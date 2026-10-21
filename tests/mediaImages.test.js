import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  uploadMediaImage,
  listAllMediaImages,
  selectEvictionTargets,
  detectMediaImageContentType,
  normalizeMediaImageName,
  isMediaImageUrl,
  isMediaImageQuotaError,
  isMediaImageReferenceError,
  MediaImageCache,
  MEDIA_IMAGE_MAX_BYTES
} from '../lib/mediaImages.js'
import { shouldUploadToImageBed } from '../Model/markdownImage.js'

// 最小合法头部的「图片」字节：只用到魔数，不上真图
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)])
const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(40, 3)])
const WEBP = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'), Buffer.alloc(40, 4)])

function md5 (buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex')
}

function apiError (code) {
  return Object.assign(new Error(`code(${code})`), { response: { data: { code } } })
}

function makeRequest (handlers) {
  const calls = []
  return {
    calls,
    async post (url, body) {
      calls.push({ method: 'post', url, body })
      const handler = handlers[url]
      if (!handler) throw new Error(`未预期的 POST: ${url}`)
      return handler(body)
    },
    async get (url) {
      calls.push({ method: 'get', url })
      const handler = handlers[url]
      if (!handler) throw new Error(`未预期的 GET: ${url}`)
      return handler()
    },
    async delete (url) {
      calls.push({ method: 'delete', url })
      const handler = handlers[url]
      if (!handler) throw new Error(`未预期的 DELETE: ${url}`)
      return handler()
    }
  }
}

function makeFetch (calls) {
  return async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, headers: { get: () => `"${md5(init.body)}"` } }
  }
}

test('按魔数识别图片类型，未知类型返回空', () => {
  assert.equal(detectMediaImageContentType(PNG), 'image/png')
  assert.equal(detectMediaImageContentType(JPEG), 'image/jpeg')
  assert.equal(detectMediaImageContentType(GIF), 'image/gif')
  assert.equal(detectMediaImageContentType(WEBP), 'image/webp')
  assert.equal(detectMediaImageContentType(Buffer.from('not an image at all')), '')
  assert.equal(detectMediaImageContentType(null), '')
})

test('文件名后缀跟随真实类型：兼容后缀保留，不兼容后缀改写', () => {
  // 原名就是 jpg / jpeg 时不强行统一，避免平台对 .jpeg 的兼容问题
  assert.equal(normalizeMediaImageName('kline.jpg', 'image/jpeg'), 'kline.jpg')
  assert.equal(normalizeMediaImageName('kline.jpeg', 'image/jpeg'), 'kline.jpeg')
  // 后缀和字节类型不一致时必须改写，否则 prepare 直接 40035001
  assert.equal(normalizeMediaImageName('chart.png', 'image/jpeg'), 'chart.jpg')
  assert.equal(normalizeMediaImageName('chart.webp', 'image/png'), 'chart.png')
  // 没有文件名 / 带路径 / 带非法字符
  assert.match(normalizeMediaImageName('', 'image/png'), /^image_[a-z0-9]+\.png$/)
  assert.equal(normalizeMediaImageName('/tmp/a b/c.png', 'image/png'), 'c.png')
  assert.equal(normalizeMediaImageName('a:b*.png', 'image/png'), 'a_b_.png')
})

test('上传走 prepare → PUT → complete 三步，参数与头都对得上', async () => {
  const buffer = PNG
  const fetchCalls = []
  const request = makeRequest({
    '/v2/media-images/prepare': body => {
      assert.equal(body.file_name, 'kline.png')
      assert.equal(body.file_size, buffer.length)
      assert.equal(body.content_type, 'image/png')
      assert.equal(body.md5, md5(buffer))
      assert.equal(body.sha1, crypto.createHash('sha1').update(buffer).digest('hex'))
      return { data: { upload_id: 'upload_1', presigned_url: 'https://cos.example.com/obj', expires_in: 3600 } }
    },
    '/v2/media-images/complete': body => {
      assert.equal(body.upload_id, 'upload_1')
      assert.equal(body.md5, md5(buffer))
      return { data: { image_id: 'img_1', url: 'qqbot-media://image/v1/token', ttl: 7776000 } }
    }
  })

  const result = await uploadMediaImage({
    request,
    buffer,
    fileName: 'kline.png',
    fetchImpl: makeFetch(fetchCalls)
  })

  assert.equal(result.image_id, 'img_1')
  assert.equal(result.url, 'qqbot-media://image/v1/token')
  assert.equal(result.ttl, 7776000)

  // PUT 的 Content-Type 必须与 prepare 声明完全一致，否则 COS 403
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].init.method, 'PUT')
  assert.equal(fetchCalls[0].init.headers['Content-Type'], 'image/png')
  assert.equal(fetchCalls[0].init.headers['Content-Length'], String(buffer.length))
  assert.equal(fetchCalls[0].init.body.length, buffer.length)
})

test('类型不支持或超过 10MB 时返回 null，不浪费一次上传', async () => {
  const request = makeRequest({})
  const fetchCalls = []

  assert.equal(await uploadMediaImage({
    request,
    buffer: Buffer.from('plain text body'),
    fetchImpl: makeFetch(fetchCalls)
  }), null)

  assert.equal(await uploadMediaImage({
    request,
    buffer: Buffer.concat([PNG, Buffer.alloc(MEDIA_IMAGE_MAX_BYTES)]),
    fetchImpl: makeFetch(fetchCalls)
  }), null)

  assert.equal(request.calls.length, 0)
  assert.equal(fetchCalls.length, 0)
})

test('上传任务过期(40035003)时重新申请一次', async () => {
  const fetchCalls = []
  let prepareCount = 0
  const request = makeRequest({
    '/v2/media-images/prepare': () => {
      prepareCount += 1
      return { data: { upload_id: `upload_${prepareCount}`, presigned_url: 'https://cos.example.com/obj' } }
    },
    '/v2/media-images/complete': body => {
      if (body.upload_id === 'upload_1') throw apiError(40035003)
      return { data: { image_id: 'img_2', url: 'qqbot-media://image/v1/ok', ttl: 100 } }
    }
  })

  const retries = []
  const result = await uploadMediaImage({
    request,
    buffer: PNG,
    fetchImpl: makeFetch(fetchCalls),
    retryDelayMs: 1,
    onRetry: ctx => retries.push(ctx.code)
  })

  assert.equal(result.url, 'qqbot-media://image/v1/ok')
  assert.equal(prepareCount, 2)
  assert.deepEqual(retries, ['40035003'])
})

test('配额打满(40035007)不重试，直接抛给调用方去淘汰', async () => {
  const request = makeRequest({
    '/v2/media-images/prepare': () => { throw apiError(40035007) }
  })

  await assert.rejects(
    () => uploadMediaImage({ request, buffer: PNG, fetchImpl: makeFetch([]), retryDelayMs: 1 }),
    err => isMediaImageQuotaError(err)
  )
  assert.equal(request.calls.length, 1)
})

test('错误码分类：引用失效与配额是两回事', () => {
  assert.equal(isMediaImageQuotaError(apiError(40035007)), true)
  assert.equal(isMediaImageQuotaError(apiError(40035003)), false)
  assert.equal(isMediaImageReferenceError(apiError(40035009)), true)
  assert.equal(isMediaImageReferenceError(apiError(40035010)), true)
  assert.equal(isMediaImageReferenceError(apiError(40035007)), false)
  assert.equal(isMediaImageReferenceError(new Error('网络炸了')), false)
})

test('查询接口按 next_cursor 翻页直到末页', async () => {
  const request = {
    calls: [],
    async get (url) {
      this.calls.push(url)
      if (url === '/v2/media-images') {
        return { data: { images: [{ image_id: 'a' }], next_cursor: 'c1', total: 2 } }
      }
      return { data: { images: [{ image_id: 'b' }], next_cursor: '', total: 2 } }
    }
  }

  const images = await listAllMediaImages({ request })
  assert.deepEqual(images.map(i => i.image_id), ['a', 'b'])
  assert.deepEqual(request.calls, ['/v2/media-images', '/v2/media-images?cursor=c1'])
})

test('淘汰时按上传时间升序挑最旧的', () => {
  const images = [
    { image_id: 'new', created_at: 300 },
    { image_id: 'old', created_at: 100 },
    { image_id: 'mid', created_at: 200 }
  ]
  assert.deepEqual(selectEvictionTargets(images, 2).map(i => i.image_id), ['old', 'mid'])
  assert.deepEqual(selectEvictionTargets(images, 0), [])
  assert.deepEqual(selectEvictionTargets(null, 3), [])
})

test('本地缓存按内容 sha1 去重，落盘后重启还能读到', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-media-'))
  const filePath = path.join(dir, 'media-images.json')
  const now = () => 1_700_000_000_000

  const cache = new MediaImageCache({ filePath, now })
  cache.set('bot1', 'sha1-a', { image_id: 'img_a', url: 'qqbot-media://image/v1/a', expires_at: 1_700_000_100 })
  await cache.save()

  const reopened = new MediaImageCache({ filePath, now })
  const entry = reopened.get('bot1', 'sha1-a')
  assert.equal(entry.url, 'qqbot-media://image/v1/a')
  assert.equal(entry.image_id, 'img_a')

  reopened.removeByImageId('bot1', 'img_a')
  assert.equal(reopened.get('bot1', 'sha1-a'), null)

  reopened.set('bot1', 'sha1-b', { image_id: 'img_b', url: 'qqbot-media://image/v1/b' })
  reopened.removeByUrl('bot1', 'qqbot-media://image/v1/b')
  assert.equal(reopened.get('bot1', 'sha1-b'), null)

  // 别的机器人互不影响
  reopened.set('bot2', 'sha1-a', { image_id: 'img_c', url: 'qqbot-media://image/v1/c' })
  assert.equal(reopened.get('bot1', 'sha1-a'), null)
  assert.equal(reopened.get('bot2', 'sha1-a').image_id, 'img_c')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('缓存文件损坏时当作空缓存，不抛异常', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-media-'))
  const filePath = path.join(dir, 'media-images.json')
  fs.writeFileSync(filePath, '{ this is not json')

  const cache = new MediaImageCache({ filePath })
  assert.equal(cache.get('bot1', 'sha1'), null)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('素材库引用不再被图床覆盖', () => {
  assert.equal(isMediaImageUrl('qqbot-media://image/v1/token'), true)
  assert.equal(isMediaImageUrl('https://example.com/a.png'), false)
  assert.equal(
    shouldUploadToImageBed({
      externalUrl: '',
      localUrl: '',
      currentUrl: 'qqbot-media://image/v1/token'
    }),
    false
  )
})

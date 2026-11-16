import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  selectEvictionTargets,
  detectMediaImageContentType,
  normalizeMediaImageName,
  isMediaImageUrl,
  isMediaImageQuotaError,
  isMediaImageReferenceError,
  MediaImageCache
} from '../lib/mediaImages.js'
import { shouldUploadToImageBed } from '../Model/markdownImage.js'

// 最小合法头部的「图片」字节：只用到魔数，不上真图
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)])
const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(40, 3)])
const WEBP = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'), Buffer.alloc(40, 4)])

function apiError (code) {
  return Object.assign(new Error(`code(${code})`), { response: { data: { code } } })
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

test('错误码分类：引用失效与配额是两回事', () => {
  assert.equal(isMediaImageQuotaError(apiError(40035007)), true)
  assert.equal(isMediaImageQuotaError(apiError(40035003)), false)
  assert.equal(isMediaImageReferenceError(apiError(40035009)), true)
  assert.equal(isMediaImageReferenceError(apiError(40035010)), true)
  assert.equal(isMediaImageReferenceError(apiError(40035007)), false)
  assert.equal(isMediaImageReferenceError(new Error('网络炸了')), false)
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

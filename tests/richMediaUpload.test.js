import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { uploadRichMediaByParts } from '../lib/richMediaUpload.js'

const ENDPOINT = '/v2/groups/ABCDEF'

/**
 * 平台返回的分片序号不保证连续（官方 issue 里就有 1,2,3,7 这种），
 * 末片大小也和前面几片不同。这里覆盖「跳号 + 非等长」两种布局。
 */
function makeRequest (prepareResponse, postCalls) {
  return {
    post: async (url, body) => {
      postCalls.push({ url, body })
      if (url.endsWith('/upload_prepare')) return { data: prepareResponse }
      if (url.endsWith('/upload_part_finish')) return { data: {} }
      if (url.endsWith('/files')) return { data: { file_info: 'FILE_INFO' } }
      throw new Error(`未预期的请求: ${url}`)
    }
  }
}

function makeFetch (putCalls) {
  return async (url, init) => {
    putCalls.push({ url, body: init.body, contentLength: init.headers['Content-Length'] })
    return { ok: true, status: 200 }
  }
}

function prepare (blockSize, parts, concurrency = 1) {
  return {
    upload_id: 'upload_1',
    block_size: String(blockSize),
    parts,
    upload_config: { concurrency, retry_timeout: 300, retry_delay: 1 }
  }
}

test('分片序号从 1 开始且连续时，偏移按累加计算', async () => {
  const fileBuffer = Buffer.alloc(30, 7)
  const postCalls = []
  const putCalls = []

  const result = await uploadRichMediaByParts({
    request: makeRequest(prepare(10, [
      { index: 1, block_size: '10', presigned_url: 'https://cos.example.com/p1' },
      { index: 2, block_size: '10', presigned_url: 'https://cos.example.com/p2' },
      { index: 3, block_size: '10', presigned_url: 'https://cos.example.com/p3' }
    ]), postCalls),
    endpointPath: ENDPOINT,
    fileBuffer,
    fileType: 1,
    fileName: 'a.png',
    fetchImpl: makeFetch(putCalls)
  })

  assert.equal(result.file_info, 'FILE_INFO')
  assert.deepEqual(putCalls.map(c => [c.body.length, c.contentLength]), [[10, '10'], [10, '10'], [10, '10']])
})

test('分片序号跳号（1,4,9）时不得越界，偏移按前序分片累加', async () => {
  const fileBuffer = Buffer.alloc(30, 7)
  const postCalls = []
  const putCalls = []

  // 旧实现用 (index - base) * blockSize：index=4 会算出 start=30，
  // 正好等于文件长度 → 抛「分片 4 超出文件范围」，整单上传失败。
  const result = await uploadRichMediaByParts({
    request: makeRequest(prepare(10, [
      { index: 1, block_size: '10', presigned_url: 'https://cos.example.com/p1' },
      { index: 4, block_size: '10', presigned_url: 'https://cos.example.com/p4' },
      { index: 9, block_size: '10', presigned_url: 'https://cos.example.com/p9' }
    ]), postCalls),
    endpointPath: ENDPOINT,
    fileBuffer,
    fileType: 1,
    fileName: 'a.png',
    fetchImpl: makeFetch(putCalls)
  })

  assert.equal(result.file_info, 'FILE_INFO')
  assert.equal(putCalls.length, 3)
  // 三片必须完整覆盖整个文件，且互不重叠
  assert.equal(putCalls.reduce((sum, c) => sum + c.body.length, 0), fileBuffer.length)
})

test('末片大小小于 block_size 时按实际大小切片', async () => {
  const fileBuffer = Buffer.alloc(25, 3)
  const putCalls = []

  await uploadRichMediaByParts({
    request: makeRequest(prepare(10, [
      { index: 1, block_size: '10', presigned_url: 'https://cos.example.com/p1' },
      { index: 2, block_size: '10', presigned_url: 'https://cos.example.com/p2' },
      { index: 3, block_size: '5', presigned_url: 'https://cos.example.com/p3' }
    ]), []),
    endpointPath: ENDPOINT,
    fileBuffer,
    fileType: 1,
    fileName: 'a.png',
    fetchImpl: makeFetch(putCalls)
  })

  assert.deepEqual(putCalls.map(c => c.body.length), [10, 10, 5])
})

test('分片序号从 0 开始时同样正确', async () => {
  const fileBuffer = Buffer.alloc(20, 1)
  const putCalls = []

  await uploadRichMediaByParts({
    request: makeRequest(prepare(10, [
      { index: 0, block_size: '10', presigned_url: 'https://cos.example.com/p0' },
      { index: 1, block_size: '10', presigned_url: 'https://cos.example.com/p1' }
    ]), []),
    endpointPath: ENDPOINT,
    fileBuffer,
    fileType: 1,
    fileName: 'a.png',
    fetchImpl: makeFetch(putCalls)
  })

  assert.deepEqual(putCalls.map(c => c.body.length), [10, 10])
})

test('parts 数组本身乱序时，偏移仍按序号顺序计算', async () => {
  const fileBuffer = Buffer.alloc(30, 5)
  const putCalls = []

  await uploadRichMediaByParts({
    request: makeRequest(prepare(10, [
      { index: 9, block_size: '10', presigned_url: 'https://cos.example.com/p9' },
      { index: 1, block_size: '10', presigned_url: 'https://cos.example.com/p1' },
      { index: 4, block_size: '10', presigned_url: 'https://cos.example.com/p4' }
    ]), []),
    endpointPath: ENDPOINT,
    fileBuffer,
    fileType: 1,
    fileName: 'a.png',
    fetchImpl: makeFetch(putCalls)
  })

  assert.equal(putCalls.reduce((sum, c) => sum + c.body.length, 0), fileBuffer.length)
})

test('upload_prepare 必须携带完整文件与前 10002432 字节的校验值', async () => {
  const fileBuffer = Buffer.alloc(100, 9)
  const postCalls = []

  await uploadRichMediaByParts({
    request: makeRequest(prepare(100, [
      { index: 1, block_size: '100', presigned_url: 'https://cos.example.com/p1' }
    ]), postCalls),
    endpointPath: ENDPOINT,
    fileBuffer,
    fileType: 4,
    fileName: 'a.bin',
    fetchImpl: makeFetch([])
  })

  const prepareCall = postCalls.find(c => c.url.endsWith('/upload_prepare'))
  assert.ok(prepareCall, '应调用 upload_prepare')
  const expected = crypto.createHash('md5').update(fileBuffer).digest('hex')
  assert.equal(prepareCall.body.md5, expected)
  assert.equal(prepareCall.body.sha1, crypto.createHash('sha1').update(fileBuffer).digest('hex'))
  // 文件小于 10MB 时，md5_10m 就是完整 md5
  assert.equal(prepareCall.body.md5_10m, expected)
  assert.equal(prepareCall.body.file_size, String(fileBuffer.length))
})

test('平台返回重复分片序号时报错而不是静默算错', async () => {
  await assert.rejects(
    () => uploadRichMediaByParts({
      request: makeRequest(prepare(10, [
        { index: 1, block_size: '10', presigned_url: 'https://cos.example.com/p1' },
        { index: 1, block_size: '10', presigned_url: 'https://cos.example.com/p1b' }
      ]), []),
      endpointPath: ENDPOINT,
      fileBuffer: Buffer.alloc(20),
      fileType: 1,
      fileName: 'a.png',
      fetchImpl: makeFetch([])
    }),
    /重复分片序号/
  )
})

test('非法的上传地址与文件类型被拒绝', async () => {
  await assert.rejects(
    () => uploadRichMediaByParts({
      request: makeRequest({}, []),
      endpointPath: '/v1/groups/x',
      fileBuffer: Buffer.alloc(1),
      fileType: 1,
      fileName: 'a.png',
      fetchImpl: makeFetch([])
    }),
    /不支持的富媒体上传地址/
  )

  await assert.rejects(
    () => uploadRichMediaByParts({
      request: makeRequest({}, []),
      endpointPath: ENDPOINT,
      fileBuffer: Buffer.alloc(1),
      fileType: 9,
      fileName: 'a.png',
      fetchImpl: makeFetch([])
    }),
    /不支持的富媒体类型/
  )
})

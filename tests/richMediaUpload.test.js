import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyGroupMarkdownImageVerification,
  sendWithGroupMarkdownImageRetry,
  uploadRichMediaByParts
} from '../lib/richMediaUpload.js'

test('分片上传按 0 起始索引切分并携带完整合并参数', async () => {
  const calls = []
  const uploadedParts = []
  const request = {
    async post(url, body, config) {
      calls.push({ url, body, config })
      if (url.endsWith('/upload_prepare')) {
        return {
          data: {
            upload_id: 'UPLOAD_ID',
            block_size: '4',
            parts: [
              { index: 0, presigned_url: 'https://upload/0', block_size: '4' },
              { index: 1, presigned_url: 'https://upload/1', block_size: '4' },
              { index: 2, presigned_url: 'https://upload/2', block_size: '2' }
            ],
            upload_config: {
              concurrency: 1,
              retry_timeout: 1,
              retry_delay: 0
            }
          }
        }
      }
      if (url.endsWith('/files')) return { data: { file_info: 'FILE_INFO' } }
      return { data: {} }
    }
  }

  const result = await uploadRichMediaByParts({
    request,
    endpointPath: '/v2/groups/GROUP_OPENID',
    fileBuffer: Buffer.from('abcdefghij'),
    fileType: 4,
    fileName: 'demo.bin',
    fetchImpl: async (url, options) => {
      uploadedParts.push({
        url,
        contentLength: options.headers['Content-Length'],
        body: Buffer.from(options.body).toString()
      })
      return { ok: true, status: 200 }
    }
  })

  assert.deepEqual(result, { file_info: 'FILE_INFO' })
  assert.deepEqual(uploadedParts, [
    { url: 'https://upload/0', contentLength: '4', body: 'abcd' },
    { url: 'https://upload/1', contentLength: '4', body: 'efgh' },
    { url: 'https://upload/2', contentLength: '2', body: 'ij' }
  ])

  const prepareCall = calls.find(call => call.url.endsWith('/upload_prepare'))
  assert.equal(prepareCall.body.file_size, '10')
  assert.equal(prepareCall.body.file_type, 4)
  assert.equal(prepareCall.body.md5, 'a925576942e94b2ef57a066101b48876')
  assert.equal(prepareCall.body.sha1, 'd68c19a0a345b7eab78d5e11e991c026ec60db63')
  assert.equal(prepareCall.body.md5_10m, prepareCall.body.md5)

  const finishCalls = calls.filter(call => call.url.endsWith('/upload_part_finish'))
  assert.deepEqual(finishCalls.map(call => call.body.part_index), [0, 1, 2])
  assert.deepEqual(finishCalls.map(call => call.body.block_size), ['4', '4', '2'])
  assert.equal(finishCalls.every(call => call.config.timeout > 0), true)

  const mergeCall = calls.find(call => call.url.endsWith('/files'))
  assert.deepEqual(mergeCall.body, {
    file_type: 4,
    srv_send_msg: false,
    file_name: 'demo.bin',
    upload_id: 'UPLOAD_ID'
  })
})

test('预签名 PUT 失败时按照上传配置重试', async () => {
  let uploadAttempts = 0
  const retryEvents = []
  const request = {
    async post(url) {
      if (url.endsWith('/upload_prepare')) {
        return {
          data: {
            upload_id: 'UPLOAD_ID',
            block_size: '4',
            parts: [{ index: 0, presigned_url: 'https://upload/0', block_size: '4' }],
            upload_config: {
              concurrency: 1,
              retry_timeout: 1,
              retry_delay: 0
            }
          }
        }
      }
      if (url.endsWith('/files')) return { data: { file_info: 'FILE_INFO' } }
      return { data: {} }
    }
  }

  await uploadRichMediaByParts({
    request,
    endpointPath: '/v2/users/USER_OPENID',
    fileBuffer: Buffer.from('abcd'),
    fileType: 1,
    fileName: 'demo.png',
    fetchImpl: async () => {
      uploadAttempts += 1
      return uploadAttempts === 1
        ? { ok: false, status: 503 }
        : { ok: true, status: 200 }
    },
    sleep: async () => {},
    onRetry: event => retryEvents.push(event)
  })

  assert.equal(uploadAttempts, 2)
  assert.equal(retryEvents.length, 1)
  assert.equal(retryEvents[0].stage, 'put')
  assert.equal(retryEvents[0].partIndex, 0)
})

test('整轮分片上传失败后重新申请上传任务', async () => {
  let prepareAttempts = 0
  const retryEvents = []
  const request = {
    async post(url) {
      if (url.endsWith('/upload_prepare')) {
        prepareAttempts += 1
        if (prepareAttempts === 1) throw new Error('临时申请失败')
        return {
          data: {
            upload_id: 'UPLOAD_ID_2',
            block_size: '4',
            parts: [{ index: 0, presigned_url: 'https://upload/0', block_size: '4' }],
            upload_config: {
              concurrency: 1,
              retry_timeout: 1,
              retry_delay: 0
            }
          }
        }
      }
      if (url.endsWith('/files')) return { data: { file_info: 'FILE_INFO' } }
      return { data: {} }
    }
  }

  const result = await uploadRichMediaByParts({
    request,
    endpointPath: '/v2/groups/GROUP_OPENID',
    fileBuffer: Buffer.from('abcd'),
    fileType: 1,
    fileName: 'demo.png',
    fetchImpl: async () => ({ ok: true, status: 200 }),
    sleep: async () => {},
    onRetry: event => retryEvents.push(event)
  })

  assert.deepEqual(result, { file_info: 'FILE_INFO' })
  assert.equal(prepareAttempts, 2)
  assert.equal(retryEvents.length, 1)
  assert.equal(retryEvents[0].stage, 'session')
})

test('群聊 Markdown 默认开启图片资源校验并保留显式关闭', () => {
  const groupPayload = { markdown: { content: '![图](https://example.com/a.png)' } }
  applyGroupMarkdownImageVerification('/v2/groups/GROUP_OPENID', groupPayload)
  assert.equal(groupPayload.markdown.force_verify_image_resource, true)

  const explicitlyDisabled = {
    markdown: {
      content: 'text',
      force_verify_image_resource: false
    }
  }
  applyGroupMarkdownImageVerification('/v2/groups/GROUP_OPENID', explicitlyDisabled)
  assert.equal(explicitlyDisabled.markdown.force_verify_image_resource, false)

  const userPayload = { markdown: { content: 'text' } }
  applyGroupMarkdownImageVerification('/v2/users/USER_OPENID', userPayload)
  assert.equal('force_verify_image_resource' in userPayload.markdown, false)
})

test('群聊 Markdown 图片转存失败时自动退避重发', async () => {
  let attempts = 0
  const delays = []
  const payload = { markdown: { content: '![图](https://example.com/a.png)' } }

  const result = await sendWithGroupMarkdownImageRetry({
    endpointPath: '/v2/groups/GROUP_OPENID',
    messagePayload: payload,
    send: async () => {
      attempts += 1
      if (attempts < 3) {
        const error = new Error('request failed')
        error.response = { data: { code: 40034004 } }
        throw error
      }
      return { data: { id: 'MESSAGE_ID' } }
    },
    sleep: async ms => delays.push(ms)
  })

  assert.deepEqual(result, { data: { id: 'MESSAGE_ID' } })
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [500, 1000])
  assert.equal(payload.markdown.force_verify_image_resource, true)
})

test('非图片转存错误不会自动重发', async () => {
  let attempts = 0
  const error = new Error('code(40034006)')

  await assert.rejects(
    sendWithGroupMarkdownImageRetry({
      endpointPath: '/v2/groups/GROUP_OPENID',
      messagePayload: { markdown: { content: 'text' } },
      send: async () => {
        attempts += 1
        throw error
      },
      sleep: async () => {}
    }),
    error
  )

  assert.equal(attempts, 1)
})

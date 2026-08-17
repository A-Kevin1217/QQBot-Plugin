import crypto from 'node:crypto'

const MD5_10M_SIZE = 10002432
const DEFAULT_RETRY_TIMEOUT_SECONDS = 300
const DEFAULT_RETRY_DELAY_SECONDS = 1
const DEFAULT_SESSION_RETRIES = 2
const DEFAULT_SESSION_RETRY_DELAY_MS = 500
const DEFAULT_MARKDOWN_IMAGE_RETRIES = 3
const DEFAULT_MARKDOWN_IMAGE_RETRY_DELAY_MS = 500
const MARKDOWN_IMAGE_TRANSFER_ERROR_CODES = new Set(['304010', '40034004'])

function toPositiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function toNonNegativeNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex')
}

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex')
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function retryOperation(operation, options) {
  const timeoutMs = options.timeoutMs
  const delayMs = options.delayMs
  const sleep = options.sleep || delay
  const startedAt = Date.now()
  let attempt = 0

  while (true) {
    attempt += 1
    const elapsedMs = Date.now() - startedAt
    const remainingMs = Math.max(1, timeoutMs - elapsedMs)

    try {
      return await operation({ attempt, remainingMs })
    } catch (error) {
      if (Date.now() - startedAt + delayMs >= timeoutMs) throw error
      options.onRetry?.({ attempt, error })
      await sleep(delayMs)
    }
  }
}

async function runWithConcurrency(items, concurrency, worker) {
  let cursor = 0
  const workerCount = Math.min(items.length, Math.max(1, concurrency))

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      await worker(item)
    }
  }))
}

export function applyGroupMarkdownImageVerification(endpointPath, messagePayload) {
  if (
    String(endpointPath).startsWith('/v2/groups/')
    && messagePayload?.markdown
    && typeof messagePayload.markdown === 'object'
  ) {
    messagePayload.markdown.force_verify_image_resource ??= true
  }
  return messagePayload
}

export function getQQApiErrorCode(error) {
  const candidates = [
    error?.response?.data?.code,
    error?.data?.code,
    error?.code
  ]
  for (const candidate of candidates) {
    const code = String(candidate ?? '')
    if (/^\d+$/.test(code)) return code
  }
  return String(error?.message || '').match(/code\((\d+)\)/)?.[1] || ''
}

export async function sendWithGroupMarkdownImageRetry(options) {
  const {
    endpointPath,
    messagePayload,
    send,
    sleep = delay,
    onRetry
  } = options

  if (typeof send !== 'function') throw new Error('群聊 Markdown 重试缺少发送函数')

  applyGroupMarkdownImageVerification(endpointPath, messagePayload)
  const shouldRetry = /^\/v2\/groups\/[^/]+$/.test(String(endpointPath))
    && messagePayload?.markdown?.force_verify_image_resource === true
  const maxRetries = Math.floor(toNonNegativeNumber(
    options.maxRetries,
    DEFAULT_MARKDOWN_IMAGE_RETRIES
  ))
  const baseDelayMs = Math.ceil(toNonNegativeNumber(
    options.retryDelayMs,
    DEFAULT_MARKDOWN_IMAGE_RETRY_DELAY_MS
  ))
  let retryCount = 0

  while (true) {
    try {
      return await send()
    } catch (error) {
      const code = getQQApiErrorCode(error)
      if (!shouldRetry || !MARKDOWN_IMAGE_TRANSFER_ERROR_CODES.has(code) || retryCount >= maxRetries) {
        throw error
      }

      retryCount += 1
      const delayMs = baseDelayMs * (2 ** (retryCount - 1))
      const retryContext = {
        stage: 'markdown-image',
        attempt: retryCount,
        code,
        delayMs,
        error
      }
      onRetry?.(retryContext)
      await sleep(delayMs)
    }
  }
}

async function uploadRichMediaSession(options) {
  const {
    request,
    endpointPath,
    fileBuffer,
    fileName,
    normalizedFileType,
    fetchImpl = globalThis.fetch,
    sleep,
    onRetry
  } = options

  const { data: prepareResult } = await request.post(`${endpointPath}/upload_prepare`, {
    file_type: normalizedFileType,
    file_size: String(fileBuffer.length),
    file_name: fileName,
    md5: md5(fileBuffer),
    sha1: sha1(fileBuffer),
    md5_10m: md5(fileBuffer.subarray(0, Math.min(MD5_10M_SIZE, fileBuffer.length)))
  })

  const uploadId = prepareResult?.upload_id
  const parts = prepareResult?.parts
  const blockSize = toPositiveNumber(prepareResult?.block_size, 0)
  if (!uploadId || !Array.isArray(parts) || !parts.length || !blockSize) {
    throw new Error('富媒体预上传响应缺少 upload_id、block_size 或 parts')
  }

  const uploadConfig = prepareResult.upload_config || {}
  const concurrency = Math.floor(toPositiveNumber(uploadConfig.concurrency, 1))
  const retryTimeoutMs = toPositiveNumber(
    uploadConfig.retry_timeout,
    DEFAULT_RETRY_TIMEOUT_SECONDS
  ) * 1000
  const retryDelayMs = toNonNegativeNumber(
    uploadConfig.retry_delay,
    DEFAULT_RETRY_DELAY_SECONDS
  ) * 1000
  const normalizedRetryTimeoutMs = Math.max(1, Math.ceil(retryTimeoutMs))
  const normalizedRetryDelayMs = Math.max(0, Math.ceil(retryDelayMs))

  await runWithConcurrency(parts, concurrency, async part => {
    const partIndex = Number(part?.index)
    const partSize = toPositiveNumber(part?.block_size, blockSize)
    if (!Number.isInteger(partIndex) || partIndex < 0 || !part?.presigned_url) {
      throw new Error('富媒体预上传返回了无效分片')
    }

    const start = partIndex * blockSize
    const end = Math.min(start + partSize, fileBuffer.length)
    if (start >= fileBuffer.length || end <= start) {
      throw new Error(`富媒体分片 ${partIndex} 超出文件范围`)
    }

    const partBuffer = fileBuffer.subarray(start, end)
    const retryOptions = {
      timeoutMs: normalizedRetryTimeoutMs,
      delayMs: normalizedRetryDelayMs,
      sleep,
      onRetry: ({ attempt, error }) => onRetry?.({
        stage: 'put',
        partIndex,
        attempt,
        error
      })
    }

    await retryOperation(async ({ remainingMs }) => {
      const signal = typeof globalThis.AbortSignal?.timeout === 'function'
        ? globalThis.AbortSignal.timeout(remainingMs)
        : undefined
      const response = await fetchImpl(part.presigned_url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(partBuffer.length)
        },
        body: partBuffer,
        signal
      })
      if (!response?.ok) {
        throw new Error(`富媒体分片 ${partIndex} 上传失败: HTTP ${response?.status || 'unknown'}`)
      }
    }, retryOptions)

    await retryOperation(
      ({ remainingMs }) => request.post(
        `${endpointPath}/upload_part_finish`,
        {
          upload_id: uploadId,
          part_index: partIndex,
          block_size: String(partBuffer.length),
          md5: md5(partBuffer)
        },
        { timeout: remainingMs }
      ),
      {
        ...retryOptions,
        onRetry: ({ attempt, error }) => onRetry?.({
          stage: 'finish',
          partIndex,
          attempt,
          error
        })
      }
    )
  })

  const { data: result } = await request.post(`${endpointPath}/files`, {
    file_type: normalizedFileType,
    srv_send_msg: false,
    file_name: fileName,
    upload_id: uploadId
  })
  return result
}

export async function uploadRichMediaByParts(options) {
  const {
    request,
    endpointPath,
    fileBuffer,
    fileType,
    fetchImpl = globalThis.fetch,
    sleep = delay,
    onRetry
  } = options

  if (!request?.post) throw new Error('分片上传缺少请求客户端')
  if (!Buffer.isBuffer(fileBuffer)) throw new Error('分片上传数据必须是 Buffer')
  if (!fetchImpl) throw new Error('分片上传缺少 fetch 实现')
  if (!/^\/v2\/(?:users|groups)\/[^/]+$/.test(endpointPath)) {
    throw new Error(`不支持的富媒体上传地址: ${endpointPath}`)
  }

  const normalizedFileType = Number(fileType)
  if (![1, 2, 3, 4].includes(normalizedFileType)) {
    throw new Error(`不支持的富媒体类型: ${fileType}`)
  }

  const maxSessionRetries = Math.floor(toNonNegativeNumber(
    options.maxSessionRetries,
    DEFAULT_SESSION_RETRIES
  ))
  const baseDelayMs = Math.ceil(toNonNegativeNumber(
    options.sessionRetryDelayMs,
    DEFAULT_SESSION_RETRY_DELAY_MS
  ))
  let retryCount = 0

  while (true) {
    try {
      return await uploadRichMediaSession({
        ...options,
        normalizedFileType,
        fetchImpl
      })
    } catch (error) {
      if (retryCount >= maxSessionRetries) throw error

      retryCount += 1
      const delayMs = baseDelayMs * (2 ** (retryCount - 1))
      onRetry?.({
        stage: 'session',
        attempt: retryCount,
        delayMs,
        error
      })
      await sleep(delayMs)
    }
  }
}

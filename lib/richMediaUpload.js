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

export function applyMarkdownImageVerification(endpointPath, messagePayload) {
  const path = String(endpointPath)
  if (
    (path.startsWith('/v2/groups/') || path.startsWith('/v2/users/'))
    && messagePayload?.markdown
    && typeof messagePayload.markdown === 'object'
  ) {
    // 单聊同样要开强校验：否则图片转存失败时平台既不报错也不返回 304010，
    // 消息照发，用户收到的是一张裂图，而且永远触发不了下面的重试/换床逻辑。
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

export async function sendWithMarkdownImageRetry(options) {
  const {
    endpointPath,
    messagePayload,
    send,
    sleep = delay,
    onRetry
  } = options

  if (typeof send !== 'function') throw new Error('Markdown 图片重试缺少发送函数')

  applyMarkdownImageVerification(endpointPath, messagePayload)
  const shouldRetry = /^\/v2\/(?:users|groups)\/[^/]+$/.test(String(endpointPath))
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
      const retryResult = await onRetry?.(retryContext)
      if (retryResult !== true) await sleep(delayMs)
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
  const partIndexes = parts.map(part => Number(part?.index))
  if (partIndexes.some(index => !Number.isInteger(index) || index < 0)) {
    throw new Error('富媒体预上传返回了无效分片序号')
  }
  const partIndexBase = partIndexes.includes(0) ? 0 : Math.min(...partIndexes)
  if (partIndexBase !== 0 && partIndexBase !== 1) {
    throw new Error(`富媒体预上传返回了不支持的分片起始序号: ${partIndexBase}`)
  }
  if (new Set(partIndexes).size !== partIndexes.length) {
    throw new Error('富媒体预上传返回了重复分片序号')
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

  // 分片偏移必须由「前面所有分片大小累加」得出，而不是用序号乘 block_size：
  // 平台返回的分片序号可能跳号（例如 1,2,3,7），末片大小也和前面几片不同，
  // 用序号相乘会把 start 算到文件末尾之外，直接抛「分片超出文件范围」导致整单上传失败。
  const partOffsetByIndex = new Map()
  {
    let cursor = 0
    for (const item of [...parts].sort((a, b) => Number(a?.index) - Number(b?.index))) {
      partOffsetByIndex.set(Number(item?.index), cursor)
      cursor += toPositiveNumber(item?.block_size, blockSize)
    }
  }

  await runWithConcurrency(parts, concurrency, async part => {
    const partIndex = Number(part?.index)
    const partSize = toPositiveNumber(part?.block_size, blockSize)
    if (!part?.presigned_url) {
      throw new Error('富媒体预上传返回了无效分片')
    }

    const start = partOffsetByIndex.get(partIndex)
    if (!Number.isInteger(start)) {
      throw new Error(`富媒体预上传缺少分片 ${partIndex} 的偏移量`)
    }
    const end = Math.min(start + partSize, fileBuffer.length)
    if (start >= fileBuffer.length || end <= start) {
      throw new Error(
        `富媒体分片 ${partIndex} 超出文件范围 `
        + `(index_base=${partIndexBase}, file_size=${fileBuffer.length}, `
        + `block_size=${blockSize}, part_size=${partSize}, start=${start}, end=${end})`
      )
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

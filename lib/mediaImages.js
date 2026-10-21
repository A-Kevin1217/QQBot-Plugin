/**
 * 平台素材库（Markdown 图片素材管理）。
 *
 * 官方文档：https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html
 *
 * 和「图床」解决的是同一个问题，但路径完全不同：
 *   - 图床：把图片挂到一个公网地址，发送时由**平台服务端去下载转存** —— 所以要公网可达、
 *     要体量合规，否则 304010（图片转存错误）/ 40034004。
 *   - 素材库：图片先传到平台自己的 COS，拿到 `qqbot-media://image/v1/<token>` 引用，
 *     发送时平台直接用自己的副本，**不经过公网下载**，也就没有转存失败这条路。
 *
 * 代价是配额：单机器人 100 张、单张 10MB、png/jpeg/gif/webp，所以必须做「按内容去重 +
 * 快满时淘汰最旧的」，否则每发一张新图就顶掉一张配额。
 *
 * 流程（三步，缺一不可）：
 *   1. POST /v2/media-images/prepare   申请上传，拿 presigned_url / upload_id
 *   2. PUT  <presigned_url>            直传二进制，Content-Type 必须与 prepare 声明完全一致
 *   3. POST /v2/media-images/complete  交 upload_id + md5，拿 image_id 与引用链接
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getQQApiErrorCode } from './richMediaUpload.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(__dirname, '..')

/** 单张图片体积上限（字节），官方默认 10MB */
export const MEDIA_IMAGE_MAX_BYTES = 10 * 1024 * 1024
/** 单机器人图片数量上限，超过后 prepare/complete 返回 40035007 */
export const MEDIA_IMAGE_MAX_COUNT = 100
/** 引用有效期：滑动过期，每次被消息引用后顺延 90 天 */
export const MEDIA_IMAGE_TTL_SECONDS = 7776000
/** 引用链接前缀，和公网图片 URL 在 markdown 里可以混用 */
export const MEDIA_IMAGE_URL_PREFIX = 'qqbot-media://'
/** 缓存条目剩余有效期低于这个值就提前重传，避免发到一半链接过期（40035009） */
export const MEDIA_IMAGE_REFRESH_MARGIN_SECONDS = 7 * 86400
/** 配额打满时一次淘汰多少张，留出余量免得每发一张都要先删一张 */
export const MEDIA_IMAGE_EVICT_BATCH = 10

const DEFAULT_RETRY_DELAY_MS = 800

const CONTENT_TYPE_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

const CANONICAL_EXT_BY_CONTENT_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

const COMPATIBLE_EXT_BY_CONTENT_TYPE = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp']
}

export const MEDIA_IMAGE_CACHE_FILE = path.join(pluginRoot, 'data', 'media-images.json')

function md5 (buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex')
}

function sha1 (buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex')
}

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function hashMediaImage (buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { md5: '', sha1: '' }
  return { md5: md5(buffer), sha1: sha1(buffer) }
}

export function isMediaImageUrl (value) {
  return String(value || '').startsWith(MEDIA_IMAGE_URL_PREFIX)
}

/**
 * 按魔数判断图片类型。平台只接受 png/jpeg/gif/webp，且要求文件名后缀与 Content-Type 一致，
 * 所以这里不信调用方传进来的文件名，一律以字节为准。
 */
export function detectMediaImageContentType (buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return ''
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'image/gif'
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return ''
}

/**
 * 生成「后缀与 Content-Type 一致」的文件名。
 * 原名后缀本来就兼容时保留（jpg/jpeg 不强行改写），否则按实际字节类型改名 ——
 * 平台只校验后缀与声明是否匹配，改了名不会有副作用。
 */
export function normalizeMediaImageName (fileName, contentType) {
  const compatible = COMPATIBLE_EXT_BY_CONTENT_TYPE[contentType] || []
  const fallbackExt = CANONICAL_EXT_BY_CONTENT_TYPE[contentType] || 'png'

  let name = String(fileName || '').split(/[\\/]/).pop().trim()
  let base = name
  let ext = ''
  const dot = name.lastIndexOf('.')
  if (dot > 0) {
    base = name.slice(0, dot)
    ext = name.slice(dot + 1).toLowerCase()
  }
  base = base.replace(/[^\w.\-]+/g, '_').slice(0, 80)
  if (!base) base = `image_${Date.now().toString(36)}`
  return `${base}.${compatible.includes(ext) ? ext : fallbackExt}`
}

export function isMediaImageQuotaError (error) {
  return getQQApiErrorCode(error) === '40035007'
}

export function isMediaImageReferenceError (error) {
  const code = getQQApiErrorCode(error)
  return code === '40035009' || code === '40035010'
}

/**
 * 申请上传 → 直传 COS → 完成上传。
 *
 * 返回 null 表示「这张图不适合进素材库」（类型不支持 / 超过 10MB），调用方应继续走
 * 图床或本地服务的老链路；真正的接口错误会抛出去，由调用方决定降级。
 */
export async function uploadMediaImage (options = {}) {
  const {
    request,
    buffer,
    fileName = '',
    fetchImpl = globalThis.fetch,
    maxRetries = 1,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    sleep = delay,
    onRetry
  } = options

  if (!request?.post) throw new Error('素材库上传缺少请求客户端')
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null
  if (buffer.length > MEDIA_IMAGE_MAX_BYTES) return null

  const contentType = options.contentType || detectMediaImageContentType(buffer)
  if (!contentType) return null

  const normalizedName = normalizeMediaImageName(fileName, contentType)
  const digests = hashMediaImage(buffer)

  let attempt = 0
  while (true) {
    attempt += 1
    try {
      const { data: prepared } = await request.post('/v2/media-images/prepare', {
        file_name: normalizedName,
        file_size: buffer.length,
        content_type: contentType,
        md5: digests.md5,
        sha1: digests.sha1
      })

      const uploadId = prepared?.upload_id
      const presignedUrl = prepared?.presigned_url
      if (!uploadId || !presignedUrl) {
        throw new Error('素材库申请上传响应缺少 upload_id 或 presigned_url')
      }
      if (!fetchImpl) throw new Error('素材库直传缺少 fetch 实现')

      // Content-Type 必须与 prepare 声明完全一致，否则 COS 直接 403
      const putResponse = await fetchImpl(presignedUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(buffer.length)
        },
        body: buffer,
        signal: typeof globalThis.AbortSignal?.timeout === 'function'
          ? globalThis.AbortSignal.timeout(60000)
          : undefined
      })
      if (!putResponse?.ok) {
        throw new Error(`素材库直传失败: HTTP ${putResponse?.status || 'unknown'}`)
      }

      // complete 的 md5 服务端会拿去和 COS 对象 ETag 比对（单次 PUT 的 ETag 就是文件 MD5），
      // 不一致返回 40035003，所以这里直接用自己算的值，比读响应头稳妥。
      const { data: completed } = await request.post('/v2/media-images/complete', {
        upload_id: uploadId,
        md5: digests.md5
      })

      if (!completed?.url) throw new Error('素材库完成上传响应缺少引用链接')

      return {
        image_id: String(completed.image_id || ''),
        url: String(completed.url),
        ttl: Number(completed.ttl) || MEDIA_IMAGE_TTL_SECONDS,
        preview_url: String(completed.preview_url || ''),
        file_name: normalizedName,
        content_type: contentType,
        md5: digests.md5,
        sha1: digests.sha1
      }
    } catch (error) {
      // 40035003 上传任务不存在/已过期（prepare 的 upload_id 只有 4 小时）、
      // 40035006 服务端内部错误 —— 都值得重新申请一次再试。
      const code = getQQApiErrorCode(error)
      const retriable = !code || code === '40035003' || code === '40035006'
      if (!retriable || attempt > maxRetries) throw error
      onRetry?.({ attempt, code, error })
      await sleep(retryDelayMs * attempt)
    }
  }
}

export async function listMediaImages (options = {}) {
  const { request, cursor = '' } = options
  if (!request?.get) throw new Error('查询素材库缺少请求客户端')
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  const { data } = await request.get(`/v2/media-images${query}`)
  return {
    images: Array.isArray(data?.images) ? data.images : [],
    next_cursor: String(data?.next_cursor || ''),
    total: Number(data?.total) || 0
  }
}

export async function listAllMediaImages (options = {}) {
  const images = []
  let cursor = ''
  for (let page = 0; page < 50; page++) {
    const result = await listMediaImages({ ...options, cursor })
    images.push(...result.images)
    if (!result.next_cursor) break
    cursor = result.next_cursor
  }
  return images
}

export async function deleteMediaImage (options = {}) {
  const { request, imageId } = options
  if (!request?.delete) throw new Error('删除素材库图片缺少请求客户端')
  if (!imageId) throw new Error('删除素材库图片缺少 image_id')
  await request.delete(`/v2/media-images/${encodeURIComponent(String(imageId))}/delete`)
}

/** 按上传时间升序挑出要淘汰的条目（越旧越先删） */
export function selectEvictionTargets (images, need) {
  const count = Math.max(0, Math.floor(Number(need) || 0))
  if (!count || !Array.isArray(images) || !images.length) return []
  return [...images]
    .sort((a, b) => (Number(a?.created_at) || 0) - (Number(b?.created_at) || 0))
    .slice(0, count)
}

/**
 * 素材库本地索引：内容 sha1 → { image_id, url, expires_at, last_used_at }。
 *
 * 平台按「张」计配额，同一张图重复上传等于白白烧掉配额，所以必须按内容去重；
 * 进程重启后还要能复用，因此落盘到 data/media-images.json。
 * 索引只是加速缓存，丢了也只是多传一次，不影响正确性 —— 所以读写一律吞异常。
 */
export class MediaImageCache {
  #saving = null

  constructor (options = {}) {
    this.filePath = options.filePath || MEDIA_IMAGE_CACHE_FILE
    this.now = options.now || Date.now
    this.data = null
  }

  #readFile () {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  #ensure () {
    if (!this.data) this.data = this.#readFile()
    return this.data
  }

  #bucket (selfId, create = false) {
    const data = this.#ensure()
    const key = String(selfId || '')
    if (!data[key] && create) data[key] = {}
    return data[key] || null
  }

  get (selfId, sha1Hex) {
    if (!sha1Hex) return null
    const entry = this.#bucket(selfId)?.[sha1Hex]
    return entry && typeof entry === 'object' ? entry : null
  }

  set (selfId, sha1Hex, entry) {
    if (!sha1Hex || !entry?.url) return
    const bucket = this.#bucket(selfId, true)
    bucket[sha1Hex] = {
      image_id: String(entry.image_id || ''),
      url: String(entry.url),
      expires_at: Number(entry.expires_at) || 0,
      last_used_at: Math.floor(this.now() / 1000)
    }
    this.save()
  }

  touch (selfId, sha1Hex) {
    const entry = this.get(selfId, sha1Hex)
    if (!entry) return null
    entry.last_used_at = Math.floor(this.now() / 1000)
    this.save()
    return entry
  }

  remove (selfId, sha1Hex) {
    const bucket = this.#bucket(selfId)
    if (!bucket?.[sha1Hex]) return
    delete bucket[sha1Hex]
    this.save()
  }

  removeByImageId (selfId, imageId) {
    const bucket = this.#bucket(selfId)
    if (!bucket || !imageId) return
    let dirty = false
    for (const [key, entry] of Object.entries(bucket)) {
      if (entry?.image_id === String(imageId)) {
        delete bucket[key]
        dirty = true
      }
    }
    if (dirty) this.save()
  }

  removeByUrl (selfId, url) {
    const target = String(url || '')
    const bucket = this.#bucket(selfId)
    if (!bucket || !target) return
    let dirty = false
    for (const [key, entry] of Object.entries(bucket)) {
      if (entry?.url === target) {
        delete bucket[key]
        dirty = true
      }
    }
    if (dirty) this.save()
  }

  entries (selfId) {
    return Object.entries(this.#bucket(selfId) || {}).map(([sha1Hex, entry]) => ({ sha1: sha1Hex, ...entry }))
  }

  /** 落盘是「后台尽力而为」，不阻塞发送；并发写合并成一次 */
  save () {
    if (this.#saving) return this.#saving
    this.#saving = (async () => {
      try {
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true })
        await fsp.writeFile(this.filePath, JSON.stringify(this.data || {}), 'utf8')
      } catch {
        // 索引写不进去不影响功能
      } finally {
        this.#saving = null
      }
    })()
    return this.#saving
  }
}

export { CONTENT_TYPE_BY_EXT, CANONICAL_EXT_BY_CONTENT_TYPE }

/**
 * 平台素材库（Markdown 图片素材管理）——适配器侧独有逻辑。
 *
 * 上传 / 查询 / 删除的 HTTP 构造已由 SDK（>=1.3.4）的 `sdk.materialService` 提供
 * （uploadImage / getImages / deleteImage），这里**不再重复实现**，只保留 SDK 没有的部分：
 *   - 按魔数判定真实图片类型、按 Content-Type 规范文件名（SDK 入参要求后缀与类型一致）；
 *   - 内容 sha1 哈希（本地去重缓存的键）；
 *   - 配额打满时「按上传时间淘汰最旧」的选择策略；
 *   - 素材库错误码识别（40035007 配额满、40035009/40035010 引用失效）；
 *   - 落盘的本地索引 MediaImageCache（同一张图不重复烧配额，重启可复用）。
 *
 * 背景：markdown 里的公网图片由**平台服务端下载转存**，公网不可达/体量超限会被 304010 拦下；
 * 素材库的图是平台自己的副本，发送时不下载，没有转存失败这条路。代价是配额
 * （单机器人 100 张、单张 10MB、png/jpeg/gif/webp），所以要按内容去重 + 快满时淘汰。
 *
 * 官方文档：https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getQQApiErrorCode } from './richMediaUpload.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(__dirname, '..')

/** 引用链接前缀，和公网图片 URL 在 markdown 里可以混用 */
export const MEDIA_IMAGE_URL_PREFIX = 'qqbot-media://'
/** 缓存条目剩余有效期低于这个值就提前重传，避免发到一半链接过期（40035009） */
export const MEDIA_IMAGE_REFRESH_MARGIN_SECONDS = 7 * 86400
/** 配额打满时一次淘汰多少张，留出余量免得每发一张都要先删一张 */
export const MEDIA_IMAGE_EVICT_BATCH = 10

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

export function hashMediaImage (buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { md5: '', sha1: '' }
  return {
    md5: crypto.createHash('md5').update(buffer).digest('hex'),
    sha1: crypto.createHash('sha1').update(buffer).digest('hex')
  }
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
 * 生成「后缀与 Content-Type 一致」的文件名（SDK materialService.uploadImage 的入参要求）。
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

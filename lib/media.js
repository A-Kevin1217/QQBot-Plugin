// 本地媒体缓存：把收到的图片/视频 Buffer 落地到 data/imgs/{md5}.{ext}，
// 通过 local-media 端点对外提供稳定 URL，避免依赖 QQ 官方 CDN 的短时效链接。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { config } from '../Model/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(__dirname, '..')
export const IMG_DIR = path.join(pluginRoot, 'data', 'imgs')

function getSaveDays () {
  const t = Number(config.mediaCache?.saveDays ?? 3)
  return (t >= 1 && t <= 30 && Number.isInteger(t)) ? t : 3
}

/**
 * 检测 Buffer 的媒体文件扩展名（优先取 segment 里的文件名后缀，否则按 magic bytes）
 */
export function detectMediaExt (buffer, seg = {}) {
  const name = seg.fileName || seg.name || ''
  const extMatch = String(name).match(/\.(\w{2,5})$/i)
  if (extMatch) return extMatch[1].toLowerCase()
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return 'bin'
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg'
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'gif'
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (buffer[0] === 0x00 && buffer[1] === 0x00) return 'mp4'
  return 'bin'
}

/**
 * 将 Buffer 存入本地 data/imgs/{md5}.{ext}，扁平目录，按内容 md5 去重。
 * 命中已有文件时刷新 mtime，用于清理时判断活跃度。返回文件名（不含目录）。
 */
export async function saveMediaFile (buffer, seg = {}) {
  const md5 = crypto.createHash('md5').update(buffer).digest('hex')
  const ext = detectMediaExt(buffer, seg)
  const name = `${md5}.${ext}`
  const absPath = path.join(IMG_DIR, name)

  if (fs.existsSync(absPath)) {
    const now = new Date()
    await fsp.utimes(absPath, now, now).catch(() => {})
    return name
  }

  await fsp.mkdir(IMG_DIR, { recursive: true })
  await fsp.writeFile(absPath, buffer)
  return name
}

/**
 * 拼接 local-media 端点的完整 URL。baseUrl 为空时返回纯文件名。
 */
export function getLocalMediaUrl (name, baseUrl = '') {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  return base ? `${base}/${name}` : name
}

/**
 * 扫描 segments，将远程 HTTP 图片/视频下载到本地缓存。
 * 提供 baseUrl 时会把 file/url 改写为 local-media 完整 URL（自托管）。
 */
export async function cacheRemoteMedia (segments, baseUrl = '') {
  if (!Array.isArray(segments)) return segments
  const results = []

  for (const seg of segments) {
    if (!seg || typeof seg !== 'object' || !['image', 'video'].includes(seg.type)) {
      results.push(seg)
      continue
    }

    let remoteUrl = null
    for (const key of ['url', 'file']) {
      const v = seg[key]
      if (v && typeof v === 'string' && /^https?:\/\//i.test(v)) {
        remoteUrl = v
        break
      }
    }
    if (!remoteUrl) {
      results.push(seg)
      continue
    }

    try {
      const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(30000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const arr = await res.arrayBuffer()
      if (!arr.byteLength) throw new Error('empty body')

      const maxSize = Number(config.mediaCache?.maxSize ?? 10) * 1024 * 1024
      if (arr.byteLength > maxSize) {
        results.push(seg)
        continue
      }

      const buffer = Buffer.from(arr)
      const name = await saveMediaFile(buffer, seg)
      const clean = { ...seg }
      clean.file = getLocalMediaUrl(name, baseUrl)
      clean._local = true
      if (baseUrl) clean.url = getLocalMediaUrl(name, baseUrl)
      results.push(clean)
    } catch (err) {
      logger.debug?.(`[QQBot] 缓存远程媒体失败: ${err?.message || err}`)
      results.push(seg)
    }
  }

  return results
}

/**
 * 清理 data/imgs 下超过 saveDays 天未访问的文件（按 mtime 判断）
 */
export async function cleanupMediaFiles () {
  const saveDays = getSaveDays()
  const cutoff = Date.now() - saveDays * 86400 * 1000

  let files = []
  try {
    files = await fsp.readdir(IMG_DIR)
  } catch {
    return
  }

  for (const name of files) {
    try {
      const stat = await fsp.stat(path.join(IMG_DIR, name))
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        await fsp.unlink(path.join(IMG_DIR, name))
        logger.info?.(`[QQBot] 清理过期媒体: ${name}`)
      }
    } catch { /* 单个文件清理失败不影响后续 */ }
  }
}

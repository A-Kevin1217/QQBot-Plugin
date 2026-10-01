function normalizeMessageItem (item) {
  return item && typeof item === 'object' ? { ...item } : { type: 'text', text: item }
}

function getImageInput (item) {
  if (!item || item.type !== 'image') return null
  return item.file ? item : item.data
}

function getExternalImageUrl (source) {
  if (typeof source !== 'string' && !(source instanceof URL)) return ''
  const value = String(source).trim()
  if (!value) return ''

  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    // 本机/内网地址不算「外链」：QQ 服务器拉不到，只会让 markdown 图片显示不出来。
    // 以前只判断协议，导致 Bot.fileToUrl() 产出的 http://localhost:2536/... 被当成外链，
    // 进而跳过了 makeBotImage()，最后落到图床 —— 图床一挂就发成默认占位图。
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (!host) return ''
    if (host === 'localhost' || host.endsWith('.localhost')) return ''
    if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')) return ''
    if (host === '::1' || host === '0.0.0.0') return ''
    if (/^127\./.test(host)) return ''
    if (/^10\./.test(host)) return ''
    if (/^192\.168\./.test(host)) return ''
    if (/^169\.254\./.test(host)) return ''
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return ''
    return value
  } catch {
    return ''
  }
}

function shouldUploadToImageBed ({ externalUrl = '', localUrl = '', currentUrl = '' } = {}) {
  // 插件自己已经给了公网直链 → 不需要图床
  if (externalUrl) return false

  const normalizedCurrentUrl = String(currentUrl || '')
  // 完全没有 URL → 只能靠图床
  if (!/^https?:\/\//i.test(normalizedCurrentUrl)) return true
  // 已经是公网可达地址（例如 Bot.fileToUrl() 用 server.url 拼出的
  // https://bot.kevcore.cn/File/xxx）→ 直接用它，不必再传图床。
  // 以前只比较 currentUrl === localUrl 就判定「这还是本地地址」，
  // 于是把好好的公网地址又传了一遍图床 —— 图床一旦出问题（凭据过期、
  // 存成 JSON、防盗链 403），就会把本来能正常显示的图顶坏。
  if (getExternalImageUrl(normalizedCurrentUrl)) return false
  // 剩下的是本机/内网地址（localhost / 192.168.x.x …）→ 需要图床
  return true
}

function getImageSource (input) {
  if (Buffer.isBuffer(input) || input instanceof URL || typeof input === 'string') return input
  if (!input || typeof input !== 'object') return input
  if (input.file != null) return input.file
  if (input.url != null) return input.url
  if (input.data && input.data !== input) return getImageSource(input.data)
  return input
}

function getImageFileName (source) {
  if (source instanceof URL) source = source.href
  if (typeof source !== 'string' || /^(?:base64|data):/i.test(source)) return ''

  let pathname = source
  try {
    pathname = new URL(source).pathname
  } catch { }

  const name = pathname.split(/[\\/]/).pop() || ''
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

const MOTION_PHOTO_MARKERS = [
  'GCamera:MotionPhoto',
  'GCamera:MicroVideo',
  'OpCamera:OLivePhotoVersion',
  'Item:Semantic="MotionPhoto"',
  "Item:Semantic='MotionPhoto'"
]

async function inspectMotionPhoto (input) {
  const source = getImageSource(input)
  const fileName = getImageFileName(source)
  if (/^MVIMG_.*\.jpe?g$/i.test(fileName)) {
    return { isMotionPhoto: true, source, fileName, reason: 'filename' }
  }

  // 外部直链只按文件名识别，避免为了探测格式而下载或重新托管。
  if (getExternalImageUrl(source)) {
    return { isMotionPhoto: false, source, fileName }
  }

  try {
    let buffer = Buffer.isBuffer(source) ? source : await Bot.Buffer(source, { http: true })
    if (buffer instanceof Uint8Array && !Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer)
    if (!Buffer.isBuffer(buffer) || buffer.length < 3 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
      return { isMotionPhoto: false, source, fileName, size: buffer?.length }
    }

    const probeSize = 512 * 1024
    const head = buffer.subarray(0, Math.min(probeSize, buffer.length)).toString('latin1')
    const tail = buffer.subarray(Math.max(0, buffer.length - probeSize)).toString('latin1')
    const marker = MOTION_PHOTO_MARKERS.find(value => head.includes(value) || tail.includes(value))
    const huaweiMarker = tail.includes('LIVE_') ? 'LIVE_' : ''

    return {
      isMotionPhoto: Boolean(marker || huaweiMarker),
      source,
      fileName,
      size: buffer.length,
      reason: marker || huaweiMarker || ''
    }
  } catch {
    return { isMotionPhoto: false, source, fileName }
  }
}

async function prepareMarkdownImages (adapter, data, msg) {
  const items = (Array.isArray(msg) ? msg : [msg]).map(normalizeMessageItem)
  const images = items
    .map((item, index) => ({ item, index, input: getImageInput(item) }))
    .filter(item => item.input)

  const results = new Map()
  await Promise.all(images.map(async ({ index, input }) => {
    try {
      const motionPhoto = await inspectMotionPhoto(input)
      if (motionPhoto.isMotionPhoto) {
        Bot.makeLog?.('info', ['检测到 Motion Photo，使用 QQ 富媒体原始上传', {
          file_name: motionPhoto.fileName || 'buffer.jpg',
          file_size: motionPhoto.size,
          marker: motionPhoto.reason
        }], data.self_id)
        results.set(index, { motionPhoto: true, ...motionPhoto })
        return
      }

      results.set(index, await adapter.makeMarkdownImage(data, input))
    } catch (err) {
      Bot.makeLog?.('error', [`第${index + 1}张图片处理失败`, err], data.self_id)
      results.set(index, { des: '图片加载失败', url: '' })
    }
  }))

  return { items, results }
}

export {
  getExternalImageUrl,
  shouldUploadToImageBed,
  inspectMotionPhoto,
  prepareMarkdownImages
}

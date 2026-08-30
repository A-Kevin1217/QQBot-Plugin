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
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : ''
  } catch {
    return ''
  }
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
  inspectMotionPhoto,
  prepareMarkdownImages
}

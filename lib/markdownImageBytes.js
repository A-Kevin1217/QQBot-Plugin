/**
 * markdown 图片的「平台转得动」预处理。
 *
 * 背景：QQ 平台对 markdown 里的图片是**服务端下载转存**，对体量比富媒体敏感得多，
 * 超出后返回 304010 CHANGE_IMAGE_URL（图片转存错误）—— 消息里那张图就是裂的或发不出去。
 * 而富媒体（msg_type=7）走的是「先上传拿 file_info」，不经过转存，所以不受影响。
 *
 * 实测：一张 puppeteer 渲染的错误卡片 1440x5439 / 11.17MB(PNG)，只按体积降质到 q85 仍有
 * 2.36MB，而**边长一点没动**（5439px），平台照样拒。所以必须先限边长再降质。
 *
 * 这里保持纯函数、不依赖宿主的 Bot/logger，便于单测。
 */

/** markdown 图片最大边长（像素） */
export const MARKDOWN_IMAGE_MAX_PX = 4096

/**
 * @param {object} options
 * @param {Buffer} options.buffer            原始图片字节
 * @param {object} [options.sharp]           sharp 模块；缺失时直接放弃处理
 * @param {number} [options.maxPx]           最大边长
 * @param {number} [options.maxBytes]        体积上限（字节）；<=0 表示不限
 * @param {number} [options.quality]         缩放后的 jpeg 质量
 * @returns {Promise<{buffer: Buffer, resized: boolean, reason?: string} | null>}
 *          null 表示「无需处理或无法处理」，调用方应继续原流程
 */
export async function prepareMarkdownImageBytes (options = {}) {
  const {
    buffer,
    sharp,
    maxPx = MARKDOWN_IMAGE_MAX_PX,
    maxBytes = 0,
    quality = 90
  } = options

  if (!sharp || typeof sharp !== 'function') return null
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null

  let output = buffer

  // 1) 限边长：这是 markdown 转存失败的主因，且只降质解决不了
  let resizedForDimension = false
  try {
    const meta = await sharp(buffer).metadata()
    const width = Number(meta.width) || 0
    const height = Number(meta.height) || 0
    const maxSide = Math.max(width, height)
    if (maxSide > maxPx && width > 0 && height > 0) {
      const scale = maxPx / maxSide
      const resized = sharp(buffer).resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        fit: 'inside',
        withoutEnlargement: true
      })
      // jpeg 和 png 各编一份取更小的：对**高度可压缩的 PNG**（纯色/扁平插画/渲染卡片）
      // 转 jpeg 反而会变大 —— 实测一张 20KB 的图转 jpeg 后 105KB，等于把要解决的问题放大。
      const [asJpeg, asPng] = await Promise.all([
        resized.clone().jpeg({ quality }).toBuffer(),
        resized.clone().png({ compressionLevel: 9 }).toBuffer()
      ])
      output = asPng.length < asJpeg.length ? asPng : asJpeg
      resizedForDimension = true
    }
  } catch {
    // 缩不下来就退回原流程，不要因为预处理把消息本身搞挂
    output = buffer
    resizedForDimension = false
  }

  // 2) 体积兜底：缩放后通常已经不超，这里只处理 maxBytes 给定时仍然超的情况
  if (maxBytes > 0 && output.length > maxBytes) {
    try {
      let q = 85
      let encoded = await sharp(output).jpeg({ quality: q }).toBuffer()
      while (encoded.length > maxBytes && q > 10) {
        q -= 10
        encoded = await sharp(output).jpeg({ quality: q }).toBuffer()
      }
      output = encoded
    } catch {
      // 保留上一步的结果
    }
  }

  // 没做尺寸缩减、且结果不比原图小 —— 处理只会让文件更大，不如原样放过
  if (!resizedForDimension && output.length >= buffer.length) return null
  if (!Buffer.isBuffer(output) || !output.length) return null

  const outMeta = await sharp(output).metadata().catch(() => ({}))
  const reason = `${Math.max(Number(outMeta.width) || 0, Number(outMeta.height) || 0)}px`
  return { buffer: output, resized: true, reason }
}

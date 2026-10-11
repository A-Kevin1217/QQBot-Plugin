import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { readFileSync, existsSync } from 'node:fs'
import { prepareMarkdownImageBytes, MARKDOWN_IMAGE_MAX_PX } from '../lib/markdownImageBytes.js'

const CARD = '/home/xiaoa/.hermes/cache/scratch/img2.png'
const hasCard = existsSync(CARD)

/** 造一张指定尺寸的 PNG（纯色，压缩后极小，但像素尺寸是真的） */
const makeImage = (w, h) => sharp({
  create: { width: w, height: h, channels: 3, background: { r: 30, g: 40, b: 60 } }
}).png().toBuffer()

const meta = buf => sharp(buf).metadata()

test('长边超限的图片被缩放到上限以内', async () => {
  const src = await makeImage(1000, 9000)
  const r = await prepareMarkdownImageBytes({ buffer: src, sharp, maxPx: 4096 })
  assert.ok(r, '应当发生缩放')
  const m = await meta(r.buffer)
  assert.ok(Math.max(m.width, m.height) <= 4096, `长边应 <= 4096，实际 ${Math.max(m.width, m.height)}`)
  // 需要保持长宽比（允许取整误差）
  const before = 1000 / 9000
  const after = m.width / m.height
  assert.ok(Math.abs(before - after) < 0.01, `长宽比应保持: ${before.toFixed(4)} vs ${after.toFixed(4)}`)
})

test('宽边超限同样被处理', async () => {
  const src = await makeImage(8000, 500)
  const r = await prepareMarkdownImageBytes({ buffer: src, sharp, maxPx: 4096 })
  assert.ok(r)
  const m = await meta(r.buffer)
  assert.ok(m.width <= 4096, `宽应 <= 4096，实际 ${m.width}`)
})

test('尺寸合规的小图不做任何处理（返回 null，走原流程）', async () => {
  const src = await makeImage(800, 600)
  const r = await prepareMarkdownImageBytes({ buffer: src, sharp, maxPx: 4096 })
  assert.equal(r, null)
})

test('尺寸合规但体积超限时按体积降质', async () => {
  // 平滑渐变图：体积可控且 jpeg 能稳定压下去
  const w = 1600, h = 1600
  const raw = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      raw[i] = x % 256
      raw[i + 1] = y % 256
      raw[i + 2] = (x + y) % 256
    }
  }
  const src = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer()
  const limit = 300 * 1024
  assert.ok(src.length > limit, `样本应超过 ${limit} 字节，实际 ${src.length}`)

  const r = await prepareMarkdownImageBytes({ buffer: src, sharp, maxPx: 4096, maxBytes: limit })
  assert.ok(r, '体积超限时应当处理')
  assert.ok(r.buffer.length <= limit, `体积应 <= ${limit}，实际 ${r.buffer.length}`)
})

test('体积下不去时（质量已到下限）不自暴自弃，也不把图变大', async () => {
  // 纯噪点几乎不可压缩
  const w = 1200, h = 1200
  const raw = Buffer.alloc(w * h * 3)
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7919) % 256
  const src = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer()

  const r = await prepareMarkdownImageBytes({ buffer: src, sharp, maxPx: 4096, maxBytes: 1024 })
  // 尺寸合规、降质又压不到目标 —— 要么返回比原图小的结果，要么返回 null 让原流程处理；
  // 绝不允许返回一个比原图更大的 buffer。
  if (r) assert.ok(r.buffer.length < src.length, `不应变大: ${src.length} -> ${r.buffer.length}`)
})

test('高度可压缩的 PNG 被重新编码时不会反而变大', async () => {
  // 之前用 jpeg 硬编会踩这里：20KB 的扁平图转 jpeg 后 105KB
  const src = await sharp({
    create: { width: 3000, height: 3000, channels: 3, background: { r: 250, g: 250, b: 250 } }
  }).png().toBuffer()

  const r = await prepareMarkdownImageBytes({ buffer: src, sharp, maxPx: 1024, maxBytes: 0 })
  assert.ok(r, '超长边应当被处理')
  assert.ok(r.buffer.length <= src.length, `处理不应让文件变大: ${src.length} -> ${r.buffer.length}`)
  const m = await sharp(r.buffer).metadata()
  assert.ok(Math.max(m.width, m.height) <= 1024, `长边应 <= 1024，实际 ${Math.max(m.width, m.height)}`)
})

test('sharp 缺失时返回 null 而不是抛错（宿主没装 sharp 也要能发消息）', async () => {
  const src = await makeImage(1000, 9000)
  const r = await prepareMarkdownImageBytes({ buffer: src, sharp: undefined, maxPx: 4096 })
  assert.equal(r, null)
})

test('空 / 非法输入返回 null', async () => {
  assert.equal(await prepareMarkdownImageBytes({ buffer: Buffer.alloc(0), sharp }), null)
  assert.equal(await prepareMarkdownImageBytes({ buffer: 'not-a-buffer', sharp }), null)
  assert.equal(await prepareMarkdownImageBytes({ sharp }), null)
})

test('输入不是图片时返回 null，不把调用方带崩', async () => {
  const r = await prepareMarkdownImageBytes({ buffer: Buffer.from('这不是一张图片'), sharp, maxPx: 4096 })
  assert.equal(r, null)
})

test('MARKDOWN_IMAGE_MAX_PX 是 4096', () => {
  assert.equal(MARKDOWN_IMAGE_MAX_PX, 4096)
})

// ---- 用真实故障卡回归（存在才跑） ----
test('真实错误卡片 1440x5439 / 11MB：仅降质不够，必须限边长', { skip: !hasCard && '缺少样本图' }, async () => {
  const src = readFileSync(CARD)
  const srcMeta = await meta(src)
  const srcSide = Math.max(srcMeta.width, srcMeta.height)
  assert.ok(srcSide > 4096, `样本应超限，实际 ${srcSide}`)

  // 旧逻辑：只按体积降质，边长不动 —— 证明这才是漏掉的那一环
  const sizeLimit = 3 * 1024 * 1024
  let q = 95
  let oldOut = await sharp(src).jpeg({ quality: q }).toBuffer()
  while (oldOut.length > sizeLimit && q > 10) {
    q -= 10
    oldOut = await sharp(src).jpeg({ quality: q }).toBuffer()
  }
  const oldMeta = await meta(oldOut)
  assert.ok(oldOut.length <= sizeLimit, '旧逻辑确实把体积压下来了')
  assert.equal(Math.max(oldMeta.width, oldMeta.height), srcSide, '但边长一点没动 —— 平台照样拒')

  // 新逻辑：限边长 + 体积兜底
  const r = await prepareMarkdownImageBytes({
    buffer: src, sharp, maxPx: 4096, maxBytes: sizeLimit
  })
  assert.ok(r, '应当处理')
  const m = await meta(r.buffer)
  assert.ok(Math.max(m.width, m.height) <= 4096, `长边应 <= 4096，实际 ${Math.max(m.width, m.height)}`)
  assert.ok(r.buffer.length <= sizeLimit, `体积应 <= 3MB，实际 ${(r.buffer.length / 1024 / 1024).toFixed(2)}MB`)
  assert.ok(['jpeg', 'png', 'webp'].includes(m.format), '仍是可展示图片')
})

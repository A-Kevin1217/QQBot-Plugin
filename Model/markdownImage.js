function normalizeMessageItem (item) {
  return item && typeof item === 'object' ? { ...item } : { type: 'text', text: item }
}

function getImageInput (item) {
  if (!item || item.type !== 'image') return null
  return item.file ? item : item.data
}

async function prepareMarkdownImages (adapter, data, msg) {
  const items = (Array.isArray(msg) ? msg : [msg]).map(normalizeMessageItem)
  const images = items
    .map((item, index) => ({ item, index, input: getImageInput(item) }))
    .filter(item => item.input)

  const results = new Map()
  await Promise.all(images.map(async ({ index, input }) => {
    try {
      results.set(index, await adapter.makeMarkdownImage(data, input))
    } catch (err) {
      Bot.makeLog?.('error', [`第${index + 1}张图片处理失败`, err], data.self_id)
      results.set(index, { des: '![图片加载失败]', url: '()' })
    }
  }))

  return { items, results }
}

export {
  prepareMarkdownImages
}

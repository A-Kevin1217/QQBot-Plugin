const STATS_KEY = 'Yunzai:QQBot:imgBed:stats'
const MAX_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const STATS_TTL = (MAX_DAYS + 1) * 24 * 60 * 60
const MAX_RECORDS = 5000

const BED_ALIAS = {
  cnb: 'cnb',
  bilibili: 'bilibili',
  'b站': 'bilibili',
  b站: 'bilibili',
  huaban: 'huaban',
  '花瓣': 'huaban',
  cos: 'cos',
  qqchannel: 'qqchannel',
  'qq频道': 'qqchannel',
  telegraph: 'telegraph',
  tg: 'telegraph',
  tencentci: 'tencentci',
  '腾讯云ci': 'tencentci',
  '腾讯云': 'tencentci',
  ci: 'tencentci',
  cosdemo: 'tencentci',
  all: ''
}

const BED_NAMES = {
  cnb: 'CNB',
  bilibili: 'B站',
  huaban: '花瓣网',
  cos: 'COS',
  qqchannel: 'QQ频道',
  telegraph: 'Telegraph',
  tencentci: '腾讯云CI',
  unknown: '未知图床'
}

function getRedis () {
  return typeof redis === 'undefined' ? null : redis
}

function toInt (value, fallback = 0) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function clampDays (days) {
  return Math.max(1, Math.min(MAX_DAYS, toInt(days, 1)))
}

function normalizeBed (bed = '') {
  const key = String(bed || '').trim().toLowerCase()
  return BED_ALIAS[key] ?? key
}

function getBedName (bed = '') {
  const key = normalizeBed(bed)
  return BED_NAMES[key] || bed || '图床'
}

async function recordImageBedStat ({ bed, name, success, size = 0, cost = 0, error = '' }) {
  const client = getRedis()
  if (!client || !bed) return

  const now = Date.now()
  const record = {
    ts: now,
    bed,
    name: name || bed,
    success: !!success,
    size: toInt(size, 0),
    cost: toInt(cost, 0),
    error: String(error || '').slice(0, 200)
  }

  const cutoff = now - MAX_DAYS * DAY_MS
  const multi = client.multi()
  multi.zAdd(STATS_KEY, { score: now, value: JSON.stringify(record) })
  multi.zRemRangeByScore(STATS_KEY, 0, cutoff)
  if (typeof multi.zRemRangeByRank === 'function') {
    multi.zRemRangeByRank(STATS_KEY, 0, -MAX_RECORDS - 1)
  }
  if (typeof multi.expire === 'function') multi.expire(STATS_KEY, STATS_TTL)
  await multi.exec()
}

async function getImageBedStats (days = 1, bed = '') {
  const client = getRedis()
  days = clampDays(days)
  bed = normalizeBed(bed)
  if (!client) return { days, bed, total: 0, rows: [] }

  const now = Date.now()
  const minTs = now - days * DAY_MS
  await client.zRemRangeByScore(STATS_KEY, 0, now - MAX_DAYS * DAY_MS)
  if (typeof client.expire === 'function') await client.expire(STATS_KEY, STATS_TTL)

  const values = await client.zRangeByScore(STATS_KEY, minTs, now)
  const rows = new Map()

  for (const value of values) {
    let item
    try {
      item = JSON.parse(value)
    } catch {
      continue
    }
    if (bed && item.bed !== bed) continue
    const key = item.bed || 'unknown'
    const row = rows.get(key) || {
      bed: key,
      name: item.name || getBedName(key),
      ok: 0,
      fail: 0,
      totalSize: 0,
      minCost: 0,
      maxCost: 0,
      totalCost: 0,
      minSize: 0,
      maxSize: 0
    }

    const size = toInt(item.size, 0)
    const cost = toInt(item.cost, 0)
    if (item.success) {
      row.ok++
      row.totalSize += size
      row.totalCost += cost
      row.minCost = row.minCost ? Math.min(row.minCost, cost) : cost
      row.maxCost = Math.max(row.maxCost, cost)
      row.minSize = row.minSize ? Math.min(row.minSize, size) : size
      row.maxSize = Math.max(row.maxSize, size)
    } else {
      row.fail++
    }
    rows.set(key, row)
  }

  const list = [...rows.values()].map(row => ({
    ...row,
    total: row.ok + row.fail,
    successRate: percent(row.ok, row.ok + row.fail),
    avgCost: row.ok ? Math.round(row.totalCost / row.ok) : 0,
    avgSize: row.ok ? Math.round(row.totalSize / row.ok) : 0
  })).sort((a, b) => b.total - a.total)

  return { days, bed, total: list.reduce((sum, row) => sum + row.total, 0), rows: list }
}

function percent (num, den) {
  if (!den) return '0.00%'
  return `${((num / den) * 100).toFixed(2)}%`
}

function formatBytes (bytes = 0) {
  bytes = toInt(bytes, 0)
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}

function formatMs (ms = 0) {
  ms = toInt(ms, 0)
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`
}

function speedLevel (avgCost) {
  if (avgCost <= 600) return '⚡ 很快'
  if (avgCost <= 1500) return '🚀 良好'
  if (avgCost <= 3000) return '🟡 一般'
  return '🐢 偏慢'
}

function formatImageBedStats (stats) {
  if (!stats.rows.length) {
    const title = stats.bed ? `${getBedName(stats.bed)} 详情` : '图床状态'
    return `# ${title}\r> 统计区间：${stats.days}天\r> 数据保留：${MAX_DAYS}天\r> 暂无上传记录`
  }

  if (stats.bed) {
    const row = stats.rows[0]
    return [
      `# ${row.name} 详情`,
      `> 统计区间：${stats.days}天`,
      `> 数据保留：${MAX_DAYS}天`,
      `> 上传表现：${speedLevel(row.avgCost)}`,
      '',
      '## 状态统计',
      '| 指标 | 数值 |',
      '|---|---:|',
      `| 上传成功 | ${row.ok} 张 |`,
      `| 上传失败 | ${row.fail} 次 |`,
      `| 成功率 | ${row.successRate} |`,
      `| 最大 | ${formatBytes(row.maxSize)} |`,
      `| 最小 | ${formatBytes(row.minSize)} |`,
      `| 总大小 | ${formatBytes(row.totalSize)} |`,
      `| 平均单张大小 | ${formatBytes(row.avgSize)} |`,
      '',
      '## 耗时统计',
      '| 项目 | 数值 |',
      '|---|---:|',
      `| 最短上传耗时 | ${formatMs(row.minCost)} |`,
      `| 最长上传耗时 | ${formatMs(row.maxCost)} |`,
      `| 平均上传耗时 | ${formatMs(row.avgCost)} |`
    ].join('\r')
  }

  return [
    '# 图床状态',
    `> 统计区间：${stats.days}天`,
    `> 使用图床：${stats.rows.length} 个`,
    '',
    '| 图床 | 成功 | 失败 | 成功率 | 平均耗时 | 总大小 |',
    '|---|---:|---:|---:|---:|---:|',
    ...stats.rows.map(row => `| ${row.name} | ${row.ok} | ${row.fail} | ${row.successRate} | ${formatMs(row.avgCost)} | ${formatBytes(row.totalSize)} |`)
  ].join('\r')
}

export {
  MAX_DAYS,
  normalizeBed,
  getBedName,
  recordImageBedStat,
  getImageBedStats,
  formatImageBedStats
}

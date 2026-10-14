/**
 * 群成员禁言（/v2/groups/{group_openid}/restrict_chat_setting）入参整理。
 *
 * 官方约束：
 * - 单次设置最多 20 个成员，超出需要分批；
 * - op 只有 add / update / del 三种，op=del 时 mute_expire_at 传空串表示立即解除；
 * - 最大禁言时长 30 天，超过会被服务端拒绝，这里直接夹紧到 30 天。
 */

/** 官方限制：单次禁言设置最多 20 个成员 */
export const GROUP_MUTE_BATCH_LIMIT = 20

/** 官方限制：最大禁言时长 30 天（秒） */
export const GROUP_MUTE_MAX_SECONDS = 30 * 24 * 60 * 60

const MUTE_OPS = new Set(['add', 'update', 'del'])

function pickMemberOpenid(item) {
  if (item == null) return ''
  if (typeof item === 'string' || typeof item === 'number') return String(item).trim()
  const value = item.member_openid ?? item.memberOpenid ?? item.user_id ?? item.userId ?? item.openid ?? item.raw_user_id
  return value == null ? '' : String(value).trim()
}

function pickOp(item) {
  if (!item || typeof item !== 'object') return ''
  const op = String(item.op ?? '').trim().toLowerCase()
  return MUTE_OPS.has(op) ? op : ''
}

/** 秒 → RFC3339；非正数返回空串（官方约定：空串表示立即解除禁言） */
export function buildMuteExpireAt(duration) {
  const seconds = Number(duration)
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const clamped = Math.min(seconds, GROUP_MUTE_MAX_SECONDS)
  return new Date(Date.now() + clamped * 1000).toISOString()
}

function pickExpireAt(item) {
  if (!item || typeof item !== 'object') return undefined
  if (item.mute_expire_at !== undefined) return item.mute_expire_at == null ? '' : String(item.mute_expire_at)
  if (item.muteExpireAt !== undefined) return item.muteExpireAt == null ? '' : String(item.muteExpireAt)
  return undefined
}

function pickDuration(item, fallback) {
  if (item && typeof item === 'object') {
    const raw = item.duration ?? item.time ?? item.seconds
    if (raw !== undefined && raw !== null && raw !== '') return Number(raw)
  }
  return fallback
}

/**
 * 把单条成员描述整理成官方结构 { op, member_openid, mute_expire_at }。
 *
 * 支持三种写法：
 * - 'openid' / 123456        → 按默认时长禁言（无默认时长时不带 mute_expire_at）
 * - { member_openid, duration } → duration 秒，>0 禁言、<=0 解禁
 * - { member_openid, op, mute_expire_at } → 完全透传官方语义
 */
export function normalizeMuteMember(item, defaultDuration) {
  const memberOpenid = pickMemberOpenid(item)
  if (!memberOpenid) return null

  const explicitOp = pickOp(item)
  const explicitExpire = pickExpireAt(item)
  const duration = pickDuration(item, defaultDuration)

  let op = explicitOp
  if (!op) op = Number.isFinite(duration) && duration <= 0 ? 'del' : 'add'

  let muteExpireAt
  if (op === 'del') {
    muteExpireAt = ''
  } else if (explicitExpire !== undefined) {
    muteExpireAt = explicitExpire
  } else if (Number.isFinite(duration) && duration > 0) {
    muteExpireAt = buildMuteExpireAt(duration)
  }

  const member = { op, member_openid: memberOpenid }
  if (muteExpireAt !== undefined) member.mute_expire_at = muteExpireAt
  return member
}

/**
 * 整理成员列表，并按 member_openid 去重（后者覆盖前者，避免同一次请求里自相矛盾）。
 */
export function normalizeMuteMembers(list, defaultDuration) {
  const items = Array.isArray(list) ? list : list == null ? [] : [list]
  const merged = new Map()
  for (const item of items) {
    const member = normalizeMuteMember(item, defaultDuration)
    if (member) merged.set(member.member_openid, member)
  }
  return [...merged.values()]
}

/** 按官方单次上限切片，返回二维数组 */
export function chunkMuteMembers(members, limit = GROUP_MUTE_BATCH_LIMIT) {
  const size = Number(limit) > 0 ? Math.floor(Number(limit)) : GROUP_MUTE_BATCH_LIMIT
  const chunks = []
  for (let i = 0; i < members.length; i += size) chunks.push(members.slice(i, i + size))
  return chunks
}

/**
 * 整理 → 还原官方 member_openid → 去重 → 分批，产出可直接 POST 给官方接口的批次列表。
 *
 * resolveOpenid 负责把框架内部 userId（可能带 `机器人号:` 前缀）还原成官方 member_openid；
 * 还原后仍重复的成员只保留最后一条，避免同一次请求里对同一人自相矛盾。
 */
export function buildMuteRequests(list, defaultDuration, resolveOpenid) {
  const resolve = typeof resolveOpenid === 'function' ? resolveOpenid : value => value
  const merged = new Map()
  for (const item of normalizeMuteMembers(list, defaultDuration)) {
    const memberOpenid = String(resolve(item.member_openid) ?? '').trim()
    if (!memberOpenid) continue
    merged.set(memberOpenid, { ...item, member_openid: memberOpenid })
  }
  return chunkMuteMembers([...merged.values()])
}

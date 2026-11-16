/**
 * 群成员批量移除（/v2/groups/{group_openid}/batch_remove_members）入参整理。
 *
 * 官方约束：
 * - 单次最多 20 个 openid，超出需要分批（SDK 的 removeMembers 不分批，超了直接失败）；
 * - 需要群主/机器人侧的「移除群成员」权限开关（未开时 40103011 / 40103012）；
 * - 该接口只踢人，不涉及禁言，和 restrict_chat_setting 是两条链路。
 */

/** 官方限制：单次移除最多 20 个成员 */
export const GROUP_REMOVE_BATCH_LIMIT = 20

function pickOpenid (item) {
  if (item == null) return ''
  if (typeof item === 'string' || typeof item === 'number') return String(item).trim()
  const value = item.member_openid ?? item.memberOpenid ?? item.user_id ?? item.userId ?? item.openid ?? item.raw_user_id
  return value == null ? '' : String(value).trim()
}

/**
 * 把各种形态的成员描述整理成去重后的 openid 列表。
 *
 * resolveOpenid 负责把框架内部 ID（可能带 `机器人号:` 前缀）还原成官方 member_openid。
 */
export function normalizeMemberOpenids (list, resolveOpenid) {
  const resolve = typeof resolveOpenid === 'function' ? resolveOpenid : value => value
  const items = Array.isArray(list) ? list : list == null ? [] : [list]
  const seen = new Set()
  for (const item of items) {
    const openid = String(resolve(pickOpenid(item)) ?? '').trim()
    if (openid) seen.add(openid)
  }
  return [...seen]
}

/** 按官方单次上限切片，返回二维数组 */
export function chunkMemberOpenids (openids, limit = GROUP_REMOVE_BATCH_LIMIT) {
  const size = Number(limit) > 0 ? Math.floor(Number(limit)) : GROUP_REMOVE_BATCH_LIMIT
  const chunks = []
  for (let i = 0; i < openids.length; i += size) chunks.push(openids.slice(i, i + size))
  return chunks
}

/** 整理 → 还原 openid → 去重 → 分批，产出可直接 POST 的批次列表 */
export function buildRemoveMemberRequests (list, resolveOpenid, limit = GROUP_REMOVE_BATCH_LIMIT) {
  return chunkMemberOpenids(normalizeMemberOpenids(list, resolveOpenid), limit)
}

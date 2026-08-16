function getStateValue(info, key) {
  if (!info || typeof info !== 'object') return undefined
  return info[key] ?? info.data?.[key]
}

export function normalizeGroupMemberRole(role) {
  const value = String(role ?? '').trim().toLowerCase()
  if (/(^|_)(owner|creator|group_owner)$/.test(value) || ['4', 'owner_role'].includes(value)) return 'owner'
  if (/(^|_)(admin|administrator|manager|group_admin)$/.test(value) || ['2', '3', 'admin_role'].includes(value)) return 'admin'
  return 'member'
}

export function normalizeGroupBotRole(info = {}, fallbackRole = 'member') {
  if (getStateValue(info, 'is_owner') || getStateValue(info, 'owner')) return 'owner'
  if (getStateValue(info, 'is_admin') || getStateValue(info, 'admin') || getStateValue(info, 'manager')) return 'admin'

  const candidates = [
    getStateValue(info, 'member_role'),
    getStateValue(info, 'role'),
    getStateValue(info, 'bot_role'),
    getStateValue(info, 'group_role'),
    getStateValue(info, 'permission')
  ]
  for (const item of candidates) {
    if (item == null || item === '') continue
    return normalizeGroupMemberRole(item)
  }
  return normalizeGroupMemberRole(fallbackRole)
}

export function buildGroupRoleFields(role) {
  role = normalizeGroupMemberRole(role)
  return {
    role,
    member_role: role,
    is_admin: role === 'admin',
    is_owner: role === 'owner',
    is_member: role === 'member'
  }
}

export function buildGroupBotStateFields(info = {}, fallbackRole = 'member') {
  const memberOpenid = getStateValue(info, 'member_openid')
  const joinedAt = getStateValue(info, 'joined_at')
  const allowProactiveMsg = getStateValue(info, 'allow_proactive_msg')
  const recvMsgSetting = getStateValue(info, 'recv_msg_setting')

  return {
    ...buildGroupRoleFields(normalizeGroupBotRole(info, fallbackRole)),
    member_openid: memberOpenid == null ? '' : String(memberOpenid),
    joined_at: joinedAt == null ? '' : String(joinedAt),
    allow_proactive_msg: typeof allowProactiveMsg === 'boolean' ? allowProactiveMsg : undefined,
    recv_msg_setting: recvMsgSetting == null ? '' : String(recvMsgSetting)
  }
}

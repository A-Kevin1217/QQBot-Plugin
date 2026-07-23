function getRawData(event) {
  return event?.raw?.d || event?.raw?.raw?.d || event?.raw_event?.d || {}
}

function parseMessageSceneExt(event) {
  const meta = {}
  const rawData = getRawData(event)
  const ext = event?.message_scene?.ext || event?.raw?.message_scene?.ext || rawData?.message_scene?.ext
  if (!Array.isArray(ext)) return meta

  for (const item of ext) {
    if (typeof item !== 'string') continue
    if (item.startsWith('ref_msg_idx=')) {
      meta.ref_msg_idx = item.slice('ref_msg_idx='.length)
    } else if (item.startsWith('msg_idx=')) {
      meta.msg_idx = item.slice('msg_idx='.length)
    }
  }
  return meta
}

function getMentionId(mention) {
  return mention?.member_openid || mention?.id || mention?.user_id || mention?.openid || ''
}

function getMentionMeta(botId, mentions) {
  const list = Array.isArray(mentions) ? mentions : []
  const atUsers = list.filter(m => m?.is_you !== true)
  const humanAtUsers = atUsers.filter(m => !m?.bot && m?.scope !== 'all')
  const botAtUsers = atUsers.filter(m => m?.bot === true)
  const atArray = atUsers.map(m => {
    const id = getMentionId(m)
    return id ? `${botId}:${id}` : ''
  }).filter(Boolean)

  return {
    mentions: list,
    atUsers,
    atArray,
    atme: list.some(m => m?.is_you === true),
    atall: list.some(m => m?.scope === 'all'),
    atbot: botAtUsers.length > 0 && humanAtUsers.length === 0
  }
}

function getMessageMeta(botId, event) {
  const rawData = getRawData(event)
  const msgElements = Array.isArray(event?.msg_elements)
    ? event.msg_elements
    : Array.isArray(event?.raw?.msg_elements)
      ? event.raw.msg_elements
      : Array.isArray(rawData?.msg_elements)
        ? rawData.msg_elements
        : []
  return {
    ...parseMessageSceneExt(event),
    msg_elements: msgElements,
    reply_user: msgElements[0]?.author || {},
    ...getMentionMeta(botId, event?.mentions)
  }
}

export {
  getMessageMeta
}

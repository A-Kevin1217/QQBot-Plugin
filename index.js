import _ from 'lodash'
import fs from 'node:fs'
import QRCode from 'qrcode'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import imageSize from 'image-size'
import crypto from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { encode as encodeSilk, isSilk } from 'silk-wasm'
import {
  Dau,
  importJS,
  Runtime,
  Handler,
  config,
  configSave,
  refConfig,
  isCNBEnabled,
  uploadToCNB,
  getExternalImageUrl,
  prepareMarkdownImages,
  IMG_BED_STATS_MAX_DAYS,
  normalizeBed,
  getBedName,
  recordImageBedStat,
  getImageBedStats,
  formatImageBedStats,
  splitMarkDownTemplate,
  getMustacheTemplating
} from './Model/index.js'
import { qrRegister, generateQRCode, BindStatus } from './Model/qr-auth.js'
import { getMessageMeta } from './Model/eventMeta.js'
import { patchSessionManager } from './lib/sessionManagerPatch.js'
import {
  sendWithGroupMarkdownImageRetry,
  uploadRichMediaByParts
} from './lib/richMediaUpload.js'
import {
  buildGroupBotStateFields,
  buildGroupRoleFields,
  normalizeGroupMemberRole
} from './lib/groupRole.js'

const require = createRequire(import.meta.url)

const QQBot = await (async () => {
  for (const pkg of ['qq-official-bot', 'qq-group-bot']) {
    try {
      const { Bot } = await import(pkg)
      return Bot
    } catch (e) { }
  }
})()

function adaptSendableForSDK(msg) {
  if (msg == null) return msg
  if (typeof msg === 'string') return msg
  if (Array.isArray(msg)) return msg.map(adaptSendableForSDK)
  if (typeof msg !== 'object') return msg
  if (msg.data && typeof msg.data === 'object') return msg
  const { type, ...rest } = msg
  return { type, data: rest }
}

function flattenReceivedMessage(msg) {
  if (!Array.isArray(msg)) return msg
  return msg.map(i => {
    if (!i || typeof i !== 'object') return i
    if (i.data && typeof i.data === 'object' && !i.text && !i.qq && !i.url && !i.file) {
      return { type: i.type, ...i.data }
    }
    return i
  })
}

function disableAxiosEnvProxy(request) {
  if (request?.defaults) request.defaults.proxy = false
}

function normalizeReplySegment(i) {
  const id = i?.id ?? i?.data?.id
  if (id == null || id === '') return null
  const idText = String(id)
  if (idText.startsWith('event_')) {
    return { type: 'reply', event_id: idText.replace(/^event_/, '') }
  }
  return { ...i, id: idText }
}

function normalizeEventId(id) {
  if (id == null || id === '') return ''
  return String(id).replace(/^event_/, '')
}

function pickCallbackEventId(...ids) {
  for (const id of ids) {
    if (id == null || id === '') continue
    const text = normalizeEventId(id)
    if (text.startsWith('INTERACTION_CREATE:')) return text
  }
  for (const id of ids) {
    if (id == null || id === '') continue
    const text = normalizeEventId(id)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return `INTERACTION_CREATE:${text}`
  }
  return ''
}

function normalizeSendEvent(event) {
  if (!event || (typeof event !== 'object' && typeof event !== 'function')) return {}
  return event
}


function normalizeMessageFingerprint(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500)
}

function getSegmentText(message) {
  if (!Array.isArray(message)) return ''
  return message.map(item => {
    if (!item || typeof item !== 'object') return ''
    if (item.type === 'text') return item.text || item.data?.text || ''
    return item.text || item.content || item.data?.text || item.data?.content || ''
  }).filter(Boolean).join('')
}

function clonePlain(value) {
  if (value == null) return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    if (Array.isArray(value)) return value.map(item => clonePlain(item))
    if (typeof value === 'object') return { ...value }
    return value
  }
}

function normalizeImageSegment(item = {}) {
  const data = item.data && typeof item.data === 'object' ? item.data : item
  const file = data.file || data.url || data.src || data.image || data.file_url || data.file_path
  if (!file) return null
  return {
    ...data,
    type: 'image',
    file,
    url: data.url || file
  }
}

function buildMessageFromQQBotElement(item = {}) {
  const message = []
  const nested = Array.isArray(item.message)
    ? item.message
    : Array.isArray(item.elements)
      ? item.elements
      : Array.isArray(item.msg_elements)
        ? item.msg_elements
        : []
  if (nested.length) message.push(...flattenReceivedMessage(nested))

  const text = item.content || item.text || item.raw_message || item.markdown?.content
  if (text) message.push({ type: 'text', text: String(text) })

  const images = []
  for (const key of ['image', 'image_data', 'attachment', 'file']) {
    const image = item[key]
    if (image && typeof image === 'object') images.push(image)
  }
  for (const listKey of ['images', 'attachments', 'files']) {
    if (Array.isArray(item[listKey])) images.push(...item[listKey])
  }
  for (const image of images) {
    const segment = normalizeImageSegment(image)
    if (segment) message.push(segment)
  }

  return message
}

function getQQBotQuotedMessage(payload = {}) {
  for (const item of getQQBotQuotedElements(payload)) {
    const message = buildMessageFromQQBotElement(item)
    if (message.length) return message
  }
  return []
}

function normalizeCachedMessage(message = []) {
  if (!Array.isArray(message)) return []
  return flattenReceivedMessage(message).map(item => {
    if (!item || typeof item !== 'object') return item
    if (item.type === 'image') {
      const image = normalizeImageSegment(item)
      return image || item
    }
    if (item.type === 'file') {
      const data = item.data && typeof item.data === 'object' ? item.data : item
      const url = data.url || data.file || data.path || data.file_url
      return url ? { ...data, type: 'file', url } : item
    }
    return item
  })
}

function getQQBotMessageContentFingerprint(payload = {}) {
  const candidates = [
    payload.raw_message,
    payload.content,
    payload.raw?.raw_message,
    payload.raw?.content,
    payload.raw?.raw?.d?.content,
    payload.raw_event?.d?.content,
    getSegmentText(payload.message),
    getSegmentText(payload.raw?.message)
  ]
  for (const item of candidates) {
    const value = normalizeMessageFingerprint(item)
    if (value) return value
  }
  return ''
}

function getQQBotQuotedElements(payload = {}) {
  return [
    ...(Array.isArray(payload.msg_elements) ? payload.msg_elements : []),
    ...(Array.isArray(payload.raw?.msg_elements) ? payload.raw.msg_elements : []),
    ...(Array.isArray(payload.raw?.raw?.d?.msg_elements) ? payload.raw.raw.d.msg_elements : []),
    ...(Array.isArray(payload.raw_event?.d?.msg_elements) ? payload.raw_event.d.msg_elements : [])
  ].filter(item => item && typeof item === 'object')
}

function getQQBotQuotedContentFingerprint(payload = {}) {
  for (const item of getQQBotQuotedElements(payload)) {
    const value = normalizeMessageFingerprint(
      item.content || item.text || item.raw_message || item.markdown?.content || getSegmentText(item.message)
    )
    if (value) return value
  }
  return ''
}

function getQQBotQuotedAuthorOpenid(payload = {}) {
  for (const item of getQQBotQuotedElements(payload)) {
    const author = item.author || item.sender || {}
    const id = author.member_openid || author.id || author.user_id || author.openid || author.user_openid
    if (id) return String(id)
  }
  return ''
}

function getQQBotQuotedAuthorBot(payload = {}) {
  for (const item of getQQBotQuotedElements(payload)) {
    const author = item.author || item.sender || {}
    if (typeof author.bot === 'boolean') return author.bot
  }
  return undefined
}

function getQQBotEventTime(payload = {}) {
  const value = payload._rawTimestamp || payload.raw?._rawTimestamp || payload.timestamp || payload.raw?.timestamp || payload.time || Date.now()
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 10000000000 ? numeric : numeric * 1000
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function getQQBotApiErrorCode(err) {
  return String(err?.code || err?.response?.data?.code || err?.data?.code || err?.message?.match?.(/code\((\d+)\)/)?.[1] || '')
}

function isQQBotApiNoAccessError(err) {
  return getQQBotApiErrorCode(err) === '11253'
}

function isGroupAtMessageEvent(event = {}) {
  return event.sub_type === 'at'
    || event.raw?.t === 'GROUP_AT_MESSAGE_CREATE'
    || event.raw_event?.t === 'GROUP_AT_MESSAGE_CREATE'
}

// QQ 官方 SDK 的申请事件在不同版本中可能直接携带字段，也可能把原始数据
// 放在 raw/raw_event/raw.d/raw_event.d 中。统一从这些位置读取，避免验证信息
// 在 SDK 事件解析时丢失。
function getJoinRequestCandidates(value = {}) {
  return [
    value,
    value?.raw_event,
    value?.raw,
    value?.raw_event?.d,
    value?.raw?.d
  ].filter(item => item && typeof item === 'object')
}

function getJoinRequestField(value, ...keys) {
  for (const candidate of getJoinRequestCandidates(value)) {
    for (const key of keys) {
      if (candidate[key] !== undefined && candidate[key] !== null && candidate[key] !== '') return candidate[key]
    }
  }
  return undefined
}

function getJoinRequestVerifyInfo(value) {
  let fallback
  for (const candidate of getJoinRequestCandidates(value)) {
    const info = candidate.verify_info ?? candidate.verifyInfo
    if (!info || typeof info !== 'object') continue
    fallback ??= info
    if (Object.keys(info).length) return info
  }
  return fallback || {}
}

function getJoinRequestComment(value, verifyInfo) {
  if (verifyInfo?.verify_message) return String(verifyInfo.verify_message)
  if (Array.isArray(verifyInfo?.review_qa_list)) {
    const qa = verifyInfo.review_qa_list
      .map(item => {
        const question = String(item?.question ?? '').trim()
        const answer = String(item?.answer ?? '').trim()
        return question && answer ? `${question}: ${answer}` : question || answer
      })
      .filter(Boolean)
    if (qa.length) return qa.join('\n')
  }
  return String(getJoinRequestField(value, 'comment', 'message') ?? '')
}

function patchGroupRequestEventParser(sdk) {
  for (const pkg of ['qq-official-bot', 'qq-group-bot']) {
    try {
      const eventsMod = require(`${pkg}/lib/events/index.js`)
      const QQEvent = eventsMod?.QQEvent
      const EventParserMap = eventsMod?.EventParserMap
      if (!QQEvent) continue
      if (!QQEvent.GROUP_JOIN_REQUEST) QQEvent.GROUP_JOIN_REQUEST = 'request.group'
      if (EventParserMap && !EventParserMap.has('request.group')) {
        EventParserMap.set('request.group', function (event, result) {
          const source = result || {}
          const sourceVerifyInfo = getJoinRequestVerifyInfo(source)
          const eventVerifyInfo = getJoinRequestVerifyInfo(event)
          const verifyInfo = Object.keys(sourceVerifyInfo).length ? sourceVerifyInfo : eventVerifyInfo
          return Object.assign(result || {}, {
            sub_type: source.sub_type || 'add',
            user_id: getJoinRequestField(source, 'member_openid', 'user_id') ?? getJoinRequestField(event, 'member_openid', 'user_id'),
            group_id: getJoinRequestField(source, 'group_openid', 'group_id') ?? getJoinRequestField(event, 'group_openid', 'group_id'),
            raw_user_id: getJoinRequestField(source, 'member_openid', 'raw_user_id') ?? getJoinRequestField(event, 'member_openid', 'raw_user_id'),
            join_request_id: getJoinRequestField(source, 'join_request_id', 'flag') ?? getJoinRequestField(event, 'join_request_id', 'flag'),
            verify_info: verifyInfo,
            comment: getJoinRequestComment(source, verifyInfo) || getJoinRequestComment(event, verifyInfo),
            risk_tips: getJoinRequestField(source, 'risk_tips') ?? getJoinRequestField(event, 'risk_tips') ?? ''
          })
        })
      }
      return
    } catch {}
  }
}

const startTime = new Date()
logger.info(logger.yellow('- 正在加载 QQBot 适配器插件'))

const _sdkVersion = await (async () => {
  for (const pkg of ['qq-official-bot', 'qq-group-bot']) {
    try {
      const { createRequire } = await import('node:module')
      const require = createRequire(import.meta.url)
      const { version } = require(`${pkg}/package.json`)
      return `${pkg} v${version}`
    } catch (e) { }
  }
  return 'QQBot'
})()
let sharp
if (config.imageLength) {
  try {
    sharp = (await import('sharp')).default
  } catch (err) {
    Bot.makeLog('error', ['sharp 导入错误，图片压缩关闭', err], 'QQBot-Plugin')
  }
}
const userIdCache = {}
const markdown_template = await importJS('Model/template/markdownTemplate.js', 'default')
const TmplPkg = await importJS('templates/index.js')

const adapter = new class QQBotAdapter {
  constructor() {
    this.id = 'QQBot'
    this.name = 'QQBot'
    this.path = 'data/QQBot/'
    this.version = _sdkVersion

    if (typeof config.toQRCode == 'boolean') {
      this.toQRCodeRegExp = config.toQRCode ? /(?<!\[(.*?)\]\()https?:\/\/[-\w_]+(\.[-\w_]+)+([-\w.,@?^=%&:/~+#]*[-\w@?^=%&/~+#])?/g : false
    } else {
      this.toQRCodeRegExp = new RegExp(config.toQRCode, 'g')
    }

    this.sep = ":"
    this.callbackEventCache = new Map()
    this.noticeEventCache = new Set()
    this.recallMessageCache = new Map()
    this.messageIndexCache = new Map()
    this.messageContentCache = new Map()
    this.refContentCache = new Map()
    this.groupBotStateCache = new Map()
    this.groupJoinRequestSyncCache = new Map()
    this.localMarkdownImageUrls = new Map()
    if (process.platform === "win32")
      this.sep = ""
    this.bind_user = {}
    this.appid = {}
  }


  async makeRecord(file) {
    if (config.toBotUpload) {
      for (const i of Bot.uin) {
        if (!Bot[i].uploadRecord) continue
        try {
          const url = await Bot[i].uploadRecord(file)
          if (url) return url
        } catch (err) {
          Bot.makeLog('error', ['Bot', i, '语音上传错误', file, err])
        }
      }
    }

    const inputFile = join('temp', randomUUID())
    const pcmFile = join('temp', randomUUID())

    try {
      const buffer = await Bot.Buffer(file)
      if (!Buffer.isBuffer(buffer)) return file
      if (isSilk(buffer)) return buffer

      fs.writeFileSync(inputFile, buffer)
      await Bot.exec(`ffmpeg -i "${inputFile}" -f s16le -ar 48000 -ac 1 "${pcmFile}"`)
      file = Buffer.from((await encodeSilk(fs.readFileSync(pcmFile), 48000)).data)
    } catch (err) {
      logger.error(`silk 转码错误：${err}`)
    }

    for (const i of [inputFile, pcmFile]) {
      try {
        fs.unlinkSync(i)
      } catch (err) { }
    }
    return file
  }

  async makeQRCode(data) {
    return (await QRCode.toDataURL(data)).replace('data:image/png;base64,', 'base64://')
  }

  async makeRawMarkdownText(data, text, button) {
    text = String(text ?? '')
    const match = text.match(this.toQRCodeRegExp)
    if (match) {
      for (const url of match) {
        button.push(...this.makeButtons(data, [[{ text: url, link: url }]]))
        const img = await this.makeMarkdownImage(data, await this.makeQRCode(url), '二维码')
        text = text.replace(url, `${img.des}${img.url}`)
      }
    }
    return text.replace(/@/g, '@​')
  }

  async makeBotImage(file) {
    if (config.toBotUpload) {
      for (const i of Bot.uin) {
        if (!Bot[i].uploadImage) continue
        try {
          const image = await Bot[i].uploadImage(file)
          if (image.url) return image
        } catch (err) {
          Bot.makeLog('error', ['Bot', i, '图片上传错误', file, err])
        }
      }
    }
  }

  async uploadToBilibili(data, buffer) {
    const cookie = config.imgBed?.bilibili
    if (!cookie) return
    try {
      const bili_jct = cookie.match(/bili_jct=([^;]+)/)?.[1]
      const SESSDATA = cookie.match(/SESSDATA=([^;]+)/)?.[1]
      if (!bili_jct || !SESSDATA) throw new Error('B站cookie无效')
      const form = new FormData()
      form.append('file_up', new Blob([buffer], { type: 'image/png' }), 'image.png')
      form.append('csrf', bili_jct)
      form.append('csrf_token', bili_jct)
      const res = await fetch('https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs', {
        method: 'POST', body: form,
        headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      })
      const json = await res.json()
      if (json.code === 0 && json.data?.image_url) return json.data.image_url
    } catch { }
  }

  async uploadToHuaban(data, buffer) {
    const cookie = config.imgBed?.huaban
    if (!cookie) return
    try {
      const boundary = '----' + crypto.randomBytes(16).toString('hex')
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image"\r\nContent-Type: image/png\r\n\r\n`),
        buffer,
        Buffer.from(`\r\n--${boundary}--`)
      ])
      const res = await fetch('https://api.huaban.com/upload', {
        method: 'POST', body: payload,
        headers: {
          Cookie: cookie,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      })
      const json = await res.json()
      if (json.key) return `https://hbimg.huabanimg.com/${json.key}`
    } catch { }
  }

  async uploadToTelegraph(data, buffer) {
    const api = config.imgBed?.telegraph || 'https://tg.telegra.ph/upload'
    try {
      const form = new FormData()
      form.append('file', new Blob([buffer], { type: 'image/jpeg' }), 'image.jpg')
      const res = await fetch(`${api}?source=bugtracker`, { method: 'POST', body: form })
      const json = await res.json()
      if (json.src) return new URL(api).origin + json.src
    } catch { }
  }

  async uploadToTencentCI(data, buffer) {
    const base = 'https://ci-exhibition.cloud.tencent.com'
    const cosHost = 'https://ci-h5-demo-1258125638.cos.ap-chengdu.myqcloud.com'
    const ext = this.#detectImageExt(buffer) || 'png'
    const headers = {
      Referer: 'https://cloud.tencent.com/act/pro/ciExhibition',
      Origin: 'https://cloud.tencent.com',
      'User-Agent': 'Mozilla/5.0'
    }

    const keyRes = await fetch(`${base}/samples/createUploadKey?${new URLSearchParams({
      ext,
      ciProcess: 'sensitive-content-recognition'
    })}`, { headers })
    if (!keyRes.ok) throw new Error(`获取腾讯云CI上传凭证失败: ${keyRes.status}`)

    const json = await keyRes.json()
    const key = json.data?.key
    const uploadAuthorization = json.data?.uploadAuthorization
    const ciProcessAuthorization = json.data?.ciProcessAuthorization
    if (!key || !uploadAuthorization) throw new Error('腾讯云CI上传凭证无效')

    const uploadUrl = `${cosHost}/${String(key).replace(/^\/+/, '')}`
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      body: buffer,
      headers: {
        ...headers,
        Authorization: uploadAuthorization,
        'x-cos-storage-class': 'STANDARD',
        'Content-Type': `image/${ext}`
      }
    })
    if (!uploadRes.ok) throw new Error(`腾讯云CI上传失败: ${uploadRes.status}`)

    if (ciProcessAuthorization) {
      const reviewUrl = `${uploadUrl}?${ciProcessAuthorization}&ci-process=sensitive-content-recognition&detect-type=porn,terrorist,politics,ads`
      try { await fetch(reviewUrl, { headers }) } catch { }
    }

    return uploadUrl
  }

  async uploadToCOS(data, buffer) {
    const cosConfig = config.imgBed?.cos
    if (!cosConfig?.createUploadKeyUrl || !cosConfig?.cosBucketUrlPrefix) return
    try {
      const ext = this.#detectImageExt(buffer) || 'jpg'
      const mime = `image/${ext}`
      const res = await fetch(`${cosConfig.createUploadKeyUrl}?ext=${ext}&ciProcess=sensitive-content-recognition`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.179 Mobile Safari/537.36',
          'origin': 'https://cloud.tencent.com',
          'referer': 'https://cloud.tencent.com/act/pro/ciExhibition'
        }
      })
      const json = await res.json()
      if (!json.data?.key || !json.data?.uploadAuthorization) throw new Error('获取COS凭证失败')
      const uploadUrl = cosConfig.cosBucketUrlPrefix + json.data.key
      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT', body: buffer,
        headers: { 'Content-Type': mime, 'Authorization': json.data.uploadAuthorization }
      })
      if (uploadRes.ok) return uploadUrl
    } catch { }
  }

  async uploadToQQChannel(data, buffer) {
    const chConfig = config.imgBed?.qqchannel
    if (!chConfig?.botQQ || !chConfig?.channelId) return
    try {
      const bot = Bot[chConfig.botQQ]
      if (!bot?.sdk?.sessionManager?.access_token) return
      const form = new FormData()
      form.append('msg_id', '0')
      form.append('file_image', new Blob([buffer], { type: 'image/jpeg' }), 'image.jpg')
      const res = await fetch(`https://api.sgroup.qq.com/channels/${chConfig.channelId}/messages`, {
        method: 'POST', body: form,
        headers: {
          Authorization: `QQBot ${bot.sdk.sessionManager.access_token}`,
          'X-Union-Appid': bot.info.appid,
          Accept: 'application/json'
        }
      })
      if (res.ok) {
        const md5 = crypto.createHash('md5').update(buffer).digest('hex').toUpperCase()
        return `https://gchat.qpic.cn/qmeetpic/0/0-0-${md5}/0`
      }
    } catch { }
  }

  #detectImageExt(buffer) {
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'jpg'
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'png'
    if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'gif'
    if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'webp'
    return 'jpg'
  }

  async #setMarkdownImageSizeFromSource(data, image, source, label = '图片') {
    try {
      const targetBuffer = Buffer.isBuffer(source) ? source : await Bot.Buffer(source)
      const size = imageSize(targetBuffer)
      image.width = size.width
      image.height = size.height
      if (image.width && image.height) {
        image.width = Math.floor(image.width * (config.markdownImgScale || 1))
        image.height = Math.floor(image.height * (config.markdownImgScale || 1))
      }
      return true
    } catch (err) {
      Bot.makeLog('error', [`${label}分辨率检测错误`, source, err], data.self_id)
      return false
    }
  }

  async uploadToImageBed(data, buffer) {
    if (config.imgBed?.enable === false) return

    const md5 = crypto.createHash('md5').update(buffer).digest('hex')
    const cacheKey = `Yunzai:QQBot:imgBed:${md5}`
    const ttl = config.imgBed?.cache_ttl || 600

    try {
      const cached = await redis.get(cacheKey)
      if (cached) {
        try {
          const res = await fetch(cached, { method: 'HEAD' })
          if (res.ok) return cached
          await redis.del(cacheKey)
        } catch {
          await redis.del(cacheKey)
        }
      }
    } catch { }

    const saveCache = async (url) => {
      if (url) {
        try { await redis.set(cacheKey, url, { EX: ttl }) } catch { }
      }
      return url
    }

    const beds = [
      ['cnb', 'CNB', isCNBEnabled(config.imgBed?.cnb), () => uploadToCNB(data, buffer, config.imgBed?.cnb), config.imgBed?.cnb?.stats !== false],
      ['bilibili', 'B站', !!config.imgBed?.bilibili, () => this.uploadToBilibili(data, buffer), true],
      ['huaban', '花瓣网', !!config.imgBed?.huaban, () => this.uploadToHuaban(data, buffer), true],
      ['cos', 'COS', !!(config.imgBed?.cos?.createUploadKeyUrl && config.imgBed?.cos?.cosBucketUrlPrefix), () => this.uploadToCOS(data, buffer), true],
      ['qqchannel', 'QQ频道', !!(config.imgBed?.qqchannel?.botQQ && config.imgBed?.qqchannel?.channelId), () => this.uploadToQQChannel(data, buffer), true],
      ['telegraph', 'Telegraph', !!config.imgBed?.telegraph, () => this.uploadToTelegraph(data, buffer), true],
      ['tencentci', '腾讯云CI', true, () => this.uploadToTencentCI(data, buffer), true]
    ]

    const recordStat = async (record) => {
      try {
        await recordImageBedStat(record)
      } catch (err) {
        Bot.makeLog('debug', ['图床统计写入失败', err], data.self_id)
      }
    }

    for (const [bed, name, enabled, upload, statsEnabled] of beds) {
      if (!enabled) continue
      const start = Date.now()
      try {
        const url = await upload()
        if (statsEnabled) await recordStat({
          bed,
          name,
          success: !!url,
          size: buffer.length,
          cost: Date.now() - start,
          error: url ? '' : 'empty_result'
        })
        if (url) {
          Bot.makeLog('debug', [`图床上传成功: ${name}`], data.self_id)
          return saveCache(url)
        }
      } catch (err) {
        if (statsEnabled) await recordStat({
          bed,
          name,
          success: false,
          size: buffer.length,
          cost: Date.now() - start,
          error: err.message
        })
        Bot.makeLog('debug', [`图床上传失败: ${name}`, err.message], data.self_id)
      }
    }

    Bot.makeLog('warn', ['图床上传失败，所有图床均不可用'], data.self_id)
    const defaultImageUrl = String(config.imgBed?.default || '').trim()
    return defaultImageUrl || undefined
  }

  rememberLocalMarkdownImageUrl(url, selfId) {
    url = String(url || '')
    if (!url.startsWith('http')) return

    const now = Date.now()
    for (const [key, value] of this.localMarkdownImageUrls) {
      if (value.expires <= now) this.localMarkdownImageUrls.delete(key)
    }
    this.localMarkdownImageUrls.set(url, {
      self_id: String(selfId || ''),
      expires: now + 10 * 60 * 1000
    })
  }

  async switchLocalMarkdownImagesToImageBed(data, message) {
    const now = Date.now()
    const payload = clonePlain(message)
    const text = JSON.stringify(payload)
    const localUrls = []
    for (const [url, record] of this.localMarkdownImageUrls) {
      if (record.expires <= now) {
        this.localMarkdownImageUrls.delete(url)
        continue
      }
      if (record.self_id === String(data.self_id || '') && text.includes(url)) localUrls.push(url)
    }
    if (!localUrls.length) return { message, replaced: 0 }

    const replacements = new Map()
    for (const localUrl of localUrls) {
      try {
        const buffer = await Bot.Buffer(localUrl, { http: true })
        const imageBedUrl = await this.uploadToImageBed(data, buffer)
        if (imageBedUrl && imageBedUrl !== localUrl) replacements.set(localUrl, String(imageBedUrl))
      } catch (err) {
        Bot.makeLog('warn', ['本地图片自动切换图床失败', localUrl, err], data.self_id)
      }
    }
    if (!replacements.size) return { message, replaced: 0 }

    const replaceStrings = value => {
      if (typeof value === 'string') {
        for (const [localUrl, imageBedUrl] of replacements) {
          value = value.split(localUrl).join(imageBedUrl)
        }
        return value
      }
      if (Array.isArray(value)) return value.map(replaceStrings)
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStrings(item)]))
      }
      return value
    }

    return {
      message: replaceStrings(payload),
      replaced: replacements.size,
      urls: [...replacements.values()]
    }
  }

  async makeMarkdownImage(data, file, summary = '图片') {
    const imageData = !Buffer.isBuffer(file) && file && typeof file === 'object' ? file : {}
    const imageMeta = imageData.data && typeof imageData.data === 'object' ? imageData.data : imageData
    const source = imageMeta.url || imageMeta.file || file
    const externalUrl = getExternalImageUrl(source)
    summary = imageMeta.summary ?? imageData.summary ?? summary

    let buffer
    let image
    if (externalUrl) {
      image = { url: externalUrl }
    } else {
      buffer = await Bot.Buffer(source)
      image = {}
      try {
        const localUrl = getExternalImageUrl(await Bot.fileToUrl(source))
        if (localUrl) {
          image.url = localUrl
          this.rememberLocalMarkdownImageUrl(image.url, data.self_id)
        }
      } catch (err) {
        Bot.makeLog('debug', ['本地图片服务转换失败', source, err], data.self_id)
      }
      if (!image.url) image = await this.makeBotImage(buffer) || {}
    }
    image.width = Number(imageMeta.width) || null
    image.height = Number(imageMeta.height) || null

    if (!image.width || !image.height) {
      try {
        buffer ??= await Bot.Buffer(source)
        const size = imageSize(buffer)
        image.width = size.width
        image.height = size.height
      } catch (err) {
        Bot.makeLog('error', ['图片分辨率检测错误', source, err], data.self_id)
      }
    }

    if (image.width && image.height) {
      image.width = Math.floor(image.width * (config.markdownImgScale || 1))
      image.height = Math.floor(image.height * (config.markdownImgScale || 1))
    }

    summary = String(summary ?? '图片')
    if (/[<>\[\]()]/.test(summary)) summary = '图片'

    // fileToUrl 可能已经生成了本地 HTTP 地址，但自定义图床仍需有机会将其替换为公网地址。
    // 只有输入本身就是外部直链时，才保留原地址并跳过自定义图床。
    if (!externalUrl && Handler.has('QQBot.makeMarkdownImage')) {
      const res = await Handler.call(
        'QQBot.makeMarkdownImage',
        data,
        {
          image,
          buffer,
          file: source,
          summary,
          config
        }
      )
      if (res) {
        typeof res == 'object' ? Object.assign(image, res) : image.url = res
      }
    }

    if (!image.url?.startsWith?.('http')) {
      const imgBedUrl = await this.uploadToImageBed(data, buffer)
      if (imgBedUrl) {
        image.url = imgBedUrl
        const defaultImageUrl = String(config.imgBed?.default || '').trim()
        if (defaultImageUrl.startsWith('http') && imgBedUrl === defaultImageUrl) {
          await this.#setMarkdownImageSizeFromSource(data, image, defaultImageUrl, '备用图片')
        }
      }
    }

    if (!image.url?.startsWith?.('http') && typeof Bot.imageToUrl === 'function') {
      try {
        image.url = await Bot.imageToUrl(source, {
          self_id: data.self_id,
          name: imageMeta.name || imageData.name
        })
      } catch (err) {
        Bot.makeLog('debug', ['自定义图片图床上传失败', source, err], data.self_id)
      }
    }

    Bot.makeLog('debug', [`图片URL: ${image.url}`, `来源: ${externalUrl ? '外部直链' : String(image.url).includes('File/') ? 'fileToUrl(本地服务)' : String(image.url).includes('gchat.qpic.cn') ? 'QQ CDN' : '图床'}`], data.self_id)

    return {
      des: `![${summary} #${image.width || 0}px #${image.height || 0}px]`,
      url: `(${image.url})`
    }
  }

  makeButton(data, button) {
    const msg = {
      id: button.id || randomUUID(),
      render_data: {
        label: button.text,
        visited_label: button.clicked_text ?? button.text,
        style: button.style ?? 1,
        ...button.QQBot?.render_data
      }
    }

    if (button.input) {
      msg.action = {
        type: button.type ?? 2,
        permission: { type: 2 },
        data: button.input,
        enter: button.send,
        reply: button.reply ?? false,
        anchor: button.anchor ?? 0,
        click_limit: button.click_limit ?? undefined,
        at_bot_show_channel_list: button.at_bot_show_channel_list ?? false,
        unsupport_tips: button.unsupport_tips || '当前客户端不支持此操作',
        ...button.QQBot?.action
      }
    } else if (button.callback) {
      if (config.toCallback || button.toCallback) {
        msg.action = {
          type: button.type ?? 1,
          permission: { type: 2 },
          data: button.callback,
          reply: button.reply ?? false,
          enter: button.enter ?? false,
          anchor: button.anchor ?? 0,
          click_limit: button.click_limit ?? undefined,
          at_bot_show_channel_list: button.at_bot_show_channel_list ?? false,
          unsupport_tips: button.unsupport_tips || '当前客户端不支持此操作',
          ...button.QQBot?.action
        }
        if (!Array.isArray(data._ret_id)) data._ret_id = []

        data.bot.callback[msg.id] = {
          id: data.message_id,
          user_id: data.user_id,
          group_id: data.group_id,
          message: button.callback,
          message_id: data._ret_id
        }
        // setTimeout(() => delete data.bot.callback[msg.id], 300000)
      } else {
        msg.action = {
          type: button.type ?? 1,
          permission: { type: 2 },
          data: button.callback,
          enter: true,
          reply: button.reply ?? false,
          anchor: button.anchor ?? 0,
          click_limit: button.click_limit ?? undefined,
          at_bot_show_channel_list: button.at_bot_show_channel_list ?? false,
          unsupport_tips: button.unsupport_tips || '当前客户端不支持此操作',
          ...button.QQBot?.action
        }
      }
    } else if (button.link) {
      msg.action = {
        type: button.type ?? 0,
        permission: { type: 2 },
        data: button.link,
        reply: button.reply ?? false,
        enter: button.enter ?? false,
        anchor: button.anchor ?? 0,
        click_limit: button.click_limit ?? undefined,
        at_bot_show_channel_list: button.at_bot_show_channel_list ?? false,
        unsupport_tips: button.unsupport_tips || '当前客户端不支持此操作',
        ...button.QQBot?.action
      }
    } else return false

    const groupId = button.group_id || button.QQBot?.group_id
    if (groupId) msg.group_id = String(groupId)

    if (button.modal || button.content || button.confirm_text || button.cancel_text) {
      const modal = button.modal || button
      msg.action.modal = {
        content: modal.content || '是否确认操作?',
        confirm_text: modal.confirm_text || '是',
        cancel_text: modal.cancel_text || '否'
      }
    }

    if (button.permission) {
      if (button.permission == 'admin') {
        msg.action.permission.type = 1
      } else {
        msg.action.permission.type = 0
        msg.action.permission.specify_user_ids = []
        if (!Array.isArray(button.permission)) button.permission = [button.permission]
        for (let id of button.permission) {
          if (config.toQQUin && userIdCache[id]) id = userIdCache[id]
          msg.action.permission.specify_user_ids.push(id.replace(`${data.self_id}${this.sep}`, ''))
        }
      }
    }
    return msg
  }

  makeButtons(data, button_square) {
    const msgs = []
    for (const button_row of button_square) {
      const buttons = []
      for (let button of button_row) {
        button = this.makeButton(data, button)
        if (button) buttons.push(button)
      }
      if (buttons.length) { msgs.push({ type: 'button', buttons }) }
    }
    return msgs
  }

  useRawButton(data) {
    return config.rawButton?.[data.self_id] !== false && config.rawButton?.[data.self_id] !== 'false'
  }

  escapeMarkdownLinkText(text) {
    return String(text ?? '').replace(/([\\\[\]])/g, '\\$1') || '按钮'
  }

  buttonToCommandMarkdown(buttonSegment) {
    const rows = Array.isArray(buttonSegment?.data) ? buttonSegment.data : []
    const lines = rows.map(row => {
      if (!Array.isArray(row)) return ''
      return row.map(item => {
        if (!item) return ''
        const label = this.escapeMarkdownLinkText(item.text)
        if (item.link?.startsWith?.('https://qun.qq.com/')) return `[${label}](${item.link})`
        const command = item.callback ?? item.input ?? item.link
        if (!command) return ''
        const enter = item.send || item.callback ? 'true' : 'false'
        const reply = item.reply ? 'true' : 'false'
        return `[${label}](mqqapi://aio/inlinecmd?command=${encodeURIComponent(command)}&enter=${enter}&reply=${reply})`
      }).filter(Boolean).join(' | ')
    }).filter(Boolean)

    return lines.length ? `\r***\r${lines.map(line => `\r${line}`).join('')}` : ''
  }

  async makeRawMarkdownMsg(data, msg) {
    const messages = []
    const button = []
    const files = []
    let content = ''
    let reply
    const { items, results: imageResults } = await prepareMarkdownImages(this, data, msg)

    for (let idx = 0; idx < items.length; idx++) {
      const i = items[idx]

      switch (i.type) {
        case 'record':
          i.type = 'audio'
          i.file = await this.makeRecord(i.file)
        case 'video':
        case 'face':
        case 'ark':
        case 'embed':
          messages.push([i])
          break
        case 'file': {
          Bot.makeLog('debug', ['file segment 原始结构', i], data.self_id)
          const fileData = this._parseFileSegment(i, data)
          files.push(fileData)
          Bot.makeLog('debug', ['收集文件消息', fileData], data.self_id)
          break
        }
        case 'at':
          if (i.qq == 'all') { content += '@everyone' } else { content += `<@${i.qq?.replace?.(`${data.self_id}${this.sep}`, '')}>` }
          break
        case 'text':
          content += await this.makeRawMarkdownText(data, i.text, button)
          break
        case 'image': {
          const { des, url } = imageResults.get(idx) || await this.makeMarkdownImage(data, i)
          content += `${des}${url}`
          break
        } case 'markdown':
          if (typeof i.data == 'object') messages.push([{ type: 'markdown', ...i.data }])
          else content += i.data
          break
        case 'button':
          if (this.useRawButton(data)) button.push(...this.makeButtons(data, i.data))
          else content += this.buttonToCommandMarkdown(i)
          break
        case 'keyboard':
          if (Array.isArray(i.data)) button.push(...i.data.filter(Boolean))
          else button.push(i)
          break
        case 'reply':
          reply = normalizeReplySegment(i) || reply
          continue
        case 'node':
          for (const { message } of i.data) { messages.push(...(await this.makeRawMarkdownMsg(data, message))) }
          continue
        case 'raw':
          if (Array.isArray(i.data)) {
            messages.push(i.data)
          } else if (i.data && (i.data.type === 'keyboard' || i.data.type === 'button')) {
            button.push(i.data)
          } else {
            messages.push([i.data])
          }
          break
        case 'stream':
          data.stream = true
          data.chunkSize = i.data?.chunkSize ?? config.chunkSize
          data.delay = i.data?.delay ?? config.delay
          break
        case 'small':
          data.smallbtn = true
          continue
        default:
          content += await this.makeRawMarkdownText(data, JSON.stringify(i), button)
      }
    }

    if (config.mdSuffix?.[data.self_id]) {
      const suffixParts = []
      for (const i of config.mdSuffix[data.self_id]) {
        if (data.group_id) data.group = data.bot.pickGroup(data.group_id)
        if (data.user_id) data.friend = data.bot.pickFriend(data.user_id)
        if (data.user_id && data.group_id) data.member = data.bot.pickMember(data.group_id, data.user_id)
        const value = getMustacheTemplating(i.values[0], { e: data })
        if (value) suffixParts.push(value)
      }
      if (suffixParts.length && content) content += '\r' + suffixParts.join('\r')
    }

    if (content) { messages.unshift([{ type: 'markdown', content }]) }

    if (button.length) {
      for (const i of messages) {
        if (i[0].type == 'markdown') { i.push(...button.splice(0, 5)) }
        if (!button.length) break
      }
      while (button.length) {
        messages.push([
          { type: 'markdown', content: ' ' },
          ...button.splice(0, 5)
        ])
      }
    }

    if (reply) {
      for (const i in messages) {
        if (Array.isArray(messages[i])) messages[i].unshift(reply)
        else messages[i] = [reply, messages[i]]
      }
    }

    if (files.length) data._files = files
    return messages
  }

  makeMarkdownText(data, text, button) {
    text = String(text ?? '')
    const match = text.match(this.toQRCodeRegExp)
    if (match) {
      for (const url of match) {
        button.push(...this.makeButtons(data, [[{ text: url, link: url }]]))
        text = text.replace(url, '[链接(请点击按钮查看)]')
      }
    }
    return text.replace(/\n/g, '\r').replace(/@/g, '@​')
  }

  makeMarkdownTemplate(data, template) {
    let keys; let custom_template_id; let params = []; let index = 0; let type = 0
    const result = []
    if (markdown_template) {
      custom_template_id = markdown_template.custom_template_id
      params = _.cloneDeep(markdown_template.params)
      type = 1
    } else {
      const custom = config.customMD?.[data.self_id]
      custom_template_id = custom?.custom_template_id || config.markdown[data.self_id]
      keys = _.cloneDeep(custom?.keys) || []
    }
    for (const temp of template) {
      if (!temp.length) continue

      for (const i of splitMarkDownTemplate(temp)) {
        if (index == (type == 1 ? markdown_template.params.length : keys.length)) {
          result.push({
            type: 'markdown',
            custom_template_id,
            params: _.cloneDeep(params)
          })
          params = type == 1 ? _.cloneDeep(markdown_template.params) : []
          index = 0
        }

        if (type == 1) {
          params[index].values = [i]
        } else {
          params.push({
            key: keys[index],
            values: [i]
          })
        }
        index++
      }
    }

    if (config.mdSuffix?.[data.self_id]) {
      if (!params.some(p => config.mdSuffix[data.self_id].some(c => (c.key === p.key && p.values[0] !== '\u200B')))) {
        for (const i of config.mdSuffix[data.self_id]) {
          if (data.group_id) data.group = data.bot.pickGroup(data.group_id)
          if (data.user_id) data.friend = data.bot.pickFriend(data.user_id)
          if (data.user_id && data.group_id) data.member = data.bot.pickMember(data.group_id, data.user_id)
          const value = getMustacheTemplating(i.values[0], { e: data })
          params.push({ key: i.key, values: [value] })
        }
      }
    }

    if (params.length) {
      result.push({
        type: 'markdown',
        custom_template_id,
        params
      })
    }

    return result
  }

  async makeMarkdownMsg(data, msg) {
    const messages = []
    const button = []
    const files = []
    let template = []
    let content = ''
    let reply
    const length = markdown_template?.params?.length || config.customMD?.[data.self_id]?.keys?.length || 0
    const { items, results: imageResults } = await prepareMarkdownImages(this, data, msg)

    for (let idx = 0; idx < items.length; idx++) {
      let i = items[idx]

      switch (i.type) {
        case 'record':
          i.type = 'audio'
          i.file = await this.makeRecord(i.file)
        case 'video':
        case 'face':
        case 'ark':
        case 'embed':
          messages.push([i])
          break
        case 'file': {
          Bot.makeLog('debug', ['file segment 原始结构', i], data.self_id)
          const fileData = this._parseFileSegment(i, data)
          files.push(fileData)
          Bot.makeLog('debug', ['收集文件消息', fileData], data.self_id)
          break
        }
        case 'at':
          if (i.qq == 'all') content += '@everyone'
          else {
            if (config.toQQUin && userIdCache[i.qq]) i.qq = userIdCache[i.qq]
            content += `<@${i.qq?.replace?.(`${data.self_id}${this.sep}`, '')}>`
          }
          break
        case 'text':
          content += this.makeMarkdownText(data, i.text, button)
          break
        case 'node':
          if (Handler.has('ws.tool.toImg') && config.toImg) {
            const getButton = data => {
              return data.flatMap(item => {
                if (Array.isArray(item.message)) {
                  return item.message.flatMap(msg => {
                    if (msg.type === 'node') return getButton(msg.data)
                    if (msg.type === 'button') return msg
                    return []
                  })
                }
                if (typeof item.message === 'object') {
                  if (item.message.type === 'button') return item.message
                  if (item.message.type === 'node') return getButton(item.message.data)
                }
                return []
              })
            }
            const btn = getButton(i.data)
            let result = btn.reduce((acc, cur) => {
              const duplicate = acc.find(obj => obj.text === cur.text && obj.callback === cur.callback && obj.input === cur.input && obj.link === cur.link)
              if (!duplicate) return acc.concat([cur])
              else return acc
            }, [])

            const e = {
              reply: (msg) => {
                i = msg
              },
              user_id: data.bot.uin,
              nickname: data.bot.nickname
            }

            e.runtime = new Runtime(e)
            i.data.cfg = { retType: 'msgId', returnID: true }
            let { wsids } = await Handler.call('ws.tool.toImg', e, i.data)

            if (!result.length && data.wsids && data.wsids?.fnc) {
              wsids = wsids.map((id, k) => ({ text: `${data.wsids.text}${k}`, callback: `#ws查看${id}` }))
              result = _.chunk(_.tail(wsids), data.wsids.col)
            }

            for (const b of result) {
              button.push(...this.makeButtons(data, b.data ? b.data : [b]))
            }
          } else if (TmplPkg && TmplPkg?.nodeMsg) {
            messages.push(...(await this.makeMarkdownMsg(data, TmplPkg.nodeMsg(i.data))))
            continue
          } else {
            for (const { message } of i.data) {
              messages.push(...(await this.makeMarkdownMsg(data, message)))
            }
            continue
          }
        case 'image': {
          const { des, url } = imageResults.get(idx) || await this.makeMarkdownImage(data, i)
          const limit = template.length % (length - 1)

          // 图片数量超过模板长度时
          if (template.length && !limit) {
            if (content) template.push(content)
            template.push(des)
          } else template.push(content + des)

          content = url
          break
        } case 'markdown':
          if (typeof i.data == 'object') messages.push([{ type: 'markdown', ...i.data }])
          else content += i.data
          break
        case 'button':
          if (this.useRawButton(data)) button.push(...this.makeButtons(data, i.data))
          else content += this.buttonToCommandMarkdown(i)
          break
        case 'keyboard':
          if (Array.isArray(i.data)) button.push(...i.data.filter(Boolean))
          else button.push(i)
          break
        case 'reply':
          reply = normalizeReplySegment(i) || reply
          continue
        case 'raw':
          if (Array.isArray(i.data)) {
            messages.push(i.data)
          } else if (i.data && (i.data.type === 'keyboard' || i.data.type === 'button')) {
            button.push(i.data)
          } else {
            messages.push([i.data])
          }
          break
        case 'custom':
          template.push(...i.data)
          break
        case 'stream':
          data.stream = true
          data.chunkSize = i.data?.chunkSize ?? config.chunkSize
          data.delay = i.data?.delay ?? config.delay
          break
        case 'small':
          data.smallbtn = true
          continue
        default:
          content += this.makeMarkdownText(data, JSON.stringify(i), button)
      }
    }

    if (content) template.push(content)
    if (template.length > length) {
      const templates = _(template).chunk(length).map(v => this.makeMarkdownTemplate(data, v)).value()
      messages.push(...templates)
    } else if (template.length) {
      const tmp = this.makeMarkdownTemplate(data, template)
      if (tmp.length > 1) {
        messages.push(...tmp.map(i => ([i])))
      } else {
        messages.push(tmp)
      }
    }

    if (template.length && button.length < 5 && config.btnSuffix[data.self_id]) {
      let { position, values } = config.btnSuffix[data.self_id]
      position = +position - 1
      if (position > button.length) {
        position = button.length
      }
      const btn = values.filter(i => {
        if (i.show) {
          switch (i.show.type) {
            case 'random':
              if (i.show.data <= _.random(1, 100)) return false
              break
            default:
              break
          }
        }
        return true
      })
      button.splice(position, 0, ...this.makeButtons(data, [btn]))
    }

    if (button.length) {
      for (const i of messages) {
        if (i[0].type == 'markdown') i.push(...button.splice(0, 5))
        if (!button.length) break
      }
      while (button.length) {
        messages.push([
          ...this.makeMarkdownTemplate(data, [' ']),
          ...button.splice(0, 5)
        ])
      }
    }
    if (reply) {
      for (const i of messages) {
        i.unshift(reply)
      }
    }
    if (files.length) data._files = files
    return messages
  }

  async compressImage(data, file) {
    try {
      const imageLength = Number(config.imageLength)
      if (!sharp || !Number.isFinite(imageLength) || imageLength <= 0) return file

      const size = imageLength * 1024 * 1024
      const buffer = await Bot.Buffer(file, { http: true })
      if (!Buffer.isBuffer(buffer) || buffer.length <= size) return file

      let quality = 95
      let output = await sharp(buffer).jpeg({ quality }).toBuffer()
      while (output.length > size && quality > 10) {
        quality -= 10
        output = await sharp(buffer).jpeg({ quality }).toBuffer()
      }

      Bot.makeLog('debug', `图片压缩完成 ${quality}%(${(output.length / 1024).toFixed(2)}KB)`, data.self_id)
      return output
    } catch (err) {
      Bot.makeLog('error', ['图片压缩错误', err], data.self_id)
      return file
    }
  }

  async makeMsg(data, msg) {
    const sendType = ['audio', 'image', 'video', 'file']
    const messages = []
    const button = []
    const files = []
    let message = []
    let reply

    for (let i of Array.isArray(msg) ? msg : [msg]) {
      if (typeof i == 'object') { i = { ...i } } else { i = { type: 'text', text: i } }

      switch (i.type) {
        case 'at':
          // if (config.toQQUin && userIdCache[user_id]) {
          //   i.qq = userIdCache[user_id]
          // }
          // i.qq = i.qq?.replace?.(`${data.self_id}${this.sep}`, "")
          continue
        case 'text':
        case 'face':
        case 'ark':
        case 'embed':
          break
        case 'record':
          i.type = 'audio'
          i.file = await this.makeRecord(i.file)
        case 'video':
          if (message.some(s => sendType.includes(s.type))) {
            messages.push(message)
            message = []
          }
          break
        case 'image':
          if (i.file) i.file = await this.compressImage(data, i.file)
          if (message.some(s => sendType.includes(s.type))) {
            messages.push(message)
            message = []
          }
          break
        case 'file': {
          Bot.makeLog('debug', ['file segment 原始结构', i], data.self_id)
          const fileData = this._parseFileSegment(i, data)
          files.push(fileData)
          Bot.makeLog('debug', ['收集文件消息', fileData], data.self_id)
          break
        }
        case 'reply':
          reply = normalizeReplySegment(i) || reply
          continue
        case 'markdown':
          if (typeof i.data == 'object') { i = { type: 'markdown', ...i.data } } else { i = { type: 'markdown', content: i.data } }
          break
        case 'button':
          config.sendButton && button.push(...this.makeButtons(data, i.data))
          continue
        case 'node':
          if (Handler.has('ws.tool.toImg') && config.toImg) {
            const e = {
              reply: (msg) => {
                i = msg
              },
              user_id: data.bot.uin,
              nickname: data.bot.nickname
            }
            e.runtime = new Runtime(e)
            await Handler.call('ws.tool.toImg', e, i.data)
            // i.file = await Bot.fileToUrl(i.file)
            if (message.some(s => sendType.includes(s.type))) {
              messages.push(message)
              message = []
            }
          } else {
            for (const { message } of i.data) {
              messages.push(...(await this.makeMsg(data, message)))
            }
          }
          break
        case 'raw':
          if (Array.isArray(i.data)) {
            messages.push(i.data)
            continue
          }
          i = i.data
          break
        case 'stream':
          data.stream = true
          data.chunkSize = i.data?.chunkSize ?? config.chunkSize
          data.delay = i.data?.delay ?? config.delay
          continue
        case 'small':
          data.smallbtn = true
          continue
        default:
          i = { type: 'text', text: JSON.stringify(i) }
      }

      if (i.type === 'text' && i.text) {
        const match = i.text.match(this.toQRCodeRegExp)
        if (match) {
          for (const url of match) {
            const msg = segment.image(await Bot.fileToUrl(await this.makeQRCode(url)))
            if (message.some(s => sendType.includes(s.type))) {
              messages.push(message)
              message = []
            }
            message.push(msg)
            i.text = i.text.replace(url, '[链接(请扫码查看)]')
          }
        }
      }

      if (i.type !== 'node') message.push(i)
    }

    if (message.length) { messages.push(message) }

    while (button.length) {
      messages.push([{
        type: 'keyboard',
        content: { rows: button.splice(0, 5) }
      }])
    }

    if (reply) {
      for (const i of messages) i.unshift(reply)
    }
    if (files.length) data._files = files
    return messages
  }

  async sendMsg(data, send, msg) {
    await this._preSendMsg?.(data, send, msg)

    const rets = { message_id: [], data: [], error: [] }
    let msgs

    Bot.makeLog('debug', ['sendMsg开始执行', { hasFiles: !!(data._files && data._files.length), filesCount: data._files?.length || 0 }], data.self_id)

    const sendMsg = async () => {
      for (const i of msgs) {
        try {
          Bot.makeLog('debug', ['发送消息', i], data.self_id)
          const ret = await send(i)
          Bot.makeLog('debug', ['发送消息返回', ret], data.self_id)

          rets.data.push(ret)
          await this.rememberSentMessageRef(data, ret)
          if (ret.id) rets.message_id.push(ret.id)
          Bot[data.self_id].dau.setDau('send_msg', data)
        } catch (err) {
          // Bot.makeLog('error', ['发送消息错误', i, err], data.self_id)
          logger.error(data.self_id, '发送消息错误', i, err)
          rets.error.push(err)
          return false
        }
      }
    }

    if (TmplPkg && TmplPkg?.Button && !data.toQQBotMD) {
      let fncName = /\[.*?\((\S+)\)\]/.exec(data.logFnc)[1]
      const Btn = TmplPkg.Button[fncName]

      if (msg.type === 'node') data.wsids = { toImg: config.toImg }

      let res
      if (Btn) res = Btn(data, msg)

      if (res?.nodeMsg) {
        data.toQQBotMD = true
        data.wsids = {
          text: res.nodeMsg,
          fnc: fncName,
          col: res.col
        }
      } else if (res) {
        data.toQQBotMD = true
        res = segment.button(...res)
        msg = _.castArray(msg)

        let _btn = msg.findIndex(b => b.type === 'button')
        if (_btn === -1) msg.push(res)
        else msg[_btn] = res
      }
    }

    if (data.toQQBotMD !== false) {
      const mdConfig = config.markdown[data.self_id]
      if (mdConfig && mdConfig !== 'raw') msgs = await this.makeMarkdownMsg(data, msg)
      else if (!mdConfig || mdConfig === 'raw') msgs = await this.makeRawMarkdownMsg(data, msg)
      else msgs = await this.makeMsg(data, msg)

      const [mds, btns] = _.partition(msgs[0], v => v.type === 'markdown')
      if (mds.length > 1) {
        for (const idx in mds) {
          msgs = mds[idx]
          if (idx === mds.length - 1) msgs.push(...btns)
          await sendMsg()
        }
        return rets
      }
    } else {
      msgs = await this.makeMsg(data, msg)
    }

    if (await sendMsg() === false) {
      if (this._onSendMsgFallback) {
        msgs = await this._onSendMsgFallback(data, msg)
        if (msgs) await sendMsg()
      }
    }

    if (data._files && data._files.length) {
      Bot.makeLog('debug', ['开始发送文件', { filesCount: data._files.length }], data.self_id)
      const fileResults = await this.sendFiles(data, data._files)
      if (fileResults) {
        Bot.makeLog('debug', ['文件发送完成', {
          message_id_count: fileResults.message_id.length,
          data_count: fileResults.data.length,
          error_count: fileResults.error.length
        }], data.self_id)
        rets.message_id.push(...fileResults.message_id)
        rets.data.push(...fileResults.data)
        rets.error.push(...fileResults.error)
      } else {
        Bot.makeLog('warn', ['文件发送返回空结果'], data.self_id)
      }
      data._files = []
    }

    if (Array.isArray(data._ret_id)) { data._ret_id.push(...rets.message_id) }
    const refIdx = rets.data?.[0]?.ext_info?.ref_idx
    const msgId = rets.data?.[0]?.id
    if (refIdx && msgId) {
      try {
        await redis.set(`wind-idx-to-id:${refIdx}`, msgId, { EX: 120 })
      } catch (err) {
        Bot.makeLog('debug', ['消息ref_idx缓存失败', refIdx, msgId, err], data.self_id)
      }
    }
    return rets
  }

  sendFriendMsg(data, msg, event) {
    event = normalizeSendEvent(event)
    if (!event.event_id) delete event.event_id
    if (!event.event_id && data.self_id && data.user_id) {
      const userId = this.stripSelfPrefix(data.self_id, data.user_id)
      const currentCallbackEventId = data.bot?.callbackEvent?.user?.[userId]
      const cachedEventId = this.callbackEventCache.get(`${data.self_id}:user:${userId}`)
        || this.callbackEventCache.get(`${data.self_id}:${userId}`)
      const dataEventId = pickCallbackEventId(
        data.callback_event_id,
        data.notice_id,
        data.raw?.notice_id,
        data.raw?.event_id,
        data.raw?.raw?.id,
        data.raw_event?.id,
        data.event_id
      )
      event.event_id = cachedEventId || currentCallbackEventId || dataEventId
    }
    if (data.smallbtn) event.smallbtn = true
    if (data.stream === undefined) data.stream = config.stream
    return this.sendMsg(data, msg => {
      if (data.smallbtn) event.smallbtn = true
      return data.bot.sdk.sendPrivateMessage(data.user_id, adaptSendableForSDK(msg), event, {
        stream: data.stream || false,
        chunkSize: data.chunkSize ?? config.chunkSize,
        delay: data.delay ?? config.delay
      })
    }, msg)
  }

  async sendGroupMsg(data, msg, event) {
    event = normalizeSendEvent(event)
    if (!event.event_id) delete event.event_id
    if (!event.event_id && data.self_id && data.group_id) {
      const groupId = this.stripSelfPrefix(data.self_id, data.group_id)
      const currentCallbackEventId = data.bot?.callbackEvent?.group?.[groupId]
      const cachedEventId = this.callbackEventCache.get(`${data.self_id}:group:${groupId}`)
        || this.callbackEventCache.get(`${data.self_id}:${groupId}`)
      const dataEventId = pickCallbackEventId(
        data.callback_event_id,
        data.notice_id,
        data.raw?.notice_id,
        data.raw?.event_id,
        data.raw?.raw?.id,
        data.raw_event?.id,
        data.event_id
      )
      event.event_id = cachedEventId || currentCallbackEventId || dataEventId
    }
    if (data.smallbtn) event.smallbtn = true

    if (Handler.has('QQBot.group.sendMsg')) {
      const res = await Handler.call(
        'QQBot.group.sendMsg',
        data,
        {
          self_id: data.self_id,
          group_id: `${data.self_id}${this.sep}${data.group_id}`,
          raw_group_id: data.group_id,
          user_id: data.user_id,
          msg,
          event
        }
      )
      if (res !== false) {
        return res
      }
    }
    return this.sendMsg(data, msg => {
      if (data.smallbtn) event.smallbtn = true
      return data.bot.sdk.sendGroupMessage(data.group_id, adaptSendableForSDK(msg), event, {
        stream: data.stream || false,
        chunkSize: data.chunkSize ?? config.chunkSize,
        delay: data.delay ?? config.delay
      })
    }, msg)
  }

  _parseFileSegment(i, data) {
    let fileData = {
      file: null,
      name: null,
      force_chunk: false,
      recall_time: 0
    }

    if (typeof i.file === 'string') {
      fileData.file = i.file

      if (typeof i.name === 'object' && i.name !== null) {
        fileData.name = i.name.name || null
        fileData.force_chunk = typeof i.name.force_chunk !== 'undefined' ? !!i.name.force_chunk : false
        fileData.recall_time = Number(i.name.recall_time) || 0
      } else {
        fileData.name = i.name || null

        let thirdParam = undefined
        if (typeof i.force_chunk !== 'undefined') {
          thirdParam = i.force_chunk
        } else if (typeof i.data !== 'undefined' && typeof i.data !== 'object') {
          thirdParam = i.data
        } else if (typeof i[2] !== 'undefined') {
          thirdParam = i[2]
        } else if (typeof i['2'] !== 'undefined') {
          thirdParam = i['2']
        } else if (Array.isArray(i.args) && i.args.length > 0) {
          thirdParam = i.args[0]
        }
        fileData.force_chunk = typeof thirdParam !== 'undefined' ? !!thirdParam : false

        let fourthParam = undefined
        if (typeof i.recall_time !== 'undefined') {
          fourthParam = i.recall_time
        } else if (typeof i[3] !== 'undefined') {
          fourthParam = i[3]
        } else if (typeof i['3'] !== 'undefined') {
          fourthParam = i['3']
        } else if (Array.isArray(i.args) && i.args.length > 1) {
          fourthParam = i.args[1]
        }
        fileData.recall_time = Number(fourthParam) || 0
      }
    } else if (typeof i.file === 'object' && i.file !== null) {
      if (i.file.file) {
        fileData.file = i.file.file
        fileData.name = i.file.name || i.name || null
        fileData.force_chunk = typeof i.file.force_chunk !== 'undefined'
          ? !!i.file.force_chunk
          : (typeof i.force_chunk !== 'undefined' ? !!i.force_chunk : false)
        fileData.recall_time = Number(i.file.recall_time ?? i.recall_time) || 0
      } else {
        fileData.file = i.file
        fileData.name = i.name || null
        fileData.force_chunk = typeof i.force_chunk !== 'undefined' ? !!i.force_chunk : false
        fileData.recall_time = Number(i.recall_time) || 0
      }
    }

    if (!fileData.name && typeof fileData.file === 'string' && fileData.file.startsWith('http')) {
      try {
        const url = new URL(fileData.file)
        const lastSegment = url.pathname.split('/').pop()
        const fileNameWithoutParams = lastSegment.split('?')[0]
        if (fileNameWithoutParams && fileNameWithoutParams.includes('.')) {
          fileData.name = decodeURIComponent(fileNameWithoutParams)
        }
      } catch { }
    }

    return fileData
  }

  async recallMessageById(data, message_id, target_type, target_id) {
    try {
      const encodedTargetId = encodeURIComponent(String(target_id || ''))
      const encodedMessageId = encodeURIComponent(String(message_id || ''))
      const url = `/v2/${target_type}s/${encodedTargetId}/messages/${encodedMessageId}`
      Bot.makeLog('debug', ['撤回消息', { url, target_type, target_id, message_id }], data.self_id)
      const ret = await data.bot.sdk.request.delete(url)
      Bot.makeLog('info', [`撤回${target_type === 'group' ? '群' : '私聊'}消息成功`, { target_id, message_id, status: ret?.status }], data.self_id)
      return { ok: true, type: target_type === 'group' ? 'group' : 'c2c', target_id, message_id }
    } catch (err) {
      const parsed = this.#parseRecallError?.(err) || { message: err.message, error: err.response?.data || { message: err.message } }
      Bot.makeLog('error', ['撤回消息失败', { target_type, target_id, message_id }, parsed.code, parsed.message, parsed.error], data.self_id)
      return {
        ok: false,
        type: target_type === 'group' ? 'group' : 'c2c',
        target_id,
        message_id,
        code: parsed.code,
        message: parsed.message || '撤回失败',
        error: parsed.error
      }
    }
  }

  stripSelfPrefix(self_id, value) {
    if (value == null) return value
    return String(value).replace(`${self_id}${this.sep}`, '')
  }

  getEventMessageId(event = {}) {
    return String(
      event.raw?.d?.id
      || event.raw_event?.d?.id
      || event.api_message_id
      || event.id
      || event.message_id
      || ''
    )
  }

  normalizeRecallType(type) {
    if (type === 'c2c' || type === 'friend' || type === 'private') return 'user'
    if (type === 'group') return 'group'
    return type || ''
  }

  getRecallContext(data = {}, targetId = '', targetType = '') {
    let type = this.normalizeRecallType(targetType)
    if (!type) {
      if (data.message_type === 'group' || data.notice_type === 'group' || data.group_id || data.raw_group_id || data.group_openid) type = 'group'
      else if (data.message_type === 'private' || data.sub_type === 'friend' || data.user_id || data.raw_user_id) type = 'user'
      else if (data.message_type === 'guild') type = 'guild'
      else if (data.message_type === 'direct') type = 'direct'
    }

    let target = String(targetId || '').trim()
    if (!target) {
      if (type === 'group') target = data.raw_group_id || data.group_openid || data.raw?.group_id || this.stripSelfPrefix(data.self_id, data.group_id || '')
      else if (type === 'user') target = data.raw_user_id || data.raw?.sender?.user_id || this.stripSelfPrefix(data.self_id, data.user_id || '')
      else if (type === 'guild') target = data.channel_id || ''
      else if (type === 'direct') target = data.guild_id || ''
    }
    return { type, target: String(target || '') }
  }

  #messageIndexKey(selfId, messageId) {
    return `wind-msg-index:${selfId}:${messageId}`
  }

  #scopedMessageIndexKey(selfId, type, target, messageId) {
    return `wind-msg-index:${selfId}:${type}:${target}:${messageId}`
  }

  #refKey(selfId, type, target, refIdx) {
    return `wind-ref:${selfId}:${type}:${target}:${refIdx}`
  }

  #legacyRefKey(selfId, refIdx) {
    return `wind-ref:${selfId}:${refIdx}`
  }

  async rememberMessageRef(dataOrBot, refIdx, messageId, context = {}) {
    const bot = dataOrBot?.bot || dataOrBot
    const selfId = dataOrBot?.self_id || bot?.uin
    if (!selfId || !refIdx || !messageId) return
    const trimmed = String(refIdx).trim()
    const { type, target } = context.type || context.target ? context : this.getRecallContext(dataOrBot)
    try {
      if (type && target) await redis.set(this.#refKey(selfId, type, target, trimmed), String(messageId), { EX: 86400 })
      await redis.set(this.#legacyRefKey(selfId, trimmed), String(messageId), { EX: 86400 })
    } catch {}
  }

  async getMessageIdByRefIdx(dataOrBot, refIdx, context = {}) {
    const bot = dataOrBot?.bot || dataOrBot
    const selfId = dataOrBot?.self_id || bot?.uin
    if (!selfId || !refIdx) return ''
    const trimmed = String(refIdx).trim()
    const { type, target } = context.type || context.target ? context : this.getRecallContext(dataOrBot)
    try {
      if (type && target) {
        const scoped = await redis.get(this.#refKey(selfId, type, target, trimmed))
        if (scoped) return scoped
      }
      return await redis.get(this.#legacyRefKey(selfId, trimmed)) || ''
    } catch { return '' }
  }

  async recordMessageIndex(data = {}, record = {}) {
    const messageId = String(record.message_id || '').trim()
    const selfId = record.self_id || data.self_id
    if (!selfId || !messageId) return false
    const context = this.getRecallContext(data, record.target_id, record.type)
    const item = {
      message_id: messageId,
      actual_message_id: record.actual_message_id || '',
      self_id: selfId,
      target_id: record.target_id || context.target,
      type: this.normalizeRecallType(record.type || context.type),
      author_openid: record.author_openid || '',
      member_role: record.member_role || '',
      bot: record.bot === true,
      time: record.time || getQQBotEventTime(data),
      seq: record.seq || data.seq || data.raw?.seq || 0,
      content_fingerprint: record.content_fingerprint || getQQBotMessageContentFingerprint(data),
      raw_message: record.raw_message ?? data.raw_message ?? getSegmentText(data.message),
      message: normalizeCachedMessage(clonePlain(record.message ?? data.message ?? [])),
      sender: clonePlain(record.sender ?? data.sender ?? {}),
      aliases: [...new Set((record.aliases || []).filter(Boolean).map(String))]
    }
    const keys = [this.#messageIndexKey(selfId, messageId)]
    if (item.type && item.target_id) keys.push(this.#scopedMessageIndexKey(selfId, item.type, item.target_id, messageId))
    for (const alias of item.aliases) {
      if (alias === messageId) continue
      keys.push(this.#messageIndexKey(selfId, alias))
      if (item.type && item.target_id) keys.push(this.#scopedMessageIndexKey(selfId, item.type, item.target_id, alias))
      await this.rememberMessageRef(data, alias, messageId, { type: item.type, target: item.target_id })
    }
    try {
      for (const key of keys) await redis.set(key, JSON.stringify(item), { EX: 86400 })
    } catch {}
    this.messageIndexCache.set(`${selfId}:${messageId}`, item)
    await this.rememberMessageContentIndex(item)
    return true
  }

  #messageContentKey(selfId, type, target) {
    return `wind-msg-content:${selfId}:${type}:${target}`
  }

  #refContentKey(selfId, type, target, refIdx) {
    return `wind-ref-content:${selfId}:${type}:${target}:${refIdx}`
  }

  async rememberMessageContentIndex(item = {}) {
    if (!item.self_id || !item.type || !item.target_id || !item.message_id || !item.content_fingerprint) return
    const key = this.#messageContentKey(item.self_id, item.type, item.target_id)
    let list = this.messageContentCache.get(key) || []
    try {
      const raw = await redis.get(key)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) list = parsed
      }
    } catch {}
    const next = list.filter(i => i?.message_id !== item.message_id)
    next.push(item)
    next.sort((a, b) => (b.time || 0) - (a.time || 0))
    if (next.length > 500) next.length = 500
    this.messageContentCache.set(key, next)
    try { await redis.set(key, JSON.stringify(next), { EX: 86400 }) } catch {}
  }

  async rememberRefContent(data = {}, refs = [], context = {}) {
    const content = getQQBotQuotedContentFingerprint(data)
    if (!content) return
    const selfId = data.self_id || data.bot?.uin
    const { type, target } = context.type || context.target ? context : this.getRecallContext(data)
    if (!selfId || !type || !target) return
    const item = {
      self_id: selfId,
      type,
      target_id: target,
      content,
      author_openid: getQQBotQuotedAuthorOpenid(data),
      bot: getQQBotQuotedAuthorBot(data),
      time: getQQBotEventTime(data)
    }
    for (const ref of refs) {
      const id = String(ref ?? '').trim()
      if (!this.isReferenceIndex(id)) continue
      const key = this.#refContentKey(selfId, type, target, id)
      this.refContentCache.set(key, item)
      try { await redis.set(key, JSON.stringify(item), { EX: 10 * 60 }) } catch {}
    }
  }

  async getRefContent(data = {}, ref = '', context = {}) {
    const id = String(ref ?? '').trim()
    if (!id || !this.isReferenceIndex(id)) return null
    const selfId = data.self_id || data.bot?.uin
    const { type, target } = context.type || context.target ? context : this.getRecallContext(data)
    if (!selfId || !type || !target) return null
    const key = this.#refContentKey(selfId, type, target, id)
    if (this.refContentCache.has(key)) return this.refContentCache.get(key)
    try {
      const raw = await redis.get(key)
      if (!raw) return null
      const item = JSON.parse(raw)
      this.refContentCache.set(key, item)
      return item
    } catch { return null }
  }

  getMessageAliases(data = {}) {
    const aliases = []
    const add = value => {
      const text = String(value ?? '').trim()
      if (text && !aliases.includes(text)) aliases.push(text)
    }
    add(data.message_id)
    add(data.sdk_message_id)
    add(data.msg_idx)
    add(data.ref_msg_idx)
    add(data.raw?.id)
    add(data.raw?.message_id)
    add(data.raw?.msg_id)
    const ext = data.raw?.message_scene?.ext || data.raw?.raw?.d?.message_scene?.ext || data.raw_event?.d?.message_scene?.ext
    if (Array.isArray(ext)) {
      for (const item of ext) {
        if (typeof item !== 'string') continue
        const match = item.match(/^(?:msg_idx|ref_msg_idx)=(.+)$/)
        if (match) add(match[1])
      }
    }
    return aliases
  }

  async findMessageIndexByQuotedContent(data = {}, context = {}, refIdx = '') {
    const refContent = refIdx ? await this.getRefContent(data, refIdx, context) : null
    const content = getQQBotQuotedContentFingerprint(data) || refContent?.content || ''
    if (!content) return null
    const { type, target } = context.type || context.target ? context : this.getRecallContext(data)
    const selfId = data.self_id || data.bot?.uin
    if (!selfId || !type || !target) return null
    const key = this.#messageContentKey(selfId, type, target)
    let list = this.messageContentCache.get(key) || []
    if (!list.length) {
      try {
        const raw = await redis.get(key)
        const parsed = raw ? JSON.parse(raw) : []
        if (Array.isArray(parsed)) {
          list = parsed
          this.messageContentCache.set(key, list)
        }
      } catch {}
    }
    const beforeTime = getQQBotEventTime(data) + 1000
    const quotedAuthor = getQQBotQuotedAuthorOpenid(data) || refContent?.author_openid || ''
    const quotedBot = typeof getQQBotQuotedAuthorBot(data) === 'boolean' ? getQQBotQuotedAuthorBot(data) : refContent?.bot
    const exclude = new Set(this.getMessageAliases(data))
    const candidates = list.filter(item => {
      if (!item || item.content_fingerprint !== content) return false
      if (item.time && item.time > beforeTime) return false
      if (exclude.has(item.message_id) || exclude.has(item.actual_message_id)) return false
      if (quotedAuthor && item.author_openid && item.author_openid !== quotedAuthor) return false
      if (typeof quotedBot === 'boolean' && item.bot !== quotedBot) return false
      return true
    })
    candidates.sort((a, b) => (b.time || 0) - (a.time || 0))
    return candidates[0] || null
  }

  async getMessageIndex(data = {}, messageId = '', context = {}) {
    const selfId = data.self_id || data.bot?.uin
    const id = String(messageId || '').trim()
    if (!selfId || !id) return null
    const { type, target } = context.type || context.target ? context : this.getRecallContext(data)
    const parse = raw => {
      try { return raw ? JSON.parse(raw) : null } catch { return null }
    }
    try {
      if (type && target) {
        const scoped = parse(await redis.get(this.#scopedMessageIndexKey(selfId, type, target, id)))
        if (scoped) return scoped
      }
      const item = parse(await redis.get(this.#messageIndexKey(selfId, id))) || this.messageIndexCache.get(`${selfId}:${id}`) || null
      if (!item) return null
      if (type && item.type && item.type !== type) return null
      if (target && item.target_id && item.target_id !== target) return null
      return item
    } catch { return null }
  }

  buildReplyMessageFromRecord(data = {}, record = {}, messageId = '') {
    if (!record && !messageId) return null
    const message = normalizeCachedMessage(clonePlain(record?.message ?? []))
    const rawMessage = record?.raw_message ?? getSegmentText(message)
    const userId = record?.author_openid
      ? `${data.self_id || record.self_id}${this.sep}${record.author_openid}`
      : data.reply_user?.member_openid || data.reply_user?.id || data.reply_user?.user_id || data.reply_user?.openid || ''
    const groupId = data.message_type === 'group'
      ? data.group_id || (record?.target_id ? `${data.self_id || record.self_id}${this.sep}${record.target_id}` : undefined)
      : undefined
    const id = messageId || record?.actual_message_id || record?.message_id || ''
    return {
      self_id: data.self_id || record?.self_id,
      message_id: id,
      id,
      user_id: userId,
      group_id: groupId,
      time: record?.time || 0,
      seq: record?.seq || 0,
      raw_message: rawMessage,
      message
    }
  }

  async getReferencedMessageRecord(data = {}) {
    const messageId = data.referenced_message_id || await this.getReferencedMessageId(data)
    let record = messageId ? await this.getMessageIndex(data, messageId, this.getRecallContext(data)) : null
    if (!record && messageId && this.isReferenceIndex(messageId)) {
      const contentRecord = await this.findMessageIndexByQuotedContent(data, this.getRecallContext(data), messageId)
      if (contentRecord) record = contentRecord
    }
    const fallbackMessage = getQQBotQuotedMessage(data)
    if (!record && !fallbackMessage.length && !messageId) return null
    return {
      ...(record || {}),
      message_id: record?.message_id || messageId,
      actual_message_id: record?.actual_message_id || '',
      raw_message: record?.raw_message || getSegmentText(fallbackMessage),
      message: record?.message?.length ? normalizeCachedMessage(record.message) : normalizeCachedMessage(fallbackMessage)
    }
  }

  async rememberReceivedMessageRef(data) {
    if (!data?.message_id) return
    const aliases = [
      data.msg_idx,
      data.raw?.msg_idx,
      data.raw?.id,
      data.raw?.message_id,
      data.raw?.raw?.d?.id,
      data.raw_event?.d?.id,
      data.sdk_message_id
    ]
    const rawExt = data.raw?.message_scene?.ext || data.raw?.raw?.d?.message_scene?.ext || data.raw_event?.d?.message_scene?.ext
    if (Array.isArray(rawExt)) {
      for (const item of rawExt) {
        if (typeof item !== 'string') continue
        if (item.startsWith('msg_idx=')) aliases.push(item.slice('msg_idx='.length))
      }
    }
    for (const ref of aliases) await this.rememberMessageRef(data, ref, data.message_id)
    const role = normalizeGroupMemberRole(data.raw?.author?.member_role || data.sender?.role)
    await this.recordMessageIndex(data, {
      message_id: data.message_id,
      author_openid: data.raw?.author?.member_openid || data.raw?.author?.id || data.raw?.sender?.user_id || data.sender?.raw_user_id || '',
      member_role: role,
      bot: data.raw?.author?.bot === true || data.sender?.bot === true,
      content_fingerprint: getQQBotMessageContentFingerprint(data),
      raw_message: data.raw_message,
      message: data.message,
      time: getQQBotEventTime(data),
      seq: data.seq || data.raw?.seq || 0,
      aliases: aliases.filter(Boolean)
    })
  }

  async rememberSentMessageRef(data, ret) {
    const messageId = ret?.msg_id || ret?.id || ret?.message_id
    if (!messageId) return
    const aliases = [ret?.ext_info?.ref_idx, ret?.ext_info?.msg_idx, ret?.msg_idx].filter(Boolean)
    for (const refIdx of aliases) await this.rememberMessageRef(data, refIdx, messageId)
    await this.recordMessageIndex(data, {
      message_id: messageId,
      author_openid: data?.self_id,
      bot: true,
      content_fingerprint: getQQBotMessageContentFingerprint(data),
      raw_message: data.raw_message,
      message: data.message,
      time: Date.now(),
      aliases
    })
  }

  extractMessageIdFromElements(elements) {
    if (!Array.isArray(elements)) return ''
    for (const elem of elements) {
      if (!elem || typeof elem !== 'object') continue
      const id = elem.id || elem.message_id || elem.msg_id
      if (id) return String(id)
    }
    return ''
  }

  extractRefIdxCandidates(data) {
    const candidates = []
    const seen = new Set()
    const add = value => {
      value = String(value ?? '').trim()
      if (!value || seen.has(value)) return
      seen.add(value)
      candidates.push(value)
    }

    add(data?.ref_msg_idx)
    const ext = data?.raw?.message_scene?.ext || data?.raw?.raw?.d?.message_scene?.ext || data?.raw_event?.d?.message_scene?.ext
    if (Array.isArray(ext)) {
      for (const item of ext) {
        if (typeof item !== 'string') continue
        if (item.startsWith('ref_msg_idx=')) add(item.slice('ref_msg_idx='.length))
      }
    }
    for (const elem of data?.msg_elements || []) {
      if (!elem || typeof elem !== 'object') continue
      add(elem.msg_idx)
      add(elem.id)
      add(elem.message_id)
      add(elem.msg_id)
    }
    return candidates
  }

  async getReferencedMessageId(data) {
    const directId = this.extractMessageIdFromElements(data?.msg_elements)
    const context = this.getRecallContext(data)
    const refIdxList = this.extractRefIdxCandidates(data)
    const addRef = value => {
      value = String(value ?? '').trim()
      if (value && !refIdxList.includes(value)) refIdxList.push(value)
    }

    if (directId && !this.isReferenceIndex(directId)) return directId
    if (directId) {
      addRef(directId)
      const refMatch = directId.match(/^(?:ref_msg_idx|msg_idx)=(.+)$/)
      if (refMatch) addRef(refMatch[1])
    }

    await this.rememberRefContent(data, refIdxList, context)

    for (const refIdx of refIdxList) {
      const messageId = await this.getMessageIdByRefIdx(data, refIdx, context)
      if (messageId) return messageId
    }

    const record = await this.findMessageIndexByQuotedContent(data, context, refIdxList[0])
    if (record) {
      const messageId = record.actual_message_id || record.message_id
      for (const refIdx of refIdxList) await this.rememberMessageRef(data, refIdx, messageId, context)
      Bot.makeLog('debug', ['回复引用按内容命中消息ID', {
        message_id: messageId,
        refs: refIdxList,
        content: getQQBotQuotedContentFingerprint(data),
        author_openid: record.author_openid || '',
        member_role: record.member_role || ''
      }], data.self_id)
      return messageId
    }
    return directId || ''
  }

  isReferenceIndex(value) {
    return /^(?:REFIDX_|TMP_)/i.test(String(value || '')) || /^(?:ref_msg_idx|msg_idx)=/.test(String(value || ''))
  }

  async resolveRecallMessage(data, message_id, context = {}) {
    const original = message_id
    let id = ''
    let source = 'direct'
    if (message_id && typeof message_id === 'object') {
      id = String(message_id.id || message_id.message_id || message_id.msg_id || '').trim()
      source = 'object'
    } else {
      id = String(message_id ?? '').trim()
    }

    if (!id) {
      id = await this.getReferencedMessageId(data)
      source = 'referenced'
    }
    if (!id) return { id: '', source, original }

    try {
      const auditRaw = await redis.get(`wind-audit-message_id:${id}`)
      if (auditRaw) {
        const audit = JSON.parse(auditRaw)
        if (audit?.success && audit?.id) return { id: String(audit.id), source: 'audit', original }
      }
    } catch {}

    const refMatch = id.match(/^(?:ref_msg_idx|msg_idx)=(.+)$/)
    if (refMatch) {
      const resolved = await this.getMessageIdByRefIdx(data, refMatch[1], context)
      if (resolved) return { id: resolved, source: 'ref_idx', original }
      const contentRecord = await this.findMessageIndexByQuotedContent(data, context, refMatch[1])
      if (contentRecord) {
        const actual = contentRecord.actual_message_id || contentRecord.message_id
        await this.rememberMessageRef(data, refMatch[1], actual, context)
        return { id: actual, source: 'content', original, record: contentRecord }
      }
      return { id, source: 'ref_idx', original, unresolved: true, code: 'REFIDX_UNRESOLVED', message: '未找到引用索引对应的真实消息ID' }
    }

    let record = await this.getMessageIndex(data, id, context)
    if (record) {
      const actual = record.actual_message_id || record.message_id
      return { id: actual, source: record.actual_message_id ? 'alias' : 'index', original, record }
    }

    const byRef = await this.getMessageIdByRefIdx(data, id, context)
    if (byRef) {
      record = await this.getMessageIndex(data, byRef, context)
      return { id: record?.actual_message_id || record?.message_id || byRef, source: 'ref_idx', original, record }
    }

    if (this.isReferenceIndex(id)) {
      const contentRecord = await this.findMessageIndexByQuotedContent(data, context, id)
      if (contentRecord) {
        const actual = contentRecord.actual_message_id || contentRecord.message_id
        await this.rememberMessageRef(data, id, actual, context)
        Bot.makeLog('debug', ['引用索引按内容命中消息ID', {
          input_message_id: id,
          resolved_message_id: actual,
          content: getQQBotQuotedContentFingerprint(data),
          author_openid: contentRecord.author_openid || '',
          member_role: contentRecord.member_role || ''
        }], data.self_id)
        return { id: actual, source: 'content', original, record: contentRecord }
      }
      return { id, source, original, unresolved: true, code: 'REFIDX_UNRESOLVED', message: '未找到引用索引对应的真实消息ID' }
    }
    return { id, source, original }
  }

  async resolveRecallMessageId(data, message_id) {
    return (await this.resolveRecallMessage(data, message_id)).id
  }

  async uploadFileToQQ(data, target_id, target_type, file_data, file_name, force_chunk = false, file_type = 4) {
    file_type = Number(file_type)
    if (!['user', 'group'].includes(target_type)) throw new Error(`不支持的上传目标类型: ${target_type}`)
    if (![1, 2, 3, 4].includes(file_type)) throw new Error(`不支持的富媒体类型: ${file_type}`)

    if (typeof file_data === 'string' && file_data.startsWith('http') && !force_chunk) {
      Bot.makeLog('info', ['检测到网络 URL，使用直传（不下载文件）', { url: file_data.substring(0, 100), file_name }], data.self_id)

      try {
        const filesUrl = `/v2/${target_type}s/${target_id}/files`
        const filesData = {
          file_type,
          srv_send_msg: false,
          url: file_data
        }
        const directFileName = file_name || this.extractFileNameFromUrl(file_data)
        if (directFileName) filesData.file_name = directFileName

        Bot.makeLog('debug', ['URL 直传', filesUrl, filesData], data.self_id)

        const { data: result } = await data.bot.sdk.request.post(filesUrl, filesData)

        Bot.makeLog('info', ['URL 直传成功，无需下载文件', result], data.self_id)

        return result
      } catch (error) {
        Bot.makeLog('warn', ['URL 直传失败', error.message, error.response?.data], data.self_id)
        Bot.makeLog('info', ['URL 直传失败，降级为分片上传'], data.self_id)
      }
    }

    const getFileBuffer = async (file_data) => {
      if (file_data instanceof Uint8Array) {
        return Buffer.from(file_data)
      } else if (Buffer.isBuffer(file_data)) {
        return file_data
      } else if (typeof file_data === 'string') {
        if (file_data.startsWith('http')) {
          Bot.makeLog('info', ['开始下载网络文件...'], data.self_id)
          const response = await fetch(file_data)
          if (!response.ok) throw new Error(`下载网络文件失败: HTTP ${response.status}`)
          const buffer = Buffer.from(await response.arrayBuffer())
          Bot.makeLog('info', [`下载完成，大小: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`], data.self_id)
          return buffer
        } else if (file_data.startsWith('base64://')) {
          return Buffer.from(file_data.replace('base64://', ''), 'base64')
        } else if (/^data:[^/]+\/[^;]+;base64,/.test(file_data)) {
          return Buffer.from(file_data.replace(/^data:[^/]+\/[^;]+;base64,/, ''), 'base64')
        } else if (file_data.startsWith('file://')) {
          return fs.readFileSync(file_data.replace('file://', ''))
        } else {
          try {
            return fs.readFileSync(file_data)
          } catch {
            return Buffer.from(file_data)
          }
        }
      } else {
        throw new Error('不支持的文件数据类型')
      }
    }

    const extractFileName = (file_data, fileBuffer) => {
      let name = ''
      let ext = ''

      if (typeof file_data === 'string') {
        if (file_data.startsWith('http')) {
          try {
            const url = new URL(file_data)
            const pathname = url.pathname
            const segments = pathname.split('/')
            const lastSegment = segments[segments.length - 1]
            const fileNameWithoutParams = lastSegment.split('?')[0]
            if (fileNameWithoutParams && fileNameWithoutParams.includes('.')) {
              name = decodeURIComponent(fileNameWithoutParams)
              ext = name.substring(name.lastIndexOf('.'))
            }
          } catch { }
        } else if (file_data.startsWith('file://')) {
          const path = file_data.replace('file://', '')
          name = path.split('/').pop() || path.split('\\').pop()
          if (name && name.includes('.')) {
            ext = name.substring(name.lastIndexOf('.'))
          }
        } else {
          name = file_data.split('/').pop() || file_data.split('\\').pop()
          if (name && name.includes('.')) {
            ext = name.substring(name.lastIndexOf('.'))
          }
        }
      }

      if (!ext && fileBuffer) {
        const header = fileBuffer.toString('hex', 0, 16).toUpperCase()
        const fileTypeMap = {
          '89504E47': '.png',
          '47494638': '.gif',
          'FFD8FF': '.jpg',
          '25504446': '.pdf',
          '494433': '.mp3',
          '52494646': '.wav',
          '00000018': '.mp4',
          '00000020': '.mp4',
          'D0CF11E0': '.doc',
          '504B0304': '.zip',
          '7B22': '.json',
          '3C3F786D': '.xml',
          'EFBBBF': '.txt',
          'FFFE': '.txt',
          'FEFF': '.txt'
        }

        for (const [signature, extension] of Object.entries(fileTypeMap)) {
          if (header.startsWith(signature)) {
            ext = extension
            break
          }
        }

        if (header.startsWith('52494646')) {
          const riffType = fileBuffer.toString('hex', 8, 12).toUpperCase()
          if (riffType === '57454250') {
            ext = '.webp'
          } else {
            ext = '.wav'
          }
        }
      }

      if (!name || !name.includes('.')) {
        const timestamp = Date.now().toString(36)
        const random = Math.random().toString(36).substring(2, 8)
        const defaultExt = { 1: '.jpg', 2: '.mp4', 3: '.silk', 4: '.bin' }[file_type]
        name = `file_${timestamp}_${random}${ext || defaultExt}`
      }

      if (name.length > 100) {
        const extension = name.substring(name.lastIndexOf('.'))
        const baseName = name.substring(0, name.lastIndexOf('.'))
        name = baseName.substring(0, 80) + '...' + extension
      }

      return name
    }

    try {
      const fileBuffer = await getFileBuffer(file_data)
      const file_size = fileBuffer.length

      if (!file_name) {
        file_name = extractFileName(file_data, fileBuffer)
      }

      Bot.makeLog('debug', ['准备分片上传', {
        target_id,
        target_type,
        file_type,
        file_name,
        file_size
      }], data.self_id)

      const filesResult = await uploadRichMediaByParts({
        request: data.bot.sdk.request,
        endpointPath: `/v2/${target_type}s/${target_id}`,
        fileBuffer,
        fileType: file_type,
        fileName: file_name,
        onRetry: ({ stage, partIndex, attempt, delayMs, error }) => {
          if (stage === 'session') {
            Bot.makeLog('warn', ['富媒体上传任务失败，准备重新申请上传任务', {
              attempt,
              delay_ms: delayMs,
              error: error?.message || String(error)
            }], data.self_id)
            return
          }

          Bot.makeLog('warn', ['富媒体分片上传重试', {
            stage,
            part_index: partIndex,
            attempt,
            error: error?.message || String(error)
          }], data.self_id)
        }
      })

      Bot.makeLog('info', ['分片上传成功', filesResult], data.self_id)

      Bot.makeLog('debug', ['文件上传完成', {
        file_info: filesResult?.file_info,
        hasFile: !!filesResult?.file_info
      }], data.self_id)

      return filesResult
    } catch (error) {
      Bot.makeLog('error', ['文件上传失败', error.message], data.self_id)
      throw error
    }
  }

  extractFileNameFromUrl(url) {
    try {
      const urlObj = new URL(url)
      const lastSegment = urlObj.pathname.split('/').pop()
      const fileNameWithoutParams = lastSegment.split('?')[0]
      if (fileNameWithoutParams && fileNameWithoutParams.includes('.')) {
        return decodeURIComponent(fileNameWithoutParams)
      }
    } catch { }
    return null
  }

  async sendFileMessage(data, target_id, target_type, fileInfo) {
    try {
      let actualFile, actualName, actualForceChunk, actualRecallTime

      if (typeof fileInfo.file === 'object' && fileInfo.file !== null && fileInfo.file.file) {
        actualFile = fileInfo.file.file
        actualName = fileInfo.file.name || fileInfo.name
        actualForceChunk = !!(fileInfo.file.force_chunk || fileInfo.force_chunk)
        actualRecallTime = fileInfo.file.recall_time ?? fileInfo.recall_time ?? 0
      } else {
        actualFile = fileInfo.file
        actualName = fileInfo.name
        actualForceChunk = !!(fileInfo.force_chunk)
        actualRecallTime = fileInfo.recall_time ?? 0
      }

      actualRecallTime = Number(actualRecallTime) || 0

      Bot.makeLog('debug', ['解析后的文件信息', {
        actualFile: typeof actualFile === 'string' ? actualFile : 'Buffer',
        actualName,
        actualForceChunk,
        actualRecallTime
      }], data.self_id)

      const result = await this.uploadFileToQQ(
        data,
        target_id,
        target_type,
        actualFile,
        actualName,
        actualForceChunk
      )

      const messageUrl = `/v2/${target_type}s/${target_id}/messages`
      const messageData = {
        msg_type: 7,
        media: { file_info: result.file_info }
      }

      if (data.message_id) {
        messageData.msg_id = data.message_id
      }

      Bot.makeLog('debug', ['发送文件消息', messageUrl, messageData], data.self_id)

      const { data: sendResult } = await data.bot.sdk.request.post(messageUrl, messageData)

      Bot.makeLog('debug', ['文件消息发送成功', sendResult], data.self_id)

      if (actualRecallTime > 0 && sendResult && sendResult.id) {
        const msgId = sendResult.id
        Bot.makeLog('info', [`文件消息将在 ${actualRecallTime} 秒后撤回`, { msgId, target_type, target_id }], data.self_id)
        setTimeout(async () => {
          await this.recallMessageById(data, msgId, target_type, target_id)
        }, actualRecallTime * 1000)
      }

      if (!sendResult || !sendResult.id) {
        Bot.makeLog('warn', ['文件消息发送成功但未返回ID', { sendResult, target_type, target_id }], data.self_id)
      }

      return { id: sendResult?.id || null }
    } catch (error) {
      Bot.makeLog('error', ['文件消息发送失败', error.message], data.self_id)
      throw error
    }
  }

  async sendFiles(data, files) {
    let target_type, target_id

    if (data.group_id) {
      target_type = 'group'
      target_id = data.raw?.group_id || data.group_id.replace(`${data.self_id}${this.sep}`, '')
    } else {
      target_type = 'user'
      target_id = data.raw?.sender?.user_id || data.user_id.replace(`${data.self_id}${this.sep}`, '')
    }

    Bot.makeLog('debug', ['准备发送文件列表', { target_type, target_id, count: files.length }], data.self_id)

    const rets = { message_id: [], data: [], error: [] }

    for (const fileInfo of files) {
      try {
        const result = await this.sendFileMessage(data, target_id, target_type, fileInfo)
        Bot.makeLog('info', ['文件发送成功', { target_type, target_id, file: fileInfo.name, force_chunk: fileInfo.force_chunk, recall_time: fileInfo.recall_time }], data.self_id)

        if (result && result.id) {
          rets.message_id.push(result.id)
          rets.data.push(result)
          await this.rememberSentMessageRef({ ...data, group_id: target_type === 'group' ? target_id : data.group_id, user_id: target_type === 'user' ? target_id : data.user_id }, result)
        }
      } catch (err) {
        Bot.makeLog('error', ['发送文件失败', fileInfo, err.message, err.response?.data], data.self_id)
        rets.error.push(err)
      }
    }

    return rets
  }

  async makeGuildMsg(data, msg) {
    const messages = []
    let message = []
    let reply
    let button = []
    for (let i of Array.isArray(msg) ? msg : [msg]) {
      if (typeof i == 'object') { i = { ...i } } else { i = { type: 'text', text: i } }

      switch (i.type) {
        case 'at':
          i.user_id = i.qq?.replace?.(/^qg_/, '')
        case 'text':
        case 'face':
        case 'ark':
        case 'embed':
          break
        case 'image':
          message.push(i)
          if (button.length) {
            message.push({
              type: 'keyboard',
              content: { rows: button }
            })
            button = []
          }
          messages.push(message)
          message = []
          continue
        case 'record':
        case 'video':
        case 'file':
          // if (i.file) i.file = await Bot.fileToUrl(i.file, i)
          // i = { type: 'text', text: `文件：${i.file}` }
          // break
          return []
        case 'reply':
          reply = normalizeReplySegment(i) || reply
          continue
        case 'markdown':
          if (typeof i.data == 'object') { i = { type: 'markdown', ...i.data } } else { i = { type: 'markdown', content: i.data } }
          break
        case 'button':
          config.sendButton && button.push(...this.makeButtons(data, i.data))
          continue
        case 'node':
          for (const { message } of i.data) { messages.push(...(await this.makeGuildMsg(data, message))) }
          continue
        case 'raw':
          if (Array.isArray(i.data)) {
            messages.push(i.data)
            continue
          }
          i = i.data
          break
        default:
          i = { type: 'text', text: JSON.stringify(i) }
      }

      if (i.type == 'text' && i.text) {
        const match = i.text.match(this.toQRCodeRegExp)
        if (match) {
          for (const url of match) {
            const msg = segment.image(await this.makeQRCode(url))
            message.push(msg)
            if (button.length) {
              message.push({
                type: 'keyboard',
                content: { rows: button }
              })
              button = []
            }
            messages.push(message)
            message = []
            i.text = i.text.replace(url, '[链接(请扫码查看)]')
          }
        }
      }

      message.push(i)
    }

    if (message.length) {
      if (button.length) {
        message.push({
          type: 'keyboard',
          content: { rows: button }
        })
      }
      messages.push(message)
    } else if (button.length) {
      messages.push([
        { type: 'text', text: ' ' },
        {
          type: 'keyboard',
          content: { rows: button }
        }
      ])
    }

    if (reply) {
      for (const i of messages) i.unshift(reply)
    }
    return messages
  }

  async sendGMsg(data, send, msg) {
    const rets = { message_id: [], data: [], error: [] }
    let msgs

    const sendMsg = async () => {
      for (const i of msgs) {
        try {
          Bot.makeLog('debug', ['发送消息', i], data.self_id)
          const ret = await send(i)
          Bot.makeLog('debug', ['发送消息返回', ret], data.self_id)

          rets.data.push(ret)
          await this.rememberSentMessageRef(data, ret)
          if (ret.id) rets.message_id.push(ret.id)
          Bot[data.self_id].dau.setDau('send_msg', data)
        } catch (err) {
          // Bot.makeLog('error', ['发送消息错误', i, err], data.self_id)
          logger.error(data.self_id, '发送消息错误', i, err)
          rets.error.push(err)
          return false
        }
      }
    }

    msgs = await this.makeGuildMsg(data, msg)
    await sendMsg()
    return rets
  }

  async sendDirectMsg(data, msg, event) {
    if (!data.guild_id) {
      if (!data.src_guild_id) {
        Bot.makeLog('error', [`发送频道私聊消息失败：[${data.user_id}] 不存在来源频道信息`, msg], data.self_id)
        return false
      }
      const dms = await data.bot.sdk.createDirectSession(data.src_guild_id, data.user_id)
      data.guild_id = dms.guild_id
      data.channel_id = dms.channel_id
      data.bot.fl.set(`qg_${data.user_id}`, {
        ...data.bot.fl.get(`qg_${data.user_id}`),
        ...dms
      })
    }
    return this.sendGMsg(data, msg => data.bot.sdk.sendDirectMessage(data.guild_id, adaptSendableForSDK(msg), event), msg)
  }

  #makeRecallDedupeKey(data, messageId) {
    const target = data?.raw_group_id || data?.group_id || data?.channel_id || data?.guild_id || data?.raw_user_id || data?.user_id || ''
    return [data?.self_id || '', data?.message_type || data?.notice_type || '', target, messageId].join(':')
  }

  #markRecallMessage(key, ttl = 30 * 1000) {
    if (!key) return false
    if (this.recallMessageCache.has(key)) return false
    const timer = setTimeout(() => this.recallMessageCache.delete(key), ttl)
    if (typeof timer.unref === 'function') timer.unref()
    this.recallMessageCache.set(key, timer)
    return true
  }

  #parseRecallError(err) {
    const responseData = err?.response?.data
    const rawMessage = responseData?.message || err?.message || '撤回失败'
    let code = responseData?.err_code ?? responseData?.code
    let message = rawMessage

    // qq-official-bot@1.2.3 的响应拦截器会重新创建 Error，未保留 response。
    // 从 `failed with code(CODE): MESSAGE` 中恢复结构化错误信息。
    if (code == null && typeof rawMessage === 'string') {
      const match = rawMessage.match(/failed with code\(([^)]+)\):\s*(.*)$/s)
      if (match) {
        code = /^\d+$/.test(match[1]) ? Number(match[1]) : match[1]
        message = match[2] || rawMessage
      }
    }

    return {
      code,
      message,
      error: responseData || { code, message, raw_message: err?.message || rawMessage }
    }
  }

  async #recallByPath(data, targetType, targetId, messageId, suffix = '') {
    const encodedTargetId = encodeURIComponent(String(targetId || ''))
    const encodedMessageId = encodeURIComponent(String(messageId || ''))
    const base = targetType === 'group'
      ? `/v2/groups/${encodedTargetId}`
      : targetType === 'user'
        ? `/v2/users/${encodedTargetId}`
        : targetType === 'channels' || targetType === 'channel' || targetType === 'guild'
          ? `/channels/${encodedTargetId}`
          : targetType === 'dms' || targetType === 'direct'
            ? `/dms/${encodedTargetId}`
            : `/${String(targetType || '').replace(/^\/+|\/+$/g, '')}/${encodedTargetId}`
    const result = await data.bot.sdk.request.delete(`${base}/messages/${encodedMessageId}${suffix}`)
    return result?.status === 200 || result?.status === 204
  }

  async recallMsg(data, recall, message_id) {
    if (!Array.isArray(message_id)) message_id = [message_id]
    const msgs = []
    for (const i of message_id) {
      const context = this.getRecallContext(data)
      const resolved = await this.resolveRecallMessage(data, i, context)
      const id = resolved.id
      if (!id) {
        msgs.push({ ok: false, message_id: id, source: resolved.source, message: 'msgid不能为空' })
        continue
      }
      if (resolved.unresolved) {
        const ret = { ok: false, message_id: id, input_message_id: resolved.original, source: resolved.source, code: resolved.code, message: resolved.message }
        Bot.makeLog('warn', ['撤回消息跳过', ret], data.self_id)
        msgs.push(ret)
        continue
      }
      if (context.type === 'group' && resolved.record?.member_role && ['owner', 'admin'].includes(resolved.record.member_role)) {
        const ret = { ok: false, message_id: id, input_message_id: resolved.original, source: resolved.source, code: 'ROLE_PROTECTED', message: '不能撤回管理员或群主消息' }
        Bot.makeLog('warn', ['撤回消息跳过', ret], data.self_id)
        msgs.push(ret)
        continue
      }
      if (context.type === 'user' && resolved.record && resolved.record.bot !== true) {
        const ret = { ok: false, message_id: id, input_message_id: resolved.original, source: resolved.source, code: 'C2C_USER_MESSAGE', message: 'C2C不能撤回用户发送的消息' }
        Bot.makeLog('warn', ['撤回消息跳过', ret], data.self_id)
        msgs.push(ret)
        continue
      }
      Bot.makeLog('debug', ['撤回消息诊断', { input_message_id: resolved.original, resolved_message_id: id, source: resolved.source, context, record: resolved.record || null }], data.self_id)

      const recallKey = this.#makeRecallDedupeKey(data, id)
      if (!this.#markRecallMessage(recallKey)) {
        Bot.makeLog('debug', ['忽略重复撤回消息', id], data.self_id)
        msgs.push({ ok: true, message_id: id, skipped: true, message: '重复撤回已跳过' })
        continue
      }

      try {
        const ret = await recall(id)
        if (ret === false) {
          const err = new Error('SDK 返回 false，未抛出具体错误')
          Bot.makeLog('warn', ['撤回消息错误', id, err.message, err], data.self_id)
          msgs.push({ ok: false, message_id: id, message: err.message })
          continue
        }
        msgs.push({ ok: true, message_id: id, data: ret, source: resolved.source })
      } catch (err) {
        const parsed = this.#parseRecallError(err)
        Bot.makeLog('warn', ['撤回消息错误', id, parsed.code, parsed.message, parsed.error], data.self_id)
        msgs.push({
          ok: false,
          message_id: id,
          code: parsed.code,
          message: parsed.message,
          error: parsed.error
        })
      }
    }
    return msgs
  }

  recallFriendMsg(data, message_id) {
    const userId = this.stripSelfPrefix(data.self_id, data.user_id)
    Bot.makeLog('info', `撤回好友消息：[${userId}] ${message_id}`, data.self_id)
    return this.recallMsg({ ...data, message_type: 'private', user_id: userId }, i => this.#recallByPath(data, 'user', userId, i), message_id)
  }

  recallGroupMsg(data, message_id) {
    const groupId = this.stripSelfPrefix(data.self_id, data.raw_group_id || data.group_id)
    Bot.makeLog('info', `撤回群消息：[${groupId}] ${message_id}`, data.self_id)
    return this.recallMsg({ ...data, message_type: 'group', group_id: groupId, group_openid: groupId }, i => this.#recallByPath(data, 'group', groupId, i), message_id)
  }

  recallDirectMsg(data, message_id, hide = config.hideGuildRecall) {
    Bot.makeLog('info', `撤回${hide ? '并隐藏' : ''}频道私聊消息：[${data.guild_id}] ${message_id}`, data.self_id)
    return this.recallMsg({ ...data, message_type: 'direct' }, i => this.#recallByPath(data, 'dms', data.guild_id, i, `?hidetip=${!!hide}`), message_id)
  }

  recallGuildMsg(data, message_id, hide = config.hideGuildRecall) {
    Bot.makeLog('info', `撤回${hide ? '并隐藏' : ''}频道消息：[${data.channel_id}] ${message_id}`, data.self_id)
    return this.recallMsg({ ...data, message_type: 'guild' }, i => this.#recallByPath(data, 'channels', data.channel_id, i, `?hidetip=${!!hide}`), message_id)
  }

  sendWakeUp(data, message) {
    return this.sendMsg(data, msg => data.bot.sdk.messageService.sendRecallMessage(`/v2/users/${data.user_id}`, msg), message)
  }

  async sendInputNotify(data, input_second) {
    try {
      await data.bot.sdk.request.post(`/v2/users/${data.user_id}/messages`, {
        msg_type: 6,
        input_notify: { input_type: 1, input_second: input_second || 30 },
        msg_id: data.message_id
      })
    } catch (err) {
      Bot.makeLog('debug', ['发送输入状态通知错误', err], data.self_id)
    }
  }

  async groupManageRequest(id, method, url, body) {
    try {
      const res = method === 'get' && body
        ? await Bot[id].sdk.request[method](url, { params: body })
        : await Bot[id].sdk.request[method](url, body)
      return res?.data ?? res
    } catch (err) {
      throw err
    }
  }

  toGroupManageOpenid(id, value) {
    value = String(value ?? '').replace(`${id}${this.sep}`, '')
    const idx = value.lastIndexOf(':')
    return idx > -1 ? value.slice(idx + 1) : value
  }

  getGroupInfo(id, group_openid) {
    group_openid = this.toGroupManageOpenid(id, group_openid)
    return this.groupManageRequest(id, 'get', `/v2/groups/${group_openid}/info`)
  }

  getGroupBotState(id, group_openid) {
    group_openid = this.toGroupManageOpenid(id, group_openid)
    return this.groupManageRequest(id, 'get', `/v2/groups/${group_openid}/bot_state`)
  }

  getCachedGroupBotState(id, group_id) {
    const groupOpenid = this.toGroupManageOpenid(id, group_id)
    const key = `${id}:${groupOpenid}`
    const cached = this.groupBotStateCache.get(key)
    if (cached && cached.expires > Date.now()) return cached.state
    const group = Bot[id]?.gl?.get?.(`${id}${this.sep}${groupOpenid}`) || Bot[id]?.gl?.get?.(group_id)
    return buildGroupBotStateFields(group?.bot_state)
  }

  getCachedGroupBotRole(id, group_id) {
    return this.getCachedGroupBotState(id, group_id).role
  }

  async refreshGroupBotState(id, group_id) {
    const groupOpenid = this.toGroupManageOpenid(id, group_id)
    if (!groupOpenid) return buildGroupBotStateFields()
    const key = `${id}:${groupOpenid}`
    const cached = this.groupBotStateCache.get(key)
    if (cached && cached.expires > Date.now()) return cached.state

    try {
      const info = await this.getGroupBotState(id, groupOpenid)
      const state = buildGroupBotStateFields(info)
      this.groupBotStateCache.set(key, { state, info, expires: Date.now() + 60 * 1000 })
      const groupKey = `${id}${this.sep}${groupOpenid}`
      await Bot[id]?.gl?.set?.(groupKey, {
        ...Bot[id].gl.get(groupKey),
        group_id: groupKey,
        bot_state: info,
        ...buildGroupRoleFields(state.role),
        bot_member_openid: state.member_openid,
        bot_joined_at: state.joined_at,
        bot_allow_proactive_msg: state.allow_proactive_msg,
        bot_recv_msg_setting: state.recv_msg_setting
      })
      let gml = Bot[id]?.gml?.get?.(groupKey)
      if (!gml) {
        gml = new Map()
        await Bot[id]?.gml?.set?.(groupKey, gml)
      }
      const memberOpenid = state.member_openid
      const memberKeys = [...new Set([
        String(id),
        String(Bot[id]?.uin || ''),
        memberOpenid,
        memberOpenid && `${id}${this.sep}${memberOpenid}`
      ].filter(Boolean))]
      const cachedMember = memberKeys.reduce((result, memberKey) => ({
        ...result,
        ...gml?.get?.(memberKey)
      }), {})
      const selfMember = {
        ...cachedMember,
        ...state,
        self_id: id,
        user_id: memberOpenid ? `${id}${this.sep}${memberOpenid}` : String(id),
        raw_user_id: memberOpenid || String(id),
        openid: memberOpenid || String(id),
        bot: true,
        group_id: groupKey,
        nickname: Bot[id]?.nickname,
        card: Bot[id]?.nickname,
        platform: 'QQ-group-member'
      }
      for (const memberKey of memberKeys) await gml?.set?.(memberKey, selfMember)
      return state
    } catch (err) {
      if (isQQBotApiNoAccessError(err)) {
        const groupKey = `${id}${this.sep}${groupOpenid}`
        const storedInfo = Bot[id]?.gl?.get?.(groupKey)?.bot_state
        const state = buildGroupBotStateFields(storedInfo)
        this.groupBotStateCache.set(key, {
          state,
          info: storedInfo,
          error: { code: 11253, message: '应用无接口访问权限' },
          expires: Date.now() + 60 * 1000
        })
        return state
      }
      return this.getCachedGroupBotState(id, groupOpenid)
    }
  }

  async getGroupMemberInfo(id, group_openid, member_openid) {
    group_openid = this.toGroupManageOpenid(id, group_openid)
    member_openid = this.toGroupManageOpenid(id, member_openid)
    try {
      return await this.groupManageRequest(id, 'get', `/v2/groups/${group_openid}/members/${member_openid}`)
    } catch (err) {
      if (!isQQBotApiNoAccessError(err)) throw err
      const groupKey = `${id}${this.sep}${group_openid}`
      const memberMap = Bot[id]?.gml?.get?.(groupKey) || Bot[id]?.gml?.get?.(group_openid)
      const cached = memberMap?.get?.(`${id}${this.sep}${member_openid}`) || memberMap?.get?.(member_openid)
      const fallbackRole = normalizeGroupMemberRole(cached?.role || cached?.member_role)
      return {
        ...cached,
        ...buildGroupRoleFields(fallbackRole),
        user_id: member_openid,
        raw_user_id: member_openid,
        group_id: group_openid,
        nickname: cached?.nickname || cached?.card || '',
        card: cached?.card || cached?.nickname || ''
      }
    }
  }

  getGroupMuteState(id, group_openid) {
    group_openid = this.toGroupManageOpenid(id, group_openid)
    return this.groupManageRequest(id, 'get', `/v2/groups/${group_openid}/restrict_chat_setting`)
  }

  setGroupBan(id, group_openid, member_openid, duration = 0) {
    group_openid = this.toGroupManageOpenid(id, group_openid)
    const time = Number(duration)
    const members = [{
      op: time > 0 ? 'add' : 'del',
      member_openid: this.toGroupManageOpenid(id, member_openid),
      mute_expire_at: time > 0 ? new Date(Date.now() + time * 1000).toISOString() : ''
    }]
    return this.groupManageRequest(id, 'post', `/v2/groups/${group_openid}/restrict_chat_setting`, { members })
  }

  normalizeGroupJoinRequest(id, group_openid, item = {}, rawEvent) {
    const source = item && typeof item === 'object' ? item : {}
    const groupOpenid = this.toGroupManageOpenid(id, group_openid || getJoinRequestField(source, 'group_openid', 'group_id'))
    const memberOpenid = this.toGroupManageOpenid(id, getJoinRequestField(source, 'member_openid', 'raw_user_id', 'user_id') || '')
    const joinRequestId = String(getJoinRequestField(source, 'join_request_id', 'flag') || '')
    const verifyInfo = getJoinRequestVerifyInfo(source)
    const comment = getJoinRequestComment(source, verifyInfo)
    const riskTips = String(getJoinRequestField(source, 'risk_tips') || '')
    const event = rawEvent || source
    const groupId = `${id}${this.sep}${groupOpenid}`
    const userId = `${id}${this.sep}${memberOpenid}`
    const data = {
      ...source,
      raw: event,
      raw_event: event,
      bot: Bot[id],
      self_id: id,
      post_type: 'request',
      request_type: 'group',
      sub_type: 'add',
      platform: 'QQ-group',
      group_id: groupId,
      group_openid: groupOpenid,
      user_id: userId,
      raw_user_id: memberOpenid,
      member_openid: memberOpenid,
      nickname: getJoinRequestField(source, 'username', 'nickname') || '',
      comment,
      flag: joinRequestId,
      join_request_id: joinRequestId,
      tips: riskTips,
      risk_tips: riskTips,
      apply_source: getJoinRequestField(source, 'apply_source') || '',
      invited_by: getJoinRequestField(source, 'invited_by') || '',
      verify_info: verifyInfo,
      verify_message: verifyInfo.verify_message || '',
      review_qa_list: Array.isArray(verifyInfo.review_qa_list) ? verifyInfo.review_qa_list : [],
      time: getJoinRequestField(source, 'apply_at', 'timestamp', 'time')
    }
    if (!data.join_request_id && data.flag) data.join_request_id = data.flag

    data.approve = async (approve, reason) => {
      try {
        const result = await this.approvalJoinRequest(id, groupOpenid, memberOpenid, {
          approve,
          join_request_id: data.join_request_id,
          reject_reason: approve ? undefined : reason
        })
        if (result !== false) this.removeGroupJoinRequest(id, data)
        return result
      } catch (err) {
        Bot.makeLog('error', ['审批加群请求失败', data.group_id, data.user_id, err], id)
        throw err
      }
    }
    return data
  }

  upsertGroupJoinRequest(id, data) {
    if (!data?.group_id || !data?.raw_user_id) return data
    const requestList = Bot[id]?.request_list || (Bot[id].request_list = [])
    const requestId = data.join_request_id || data.flag
    const index = requestList.findIndex(item => {
      if (!item || item.request_type !== 'group' || item.sub_type !== 'add') return false
      if (requestId && (item.join_request_id === requestId || item.flag === requestId)) return true
      return item.group_openid === data.group_openid && item.raw_user_id === data.raw_user_id
    })
    if (index === -1) requestList.push(data)
    else requestList[index] = { ...requestList[index], ...data }
    return data
  }

  removeGroupJoinRequest(id, data) {
    const requestList = Bot[id]?.request_list
    if (!Array.isArray(requestList)) return
    const requestId = data?.join_request_id || data?.flag
    for (let index = requestList.length - 1; index >= 0; index--) {
      const item = requestList[index]
      const sameRequest = requestId && (item?.join_request_id === requestId || item?.flag === requestId)
      const sameApplicant = item?.group_openid === data?.group_openid && item?.raw_user_id === data?.raw_user_id
      if (sameRequest || (!requestId && sameApplicant)) requestList.splice(index, 1)
    }
  }

  async getGroupJoinRequestList(id, group_openid, cursor = '', limit = 20) {
    group_openid = this.toGroupManageOpenid(id, group_openid)
    const body = {}
    if (cursor) body.cursor = cursor
    if (limit) body.limit = limit
    const result = await this.groupManageRequest(id, 'get', `/v2/groups/${group_openid}/join_request_list`, body)
    const list = Array.isArray(result?.list) ? result.list : []
    const normalizedList = list.map(item => {
      const request = this.normalizeGroupJoinRequest(id, group_openid, item)
      this.upsertGroupJoinRequest(id, request)
      return request
    })
    return { ...(result || {}), list: normalizedList }
  }

  async syncGroupJoinRequests(id, group_id, options = {}) {
    options = options || {}
    const groupOpenid = this.toGroupManageOpenid(id, group_id)
    const cacheKey = `${id}:${groupOpenid}`
    const cacheMs = Math.max(0, Number(options.cacheMs) || 5000)
    const cached = this.groupJoinRequestSyncCache.get(cacheKey)
    if (!options.force && cached?.promise) return cached.promise
    if (!options.force && cached?.result && Date.now() - cached.updatedAt < cacheMs) return cached.result

    const promise = this.fetchGroupJoinRequests(id, groupOpenid, options)
    this.groupJoinRequestSyncCache.set(cacheKey, { promise, updatedAt: Date.now() })
    try {
      const result = await promise
      this.groupJoinRequestSyncCache.set(cacheKey, { result, updatedAt: Date.now() })
      return result
    } catch (err) {
      if (this.groupJoinRequestSyncCache.get(cacheKey)?.promise === promise) {
        this.groupJoinRequestSyncCache.delete(cacheKey)
      }
      throw err
    }
  }

  async fetchGroupJoinRequests(id, group_id, options = {}) {
    const maxPages = Math.max(1, Number(options.maxPages) || 10)
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 100))
    let cursor = options.cursor || ''
    let pageCount = 0
    let nextCursor = ''
    const list = []
    do {
      const page = await this.getGroupJoinRequestList(id, group_id, cursor, limit)
      list.push(...(page.list || []))
      nextCursor = page.next_cursor || ''
      cursor = nextCursor
      pageCount += 1
    } while (cursor && pageCount < maxPages)
    if (!nextCursor) {
      const groupOpenid = this.toGroupManageOpenid(id, group_id)
      const activeKeys = new Set(list.map(item => item.join_request_id || item.flag || `${item.group_openid}:${item.raw_user_id}`))
      const requestList = Bot[id]?.request_list
      if (Array.isArray(requestList)) {
        for (let index = requestList.length - 1; index >= 0; index--) {
          const item = requestList[index]
          const itemKey = item?.join_request_id || item?.flag || `${item?.group_openid}:${item?.raw_user_id}`
          if (item?.request_type === 'group' && item?.sub_type === 'add' && item.group_openid === groupOpenid &&
            !activeKeys.has(itemKey)) {
            requestList.splice(index, 1)
          }
        }
      }
    }
    return { list, next_cursor: nextCursor }
  }

  approvalJoinRequest(id, group_openid, member_openid, options = {}) {
    group_openid = this.toGroupManageOpenid(id, group_openid)
    member_openid = this.toGroupManageOpenid(id, member_openid)
    const body = { op: options.op ?? (options.approve ? 'approve' : 'decline') }
    if (options.join_request_id) body.join_request_id = options.join_request_id
    if (body.op === 'decline' && options.reject_reason) body.reject_reason = String(options.reject_reason)
    if (body.op === 'decline' && options.add_to_member_blacklist) body.add_to_member_blacklist = true
    return this.groupManageRequest(id, 'post', `/v2/groups/${group_openid}/approval_join_request/${member_openid}`, body)
  }

  setGroupAddRequest(id, flagOrGroupOpenid, arg2, arg3, arg4, arg5, arg6) {
    const isFlagStyle = typeof arg2 === 'boolean'
    const approve = isFlagStyle ? arg2 : arg3
    const reason = isFlagStyle ? arg3 : arg4
    const member_openid = isFlagStyle ? arg5 : arg2
    const join_request_id = isFlagStyle ? arg6 : arg5
    const request = Bot[id]?.request_list?.find?.(item =>
      item?.flag === flagOrGroupOpenid || item?.join_request_id === flagOrGroupOpenid
    )
    if (request) {
      return request.approve(approve, reason)
    }
    if (member_openid) {
      return this.approvalJoinRequest(id, flagOrGroupOpenid, member_openid, {
        approve,
        join_request_id,
        reject_reason: reason
      })
    }
    throw new Error(`No such group add request: ${flagOrGroupOpenid || ''}`)
  }

  getJoinApprovalStrategies(id, cursor = '', limit = 20) {
    const qs = new URLSearchParams()
    if (cursor) qs.set('cursor', cursor)
    qs.set('limit', limit)
    return this.groupManageRequest(id, 'get', `/v2/groups/join_approval_strategy?${qs}`)
  }

  createJoinApprovalStrategy(id, body) {
    return this.groupManageRequest(id, 'post', '/v2/groups/join_approval_strategy', body)
  }

  updateJoinApprovalStrategy(id, strategy_id, body) {
    return this.groupManageRequest(id, 'patch', `/v2/groups/join_approval_strategy/${strategy_id}`, body)
  }

  deleteJoinApprovalStrategy(id, strategy_id) {
    return this.groupManageRequest(id, 'delete', `/v2/groups/join_approval_strategy/${strategy_id}`)
  }

  executeJoinApprovalStrategy(id, strategy_id) {
    return this.groupManageRequest(id, 'post', `/v2/groups/join_approval_strategy/${strategy_id}/execute`)
  }

  updateJoinApprovalWhitelist(id, strategy_id, op, whitelist_users) {
    return this.groupManageRequest(id, 'post', `/v2/groups/join_approval_strategy/${strategy_id}/whitelist_users`, { op, whitelist_users })
  }

  sendGuildMsg(data, msg, event) {
    return this.sendGMsg(data, msg => data.bot.sdk.sendGuildMessage(data.channel_id, adaptSendableForSDK(msg), event), msg)
  }

  pickFriend(id, user_id) {
    if (config.toQQUin && userIdCache[user_id]) user_id = userIdCache[user_id]
    if (user_id.startsWith('qg_')) return this.pickGuildFriend(id, user_id)

    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(`${id}${this.sep}`, ''),
      platform: 'QQ-private'
    }
    return {
      ...i,
      sendMsg: msg => this.sendFriendMsg(i, msg),
      sendWakeUp: message => this.sendWakeUp(i, message),
      recallMsg: message_id => this.recallFriendMsg(i, message_id),
      getAvatarUrl: () => `https://q.qlogo.cn/qqapp/${i.bot.info.appid}/${i.user_id}/0`
    }
  }

  pickMember(id, group_id, user_id) {
    if (!user_id) return undefined
    if (typeof group_id !== 'string') group_id = String(group_id)
    if (typeof user_id !== 'string') user_id = String(user_id)
    if (config.toQQUin && userIdCache[user_id]) {
      user_id = userIdCache[user_id]
    }
    const groupOpenid = this.toGroupManageOpenid(id, group_id)
    const groupKey = `${id}${this.sep}${groupOpenid}`
    const userOpenid = this.toGroupManageOpenid(id, user_id)
    if (user_id.startsWith('qg_')) { return this.pickGuildMember(id, group_id, user_id) }
    const memberMap = Bot[id].gml.get(group_id) || Bot[id].gml.get(groupKey)
    const cachedMember = {
      ...memberMap?.get(user_id),
      ...memberMap?.get(userOpenid),
      ...memberMap?.get(`${id}${this.sep}${userOpenid}`)
    }
    const botState = this.getCachedGroupBotState(id, groupOpenid)
    const isSelf = [String(id), String(Bot[id]?.uin || ''), botState.member_openid]
      .filter(Boolean)
      .includes(userOpenid)
    const roleFields = isSelf
      ? botState
      : buildGroupRoleFields(cachedMember.member_role || cachedMember.role)
    const memberOpenid = isSelf && botState.member_openid ? botState.member_openid : userOpenid
    const i = {
      ...Bot[id].fl.get(user_id),
      ...cachedMember,
      ...roleFields,
      self_id: id,
      bot: Bot[id],
      user_id: userOpenid,
      raw_user_id: memberOpenid,
      openid: memberOpenid,
      member_openid: memberOpenid,
      group_id: groupOpenid,
      platform: 'QQ-group-member'
    }
    return {
      ...this.pickFriend(id, user_id),
      ...i,
      getInfo: () => isSelf
        ? this.getGroupBotState(id, groupOpenid)
        : this.getGroupMemberInfo(id, groupOpenid, userOpenid)
    }
  }

  pickGroup(id, group_id) {
    if (typeof group_id !== 'string') group_id = String(group_id)
    if (group_id.startsWith?.('qg_')) { return this.pickGuild(id, group_id) }
    const groupOpenid = this.toGroupManageOpenid(id, group_id)
    const groupKey = `${id}${this.sep}${groupOpenid}`
    const roleFields = buildGroupRoleFields(this.getCachedGroupBotRole(id, groupOpenid))
    const i = {
      ...Bot[id].gl.get(groupKey),
      ...Bot[id].gl.get(group_id),
      ...roleFields,
      self_id: id,
      bot: Bot[id],
      group_id: groupOpenid,
      platform: 'QQ-group'
    }
    const openid = value => this.toGroupManageOpenid(id, value)
    return {
      ...i,
      sendMsg: (msg, event) => this.sendGroupMsg(i, msg, event),
      pickMember: user_id => this.pickMember(id, group_id, user_id),
      recallMsg: message_id => this.recallGroupMsg(i, message_id),
      getMemberMap: () => i.bot.gml.get(group_id) || i.bot.gml.get(groupKey),
      getInfo: () => this.getGroupInfo(id, i.group_id),
      getBotState: () => this.getGroupBotState(id, i.group_id),
      refreshBotState: () => this.refreshGroupBotState(id, i.group_id),
      getMuteState: () => this.getGroupMuteState(id, i.group_id),
      getGroupMemberInfo: user_id => this.getGroupMemberInfo(id, i.group_id, openid(user_id)),
      muteMember: (user_id, duration) => this.setGroupBan(id, i.group_id, openid(user_id), duration),
      getJoinRequestList: (cursor, limit) => this.getGroupJoinRequestList(id, i.group_id, cursor, limit),
      approveJoinRequest: (member_openid, options) => this.approvalJoinRequest(id, i.group_id, openid(member_openid), options),
      getJoinApprovalStrategies: (cursor, limit) => this.getJoinApprovalStrategies(id, cursor, limit),
      createJoinApprovalStrategy: body => this.createJoinApprovalStrategy(id, body),
      updateJoinApprovalStrategy: (strategy_id, body) => this.updateJoinApprovalStrategy(id, strategy_id, body),
      deleteJoinApprovalStrategy: strategy_id => this.deleteJoinApprovalStrategy(id, strategy_id),
      executeJoinApprovalStrategy: strategy_id => this.executeJoinApprovalStrategy(id, strategy_id),
      updateJoinApprovalWhitelist: (strategy_id, op, whitelist_users) => this.updateJoinApprovalWhitelist(id, strategy_id, op, whitelist_users)
    }
  }

  pickGuildFriend(id, user_id) {
    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(/^qg_/, ''),
      platform: 'guild-private'
    }
    return {
      ...i,
      sendMsg: msg => this.sendDirectMsg(i, msg),
      recallMsg: (message_id, hide) => this.recallDirectMsg(i, message_id, hide)
    }
  }

  pickGuildMember(id, group_id, user_id) {
    const guild_id = group_id.replace(/^qg_/, '').split('-')
    const i = {
      ...Bot[id].fl.get(user_id),
      ...Bot[id].gml.get(group_id)?.get(user_id),
      self_id: id,
      bot: Bot[id],
      src_guild_id: guild_id[0],
      src_channel_id: guild_id[1],
      user_id: user_id.replace(/^qg_/, ''),
      platform: 'guild-channel-member'
    }
    return {
      ...this.pickGuildFriend(id, user_id),
      ...i,
      sendMsg: msg => this.sendDirectMsg(i, msg),
      recallMsg: (message_id, hide) => this.recallDirectMsg(i, message_id, hide)
    }
  }

  pickGuild(id, group_id) {
    const guild_id = group_id.replace(/^qg_/, '').split('-')
    const i = {
      ...Bot[id].gl.get(group_id),
      self_id: id,
      bot: Bot[id],
      guild_id: guild_id[0],
      channel_id: guild_id[1],
      platform: 'guild-channel'
    }
    return {
      ...i,
      sendMsg: msg => this.sendGuildMsg(i, msg),
      recallMsg: (message_id, hide) => this.recallGuildMsg(i, message_id, hide),
      pickMember: user_id => this.pickGuildMember(id, group_id, user_id),
      getMemberMap: () => i.bot.gml.get(group_id)
    }
  }

  setGenerateUrl(data) {
    if (typeof data.bot?.sdk?.getGenerateUrl == 'function') {
      data.getGenerateUrl = callbackData => data.bot.sdk.getGenerateUrl(callbackData)
    }
  }

  async makeFriendMessage(data, event) {
    const user = await data.bot.fl.get(`${data.self_id}${this.sep}${event.sender.user_id}`)
    data.sender = {
      user_id: `${data.self_id}${this.sep}${event.sender.user_id}`,
      raw_user_id: event.sender.user_id,
      bot: event.author?.bot || user?.bot || false,
      nickname: event.sender.user_name || user?.nickname || '',
      avatar: `https://q.qlogo.cn/qqapp/${data.bot.info.appid}/${event.sender.user_id}/0`,
      unionid: event.author?.union_openid || user?.unionid || '',
      openid: event.sender?.user_id || user?.openid || ''
    }
    data.platform = 'QQ-private'
    Bot.makeLog('info', `好友消息：[${data.user_id}] ${data.raw_message}`, data.self_id)
    data.sendInputNotify = input_second => this.sendInputNotify(data, input_second)
    if (config.autoInputNotify) {
      this.sendInputNotify(data, 30)
    }
    data.reply = msg => this.sendFriendMsg({
      ...data, user_id: event.sender.user_id
    }, msg, { id: data.message_id })
    this.setGenerateUrl(data)
    await this.setFriendMap(data)
  }

  async makeGroupMessage(data, event) {
    const user = await data.bot.fl.get(`${data.self_id}${this.sep}${event.sender.user_id}`)
    const memberOpenid = event.author?.member_openid || event.sender.user_id
    const roleFields = buildGroupRoleFields(event.author?.member_role)
    data.sender = {
      user_id: `${data.self_id}${this.sep}${event.sender.user_id}`,
      raw_user_id: event.sender.user_id,
      bot: event.author?.bot || user?.bot || false,
      nickname: event.sender.user_name || user?.nickname || '',
      avatar: `https://q.qlogo.cn/qqapp/${data.bot.info.appid}/${event.sender.user_id}/0`,
      unionid: event.author?.union_openid || user?.unionid || '',
      union_openid: event.author?.union_openid || user?.union_openid || user?.unionid || '',
      user_openid: event.author?.user_openid || '',
      member_openid: memberOpenid,
      openid: event.sender?.user_id || user?.openid || '',
      ...roleFields
    }
    data.group_id = `${data.self_id}${this.sep}${event.group_id}`
    data.platform = 'QQ-group'
    if (config.toQQUin && Handler.has('ws.tool.findUserId')) {
      const user_id = await Handler.call('ws.tool.findUserId', { user_id: data.user_id })
      if (user_id?.custom) {
        userIdCache[user_id.custom] = data.user_id
        data.sender.user_id = user_id.custom
      }
    }

    // 自定义消息过滤前台日志防刷屏(自欺欺人大法)
    const filterLog = config.filterLog?.[data.self_id] || []
    let logStat = filterLog.includes(_.trim(data.raw_message)) ? 'debug' : 'info'
    Bot.makeLog(logStat, `群消息：[${data.group_id}, ${data.user_id}] ${data.raw_message}`, data.self_id)
    data.sendInputNotify = input_second => this.sendInputNotify(data, input_second)
    if (config.autoInputNotify) {
      this.sendInputNotify(data, 30)
    }
    data.reply = msg => this.sendGroupMsg({
      ...data, group_id: event.group_id
    }, msg, { id: data.message_id })
    // data.message.unshift({ type: "at", qq: data.self_id })
    this.setGenerateUrl(data)
    await this.setFriendMap(data)
    await this.setGroupMap(data)
    await this.refreshGroupBotState(data.self_id, data.group_id)
    data.group = this.pickGroup(data.self_id, data.group_id)
    data.member = {
      ...this.pickMember(data.self_id, data.group_id, data.user_id),
      member_openid: memberOpenid,
      ...roleFields
    }
    this.attachMemberMap(data)
  }

  async makeDirectMessage(data, event) {
    data.sender = {
      ...data.bot.fl.get(`qg_${event.sender.user_id}`),
      ...event.sender,
      user_id: `qg_${event.sender.user_id}`,
      bot: event.author?.bot || false,
      nickname: event.sender.user_name,
      avatar: event.author?.avatar,
      guild_id: event.guild_id,
      channel_id: event.channel_id,
      src_guild_id: event.src_guild_id,
      unionid: event.author?.union_openid || '',
      openid: event.sender?.user_id || ''
    }
    data.platform = 'guild-private'
    Bot.makeLog('info', `频道私聊消息：[${data.sender.nickname}(${data.user_id})] ${data.raw_message}`, data.self_id)
    data.sendInputNotify = input_second => this.sendInputNotify(data, input_second)
    data.reply = msg => this.sendDirectMsg({
      ...data,
      user_id: event.user_id,
      guild_id: event.guild_id,
      channel_id: event.channel_id
    }, msg, { id: data.message_id })
    await this.setFriendMap(data)
  }

  async makeGuildMessage(data, event) {
    data.message_type = 'group'
    data.sender = {
      ...data.bot.fl.get(`qg_${event.sender.user_id}`),
      ...event.sender,
      user_id: `qg_${event.sender.user_id}`,
      bot: event.author?.bot || false,
      nickname: event.sender.user_name,
      card: event.member.nick,
      avatar: event.author?.avatar,
      src_guild_id: event.guild_id,
      src_channel_id: event.channel_id,
      unionid: event.author?.union_openid || '',
      openid: event.sender?.user_id || ''
    }
    if (config.toQQUin && Handler.has('ws.tool.findUserId')) {
      const user_id = await Handler.call('ws.tool.findUserId', { user_id: data.user_id })
      if (user_id?.custom) {
        userIdCache[user_id.custom] = data.user_id
        data.sender.user_id = user_id.custom
      }
    }
    data.group_id = `qg_${event.guild_id}-${event.channel_id}`
    data.platform = 'guild-channel'
    Bot.makeLog('info', `频道消息：[${data.group_id}, ${data.sender.nickname}(${data.user_id})] ${data.raw_message}`, data.self_id)
    data.sendInputNotify = input_second => this.sendInputNotify(data, input_second)
    data.reply = msg => this.sendGuildMsg({
      ...data,
      guild_id: event.guild_id,
      channel_id: event.channel_id
    }, msg, { id: data.message_id })
    await this.setFriendMap(data)
    await this.setGroupMap(data)
  }

  async setFriendMap(data) {
    if (!data.user_id) return
    await data.bot.fl.set(data.user_id, {
      ...data.bot.fl.get(data.user_id),
      ...data.sender
    })
  }

  async setGroupMap(data) {
    if (!data.group_id) return
    const groupRole = buildGroupRoleFields(data.group?.role || this.getCachedGroupBotRole(data.self_id, data.group_id))
    await data.bot.gl.set(data.group_id, {
      ...data.bot.gl.get(data.group_id),
      group_id: data.group_id,
      ...groupRole
    })
    let gml = data.bot.gml.get(data.group_id)
    if (!gml) {
      gml = new Map()
      await data.bot.gml.set(data.group_id, gml)
    }
    const memberKeys = [...new Set([
      data.user_id,
      data.sender?.raw_user_id,
      data.sender?.member_openid,
      data.sender?.member_openid && `${data.self_id}${this.sep}${data.sender.member_openid}`
    ].filter(Boolean).map(String))]
    const cachedMember = memberKeys.reduce((result, memberKey) => ({
      ...result,
      ...gml.get(memberKey)
    }), {})
    const member = {
      ...cachedMember,
      ...data.sender
    }
    for (const memberKey of memberKeys) await gml.set(memberKey, member)
    if (data.self_id && data.bot?.uin) {
      const botState = this.getCachedGroupBotState(data.self_id, data.group_id)
      const botMemberOpenid = botState.member_openid
      const botMemberKeys = [...new Set([
        String(data.bot.uin),
        botMemberOpenid,
        botMemberOpenid && `${data.self_id}${this.sep}${botMemberOpenid}`
      ].filter(Boolean))]
      const cachedBotMember = botMemberKeys.reduce((result, memberKey) => ({
        ...result,
        ...gml.get(memberKey)
      }), {})
      const botMember = {
        ...cachedBotMember,
        ...botState,
        self_id: data.self_id,
        user_id: botMemberOpenid ? `${data.self_id}${this.sep}${botMemberOpenid}` : String(data.bot.uin),
        raw_user_id: botMemberOpenid || String(data.bot.uin),
        openid: botMemberOpenid || String(data.bot.uin),
        bot: true,
        group_id: data.group_id,
        nickname: data.bot.nickname,
        card: data.bot.nickname,
        platform: 'QQ-group-member'
      }
      for (const memberKey of botMemberKeys) await gml.set(memberKey, botMember)
    }
  }

  async cacheAuditEvent(event) {
    if (!event?.audit_id) return
    const rawType = event.raw?.t
    const isPass = rawType === 'MESSAGE_AUDIT_PASS' || event.sub_type === 'pass' || event.is_passed === true
    const isReject = rawType === 'MESSAGE_AUDIT_REJECT' || event.sub_type === 'reject' || event.is_passed === false
    if (!isPass && !isReject) return

    try {
      await redis.set(`wind-audit-message_id:${event.audit_id}`, JSON.stringify({
        success: isPass,
        id: isPass ? event.message_id : undefined,
        raw_event: event.raw
      }), { EX: 30 * 24 * 60 * 60 })
    } catch (err) {
      Bot.makeLog('debug', ['审核事件缓存失败', event.audit_id, err], event.self_id || event.bot?.uin)
    }
  }

  async makeMessage(id, event) {
    // 消息审核事件：兼容 SDK 不同版本的字段标识
    const isAuditEvent = event.message_type === 'audit'
      || event.constructor?.name === 'MessageAuditEvent'
      || typeof event.audit_id !== 'undefined'
      || typeof event.is_passed === 'boolean'
    if (isAuditEvent) {
      const subType = event.sub_type || (event.is_passed === true ? 'pass' : event.is_passed === false ? 'reject' : 'unknown')
      const auditInfo = {
        audit_id: event.audit_id,
        message_id: event.message_id,
        guild_id: event.guild_id,
        channel_id: event.channel_id
      }
      Bot.makeLog('info', `消息审核${subType === 'pass' ? '通过' : subType === 'reject' ? '不通过' : '未知'} ${JSON.stringify(auditInfo)}`, id)
      await this.cacheAuditEvent({ ...event, sub_type: subType, bot: Bot[id], self_id: id })
      Bot.em(`notice.audit.${subType}`, {
        ...event,
        self_id: id,
        bot: Bot[id],
        post_type: 'notice',
        notice_type: 'audit',
        sub_type: subType
      })
      return
    }

    const selfBotMentionIds = Array.isArray(event.mentions)
      ? event.mentions
        .filter(m => m?.bot === true && m?.is_you === true)
        .flatMap(m => [m.id, m.member_openid])
        .filter(Boolean)
      : []

    // 艾特了自己机器人时，删除所有出现的自己的艾特
    if (selfBotMentionIds.length) {
      const mentionReg = new RegExp(selfBotMentionIds.map(i => `<@${_.escapeRegExp(i)}>`).join('|'), 'g')
      if (event.raw_message) {
        event.raw_message = event.raw_message.replace(mentionReg, '').replace(/[ \t]{2,}/g, ' ').trim()
      }
      if (event.content) {
        event.content = event.content.replace(mentionReg, '').replace(/[ \t]{2,}/g, ' ').trim()
      }
    }

    const eventMessageId = this.getEventMessageId(event)
    const sdkMessageId = String(event.message_id || '')

    // 提前存储 msg_idx → 网关 d.id 映射，避免后续撤回拿到 SDK/缓存里的其它 message_id
    const msgIdx = event.msg_idx
      || event.message_scene?.ext?.find(e => typeof e === 'string' && e.startsWith('msg_idx='))?.slice('msg_idx='.length)
      || event.raw?.d?.message_scene?.ext?.find(e => typeof e === 'string' && e.startsWith('msg_idx='))?.slice('msg_idx='.length)
    if (msgIdx && eventMessageId) {
      await this.rememberMessageRef({ bot: Bot[id], self_id: id, message_type: event.message_type, raw: event, group_id: event.group_id }, msgIdx, eventMessageId)
    }

    if (config.filter_bot_msg) {
      // 发送方本身是机器人，直接丢弃
      if (event.author?.bot) return true
      // 消息里 @ 了别的机器人（bot=true 且不是当前 Bot），或 @ 了全体成员，丢弃
      if (Array.isArray(event.mentions)) {
        const isBotMentioned = event.mentions.some(m => m?.is_you === true && m?.scope !== "all")
        if (!isBotMentioned && (event.mentions.some(m => m?.scope === "all") || event.mentions.some(m => m?.bot === true && m?.is_you !== true))) return true
      }
    }

    const mentionAtIds = Array.isArray(event.mentions)
      ? _.uniq(event.mentions.flatMap(m => [m.id, m.member_openid, m.user_id, m.openid]).filter(Boolean))
      : []
    const rawMessage = event.raw_message || event.content || ''
    let message = flattenReceivedMessage(event.message || [])
    let raw_message = rawMessage

    const messageMeta = getMessageMeta(id, event)

    const data = {
      event_id: event.event_id,
      raw: event,
      raw_event: event.raw,
      bot: Bot[id],
      self_id: id,
      post_type: event.post_type,
      message_type: event.message_type,
      sub_type: event.sub_type,
      sdk_sub_type: event.sub_type,
      group_at_message: isGroupAtMessageEvent(event),
      message_id: eventMessageId,
      sdk_message_id: sdkMessageId && sdkMessageId !== eventMessageId ? sdkMessageId : '',
      get unionid() { return this.sender.unionid },
      get union_openid() { return this.sender?.union_openid || this.sender?.unionid },
      get openid() { return this.sender.openid },
      get user_openid() { return this.sender?.user_openid },
      get member_openid() { return this.sender?.member_openid },
      get role() { return this.sender?.role },
      get member_role() { return this.sender?.member_role },
      get is_admin() { return this.sender?.is_admin === true },
      get is_owner() { return this.sender?.is_owner === true },
      get is_member() { return this.sender?.is_member === true },
      get user_id() { return this.sender.user_id },
      get nickname() { return this.sender.nickname },
      get avatar() { return this.sender.avatar },
      set avatar(newAvatar) { this.sender.avatar = newAvatar },
      message,
      raw_message,
      time: event.timestamp,
      msg_elements: messageMeta.msg_elements,
      ref_msg_idx: messageMeta.ref_msg_idx,
      msg_idx: messageMeta.msg_idx,
      reply_user: messageMeta.reply_user,
      mentions: messageMeta.mentions,
      at: messageMeta.atArray[messageMeta.atArray.length - 1] || '',
      atall: messageMeta.atall,
      atme: messageMeta.atme,
      atbot: messageMeta.atbot
    }

    await this.rememberReceivedMessageRef(data)
    data.referenced_message_id = await this.getReferencedMessageId(data)
    const referencedRecord = await this.getReferencedMessageRecord(data)
    const referencedReply = referencedRecord ? this.buildReplyMessageFromRecord(data, referencedRecord, data.referenced_message_id) : null
    data.source = data.referenced_message_id
      ? {
        id: data.referenced_message_id,
        message_id: data.referenced_message_id,
        user_id: data.reply_user?.member_openid || data.reply_user?.id || data.reply_user?.user_id || data.reply_user?.openid || '',
        group_id: data.message_type === 'group' && event.group_id ? `${id}${this.sep}${event.group_id}` : undefined,
        time: referencedReply?.time || 0,
        seq: referencedReply?.seq || 0,
        raw_message: referencedReply?.raw_message || '',
        message: referencedReply?.message || []
      }
      : undefined
    data.getReply = async () => {
      const record = await this.getReferencedMessageRecord(data)
      return this.buildReplyMessageFromRecord(data, record, data.referenced_message_id) || referencedReply
    }

    // 插入 reply segment 供 Yunzai loader 设置 e.reply_id，使 recallReply 等插件可正常撤回引用消息
    const replyRefId = data.referenced_message_id || data.ref_msg_idx
    if (replyRefId && !data.message.some(m => m.type === 'reply')) {
      data.message.unshift({ type: 'reply', id: replyRefId })
    }

    for (const i of data.message) {
      switch (i.type) {
        case 'at':
          if (data.message_type == 'group') i.qq = `${data.self_id}${this.sep}${i.user_id}`
          else i.qq = `qg_${i.user_id}`
          break
      }
    }

    if (messageMeta.atUsers.length > 0 && !data.message.some(m => m.type === 'at')) {
      for (const m of messageMeta.atUsers) {
        const mentionId = m.member_openid || m.id || m.user_id || m.openid
        if (!mentionId) continue
        const qq = data.message_type == 'group'
          ? `${data.self_id}${this.sep}${mentionId}`
          : `qg_${mentionId}`
        data.message.push({
          type: 'at',
          qq,
          user_id: mentionId,
          username: m.username || m.nick || m.name || '',
          bot: !!m.bot,
          text: `@${m.username || m.nick || m.name || ''}`
        })
      }
    }

    switch (data.message_type) {
      case 'private':
      case 'direct':
        if (data.sub_type == 'friend') {
          await this.makeFriendMessage(data, event)
        } else {
          await this.makeDirectMessage(data, event)
        }
        break
      case 'group':
        await this.makeGroupMessage(data, event)
        break
      case 'guild':
        await this.makeGuildMessage(data, event)
        if (data.message.length === 0) {
          // tx.sb 群有一个空格频道没有
          data.message.push({ type: 'text', text: '' })
        }
        break
      default:
        Bot.makeLog('warn', ['未知消息', event], id)
        return
    }

    if (config.filter_only_at_other_bot && data.atbot && !data.atme) {
      Bot.makeLog('debug', ['过滤纯艾特其他Bot消息', event], id)
      return true
    }

    data.bot.stat.recv_msg_cnt++
    Bot[data.self_id].dau.setDau('receive_msg', data)
    const emSubType = data.message_type === 'group' && data.sub_type === 'at' ? '' : data.sub_type
    Bot.em([data.post_type, data.message_type, emSubType].filter(Boolean).join('.'), {
      ...data,
      sub_type: emSubType || data.sub_type
    })
  }

  async makeCallback(id, event) {
    const reply = event.reply.bind(event)
    event.reply = async (...args) => {
      try {
        return await reply(...args)
      } catch (err) {
        Bot.makeLog('debug', ['回复按钮点击事件错误', err], data.self_id)
      }
    }

    if ([2001, 2002].includes(event.data?.type)) return

    const user = await Bot[id].fl.get(`${id}${this.sep}${event.operator_id}`)
    const callbackBot = Bot[id]
    if (!callbackBot.callbackEvent) callbackBot.callbackEvent = { user: {}, group: {} }
    const interactionEventId = event.notice_id?.startsWith?.('INTERACTION_CREATE:')
      ? event.notice_id
      : `INTERACTION_CREATE:${event.notice_id}`

    if (event.operator_id) {
      callbackBot.callbackEvent.user[event.operator_id] = interactionEventId
      this.callbackEventCache.set(`${id}:user:${event.operator_id}`, interactionEventId)
      setTimeout(() => {
        delete callbackBot.callbackEvent.user[event.operator_id]
        this.callbackEventCache.delete(`${id}:user:${event.operator_id}`)
      }, 60 * 60 * 1000)
    }
    if (event.group_id) {
      callbackBot.callbackEvent.group[event.group_id] = interactionEventId
      this.callbackEventCache.set(`${id}:group:${event.group_id}`, interactionEventId)
      setTimeout(() => {
        delete callbackBot.callbackEvent.group[event.group_id]
        this.callbackEventCache.delete(`${id}:group:${event.group_id}`)
      }, 5 * 60 * 1000)
    }

    const data = {
      event_id: event.event_id,
      raw: event,
      raw_event: event.raw,
      bot: Bot[id],
      self_id: id,
      post_type: 'message',
      notice_id: event.notice_id,
      callback_event_id: interactionEventId,
      message_id: event.event_id ? `event_${event.event_id}` : event.notice_id || '',
      message_type: event.notice_type,
      sub_type: 'callback',
      get openid() { return this.sender.openid },
      get unionid() { return this.sender.unionid },
      get user_id() { return this.sender.user_id },
      get nickname() { return this.sender.nickname },
      get avatar() { return this.sender.avatar },
      set avatar(newAvatar) { this.sender.avatar = newAvatar },
      sender: {
        user_id: `${id}${this.sep}${event.operator_id}`,
        bot: event.author?.bot || user?.bot || false,
        avatar: `https://q.qlogo.cn/qqapp/${Bot[id].info.appid}/${event.operator_id}/0`,
        unionid: event.union_openid || user?.unionid || '',
        openid: event.operator_id || user?.openid || '',
        nickname: event.user_name || user?.nickname || ''
      },
      message: [],
      raw_message: '',
      platform: `QQ-${event.notice_type === 'group' ? 'group' : 'private'}`,
      time: event.timestamp
    }

    const callback = data.bot.callback[event.data?.resolved?.button_id]
    const buttonData = event.data?.resolved?.button_data
    if (callback) {
      if (!event.group_id && callback.group_id) { event.group_id = callback.group_id }
    }
    const callbackText = buttonData || callback?.message || ''
    if (callbackText) {
      data.message.push({ type: 'text', text: callbackText })
      data.raw_message += callbackText
    } else {
      return event.reply(1)
    }
    event.reply(0)

    const wrapWithEventId = (msg) => {
      msg = Array.isArray(msg) ? [...msg] : [msg]
      msg.unshift({ type: 'reply', id: `event_${interactionEventId}` })
      return msg
    }

    switch (data.message_type) {
      case 'direct':
      case 'friend':
        data.message_type = 'private'
        Bot.makeLog('info', [`好友按钮点击事件：[${data.user_id}]`, data.raw_message], data.self_id)
        data.reply = msg => this.sendFriendMsg(
          { ...data, user_id: event.operator_id },
          wrapWithEventId(msg),
          { event_id: `event_${interactionEventId}` }
        )
        await this.setFriendMap(data)
        callbackBot.callbackEvent.user[event.operator_id] = interactionEventId
        this.callbackEventCache.set(`${id}:user:${event.operator_id}`, interactionEventId)
        setTimeout(() => {
          delete callbackBot.callbackEvent.user[event.operator_id]
          this.callbackEventCache.delete(`${id}:user:${event.operator_id}`)
        }, 60 * 60 * 1000)
        break
      case 'group':
        data.group_id = `${id}${this.sep}${event.group_id}`
        this.attachMemberMap(data)
        Bot.makeLog('info', [`群按钮点击事件：[${data.group_id}, ${data.user_id}]`, data.raw_message], data.self_id)
        data.reply = msg => this.sendGroupMsg(
          { ...data, group_id: event.group_id },
          wrapWithEventId(msg),
          { event_id: `event_${interactionEventId}` }
        )
        await this.setGroupMap(data)
        callbackBot.callbackEvent.group[event.group_id] = interactionEventId
        callbackBot.callbackEvent.user[event.operator_id] = interactionEventId
        this.callbackEventCache.set(`${id}:group:${event.group_id}`, interactionEventId)
        this.callbackEventCache.set(`${id}:user:${event.operator_id}`, interactionEventId)
        setTimeout(() => {
          delete callbackBot.callbackEvent.group[event.group_id]
          delete callbackBot.callbackEvent.user[event.operator_id]
          this.callbackEventCache.delete(`${id}:group:${event.group_id}`)
          this.callbackEventCache.delete(`${id}:user:${event.operator_id}`)
        }, 5 * 60 * 1000)
        break
      case 'guild':
        break
      default:
        Bot.makeLog('warn', ['未知按钮点击事件', event], data.self_id)
    }

    Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  async makeNotice(id, event) {
    const noticeEventKey = event.event_id && `${id}:${event.event_id}`
    if (noticeEventKey) {
      if (this.noticeEventCache.has(noticeEventKey)) {
        Bot.makeLog('debug', ['忽略重复通知事件', event.event_id], id)
        return
      }
      this.noticeEventCache.add(noticeEventKey)
      setTimeout(() => this.noticeEventCache.delete(noticeEventKey), 5 * 60 * 1000)
    }

    // QQ 官方事件中 group.increase/decrease 表示机器人自身被加群/移出群，
    // 而 Yunzai/ICQQ 使用这两个事件表示普通成员进退群。为避免语义冲突，
    // 机器人自身的群变更使用独立的 bot.increase/bot.decrease 事件。
    const isGroupBotChange = event.notice_type === 'group'
      && ['increase', 'decrease'].includes(event.sub_type)
    const subType = isGroupBotChange ? `bot.${event.sub_type}` : event.sub_type
    const rawUserId = event.user_id
      || (!isGroupBotChange ? event.operator_id || event.raw?.d?.member_openid : undefined)

    const data = {
      event_id: event.event_id,
      raw: event,
      raw_event: event.raw,
      bot: Bot[id],
      self_id: id,
      post_type: event.post_type || 'notice',
      notice_type: event.notice_type,
      sub_type: subType,
      raw_message: event.raw_message || event.event_id || `${event.notice_type || 'notice'}.${subType || 'unknown'}`,
      notice_id: event.notice_id,
      group_id: event.group_id ? `${id}${this.sep}${event.group_id}` : event.group_id,
      user_id: rawUserId ? `${id}${this.sep}${rawUserId}` : undefined,
      operator_id: event.operator_id ? `${id}${this.sep}${event.operator_id}` : undefined,
      raw_group_id: event.group_id,
      raw_user_id: rawUserId,
      raw_operator_id: event.operator_id,
      platform: event.notice_type === 'guild' ? 'guild-notice' : 'QQ-notice'
    }
    this.setGenerateUrl(data)

    const noticeEventId = event.notice_id?.startsWith?.('INTERACTION_CREATE:')
      ? event.notice_id
      : (event.notice_id ? `INTERACTION_CREATE:${event.notice_id}` : null)
    if (noticeEventId && event.group_id) {
      this.callbackEventCache.set(`${id}:${event.group_id}`, noticeEventId)
      setTimeout(() => this.callbackEventCache.delete(`${id}:${event.group_id}`), 5 * 60 * 1000)
    }
    if (noticeEventId && event.user_id) {
      this.callbackEventCache.set(`${id}:${event.user_id}`, noticeEventId)
      setTimeout(() => this.callbackEventCache.delete(`${id}:${event.user_id}`), 5 * 60 * 1000)
    }

    if (event.notice_type === 'friend' && event.user_id) {
      data.reply = msg => this.sendFriendMsg({
        ...data,
        user_id: event.user_id
      }, msg, { event_id: data.event_id })
    }

    if (event.notice_type === 'group' && event.group_id) {
      const replyEventId = ['increase', 'member.increase'].includes(data.sub_type)
        ? data.event_id
        : undefined
      data.reply = msg => this.sendGroupMsg({
        ...data,
        group_id: event.group_id
      }, msg, replyEventId ? { event_id: replyEventId } : {})
      await this.refreshGroupBotState(id, data.group_id)
      data.group = this.pickGroup(id, data.group_id)
      this.attachMemberMap(data)
      if (replyEventId) {
        const sendMsg = data.group.sendMsg
        data.group.sendMsg = (msg, source = {}) => sendMsg(msg, {
          ...source,
          event_id: source.event_id || replyEventId
        })
      }
      if (data.user_id) {
        data.member = this.pickMember(id, data.group_id, data.user_id)
      }

      if (['decrease', 'member.decrease'].includes(data.sub_type) && data.user_id) {
        const memberMap = Bot[id].gml.get(data.group_id)
        const rawUserId = data.raw_user_id || event.raw?.d?.member_openid
        let cachedMember = memberMap?.get(data.user_id)

        // 开启 QQ 号转换时，成员表可能以转换后的 user_id 为键，需要按原始 openid 回查。
        if (!cachedMember && rawUserId && memberMap?.values) {
          cachedMember = [...memberMap.values()].find(member =>
            member?.raw_user_id === rawUserId || member?.openid === rawUserId
          )
        }

        const cachedFriend = Bot[id].fl.get(data.user_id)
        const nickname = cachedMember?.nickname || cachedFriend?.nickname || ''
        data.sender = {
          ...cachedFriend,
          ...cachedMember,
          user_id: data.user_id,
          raw_user_id: rawUserId,
          nickname
        }
        data.nickname = nickname
        data.member = {
          ...data.member,
          ...cachedMember,
          nickname
        }
      }
    }

    switch (data.sub_type) {
      case 'action':
        return this.makeCallback(id, event)
      case 'increase':
        break
      case 'member.increase':
        if (event.notice_type === 'group') {
          Bot[data.self_id].dau.setDau('group_increase', data)
          const path = join(process.cwd(), 'plugins', 'QQBot-Plugin', 'Model', 'template', 'groupIncreaseMsg.js')
          if (fs.existsSync(path)) {
            import(`file://${path}`).then(i => i.default).then(async i => {
              let msg
              if (typeof i === 'function') {
                msg = await i(`${data.self_id}${this.sep}${event.group_id}`, `${data.self_id}${this.sep}${data.user_id}`, data.self_id)
              } else {
                msg = i
              }
              if (msg?.length > 0) {
                this.sendMsg(data, msg => data.bot.sdk.sendGroupMessage(event.group_id, adaptSendableForSDK(msg)), msg)
              }
            })
          }
        }
        break
      case 'decrease':
        break
      case 'member.decrease':
        if (event.notice_type === 'group') {
          Bot[data.self_id].dau.setDau('group_decrease', data)
        }
        break
      case 'bot.increase':
      case 'bot.decrease':
        break
      case 'update':
      case 'member.update':
      case 'add':
      case 'remove':
        break
      case 'receive_open':
      case 'receive_close':
        break
      default:
        // console.log('event', event)
        Bot.makeLog('warn', ['未知通知', event], id)
        return
    }

    // 保留 SDK 原生群成员事件，同时发送 Yunzai/ICQQ 兼容事件。
    // Yunzai 插件加载器根据事件对象字段匹配，因此兼容事件必须同步改写 sub_type。
    const emSubType = data.sub_type.replace('member.', '')
    if (emSubType !== data.sub_type) {
      // 原生四段事件只精确发送，避免它冒泡到 notice 后让插件加载器重复处理。
      Bot.prepareEvent?.(data)
      Bot.emit(`${data.post_type}.${data.notice_type}.${data.sub_type}`, data)
      Bot.em(`${data.post_type}.${data.notice_type}.${emSubType}`, {
        ...data,
        sub_type: emSubType
      })
    } else {
      Bot.em(`${data.post_type}.${data.notice_type}.${data.sub_type}`, data)
    }
  }

  async makeGroupJoinRequest(id, event) {
    const groupOpenid = getJoinRequestField(event, 'group_id', 'group_openid')
    const data = this.normalizeGroupJoinRequest(id, groupOpenid, event, event)
    if (!data.flag) data.flag = event.notice_id || event.event_id || ''
    const groupId = data.group_id

    await this.refreshGroupBotState(id, groupId)
    data.group = this.pickGroup(id, groupId)
    data.member = this.pickMember(id, groupId, data.user_id)
    this.attachMemberMap(data)

    this.upsertGroupJoinRequest(id, data)
    Bot.makeLog('info', `加群请求：${data.sub_type} ${data.comment}(${data.flag})`, data.self_id)
    Bot.em(`${data.post_type}.${data.request_type}.${data.sub_type}`, data)
  }

  getFriendMap(id) {
    return Bot.getMap(`${this.path}${id}/Friend`)
  }

  getGroupMap(id) {
    return Bot.getMap(`${this.path}${id}/Group`)
  }

  getMemberMap(id) {
    return Bot.getMap(`${this.path}${id}/Member`)
  }

  attachMemberMap(data) {
    if (!data?.group_id) return data
    data.getMemberMap = (...args) => {
      const group = data.group || data.bot?.pickGroup?.(data.group_id)
      return group?.getMemberMap?.(...args)
    }
    return data
  }

  async connect(token) {
    token = token.split(':')
    const id = token[0]
    const adapterInstance = this
    const opts = {
      ...config.bot,
      appid: token[1],
      token: token[2],
      secret: token[3],
      intents: [
        'GUILDS',
        'GUILD_MEMBERS',
        'GUILD_MESSAGE_REACTIONS',
        'DIRECT_MESSAGE',
        'INTERACTION',
        'MESSAGE_AUDIT'
      ],
      mode: 'websocket'
    }

    if (Number(token[4])) {
      opts.intents.push('GROUP_AND_C2C_EVENT', 'GROUP_MEMBER')
    }

    if (Number(token[5])) opts.intents.push('GUILD_MESSAGES')
    else opts.intents.push('PUBLIC_GUILD_MESSAGES')

    const sdk = new QQBot(opts)
    disableAxiosEnvProxy(sdk.request)
    patchGroupRequestEventParser(sdk)

    const originalMessageUploadFile = sdk.messageService?.uploadFile?.bind(sdk.messageService)
    if (originalMessageUploadFile) {
      sdk.messageService.uploadFile = async (endpointPath, buildResult) => {
        const endpointMatch = String(endpointPath).match(/^\/v2\/(users|groups)\/([^/]+)$/)
        const filePayload = buildResult?.filePayload || {}
        const fileData = filePayload.file_data
          ? `base64://${filePayload.file_data}`
          : filePayload.url
        if (!endpointMatch || !fileData) return originalMessageUploadFile(endpointPath, buildResult)

        const targetType = endpointMatch[1] === 'groups' ? 'group' : 'user'
        const uploadResult = await this.uploadFileToQQ(
          { bot: { sdk }, self_id: id },
          endpointMatch[2],
          targetType,
          fileData,
          filePayload.file_name,
          false,
          filePayload.file_type
        )
        if (!uploadResult?.file_info) throw new Error('富媒体上传成功但未返回 file_info')
        return { file_info: uploadResult.file_info }
      }
    }

    const originalDispatchEvent = sdk.dispatchEvent?.bind(sdk)
    if (originalDispatchEvent) {
      sdk.dispatchEvent = (event, wsRes) => {
        if (wsRes?.d && typeof wsRes.d === 'object') {
          const rawPacket = { ...wsRes, d: { ...wsRes.d } }
          wsRes.d.raw = rawPacket
          wsRes.d.raw_event = rawPacket
          wsRes.d.api_message_id = wsRes.d.id
        }
        return originalDispatchEvent(event, wsRes)
      }
    }

    {
      const StreamInputMode = { REPLACE: 'replace' }
      const StreamInputState = { GENERATING: 1, DONE: 10 }
      const StreamContentType = { TEXT: 'text', MARKDOWN: 'markdown' }

      function extractText(message) {
        if (typeof message === 'string') return message
        if (Array.isArray(message)) {
          return message.map(item => {
            if (!item || typeof item !== 'object') return ''
            const d = item.data
            if (item.type === 'markdown') return (d?.content ?? item.content) || ''
            if (item.type === 'text') return (d?.text ?? item.text) || ''
            return ''
          }).join('')
        }
        return ''
      }

      function getStreamSourcePayload(buildResult) {
        const payload = buildResult?.messagePayload || {}
        if (payload.markdown?.content) {
          return {
            content: String(payload.markdown.content),
            contentType: StreamContentType.MARKDOWN,
            payload
          }
        }
        if (payload.content) {
          return {
            content: String(payload.content),
            contentType: StreamContentType.TEXT,
            payload
          }
        }
        return { content: '', contentType: StreamContentType.TEXT, payload }
      }

      async function postStreamPart(sdk, endpointPath, req) {
        try {
          return await sdk.request.post(`${endpointPath}/stream_messages`, req)
        } catch (e) {
          const code = e.message?.match(/code\((\d+)\)/)?.[1]
          if (code === '40034105' && req.event_id?.startsWith?.('INTERACTION_CREATE:')) {
            return await sdk.request.post(`${endpointPath}/stream_messages`, {
              ...req,
              event_id: req.event_id.replace(/^INTERACTION_CREATE:/, '')
            })
          }
          throw e
        }
      }

      async function sendStreamMessage(sdk, endpointPath, message, source = {}, options = {}) {
        const { MessageBuilder } = _require('qq-official-bot/lib/message/builder.js')
        const buildResult = await new MessageBuilder(
          sdk.config?.appid,
          !endpointPath.startsWith('/v2'),
          source
        ).build(message)
        const streamSource = getStreamSourcePayload(buildResult)
        let content = streamSource.content || extractText(message)
        if (!content || typeof content !== 'string') throw new Error('流式消息内容必须是字符串')
        const contentType = streamSource.content ? streamSource.contentType : StreamContentType.MARKDOWN
        const chunkSize = Math.max(1, Number(options.chunkSize) || Math.ceil(content.length / 2) || 1)
        const delay = Math.max(0, Number(options.delay) || 0)
        const chars = Array.from(content)
        const baseReq = {
          input_mode: StreamInputMode.REPLACE,
          content_type: contentType,
          msg_seq: streamSource.payload.msg_seq
        }
        if (streamSource.payload.event_id) baseReq.event_id = streamSource.payload.event_id
        else if (streamSource.payload.msg_id) baseReq.msg_id = streamSource.payload.msg_id
        if (streamSource.payload.is_wakeup) baseReq.is_wakeup = true

        let streamMsgId = null
        let index = 0
        let currentContent = ''
        let lastResult = null
        for (let i = 0; i < chars.length; i += chunkSize) {
          const chunk = chars.slice(i, i + chunkSize).join('')
          currentContent += chunk
          const req = {
            ...baseReq,
            input_mode: StreamInputMode.REPLACE,
            input_state: i + chunkSize >= chars.length ? StreamInputState.DONE : StreamInputState.GENERATING,
            content_raw: currentContent,
            index: index++
          }
          if (streamMsgId) req.stream_msg_id = streamMsgId
          const response = await postStreamPart(sdk, endpointPath, req)
          lastResult = response.data || null
          if (!streamMsgId && response.data?.id) streamMsgId = response.data.id
          if (i + chunkSize < chars.length && delay > 0) await new Promise(r => setTimeout(r, delay))
        }
        return {
          id: streamMsgId || lastResult?.id,
          timestamp: Date.now() / 1000,
          brief: buildResult.brief,
          content: currentContent,
          ext_info: lastResult?.ext_info,
          remain_msg_len: lastResult?.remain_msg_len
        }
      }

      {
        const origPrivate = sdk.sendPrivateMessage?.bind(sdk)
        if (origPrivate) {
          sdk.sendPrivateMessage = async function (user_id, message, source = {}, options = {}) {
            if (options.stream) {
              const text = extractText(message)
              logger.info(`[QQBot] 流式消息: stream=${options.stream}, 文本长度=${text.length}`)
              if (text) {
                try { return await sendStreamMessage(sdk, `/v2/users/${user_id}`, message, source, options) }
                catch (e) { logger.error(`流式发送失败，转为普通消息: ${e.message}`) }
              } else {
                logger.warn('[QQBot] 流式消息提取文本为空，转为普通消息', JSON.stringify(message).slice(0, 200))
              }
            }
            return origPrivate(user_id, message, source, options)
          }
        }
      }

      const { createRequire } = await import('node:module')
      const _require = createRequire(import.meta.url)
      const { MessageBuilder } = _require('qq-official-bot/lib/message/builder.js')
      async function sendRegularMessageWithMeta(endpointPath, buildResult, options = {}) {
        const { data: result } = await sendWithGroupMarkdownImageRetry({
          endpointPath,
          messagePayload: buildResult.messagePayload,
          send: () => this.request.post(endpointPath + '/messages', buildResult.messagePayload, {
            headers: {
              'Content-Type': buildResult.contentType
            },
            timeout: options.timeout || 10000
          }),
          onRetry: async retryContext => {
            const switched = await options.onMarkdownImageRetry?.(retryContext)
            const { attempt, delayMs, code } = retryContext
            if (!switched) {
              logger.warn(`[QQBot] 群聊 Markdown 图片转存失败(code(${code}))，${delayMs}ms 后进行第 ${attempt} 次重试`)
            }
            return switched === true
          }
        })
        if (this.isAuditResult(result)) {
          return {
            id: result.message_audit.audit_id,
            timestamp: Date.now() / 1000,
            audit_status: 'pending',
            reason: '',
            brief: buildResult.brief
          }
        }
        return {
          id: result.id,
          timestamp: Date.now() / 1000,
          brief: buildResult.brief,
          ext_info: result.ext_info,
          msg_idx: result.msg_idx
        }
      }
      sdk.messageService.sendMessage = async function (endpointPath, message, source, options) {
        const buildResult = await new MessageBuilder(
          this.appid,
          !endpointPath.startsWith('/v2'),
          source
        ).build(message)
        if (source?.smallbtn && buildResult.messagePayload?.keyboard?.content) {
          buildResult.messagePayload.keyboard.content.style = { font_size: 'small' }
        }
        if (buildResult.isFile) {
          buildResult.messagePayload.media = await this.uploadFile(endpointPath, buildResult)
        }
        let imageBedFallbackAttempted = false
        const sendOptions = {
          ...(options || {}),
          onMarkdownImageRetry: async ({ code }) => {
            if (imageBedFallbackAttempted) return false
            imageBedFallbackAttempted = true

            const fallback = await adapterInstance.switchLocalMarkdownImagesToImageBed(
              { self_id: id, bot: Bot[id] },
              buildResult.messagePayload
            )
            if (!fallback.replaced) return false

            buildResult.messagePayload = fallback.message
            if (source?.smallbtn && buildResult.messagePayload?.keyboard?.content) {
              buildResult.messagePayload.keyboard.content.style = { font_size: 'small' }
            }
            if (buildResult.messagePayload?.markdown && typeof buildResult.messagePayload.markdown === 'object') {
              buildResult.messagePayload.markdown.force_verify_image_resource = true
            }
            logger.info(`[QQBot] 本地图片被平台拒绝(code(${code}))，已自动切换图床并重发: ${fallback.urls.join(', ')}`)
            return true
          }
        }
        try {
          return await sendRegularMessageWithMeta.call(this, endpointPath, buildResult, sendOptions)
        } catch (e) {
          const code = e.message?.match(/code\((\d+)\)/)?.[1]
          const eventId = buildResult.messagePayload?.event_id
          if (code === '40034105' && eventId?.startsWith?.('INTERACTION_CREATE:')) {
            const retryBuildResult = {
              ...buildResult,
              messagePayload: {
                ...buildResult.messagePayload,
                event_id: eventId.replace(/^INTERACTION_CREATE:/, '')
              }
            }
            return await sendRegularMessageWithMeta.call(this, endpointPath, retryBuildResult, sendOptions)
          }
          if (buildResult.messagePayload && ['22007', '40034025', '40034128'].includes(code)) {
            logger.warn(`被动回复失败(code(${code}))，正在尝试通过主动消息发送`)
            delete buildResult.messagePayload.msg_id
            delete buildResult.messagePayload.event_id
            return await sendRegularMessageWithMeta.call(this, endpointPath, buildResult, sendOptions)
          }
          throw e
        }
      }

      sdk.messageService.sendRecallMessage = async function (endpointPath, message, source) {
        const messageBuilder = new MessageBuilder(this.appid, !endpointPath.startsWith('/v2'), source)
        const buildResult = await messageBuilder.build(message)
        if (buildResult.messagePayload) {
          delete buildResult.messagePayload.msg_id
          delete buildResult.messagePayload.event_id
          buildResult.messagePayload.is_wakeup = true
        }
        if (buildResult.isFile) {
          buildResult.messagePayload.media = await this.uploadFile(endpointPath, buildResult)
        }
        return await sendRegularMessageWithMeta.call(this, endpointPath, buildResult)
      }
    }

    Bot[id] = {
      adapter: this,
      sdk,
      login() {
        return this.sdk.start()
      },
      logout() {
        return Promise.resolve(this.sdk.stop())
      },

      uin: id,
      info: {
        id, ...opts,
        avatar: `https://q.qlogo.cn/g?b=qq&s=0&nk=${this.uin}`,
      },
      get nickname() { return this.info.username },
      get avatar() { return this.info.avatar },

      version: {
        id: this.id,
        name: this.name,
        version: this.version
      },
      stat: {
        start_time: Date.now() / 1000,
        recv_msg_cnt: 0
      },

      pickFriend: user_id => this.pickFriend(id, user_id),
      get pickUser() { return this.pickFriend },
      getFriendMap() { return this.fl },
      fl: await this.getFriendMap(id),

      pickMember: (group_id, user_id) => this.pickMember(id, group_id, user_id),
      pickGroup: group_id => this.pickGroup(id, group_id),
      getGroupMap() { return this.gl },
      gl: await this.getGroupMap(id),
      gml: await this.getMemberMap(id),

      dau: new Dau(id, this.sep, config.dauDB),

      getGroupInfo: group_openid => this.getGroupInfo(id, group_openid),
      getGroupBotState: group_openid => this.getGroupBotState(id, group_openid),
      refreshGroupBotState: group_openid => this.refreshGroupBotState(id, group_openid),
      getGroupMemberInfo: (group_openid, member_openid) => this.getGroupMemberInfo(id, group_openid, member_openid),
      getGroupMuteState: group_openid => this.getGroupMuteState(id, group_openid),
      setGroupBan: (group_openid, member_openid, duration) => this.setGroupBan(id, group_openid, member_openid, duration),
      getGroupJoinRequestList: (group_openid, cursor, limit) => this.getGroupJoinRequestList(id, group_openid, cursor, limit),
      syncGroupJoinRequests: (group_id, options) => this.syncGroupJoinRequests(id, group_id, options),
      setGroupAddRequest: (flagOrGroupOpenid, arg2, arg3, arg4, arg5, arg6) =>
        this.setGroupAddRequest(id, flagOrGroupOpenid, arg2, arg3, arg4, arg5, arg6),
      getJoinApprovalStrategies: (cursor, limit) => this.getJoinApprovalStrategies(id, cursor, limit),
      createJoinApprovalStrategy: body => this.createJoinApprovalStrategy(id, body),
      updateJoinApprovalStrategy: (strategy_id, body) => this.updateJoinApprovalStrategy(id, strategy_id, body),
      deleteJoinApprovalStrategy: strategy_id => this.deleteJoinApprovalStrategy(id, strategy_id),
      executeJoinApprovalStrategy: strategy_id => this.executeJoinApprovalStrategy(id, strategy_id),
      updateJoinApprovalWhitelist: (strategy_id, op, whitelist_users) => this.updateJoinApprovalWhitelist(id, strategy_id, op, whitelist_users),

      callback: {},

      request_list: [],
      getRequestList() {
        return this.request_list
      },
      getSystemMsg() {
        return this.getRequestList()
      }
    }

    sdk.recallPrivateMessage = async (userId, messageId) => (await this.recallFriendMsg({
      self_id: id,
      bot: Bot[id],
      message_type: 'private',
      user_id: String(userId || '')
    }, messageId))?.[0]
    sdk.recallGroupMessage = async (groupId, messageId) => (await this.recallGroupMsg({
      self_id: id,
      bot: Bot[id],
      message_type: 'group',
      group_id: String(groupId || ''),
      group_openid: String(groupId || '')
    }, messageId))?.[0]

    Bot[id].sdk.logger = {}
    for (const i of ['trace', 'debug', 'info', 'mark', 'warn', 'error', 'fatal']) {
      Bot[id].sdk.logger[i] = (...args) => {
        if (args?.[0]?.match?.(/Invalid intends/)) return
        if (config.simplifiedSdkLog) {
          if (args?.[0]?.match?.(/^send to/)) {
            args[0] = args[0].replace(/<(.+?)(,.*?)>/g, (v, k1, k2) => {
              return `<${k1}>`
            })
          } else if (args?.[0]?.match?.(/^recv from/)) {
            return
          }
        }
        Bot.makeLog(i, args, id)
      }
    }
    patchSessionManager(Bot[id].sdk.sessionManager)

    try {
      if (token[4] === "2") {
        await Bot[id].sdk.sessionManager.getAccessToken()
        Bot[id].login = () => this.appid[opts.appid] = Bot[id]
        Bot[id].logout = () => delete this.appid[opts.appid]
      }

      await Bot[id].login()
      Object.assign(Bot[id].info, await Bot[id].sdk.getSelfInfo())
    } catch (err) {
      Bot.makeLog("error", [`${this.name}(${this.id}) ${this.version} 连接失败`, err], id)
      return false
    }
    await Bot[id].dau.init()

    Bot[id].sdk.on('message', event => this.makeMessage(id, event))
    Bot[id].sdk.on('notice', event => this.makeNotice(id, event))
    Bot[id].sdk.on('request', event => this.makeGroupJoinRequest(id, event))

    Bot.makeLog("mark", `${this.name}(${this.id}) ${this.version} ${Bot[id].nickname} 已连接`, id)
    Bot.em(`connect.${id}`, { self_id: id })
    return true
  }

  async makeWebHookSign(req, secret) {
    const { sign } = (await import("tweetnacl")).default
    const { plain_token, event_ts } = req.body.d
    while (secret.length < 32)
      secret = secret.repeat(2).slice(0, 32)
    const signature = Buffer.from(sign.detached(
      Buffer.from(`${event_ts}${plain_token}`),
      sign.keyPair.fromSeed(Buffer.from(secret)).secretKey,
    )).toString("hex")
    req.res.send({ plain_token, signature })
  }

  makeWebHook(req) {
    const appid = req.headers["x-bot-appid"]
    if (!(appid in this.appid))
      return Bot.makeLog("warn", "找不到对应Bot", appid)
    if (req.body?.d && "plain_token" in req.body.d)
      return this.makeWebHookSign(req, this.appid[appid].info.secret)
    if (req.body && "t" in req.body) {
      this.appid[appid].sdk.dispatchEvent(req.body.t, req.body)
    }
    req.res.send({ code: 0 })
  }

  async load() {
    Bot.express.use(`/${this.name}`, this.makeWebHook.bind(this))
    Bot.express.quiet?.push?.(`/${this.name}`)
    for (const token of config.token) {
      await new Promise(resolve => {
        adapter.connect(token).then(resolve)
        setTimeout(resolve, 5000)
      })
    }
  }
}()

Bot.adapter.push(adapter)

const setMap = {
  二维码: 'toQRCode',
  按钮回调: 'toCallback',
  转换: 'toQQUin',
  转图片: 'toImg',
  调用统计: 'callStats',
  用户统计: 'userStats',
  流式: 'stream',
  小按钮: 'smallbtn',
  机器人消息过滤: 'filter_bot_msg',
  其他Bot艾特过滤: 'filter_only_at_other_bot'
}

export class QQBotAdapter extends plugin {
  constructor() {
    super({
      name: 'QQBotAdapter',
      dsc: 'QQBot 适配器设置',
      event: 'message',
      rule: [
        {
          reg: /^#q+bot(帮助|help)$/i,
          fnc: 'help',
          permission: config.permission
        },
        {
          reg: /^#q+bot账号$/i,
          fnc: 'List',
          permission: config.permission
        },
        {
          reg: /^#[Qq]+[Bb]ot设置[0-9]+:[0-9]+:.+:.+:([01]:[01]|2)$/i,
          fnc: 'Token',
          permission: config.permission
        },
        {
          reg: /^#[Qq]+[Bb]ot登录[0-9]+:([01]:[01]|2)$/i,
          fnc: 'QRLogin',
          permission: config.permission
        },
        {
          reg: /^#q+botm(ark)?d(own)?[0-9]+:/i,
          fnc: 'Markdown',
          permission: config.permission
        },
        {
          reg: new RegExp(`^#q+bot设置(${Object.keys(setMap).join('|')})\\s*(开启|关闭)$`, 'i'),
          fnc: 'Setting',
          permission: config.permission
        },
        {
          reg: /^#q+botdau/i,
          fnc: 'DAUStat',
          permission: config.permission
        },
        {
          reg: /^#q+bot调用统计$/i,
          fnc: 'callStat',
          permission: config.permission
        },
        {
          reg: /^#q+bot用户统计$/i,
          fnc: 'userStat',
          permission: config.permission
        },
        {
          reg: /^#?图床状态(?:\s*[\w\u4e00-\u9fa5-]+)?(?:\s*\d+\s*天?)?$/i,
          fnc: 'imageBedStat',
          permission: config.permission
        },
        {
          reg: /^#q+bot刷新co?n?fi?g$/i,
          fnc: 'refConfig',
          permission: config.permission
        },
        {
          reg: /^#q+bot(添加|删除)过滤日志/i,
          fnc: 'filterLog',
          permission: config.permission
        },
        {
          reg: /^#q+bot一键群发$/i,
          fnc: 'oneKeySendGroupMsg',
          permission: config.permission
        },
        {
          reg: /^#[Rr][Aa][Ww][Bb][Uu][Tt][Tt][Oo][Nn]\d+(?::(true|false))?$/i,
          fnc: 'rawButton',
          permission: config.permission
        }
      ]
    })
  }

  help() {
    this.reply(['# QQBot 帮助', segment.button(
      [
        { text: 'dau', callback: '#QQBotdau' },
        { text: 'daupro', callback: '#QQBotdaupro' }
      ],
      [
        { text: '调用统计', callback: '#QQBot调用统计' },
        { text: '用户统计', callback: '#QQBot用户统计' }
      ],
      [
        { text: `${config.toCallback ? '关闭' : '开启'}按钮回调`, callback: `#QQBot设置按钮回调${config.toCallback ? '关闭' : '开启'}` },
        { text: `${config.callStats ? '关闭' : '开启'}调用统计`, callback: `#QQBot设置调用统计${config.callStats ? '关闭' : '开启'}` }
      ],
      [
        { text: `${config.userStats ? '关闭' : '开启'}用户统计`, callback: `#QQBot设置用户统计${config.userStats ? '关闭' : '开启'}` },
        { text: `${config.stream ? '关闭' : '开启'}流式`, callback: `#QQBot设置流式${config.stream ? '关闭' : '开启'}` }
      ],
      [
        { text: `${config.smallbtn ? '关闭' : '开启'}小按钮`, callback: `#QQBot设置小按钮${config.smallbtn ? '关闭' : '开启'}` },
        { text: `${config.filter_bot_msg ? '关闭' : '开启'}机器人消息过滤`, callback: `#QQBot设置机器人消息过滤${config.filter_bot_msg ? '关闭' : '开启'}` }
      ],
      [
        { text: `${config.filter_only_at_other_bot ? '关闭' : '开启'}其他Bot艾特过滤`, callback: `#QQBot设置其他Bot艾特过滤${config.filter_only_at_other_bot ? '关闭' : '开启'}` }
      ]
    )])
  }

  refConfig() {
    refConfig()
  }

  List() {
    this.reply(`共${config.token.length}个账号：\n${config.token.join('\n')}`, true)
  }

  async Token() {
    const token = this.e.msg.replace(/^#q+bot设置/i, '').trim()
    if (config.token.includes(token)) {
      config.token = config.token.filter(item => item != token)
      this.reply(`账号已删除，重启后生效，共${config.token.length}个账号`, true)
    } else {
      if (await adapter.connect(token)) {
        config.token.push(token)
        this.reply(`账号已连接，共${config.token.length}个账号`, true)
      } else {
        this.reply('账号连接失败', true)
        return false
      }
    }
    await configSave()
  }

  async QRLogin() {
    const match = /^#[Qq]+[Bb]ot登录([0-9]+):([01]):([01])$/i.exec(this.e.msg)
    const matchWebhook = /^#[Qq]+[Bb]ot登录([0-9]+):2$/i.exec(this.e.msg)

    let qqId, param1, param2, isWebhook = false

    if (match) {
      qqId = match[1]
      param1 = match[2]
      param2 = match[3]
    } else if (matchWebhook) {
      qqId = matchWebhook[1]
      param1 = '2'
      param2 = '0'
      isWebhook = true
    } else {
      return this.reply('指令格式错误\n普通模式: #QQBot登录QQ号:参数1:参数2\nWebhook模式: #QQBot登录QQ号:2', true)
    }

    await this.reply(`正在为 QQ ${qqId} 生成扫码登录二维码 (${isWebhook ? 'Webhook模式' : '普通模式'})，请稍候...`, true)

    const tempDir = join(process.cwd(), 'temp')
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }

    try {
      const result = await qrRegister({
        timeoutSeconds: 300,
        onQRCode: async (imageBuffer, url) => {
          const qrFile = join(tempDir, `qqbot_qr_${Date.now()}.gif`)
          fs.writeFileSync(qrFile, imageBuffer)

          logger.info(`[QQBot] 二维码已保存到: ${qrFile}`)
          logger.info(`[QQBot] 二维码链接: ${url}`)

          await this.reply([
            segment.image(imageBuffer),
            `\n请使用手机 QQ 扫描二维码登录\n或打开链接: ${url}\n\n二维码图片已保存到: ${qrFile}`
          ])
        },
        onStatusChange: async (status, message) => {
          if (status === BindStatus.COMPLETED) {
            logger.info(`[QQBot] 扫码成功: ${message}`)
          } else if (status === BindStatus.EXPIRED) {
            logger.info(`[QQBot] 二维码过期: ${message}`)
            await this.reply(`二维码状态: ${message}`)
          } else if (status === BindStatus.PENDING) {
            logger.info(`[QQBot] 等待扫码: ${message}`)
          } else {
            logger.info(`[QQBot] 状态: ${message}`)
          }
        }
      })

      if (!result) {
        return await this.reply('扫码登录失败或超时', true)
      }

      const { appId, clientSecret, userOpenid } = result

      logger.info(`[QQBot] 扫码成功!`)
      logger.info(`[QQBot] AppID: ${appId}`)
      logger.info(`[QQBot] UserOpenID: ${userOpenid}`)

      const token = `${qqId}:${appId}:QQBot:${clientSecret}:${param1}:${param2}`

      const existingIndex = config.token.findIndex(t => t.startsWith(`${qqId}:`))

      if (await adapter.connect(token)) {
        if (existingIndex >= 0) {
          config.token[existingIndex] = token
        } else {
          config.token.push(token)
        }
        await configSave()
        await this.reply(`扫码登录成功！\nQQ号: ${qqId}\nAppID: ${appId}\n账号已保存并连接`, true)
      } else {
        await this.reply(`扫码登录成功，但连接失败\nQQ号: ${qqId}\nAppID: ${appId}\n请检查机器人配置`, true)
      }
    } catch (err) {
      console.error('[QQBot] 扫码登录错误:', err)
      await this.reply(`扫码登录出错: ${err.message}`, true)
    }
  }

  async Markdown() {
    let token = this.e.msg.replace(/^#q+botm(ark)?d(own)?/i, '').trim().split(':')
    const bot_id = token.shift()
    token = token.join(':')
    this.reply(`Bot ${bot_id} Markdown 模板已设置为 ${token}`, true)
    config.markdown[bot_id] = token
    await configSave()
  }

  async Setting() {
    const reg = /^#q+bot设置(.+)\s*(开启|关闭)$/i
    const regRet = reg.exec(this.e.msg)
    const state = regRet[2] == '开启'
    config[setMap[regRet[1]]] = state
    this.reply('设置成功,已' + (state ? '开启' : '关闭'), true)
    await configSave()
  }

  async DAUStat() {
    const pro = this.e.msg.includes('pro')
    const uin = this.e.msg.replace(/^#q+botdau(pro)?/i, '') || this.e.self_id
    const dau = Bot[uin]?.dau
    if (!dau || !dau.dauDB) return false
    const msg = await dau.getDauStatsMsg(this.e, pro)
    if (msg.length) this.reply(msg, true)
  }

  async callStat() {
    if (!config.callStats) {
      return this.reply([
        '调用统计未开启，请先开启后再查看。',
        segment.button([
          { text: '开启调用统计', callback: '#QQBot设置调用统计开启' }
        ])
      ], true)
    }
    const dau = this.e.bot.dau
    if (!dau || !dau.dauDB) {
      return this.reply('DAU 数据库未启用，无法查看调用统计。', true)
    }
    const msg = dau.getCallStatsMsg(this.e)
    if (msg.length) return this.reply(msg, true)
    return this.reply('暂无调用统计数据。', true)
  }

  async userStat() {
    if (!config.userStats) {
      return this.reply([
        '用户统计未开启，请先开启后再查看。',
        segment.button([
          { text: '开启用户统计', callback: '#QQBot设置用户统计开启' }
        ])
      ], true)
    }
    const dau = this.e.bot.dau
    if (!dau || !dau.dauDB) {
      return this.reply('DAU 数据库未启用，无法查看用户统计。', true)
    }
    if (dau.dauDB === 'redis') {
      return this.reply('用户统计只适配 level 数据库，请将 dauDB 设置为 level 后再查看。', true)
    }
    const msg = await dau.getUserStatsMsg(this.e)
    if (msg.length) return this.reply(msg, true)
    return this.reply('暂无用户统计数据。', true)
  }

  async imageBedStat() {
    const raw = this.e.msg.replace(/^#?图床状态/i, '').trim()
    const dayMatch = raw.match(/(\d+)\s*天?/)
    const days = Math.min(Math.max(Number(dayMatch?.[1]) || 1, 1), IMG_BED_STATS_MAX_DAYS)
    const bed = normalizeBed(raw.replace(dayMatch?.[0] || '', '').trim())
    const stats = await getImageBedStats(days, bed)
    const msg = formatImageBedStats(stats)
    const dayText = days === 1 ? '' : ` ${days}天`

    if (!bed && stats.rows.length) {
      const buttons = _.chunk(stats.rows.map(row => ({
        text: `${row.name}详情`,
        callback: `#图床状态 ${row.bed}${dayText}`
      })), 3)
      return this.reply([msg, segment.button(...buttons)], true)
    }

    if (bed) {
      return this.reply([msg, segment.button([{
        text: '全部图床',
        callback: `#图床状态${dayText}`
      }, {
        text: `${getBedName(bed)}详情`,
        callback: `#图床状态 ${bed}${dayText}`
      }])], true)
    }

    await this.reply(msg, true)
  }

  async rawButton() {
    const match = /^#rawButton(\d+)(?::(true|false))?$/i.exec(this.e.msg)
    if (!match) return this.reply('请输入正确的指令\r例：#rawButton285888888:true 或 #rawButton285888888:false', true)

    const botId = match[1]
    const enabled = match[2] !== 'false'
    config.rawButton[botId] = enabled
    await configSave()
    return this.reply(`设置成功，${botId}的rawButton为${enabled}`, true)
  }

  // 自欺欺人大法
  async filterLog() {
    const match = /^#q+bot(添加|删除)过滤日志(.*)/i.exec(this.e.msg)
    let msg = _.trim(match[2]) || ''
    if (!msg) return false

    let isAdd = match[1] === '添加'
    const filterLog = config.filterLog[this.e.self_id] || []
    const has = filterLog.includes(msg)

    if (has && isAdd) return false
    else if (!has && !isAdd) return false
    else if (!has && isAdd) {
      filterLog.push(msg)
      msg = `【${msg}】添加成功， info日志已过滤该消息`
    } else {
      _.pull(filterLog, msg)
      msg = `【${msg}】删除成功， info日志已恢复打印该消息`
    }
    config.filterLog[this.e.self_id] = filterLog
    await configSave()
    this.reply(msg, true)
  }

  async oneKeySendGroupMsg() {
    if (this.e.adapter_name !== 'QQBot') return false
    const msg = await importJS('Model/template/oneKeySendGroupMsg.js', 'default')
    if (msg === false) {
      this.reply('请先设置模版哦', true)
    } else {
      const groupList = this.e.bot.dau.dauDB === 'level' ? Object.keys(this.e.bot.dau.all_group) : [...this.e.bot.gl.keys()]
      const getMsg = typeof msg === 'function' ? msg : () => msg
      const errGroupList = []
      for (const key of groupList) {
        if (key === 'total') continue
        const id = this.e.bot.dau.dauDB === 'level' ? `${this.e.self_id}${this.e.bot.adapter.sep}${key}` : key
        const sendMsg = await getMsg(id)
        if (!sendMsg?.length) continue
        const sendRet = await this.e.bot.pickGroup(id).sendMsg(sendMsg)
        if (sendRet.error.length) {
          for (const i of sendRet.error) {
            if (i.message.includes('机器人非群成员')) {
              errGroupList.push(key)
              break
            }
          }
        }
      }
      if (errGroupList.length) await this.e.bot.dau.deleteNotExistGroup(errGroupList)
      logger.info(logger.green(`QQBot ${this.e.self_id} 群消息一键发送完成，共${groupList.length - 1}个群，失败${errGroupList.length}个`))
    }
  }
}

const endTime = new Date()
logger.info(logger.green(`- QQBot 适配器插件 加载完成! 耗时：${endTime - startTime}ms`))

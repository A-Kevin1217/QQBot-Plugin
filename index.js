import _ from 'lodash'
import fs from 'node:fs'
import QRCode from 'qrcode'
import { join } from 'node:path'
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

const QQBot = await (async () => {
  for (const pkg of ['qq-official-bot', 'qq-group-bot']) {
    try {
      const { Bot } = await import(pkg)
      return Bot
    } catch (e) {}
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

const startTime = new Date()
logger.info(logger.yellow('- 正在加载 QQBot 适配器插件'))

const _sdkVersion = await (async () => {
  for (const pkg of ['qq-official-bot', 'qq-group-bot']) {
    try {
      const { createRequire } = await import('node:module')
      const require = createRequire(import.meta.url)
      const { version } = require(`${pkg}/package.json`)
      return `${pkg} v${version}`
    } catch (e) {}
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
    } catch {}
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
    } catch {}
  }

  async uploadToTelegraph(data, buffer) {
    const api = config.imgBed?.telegraph || 'https://tg.telegra.ph/upload'
    try {
      const form = new FormData()
      form.append('file', new Blob([buffer], { type: 'image/jpeg' }), 'image.jpg')
      const res = await fetch(`${api}?source=bugtracker`, { method: 'POST', body: form })
      const json = await res.json()
      if (json.src) return new URL(api).origin + json.src
    } catch {}
  }

  async uploadToGitcode(data, buffer) {
    try {
      const res = await fetch('https://bot.meml.xyz/api/img/gitcode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64: buffer.toString('base64') })
      })
      const json = await res.json()
      if (json.url) return json.url
    } catch {}
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
    } catch {}
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
    } catch {}
  }

  #detectImageExt(buffer) {
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'jpg'
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'png'
    if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'gif'
    if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'webp'
    return 'jpg'
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
    } catch {}

    const saveCache = async (url) => {
      if (url) {
        try { await redis.set(cacheKey, url, { EX: ttl }) } catch {}
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
      ['gitcode', 'gitcode', true, () => this.uploadToGitcode(data, buffer), true]
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
    return config.imgBed?.default ?? undefined
  }

  async makeMarkdownImage(data, file, summary = '图片') {
    const imageData = !Buffer.isBuffer(file) && file && typeof file === 'object' ? file : {}
    const imageMeta = imageData.data && typeof imageData.data === 'object' ? imageData.data : imageData
    const source = imageMeta.url || imageMeta.file || file
    summary = imageMeta.summary ?? imageData.summary ?? summary

    const buffer = await Bot.Buffer(source)
    const image = await this.makeBotImage(buffer) || {}
    image.width = Number(imageMeta.width) || null
    image.height = Number(imageMeta.height) || null

    if (!image.width || !image.height) {
      try {
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

    if (Handler.has('QQBot.makeMarkdownImage')) {
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
      if (imgBedUrl) image.url = imgBedUrl
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

    if (!image.url?.startsWith?.('http')) image.url = await Bot.fileToUrl(source)

    Bot.makeLog('debug', [`图片URL: ${image.url}`, `来源: ${String(image.url).includes('File/') ? 'fileToUrl(本地服务)' : String(image.url).includes('gchat.qpic.cn') ? 'QQ CDN' : '图床'}`], data.self_id)

    return {
      des: `![${summary} #${image.width || 0}px #${image.height || 0}px]`,
      url: `(${image.url})`
    }
  }

  makeButton(data, button) {
    const msg = {
      id: randomUUID(),
      render_data: {
        label: button.text,
        visited_label: button.clicked_text,
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
          if (i.id.startsWith('event_')) {
            reply = { type: 'reply', event_id: i.id.replace(/^event_/, '') }
          } else {
            reply = i
          }
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
          if (i.id.startsWith('event_')) {
            reply = { type: 'reply', event_id: i.id.replace(/^event_/, '') }
          } else {
            reply = i
          }
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
          if (i.id.startsWith('event_')) {
            reply = { type: 'reply', event_id: i.id.replace(/^event_/, '') }
          } else {
            reply = i
          }
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
    if (!event) event = {}
    if (!event.event_id && data.self_id && data.user_id) {
      const cachedEventId = this.callbackEventCache.get(`${data.self_id}:${data.user_id}`)
      if (cachedEventId) event.event_id = cachedEventId
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
    if (!event) event = {}
    if (!event.event_id && data.self_id && data.group_id) {
      const cachedEventId = this.callbackEventCache.get(`${data.self_id}:${data.group_id}`)
      if (cachedEventId) event.event_id = cachedEventId
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
      const url = `/v2/${target_type}s/${target_id}/messages/${message_id}`
      Bot.makeLog('debug', ['撤回消息', { url, target_type, target_id, message_id }], data.self_id)
      await data.bot.sdk.request.delete(url)
      Bot.makeLog('info', [`撤回${target_type === 'group' ? '群' : '私聊'}文件消息成功`, { target_id, message_id }], data.self_id)
    } catch (err) {
      Bot.makeLog('error', ['撤回消息失败', { target_type, target_id, message_id }, err.message, err.response?.data], data.self_id)
    }
  }

  async uploadFileToQQ(data, target_id, target_type, file_data, file_name, force_chunk = false) {
    if (typeof file_data === 'string' && file_data.startsWith('http') && !force_chunk) {
      let fileSizeMB = 0
      try {
        const headResponse = await fetch(file_data, { method: 'HEAD' })
        const contentLength = headResponse.headers.get('content-length')
        fileSizeMB = contentLength ? parseInt(contentLength) / (1024 * 1024) : 0
        Bot.makeLog('info', [`网络文件大小: ${fileSizeMB.toFixed(2)} MB`], data.self_id)
      } catch (err) {
        Bot.makeLog('debug', ['无法获取文件大小，尝试直传', err.message], data.self_id)
      }

      Bot.makeLog('info', ['检测到网络 URL，使用直传（不下载文件）', { url: file_data.substring(0, 100), file_name }], data.self_id)

      try {
        const filesUrl = `/v2/${target_type}s/${target_id}/files`
        const filesData = {
          file_type: 4,
          srv_send_msg: false,
          url: file_data,
          file_name: file_name || this.extractFileNameFromUrl(file_data)
        }

        Bot.makeLog('debug', ['URL 直传', filesUrl, filesData], data.self_id)

        const { data: result } = await data.bot.sdk.request.post(filesUrl, filesData)

        Bot.makeLog('info', ['URL 直传成功，无需下载文件', result], data.self_id)

        return result
      } catch (error) {
        Bot.makeLog('warn', ['URL 直传失败', error.message, error.response?.data], data.self_id)

        if (fileSizeMB > 10) {
          Bot.makeLog('info', [`文件大于 10MB (${fileSizeMB.toFixed(2)} MB)，降级为分片上传`], data.self_id)
          force_chunk = true
        } else {
          Bot.makeLog('info', [`文件较小 (${fileSizeMB.toFixed(2)} MB)，降级为 base64 上传`], data.self_id)
        }
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
          const buffer = Buffer.from(await response.arrayBuffer())
          Bot.makeLog('info', [`下载完成，大小: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`], data.self_id)
          return buffer
        } else if (file_data.startsWith('base64://')) {
          return Buffer.from(file_data.replace('base64://', ''), 'base64')
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
        name = `file_${timestamp}_${random}${ext || '.bin'}`
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

      const shouldUseChunk = force_chunk || target_type === 'user'

      Bot.makeLog('debug', ['上传方式判断', { force_chunk, target_type, shouldUseChunk, file_size_mb: (file_size / 1024 / 1024).toFixed(2) }], data.self_id)

      if (!shouldUseChunk && target_type === 'group') {
        Bot.makeLog('debug', ['群聊使用 base64 直传', { target_id, file_name, size: file_size }], data.self_id)

        const filesUrl = `/v2/${target_type}s/${target_id}/files`
        const base64Data = fileBuffer.toString('base64')
        const filesData = {
          file_type: 4,
          srv_send_msg: false,
          file_data: base64Data,
          file_name: file_name
        }

        const { data: result } = await data.bot.sdk.request.post(filesUrl, filesData)

        Bot.makeLog('debug', ['群聊 base64 直传成功', result], data.self_id)

        return result
      }

      const md5Hash = crypto.createHash('md5').update(fileBuffer).digest('hex')
      const sha1Hash = crypto.createHash('sha1').update(fileBuffer).digest('hex')
      const MD5_10M_SIZE = 10002432
      const md5_10m = crypto.createHash('md5')
        .update(fileBuffer.slice(0, Math.min(MD5_10M_SIZE, file_size)))
        .digest('hex')

      Bot.makeLog('debug', ['准备分片上传', { target_id, target_type, file_name, file_size }], data.self_id)

      const { data: prepareResult } = await data.bot.sdk.request.post(`/v2/${target_type}s/${target_id}/upload_prepare`, {
        file_type: 4,
        file_name,
        file_size,
        md5: md5Hash,
        sha1: sha1Hash,
        md5_10m
      })

      const { upload_id, parts } = prepareResult

      for (const part of parts) {
        const { index, presigned_url } = part
        const start = (index - 1) * prepareResult.block_size
        const end = Math.min(start + prepareResult.block_size, file_size)
        const partBuffer = fileBuffer.slice(start, end)

        await fetch(presigned_url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': partBuffer.length },
          body: partBuffer
        })

        await data.bot.sdk.request.post(`/v2/${target_type}s/${target_id}/upload_part_finish`, {
          upload_id,
          part_index: index,
          block_size: partBuffer.length,
          md5: crypto.createHash('md5').update(partBuffer).digest('hex')
        })
      }

      const { data: filesResult } = await data.bot.sdk.request.post(`/v2/${target_type}s/${target_id}/files`, {
        upload_id,
        srv_send_msg: false
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
          if (i.id.startsWith('event_')) {
            reply = { type: 'reply', event_id: i.id.replace(/^event_/, '') }
          } else {
            reply = i
          }
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

  async recallMsg(data, recall, message_id) {
    if (!Array.isArray(message_id)) message_id = [message_id]
    const msgs = []
    for (const i of message_id) {
      try {
        msgs.push(await recall(i))
      } catch (err) {
        Bot.makeLog('debug', ['撤回消息错误', i, err], data.self_id)
        msgs.push(false)
      }
    }
    return msgs
  }

  recallFriendMsg(data, message_id) {
    Bot.makeLog('info', `撤回好友消息：[${data.user_id}] ${message_id}`, data.self_id)
    return this.recallMsg(data, i => data.bot.sdk.recallFriendMessage(data.user_id, i), message_id)
  }

  recallGroupMsg(data, message_id) {
    Bot.makeLog('info', `撤回群消息：[${data.group_id}] ${message_id}`, data.self_id)
    return this.recallMsg(data, i => data.bot.sdk.recallGroupMessage(data.group_id, i), message_id)
  }

  recallDirectMsg(data, message_id, hide = config.hideGuildRecall) {
    Bot.makeLog('info', `撤回${hide ? '并隐藏' : ''}频道私聊消息：[${data.guild_id}] ${message_id}`, data.self_id)
    return this.recallMsg(data, i => data.bot.sdk.recallDirectMessage(data.guild_id, i, hide), message_id)
  }

  recallGuildMsg(data, message_id, hide = config.hideGuildRecall) {
    Bot.makeLog('info', `撤回${hide ? '并隐藏' : ''}频道消息：[${data.channel_id}] ${message_id}`, data.self_id)
    return this.recallMsg(data, i => data.bot.sdk.recallGuildMessage(data.channel_id, i, hide), message_id)
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
    if (config.toQQUin && userIdCache[user_id]) {
      user_id = userIdCache[user_id]
    }
    if (user_id.startsWith('qg_')) { return this.pickGuildMember(id, group_id, user_id) }
    const i = {
      ...Bot[id].fl.get(user_id),
      ...Bot[id].gml.get(group_id)?.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(`${id}${this.sep}`, ''),
      group_id: group_id.replace(`${id}${this.sep}`, ''),
      platform: 'QQ-group-member'
    }
    return {
      ...this.pickFriend(id, user_id),
      ...i
    }
  }

  pickGroup(id, group_id) {
    if (group_id.startsWith?.('qg_')) { return this.pickGuild(id, group_id) }
    const i = {
      ...Bot[id].gl.get(group_id),
      self_id: id,
      bot: Bot[id],
      group_id: group_id.replace?.(`${id}${this.sep}`, '') || group_id,
      platform: 'QQ-group'
    }
    return {
      ...i,
      sendMsg: (msg, event) => this.sendGroupMsg(i, msg, event),
      pickMember: user_id => this.pickMember(id, group_id, user_id),
      recallMsg: message_id => this.recallGroupMsg(i, message_id),
      getMemberMap: () => i.bot.gml.get(group_id)
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
    data.sender = {
      user_id: `${data.self_id}${this.sep}${event.sender.user_id}`,
      raw_user_id: event.sender.user_id,
      bot: event.author?.bot || user?.bot || false,
      nickname: event.sender.user_name || user?.nickname || '',
      avatar: `https://q.qlogo.cn/qqapp/${data.bot.info.appid}/${event.sender.user_id}/0`,
      unionid: event.author?.union_openid || user?.unionid || '',
      openid: event.sender?.user_id || user?.openid || '',
      role: event.author?.member_role
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
    await data.bot.gl.set(data.group_id, {
      ...data.bot.gl.get(data.group_id),
      group_id: data.group_id
    })
    let gml = data.bot.gml.get(data.group_id)
    if (!gml) {
      gml = new Map()
      await data.bot.gml.set(data.group_id, gml)
    }
    await gml.set(data.user_id, {
      ...gml.get(data.user_id),
      ...data.sender
    })
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
      message_id: event.message_id,
      get unionid() { return this.sender.unionid },
      get openid() { return this.sender.openid },
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
    Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
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
    const interactionEventId = event.notice_id?.startsWith?.('INTERACTION_CREATE:')
      ? event.notice_id
      : `INTERACTION_CREATE:${event.notice_id}`

    const data = {
      event_id: event.event_id,
      raw: event,
      raw_event: event.raw,
      bot: Bot[id],
      self_id: id,
      post_type: 'message',
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
      msg.unshift({ type: 'reply', event_id: interactionEventId })
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
          { event_id: interactionEventId }
        )
        await this.setFriendMap(data)
        break
      case 'group':
        data.group_id = `${id}${this.sep}${event.group_id}`
        Bot.makeLog('info', [`群按钮点击事件：[${data.group_id}, ${data.user_id}]`, data.raw_message], data.self_id)
        data.reply = msg => this.sendGroupMsg(
          { ...data, group_id: event.group_id },
          wrapWithEventId(msg),
          { event_id: interactionEventId }
        )
        await this.setGroupMap(data)
        this.callbackEventCache.set(`${id}:${event.group_id}`, interactionEventId)
        this.callbackEventCache.set(`${id}:${event.operator_id}`, interactionEventId)
        setTimeout(() => {
          this.callbackEventCache.delete(`${id}:${event.group_id}`)
          this.callbackEventCache.delete(`${id}:${event.operator_id}`)
        }, 5 * 60 * 1000)
        break
      case 'guild':
        break
      default:
        Bot.makeLog('warn', ['未知按钮点击事件', event], data.self_id)
    }

    Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  makeNotice(id, event) {
    const data = {
      event_id: event.event_id,
      raw: event,
      raw_event: event.raw,
      bot: Bot[id],
      self_id: id,
      post_type: event.post_type,
      notice_type: event.notice_type,
      sub_type: event.sub_type,
      notice_id: event.notice_id,
      group_id: event.group_id,
      user_id: event.user_id || event.operator_id,
      raw_group_id: event.group_id,
      raw_user_id: event.user_id || event.operator_id,
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
      data.reply = msg => this.sendGroupMsg({
        ...data,
        group_id: event.group_id
      }, msg, { event_id: data.event_id })
    }

    switch (data.sub_type) {
      case 'action':
        return this.makeCallback(id, event)
      case 'increase':
        Bot[data.self_id].dau.setDau('group_increase', data)
        if (event.notice_type === 'group') {
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
        Bot[data.self_id].dau.setDau('group_decrease', data)
      case 'update':
      case 'member.increase':
      case 'member.decrease':
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

    Bot.em(`${data.post_type}.${data.notice_type}.${data.sub_type}`, data)
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

  async connect(token) {
    token = token.split(':')
    const id = token[0]
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

    if (Number(token[4])) opts.intents.push('GROUP_AND_C2C_EVENT')

    if (Number(token[5])) opts.intents.push('GUILD_MESSAGES')
    else opts.intents.push('PUBLIC_GUILD_MESSAGES')

    const sdk = new QQBot(opts)
    disableAxiosEnvProxy(sdk.request)

    {
      const StreamInputMode = { REPLACE: 'replace' }
      const StreamInputState = { GENERATING: 1, DONE: 10 }
      const StreamContentType = { MARKDOWN: 'markdown' }

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

      async function sendStreamMessage(sdk, endpointPath, message, source, options) {
        let content = extractText(message)
        if (!content || typeof content !== 'string') throw new Error('流式消息内容必须是字符串')
        const chunkSize = options.chunkSize || Math.ceil(content.length / 2)
        const delay = options.delay || 100
        let streamMsgId = null
        let index = 0
        let currentContent = ''
        for (let i = 0; i < content.length; i += chunkSize) {
          const chunk = content.substring(i, i + chunkSize)
          currentContent += chunk
          const req = {
            input_mode: StreamInputMode.REPLACE,
            input_state: i + chunkSize >= content.length ? StreamInputState.DONE : StreamInputState.GENERATING,
            content_type: StreamContentType.MARKDOWN,
            content_raw: currentContent,
            event_id: source?.event_id || `event_${Date.now()}`,
            msg_id: source?.id || `msg_${Date.now()}`,
            index: index++
          }
          if (streamMsgId) req.stream_msg_id = streamMsgId
          const response = await sdk.request.post(`${endpointPath}/stream_messages`, req)
          if (!streamMsgId && response.data?.id) streamMsgId = response.data.id
          if (i + chunkSize < content.length) await new Promise(r => setTimeout(r, delay))
        }
        return { id: streamMsgId, content: currentContent }
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

      const origSend = sdk.messageService.sendMessage.bind(sdk.messageService)
      sdk.messageService.sendMessage = async function (endpointPath, message, source, options) {
        const origRegular = this.sendRegularMessage.bind(this)
        this.sendRegularMessage = async function (ep, buildResult, opts) {
          if (source?.smallbtn && buildResult.messagePayload?.keyboard?.content) {
            buildResult.messagePayload.keyboard.content.style = { font_size: 'small' }
          }
          try {
            return await origRegular(ep, buildResult, opts)
          } catch (e) {
            const code = e.message?.match(/code\((\d+)\)/)?.[1]
            if (buildResult.messagePayload && ['22007', '40034128', '40034105'].includes(code)) {
              logger.warn(`被动回复失败(code(${code}))，正在尝试通过主动消息发送`)
              delete buildResult.messagePayload.msg_id
              delete buildResult.messagePayload.event_id
              return await origRegular(ep, buildResult, opts)
            }
            throw e
          }
        }
        try { return await origSend(endpointPath, message, source, options) }
        finally { this.sendRegularMessage = origRegular }
      }

      const { createRequire } = await import('node:module')
      const _require = createRequire(import.meta.url)
      const { MessageBuilder } = _require('qq-official-bot/lib/message/builder.js')
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
        return await this.sendRegularMessage(endpointPath, buildResult)
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

      callback: {}
    }

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
      const id = this.appid[appid].uin
      const { t, d } = req.body

      if (t === 'GROUP_MEMBER_ADD' || t === 'GROUP_MEMBER_REMOVE') {
        const sub_type = t === 'GROUP_MEMBER_ADD' ? 'increase' : 'decrease'
        Bot.makeLog('debug', [`群成员${sub_type === 'increase' ? '加入' : '离开'}事件`, d], id)
        this.makeNotice(id, {
          event_id: req.body.id,
          notice_type: 'group',
          sub_type,
          notice_id: req.body.id,
          group_id: d.group_openid,
          user_id: d.member_openid,
          time: d.timestamp,
          raw: req.body,
        })
      } else {
        this.appid[appid].sdk.dispatchEvent(t, req.body)
      }
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
    if (!config.callStats) return false
    const dau = this.e.bot.dau
    if (!dau || !dau.dauDB) return false
    const msg = dau.getCallStatsMsg(this.e)
    if (msg.length) this.reply(msg, true)
  }

  async userStat() {
    if (!config.userStats) return false
    const dau = this.e.bot.dau
    if (!dau || !dau.dauDB) return false
    if (dau.dauDB === 'redis') {
      return this.reply('用户统计只适配了level,,,', true)
    }
    const msg = await dau.getUserStatsMsg(this.e)
    if (msg.length) this.reply(msg, true)
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

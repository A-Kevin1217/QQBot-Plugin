import makeConfig from '../../../lib/plugins/config.js'
import YAML from 'yaml'
import fs from 'node:fs'

let { config, configSave } = await makeConfig('QQBot', {
  tips: '',
  permission: 'master',
  toQRCode: false,
  toCallback: false,
  toBotUpload: true,
  hideGuildRecall: false,
  toQQUin: false,
  toImg: true,
  callStats: false,
  userStats: false,
  markdown: {},
  sendButton: true,
  customMD: {},
  mdSuffix: {},
  btnSuffix: {},
  rawButton: {},
  filterLog: {},
  filter_bot_msg: true,
  filter_only_at_other_bot: false,
  simplifiedSdkLog: false,
  autoInputNotify: false,
  imageLength: 3,
  markdownImgScale: 1.0,
  stream: false,
  chunkSize: 2,
  delay: 100,
  smallbtn: false,
  sep: '',
  dauDB: 'redis',
  imgBed: {
    enable: true,
    custom: { enable: false },
    cnb: {
      enable: false,
      baseUrl: 'https://api.cnb.cool',
      token: '',
      defaultRepo: '',
      autodelete: 30,
      stats: true
    },
    bilibili: { enable: false, cookie: '' },
    huaban: { enable: false, cookie: '' },
    cos: {
      enable: false,
      createUploadKeyUrl: 'https://ci-exhibition.cloud.tencent.com/samples/createUploadKey',
      cosBucketUrlPrefix: ''
    },
    qqchannel: { enable: false, botQQ: '', channelId: '' },
    telegraph: { enable: true, api: 'https://telegra.ph/upload' },
    tencentci: { enable: true },
    default: '',
    cache_ttl: 600
  },
  mediaCache: {
    enable: true,
    autoDownload: false,
    // 你的 Yunzai 服务对外公网地址，如 https://bot.example.com（自动拼接 /QQBot/media/ 路径）
    baseUrl: '',
    saveDays: 3,
    maxSize: 10
  },
  bot: {
    sandbox: false,
    maxRetry: Infinity,
    timeout: 30000
  },
  token: []
}, {
  tips: [
    '欢迎使用 TRSS-Yunzai QQBot Plugin ! 作者：时雨🌌星空 & 小叶 & 小丞 & 霆生',
    '参考：https://github.com/A-Kevin1217/QQBot-Plugin'
  ]
})

function refConfig () {
  config = YAML.parse(fs.readFileSync('config/QQBot.yaml', 'utf-8'))
}

// ===== 旧配置自动迁移 =====
// 把 imgBed 各图床统一为 { enable, ... } 对象结构，兼容旧的字符串写法，
// 并补齐 custom / tencentci / mediaCache 默认结构。幂等：已是新结构则不做任何改动。
{
  let dirty = false
  const imgBed = config.imgBed || (config.imgBed = {})

  // 自定义图床（默认关闭）
  if (typeof imgBed.custom !== 'object' || imgBed.custom === null) {
    imgBed.custom = { enable: false }
    dirty = true
  }

  // 把某个图床归一化为对象，旧字符串形式转为 { enable, 字段 } 结构
  const asBed = (key, legacyField, defaultValue = '') => {
    const value = imgBed[key]
    if (typeof value === 'string') {
      imgBed[key] = { enable: Boolean(value), ...(legacyField ? { [legacyField]: value || defaultValue } : {}) }
      dirty = true
    } else if (value == null || typeof value !== 'object') {
      imgBed[key] = {}
      dirty = true
    }
    return imgBed[key]
  }

  const bilibili = asBed('bilibili', 'cookie')
  if (bilibili.cookie === undefined) { bilibili.cookie = ''; dirty = true }
  if (bilibili.enable === undefined) { bilibili.enable = Boolean(bilibili.cookie); dirty = true }

  const huaban = asBed('huaban', 'cookie')
  if (huaban.cookie === undefined) { huaban.cookie = ''; dirty = true }
  if (huaban.enable === undefined) { huaban.enable = Boolean(huaban.cookie); dirty = true }

  const telegraph = asBed('telegraph', 'api', 'https://telegra.ph/upload')
  if (telegraph.api === undefined) { telegraph.api = 'https://telegra.ph/upload'; dirty = true }
  if (telegraph.enable === undefined) { telegraph.enable = Boolean(telegraph.api); dirty = true }

  const cos = asBed('cos')
  if (cos.createUploadKeyUrl === undefined) { cos.createUploadKeyUrl = 'https://ci-exhibition.cloud.tencent.com/samples/createUploadKey'; dirty = true }
  if (cos.cosBucketUrlPrefix === undefined) { cos.cosBucketUrlPrefix = ''; dirty = true }
  if (cos.enable === undefined) { cos.enable = Boolean(cos.createUploadKeyUrl && cos.cosBucketUrlPrefix); dirty = true }

  const qqchannel = asBed('qqchannel')
  if (qqchannel.botQQ === undefined) { qqchannel.botQQ = ''; dirty = true }
  if (qqchannel.channelId === undefined) { qqchannel.channelId = ''; dirty = true }
  if (qqchannel.enable === undefined) { qqchannel.enable = Boolean(qqchannel.botQQ && qqchannel.channelId); dirty = true }

  const tencentci = asBed('tencentci')
  if (tencentci.enable === undefined) { tencentci.enable = true; dirty = true }

  // mediaCache 默认结构
  if (config.mediaCache == null || typeof config.mediaCache !== 'object') {
    config.mediaCache = {}
    dirty = true
  }
  for (const [key, value] of Object.entries({ enable: true, autoDownload: false, baseUrl: '', saveDays: 3, maxSize: 10 })) {
    if (config.mediaCache[key] === undefined) {
      config.mediaCache[key] = value
      dirty = true
    }
  }

  if (dirty) await configSave()
}

export {
  config,
  configSave,
  refConfig
}

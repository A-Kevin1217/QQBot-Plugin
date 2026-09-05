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
// 只处理 makeConfig 的 _.merge 深合并无法覆盖的旧结构：bilibili/huaban/telegraph
// 历史上是字符串写法，需转成 { enable, cookie/api } 对象（旧字符串非空即视为启用）。
// 其余新键（custom/tencentci/mediaCache 及各 enable 开关、字段）由 makeConfig
// 自动从默认值补全并落盘，此处无需处理。幂等：无字符串旧值则不做任何改动。
{
  let dirty = false
  const imgBed = config.imgBed || (config.imgBed = {})

  const migrateStringBed = (key, field, defaultValue = '') => {
    const value = imgBed[key]
    if (typeof value === 'string') {
      imgBed[key] = { enable: Boolean(value), [field]: value || defaultValue }
      dirty = true
    }
  }

  migrateStringBed('bilibili', 'cookie')
  migrateStringBed('huaban', 'cookie')
  migrateStringBed('telegraph', 'api', 'https://telegra.ph/upload')

  if (dirty) await configSave()
}

export {
  config,
  configSave,
  refConfig
}

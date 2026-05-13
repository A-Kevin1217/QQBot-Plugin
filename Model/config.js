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
  markdown: {
    template: 'abcdefghij'
  },
  sendButton: true,
  customMD: {},
  mdSuffix: {},
  btnSuffix: {},
  filterLog: {},
  filter_bot_msg: true,
  simplifiedSdkLog: false,
  markdownImgScale: 1.0,
  stream: true,
  smallbtn: false,
  sep: '',
  dauDB: 'redis',
  imgBed: {
    cos: { createUploadKeyUrl: 'https://ci-exhibition.cloud.tencent.com/samples/createUploadKey', cosBucketUrlPrefix: '' },
    qqchannel: { botQQ: '', channelId: '' },
    bilibili: '',
    huaban: '',
    telegraph: 'https://tg.telegra.ph/upload',
    default: '',
    cache_ttl: 600
  },
  bot: {
    sandbox: false,
    maxRetry: Infinity,
    timeout: 30000
  },
  token: []
}, {
  tips: [
    '欢迎使用 TRSS-Yunzai QQBot Plugin ! 作者：时雨🌌星空 & 小叶 & 小丞',
    '参考：https://github.com/A-Kevin1217/QQBot-Plugin'
  ]
})

function refConfig () {
  config = YAML.parse(fs.readFileSync('config/QQBot.yaml', 'utf-8'))
}

export {
  config,
  configSave,
  refConfig
}

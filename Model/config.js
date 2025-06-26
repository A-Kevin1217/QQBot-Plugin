import makeConfig from '../../../lib/plugins/config.js'
import YAML from 'yaml'
import fs from 'node:fs'

let { config, configSave } = await makeConfig('QQBot', {
  tips: '',
  permission: 'master',
  toQRCode: true,
  toCallback: true,
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
  btnTemplate: {},
  filterLog: {},
  simplifiedSdkLog: false,
  markdownImgScale: 1.0,
  sep: '',
  dauDB: 'redis',
  // dau: {
  //   enable: true,
  //   user_count: true,  // 上行消息人数
  //   group_count: true, // 上行消息群数
  //   msg_count: true,      // 上行消息量
  //   send_count: true,     // 下行消息量
  //   all_user_count: true, // 所有用户数
  //   all_group_count: true, // 所有群组数
  //   group_increase_count: true, // 新增群数量
  //   group_decrease_count: true, // 减少群数量
  // 新增用户数量
  // 消息数量最多的用户
  // 消息数量最多的群聊
  // 昨日数据
  // 平均数据
  // },
  bot: {
    sandbox: false,
    maxRetry: Infinity,
    timeout: 30000
  },
  token: []
}, {
  tips: [
    '欢迎使用 TRSS-Yunzai QQBot Plugin ! 作者：时雨🌌星空 & 小叶 & 小丞',
    '参考：https://github.com/A-Kevin1217/Yunzai-QQBot-Plugin'
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

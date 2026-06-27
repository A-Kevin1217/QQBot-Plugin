import { config, configSave, refConfig } from './Model/config.js'
import YAML from 'yaml'

const get = (obj, field) => {
  return field.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj)
}

const set = (obj, field, value) => {
  const keys = field.split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {}
    cur = cur[keys[i]]
  }
  cur[keys[keys.length - 1]] = value
  return obj
}

export function supportGuoba() {
  return {
    pluginInfo: {
      name: 'QQBot-Plugin',
      title: 'QQBot-Plugin',
      author: '时雨🌌星空 & 小叶 & 小丞 & 霆生',
      authorLink: 'https://github.com/A-Kevin1217/QQBot-Plugin',
      link: 'https://github.com/A-Kevin1217/QQBot-Plugin',
      isV3: true,
      isV2: false,
      description: 'TRSS-Yunzai QQBot 适配器插件，支持 QQ 开放平台功能',
      icon: 'mdi:robot',
      iconColor: '#12B7F5',
    },
    configInfo: {
      schemas,
      getConfigData() {
        // 重新读取最新配置
        try { refConfig() } catch (e) {}
        const c = { ...config }

        // 将对象类型的字段序列化为 JSON 字符串，供 Input 组件显示
        const jsonFields = ['filterLog']
        for (const f of jsonFields) {
          if (c[f] && typeof c[f] === 'object') {
            try {
              c[f] = JSON.stringify(c[f], null, 2)
            } catch {}
          }
        }

        // markdown: { bot_id: template_id } → [{ botId, templateId }]
        const markdownRows = []
        if (c.markdown && typeof c.markdown === 'object') {
          for (const [botId, templateId] of Object.entries(c.markdown)) {
            markdownRows.push({ botId, templateId: String(templateId || '') })
          }
        }
        c.markdown = markdownRows

        // customMD: { bot_id: { custom_template_id, keys } } → [{ botId, customTemplateId, keys }]
        const customMDRows = []
        if (c.customMD && typeof c.customMD === 'object') {
          for (const [botId, cfg] of Object.entries(c.customMD)) {
            if (!cfg || typeof cfg !== 'object') continue
            customMDRows.push({
              botId,
              customTemplateId: cfg.custom_template_id || '',
              keys: Array.isArray(cfg.keys) ? cfg.keys.join(', ') : ''
            })
          }
        }
        c.customMD = customMDRows

        // rawButton: { bot_id: true/false } → [{ botId, enabled }]
        const rawButtonRows = []
        if (c.rawButton && typeof c.rawButton === 'object') {
          for (const [botId, enabled] of Object.entries(c.rawButton)) {
            rawButtonRows.push({ botId, enabled: !!enabled })
          }
        }
        c.rawButton = rawButtonRows

        // bot.sandbox 作为 Switch 需要布尔值，确保类型正确
        if (c.bot && typeof c.bot === 'object') {
          c.bot = { ...c.bot }
        }

        // mdSuffix: { bot_id: [{ key, values }] } → [{ botId, value }]
        const mdSuffixRows = []
        if (c.mdSuffix && typeof c.mdSuffix === 'object') {
          for (const [botId, items] of Object.entries(c.mdSuffix)) {
            if (!Array.isArray(items)) continue
            for (const item of items) {
              const val = Array.isArray(item.values) ? (item.values[0] || '') : ''
              mdSuffixRows.push({ botId, value: val })
            }
          }
        }
        c.mdSuffix = mdSuffixRows

        // btnSuffix: { bot_id: { position, values } } → [{ botId, position, text, type, data }]
        const btnSuffixRows = []
        if (c.btnSuffix && typeof c.btnSuffix === 'object') {
          for (const [botId, botBtnCfg] of Object.entries(c.btnSuffix)) {
            const pos = botBtnCfg.position || 1
            const values = Array.isArray(botBtnCfg.values) ? botBtnCfg.values : []
            for (const btn of values) {
              btnSuffixRows.push({
                botId,
                position: pos,
                text: btn.text || '',
                type: btn.type || btn.callback ? 'callback' : btn.link ? 'link' : 'input',
                data: btn.callback || btn.link || btn.input || '',
              })
            }
          }
        }
        c.btnSuffix = btnSuffixRows

        return c
      },
      setConfigData(data, { Result }) {
        try {
          // 复制当前配置作为基础
          const merged = { ...config }

          // 将 JSON 字符串字段还原为对象
          const jsonFields = ['filterLog']
          for (const f of jsonFields) {
            if (typeof data[f] === 'string' && data[f].trim()) {
              try {
                data[f] = JSON.parse(data[f])
              } catch {
                return Result.error(`${f} 的 JSON 格式不正确，请检查`)
              }
            } else if (!data[f] || (typeof data[f] === 'string' && !data[f].trim())) {
              data[f] = {}
            }
          }

          // markdown: [{ botId, templateId }] → { bot_id: template_id }
          const markdownData = Array.isArray(data.markdown) ? data.markdown : []
          const markdown = {}
          for (const row of markdownData) {
            const botId = String(row.botId || '').trim()
            if (!botId) continue
            markdown[botId] = String(row.templateId || 'raw')
          }
          data.markdown = markdown

          // customMD: [{ botId, customTemplateId, keys }] → { bot_id: { custom_template_id, keys } }
          const customMDData = Array.isArray(data.customMD) ? data.customMD : []
          const customMD = {}
          for (const row of customMDData) {
            const botId = String(row.botId || '').trim()
            if (!botId) continue
            customMD[botId] = {
              custom_template_id: String(row.customTemplateId || ''),
              keys: String(row.keys || '').split(/[,，]/).map(s => s.trim()).filter(Boolean)
            }
          }
          data.customMD = customMD

          // rawButton: [{ botId, enabled }] → { bot_id: true/false }
          const rawButtonData = Array.isArray(data.rawButton) ? data.rawButton : []
          const rawButton = {}
          for (const row of rawButtonData) {
            const botId = String(row.botId || '').trim()
            if (!botId) continue
            rawButton[botId] = !!row.enabled
          }
          data.rawButton = rawButton

          // 遍历所有 schema 中的字段，从 data 中提取并写入（跳过 GSubForm 字段）
          for (const schema of schemas) {
            if (!schema.field) continue
            if (schema.field === 'mdSuffix' || schema.field === 'btnSuffix' || schema.field === 'markdown' || schema.field === 'customMD' || schema.field === 'rawButton') continue
            const value = get(data, schema.field)
            if (value !== undefined) set(merged, schema.field, value)
          }

          // mdSuffix: [{ botId, value }] → { bot_id: [{ key, values }] }
          const mdSuffixData = Array.isArray(data.mdSuffix) ? data.mdSuffix : []
          const mdSuffix = {}
          let mdKeyIdx = 0
          for (const row of mdSuffixData) {
            const botId = String(row.botId || '').trim()
            const value = String(row.value || '')
            if (!botId || !value) continue
            if (!mdSuffix[botId]) mdSuffix[botId] = []
            mdSuffix[botId].push({ key: `suffix_${mdKeyIdx++}`, values: [value] })
          }
          merged.mdSuffix = mdSuffix

          // btnSuffix: [{ botId, position, text, type, data }] → { bot_id: { position, values } }
          const btnSuffixData = Array.isArray(data.btnSuffix) ? data.btnSuffix : []
          const btnSuffix = {}
          for (const row of btnSuffixData) {
            const botId = String(row.botId || '').trim()
            if (!botId) continue
            if (!btnSuffix[botId]) {
              btnSuffix[botId] = { position: row.position || 1, values: [] }
            }
            const btn = { text: row.text || '' }
            if (row.type === 'callback') btn.callback = row.data || ''
            else if (row.type === 'link') btn.link = row.data || ''
            else btn.input = row.data || ''
            btnSuffix[botId].values.push(btn)
          }
          merged.btnSuffix = btnSuffix

          // 回写到 config 对象
          for (const key of Object.keys(merged)) {
            config[key] = merged[key]
          }

          configSave()
          return Result.ok({}, '保存成功~')
        } catch (error) {
          logger.error(`[QQBot-Plugin] 保存配置失败: ${error.message}`)
          return Result.error(error.message || '保存失败')
        }
      },
    },
  }
}

const schemas = [
  // ========== 基本设置 ==========
  { label: '基本设置', component: 'SOFT_GROUP_BEGIN' },
  {
    field: 'permission',
    label: '权限等级',
    bottomHelpMessage: '可使用管理命令的最低权限',
    component: 'Select',
    componentProps: {
      options: [
        { label: '主人', value: 'master' },
        { label: '管理员', value: 'admin' },
        { label: '所有人', value: 'all' },
      ],
    },
  },
  {
    field: 'filter_bot_msg',
    label: '过滤机器人消息',
    bottomHelpMessage: '是否忽略其他机器人的消息',
    component: 'Switch',
  },
  {
    field: 'filter_only_at_other_bot',
    label: '仅过滤@其他机器人',
    bottomHelpMessage: '开启后仅当@其他机器人时过滤',
    component: 'Switch',
  },
  {
    field: 'simplifiedSdkLog',
    label: '简化SDK日志',
    bottomHelpMessage: '是否简化 SDK 日志输出',
    component: 'Switch',
  },
  {
    field: 'autoInputNotify',
    label: '自动输入通知',
    bottomHelpMessage: '收到事件回调时自动输入通知',
    component: 'Switch',
  },

  // ========== 消息处理 ==========
  { label: '消息处理', component: 'SOFT_GROUP_BEGIN' },
  {
    field: 'toQRCode',
    label: '链接转二维码',
    bottomHelpMessage: '开启后消息中的链接会转为二维码。如需自定义匹配正则，请直接编辑 config/QQBot.yaml',
    component: 'Switch',
  },
  {
    field: 'toCallback',
    label: '命令转回调',
    bottomHelpMessage: '将命令消息转为回调事件',
    component: 'Switch',
  },
  {
    field: 'toBotUpload',
    label: '使用Bot上传',
    bottomHelpMessage: '是否使用 Bot 接口上传文件/图片',
    component: 'Switch',
  },
  {
    field: 'toQQUin',
    label: '转换QQ号',
    bottomHelpMessage: '是否将消息中的QQ号进行转换',
    component: 'Switch',
  },
  {
    field: 'toImg',
    label: '消息转图片',
    bottomHelpMessage: '是否将文字消息转为图片发送',
    component: 'Switch',
  },
  {
    field: 'hideGuildRecall',
    label: '隐藏频道撤回',
    bottomHelpMessage: '是否隐藏频道中的撤回消息',
    component: 'Switch',
  },
  {
    field: 'imageLength',
    label: '图片压缩阈值(MB)',
    bottomHelpMessage: '超过此大小的图片会被压缩，0 为不压缩',
    component: 'InputNumber',
    componentProps: { min: 0, max: 20, step: 0.5 },
  },

  // ========== Markdown 设置 ==========
  { label: 'Markdown 设置', component: 'SOFT_GROUP_BEGIN' },
  {
    field: 'markdown',
    label: 'Markdown 模板',
    bottomHelpMessage: '为每个机器人设置 markdown 模板 ID，raw 表示使用原生 markdown',
    component: 'GSubForm',
    componentProps: {
      multiple: true,
      schemas: [
        {
          field: 'botId',
          label: 'Bot ID',
          required: true,
          component: 'Input',
          componentProps: { placeholder: '机器人的 self_id / appid' },
        },
        {
          field: 'templateId',
          label: '模板 ID',
          required: true,
          component: 'Input',
          componentProps: { placeholder: '模板ID 或 raw（原生markdown）' },
        },
      ],
    },
  },
  {
    field: 'sendButton',
    label: '发送按钮',
    bottomHelpMessage: '是否在 markdown 消息中附加按钮',
    component: 'Switch',
  },
  {
    field: 'customMD',
    label: '自定义模板配置',
    bottomHelpMessage: '自定义 markdown 模板的 custom_template_id 和 keys',
    component: 'GSubForm',
    componentProps: {
      multiple: true,
      schemas: [
        {
          field: 'botId',
          label: 'Bot ID',
          required: true,
          component: 'Input',
          componentProps: { placeholder: '机器人的 self_id / appid' },
        },
        {
          field: 'customTemplateId',
          label: '模板 ID',
          required: true,
          component: 'Input',
          componentProps: { placeholder: 'custom_template_id' },
        },
        {
          field: 'keys',
          label: '模板 Keys',
          bottomHelpMessage: '用逗号分隔多个 key',
          component: 'Input',
          componentProps: { placeholder: 'key1, key2, key3' },
        },
      ],
    },
  },
  {
    field: 'rawButton',
    label: '使用原始按钮',
    bottomHelpMessage: 'per self_id 是否使用原始按钮格式',
    component: 'GSubForm',
    componentProps: {
      multiple: true,
      schemas: [
        {
          field: 'botId',
          label: 'Bot ID',
          required: true,
          component: 'Input',
          componentProps: { placeholder: '机器人的 self_id / appid' },
        },
        {
          field: 'enabled',
          label: '启用原始按钮',
          component: 'Switch',
        },
      ],
    },
  },
  {
    field: 'markdownImgScale',
    label: 'Markdown 图片缩放',
    bottomHelpMessage: 'Markdown 消息中图片的缩放比例',
    component: 'InputNumber',
    componentProps: { min: 0.1, max: 3.0, step: 0.1 },
  },
  {
    field: 'smallbtn',
    label: '小按钮模式',
    bottomHelpMessage: '是否使用小尺寸按钮',
    component: 'Switch',
  },
  {
    field: 'sep',
    label: 'ID 分隔符',
    bottomHelpMessage: '自定义 ID 分隔符，留空使用默认',
    component: 'Input',
    componentProps: { placeholder: '默认为冒号(:)' },
  },

  // ========== 小尾巴设置 ==========
  { label: '小尾巴设置', component: 'SOFT_GROUP_BEGIN' },
  {
    field: 'mdSuffix',
    label: 'Markdown 文本小尾巴',
    bottomHelpMessage: '在每条消息末尾追加文本。Bot ID 填 appid（如 123456789）。内容支持变量：{{e.bot?.nickname}} 机器人昵称、{{e.group?.name}} 群名、{{e.user_id}} 发送者QQ。多条按顺序换行拼接。',
    component: 'GSubForm',
    componentProps: {
      multiple: true,
      schemas: [
        {
          field: 'botId',
          label: 'Bot ID',
          required: true,
          component: 'Input',
          componentProps: { placeholder: '机器人的 appid，如 123456789' },
        },
        {
          field: 'value',
          label: '小尾巴内容',
          required: true,
          component: 'Input',
          componentProps: {
            type: 'textarea',
            rows: 3,
            placeholder: '每行一条，支持模板变量，例如：\n---\n来自 {{e.bot?.nickname}}\n当前群：{{e.group?.name}}',
          },
        },
      ],
    },
  },
  {
    field: 'btnSuffix',
    label: '按钮小尾巴',
    bottomHelpMessage: '在 Markdown 消息的按钮列表中插入自定义按钮。位置从 1 开始计数。',
    component: 'GSubForm',
    componentProps: {
      multiple: true,
      schemas: [
        {
          field: 'botId',
          label: 'Bot ID',
          required: true,
          component: 'Input',
          componentProps: { placeholder: '机器人的 QQ号' },
        },
        {
          field: 'position',
          label: '插入位置',
          required: true,
          component: 'InputNumber',
          componentProps: { min: 1, max: 5 },
        },
        {
          field: 'text',
          label: '按钮文字',
          required: true,
          component: 'Input',
          componentProps: { placeholder: '显示的文字' },
        },
        {
          field: 'type',
          label: '按钮类型',
          component: 'Select',
          componentProps: {
            options: [
              { label: '回调按钮', value: 'callback' },
              { label: '链接按钮', value: 'link' },
              { label: '输入按钮', value: 'input' },
            ],
          },
        },
        {
          field: 'data',
          label: '按钮数据',
          bottomHelpMessage: '回调按钮填命令，链接按钮填 URL，输入按钮填输入内容',
          component: 'Input',
          componentProps: { placeholder: '回调命令 / 链接地址 / 输入内容' },
        },
      ],
    },
  },

  // ========== 统计设置 ==========
  { label: '统计设置', component: 'SOFT_GROUP_BEGIN' },
  {
    field: 'callStats',
    label: '调用统计',
    bottomHelpMessage: '是否开启命令调用次数统计',
    component: 'Switch',
  },
  {
    field: 'userStats',
    label: '用户统计',
    bottomHelpMessage: '是否开启用户活跃统计',
    component: 'Switch',
  },
  {
    field: 'dauDB',
    label: 'DAU 数据库',
    bottomHelpMessage: '存储 DAU 统计数据的方式',
    component: 'Select',
    componentProps: {
      options: [
        { label: 'Redis', value: 'redis' },
        { label: 'SQLite', value: 'sqlite' },
        { label: 'JSON', value: 'json' },
      ],
    },
  },

  // ========== 图床设置 ==========
  { label: '图床设置', component: 'SOFT_GROUP_BEGIN' },
  {
    field: 'imgBed.enable',
    label: '启用图床',
    bottomHelpMessage: '是否启用图床上传功能',
    component: 'Switch',
  },
  {
    field: 'imgBed.default',
    label: '兜底返回图',
    bottomHelpMessage: '默认使用的图床类型',
    component: 'Select',
    componentProps: {
      options: [
        { label: '自动', value: '' },
        { label: 'QQ频道', value: 'qqchannel' },
        { label: 'B站', value: 'bilibili' },
        { label: '花瓣', value: 'huaban' },
        { label: 'Telegraph', value: 'telegraph' },
        { label: 'CNB', value: 'cnb' },
      ],
    },
  },
  {
    field: 'imgBed.cache_ttl',
    label: '图片缓存时间(秒)',
    bottomHelpMessage: '图片缓存的有效时间',
    component: 'InputNumber',
    componentProps: { min: 60, max: 86400 },
  },
  {
    field: 'imgBed.bilibili',
    label: 'B站 Cookie',
    bottomHelpMessage: 'B站图床使用的 Cookie',
    component: 'InputPassword',
  },
  {
    field: 'imgBed.huaban',
    label: '花瓣 Token',
    bottomHelpMessage: '花瓣图床使用的 Token',
    component: 'InputPassword',
  },
  {
    field: 'imgBed.telegraph',
    label: 'Telegraph 地址',
    bottomHelpMessage: 'Telegraph 上传接口地址',
    component: 'Input',
    componentProps: { placeholder: 'https://tg.telegra.ph/upload' },
  },

  // ========== CNB 图床 ==========
  { label: 'CNB 图床', component: 'SOFT_GROUP_BEGIN' },
  {
    field: 'imgBed.cnb.enable',
    label: '启用 CNB',
    bottomHelpMessage: '是否启用 CNB（cnb.cool）图床',
    component: 'Switch',
  },
  {
    field: 'imgBed.cnb.baseUrl',
    label: 'CNB API 地址',
    bottomHelpMessage: 'CNB API 基础地址',
    component: 'Input',
    componentProps: { placeholder: 'https://api.cnb.cool' },
  },
  {
    field: 'imgBed.cnb.token',
    label: 'CNB Token',
    bottomHelpMessage: 'CNB 访问令牌',
    component: 'InputPassword',
  },
  {
    field: 'imgBed.cnb.defaultRepo',
    label: 'CNB 默认仓库',
    bottomHelpMessage: 'CNB 默认上传仓库，格式为 owner/repo',
    component: 'Input',
    componentProps: { placeholder: 'owner/repo' },
  },
  {
    field: 'imgBed.cnb.autodelete',
    label: '自动删除天数',
    bottomHelpMessage: 'CNB 上传图片自动删除天数，0 为不删除',
    component: 'InputNumber',
    componentProps: { min: 0, max: 365 },
  },
  {
    field: 'imgBed.cnb.stats',
    label: 'CNB 统计',
    bottomHelpMessage: '是否开启 CNB 图床使用统计',
    component: 'Switch',
  },

  // ========== QQ频道图床 ==========
  { label: 'QQ频道图床', component: 'SOFT_GROUP_BEGIN' },
  {
    field: 'imgBed.qqchannel.botQQ',
    label: 'Bot QQ号',
    bottomHelpMessage: '用于 QQ 频道图床的 Bot QQ号',
    component: 'Input',
    componentProps: { placeholder: 'Bot 的 QQ 号' },
  },
  {
    field: 'imgBed.qqchannel.channelId',
    label: '频道 ID',
    bottomHelpMessage: '用于上传图片的 QQ 频道 ID',
    component: 'Input',
    componentProps: { placeholder: '频道 ID' },
  },

  // ========== COS 图床 ==========
  { label: '腾讯云 COS', component: 'SOFT_GROUP_BEGIN' },
  {
    field: 'imgBed.cos.createUploadKeyUrl',
    label: '上传密钥接口',
    bottomHelpMessage: '获取 COS 临时上传密钥的接口地址',
    component: 'Input',
    componentProps: { placeholder: 'https://ci-exhibition.cloud.tencent.com/samples/createUploadKey' },
  },
  {
    field: 'imgBed.cos.cosBucketUrlPrefix',
    label: 'COS Bucket 前缀',
    bottomHelpMessage: 'COS Bucket URL 前缀',
    component: 'Input',
    componentProps: { placeholder: 'https://xxx.cos.ap-xxx.myqcloud.com' },
  },

  // ========== 流式消息 ==========
  { label: '流式消息', component: 'SOFT_GROUP_BEGIN' },
  {
    field: 'stream',
    label: '启用流式消息',
    bottomHelpMessage: '是否使用流式（stream）方式发送消息',
    component: 'Switch',
  },
  {
    field: 'chunkSize',
    label: '分块大小',
    bottomHelpMessage: '流式消息每块的大小',
    component: 'InputNumber',
    componentProps: { min: 1, max: 20 },
  },
  {
    field: 'delay',
    label: '分块延迟(ms)',
    bottomHelpMessage: '流式消息每块之间的延迟时间',
    component: 'InputNumber',
    componentProps: { min: 0, max: 5000 },
  },

  // ========== Bot 设置 ==========
  { label: 'Bot 设置', component: 'SOFT_GROUP_BEGIN' },
  {
    field: 'bot.sandbox',
    label: '沙箱模式',
    bottomHelpMessage: '是否使用 QQ Bot 沙箱环境',
    component: 'Switch',
  },
  {
    field: 'bot.maxRetry',
    label: '最大重试次数',
    bottomHelpMessage: '发送消息失败后的最大重试次数',
    component: 'InputNumber',
    componentProps: { min: 0, max: 100 },
  },
  {
    field: 'bot.timeout',
    label: '超时时间(ms)',
    bottomHelpMessage: 'Bot 请求的超时时间',
    component: 'InputNumber',
    componentProps: { min: 5000, max: 120000 },
  },

  // ========== 日志过滤 ==========
  { label: '日志过滤', component: 'SOFT_GROUP_BEGIN' },
  {
    field: 'filterLog',
    label: '日志过滤规则',
    bottomHelpMessage: '按关键字过滤日志输出，key 为日志级别，value 为关键字数组',
    component: 'Input',
    componentProps: {
      type: 'textarea',
      rows: 3,
      placeholder: '{"info": ["关键字1"], "debug": ["关键字2"]}',
    },
  },
]

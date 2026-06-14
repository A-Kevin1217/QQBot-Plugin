<div align="center">

# TRSS-Yunzai QQBot Plugin

TRSS-Yunzai QQBot 适配器 插件

</div>

# Tip

建议使用TRSS原版,此版本为`个人自用`版,会在`任意时间`直接进行更改,且`不会`与TRSS一致

## 分支选择

两个分支命令、配置、用法完全一样，只是底层依赖版本不同：

| 使用上区别 | `main` 分支 | `sdk-1.0.3` 分支 |
| --- | --- | --- |
| 底层依赖 | `qq-official-bot@1.2.2` | `qq-official-bot@1.0.3` |
| 安装/更新依赖 | 第一次拉取后要 `pnpm install` | 跟着老版本走，不用动 |
| 收/发普通消息 | 正常 | 正常 |
| 收/发 Markdown / 按钮 | 已适配 | 已稳定使用 |
| 文件、图片、语音上传 | 已适配 | 已稳定使用 |

> **跟官方新版同步用 `main`**（推荐）；**云崽依赖锁死在 1.0.3 时再切 `sdk-1.0.3`**

### 切换分支方法

在 Yunzai 根目录下执行（以切到 `sdk-1.0.3` 为例）：

```bash
cd plugins/QQBot-Plugin
git fetch origin
git checkout sdk-1.0.3      # 切回主分支：git checkout main
git pull
cd ../..
pnpm install                # 让依赖版本对上
```

> 切换分支后**必须**执行一次 `pnpm install`，否则底层 SDK 版本和适配器代码不一致会出问题

## 自用Fork版

1. 转发消息改为渲染成图片,需要安装`ws-plugin`
2. `#QQBot设置转换开启`配合`#ws绑定`实现互通数据
3. `#QQBotDAU` and `#QQBotDAUpro`
4. `Model/template/groupIncreaseMsg_default.js`中`自定义入群发送主动消息`
5. `config/QQBot.yaml`中使用以下自定义模版,如果设置了全局md会优先使用自定义模版,配合`e.toQQBotMD = true`将特定消息`转换`成md,亦可在`全局md模式下`通过`e.toQQBotMD = false`将特定消息`不转换`成md
   - 方法1: 直接修改`config/QQBot.yaml` **(推荐)**
     ```yml
     customMD:
       BotQQ:
         custom_template_id: 模版id
         keys:
           - key1 # 对应的模版key名字
           - key2
           # ... 最多10个
     ```
   - 方法2: 在`Model/template`目录下新建`markdownTemplate.js`文件,写入以下内容 **(不推荐)**
     ```js
     // params为数组,每一项为{key:string,values: ['\u200B']} // values固定为['\u200B']
     export defalut {
       custom_template_id: '',
       params: []
     }
     ```
6. `#QQBot调用统计` 根据`e.reply()`发送的消息进行统计,每条消息仅统计一次,未做持久化处理,默认关闭,`#QQBot设置调用统计开启`
7. `config/QQBot.yaml`中使用以下配置项,在`全局MD`时会`以MD的模式`自动加入`params`中
   ```yml
   mdSuffix:
     BotQQ:
       - key: key1
         values:
           - value # 如果用到了key则不会添加
       - key: key2
         values:
           # \ 需转义 \\
           - "{{ e.msg.replace(/^#/g, '\\/') }}" # {{}}中为动态参数,会在发送时替换成对应值,目前仅有e可用,也可以传入js表达式等等, 后续可能会添加自定义方法
       # ...
   ```
8. `config/QQBot.yaml`中使用以下配置项,在`全局MD`时会`以button的模式`自动加入`按钮指定行数并独占一行`,当`超过`5排按钮时`不会添加`
   ```yml
   btnSuffix:
     BotQQ:
       position: 1 # 位置:第几行 1 - 5
       values:
         - text: test
           callback: test
           show: # 达成什么条件才会显示
             type: random # 目前仅支持 random
             data: 50 # 0-100
         - text: test2
           input: test2
         # ... 最多10个
   ```
9. `#QQBot用户统计`: 对比昨日的用户数据,默认关闭,`#QQBot设置用户统计开启`
10. `config/QQBot.yaml`中使用前台日志消息过滤（~~自欺欺人大法~~），将会不在前台打印自定的消息内容，防log刷屏（~~比如修仙、宝可梦等~~），也可以使用`#QQBot添加/删除过滤日志垃圾机器人`
    - **自定义消息采取完整消息匹配，非关键词匹配**
    - **非必要不建议开启此项**
      > 注意：_只会过滤部分QQBot的日志_
    ```yml
    filterLog:
      BotQQ:
        - 垃圾机器人
        - 垃圾bot
        - 垃圾Bot
        # ...
    ```
11. `config/QQBot.yaml`中`simplifiedSdkLog`是否简化sdk日志,若设置为`true`则不会打印` recv from Group(xxx):  xxx`,并且会简化发送为`send to Group(xxx): <markdown><button>`
12. `config/QQBot.yaml`中`autoInputNotify: false`是否自动显示输入状态(正在输入...),开启后收到消息时会自动显示输入状态30秒
13. `#QQBot一键群发`: 需要先配置模版 `template/oneKeySendGroupMsg_default.js`
14. `config/QQBot.yaml`中`markdownImgScale: 1`是否对markdown中的图片进行等比例缩放,0.5为缩小50%,1.5为放大50%,以此类推
15. `config/QQBot.yaml`中`sendButton: true`未开启全局MD时是否单独发送按钮
16. `config/QQBot.yaml`中`dauDB: level`选择存储dau数据的数据库,可选: `level`, `redis`,以及`false`关闭dau统计(仅每日发言用户和群)
17. `config/QQBot.yaml`中`imgBed`图床配置,当Bot上传图片失败时自动使用图床上传,支持多个图床回退,Redis缓存默认10分钟
    ```yml
    imgBed:
      enable: true # 总图床开关
      cnb:
        enable: true
        baseUrl: https://api.cnb.cool
        token: '' # CNB Access Token
        defaultRepo: QingYingX-Bot/Image # CNB 仓库路径
        autodelete: 30 # 自动删除时间,单位秒,0为不自动删除
        stats: true
      bilibili: '' # B站cookie,包含bili_jct和SESSDATA
      huaban: '' # 花瓣网cookie
      cos: # 腾讯COS图床(无需cookie)
        createUploadKeyUrl: https://ci-exhibition.cloud.tencent.com/samples/createUploadKey
        cosBucketUrlPrefix: https://your-bucket.cos.ap-chengdu.myqcloud.com/ # 替换为你的COS存储桶地址
      qqchannel: # QQ频道图床(需要有频道权限的Bot)
        botQQ: '123456' # 机器人QQ号
        channelId: '611441080' # 频道ID
      telegraph: https://tg.telegra.ph/upload # Telegraph上传API
      default: '' # 所有图床失败时的备用图片URL
      cache_ttl: 600 # Redis缓存过期时间(秒)
    ```
    - 未配置的图床会自动跳过,无需删除
    - 图床回退顺序: CNB → B站 → 花瓣网 → COS → QQ频道 → Telegraph → gitcode备用 → 默认图片
    - `#图床状态`: 查看统计周期内使用过的全部图床,默认1天
    - `#图床状态7天`: 查看全部图床7天统计
    - 总览消息会附带各图床详情按钮,例如 `CNB详情`
    - `#图床状态 cnb`: 只查看CNB图床详情
    - `#图床状态 cnb 7天`: 只查看CNB图床7天统计
    - `level`
      - 优点: 统计了大部分数据
      - 缺点: 缓存存一份,level存一份
    - `redis`
      - 优点: 大部分使用redis存储,不会缓存
      - 缺点: 没有缓存所以有些没统计

## 安装教程

1. 准备：[TRSS-Yunzai](../../../Yunzai)
2. 输入：`#安装QQBot-Plugin`
3. 打开：[QQ 开放平台](https://q.qq.com) 创建 Bot：  
① 创建机器人  
② 开发设置 → 得到 `机器人QQ号:AppID:Token:AppSecret`  
4. 输入：`#QQBot设置机器人QQ号:AppID:Token:AppSecret:[012]:[01]`

## 格式示例

- 机器人QQ号 `114` AppID `514` Token `1919` AppSecret `810` 群Bot 频道私域

```
#QQBot设置114:514:1919:810:1:1
```

- WebHook

```
#QQBot设置114:514:1919:810:2
```

公网 HTTPS 反代 url/QQBot 填入开放平台

## 使用教程

- #QQBot账号
- #QQBot设置 + `机器人QQ号:AppID:Token:AppSecret:是否群Bot:是否频道私域`（是1 否0）
- #QQBotMD + `机器人QQ号:raw`（默认使用raw模式，设置模板ID可切换为模板模式）
- #图床状态 / #图床状态7天 / #图床状态 cnb

/**
 * qq-official-bot@1.3.0 增强层
 *
 * 背景（对齐旧版 Gitee 分支 ts-yf/QQBot-Plugin 的 sdkEnhancer.js + offlineDetect）：
 * SDK 1.3.0 的 Auth 只在令牌到期前定时刷新，刷新连续失败 3 次后
 * `scheduleTokenRefreshRetry()` 会把 refreshTimer 置空并彻底放弃；此后
 * `sessionManager.access_token` 一直返回那个过期令牌，所有 REST 调用都会拿到
 * `code(11244) AccessToken无效或过期`，而 WebSocket 仍然连着 ——
 * 表现就是「机器人在线、发不出消息，只能重启」。
 *
 * 这里补两件事：
 *   1. installTokenRefreshRetry —— 响应拦截器捕获 11244/401，强制刷新令牌后重发一次；
 *   2. installOfflineWatchdog  —— 定时体检 WebSocket，SDK 自己没救回来时强制重连。
 */
import { getQQApiErrorCode } from './richMediaUpload.js'

/** 平台返回的「令牌无效/过期」错误码 */
const TOKEN_INVALID_CODES = new Set(['11244'])

/** 掉线看门狗体检间隔 */
const OFFLINE_CHECK_INTERVAL_MS = 60_000
/** 连续多少次体检不健康才动手（避免打断 SDK 自己的重连退避） */
const OFFLINE_STALE_THRESHOLD = 2
/** 最多连续强制重连多少次后放弃（成功后自动归零） */
const OFFLINE_MAX_RETRIES = 5

const WS_OPEN = 1

function headerValue(headers, name) {
  if (!headers) return undefined
  if (typeof headers.get === 'function') return headers.get(name)
  const key = Object.keys(headers).find(item => item.toLowerCase() === name.toLowerCase())
  return key ? headers[key] : undefined
}

function isTokenInvalidError(error) {
  if (TOKEN_INVALID_CODES.has(getQQApiErrorCode(error))) return true
  return Number(error?.response?.status) === 401
}

/**
 * 令牌失效自动刷新重试。
 *
 * 必须把拦截器插到 SDK 自带响应拦截器**前面**：SDK 那个拦截器会把 axios 错误
 * 重新包成一个普通 Error（丢掉 config/response），排到它后面就拿不到重发所需的 config。
 * axios 的响应链按注册顺序执行，所以这里直接 unshift 进 handlers。
 *
 * @returns {boolean} 是否安装成功
 */
export function installTokenRefreshRetry(sdk, { log } = {}) {
  const manager = sdk?.request?.interceptors?.response
  const auth = sdk?.sessionManager?.authManager
  if (!Array.isArray(manager?.handlers) || typeof auth?.refreshAccessToken !== 'function') {
    log?.('warn', 'SDK 响应拦截器或 authManager 不可用，跳过令牌自动刷新重试')
    return false
  }

  // 同一时刻多个请求一起报 11244 时，只发一次刷新请求
  let refreshing = null
  const refreshOnce = () => {
    if (!refreshing) {
      refreshing = Promise.resolve()
        .then(() => auth.refreshAccessToken())
        .finally(() => { refreshing = null })
    }
    return refreshing
  }

  manager.handlers.unshift({
    fulfilled: undefined,
    rejected: async (error) => {
      const config = error?.config
      const multipart = String(headerValue(config?.headers, 'Content-Type') || '').includes('multipart/form-data')
      if (!config || config.__qqbotTokenRetried || multipart || !isTokenInvalidError(error)) {
        return Promise.reject(error)
      }

      const code = getQQApiErrorCode(error) || error?.response?.status || 'unknown'
      const target = `${String(config.method || 'get').toUpperCase()} ${config.url || ''}`
      log?.('warn', `访问令牌失效(code=${code})，刷新令牌后重发：${target}`)
      try {
        await refreshOnce()
        config.__qqbotTokenRetried = true
        const result = await sdk.request(config)
        log?.('mark', `令牌刷新后重发成功：${target}`)
        return result
      } catch (retryError) {
        log?.('error', `令牌刷新后重发仍失败：${target} — ${retryError?.message || retryError}`)
        return Promise.reject(error)
      }
    },
    synchronous: false,
    runWhen: null
  })

  return true
}

/**
 * 掉线看门狗：定时确认 WebSocket 真的还活着，SDK 救不回来时强制重连。
 *
 * 强制重连前会先把旧 socket 的监听全摘掉，否则它的 close 事件会让 SDK 再重连一次，
 * 变成两条连接互相打架。
 *
 * @returns {{timer: *, stopped: boolean}|null} 句柄，交给 stopOfflineWatchdog 停用
 */
export function installOfflineWatchdog(sdk, { log } = {}) {
  const session = sdk?.sessionManager
  const receiver = session?.receiver
  if (!session || !receiver || typeof receiver.connect !== 'function') {
    log?.('warn', 'SDK 接收器不可用，跳过掉线看门狗')
    return null
  }

  const state = { timer: null, stopped: false, staleCount: 0, retries: 0, reconnecting: false }

  const isAlive = () => {
    const ws = receiver.handler?.ws
    return receiver.isClosed !== true && ws?.readyState === WS_OPEN
  }

  const dropSocket = () => {
    const old = receiver.handler?.ws
    if (!old) return
    try { old.removeAllListeners?.() } catch { /* 忽略 */ }
    try {
      if (typeof old.terminate === 'function') old.terminate()
      else old.close?.()
    } catch { /* 忽略 */ }
    receiver.handler.ws = null
  }

  const reconnect = async () => {
    state.retries += 1
    state.reconnecting = true
    try {
      log?.('warn', `掉线看门狗：强制重连（第 ${state.retries}/${OFFLINE_MAX_RETRIES} 次）`)
      dropSocket()
      receiver.clearTimers?.()
      receiver.retryCount = 0
      receiver.isReconnect = false
      receiver.isClosed = true
      // 顺手把可能已过期的令牌刷新掉，免得刚连上又被 11244 打回
      try {
        await session.authManager?.refreshAccessToken?.()
      } catch (error) {
        log?.('warn', `掉线看门狗：重连前刷新令牌失败（忽略）— ${error?.message || error}`)
      }
      await receiver.connect()
      log?.('mark', '掉线看门狗：重连已发起，等待 READY')
    } catch (error) {
      log?.('error', `掉线看门狗：重连失败（第 ${state.retries} 次）— ${error?.message || error}`)
    } finally {
      state.reconnecting = false
    }
  }

  state.timer = setInterval(async () => {
    if (state.stopped || state.reconnecting || session.userClose) return
    if (isAlive()) {
      state.staleCount = 0
      state.retries = 0
      return
    }
    state.staleCount += 1
    log?.('warn', `掉线看门狗：WebSocket 未就绪（连续第 ${state.staleCount}/${OFFLINE_STALE_THRESHOLD} 次体检）`)
    if (state.staleCount < OFFLINE_STALE_THRESHOLD) return
    state.staleCount = 0
    if (state.retries >= OFFLINE_MAX_RETRIES) {
      log?.('error', `掉线看门狗：已连续重连 ${OFFLINE_MAX_RETRIES} 次仍未恢复，停止重试，请手动检查`)
      return
    }
    await reconnect()
  }, OFFLINE_CHECK_INTERVAL_MS)
  state.timer.unref?.()

  return state
}

export function stopOfflineWatchdog(state) {
  if (!state) return
  state.stopped = true
  if (state.timer) clearInterval(state.timer)
  state.timer = null
}

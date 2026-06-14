const WS_STATE = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']
const WS_OPEN = 1

export function patchSessionManager(sessionManager) {
  if (!sessionManager || sessionManager.__yunzaiSafeSendWs) return
  sessionManager.__yunzaiSafeSendWs = true
  sessionManager.sendWs = function sendWsSafely(msg) {
    const ws = this.bot?.ws
    if (!ws || ws.readyState !== WS_OPEN) {
      const state = WS_STATE[ws?.readyState] || String(ws?.readyState ?? 'unknown')
      this.bot?.logger?.debug?.(`[CLIENT] WebSocket 未就绪(${state})，跳过发送`)
      return false
    }

    try {
      ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg))
      return true
    } catch (error) {
      this.bot?.logger?.warn?.(`[CLIENT] WebSocket 发送失败：${error?.message || error}`)
      return false
    }
  }
}

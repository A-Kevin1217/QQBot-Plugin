/**
 * 一键群发消息的模版
 */

/**
* 请注意，系统不会读取oneKeySendGroupMsg_default.js ！！！！
* 【请勿直接修改此文件，且可能导致后续冲突】
*
* 如需自定义可将文件【复制】一份，并重命名为 oneKeySendGroupMsg.js
 */

/**
 * 随你写什么逻辑
 * 只要保证最后导出的是一个 **要发送的消息的数组** 就行
 */

/**
 * 可选一: 直接导出msg
 */
// export default []

/**
 * 可选二: 传入参数group_id,然后返回msg
 * @param {string} group_id 本次发送的群号
 * @returns {Array} msg
 */
export default async function (group_id) {
  // 需要导出msg
  return []
}

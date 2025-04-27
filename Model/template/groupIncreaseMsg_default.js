/**
 * 用于被邀请入群后发送一条主动消息
 */

/**
* 请注意，系统不会读取groupIncreaseMsg_default.js ！！！！
* 【请勿直接修改此文件，且可能导致后续冲突】
*
* 如需自定义可将文件【复制】一份，并重命名为 groupIncreaseMsg.js
 */

/**
 * 随你写什么逻辑
 * 只要保证最后导出的是一个 **要发送的消息的数组** 就行
 */

/**
 * 需要发送的消息
 */
const msg = []

/**
 * 可选一: 直接导出msg
 */
// export default msg

/**
 * 可选二: 传入参数group_id和user_id,然后返回msg
 * @param {string} group_id 被拉入的群
 * @param {string} user_id 邀请入群的用户
 * @param {string} self_id 机器人账号
 * @returns {Array} msg
 */
export default async function (group_id, user_id, self_id) {
  // 需要导出msg
  return msg
}

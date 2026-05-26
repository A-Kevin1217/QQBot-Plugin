/**
 * QQBot 扫码授权模块
 * 
 * 实现二维码登录流程：
 * 1. 创建绑定任务
 * 2. 生成二维码
 * 3. 轮询扫码结果
 * 4. 解密凭证
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'
import fetch from 'node-fetch'

// API 端点
const PORTAL_HOST = process.env.QQ_PORTAL_HOST || 'q.qq.com'
const ONBOARD_CREATE_PATH = '/lite/create_bind_task'
const ONBOARD_POLL_PATH = '/lite/poll_bind_result'
const QR_URL_TEMPLATE = 'https://q.qq.com/qqbot/openclaw/connect.html?task_id={task_id}&_wv=2&source=yunzai'

// 轮询配置
const ONBOARD_POLL_INTERVAL = 2000  // 2秒
const ONBOARD_API_TIMEOUT = 10000   // 10秒
const MAX_REFRESHES = 3             // 最大刷新次数

/**
 * 生成 256 位 AES 密钥
 * @returns {string} Base64 编码的密钥
 */
function generateBindKey() {
  return crypto.randomBytes(32).toString('base64')
}

/**
 * 解密 AES-256-GCM 加密的密文
 * @param {string} encryptedBase64 - Base64 编码的密文
 * @param {string} keyBase64 - Base64 编码的密钥
 * @returns {string} 解密后的明文
 */
function decryptSecret(encryptedBase64, keyBase64) {
  const key = Buffer.from(keyBase64, 'base64')
  const raw = Buffer.from(encryptedBase64, 'base64')
  
  // 提取 IV (12字节) + 密文 + AuthTag (16字节)
  const iv = raw.subarray(0, 12)
  const ciphertext = raw.subarray(12)
  
  // AES-256-GCM 解密
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  const authTag = ciphertext.subarray(ciphertext.length - 16)
  const encryptedData = ciphertext.subarray(0, ciphertext.length - 16)
  
  decipher.setAuthTag(authTag)
  let decrypted = decipher.update(encryptedData)
  decrypted = Buffer.concat([decrypted, decipher.final()])
  
  return decrypted.toString('utf-8')
}

/**
 * 创建绑定任务
 * @returns {Promise<{taskId: string, key: string}>}
 */
async function createBindTask() {
  const url = `https://${PORTAL_HOST}${ONBOARD_CREATE_PATH}`
  const key = generateBindKey()
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'QQBotAdapter/Yunzai (Node.js)'
    },
    body: JSON.stringify({ key }),
    timeout: ONBOARD_API_TIMEOUT
  })
  
  const data = await response.json()
  
  if (data.retcode !== 0) {
    throw new Error(data.msg || '创建绑定任务失败')
  }
  
  const taskId = data.data?.task_id
  if (!taskId) {
    throw new Error('创建绑定任务失败：响应缺少 task_id')
  }
  
  return { taskId, key }
}

/**
 * 轮询绑定结果
 * @param {string} taskId - 任务 ID
 * @returns {Promise<{status: number, botAppid: string, botEncryptSecret: string, userOpenid: string}>}
 */
async function pollBindResult(taskId) {
  const url = `https://${PORTAL_HOST}${ONBOARD_POLL_PATH}`
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'QQBotAdapter/Yunzai (Node.js)'
    },
    body: JSON.stringify({ task_id: taskId }),
    timeout: ONBOARD_API_TIMEOUT
  })
  
  const data = await response.json()
  
  if (data.retcode !== 0) {
    throw new Error(data.msg || '轮询绑定结果失败')
  }
  
  const d = data.data || {}
  return {
    status: d.status || 0,
    botAppid: String(d.bot_appid || ''),
    botEncryptSecret: d.bot_encrypt_secret || '',
    userOpenid: d.user_openid || ''
  }
}

/**
 * 生成二维码 URL
 * @param {string} taskId - 任务 ID
 * @returns {string}
 */
function buildConnectUrl(taskId) {
  return QR_URL_TEMPLATE.replace('{task_id}', encodeURIComponent(taskId))
}

/**
 * 生成二维码图片
 * @param {string} url - 要编码的 URL
 * @returns {Promise<Buffer>} 图片 Buffer (GIF 或 PNG)
 */
async function generateQRCode(url) {
  try {
    // 优先使用项目自带的 qr.js 库生成 GIF
    const { encodeQR } = await import('./qr.js')
    const gifData = encodeQR(url, 'byte', 'medium', { scale: 8, border: 4 })
    return Buffer.from(gifData)
  } catch (err) {
    // 如果 qr.js 失败，尝试使用 qrcode 库
    try {
      const QRCode = await import('qrcode')
      return await QRCode.toBuffer(url, {
        type: 'png',
        width: 300,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      })
    } catch (err2) {
      throw new Error(`生成二维码失败: ${err.message}`)
    }
  }
}

/**
 * 在终端显示二维码
 * @param {string} url - 要编码的 URL
 */
async function displayQRCodeInTerminal(url) {
  try {
    // 使用项目自带的 qr.js 库生成终端二维码
    const { encodeQR } = await import('./qr.js')
    const bitmap = encodeQR(url, 'byte', 'medium')
    const ascii = bitmap.toASCII()
    logger.info("\n\n" + ascii)
  } catch (err) {
    // 如果 qr.js 失败，尝试使用 qrcode 库
    try {
      const QRCode = await import('qrcode')
      const qrString = await QRCode.toString(url, { type: 'terminal', small: true })
      logger.info(qrString)
    } catch (err2) {
      logger.info('[QQBot] 终端二维码显示失败，请使用链接')
    }
  }
}

/**
 * 状态码枚举
 */
const BindStatus = {
  NONE: 0,
  PENDING: 1,
  COMPLETED: 2,
  EXPIRED: 3
}

/**
 * 执行扫码授权流程
 * @param {Object} options - 配置选项
 * @param {number} options.timeoutSeconds - 超时时间（秒），默认 600
 * @param {Function} options.onQRCode - 二维码生成回调 (imageBuffer, url)
 * @param {Function} options.onStatusChange - 状态变化回调 (status, message)
 * @returns {Promise<{appId: string, clientSecret: string, userOpenid: string} | null>}
 */
async function qrRegister(options = {}) {
  const {
    timeoutSeconds = 600,
    onQRCode = null,
    onStatusChange = null
  } = options
  
  const deadline = Date.now() + timeoutSeconds * 1000
  
  for (let refreshCount = 0; refreshCount <= MAX_REFRESHES; refreshCount++) {
    try {
      // 1. 创建绑定任务
      const { taskId, key } = await createBindTask()
      const url = buildConnectUrl(taskId)
      
      // 2. 生成二维码
      const qrBuffer = await generateQRCode(url)
      
      // 3. 回调通知
      if (onQRCode) {
        await onQRCode(qrBuffer, url)
      }
      
      // 4. 终端显示
      await displayQRCodeInTerminal(url)
      
      if (onStatusChange) {
        await onStatusChange(BindStatus.PENDING, '请使用手机 QQ 扫描二维码')
      }
      
      // 5. 轮询循环
      while (Date.now() < deadline) {
        try {
          const result = await pollBindResult(taskId)
          
          if (result.status === BindStatus.COMPLETED) {
            // 解密凭证
            const clientSecret = decryptSecret(result.botEncryptSecret, key)
            
            if (onStatusChange) {
              await onStatusChange(BindStatus.COMPLETED, '扫码成功！')
            }
            
            return {
              appId: result.botAppid,
              clientSecret,
              userOpenid: result.userOpenid
            }
          }
          
          if (result.status === BindStatus.EXPIRED) {
            if (refreshCount >= MAX_REFRESHES) {
              if (onStatusChange) {
                await onStatusChange(BindStatus.EXPIRED, '二维码已过期，刷新次数已达上限')
              }
              return null
            }
            
            if (onStatusChange) {
              await onStatusChange(BindStatus.EXPIRED, `二维码已过期，正在刷新... (${refreshCount + 1}/${MAX_REFRESHES})`)
            }
            break // 跳出轮询循环，刷新二维码
          }
          
          // 继续等待
          await new Promise(resolve => setTimeout(resolve, ONBOARD_POLL_INTERVAL))
        } catch (err) {
          // 轮询出错，继续重试
          await new Promise(resolve => setTimeout(resolve, ONBOARD_POLL_INTERVAL))
        }
      }
    } catch (err) {
      if (onStatusChange) {
        await onStatusChange(BindStatus.NONE, `创建任务失败: ${err.message}`)
      }
      return null
    }
  }
  
  if (onStatusChange) {
    await onStatusChange(BindStatus.NONE, '扫码授权超时')
  }
  return null
}

export {
  qrRegister,
  generateQRCode,
  buildConnectUrl,
  BindStatus
}

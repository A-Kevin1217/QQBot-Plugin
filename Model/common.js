import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { ulid } from 'ulid'
import moment from 'moment'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
export const pluginPath = join(__dirname, '..')
export const yunzaiPath = join(pluginPath, '../..')

/**
 * 获得指定日期的日期字符串
 * @param {number} day 相较于今天的日期天数，正数表示未来日期，负数表示过去日期
 * @returns yyyy-mm-dd
 */
function getTime (day = 0) {
  const now = new Date()
  now.setHours(now.getHours() + 8)
  if (day != 0) now.setDate(now.getDate() + day)
  return now.toISOString().split('T').shift()
}

/**
 * 动态导入js文件
 * @param {string} path plusins/QQBot-Plugin/之后的路径
 * @param {string} funcOrVarName 指定要导入的函数或变量名
 * @returns 导入的函数或变量
 */
async function importJS (path, funcOrVarName) {
  try {
    const module = await import('file://' + join(pluginPath, path))
    return funcOrVarName ? module[funcOrVarName] : module
  } catch (error) {
    return false
  }
}

/**
 * 分割MD模版参数
 * @param {*} text 需要分割的字符串
 * @returns 分割后的数组
 */
function splitMarkDownTemplate (text) {
  const rand = ulid()
  const regexList = [
    /(!?\[.*?\])(\s*\(.*?\))/g,
    /(\[.*?\])(\[.*?\])/g,
    /(\*)([^*]+?\*)/g,
    /(`)([^`]+?`)/g,
    /(_)([^_]*?_)/g,
    /(~)(~)/g,
    /^(#)/g,
    /(``)(`)/g
  ]

  regexList.forEach(reg => {
    text = text.replace(reg, (match, ...groups) => groups.slice(0, -2).join(rand))
  })

  return text.split(rand)
}

function getMustacheTemplating (template, context) {
  let func = null
  try {
    // eslint-disable-next-line no-new-func
    func = new Function('context', `
      with(context) {
        return \`${template.replace(/\{\{([^}]+)\}\}/g, '${$1}')}\`;
      }
    `)
    const result = func(context).replace(/\n/g, '\r')
    func = null
    return result
  } catch (error) {
    logger.error(`getMustacheTemplating error: ${error}`)
    return ''
  }
}

function formatBytes (bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const size = parseFloat((bytes / Math.pow(k, i)).toFixed(2))
  return `${size}${sizes[i]}`
}

function formatDuration (inp, unit = 'seconds') {
  const duration = moment.duration(inp, unit)

  const days = duration.days()
  const hours = duration.hours()
  const minutes = duration.minutes()
  const secs = duration.seconds()

  let formatted = ''
  if (days > 0) formatted += `${days}天`
  if (hours > 0) formatted += `${hours}时`
  if (minutes > 0) formatted += `${minutes}分`
  if (secs > 0 || formatted === '') formatted += `${secs}秒`

  return formatted.trim()
}

export {
  getTime,
  importJS,
  formatBytes,
  formatDuration,
  splitMarkDownTemplate,
  getMustacheTemplating
}

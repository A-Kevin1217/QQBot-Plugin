import crypto from 'node:crypto'

function isCNBEnabled (cnbConfig = {}) {
  return cnbConfig.enable !== false && !!cnbConfig.token && !!cnbConfig.defaultRepo
}

function trimSlash (value = '') {
  return String(value).replace(/\/+$/, '')
}

function getImageExt (buffer) {
  if (!Buffer.isBuffer(buffer)) return ''
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'jpg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'png'
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'gif'
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return ''
}

function getFileExt (buffer) {
  const imageExt = getImageExt(buffer)
  if (imageExt) return imageExt
  if (buffer?.toString?.('hex', 0, 4).toUpperCase() === '25504446') return 'pdf'
  if (buffer?.toString?.('hex', 0, 4).toUpperCase() === '504B0304') return 'zip'
  return 'bin'
}

function getNameFromUrl (value) {
  try {
    const url = new URL(value)
    const name = url.pathname.split('/').pop()
    return name ? decodeURIComponent(name.split('?')[0]) : ''
  } catch {
    return ''
  }
}

function normalizeFileName (buffer, fileName = '') {
  let name = String(fileName || '').split(/[\\/]/).pop()
  if (!name && /^https?:\/\//.test(String(fileName))) name = getNameFromUrl(fileName)
  if (name && name.includes('.')) return encodeURIComponent(name)

  const md5 = crypto.createHash('md5').update(buffer).digest('hex')
  const ext = getFileExt(buffer)
  return `${Date.now().toString(36)}.${md5.slice(0, 8)}.${ext}`
}

async function getUploadInfo (repo, fileName, size, cnbConfig, isImage) {
  const baseUrl = trimSlash(cnbConfig.baseUrl || 'https://api.cnb.cool')
  const safeRepo = String(repo).replace(/^\/+|\/+$/g, '')
  const uploadPath = isImage ? 'imgs' : 'files'
  const response = await fetch(`${baseUrl}/${safeRepo}/-/upload/${uploadPath}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      Authorization: `Bearer ${cnbConfig.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name: fileName, size })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`获取CNB上传URL失败: ${response.status} ${response.statusText} - ${errorText}`)
  }
  return response.json()
}

async function putFile (buffer, uploadInfo) {
  let uploadUrl = uploadInfo.upload_url
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(buffer.length)
  }

  if (uploadInfo.form && Object.keys(uploadInfo.form).length) {
    const url = new URL(uploadUrl)
    for (const [key, value] of Object.entries(uploadInfo.form)) {
      url.searchParams.append(key, value)
    }
    uploadUrl = url.toString()
  }
  if (uploadInfo.token) headers.Authorization = `Bearer ${uploadInfo.token}`

  const response = await fetch(uploadUrl, { method: 'PUT', headers, body: buffer })
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`CNB文件上传失败: ${response.status} ${response.statusText} - ${errorText}`)
  }
}

async function deleteCNBFile (path, cnbConfig) {
  const baseUrl = trimSlash(cnbConfig.baseUrl || 'https://api.cnb.cool')
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${cnbConfig.token}` }
  })
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`CNB文件删除失败: ${response.status} ${response.statusText} - ${errorText}`)
  }
}

async function uploadToCNB (data, buffer, cnbConfig = {}, options = {}) {
  if (!isCNBEnabled(cnbConfig)) return
  if (!Buffer.isBuffer(buffer)) throw new Error('CNB上传需要Buffer')

  const repo = options.repo || cnbConfig.defaultRepo
  const fileName = normalizeFileName(buffer, options.name || options.fileName)
  const uploadInfo = await getUploadInfo(repo, fileName, buffer.length, cnbConfig, !!getImageExt(buffer))
  await putFile(buffer, uploadInfo)

  if (Number(cnbConfig.autodelete) > 0 && uploadInfo.assets?.path) {
    setTimeout(() => {
      deleteCNBFile(uploadInfo.assets.path, cnbConfig)
        .then(() => Bot.makeLog?.('debug', [`CNB文件已自动删除: ${uploadInfo.assets.path}`], data?.self_id || 'QQBot'))
        .catch(err => Bot.makeLog?.('warn', [`CNB文件自动删除失败: ${err.message}`], data?.self_id || 'QQBot'))
    }, Number(cnbConfig.autodelete) * 1000)
  }

  const result = uploadInfo.assets?.url || uploadInfo.assets?.path
  if (!result) return
  return result.startsWith('http') ? result : `https://cnb.cool${result}`
}

export {
  isCNBEnabled,
  uploadToCNB
}

import { join } from 'node:path'
import { dshHome, readJson } from '../core/store.js'

// Authentication belongs to the installed dsh-bili-scroll plugin. Aurabot
// reads its saved session so existing QQ features use the same account.
export function biliProviderConfig(config, { home = dshHome(), dsh } = {}) {
  let directory = join(home, 'bili-duty')
  try {
    const path = dsh?.get?.('dshHomePath')
    if (typeof path === 'function') directory = path('bili-duty') || directory
    else if (typeof path === 'string' && path) directory = join(path, 'bili-duty')
  } catch { /* Use the standard DSH home when the service is unavailable. */ }
  const login = readJson(join(directory, 'bili_credential.json'), null)
  const fields = {
    SESSDATA: login?.sessdata, bili_jct: login?.bili_jct,
    DedeUserID: login?.dedeuserid, buvid3: login?.buvid3,
  }
  const cookie = Object.entries(fields)
    .filter(([, value]) => typeof value === 'string' && value && !/[;\r\n]/.test(value))
    .map(([key, value]) => `${key}=${value}`).join('; ')
  return { ...config, bili: { ...config.bili, cookie } }
}

export const BILI_PROVIDER_TOOLS = [
  'bili_whoami', 'bili_search', 'bili_subtitle', 'bili_comments', 'bili_cover',
  'bili_frames', 'bili_reply', 'bili_status', 'bili_run', 'bili_login_start',
  'bili_login_poll', 'bili_setup', 'bili_config',
]

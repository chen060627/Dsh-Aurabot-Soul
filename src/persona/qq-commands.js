import { isOwner } from '../chat/access.js'

// These commands are reserved before extension commands and are accepted only
// in a direct private message from the configured owner.
export function parsePersonaCommand(text) {
  const m = String(text || '').trim().match(/^[/／]\s*(人格列表|当前人格|切换人格|人格|persona(?=\s|$)|dev(?=\s|$))([\s\S]*)$/i)
  if (!m) return null
  const word = m[1].toLowerCase()
  const arg = m[2].trim()
  if (word === 'dev') return { action: 'menu', arg }
  if (word === '人格列表') return { action: 'list', arg }
  if (word === '当前人格') return { action: 'current', arg }
  if (word === '切换人格') return { action: 'switch', arg }
  if (!arg || /^(列表|list)$/i.test(arg)) return { action: 'list', arg: '' }
  if (/^(当前|current)$/i.test(arg)) return { action: 'current', arg: '' }
  return { action: 'switch', arg }
}

export const canManagePersonaFromQQ = (cfg, msg) =>
  msg?.kind === 'private' && msg.chatId === `private:${msg.userId}` && isOwner(cfg, msg.userId)

const displayName = (p) => String(p.name || p.id).replace(/[\r\n]/g, ' ').trim()

/** A menu belongs to the current owner and contains a stable snapshot of IDs. */
export function createPersonaMenu({ getConfig, listPersonas, switchPersona, now = Date.now, ttlMs = 120_000 }) {
  let pending = null
  function isSelection(msg) {
    if (!pending || now() >= pending.expires || pending.owner !== String(getConfig().ownerQQ || '')) {
      pending = null
      return false
    }
    return canManagePersonaFromQQ(getConfig(), msg) && /^\d+$/.test(String(msg.text || '').trim())
  }
  function open(msg) {
    if (!canManagePersonaFromQQ(getConfig(), msg)) return null
    const cfg = getConfig()
    const entries = listPersonas().map(({ id, name }) => ({ id, name: displayName({ id, name }) }))
    pending = { owner: String(cfg.ownerQQ), entries, expires: now() + ttlMs }
    return `人格列表：\n${entries.map((p, i) => `/${i + 1} ${p.name}${p.id === cfg.persona?.current ? ' ← 当前' : ''}`).join('\n')}\n直接回复单个数字选择（2 分钟内有效）`
  }
  async function select(msg) {
    if (!isSelection(msg)) return null
    const index = Number(String(msg.text).trim()) - 1
    const target = pending.entries[index]
    if (!Number.isSafeInteger(index) || !target) return '没有这个编号，请回复列表中的数字，或重新发送 /DEV'
    pending = null
    const authorized = () => canManagePersonaFromQQ(getConfig(), msg)
    const result = await switchPersona(target.id, authorized)
    if (!result?.ok) return result?.message || '切换失败，请重新发送 /DEV'
    return `已切换到：${target.name}。下一轮回复起生效。`
  }
  return { open, isSelection, select }
}

export async function runPersonaCommand(cmd, msg, { getConfig, listPersonas, switchPersona }) {
  const authorized = () => canManagePersonaFromQQ(getConfig(), msg)
  if (!authorized()) return null
  const list = listPersonas()
  const current = getConfig().persona?.current
  if (cmd.action === 'current') {
    const active = list.find((p) => p.id === current)
    return active ? `当前人格：${displayName(active)}` : '当前人格不存在，请用 /人格列表 查看'
  }
  const formatList = () => {
    const duplicates = new Map()
    for (const p of list) duplicates.set(displayName(p), (duplicates.get(displayName(p)) || 0) + 1)
    return list.map((p) => `· ${displayName(p)}${duplicates.get(displayName(p)) > 1 ? `（ID：${p.id}）` : ''}${p.id === current ? ' ← 当前' : ''}`).join('\n')
  }
  if (cmd.action === 'list') return `可用人格：\n${formatList()}\n发送 /切换人格 名称 来切换`
  if (!cmd.arg) return '请发送 /切换人格 名称；发送 /人格列表 查看可选人格'
  const query = cmd.arg.trim().toLocaleLowerCase()
  const ids = list.filter((p) => String(p.id).toLocaleLowerCase() === query)
  const names = list.filter((p) => displayName(p).toLocaleLowerCase() === query)
  const hits = ids.length ? ids : names
  if (hits.length > 1) return `有多个同名人格，请按 ID 选择：\n${hits.map((p) => `· ${displayName(p)}（ID：${p.id}）`).join('\n')}`
  if (!hits.length) return `没找到「${cmd.arg.slice(0, 80)}」。发送 /人格列表 查看可选人格`
  const target = hits[0]
  if (target.id === current) return `当前已经是：${displayName(target)}`
  const result = await switchPersona(target.id, authorized)
  if (!result?.ok) return result?.message || '切换失败，请稍后再试'
  return `已切换到：${displayName(target)}。下一轮回复起生效。`
}

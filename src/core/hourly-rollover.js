import { dataDir, readJson, writeJson } from './store.js'

const MINUTE = 60_000
const RETRY = 5 * 60_000

// 日志和记忆都按人格处理；任何整理失败都保留原会话，下次再试。
export function createHourlyRollover({ config, personas, memory, hub, log, now = Date.now }) {
  const file = dataDir('hourly-rollover.json')
  const saved = readJson(file, {})
  const settings = () => {
    const chat = config().chat || {}
    return { trigger: chat.autoArchiveTrigger === 'context' ? 'context' : 'time', minutes: Math.max(5, Math.min(10080, Number(chat.autoArchiveMinutes) || 60)), percent: Math.max(10, Math.min(95, Number(chat.autoArchivePercent) || 70)) }
  }
  let signature = JSON.stringify(settings())
  const initial = settings()
  let state = { nextAt: Number(saved.nextAt) || now() + initial.minutes * MINUTE, lastAt: Number(saved.lastAt) || 0, lastError: String(saved.lastError || ''), lastArchived: Number(saved.lastArchived) || 0, lastProtected: Number(saved.lastProtected) || 0, lastNotice: String(saved.lastNotice || '') }
  if ((saved.settings && saved.settings !== signature) || (!saved.settings && (initial.trigger === 'context' || initial.minutes !== 60))) state.nextAt = initial.trigger === 'context' ? now() : now() + initial.minutes * MINUTE
  let running = false
  let disposed = false
  const persist = () => writeJson(file, { ...state, settings: signature })
  persist()
  const status = () => ({ ...state, enabled: config().chat?.autoArchive !== false, running })
  async function tick() {
    if (disposed || running || !config().enabled || config().chat?.autoArchive === false) return false
    const current = settings()
    const nextSignature = JSON.stringify(current)
    if (signature !== nextSignature) {
      signature = nextSignature
      state.nextAt = current.trigger === 'context' ? now() : state.lastAt ? Math.max(now(), state.lastAt + current.minutes * MINUTE) : now() + current.minutes * MINUTE
      state.lastError = ''
      persist()
    }
    if (now() < state.nextAt) return false
    running = true
    try {
      if (!config().memory?.enabled) throw new Error('记忆功能未开启，已暂停自动归档')
      const mem = memory()
      if (typeof mem?.forPersona !== 'function') throw new Error('记忆模块不可用或不支持按人格保存')
      const ids = personas().map((p) => String(p.id)).sort()
      let selected = null, pressureNotice = ''
      if (current.trigger === 'context') {
        if (typeof hub.contextPressureCandidates !== 'function') throw new Error('无法读取 DSH 上下文用量，不能按百分比归档')
        const pressure = await hub.contextPressureCandidates(ids, current.percent)
        selected = pressure.selected
        pressureNotice = pressure.unknown ? `${pressure.unknown} 个会话的上下文用量未知，未按百分比归档` : ''
        if (!selected.length) {
          state.lastNotice = pressureNotice || `已检查 ${pressure.measured} 个会话，尚未达到 ${current.percent}%`
          state.lastError = ''
          state.nextAt = now() + MINUTE
          persist()
          return false
        }
      }
      if (typeof hub.waitForDeliveries === 'function') await hub.waitForDeliveries()
      const stamps = {}
      for (const id of ids) {
        const before = hub.chatLogStamp(id)
        if (before !== '[]') {
          const store = mem.forPersona(id)
          if (typeof store?.markArchivePending === 'function') {
            store.markArchivePending()
          } else {
            let timer
            const r = await Promise.race([
              (async () => {
                let result
                // 提炼按批次断点续做；本次达到上限时立即继续一次，
                // 也可避免刚好处理完第 12 批却误报尚未完成。
                for (let i = 0; i < 2; i++) {
                  result = await store.consolidate({ includeToday: true, quick: true })
                  if (!result?.ok || !result.incomplete || result.budgetExhausted || disposed) break
                }
                return result
              })(),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('记忆整理仍在进行或超时，稍后继续检查')), 180_000); timer.unref?.() }),
            ]).finally(() => clearTimeout(timer))
            if (disposed) return false
            if (!r?.ok || r.incomplete || r.budgetExhausted) throw new Error(`人格 ${id} 的记忆尚未整理完：${r?.message || '稍后重试'}`)
          }
        }
        const after = hub.chatLogStamp(id)
        if (before !== after) throw new Error(`人格 ${id} 的聊天流水在整理时发生变化`)
        stamps[id] = after
      }
      if (JSON.stringify(ids) !== JSON.stringify(personas().map((p) => String(p.id)).sort())) throw new Error('人格列表已变化，稍后重新整理')
      if (disposed || !config().enabled || config().chat?.autoArchive === false) return false
      const result = await hub.rotateTrackedSessions(ids, stamps, selected)
      if (!result?.ok) throw new Error((result?.archived ? `本次已归档 ${result.archived} 个会话；` : '') + (result?.message || '会话暂时无法归档'))
      state = { nextAt: now() + (result.protected ? RETRY : current.trigger === 'context' ? MINUTE : current.minutes * MINUTE), lastAt: now(), lastError: '', lastArchived: result.archived || 0, lastProtected: result.protected || 0, lastNotice: [result.notice, pressureNotice, ids.length && typeof mem.forPersona(ids[0])?.hasArchivePending === 'function' && ids.some((id) => mem.forPersona(id).hasArchivePending()) ? '原始聊天已保留，记忆将在后台继续整理' : ''].filter(Boolean).join('；').slice(0, 500) }
      persist()
      log.info?.(`自动整理记忆并归档了 ${state.lastArchived} 个会话；保留 ${state.lastProtected} 个有提醒或工作的会话`)
      return true
    } catch (error) {
      state.lastError = String(error?.message || error).slice(0, 500)
      state.nextAt = now() + RETRY
      persist()
      log.warn?.('自动归档暂缓：' + state.lastError)
      return false
    } finally { running = false }
  }
  return { status, tick, dispose: () => { disposed = true } }
}

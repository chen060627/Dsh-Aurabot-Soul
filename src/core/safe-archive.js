// DSH reminders belong to a specific session. Archiving that session can stop
// them, so all plugin-initiated archives go through this shared guard.
function service(dsh, name) {
  try { return dsh.get?.(name) || dsh[name] } catch { return undefined }
}
const sessionKey = (id) => String(id).replace(/^session-/, '')

export async function withSafeArchive(dsh, operation, { archiveSession } = {}) {
  const reg = service(dsh, 'workspaceRegistry')
  const schedule = service(dsh, 'schedule')
  if (typeof reg?.archiveSession !== 'function' || !Array.isArray(reg.archivedSessionIds)) {
    throw new Error('无法核实 DSH 会话归档状态，已保留原会话')
  }
  // In the inspected DSH runtime schedule.serialize is the same queue used
  // for reminder creation, editing and delivery writes. Without it, a new
  // reminder could be created between our check and the archive operation.
  if (typeof schedule?.catalog !== 'function' || typeof schedule?.serialize !== 'function' || typeof dsh.waterfall !== 'function') {
    throw new Error('此 DSH 未提供可核实的定时任务保护接口，已保留原会话')
  }
  return schedule.serialize(async () => {
    const tasks = await schedule.catalog()
    if (!Array.isArray(tasks)) throw new Error('无法读取完整的定时提醒列表，已保留原会话')
    const protectedIds = new Set()
    for (const task of tasks) {
      const target = task?.target
      if (!target || !['session', 'new_once', 'new'].includes(target.kind)) throw new Error('定时提醒的目标格式无法识别，已保留原会话')
      if (target.kind !== 'new') {
        if (typeof target.sessionId !== 'string' || !target.sessionId) throw new Error('定时提醒缺少会话信息，已保留原会话')
        // Include paused and ended records as well as active reminders: their
        // owner may want to resume or inspect them later.
        protectedIds.add(sessionKey(target.sessionId))
      }
    }
    const check = async (id) => {
      if (protectedIds.has(sessionKey(id))) return { ok: false, protected: true, message: '会话有定时提醒，已保留会话和提醒' }
      const activity = await dsh.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]))
      if (!Array.isArray(activity)) throw new Error('无法核实会话内的后台工作，已保留原会话')
      if (activity.length) return { ok: false, protected: true, message: '会话有进行中的工作，已保留原会话' }
      return { ok: true }
    }
    const archive = async (id) => {
      const checked = await check(id)
      if (!checked.ok) return checked
      if (!reg.archivedSessionIds.includes(id)) {
        // Never ask DSH to force-stop a session's work.
        const result = await (archiveSession || reg.archiveSession.bind(reg))(id, { stopActivity: false })
        if (result === false || result?.ok === false || result?.error) throw new Error(result?.message || result?.error?.message || 'DSH 会话归档失败')
        if (!reg.archivedSessionIds.includes(id)) throw new Error('DSH 未确认会话已归档，已保留会话映射')
      }
      return { ok: true }
    }
    return operation({ check, archive })
  })
}

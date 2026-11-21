// Transfer DSH's own reminder records by its management API. The caller keeps
// both Sessions routable until every record is moved and the old one is safely
// archived; if anything fails it retains that durable transition for retry.
const key = (id) => String(id || '').replace(/^session-/, '')

export async function transferReminders(schedule, from, to) {
  if (typeof schedule?.catalog !== 'function' || typeof schedule?.edit !== 'function' || typeof schedule?.serialize !== 'function' || typeof schedule?.getDomain !== 'function') {
    throw new Error('DSH 不支持安全转移定时提醒；原会话和提醒已保留')
  }
  let moved = 0
  // Changes made by other callers are detected by expectedUpdatedAt; never
  // overwrite a task the user edited while a transfer was running.
  for (let pass = 0; pass < 4; pass++) {
    const catalog = await schedule.serialize(async () => {
      const rows = await schedule.catalog()
      const domain = await schedule.getDomain()
      if (!Array.isArray(rows) || typeof domain?.table !== 'function') throw new Error('不能核对提醒的待投递状态；原会话已保留')
      const table = domain.table('tasks')
      if (typeof table?.get !== 'function') throw new Error('不能核对提醒的待投递状态；原会话已保留')
      for (const task of rows) {
        if (task?.target?.kind === 'new' || key(task?.target?.sessionId) !== key(from)) continue
        const raw = table.get(task.id)
        if (!raw || raw.pendingDelivery) throw new Error('有提醒正在等待投递或无法核对；原会话已保留')
      }
      return rows
    })
    if (!Array.isArray(catalog)) throw new Error('不能读取完整的提醒列表；原会话已保留')
    for (const task of catalog) {
      if (!task?.target || !['session', 'new_once', 'new'].includes(task.target.kind)) throw new Error('提醒目标格式无法识别；原会话已保留')
      if (task.target.kind !== 'new' && (typeof task.target.sessionId !== 'string' || !task.target.sessionId)) throw new Error('提醒缺少目标会话；原会话已保留')
    }
    const pending = catalog.filter((task) => task.target.kind !== 'new' && key(task.target.sessionId) === key(from))
    if (!pending.length) return { moved }
    for (const task of pending) {
      // A new_once target is a reserved future Session, not an ordinary
      // existing conversation. Replacing its kind would change its behavior.
      if (task.target.kind !== 'session') throw new Error('提醒使用了尚未创建的专用会话；原会话和提醒已保留')
      if (task.executionActive) throw new Error('定时提醒正在执行；原会话已保留，稍后重试')
      if (typeof task.id !== 'string' || !task.id || !['active', 'paused', 'ended'].includes(task.status)) throw new Error('提醒状态无法识别；原会话已保留')
      const result = await schedule.edit({ id: task.id, action: 'update', expectedUpdatedAt: task.updatedAt ?? null, patch: { target: { kind: 'session', sessionId: to } } })
      if (!result || result.code || key(result.target?.sessionId) !== key(to) || result.target?.kind !== 'session' || result.status !== task.status || result.scheduledAt !== task.scheduledAt || result.title !== task.title || result.prompt !== task.prompt) {
        throw new Error('提醒转移发生冲突或无法核对；两个会话均保留，稍后重试')
      }
      moved++
    }
  }
  throw new Error('提醒在转移时持续发生变化；两个会话均保留，稍后重试')
}

// Automatic complete snapshots. Only archives created by this scheduler are rotated.
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, readJson, writeJson } from './store.js'

const FILE = () => dataDir('backup-schedule.json')
const AUTO_NAME = /^aurabot-auto-backup-\d{8}-\d{4}-[a-f0-9]{12}\.zip$/
const HOURS = [6, 12, 24, 72, 168]
const KEEP = [3, 7, 14, 30]
const RETRY = 15 * 60_000

export function createBackupSchedule({ run, now = () => Date.now(), log = console }) {
  const initial = readJson(FILE(), null)
  let state = {
    enabled: typeof initial?.enabled === 'boolean' ? initial.enabled : true,
    intervalHours: HOURS.includes(initial?.intervalHours) ? initial.intervalHours : 24,
    keep: KEEP.includes(initial?.keep) ? initial.keep : 7,
    nextAt: Number.isFinite(initial?.nextAt) ? initial.nextAt : now(),
    lastSuccess: Number(initial?.lastSuccess) || 0,
    lastFile: String(initial?.lastFile || ''),
    lastError: String(initial?.lastError || ''),
    lastAttempt: Number(initial?.lastAttempt) || 0,
  }
  let running = false
  const save = () => writeJson(FILE(), state)
  save()

  function configure(input) {
    if (typeof input?.enabled !== 'boolean' || !HOURS.includes(input.intervalHours) || !KEEP.includes(input.keep)) throw new Error('请选择有效的备份周期和保留数量')
    const changed = input.enabled !== state.enabled || input.intervalHours !== state.intervalHours
    state = { ...state, enabled: input.enabled, intervalHours: input.intervalHours, keep: input.keep }
    if (changed && state.enabled) state.nextAt = now() + state.intervalHours * 3600_000
    save()
    return status()
  }
  function status() { return { ...state, running } }
  function prune() {
    const dir = dataDir('backups')
    const files = readdirSync(dir).filter((name) => AUTO_NAME.test(name)).map((name) => ({ name, time: statSync(join(dir, name)).mtimeMs })).sort((a, b) => b.time - a.time || b.name.localeCompare(a.name))
    for (const file of files.slice(state.keep)) unlinkSync(join(dir, file.name))
  }
  async function tick() {
    if (running || !state.enabled || now() < state.nextAt) return false
    running = true
    state.lastAttempt = now()
    save()
    try {
      const result = await run()
      if (!result || result.skipped?.length) throw new Error('备份未完成，稍后会重试')
      state.lastSuccess = now()
      state.lastFile = result.name
      state.lastError = ''
      state.nextAt = now() + state.intervalHours * 3600_000
      save()
      try { prune() } catch (error) { log.warn?.('清理旧的自动备份失败：', error.message) }
      return true
    } catch (error) {
      state.lastError = String(error?.message || error).slice(0, 500)
      state.nextAt = now() + RETRY
      save()
      log.warn?.('自动备份失败：', state.lastError)
      return false
    } finally { running = false }
  }
  return { status, configure, tick }
}

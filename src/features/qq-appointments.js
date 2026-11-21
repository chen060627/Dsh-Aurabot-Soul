import { chatDay, chatTime } from '../core/chat-time.js'
import { dataDir, existsSync, readJson, writeJson } from '../core/store.js'
import { isDefiniteFailure } from '../onebot/client.js'
import { parseReply } from '../chat/reply.js'
import { defineTool, str } from '../tools/tools.js'

export const APPOINTMENT_CHAT = 'system:qq-appointments'
export const APPOINTMENT_TOOL = 'qq_appointment'
const ZONE = 'Asia/Shanghai'
const DAY = 86_400_000
const GRACE = 15 * 60_000
const MARKER = '【Aurabot QQ 定时搭话 v1】'
const DEFAULT_TEXT = '到我们约好的时间啦。'
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const QQ = /^\d{5,12}$/
const TASK_ID = /^[a-zA-Z0-9_-]{1,100}$/
const timestamp = (value) => Date.parse(value) || 0
const error = (message) => ({ ok: false, message })

function dateTime(date, time) {
  if (!DATE.test(date) || !HH_MM.test(time)) return 0
  const at = timestamp(`${date}T${time}:00+08:00`)
  return chatTime(at).slice(0, 16) === `${date} ${time}` ? at : 0
}

function taskData(task) {
  if (!TASK_ID.test(task?.id || '') || task.target?.kind !== 'session' || typeof task.prompt !== 'string') return null
  const [marker, json] = task.prompt.split('\n', 2)
  if (marker !== MARKER) return null
  try {
    const data = JSON.parse(json)
    return data && QQ.test(data.owner) && QQ.test(data.bot) && typeof data.persona === 'string' &&
      typeof data.text === 'string' && data.text.length <= 240 && HH_MM.test(data.time) &&
      (data.kind === 'daily' || (data.kind === 'once' && dateTime(data.date, data.time))) ? data : null
  } catch { return null }
}

export function createQQAppointments({ dsh, hub, getConfig, isConnected, isMuted, log, now = Date.now, file = dataDir('qq-appointment-deliveries.json') }) {
  let queue = Promise.resolve()
  let ticking = false
  let ledger
  const serial = (fn) => {
    const next = queue.then(fn)
    queue = next.catch(() => {})
    return next
  }
  const config = () => {
    const cfg = getConfig()
    return { owner: String(cfg.ownerQQ || ''), bot: String(cfg.botQQ || ''), persona: cfg.persona.current }
  }
  const availableSchedule = () => dsh.get?.('schedule') || dsh.schedule
  const supported = () => {
    const service = availableSchedule()
    return typeof service?.create === 'function' && typeof service.catalog === 'function' && typeof service.edit === 'function'
  }

  function deliveries() {
    if (ledger) return ledger
    const data = readJson(file, null)
    if (data?.version === 1 && data.deliveries && !Array.isArray(data.deliveries) && typeof data.deliveries === 'object') return (ledger = data.deliveries)
    if (existsSync(file)) throw new Error('QQ 定时搭话的发送记录无法读取，已暂停发送。')
    return (ledger = Object.create(null))
  }
  function record(id, entry) {
    const next = { ...deliveries(), [id]: entry }
    writeJson(file, { version: 1, deliveries: next })
    ledger = next
  }

  async function managedTasks(service, { currentPersona = false } = {}) {
    const { owner, bot, persona } = config()
    if (!QQ.test(owner) || !QQ.test(bot)) return []
    const tasks = await service.catalog()
    if (!Array.isArray(tasks)) throw new Error('无法读取 DSH 自动化任务。')
    const lanes = new Map()
    return tasks.flatMap((task) => {
      const data = taskData(task)
      if (!data || data.owner !== owner || data.bot !== bot || (currentPersona && data.persona !== persona)) return []
      if (!lanes.has(data.persona)) lanes.set(data.persona, hub.appointmentSessionOf(data.persona))
      return lanes.get(data.persona) === task.target.sessionId ? [{ task, data }] : []
    })
  }

  function view(task, data) {
    const at = timestamp(task.scheduledAt)
    const last = deliveries()[task.id] || null
    return {
      id: task.id, kind: data.kind, text: data.text, persona: data.persona,
      time: at ? chatTime(at).slice(11, 16) : data.time,
      date: data.kind === 'once' ? (at ? chatDay(at) : data.date) : '',
      status: task.status, nextAt: task.status === 'active' ? at : 0,
      next: task.status === 'active' && at ? chatTime(at).slice(0, 16) : '',
      last: last && { ...last, status: last.status === 'sending' ? 'uncertain' : last.status },
    }
  }

  async function list({ currentPersona = false } = {}) {
    if (!supported()) return { ...error('当前 DSH 版本没有可用的自动化任务接口。'), supported: false, items: [] }
    const { owner, bot } = config()
    return { ok: true, supported: true, configured: QQ.test(owner) && QQ.test(bot) && owner !== bot, items: (await managedTasks(availableSchedule(), { currentPersona })).map(({ task, data }) => view(task, data)) }
  }

  async function create(service, input, tasks) {
    const { owner, bot, persona } = config()
    if (!QQ.test(owner) || !QQ.test(bot) || owner === bot) return error('请先分别设置管理员 QQ 和机器人 QQ。')
    const { kind, date, time } = input
    if (!['once', 'daily'].includes(kind) || !HH_MM.test(time || '')) return error('请给出明确的 24 小时制时间，并选择指定日期或每天。')
    const at = kind === 'once' ? dateTime(date || '', time) : 0
    if (kind === 'once' && at <= now()) return error('请选择未来的日期和时间。')
    const requested = String(input.text || '').trim()
    const body = parseReply(requested || DEFAULT_TEXT, { sentenceBySentence: false }).items
      .filter((item) => item.kind === 'text' || item.kind === 'voice').map((item) => item.value).join(' ').replace(/\s+/g, ' ').trim()
    if (!body || body.length > 240) return error('搭话内容清洗后须有 1–240 个字符。')
    const same = tasks.find(({ task, data }) => task.status !== 'ended' && data.persona === persona && data.kind === kind &&
      (kind === 'once' ? timestamp(task.scheduledAt) === at : (timestamp(task.scheduledAt) ? chatTime(timestamp(task.scheduledAt)).slice(11, 16) : data.time) === time))
    if (same) return { ok: true, existing: true, item: view(same.task, same.data) }
    const sessionId = await hub.openAppointmentSession()
    if (!sessionId) return error('无法准备 QQ 定时搭话会话。')
    const current = config()
    if (owner !== current.owner || bot !== current.bot || persona !== current.persona) return error('QQ 账号或人格已切换，请重新确认这次预约。')
    const data = { owner, bot, persona, kind, ...(kind === 'once' ? { date } : {}), time, text: body }
    const timing = kind === 'once' ? { kind: 'at', at: new Date(at).toISOString() } : { kind: 'daily', daily: { time: `${time}:00`, time_zone: ZONE } }
    const task = await service.create({
      title: `Aurabot · QQ 搭话 · ${kind === 'daily' ? '每天' : date} ${time}`,
      prompt: `${MARKER}\n${JSON.stringify(data)}\n这是 Aurabot 的内部定时信号。QQ 投递由插件负责，只输出 [沉默]。`,
      timing, target: { kind: 'session', sessionId },
    })
    if (task?.status !== 'active' || !task.id || !timestamp(task.scheduledAt)) return error('DSH 未确认任务已开启，请查看自动化任务列表。')
    return { ok: true, item: view(task, data) }
  }

  async function manage(input, { currentPersona = false, authorized } = {}) {
    return serial(async () => {
      if (authorized && !authorized()) return error('只能在管理员本人正在进行的私聊中管理定时搭话。')
      if (!supported()) return error('当前 DSH 版本没有可用的自动化任务接口。')
      if (input?.action === 'list') return list({ currentPersona })
      if (!['create', 'skip', 'cancel', 'pause', 'resume'].includes(input?.action)) return error('无法识别这个定时操作。')
      const service = availableSchedule()
      const tasks = await managedTasks(service, { currentPersona })
      if (authorized && !authorized()) return error('用于确认的私聊已结束，请重新发起。')
      if (input.action === 'create') return create(service, input, tasks)
      const match = tasks.find(({ task }) => task.id === input.id)
      if (!match) return error('找不到这项 QQ 定时搭话，请刷新列表。')
      const { task, data } = match
      const expectedUpdatedAt = task.updatedAt ?? null
      if (input.action === 'cancel') {
        const result = await service.edit({ id: task.id, action: 'delete', expectedUpdatedAt })
        return result?.deleted === true ? { ok: true } : error('任务状态已变动，请刷新后再取消。')
      }
      let patch
      let skipped = ''
      if (input.action === 'skip') {
        const at = timestamp(task.scheduledAt)
        if (data.kind !== 'daily' || task.status !== 'active' || at <= now()) return error('只能跳过每日任务下一次尚未到期的搭话。')
        skipped = chatDay(at)
        if (input.date !== skipped) return error(`这项任务下次是 ${skipped}，请确认要跳过这一天。`)
        const start = chatTime(at + DAY).replace(/[-:]/g, '').replace(' ', 'T')
        patch = { timing: { kind: 'rrule', rrule: `DTSTART;TZID=${ZONE}:${start}\nRRULE:FREQ=DAILY` } }
      } else {
        if (task.status === 'ended') return error('这项搭话已经结束。')
        if (input.action === 'resume' && data.kind === 'once' && timestamp(task.scheduledAt) <= now()) return error('这次约定的时间已经过去，请重新选时间。')
        patch = { active: input.action === 'resume' }
      }
      const result = await service.edit({ id: task.id, action: 'update', expectedUpdatedAt, patch })
      if (!result?.status || result.code) return error('任务状态已变动，请刷新后重试。')
      return { ok: true, item: view(result, data), ...(skipped ? { skipped } : {}) }
    }).catch((cause) => {
      log.warn('处理 QQ 定时搭话失败：', cause.message)
      return error('DSH 没有确认操作成功，请刷新自动化任务列表。')
    })
  }

  function occurrence(task, t) {
    if (task.status === 'paused') return 0
    const scheduled = timestamp(task.scheduledAt)
    const delivered = timestamp(task.updatedAt) <= timestamp(task.lastDelivery?.deliveredAt) ? timestamp(task.lastDelivery?.scheduledAt) : 0
    // An active due task can be sent before the DSH model turn starts. A saved
    // inbox receipt covers the case where DSH already advanced the native timer.
    return Math.max(task.status === 'active' && scheduled <= t ? scheduled : 0, delivered <= t ? delivered : 0)
  }

  async function tick() {
    if (!supported() || ticking || !hub.hasAppointmentSessions()) return
    ticking = true
    try {
      await serial(async () => {
        const service = availableSchedule()
        for (const { task, data } of await managedTasks(service)) {
          const t = now()
          const at = occurrence(task, t)
          const last = deliveries()[task.id]
          if (!at || at < (last?.at || 0) || (at === last?.at && (last.status !== 'retry' || t < last.retryAt))) continue
          const cfg = getConfig()
          if (t - at >= GRACE || !cfg.enabled || cfg.dryRun || isMuted(`private:${data.owner}`)) {
            record(task.id, { at, status: cfg.dryRun ? 'dry-run' : t - at >= GRACE ? 'missed' : 'disabled' })
            continue
          }
          if (!isConnected()) continue
          const accountReady = () => {
            const cfg = getConfig()
            return cfg.enabled && !cfg.dryRun && String(cfg.ownerQQ) === data.owner && String(cfg.botQQ) === data.bot &&
              isConnected() && !isMuted(`private:${data.owner}`)
          }
          const current = async () => {
            if (!accountReady() || now() - at >= GRACE) return false
            if (typeof service.view !== 'function') return true
            const latest = await service.view({ id: task.id })
            return accountReady() && latest?.prompt === task.prompt && latest.target?.sessionId === task.target.sessionId && occurrence(latest, now()) === at
          }
          // A crash or unclear gateway response must not duplicate this occurrence.
          const attempts = (last?.at === at ? last.attempts || 0 : 0) + 1
          record(task.id, { at, status: 'sending', attempts })
          try {
            const sent = await hub.sendAppointment(data.persona, data.owner, data.text, current)
            record(task.id, { at, status: sent?.message_id != null ? 'sent' : sent ? 'uncertain' : 'blocked', finishedAt: now() })
          } catch (cause) {
            const definite = isDefiniteFailure(cause)
            if (definite && cause.transport && attempts < 3) record(task.id, { at, status: 'retry', attempts, retryAt: now() + 15_000 * attempts })
            else record(task.id, { at, status: definite ? 'failed' : 'uncertain', finishedAt: now() })
            log.warn('发送 QQ 定时搭话失败：', cause.message)
          }
        }
      })
    } finally { ticking = false }
  }

  function tool(sessionId) {
    return defineTool({
      name: APPOINTMENT_TOOL,
      description: '管理管理员本人的 QQ 定时搭话。明确要求或在私聊里确认后才操作；只在返回 ok:true 且 item.status:active 后确认已约好。返回的时间是北京时间。',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'skip', 'cancel', 'pause', 'resume'] },
        kind: { type: 'string', enum: ['once', 'daily'] },
        date: str('YYYY-MM-DD。新建单次必填。跳过时也必填，使用对方指定的日期，或先 list 获取下一次的日期。'),
        time: str('24 小时制 HH:mm；上午下午不明确时先问'),
        id: str('要管理的任务 ID，从 list 获取；多项匹配先问是哪一项'),
        text: str('到点发给对方的一句简短搭话。优先结合约定的主题；省略则使用普通提醒。'),
      },
      execute: (input) => manage(input, { currentPersona: true, authorized: () => hub.appointmentTurnAllowed(sessionId, input?.action) }),
      render: (_input, result) => [{ type: 'text', text: JSON.stringify(result) }],
    })
  }

  return { list, manage, supported, tick, tool }
}

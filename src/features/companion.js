// 陪伴类小功能：心情、主动搭话。

import { join } from 'node:path'
import { readJson, writeJson } from '../core/store.js'
import { isBlankPersona, identityDir, identityHistoryBoundary, personaId } from '../core/identity.js'
import { createEmotionSystem } from './emotions.js'
import { chatDay, chatHour, elapsedChatTime } from '../core/chat-time.js'
import { inQuietHours } from '../chat/group-policy.js'

// ---------------- 心情 ----------------
// 兼容旧插件调用的心情分数和行为系数；多维、按人格保存的持续情绪由 emotions.js 处理。
// 情绪随互动和时间变化，并在后续轮次影响表达方式。

const UP = ['喜欢你', '爱你', '想你', '可爱', '好看', '漂亮', '聪明', '真棒', '厉害', '牛', '谢谢', '辛苦', '晚安', '早安', '抱抱', '摸摸', '贴贴', '乖', '宝贝', '爱了', '哈哈哈', '白米饭', '好吃', '请你吃']
const DOWN = ['讨厌', '滚', '烦死', '闭嘴', '笨', '蠢', '傻', '丑', '垃圾', '废物', '恶心', '无聊', '走开', '别理我', '不理你', '别说话', '生气', '难过', '烦人']

export function moodLabel(v) {
  if (v >= 85) return '超开心'
  if (v >= 70) return '心情不错'
  if (v >= 50) return '平平常常'
  if (v >= 35) return '有点低落'
  return '不太开心'
}

/** 每种心情下具体怎么说话（给她的提示），平平常常时为空。 */
export const MOOD_STYLE = {
  超开心: '话多一点、语气活泼，爱用语气词和感叹，更愿意发表情包、发语音，会主动接话、开玩笑',
  心情不错: '语气轻快，爱开点小玩笑，回得积极一些',
  平平常常: '',
  有点低落: '话少一点、句子短，回得有点懒，少发表情；有人关心你会慢慢好起来',
  不太开心: '有点小脾气、带点委屈，回得简短，可能会怼一句（但别伤人）；被哄、被夸会消气',
}

/** 心情对行为的影响倍数：表情包 / 语音概率、回复间隔、群里插话。 */
export function moodEffects(v) {
  if (v >= 85) return { sticker: 1.6, voice: 1.5, delay: 0.85, chatty: 1.5 }
  if (v >= 70) return { sticker: 1.25, voice: 1.2, delay: 0.92, chatty: 1.2 }
  if (v >= 50) return { sticker: 1, voice: 1, delay: 1, chatty: 1 }
  if (v >= 35) return { sticker: 0.5, voice: 0.6, delay: 1.3, chatty: 0.6 }
  return { sticker: 0.3, voice: 0.4, delay: 1.5, chatty: 0.4 }
}

export function scoreText(text, { blank = false } = {}) {
  const t = String(text || '')
  let d = 0
  for (const w of UP) if ((!blank || !['白米饭', '好吃', '请你吃'].includes(w)) && t.includes(w)) d += 6
  for (const w of DOWN) if (t.includes(w)) d -= 8
  return Math.max(-20, Math.min(20, d))
}

/** 心情基线的兜底值：没有配置时用它（和上游原来的 60 一致）。改基线只改配置项 mood.base。 */
export const MOOD_BASE = 60

export function decayed(value, at, halfLifeHours, now = Date.now(), base = MOOD_BASE) {
  const h = Math.max(0, (now - at) / 3600_000)
  return base + (value - base) * Math.pow(0.5, h / halfLifeHours)
}

/** 解析模型判心情的结果：{delta, reason, confidence}；解析不了返回 null。 */
export function parseMoodJudge(out) {
  const m = String(out || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0])
    const delta = Math.max(-15, Math.min(15, Math.round(Number(j.delta) || 0)))
    const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0))
    return { delta, reason: String(j.reason || '').slice(0, 40), confidence }
  } catch (error) {
    return null
  }
}

export function createMood({ getConfig, dsh, log, getPersonality }) {
  return createEmotionSystem({ getConfig, dsh, log, moodEffects, scoreText, decayed, moodLabel, MOOD_STYLE, getPersonality })
}

// ---------------- 主动搭话 ----------------

export function createSpeakUp({ getConfig, hub, log, isMuted, memory }) {
  const stateIdentity = Symbol('persona')
  const stateEpoch = Symbol('epoch')
  const file = (id = personaId(getConfig())) => join(identityDir(getConfig(), id), 'speakup.json')
  const load = () => {
    const id = personaId(getConfig())
    const state = readJson(file(id), () => ({ day: '', count: 0, nextAt: 0, last: 0 }))
    Object.defineProperty(state, stateIdentity, { value: id })
    Object.defineProperty(state, stateEpoch, { value: identityHistoryBoundary(getConfig(), id, { create: false }).epoch })
    return state
  }
  const save = (s) => {
    if (identityHistoryBoundary(getConfig(), s[stateIdentity], { create: false }).epoch === s[stateEpoch]) writeJson(file(s[stateIdentity]), s)
  }

  function schedule(s, cfg) {
    const min = cfg.minIntervalMinutes
    const max = cfg.maxIntervalMinutes
    s.nextAt = Date.now() + (min + Math.random() * (max - min)) * 60_000
  }

  // 私聊里的「最近一次来往」：只看和主人的私聊，群里再热闹也不影响她想你
  const lastPrivateAt = () => Math.max(hub.lastOwnerChatAt || 0, hub.lastBotToOwner?.at || 0)
  const privateGap = (last) => last ? `距离上次私聊已过 ${elapsedChatTime(last, Date.now())}。` : '手头没有最近一次私聊的时间。'
  const awakeNow = (c) => inQuietHours(chatHour(), [c.awakeFrom, c.awakeTo])
  function refreshDay(s) {
    const now = Date.now(), today = chatDay(now)
    // Preserve today's count when upgrading from local Date.toDateString keys.
    const legacyToday = s.day === new Date(now).toDateString() && (!s.last || chatDay(s.last) === today)
    if (s.day !== today) Object.assign(s, { day: today, count: legacyToday ? s.count : 0 })
  }

  // 每次换个由头，免得句句都是「在干嘛」
  const ANGLES = [
    '分享一件你今天遇到的小事或想到的东西',
    '接着你们上次聊的话题，问问后来怎么样了',
    '想起记忆里关于对方的一件事，顺口提一句或关心一下',
    '问问对方现在在干嘛、吃了没、累不累',
    '撒个娇或者吐槽一句，说你有点无聊',
    '随手发个表情包或者一句没头没尾的感慨',
    '看看现在几点，按时间说点应景的（早上、饭点、深夜）',
  ]
  const BLANK_ANGLES = [
    '简短问候对方',
    '询问对方愿不愿意介绍自己',
    '如果有真实的最近话题，可以询问后续',
  ]

  async function fire(reason = '定时', { nudge = false, idleOnly = false } = {}) {
    const cfg = getConfig()
    const blank = isBlankPersona(personaId(cfg))
    const owner = blank ? '对方' : cfg.ownerName || '主人'
    const angles = blank ? BLANK_ANGLES : ANGLES
    const angle = angles[Math.floor(Math.random() * angles.length)]
    const prompt = nudge
      ? `【系统提醒，不是${owner}说的话】你上次跟${owner}说「${String(hub.lastBotToOwner?.text || '').slice(-60)}」，之后没有收到新消息。可以轻轻追一句或换个话题；别催、别抱怨，也别从没回复猜对方在做什么。觉得时机不合适就只回 [沉默]。`
      : blank
        ? `【系统提醒，不是对方说的话】可以主动和对方说一句话。这次可以${angle}。只依据实际互动和记忆，别编造经历或既有关系；不想说就只回 [沉默]。`
        : `【系统提醒，不是${owner}说的话】${privateGap(lastPrivateAt())}想主动找${owner}说点什么。这次的由头可以是：${angle}。优先用手里真实的素材（最近做过的事、记忆里的、聊天流水里能查到的），没有真实素材就别硬找，也不要编；用你自己的口气，一两句就好，别用模板、别解释为什么来找；实在不想说就只回 [沉默]。`
    log.info(`主动搭话（${reason}）`)
    return hub.pushToSession({ chatId: `private:${cfg.ownerQQ}`, kind: 'private', userId: cfg.ownerQQ, nickname: owner }, [{ type: 'text', text: prompt }], '', { idleOnly })
  }

  /** 找白名单里的人：不提主人的事，这是她和对方自己的聊天。 */
  async function fireFriend(qq) {
    const blank = isBlankPersona(personaId(getConfig()))
    const angles = blank ? BLANK_ANGLES : ANGLES
    const angle = angles[Math.floor(Math.random() * angles.length)]
    const prompt = blank
      ? `【系统提醒，不是对方说的话】可以主动和对方说一句话。这次可以${angle}。只依据真实互动，别编造经历或关系，也不要透露其他人的私事。`
      : `【系统提醒，不是对方说的话】${privateGap(hub.lastPrivateAt?.(qq))}想主动找对方说点什么。这次的由头：${angle}。只说你和对方之间的事，别提主人或别人的私事。`
    log.info(`主动搭话（白名单 ${qq}）`)
    return hub.pushToSession({ chatId: `private:${qq}`, kind: 'private', userId: qq, nickname: qq }, [{ type: 'text', text: prompt }], '', { idleOnly: true })
  }

  /** 白名单：每人单独算次数和间隔，一分钟最多找一个人，不一口气群发。 */
  async function tickFriends(cfg, s) {
    const c = cfg.speakUp
    if (!awakeNow(c)) return false
    s.friends = s.friends || {}
    for (const qq of c.allow || []) {
      const chatId = `private:${qq}`
      if (String(qq) === String(cfg.ownerQQ) || isMuted?.(chatId) || hub.isChatBusy?.(chatId) || memory?.()?.dislikes?.(qq)) continue
      const f = s.friends[qq] || (s.friends[qq] = {})
      refreshDay(f)
      if (!f.nextAt) schedule(f, c)
      if (Date.now() - (hub.lastPrivateAt?.(qq) || 0) > c.idleMinutes * 60_000 && f.count < c.maxPerDay && Date.now() >= f.nextAt) {
        if (await fireFriend(qq) === false) continue
        f.count++
        f.last = Date.now()
        schedule(f, c)
        save(s)
        return true
      }
    }
    return false
  }

  let ticking = false
  async function tick() {
    if (ticking) return
    ticking = true
    try { return await tickOnce() } finally { ticking = false }
  }

  async function tickOnce() {
    const cfg = getConfig()
    const c = cfg.speakUp
    if (!cfg.enabled || !c.enabled) return
    if (cfg.ext?.purpose?.enabled === true) return // 目的引擎开着时由它主动找人，两套都跑同一个人会被找两次
    const ownerChatId = `private:${cfg.ownerQQ}`
    if (isMuted?.(ownerChatId) || hub.isChatBusy?.(ownerChatId)) {
      const s = load()
      if (!(await tickFriends(cfg, s))) save(s)
      return
    }
    const s = load()
    refreshDay(s)
    if (!s.nextAt) schedule(s, c)
    const awake = awakeNow(c)
    const idleOk = Date.now() - lastPrivateAt() > c.idleMinutes * 60_000
    // 追问：她最后一句是在问主人、主人 15~40 分钟没回，有一半的机会轻轻追一句（每句最多追一次，不占每天的次数）
    const lb = hub.lastBotToOwner || { at: 0, text: '' }
    const quiet = Date.now() - lb.at
    if (awake && c.nudge && lb.at > (hub.lastOwnerChatAt || 0) && lb.at !== s.nudgedFor && /[？?]|吗|呢|嘛|没$/.test(lb.text.trim()) && quiet > 15 * 60_000 && quiet < 40 * 60_000) {
      if (Math.random() < 0.5 && await fire('追问', { nudge: true, idleOnly: true }) === false) return
      s.nudgedFor = lb.at
      save(s)
      return
    }
    if (awake && idleOk && s.count < c.maxPerDay && Date.now() >= s.nextAt) {
      if (await fire('定时', { idleOnly: true }) === false) return
      s.count++
      s.last = Date.now()
      schedule(s, c)
      save(s)
      return
    }
    if (!(await tickFriends(cfg, s))) save(s)
  }

  return { tick, fire, state: load }
}

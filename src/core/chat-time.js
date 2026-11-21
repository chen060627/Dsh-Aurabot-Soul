// QQ conversation timestamps use China Standard Time even on UTC hosts.
const clock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

/** OneBot uses Unix seconds. Some gateways provide milliseconds. */
export function oneBotMessageTime(value, now = Date.now()) {
  if (typeof value !== 'number' && typeof value !== 'string') return 0
  const raw = Number(value)
  const at = raw < 1e12 ? raw * 1000 : raw
  return Number.isFinite(at) && at > 0 && at <= now + 5000 ? Math.min(at, now) : 0
}

export function chatTime(at) {
  const date = new Date(Number(at))
  return Number(at) > 0 && Number.isFinite(date.getTime()) ? clock.format(date) : '时间未知'
}

export const chatDay = (at = Date.now()) => chatTime(at).slice(0, 10)
export const chatHour = (at = Date.now()) => Number(chatTime(at).slice(11, 13))

export function messageTimeLabel(at, observedOnly = false) {
  return observedOnly ? `${chatTime(at)} 收到，发送时间未知` : chatTime(at)
}

export function elapsedChatTime(from, to) {
  const minutes = Math.floor(Math.max(0, to - from) / 60_000)
  if (!minutes) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60), rest = minutes % 60
  if (hours < 24) return `${hours} 小时${rest ? ` ${rest} 分钟` : ''}`
  return `${Math.floor(hours / 24)} 天${hours % 24 ? ` ${hours % 24} 小时` : ''}`
}

export const chatTimeGuidance = '用最后一个【系统时间】和原话的发送时间判断先后。历史里的「刚刚、今天、明天」属于当时；只有接收时间时，不推算原话发生于几点。'
  + '优先采用本人最新的明确更新，分清打算、出发、到达、进行中、完成和取消。短时间内别跳过中间环节或催后续；过了一段时间，旧的临时状态也不能当成仍在进行。'
  + '时间流逝不能证明进度。进度未知时接眼前的话题；对方在聊这件事且有必要时才轻轻问一句。迟到的旧消息、引用、旧摘要、你的猜测和草稿都不能覆盖本人后来明确说过的进度。自然接话，不用主动报时间。'
  + '例如，一小时前说去洗澡，只知道对方当时表示要去；三分钟前说刚出发去吃饭，只知道已经出发。等对方明确更新再判断洗完、到店或吃完。'

import { normalizeForMatch } from '../security/leak-guard.js'

export const BLOCKED_REPLY_PHRASES = Object.freeze([
  '睡吧，我守着。',
  '这话我记下了。',
  '这话我心里有数。',
  '你这话是在问别人，还是在问自己？',
  '行，这话我认。',
  '这话，你自己信吗？',
  '这笔账，我记着。',
  '我听着，你往下讲。',
])

const TRADITIONAL = { 著: '着', 這: '这', 話: '话', 記: '记', 裡: '里', 裏: '里', 數: '数', 問: '问', 別: '别', 還: '还', 認: '认', 嗎: '吗', 筆: '笔', 帳: '账', 賬: '账', 聽: '听', 講: '讲' }
const needles = BLOCKED_REPLY_PHRASES.map((phrase) => normalizeForMatch(phrase).chars).sort((a, b) => b.length - a.length)
const lead = /[「『“‘"'（(【\[*_`~\p{Cf}]/u
const tail = /[「」『』“”‘’"'）)】\]*_`~，、。；：！？,.!?;:… \t\u3000\p{Cf}]/u

// Ignore delivery tags when matching, but keep them in the original reply so
// neighbouring text, voice, quotes and attachments keep their own transport.
const DELIVERY_TOKENS = /[<＜][\/／]?(?:voice|reply|at|poke|sticker|face|br)\b[^<>＜＞\r\n]*[>＞]|!\[[^\]\r\n]*\]\(\s*[^)\s]+\s*\)/gi

export function blockedReplyRanges(raw) {
  if (!raw) return []
  const tags = [...raw.matchAll(DELIVERY_TOKENS)].map((match) => ({ start: match.index, end: match.index + match[0].length }))
  const masked = raw.replace(DELIVERY_TOKENS, (tag) => ' '.repeat(tag.length)).replace(/\p{Cf}/gu, (ch) => ' '.repeat(ch.length))
  const { chars, starts, ends } = normalizeForMatch(masked)
  const charsForMatch = chars.map((ch) => TRADITIONAL[ch] || ch)
  const ranges = []
  for (let i = 0; i < charsForMatch.length; i++) {
    const match = needles.find((phrase) => phrase[0] === charsForMatch[i] && phrase.every((ch, index) => ch === charsForMatch[i + index]))
    if (!match) continue
    let start = starts[i], end = ends[i + match.length - 1]
    const left = tags.findLast((tag) => tag.end <= start)?.end ?? 0
    const right = tags.find((tag) => tag.start >= end)?.start ?? raw.length
    while (start > left && lead.test(raw[start - 1])) start--
    while (end < right && tail.test(raw[end])) end++
    for (const tag of tags) {
      if (tag.end <= start) continue
      if (tag.start >= end) break
      if (tag.start > start) ranges.push({ start, end: tag.start })
      start = tag.end
    }
    if (start < end) ranges.push({ start, end })
    i += match.length - 1
  }
  return ranges
}

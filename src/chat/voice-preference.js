// Recognise explicit requests about voice in the current conversation.
// Ambiguous questions are left to the model and do not change the setting.
export function voicePreferenceRequest(text) {
  const t = String(text || '').replace(/\s+/g, '').slice(0, 500)
  if (!t) return ''
  const voice = '(?:语音条|语音消息|语音)'
  const stop = new RegExp(`(?:别|不要|不许|禁止|停止|停发|不用|无需|不再|不能|不准|没必要|不想听).{0,10}${voice}`)
  const stopAfter = new RegExp(`${voice}.{0,5}(?:别发|不要发|不许发|不要了|不用了|停掉|关掉)`)
  if (stop.test(t) || stopAfter.test(t) || /(?:只发文字|只用文字|只打字|打字就好|文字就好|打字回复就好)/.test(t)) return 'off'
  if (/(?:为什么|怎么|是不是|有没有|不是|刚才|之前|以前).{0,12}(?:发|用|听).{0,5}语音/.test(t)) return ''
  const resume = new RegExp(`(?:可以|允许|恢复|继续|重新|再给我|给我|发个|发一条|发条|来个|来一条|来条|用).{0,8}${voice}`)
  const resumeAfter = new RegExp(`${voice}.{0,6}(?:可以发|恢复|继续|说|回|念)`)
  return resume.test(t) || resumeAfter.test(t) ? 'on' : ''
}

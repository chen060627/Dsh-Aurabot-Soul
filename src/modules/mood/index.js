// 内置模块：心情。聊天让她开心或低落，心情影响她发表情、发语音的频率和回复快慢，也会写进她的上下文。
// 导出 createMood 的返回值：nudge(变化, 原因)、label()、state()、effects()、contextLine()、observe()、judge()。

import { createMood } from '../../features/companion.js'

export default {
  id: 'mood',
  name: '心情',
  version: '2.0.0',
  description: '多维持续情绪：结合人格与聊天变化，逐渐恢复并影响后续交流',
  tab: 'mood',
  files: ['features/companion.js', 'features/emotions.js'],
  setup(api) {
    const mood = createMood({ getConfig: api.config, dsh: api.dsh, log: api.log, getPersonality: (chatId, userId) => {
      if (!chatId) return ''
      const group = String(chatId).startsWith('group:')
      const chat = { chatId, kind: group ? 'group' : 'private', groupId: group ? String(chatId).slice(6) : '', userId: group ? String(userId || '') : String(chatId).slice(8) }
      return (api.use?.('memory')?.growth?.(chat) || []).filter((item) => item.active).map((item) => item.text).join('；').slice(0, 1000)
    } })
    api.context(({ chat, userText }) => (chat.kind === 'system' ? '' : mood.contextLine({ chatId: chat.chatId, userText })))
    api.on('activity', (a) => {
      const cfg = api.config()
      if (a.kind === 'in' && a.text) mood.observe(a.text, a.nickname, { direct: a.direct, owner: a.owner, chatId: a.chatId, userId: a.userId })
      // 模型判心情（开了才判）：系统提醒开头的是她自己主动找人
      if (a.kind === 'out' && a.confirmed && a.reply && !String(a.chatId).startsWith('system:')) {
        const speakUp = String(a.userText).trimStart().startsWith('【系统提醒')
        const conversation = a.confirmed && a.conversation && !speakUp
        const angerRecorded = a.confirmed && mood.observeReply(a.deliveredText || a.reply, { chatId: a.chatId, userText: conversation ? a.userText : '' })
        mood.judge({ userText: a.userText, reply: a.reply, who: String(a.chatId).startsWith('group:') ? '群里的人' : String(a.chatId) === `private:${cfg.ownerQQ}` ? cfg.ownerName || '主人' : '对方', chatId: a.chatId, origin: speakUp ? 'speak-up' : 'user', confirmed: conversation, angerRecorded }).catch(() => {})
      }
    })
    return mood
  },
}

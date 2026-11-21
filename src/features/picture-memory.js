// 每个人格独立保存喜欢的图片及其由人格写下的意义。
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJson } from '../core/store.js'
import { mimeOf } from '../chat/inbound.js'

const MAX_BYTES = 10 * 1024 * 1024
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const ID = /^[a-f0-9-]{36}$/
const clip = (value, max = 500) => [...String(value || '').trim()].slice(0, max).join('')

export function createPictureMemory({ directory }) {
  const dir = () => join(directory(), 'picture-memory')
  const index = () => join(dir(), 'index.json')
  const load = () => {
    if (!existsSync(index())) return { limit: 100, items: [] }
    let raw
    try { raw = JSON.parse(readFileSync(index(), 'utf8')) } catch { throw new Error('图片记忆索引无法读取；原文件已保留，请从备份恢复') }
    if (!raw || !Number.isInteger(raw.limit) || raw.limit < 0 || raw.limit > 1000 || !Array.isArray(raw.items) || raw.items.some((it) => !ID.test(String(it?.id)) || !EXT[it?.mime] || typeof it.description !== 'string' || typeof it.reason !== 'string')) throw new Error('图片记忆索引格式不正确；原文件已保留，请从备份恢复')
    return { limit: raw.limit, items: raw.items }
  }
  const save = (state) => writeJson(index(), state)
  const path = (it) => join(dir(), `${it.id}.${EXT[it.mime]}`)
  const status = () => { const s = load(); return { limit: s.limit, items: s.items.slice().reverse(), count: s.items.length } }
  const get = (id) => ID.test(String(id || '')) ? load().items.find((it) => it.id === id) : undefined
  const bytes = (id) => { const item = get(id); if (!item) return null; try { return readFileSync(path(item)) } catch { return null } }
  const setLimit = (value) => {
    const limit = Number(value)
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000) return { ok: false, message: '数量上限须为 0 到 1000 的整数' }
    const state = load(); state.limit = limit; save(state)
    return { ok: true, limit, count: state.items.length }
  }
  const add = ({ buffer, description, reason, chatId, senderId }) => {
    const desc = clip(description), why = clip(reason)
    if (!desc || !why) return { ok: false, message: '请写下图片内容和喜欢或珍惜它的原因' }
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_BYTES) return { ok: false, message: '图片为空或超过 10 MB' }
    const mime = mimeOf(buffer)
    if (!EXT[mime]) return { ok: false, message: '只支持 JPEG、PNG、GIF 或 WebP 图片' }
    const state = load()
    const hash = createHash('sha256').update(buffer).digest('hex')
    if (state.items.some((it) => it.hash === hash)) return { ok: false, message: '这张图片已保存在当前人格的图片记忆中' }
    if (state.items.length >= state.limit) return { ok: false, message: '图片记忆已满；原有图片都保留，请在面板增加上限或删除不需要的图片' }
    const item = { id: randomUUID(), hash, mime, description: desc, reason: why, chatId: String(chatId || ''), senderId: String(senderId || ''), at: Date.now() }
    mkdirSync(dir(), { recursive: true })
    const file = path(item)
    writeFileSync(file, buffer, { flag: 'wx' })
    try { state.items.push(item); save(state) } catch (error) { try { unlinkSync(file) } catch {} ; throw error }
    return { ok: true, message: '已保存图片记忆', item }
  }
  const edit = (id, description, reason) => {
    const state = load(), item = state.items.find((it) => it.id === id)
    if (!item) return { ok: false, message: '图片不存在' }
    const desc = clip(description), why = clip(reason)
    if (!desc || !why) return { ok: false, message: '内容和原因都不能为空' }
    item.description = desc; item.reason = why; save(state)
    return { ok: true }
  }
  const remove = (id) => {
    const state = load(), item = state.items.find((it) => it.id === id)
    if (!item) return { ok: false, message: '图片不存在' }
    state.items = state.items.filter((it) => it.id !== id); save(state)
    try { if (existsSync(path(item))) unlinkSync(path(item)) } catch {}
    return { ok: true }
  }
  const search = (query = '') => {
    const q = clip(query, 100).toLowerCase(), items = load().items
    if (!q) return items.slice(-20).reverse()
    const pieces = [...new Set([...q.split(/[\s，,。;；]+/), ...[...q].slice(0, -1).map((c, i) => c + [...q][i + 1])].filter((x) => x.length >= 2))]
    return items.map((it) => ({ it, score: pieces.filter((piece) => `${it.description} ${it.reason}`.toLowerCase().includes(piece)).length })).filter((x) => x.score).sort((a, b) => b.score - a.score || b.it.at - a.it.at).slice(0, 20).map((x) => x.it)
  }
  return { status, get, bytes, setLimit, add, edit, remove, search }
}

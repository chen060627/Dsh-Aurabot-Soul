import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { dataDir, readJson, writeJson } from './store.js'

export const BLANK_PERSONA = '__aurabot_blank__'
export function isBlankPersona(id) {
  return id === BLANK_PERSONA || /^__aurabot_blank__-[a-f0-9]{16}$/.test(String(id || ''))
}

export function personaId(config) {
  return String(config?.persona?.current || BLANK_PERSONA)
}

// The first persona keeps the original paths, including existing installations.
export function identityDir(config, id = personaId(config)) {
  const file = dataDir('identity-owner.json')
  let owner = readJson(file, null)?.persona
  if (!owner) {
    owner = isBlankPersona(personaId(config)) ? 'dafeiyu' : personaId(config)
    try { writeJson(file, { persona: owner }) } catch {}
  }
  if (id === owner) return dataDir()
  const key = createHash('sha256').update(String(id)).digest('hex').slice(0, 24)
  return join(dataDir(), 'identities', key)
}

// QQ history predates an identity's creation or reset. Never silently import it
// into a new conversation. Unknown timestamps are rejected by the caller.
export function identityHistoryBoundary(config, id = personaId(config), { reset = false, create = true } = {}) {
  const file = join(identityDir(config, id), 'history-boundary.json')
  const previous = readJson(file, null)
  if (!reset && Number.isFinite(previous?.since) && previous.since > 0 && typeof previous.epoch === 'string') return previous
  if (!reset && !create) return { since: 0, epoch: '' }
  const boundary = { since: Date.now(), epoch: randomUUID() }
  writeJson(file, boundary)
  return boundary
}

export function afterHistoryBoundary(message, boundary, now = Date.now()) {
  const raw = Number(message?.time)
  if (!Number.isFinite(raw) || raw <= 0) return false
  const time = raw < 1e12 ? raw * 1000 : raw
  return time > boundary && time <= now + 5000
}

// Rules apply to group traffic only. A wildcard group applies to every group.
export function normalizeGroupBlacklist(value) {
  const rules = Array.isArray(value) ? value : String(value || '').split(/[\n,，;；]+/)
  return [...new Set(rules.map((rule) => {
    const match = String(rule || '').trim().match(/^(\*|\d+)\s*[:：]\s*(\d+)$/)
    return match ? `${match[1]}:${match[2]}` : ''
  }).filter(Boolean))]
}

export function isGroupUserBlocked(cfg, groupId, userId) {
  const group = String(groupId || ''), user = String(userId || '')
  if (!/^\d+$/.test(group) || !/^\d+$/.test(user)) return false
  const rules = cfg?.group?.blacklist || []
  return rules.includes(`${group}:${user}`) || rules.includes(`*:${user}`)
}

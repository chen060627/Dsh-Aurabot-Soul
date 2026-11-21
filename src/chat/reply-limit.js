// Limit the number of text/voice bubbles without cutting away the answer.
// Media and actions keep their existing delivery semantics.
export function limitReplyBubbles(items, maximum) {
  const max = Math.max(1, Math.min(30, Math.floor(Number(maximum) || 1)))
  const indices = items.map((item, index) => ['text', 'voice'].includes(item.kind) ? index : -1).filter((index) => index >= 0)
  if (indices.length <= max) return items

  const result = items.slice()
  // Consecutive groups of dialogue are joined with newlines; even long lists or
  // precise information are preserved in full instead of being truncated.
  let start = 0
  for (let group = 0; group < max; group++) {
    const count = Math.ceil((indices.length - start) / (max - group))
    const slice = indices.slice(start, start + count)
    start += count
    const first = result[slice[0]]
    const parts = slice.map((index) => result[index])
    result[slice[0]] = {
      ...first,
      kind: parts.every((part) => part.kind === 'voice') ? 'voice' : 'text',
      value: parts.map((part) => part.value).join('\n'),
    }
    for (const index of slice.slice(1)) result[index] = null
  }
  return result.filter(Boolean)
}

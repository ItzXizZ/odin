/** Pull every complete top-level {...} JSON object out of a streaming buffer. */
export function drainJsonObjects(buffer: string): { objs: unknown[]; rest: string } {
  const objs: unknown[] = []
  let idx = 0
  let consumed = 0
  while (idx < buffer.length) {
    while (idx < buffer.length && buffer[idx] !== '{') idx++
    if (idx >= buffer.length) break
    let depth = 0
    let inStr = false
    let esc = false
    let end = -1
    for (let j = idx; j < buffer.length; j++) {
      const c = buffer[j]
      if (esc) { esc = false; continue }
      if (c === '\\') { if (inStr) esc = true; continue }
      if (c === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (c === '{') depth++
      else if (c === '}') { depth--; if (depth === 0) { end = j; break } }
    }
    if (end === -1) break
    try { objs.push(JSON.parse(buffer.slice(idx, end + 1))) } catch { /* skip */ }
    idx = end + 1
    consumed = idx
  }
  return { objs, rest: buffer.slice(consumed) }
}

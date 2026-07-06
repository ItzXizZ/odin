/** Server-side mirror of src/lib/aiText.ts policy helpers. */

export const ODIN_GLOBAL_SYSTEM_SUFFIX = `

GLOBAL OUTPUT RULE (mandatory, zero exceptions): Never use em dashes (—) or en dashes (–) as punctuation in any output you generate. Use commas, periods, semicolons, parentheses, or colons instead. This applies to every string field, message, note, edit, and prose block you emit.`

export function augmentSystemPrompt(system) {
  const base = typeof system === 'string' ? system.trim() : ''
  if (base.includes('GLOBAL OUTPUT RULE')) return base
  return base + ODIN_GLOBAL_SYSTEM_SUFFIX
}

export function stripEmDashes(text) {
  if (typeof text !== 'string' || !text) return text
  return text
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/[—–]/g, ', ')
    .replace(/,\s*,+/g, ', ')
    .replace(/,\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

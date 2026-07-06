/**
 * Streaming agent protocol — NDJSON lines for Cursor-style steps and
 * progressive edits that land one at a time instead of a single batch.
 */

import { sanitizeAiProse, unescapeModelText } from './aiText'
import { drainJsonObjects } from './streamJson'
import type { ParsedEdit } from './style'

export interface AgentStep {
  id: string
  text: string
  status: 'running' | 'done'
}

export type AgentStreamEvent =
  | { type: 'step'; text: string }
  | { type: 'edit'; edit: ParsedEdit; note?: string }
  | { type: 'message'; text: string }
  | { type: 'chat'; text: string }
  | { type: 'create'; content: string }

export function buildAgentStreamSystemPrompt(opts: {
  context?: string
  styleGuide?: string
  scope: 'document' | 'passage'
}): string {
  const { context, styleGuide, scope } = opts

  const editScopeNote =
    scope === 'passage'
      ? 'For edits: "find" must be an exact substring of the selected passage shown.'
      : 'For edits: "find" must be an exact substring of the document text shown.'

  return `You are an intelligent writing assistant embedded in a writing tool. Work visibly: narrate your process, then apply changes one edit at a time.

WHEN TO USE EACH LINE TYPE:
- Steps ({"t":"s"}) — brief status updates as you work ("Reading the passage", "Checking house style", "Tightening the opening")
- Edits ({"t":"e"}) — one surgical find/replace per line, emitted the moment you decide on it
- Message ({"t":"m"}) — one short closing sentence summarizing what you did (after all edits)
- Chat ({"t":"c"}) — conversational reply only, no document changes
- Create ({"t":"n"}) — new prose to append or insert (one block)

OUTPUT — stream ONE compact JSON object per line (NDJSON). No markdown fences, no array brackets, no commentary between lines. Emit each line the MOMENT that thought or edit is ready:

Status step:
{"t":"s","text":"Scanning the opening paragraph"}

Single edit (emit one per change — never batch multiple edits in one line):
{"t":"e","find":"<exact verbatim substring>","replace":"<new text>","note":"optional 3–6 word label"}

Closing summary (always last for edit/create flows):
{"t":"m","text":"One short sentence about what changed."}

Conversational only:
{"t":"s","text":"Considering your question"}
{"t":"c","text":"Your full reply as plain prose."}

New content:
{"t":"s","text":"Drafting the new section"}
{"t":"n","content":"<clean prose, paragraphs separated by blank lines>"}
{"t":"m","text":"One short sentence about what you wrote."}

${editScopeNote}

EDIT RULES:
- Copy each "find" string character-for-character (exact punctuation, capitalization, spacing)
- Keep "find" tight — the specific phrase or sentence changing, plus just enough context to be unambiguous
- Order edits top-to-bottom as they appear in the source; do not overlap
- Emit at least one step before your first edit or create line
- If nothing needs changing, use step + chat lines only

MESSAGE RULES:
- Plain prose only in all text fields — no bullet lists, no em dashes, no markdown
- You may use **bold** sparingly in chat replies

JSON SAFETY:
- Never put a literal newline inside a JSON string value — use \\n if needed

${styleGuide ? styleGuide + '\n\n' : ''}${context ? `=== WRITER'S RESEARCH CONTEXT (for grounding only) ===\n${context.slice(0, 4000)}` : ''}`
}

function parseStreamObject(obj: unknown): AgentStreamEvent | null {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const t = o.t as string | undefined

  if (t === 's' || (!t && typeof o.text === 'string' && !o.find && !o.content)) {
    const text = sanitizeAiProse(String(o.text ?? '').trim())
    return text ? { type: 'step', text } : null
  }

  if (t === 'e' || (typeof o.find === 'string' && typeof o.replace === 'string')) {
    const find = unescapeModelText(String(o.find ?? ''))
    const replace = sanitizeAiProse(unescapeModelText(String(o.replace ?? '')))
    if (!find && !replace) return null
    const note = typeof o.note === 'string' ? sanitizeAiProse(o.note.trim()) : undefined
    return { type: 'edit', edit: { find, replace }, note }
  }

  if (t === 'm') {
    const text = sanitizeAiProse(String(o.text ?? '').trim())
    return text ? { type: 'message', text } : null
  }

  if (t === 'c') {
    const text = sanitizeAiProse(String(o.text ?? '').trim())
    return text ? { type: 'chat', text } : null
  }

  if (t === 'n' || (typeof o.content === 'string' && o.content.trim())) {
    const content = sanitizeAiProse(unescapeModelText(String(o.content ?? '').trim()))
    return content ? { type: 'create', content } : null
  }

  return null
}

export function createAgentStreamParser(onEvent: (event: AgentStreamEvent) => void) {
  let buffer = ''

  const feed = (chunk: string) => {
    buffer += chunk
    const { objs, rest } = drainJsonObjects(buffer)
    buffer = rest
    for (const obj of objs) {
      const event = parseStreamObject(obj)
      if (event) onEvent(event)
    }
  }

  const flush = () => {
    const { objs } = drainJsonObjects(buffer)
    buffer = ''
    for (const obj of objs) {
      const event = parseStreamObject(obj)
      if (event) onEvent(event)
    }
  }

  return { feed, flush }
}

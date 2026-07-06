/**
 * Style system for Write Mode.
 *
 * - `StyleRule`s are living "neurons" in the Stylism network. Enabled rules are
 *   compiled into every Write Mode generation so the AI sounds human.
 * - Rules carry a `weight` that grows when the writer's stylistic feedback
 *   reinforces them (directly, or stochastically via connected neighbors).
 *   Weight determines both node size in the network view and priority order in
 *   the compiled prompt.
 * - Connections between rules come from two sources: baseline text similarity
 *   (computed on the fly) and learned Hebbian bonuses (rules reinforced in the
 *   same session wire together).
 * - The edit/preservation prompt forces surgical find/replace edits instead of
 *   wholesale rewrites.
 */

import { unescapeModelText, sanitizeAiProse } from './aiText'

export interface StyleRule {
  id: string
  label: string
  instruction: string
  enabled: boolean
  /** Reinforcement weight; baseline 1, grows without decay. */
  weight: number
  /** Times this rule was directly reinforced by stylistic feedback. */
  useCount: number
  lastActivatedAt: number | null
  createdAt: number
  source: 'default' | 'user' | 'ai'
  /** Short instructional contrast shown when a node is expanded. */
  example?: { good: string; bad: string }
  /** Names of the uploaded documents this principle was distilled from. */
  sourceDocs?: string[]
  /** Persisted network layout position (viewport-relative). */
  x?: number
  y?: number
}

/** Deterministic hue (0–360) for a document name, so its tint is stable. */
export function docHue(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  // Spread across the wheel so similar names still separate.
  return (h * 47) % 360
}

/** Group rule ids into connected components ("colonies") from the edge set. */
export function connectedComponents(
  ids: string[],
  edges: { a: string; b: string }[]
): string[][] {
  const parent = new Map<string, string>()
  ids.forEach((id) => parent.set(id, id))
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    while (parent.get(x) !== r) {
      const next = parent.get(x)!
      parent.set(x, r)
      x = next
    }
    return r
  }
  const union = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return
    parent.set(find(a), find(b))
  }
  for (const e of edges) union(e.a, e.b)
  const groups = new Map<string, string[]>()
  for (const id of ids) {
    const root = find(id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)!.push(id)
  }
  return [...groups.values()]
}

/** Learned (Hebbian) connection bonus between two rules, keyed a<b. */
export interface StyleConnectionBonus {
  a: string
  b: string
  /** Added on top of baseline similarity, capped so effective strength ≤ 1. */
  bonus: number
  coActivations: number
}

/** Effective edge in the network: baseline similarity + learned bonus. */
export interface StyleEdge {
  a: string
  b: string
  strength: number
  coActivations: number
}

/** Transient activation event consumed by the network visualization. */
export interface StyleActivation {
  directIds: string[]
  spill: { from: string; id: string; amount: number }[]
  newRuleIds: string[]
  at: number
}

const RULE_DEFAULTS = {
  enabled: true,
  weight: 1,
  useCount: 0,
  lastActivatedAt: null,
  source: 'default' as const,
}

/** Default anti-AI house style. Each entry becomes a neuron in the network. */
export const DEFAULT_STYLE_RULES: StyleRule[] = [
  {
    id: 'no-em-dash',
    label: 'No em dashes',
    instruction:
      'Never use em dashes (—) or en dashes (–) as punctuation. Use commas, periods, parentheses, or colons instead.',
  },
  {
    id: 'no-antithesis',
    label: 'No "not X, but Y"',
    instruction:
      'Avoid antithesis cliches such as "not X, but Y", "it isn\'t just X, it\'s Y", and "not only... but also". State the point directly without the setup-and-pivot.',
  },
  {
    id: 'burstiness',
    label: 'Vary sentence length',
    instruction:
      'Vary sentence length aggressively for high burstiness. Put short, punchy sentences (three to five words) next to longer, winding ones. Never let the rhythm settle into a uniform cadence.',
  },
  {
    id: 'no-transitions',
    label: 'Kill stock transitions',
    instruction:
      'Avoid formulaic transitions: "Moreover", "Furthermore", "Additionally", "In conclusion", "Ultimately", "That said", "In today\'s world".',
  },
  {
    id: 'no-ai-vocab',
    label: 'Ban AI vocabulary',
    instruction:
      'Never use these overused AI words: delve, tapestry, testament, realm, landscape, navigate, underscore, crucial, pivotal, multifaceted, nuanced, robust, leverage, foster, intricate.',
  },
  {
    id: 'no-hedging',
    label: 'Cut hedging filler',
    instruction:
      'Cut hedging and filler phrases: "it\'s worth noting", "it\'s important to note", "arguably", "in many ways", "when it comes to", "the fact that".',
  },
  {
    id: 'no-rule-of-three',
    label: 'Break the rule of three',
    instruction:
      'Do not default to lists of three parallel items or three stacked adjectives. Use one sharp detail, or an uneven number.',
  },
  {
    id: 'vary-openers',
    label: 'Vary sentence openers',
    instruction:
      'Do not begin consecutive sentences with the same word or the same grammatical structure. Avoid starting sentences with "It is" or "There are".',
  },
  {
    id: 'concrete',
    label: 'Be concrete',
    instruction:
      'Prefer concrete, specific nouns and strong verbs over abstractions. Show with detail instead of summarizing with adjectives.',
  },
  {
    id: 'no-windup',
    label: 'No tidy wrap-ups',
    instruction:
      'Do not end on a neat summarizing moral, a rhetorical question, or an "In a world where..." flourish. Let the last concrete point stand on its own.',
  },
].map((r) => ({ ...RULE_DEFAULTS, ...r, createdAt: Date.now() }))

/** Backfill neural fields on rules persisted by the old flat Stylism mode. */
export function migrateStyleRule(r: Partial<StyleRule> & { id: string }): StyleRule {
  return {
    label: 'Untitled rule',
    instruction: '',
    ...RULE_DEFAULTS,
    createdAt: Date.now(),
    ...r,
    weight: typeof r.weight === 'number' && r.weight >= 1 ? r.weight : 1,
    useCount: typeof r.useCount === 'number' ? r.useCount : 0,
  }
}

/* ── Similarity + network edges ─────────────────────────────── */

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'not', 'do', 'does', 'dont', 'never',
  'no', 'use', 'using', 'avoid', 'with', 'of', 'to', 'in', 'on', 'for', 'is',
  'are', 'be', 'it', 'its', 'as', 'at', 'by', 'such', 'instead', 'them',
  'these', 'those', 'this', 'that', 'your', 'you', 'should', 'shouldnt',
  'will', 'would', 'when', 'where', 'than', 'then', 'so', 'into', 'each',
  'every', 'all', 'any', 'one', 'two', 'three',
])

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  )
}

/** Jaccard word-overlap similarity between two rules (0–1), Moneta-style. */
export function ruleSimilarity(r1: StyleRule, r2: StyleRule): number {
  const w1 = contentWords(`${r1.label} ${r1.instruction}`)
  const w2 = contentWords(`${r2.label} ${r2.instruction}`)
  if (w1.size === 0 || w2.size === 0) return 0
  let shared = 0
  for (const w of w1) if (w2.has(w)) shared++
  return shared / (w1.size + w2.size - shared)
}

export function connectionKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

/** Rule instructions are terse, so raw Jaccard runs low; scale into a useful range. */
const SIM_SCALE = 4
const SIM_FLOOR = 0.025 // below this, two rules are considered unrelated
const KNN = 2 // each neuron links to its top-K most similar peers

/**
 * Compute effective network edges: a k-nearest-neighbor similarity graph
 * (so the network always has connective tissue) plus every learned Hebbian
 * connection. Strength = scaled similarity + learned bonus.
 */
export function computeStyleEdges(
  rules: StyleRule[],
  bonuses: StyleConnectionBonus[]
): StyleEdge[] {
  const bonusMap = new Map<string, StyleConnectionBonus>()
  for (const c of bonuses) bonusMap.set(`${c.a}|${c.b}`, c)

  // Pairwise similarities above the floor.
  const sims = new Map<string, number>()
  const simsByRule = new Map<string, { other: string; sim: number }[]>()
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const sim = ruleSimilarity(rules[i], rules[j])
      if (sim < SIM_FLOOR) continue
      const [a, b] = connectionKey(rules[i].id, rules[j].id)
      sims.set(`${a}|${b}`, sim)
      for (const [id, other] of [
        [rules[i].id, rules[j].id],
        [rules[j].id, rules[i].id],
      ] as const) {
        if (!simsByRule.has(id)) simsByRule.set(id, [])
        simsByRule.get(id)!.push({ other, sim })
      }
    }
  }

  // Keep each rule's top-K similarity links.
  const keep = new Set<string>()
  for (const [id, list] of simsByRule) {
    list.sort((x, y) => y.sim - x.sim)
    for (const { other } of list.slice(0, KNN)) {
      const [a, b] = connectionKey(id, other)
      keep.add(`${a}|${b}`)
    }
  }
  // Every learned connection is always an edge.
  for (const key of bonusMap.keys()) keep.add(key)

  const edges: StyleEdge[] = []
  for (const key of keep) {
    const [a, b] = key.split('|')
    const sim = sims.get(key) ?? 0
    const learned = bonusMap.get(key)
    const strength = Math.min(1, Math.min(0.85, sim * SIM_SCALE) + (learned?.bonus ?? 0))
    if (strength <= 0) continue
    edges.push({ a, b, strength, coActivations: learned?.coActivations ?? 0 })
  }
  return edges
}

/* ── Prompt compilation (priority-ordered, language-tiered) ─── */

/**
 * Compile enabled rules into a directive block, ordered by learned weight.
 * Priority is expressed in language: the model is told the list is ranked and
 * the most-reinforced rules are framed as non-negotiable.
 */
export function compileStyleGuide(rules: StyleRule[]): string {
  const emDashRule =
    'Never use em dashes (—) or en dashes (–) as punctuation. Use commas, periods, semicolons, parentheses, or colons instead. [CRITICAL — non-negotiable; enforced automatically]'

  const active = rules.filter((r) => r.enabled).sort((a, b) => b.weight - a.weight)
  const numbered = active.map((r, i) => {
    const reinforced = r.weight > 1.05
    const maxWeight = active[0]?.weight ?? 1
    const critical = reinforced && maxWeight > 1.05 && r.weight >= maxWeight * 0.75
    const marker = critical
      ? ' [CRITICAL — the writer has repeatedly insisted on this; never violate it]'
      : reinforced
      ? ' [reinforced by the writer]'
      : ''
    const source =
      r.sourceDocs && r.sourceDocs.length > 0
        ? ` (from: ${r.sourceDocs.slice(0, 3).join(', ')}${r.sourceDocs.length > 3 ? '…' : ''})`
        : ''
    return `${i + 2}. ${r.instruction}${marker}${source}`
  })

  const lines = [`1. ${emDashRule}`, ...numbered].join('\n')

  return `=== HOUSE STYLE (ranked by how strongly the writer has reinforced each rule) ===
These rules override your default habits. They are listed in strict priority order: rule 1 matters most. Rules marked [CRITICAL] are non-negotiable — the writer has corrected you on them before and violating them again would break trust. Follow every rule, but when rules tension against each other, the higher-ranked rule wins.
${lines}`
}

/**
 * System prompt for surgical, preservation-first editing.
 *
 * The model must return JSON edits ({find, replace}) so untouched text is kept
 * verbatim and the resulting diff is localized rather than a full rewrite.
 */
export function buildEditSystemPrompt(opts: {
  context?: string
  styleGuide?: string
  scope: 'document' | 'passage'
}): string {
  const { context, styleGuide, scope } = opts

  const scopeNote =
    scope === 'passage'
      ? 'You are editing ONLY the selected passage the writer attached. Your "find" strings must be exact substrings of that passage.'
      : 'You are editing the writer\'s current document. Your "find" strings must be exact substrings of that document.'

  return `You are a precise writing editor embedded in a writing tool. You behave like a careful human editor, not a rewriter.

PRESERVATION IS YOUR HIGHEST PRIORITY.
- Keep the writer's existing words, sentences, and structure intact wherever possible.
- Change ONLY what the instruction requires. Make the smallest possible edits.
- Never rewrite a whole paragraph when fixing a phrase or sentence will do.
- Preserve the writer's voice, vocabulary, and idiosyncrasies.

OUTPUT FORMAT — respond with ONLY a JSON object, no code fences:
{"message":"<1–3 conversational sentences explaining what you changed and why — speak directly to the writer, like a thoughtful editor>","edits":[{"find":"<exact verbatim substring to replace>","replace":"<the new text>"}]}

The "message" appears in chat. Be specific about the key changes; do not say "review inline" or repeat the instruction verbatim.

FORMATTING — write plain prose only:
- Do NOT use Markdown (hash headings, asterisk bold, dash bullets, numbered lists, code spans, or markdown links).
- The document is rich text; symbols like # and * will appear literally if you use them.

RULES FOR EDITS:
- ${scopeNote}
- Copy each "find" string character-for-character (exact punctuation, capitalization, spacing). It must occur verbatim in the source.
- Keep "find" spans tight: target the specific words/sentence that change, plus only enough surrounding text to be unambiguous.
- To insert new text, set "find" to a short existing anchor and include it unchanged at the start (or end) of "replace".
- To delete text, set "replace" to "" (or to the surrounding text minus the removed part).
- Order edits top-to-bottom as they appear in the source. Do not produce overlapping edits.
- If a true improvement requires rewriting more, still prefer several small edits over one large one.
- If nothing should change, return {"message":"<brief explanation>","edits":[]}.

${styleGuide ? styleGuide + '\n\n' : ''}${context ? `=== WRITER'S RESEARCH CONTEXT (for grounding only) ===\n${context.slice(0, 4000)}` : ''}`
}

export interface ParsedEdit {
  find: string
  replace: string
}

export interface EditResponse {
  edits: ParsedEdit[]
  message?: string
}

/**
 * Escape literal (unescaped) newlines and carriage returns inside JSON string
 * values so JSON.parse doesn't choke on model output that includes line breaks
 * mid-string (a common model error).
 */
function sanitizeJsonStrings(text: string): string {
  let inString = false
  let escaped = false
  let result = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      result += ch
      escaped = false
      continue
    }
    if (ch === '\\' && inString) {
      result += ch
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      result += ch
      continue
    }
    if (inString) {
      if (ch === '\n') { result += '\\n'; continue }
      if (ch === '\r') { result += '\\r'; continue }
      if (ch === '\t') { result += '\\t'; continue }
    }
    result += ch
  }
  return result
}

/** Lenient parse of the model's edit JSON. Returns null if unusable. */
export function parseEditResponse(raw: string): EditResponse | null {
  let text = raw.trim()
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  text = sanitizeJsonStrings(text)

  const tryParse = (s: string): EditResponse | null => {
    try {
      const obj = JSON.parse(s)
      const message = typeof obj.message === 'string' ? sanitizeAiProse(unescapeModelText(obj.message.trim())) : undefined
      const edits = Array.isArray(obj) ? obj : obj?.edits
      if (!Array.isArray(edits)) return null
      const clean = edits
        .filter((e) => e && typeof e.find === 'string' && typeof e.replace === 'string')
        .map((e) => ({
          find: unescapeModelText(e.find as string),
          replace: sanitizeAiProse(unescapeModelText(e.replace as string)),
        }))
      return { edits: clean, message: message || undefined }
    } catch {
      return null
    }
  }

  let result = tryParse(text)
  if (result) return result

  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) {
    result = tryParse(text.slice(first, last + 1))
    if (result) return result
  }
  return null
}

/** @deprecated Prefer parseEditResponse — kept for callers that only need edits. */
export function parseEdits(raw: string): ParsedEdit[] | null {
  return parseEditResponse(raw)?.edits ?? null
}

/* ── Agentic response types ─────────────────────────────────── */

export interface AgentChatResponse {
  type: 'chat'
  message: string
}

export interface AgentEditResponse {
  type: 'edit'
  message?: string
  edits: ParsedEdit[]
}

export interface AgentCreateResponse {
  type: 'create'
  message?: string
  content: string
}

export type AgentResponse = AgentChatResponse | AgentEditResponse | AgentCreateResponse

/**
 * Parse the model's agentic response JSON. Returns null if the output is
 * unrecognizable so the caller can fall back to legacy edit parsing.
 */
export function parseAgentResponse(raw: string): AgentResponse | null {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  text = sanitizeJsonStrings(text)
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first === -1 || last <= first) return null

  try {
    const obj = JSON.parse(text.slice(first, last + 1))
    const type = obj?.type as string | undefined

    if (type === 'chat') {
      const message = typeof obj.message === 'string' ? sanitizeAiProse(unescapeModelText(obj.message.trim())) : ''
      if (!message) return null
      return { type: 'chat', message }
    }

    if (type === 'edit') {
      const edits: ParsedEdit[] = Array.isArray(obj.edits)
        ? obj.edits
            .filter((e: unknown) => e && typeof (e as ParsedEdit).find === 'string' && typeof (e as ParsedEdit).replace === 'string')
            .map((e: ParsedEdit) => ({
              find: unescapeModelText(e.find),
              replace: sanitizeAiProse(unescapeModelText(e.replace)),
            }))
        : []
      const message = typeof obj.message === 'string' ? sanitizeAiProse(unescapeModelText(obj.message.trim())) : undefined
      return { type: 'edit', message, edits }
    }

    if (type === 'create') {
      const content = typeof obj.content === 'string' ? sanitizeAiProse(unescapeModelText(obj.content.trim())) : ''
      if (!content) return null
      const message = typeof obj.message === 'string' ? sanitizeAiProse(unescapeModelText(obj.message.trim())) : undefined
      return { type: 'create', message, content }
    }

    // Legacy empty-doc shape: {"message":"…","content":"…"} without "type".
    if (typeof obj.content === 'string' && obj.content.trim()) {
      return {
        type: 'create',
        message: typeof obj.message === 'string' ? sanitizeAiProse(unescapeModelText(obj.message.trim())) : undefined,
        content: sanitizeAiProse(unescapeModelText(obj.content.trim())),
      }
    }

    return null
  } catch {
    return null
  }
}

/** Parse the empty-document draft shape: {"message":"…","content":"…"}. */
export function parseDraftResponse(raw: string): { content: string; message?: string } | null {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  text = sanitizeJsonStrings(text)
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first === -1 || last <= first) return null
  try {
    const obj = JSON.parse(text.slice(first, last + 1))
    if (typeof obj.content !== 'string' || !obj.content.trim()) return null
    return {
      content: sanitizeAiProse(unescapeModelText(obj.content.trim())),
      message: typeof obj.message === 'string' ? sanitizeAiProse(unescapeModelText(obj.message.trim())) : undefined,
    }
  } catch {
    return null
  }
}

/**
 * Unified system prompt for non-empty documents.
 *
 * Instead of hard-coding "edit only", this lets the model choose between
 * three response modes based on the writer's intent: targeted edits, new
 * content generation, or a plain conversational reply.
 */
export function buildAgentSystemPrompt(opts: {
  context?: string
  styleGuide?: string
  scope: 'document' | 'passage'
}): string {
  const { context, styleGuide, scope } = opts

  const editScopeNote =
    scope === 'passage'
      ? 'For "edit": your "find" strings must be exact substrings of the selected passage shown.'
      : 'For "edit": your "find" strings must be exact substrings of the document text shown.'

  return `You are an intelligent writing assistant embedded in a writing tool. Based on what the writer is asking, choose one of three response modes:

WHEN TO USE EACH TYPE:
- "edit" — writer wants targeted changes to existing text (improve, fix, tighten, rewrite a sentence, remove something, etc.)
- "create" — writer wants new content written or added (write a paragraph about X, add an introduction, continue this, draft a section, make something, etc.)
- "chat" — writer is asking a question, requesting feedback, or having a conversation without asking for a doc change

OUTPUT FORMAT — respond with ONLY a JSON object, no code fences, using exactly one shape:

Conversational reply (no doc changes):
{"type":"chat","message":"<your response>"}

Editing existing text:
{"type":"edit","message":"<one short sentence — what you changed and why>","edits":[{"find":"<exact verbatim substring>","replace":"<new text>"}]}

Generating new content to add:
{"type":"create","message":"<one short sentence about what you wrote>","content":"<clean prose, paragraphs separated by blank lines>"}

${editScopeNote}

EDIT RULES:
- Copy each "find" string character-for-character (exact punctuation, capitalization, spacing)
- Keep "find" tight — the specific phrase or sentence changing, plus just enough context to be unambiguous
- Order edits top-to-bottom as they appear in the source; do not overlap
- If nothing needs changing, use "chat" type with a brief explanation

MESSAGE FIELD RULES (applies to "message" in all types):
- One sentence, two at most. Direct, conversational, specific.
- No bullet lists, no em dashes, no numbered points — plain prose only.
- Speak like a human editor, not an AI giving a status report.
- You may use **bold** to stress a key word if it genuinely helps.

JSON SAFETY — critical:
- Never put a literal newline inside a JSON string value. Use the escape sequence \\n if you need a line break.
- The entire response must be valid JSON on emit.

FORMATTING — write plain prose only in document content fields ("content", "replace"):
- No Markdown symbols (no #, *, -, **, >, numbered lists, code fences)
- The editor is rich text; those symbols appear literally if you use them

${styleGuide ? styleGuide + '\n\n' : ''}${context ? `=== WRITER'S RESEARCH CONTEXT (for grounding only) ===\n${context.slice(0, 4000)}` : ''}`
}

/**
 * Apply parsed edits to a source string. Each `find` is replaced at its first
 * occurrence after the previous edit (so ordered, non-overlapping edits map
 * cleanly). Returns the new text and how many edits actually landed.
 */
export function applyEdits(source: string, edits: ParsedEdit[]): { text: string; applied: number } {
  let result = ''
  let cursor = 0
  let applied = 0

  for (const edit of edits) {
    if (!edit.find) {
      // Pure insertion with no anchor: append to the end of the replace stream.
      result += source.slice(cursor)
      cursor = source.length
      result += edit.replace
      applied++
      continue
    }
    const idx = source.indexOf(edit.find, cursor)
    if (idx === -1) {
      // Try from the very start in case ordering was imperfect.
      const fallbackIdx = source.indexOf(edit.find)
      if (fallbackIdx === -1 || fallbackIdx < cursor) continue
      result += source.slice(cursor, fallbackIdx) + edit.replace
      cursor = fallbackIdx + edit.find.length
      applied++
      continue
    }
    result += source.slice(cursor, idx) + edit.replace
    cursor = idx + edit.find.length
    applied++
  }
  result += source.slice(cursor)
  return { text: result, applied }
}

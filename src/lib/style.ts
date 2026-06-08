/**
 * Style system for Write Mode.
 *
 * - `StyleRule`s are user-editable "nodes" shown in Stylism mode. Enabled rules
 *   are compiled into every Write Mode generation so the AI sounds human.
 * - The edit/preservation prompt forces surgical find/replace edits instead of
 *   wholesale rewrites.
 */

export interface StyleRule {
  id: string
  label: string
  instruction: string
  enabled: boolean
}

/** Default anti-AI house style. Each entry becomes a floating, editable node. */
export const DEFAULT_STYLE_RULES: StyleRule[] = [
  {
    id: 'no-em-dash',
    label: 'No em dashes',
    instruction:
      'Never use em dashes (—) or en dashes (–) as punctuation. Use commas, periods, parentheses, or colons instead.',
    enabled: true,
  },
  {
    id: 'no-antithesis',
    label: 'No "not X, but Y"',
    instruction:
      'Avoid antithesis cliches such as "not X, but Y", "it isn\'t just X, it\'s Y", and "not only... but also". State the point directly without the setup-and-pivot.',
    enabled: true,
  },
  {
    id: 'burstiness',
    label: 'Vary sentence length',
    instruction:
      'Vary sentence length aggressively for high burstiness. Put short, punchy sentences (three to five words) next to longer, winding ones. Never let the rhythm settle into a uniform cadence.',
    enabled: true,
  },
  {
    id: 'no-transitions',
    label: 'Kill stock transitions',
    instruction:
      'Avoid formulaic transitions: "Moreover", "Furthermore", "Additionally", "In conclusion", "Ultimately", "That said", "In today\'s world".',
    enabled: true,
  },
  {
    id: 'no-ai-vocab',
    label: 'Ban AI vocabulary',
    instruction:
      'Never use these overused AI words: delve, tapestry, testament, realm, landscape, navigate, underscore, crucial, pivotal, multifaceted, nuanced, robust, leverage, foster, intricate.',
    enabled: true,
  },
  {
    id: 'no-hedging',
    label: 'Cut hedging filler',
    instruction:
      'Cut hedging and filler phrases: "it\'s worth noting", "it\'s important to note", "arguably", "in many ways", "when it comes to", "the fact that".',
    enabled: true,
  },
  {
    id: 'no-rule-of-three',
    label: 'Break the rule of three',
    instruction:
      'Do not default to lists of three parallel items or three stacked adjectives. Use one sharp detail, or an uneven number.',
    enabled: true,
  },
  {
    id: 'vary-openers',
    label: 'Vary sentence openers',
    instruction:
      'Do not begin consecutive sentences with the same word or the same grammatical structure. Avoid starting sentences with "It is" or "There are".',
    enabled: true,
  },
  {
    id: 'concrete',
    label: 'Be concrete',
    instruction:
      'Prefer concrete, specific nouns and strong verbs over abstractions. Show with detail instead of summarizing with adjectives.',
    enabled: true,
  },
  {
    id: 'no-windup',
    label: 'No tidy wrap-ups',
    instruction:
      'Do not end on a neat summarizing moral, a rhetorical question, or an "In a world where..." flourish. Let the last concrete point stand on its own.',
    enabled: true,
  },
]

/** Compile enabled rules into a directive block for the system prompt. */
export function compileStyleGuide(rules: StyleRule[]): string {
  const active = rules.filter((r) => r.enabled)
  if (active.length === 0) return ''
  const lines = active.map((r) => `- ${r.instruction}`).join('\n')
  return `=== HOUSE STYLE (follow strictly; these override default model habits) ===\n${lines}`
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

OUTPUT FORMAT — respond with ONLY a JSON object, no prose, no code fences:
{"edits":[{"find":"<exact verbatim substring to replace>","replace":"<the new text>"}]}

RULES FOR EDITS:
- ${scopeNote}
- Copy each "find" string character-for-character (exact punctuation, capitalization, spacing). It must occur verbatim in the source.
- Keep "find" spans tight: target the specific words/sentence that change, plus only enough surrounding text to be unambiguous.
- To insert new text, set "find" to a short existing anchor and include it unchanged at the start (or end) of "replace".
- To delete text, set "replace" to "" (or to the surrounding text minus the removed part).
- Order edits top-to-bottom as they appear in the source. Do not produce overlapping edits.
- If a true improvement requires rewriting more, still prefer several small edits over one large one.
- If nothing should change, return {"edits":[]}.

${styleGuide ? styleGuide + '\n\n' : ''}${context ? `=== WRITER'S RESEARCH CONTEXT (for grounding only) ===\n${context.slice(0, 4000)}` : ''}`
}

export interface ParsedEdit {
  find: string
  replace: string
}

/** Lenient parse of the model's edit JSON. Returns null if unusable. */
export function parseEdits(raw: string): ParsedEdit[] | null {
  let text = raw.trim()
  // Strip code fences if the model added them despite instructions.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()

  const tryParse = (s: string): ParsedEdit[] | null => {
    try {
      const obj = JSON.parse(s)
      const edits = Array.isArray(obj) ? obj : obj?.edits
      if (!Array.isArray(edits)) return null
      const clean = edits
        .filter((e) => e && typeof e.find === 'string' && typeof e.replace === 'string')
        .map((e) => ({ find: e.find as string, replace: e.replace as string }))
      return clean
    } catch {
      return null
    }
  }

  let result = tryParse(text)
  if (result) return result

  // Fall back to extracting the outermost {...} block.
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) {
    result = tryParse(text.slice(first, last + 1))
    if (result) return result
  }
  return null
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

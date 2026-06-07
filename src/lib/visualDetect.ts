/** True when the user is asking for a visual rather than prose. */
export function isVisualRequest(prompt: string, ctx: VisualRequestContext = {}): boolean {
  const lower = prompt.toLowerCase().trim()
  const combined = [prompt, ctx.parentPrompt, ctx.parentResponse, ctx.excerpt].filter(Boolean).join(' ').toLowerCase()

  if (
    /\b(chemical structure|molecular structure|structural formula|ball.?and.?stick)\b/.test(combined)
  ) {
    return true
  }

  if (
    /\b(generate|create|make|draw|give me|need|want)\s+(me\s+)?(a\s+)?(sketch|diagram|image|visual|drawing|illustration|picture|photo|graphic|rendering)\b/.test(
      lower
    )
  ) {
    return true
  }

  if (/\b(generate|create|make)\s+(a\s+)?sketch\b/.test(lower)) {
    return true
  }

  if (
    /\b(diagram|flowchart|flow chart|mind ?map|concept map|tree diagram|timeline|visualiz(e|ation)|map out|sketch|illustrate|chart of|graph of|infographic)\b/.test(
      lower
    ) &&
    /\b(generate|create|make|draw|show|give|for me|can you|please|want|need)\b/.test(lower)
  ) {
    return true
  }

  if (
    /\b(diagram|flowchart|flow chart|mind ?map|concept map|tree diagram|timeline|visualiz(e|ation)|map out|draw a|sketch a|sketch of|illustrate|chart of|graph of|infographic)\b/.test(
      lower
    )
  ) {
    return true
  }

  if (
    /\b(image|picture|photo|visual|illustration|rendering|sketch|drawing|graphic)\b/.test(lower) &&
    /\b(show|see|display|generate|create|make|give me|want|need|get)\b/.test(lower)
  ) {
    return true
  }

  if (
    /\b(show (me )?(what )?(this|it|that) looks like|what (does|do|did) (this|it|that) look like|how (does|do|did) (this|it|that) look)\b/.test(
      lower
    )
  ) {
    return true
  }

  if (/\bwhat (does|do|did|would) .+ look like\b/.test(lower)) {
    return true
  }

  if (/\b(show me|can you show|let me see|i want to see|make an image|create an image)\b/.test(lower)) {
    return true
  }

  if (ctx.hasParentContext || ctx.hasExcerpt) {
    if (/\b(this|it|that)\b/.test(lower) && /\b(look|see|show|visual|appear|picture|photo|image|structure|sketch|diagram|draw)\b/.test(lower)) {
      return true
    }
    if (/\b(generate|create|make|draw)\b/.test(lower) && /\b(for me|sketch|diagram|image|visual|this|it)\b/.test(lower)) {
      return true
    }
  }

  return false
}

export interface VisualRequestContext {
  hasParentContext?: boolean
  hasExcerpt?: boolean
  parentPrompt?: string
  parentResponse?: string
  excerpt?: string
}

/** Turn vague follow-ups into a concrete visual query using thread context. */
export function resolveVisualQuery(prompt: string, ctx: VisualRequestContext = {}): string {
  const combined = [prompt, ctx.parentPrompt, ctx.parentResponse, ctx.excerpt].filter(Boolean).join(' ')
  const lower = combined.toLowerCase()
  const promptLower = prompt.toLowerCase()

  if (/\bchemical structure\b|\bmolecular structure\b|\bstructural formula\b/.test(lower)) {
    const compounds = extractCompoundHints(combined)
    if (compounds.length) {
      return `2D chemical structure diagram of ${compounds.join(' and ')}`
    }
    if (/\b(this|it|that)\b/.test(promptLower) && ctx.parentResponse) {
      const fromParent = extractCompoundHints(ctx.parentResponse)
      if (fromParent.length) {
        return `2D chemical structure diagram of ${fromParent.join(' and ')}`
      }
    }
    return prompt.includes('chemical') ? prompt : `Chemical structure: ${prompt}`
  }

  if (/\b(sketch|diagram|drawing|illustration|visual|image|graphic)\b/.test(promptLower)) {
    const topic =
      ctx.excerpt?.trim().slice(0, 300) ||
      ctx.parentResponse?.trim().slice(0, 600) ||
      ctx.parentPrompt?.trim()
    if (topic && /\b(for me|this|it|generate|create|make|sketch|diagram)\b/.test(promptLower)) {
      return `${prompt}: ${topic.slice(0, 400)}`
    }
  }

  const refersToContext = /\b(this|it|that)\b/.test(promptLower)
  const isVagueLookRequest =
    /\b(show (me )?(what )?(this|it|that) looks like|what (does|do|did) (this|it|that) look like)\b/.test(
      promptLower
    ) || (refersToContext && /\b(look like|looks like|see (this|it|that)|show (this|it|that))\b/.test(promptLower))

  if (!isVagueLookRequest && !refersToContext) return prompt

  if (/\bchemical structure\b|\bmolecular\b|\bamphetamine\b|\bmethylphenidate\b|\bmodafinil\b/.test(lower)) {
    const compounds = extractCompoundHints(combined)
    if (compounds.length) {
      return `2D chemical structure diagram of ${compounds.join(' and ')}`
    }
  }

  const subject =
    ctx.excerpt?.trim().slice(0, 200) ||
    extractSubject(ctx.parentPrompt, ctx.parentResponse) ||
    ctx.parentPrompt?.trim()

  if (subject) {
    return `Adapted visual showing: ${subject}`
  }

  return prompt
}

const COMPOUND_PATTERNS = [
  /\b(amphetamine|methylphenidate|modafinil|lisdexamfetamine|piracetam|caffeine)\b/gi,
  /\b(adderall|ritalin|concerta|provigil|vyvanse)\b/gi,
]

function extractCompoundHints(text: string): string[] {
  const found = new Set<string>()
  for (const re of COMPOUND_PATTERNS) {
    for (const match of text.matchAll(re)) {
      found.add(match[1])
    }
  }
  return [...found]
}

function extractSubject(parentPrompt?: string, parentResponse?: string): string | null {
  if (parentPrompt?.trim()) {
    const cleaned = parentPrompt
      .trim()
      .replace(/^(what|how|why|when|where|who|can you|tell me about|explain|describe)\s+/i, '')
      .replace(/\?$/, '')
      .trim()
    if (cleaned.length > 2) return cleaned
  }

  if (parentResponse?.trim()) {
    const firstSentence = parentResponse.split(/[.!?]\s/)[0]?.trim()
    if (firstSentence && firstSentence.length > 3 && firstSentence.length < 160) {
      return firstSentence
    }
  }

  return null
}

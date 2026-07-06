/**
 * Voice import — refine a writing sample and distill style principles
 * that populate the Stylism network as new neurons.
 *
 * Import always appends. Existing principles are context only; the writer
 * removes unwanted nodes manually. Only byte-for-byte duplicate label+
 * instruction pairs are skipped client-side.
 */

import { syncChat, streamChat, uploadPDF, uploadDoc } from './claude'
import { sanitizeAiProse } from './aiText'
import { drainJsonObjects } from './streamJson'
import type { StyleRule } from './style'

export interface ExtractedVoiceRule {
  label: string
  instruction: string
  /** 1–5: how central/recurring this trait is across the writer's work. */
  relevance?: number
  /** Short instructional contrast for the expanded node. */
  example?: { good: string; bad: string }
  /** 1-based indices of the documents this trait is most evidenced in. */
  docs?: number[]
}

/** Result of a deep, multi-document voice analysis. */
export interface VoiceAnalysis {
  /** Durable style principles → new neurons in the network. */
  principles: ExtractedVoiceRule[]
  /** Eloquent 1–2 sentence observations about the writer's voice. */
  notes: string[]
}

const MAX_LABEL_CHARS = 80
const MAX_INSTRUCTION_CHARS = 1500

export function voiceRuleKey(label: string, instruction: string): string {
  return `${label.toLowerCase().trim()}|${instruction.toLowerCase().trim()}`
}

/** Keep only principles not already in the network (exact label + instruction). */
export function filterNewVoiceRules(
  extracted: ExtractedVoiceRule[],
  existing: StyleRule[]
): ExtractedVoiceRule[] {
  const existingKeys = new Set(existing.map((r) => voiceRuleKey(r.label, r.instruction)))
  const seen = new Set<string>()
  return extracted.filter((item) => {
    const key = voiceRuleKey(item.label, item.instruction)
    if (existingKeys.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const MAX_SAMPLE_CHARS = 14000

/** Normalize whitespace and, for long pieces, keep intro / middle / outro slices. */
export function refineWritingSample(raw: string, maxChars = MAX_SAMPLE_CHARS): string {
  const cleaned = raw
    .replace(/\r\n/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim()

  if (cleaned.length <= maxChars) return cleaned

  const slice = Math.floor(maxChars / 3) - 40
  const intro = cleaned.slice(0, slice)
  const midStart = Math.max(slice, Math.floor(cleaned.length / 2 - slice / 2))
  const mid = cleaned.slice(midStart, midStart + slice)
  const outro = cleaned.slice(-slice)

  return [
    intro.trim(),
    '[… middle of document omitted for analysis …]',
    mid.trim(),
    '[… later section omitted …]',
    outro.trim(),
  ].join('\n\n')
}

export async function readWritingFile(file: File): Promise<string> {
  const name = file.name.toLowerCase()
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) {
    const { text } = await uploadPDF(file)
    return text
  }
  if (
    name.endsWith('.docx') ||
    name.endsWith('.doc') ||
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    file.type === 'application/msword'
  ) {
    const { text } = await uploadDoc(file)
    return text
  }
  return file.text()
}

function parseVoiceRules(raw: string): ExtractedVoiceRule[] {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return []

  try {
    const arr = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(arr)) return []
    return arr
      .filter(
        (item): item is ExtractedVoiceRule =>
          item &&
          typeof item.label === 'string' &&
          typeof item.instruction === 'string' &&
          item.label.trim().length > 0 &&
          item.instruction.trim().length > 0
      )
      .map((item) => ({
        label: item.label.trim().slice(0, MAX_LABEL_CHARS),
        instruction: item.instruction.trim().slice(0, MAX_INSTRUCTION_CHARS),
      }))
  } catch {
    return []
  }
}

function formatExistingRules(rules: StyleRule[]): string {
  if (rules.length === 0) return '(none yet — extract everything you observe)'
  return rules.map((r) => `- ${r.label}: ${r.instruction}`).join('\n')
}

const VOICE_ANALYSIS_SYSTEM = `You are a literary stylist who reverse-engineers a writer's voice from their prose.

Your job: read a writing sample and extract durable STYLE PRINCIPLES that would let an AI write in this writer's voice — not generic "good writing" advice, but patterns observable in THIS sample.

Focus on:
- Sentence rhythm, length variation, and cadence
- Register, tone, and formality level
- Vocabulary habits (words they favor, words they avoid)
- Punctuation and structural quirks
- How they open and close paragraphs or sections
- Concrete vs abstract tendencies
- Distinctive tics worth preserving (or explicitly avoiding if they seem unintentional)

Rules for each principle:
- Label: 2–6 words, memorable name (short — it appears on the network node)
- Instruction: imperative voice, reusable directive for a writing AI. Use 1–4 sentences when a pattern needs fuller articulation; be specific rather than terse.
- Do NOT invent content facts about the topic — only stylistic patterns
- Extract generously: aim for 8–14 principles covering every distinct pattern you observe
- Existing principles (if listed) are for context only — STILL add new principles even when they overlap or refine an existing theme. Rephrase as a distinct directive rather than skipping. The writer will delete unwanted nodes manually.
- Only omit a principle if it would be literally identical (same label and same instruction text) to one already listed

Respond with ONLY a JSON array, no markdown fences:
[{"label":"Short name","instruction":"Full imperative directive."}]`

/**
 * Analyze refined writing and return voice principles for new network nodes.
 */
export async function analyzeWritingForVoice(opts: {
  text: string
  apiKey: string
  existingRules?: StyleRule[]
}): Promise<ExtractedVoiceRule[]> {
  const { text, apiKey, existingRules = [] } = opts
  const sample = refineWritingSample(text)
  if (!sample.trim()) throw new Error('No readable text in the upload.')

  const user = `EXISTING VOICE PRINCIPLES (context only — still append new ones):
${formatExistingRules(existingRules)}

WRITING SAMPLE TO ANALYZE:
"""
${sample}
"""

Extract this writer's voice as JSON principles. Be thorough; append every distinct pattern.`

  const raw = await syncChat([{ role: 'user', content: user }], VOICE_ANALYSIS_SYSTEM, apiKey, 4096)
  const rules = parseVoiceRules(raw)
  if (rules.length === 0) {
    throw new Error('Could not extract voice principles from this sample. Try a longer or more distinctive piece.')
  }
  return rules
}

/* ── Deep, multi-document voice analysis ───────────────────── */

const MAX_CORPUS_CHARS = 40000

export interface VoiceDocument {
  name: string
  text: string
}

/** Map AI relevance score (1–5) to prompt/network weight. */
export function relevanceToWeight(relevance?: number): number {
  if (!relevance || !Number.isFinite(relevance)) return 1.4
  const r = Math.min(5, Math.max(1, Math.round(relevance)))
  return 1.2 + (r - 1) * 0.825 // 1→1.2 … 5→4.5
}

/**
 * Merge documents into one analysis corpus within a char budget.
 * Documents referenced by existing rules or with more text get larger slices.
 */
export function buildVoiceCorpus(
  docs: VoiceDocument[],
  maxChars = MAX_CORPUS_CHARS,
  priorityNames?: string[]
): string {
  const priSet = new Set(priorityNames ?? [])
  const scored = docs
    .map((d) => ({
      name: d.name,
      text: d.text,
      weight: (priSet.has(d.name) ? 2.2 : 1) * Math.sqrt(Math.max(1, d.text.length)),
    }))
    .filter((d) => d.text.trim().length > 0)
  if (scored.length === 0) return ''

  const totalWeight = scored.reduce((s, d) => s + d.weight, 0)
  const blocks = scored.map((d) => {
    const share = d.weight / totalWeight
    const slice = Math.max(2400, Math.floor(maxChars * share))
    return `### DOCUMENT: ${d.name}\n${refineWritingSample(d.text, slice)}`
  })
  return blocks.join('\n\n---\n\n')
}

function parseVoiceAnalysis(raw: string): VoiceAnalysis {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return { principles: [], notes: [] }

  try {
    const obj = JSON.parse(text.slice(start, end + 1))
    const principles: ExtractedVoiceRule[] = Array.isArray(obj.principles)
      ? obj.principles
          .filter(
            (item: unknown): item is ExtractedVoiceRule =>
              !!item &&
              typeof (item as ExtractedVoiceRule).label === 'string' &&
              typeof (item as ExtractedVoiceRule).instruction === 'string' &&
              (item as ExtractedVoiceRule).label.trim().length > 0 &&
              (item as ExtractedVoiceRule).instruction.trim().length > 0
          )
          .map((item: ExtractedVoiceRule) => ({
            label: sanitizeAiProse(item.label.trim()).slice(0, MAX_LABEL_CHARS),
            instruction: sanitizeAiProse(item.instruction.trim()).slice(0, MAX_INSTRUCTION_CHARS),
          }))
      : []
    const notes: string[] = Array.isArray(obj.notes)
      ? obj.notes
          .filter((n: unknown): n is string => typeof n === 'string' && n.trim().length > 0)
          .map((n: string) => sanitizeAiProse(n.trim()).slice(0, 320))
      : []
    return { principles, notes }
  } catch {
    return { principles: [], notes: [] }
  }
}

const VOICE_DEEP_SYSTEM = `You are a literary stylist with a novelist's ear. You are handed a writer's proudest work — possibly several documents — and asked to understand their voice completely, the way a devoted editor who has read everything they've written would.

Produce TWO things:

1. PRINCIPLES — durable, reusable style directives an AI could follow to write convincingly in THIS writer's voice. Not generic "good writing" advice; patterns observable in THESE documents. Cover sentence rhythm and cadence, register and tone, vocabulary habits (words favored and avoided), punctuation and structural quirks, how they open and close, concrete vs abstract tendencies, and any distinctive tics worth preserving.
   - label: 2–6 words, memorable (it becomes a node in a network)
   - instruction: imperative directive, 1–4 sentences, specific
   - Extract generously: 8–16 principles across every distinct pattern
   - Existing principles (if listed) are context only — STILL add new ones, rephrased as distinct directives; the writer prunes manually

2. NOTES — 4 to 7 short, perceptive observations about the CRAFT of this writer's voice, each ONE sentence. Focus on style, structure, syntax, cadence, punctuation, and word choice — how they write, not what they write about. Speak ABOUT the writer's style ("You favor…", "Your sentences…"). Tight, concrete, full sentences. NEVER use em dashes (—); use commas, periods, or semicolons instead.

Respond with ONLY a JSON object, no markdown fences:
{"principles":[{"label":"Short name","instruction":"Full imperative directive."}],"notes":["Eloquent one-to-two sentence observation.","Another."]}`

/**
 * Deep analysis across one or many documents. Returns both the style
 * principles that become network nodes and eloquent voice notes for display.
 */
export async function analyzeVoiceDeep(opts: {
  docs: VoiceDocument[]
  apiKey: string
  existingRules?: StyleRule[]
}): Promise<VoiceAnalysis> {
  const { docs, apiKey, existingRules = [] } = opts
  const corpus = buildVoiceCorpus(docs)
  if (!corpus.trim()) throw new Error('No readable text in the uploaded documents.')

  const user = `EXISTING VOICE PRINCIPLES (context only — still append new ones):
${formatExistingRules(existingRules)}

THE WRITER'S PROUDEST WORK (${docs.length} document${docs.length === 1 ? '' : 's'}):
"""
${corpus}
"""

Understand this writer's voice completely, then respond with the JSON object of principles and notes.`

  const raw = await syncChat([{ role: 'user', content: user }], VOICE_DEEP_SYSTEM, apiKey, 4096)
  const analysis = parseVoiceAnalysis(raw)
  if (analysis.principles.length === 0 && analysis.notes.length === 0) {
    throw new Error('Could not read a voice from these documents. Try longer or more distinctive writing.')
  }
  return analysis
}

/* ── Streaming analysis (nodes appear as the AI finds them) ─── */

const VOICE_STREAM_SYSTEM = `You are a literary stylist with a novelist's ear. You are handed a writer's proudest work — possibly several documents — and asked to understand their voice completely, the way a devoted editor who has read everything they've written would.

Identify, in this order:

1. PRINCIPLES — the DEFINITIVE 10 to 15 style principles that capture this writer's voice: a distilled summary of the conclusions across ALL the documents. Not generic "good writing" advice; patterns observable in THESE documents. Strongly prefer traits that recur across MULTIPLE documents — the standard, frequent habits that define them — over one-off quirks from a single piece. Think "the 10–15 most relevant rules a ghostwriter would need," not an exhaustive catalogue.
   - label: 2–6 words, memorable (it becomes a node in a network)
   - instruction: imperative directive, 1–4 sentences, specific and actionable — write it so an AI ghostwriter could FOLLOW it
   - relevance: an integer 1–5 for how central and recurring this trait is — 5 = a defining habit seen consistently across the documents; 1 = minor or seen only once. Reserve 4–5 for genuinely pervasive traits.
   - good / bad: a SHORT contrasting pair (each a fragment or one short sentence, under ~12 words) — "good" demonstrates the principle in this writer's voice, "bad" shows the flat/generic version that violates it. Concrete, not meta.
   - docs: an array of the 1-based document numbers (from the DOCUMENTS list below) where this trait actually appears. Include every document that evidences it; this is how the trait is attributed to its sources.
   - Emit AT MOST 15 principles. Merge near-duplicates. Existing principles (if listed) are context only — STILL add new ones, rephrased as distinct directives.

2. NOTES — 5 to 8 short, perceptive observations about the CRAFT of this writer's voice, each ONE sentence. Focus on style, structure, syntax, cadence, punctuation, and word choice — how they write, not what they write about. Spoken ABOUT the writer ("Your sentences…", "You favor…"). Full sentences, tight and concrete. NEVER use em dashes (—); use commas, periods, or semicolons instead.

OUTPUT — stream ONE compact JSON object per line (NDJSON). No markdown, no array brackets, no commentary, no trailing commas. Emit each line the MOMENT that insight is ready — interleave principles and notes freely as you discover them; do NOT save notes for the end. Each line is exactly one of:
{"t":"p","label":"Short name","instruction":"Full imperative directive.","relevance":4,"good":"Voiced example.","bad":"Flat generic version.","docs":[1,3]}
{"t":"n","text":"Eloquent one-to-two sentence observation."}`

export interface VoiceStreamHandlers {
  onPrinciple: (rule: ExtractedVoiceRule) => void
  onNote: (note: string) => void
}

/**
 * Stream a deep voice analysis. Principles and notes are dispatched to the
 * handlers the instant each one arrives, so the UI can reveal nodes one by one
 * instead of waiting for the whole response.
 */
export async function streamVoiceDeep(opts: {
  docs: VoiceDocument[]
  apiKey: string
  existingRules?: StyleRule[]
  handlers: VoiceStreamHandlers
}): Promise<void> {
  const { docs, apiKey, existingRules = [], handlers } = opts
  const priorityNames = [
    ...new Set(
      existingRules.flatMap((r) => r.sourceDocs ?? []).filter(Boolean)
    ),
  ]
  const corpus = buildVoiceCorpus(docs, MAX_CORPUS_CHARS, priorityNames)
  if (!corpus.trim()) throw new Error('No readable text in the uploaded documents.')

  const docList = docs.map((d, i) => `${i + 1}. ${d.name}`).join('\n')

  const user = `EXISTING VOICE PRINCIPLES (context only — still append new ones):
${formatExistingRules(existingRules)}

DOCUMENTS (use these 1-based numbers for the "docs" field):
${docList}

THE WRITER'S PROUDEST WORK (${docs.length} document${docs.length === 1 ? '' : 's'}):
"""
${corpus}
"""

Understand this writer's voice completely, then stream the NDJSON lines.`

  let buffer = ''
  let count = 0

  const dispatch = (o: unknown) => {
    if (!o || typeof o !== 'object') return
    const obj = o as Record<string, unknown>
    const isNote = obj.t === 'n' || (typeof obj.text === 'string' && !obj.instruction)
    if (isNote) {
      const text = sanitizeAiProse(String(obj.text ?? '').trim()).slice(0, 320)
      if (text) handlers.onNote(text)
      return
    }
    const label = sanitizeAiProse(String(obj.label ?? '').trim()).slice(0, MAX_LABEL_CHARS)
    const instruction = sanitizeAiProse(String(obj.instruction ?? '').trim()).slice(0, MAX_INSTRUCTION_CHARS)
    if (label && instruction) {
      count++
      const rawRel = Number(obj.relevance)
      const relevance = Number.isFinite(rawRel) ? Math.min(5, Math.max(1, Math.round(rawRel))) : 3
      const good = sanitizeAiProse(String(obj.good ?? '').trim()).slice(0, 160)
      const bad = sanitizeAiProse(String(obj.bad ?? '').trim()).slice(0, 160)
      const example = good && bad ? { good, bad } : undefined
      const docs = Array.isArray(obj.docs)
        ? (obj.docs as unknown[])
            .map((n) => Math.round(Number(n)))
            .filter((n) => Number.isFinite(n) && n >= 1)
        : undefined
      handlers.onPrinciple({ label, instruction, relevance, example, docs })
    }
  }

  await new Promise<void>((resolve, reject) => {
    void streamChat(
      [{ role: 'user', content: user }],
      VOICE_STREAM_SYSTEM,
      apiKey,
      (chunk) => {
        buffer += chunk
        const { objs, rest } = drainJsonObjects(buffer)
        buffer = rest
        for (const o of objs) dispatch(o)
      },
      () => {
        const { objs } = drainJsonObjects(buffer)
        for (const o of objs) dispatch(o)
        resolve()
      },
      (err) => reject(new Error(err))
    )
  })

  if (count === 0) {
    throw new Error('Could not read a voice from these documents. Try longer or more distinctive writing.')
  }
}

/** Compile the style prompt block generated from an import session. */
export function compileImportVoicePrompt(
  rules: ExtractedVoiceRule[],
  fileName?: string
): string {
  if (rules.length === 0) return ''

  const lines = rules
    .map((r, i) => `${i + 1}. ${r.instruction}`)
    .join('\n')

  const source = fileName ? ` (from "${fileName}")` : ''
  return `=== VOICE PROFILE${source} ===
These principles were distilled from the writer's own prose. Treat them as mandatory house style when writing or editing on their behalf. Follow every rule; when two tension, prefer the higher-numbered rule.

${lines}`
}

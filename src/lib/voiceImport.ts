/**
 * Voice import — refine a writing sample and distill style principles
 * that populate the Stylism network as new neurons.
 *
 * Import always appends. Existing principles are context only; the writer
 * removes unwanted nodes manually. Only byte-for-byte duplicate label+
 * instruction pairs are skipped client-side.
 */

import { syncChat, uploadPDF } from './claude'
import type { StyleRule } from './style'

export interface ExtractedVoiceRule {
  label: string
  instruction: string
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

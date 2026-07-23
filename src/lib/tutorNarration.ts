/**
 * Guided-narration parsing for the math tutor.
 *
 * The model streams a SAY block containing prose, inline LaTeX, and inline
 * board markers of the form:
 *
 *   [[confirmed|s3,s4|equal gaps]]        — spotlight strokes they wrote
 *   [[focus|s7|your last line]]           — the ONE place to look next
 *   [[highlight|line:2|bd = -5]]          — glow a MyScript-recognized line
 *   [[error|box:120,340,300,80|sign slip]]— a concrete mistake
 *   [[write|box:520,400,300,110|write z in terms of d]] — circled blank space
 *
 * Targets are stroke ids from the manifest, `line:N` from the recognized
 * transcript, or `box:x,y,w,h` on the 0–1000 board grid. This module tokenizes
 * that stream so the UI can typewriter the prose, render math via KaTeX, and
 * fire each marker exactly when the narration reaches it — like the product
 * tutorial's moving spotlight.
 */

import type { NormBox } from './mathBoardManifest'

export type MarkerRole = 'confirmed' | 'focus' | 'suggestion' | 'error' | 'write' | 'highlight'

export interface NarrationMarker {
  role: MarkerRole
  strokeIds?: string[]
  box?: NormBox
  /** MyScript transcript line number — client glows that line's strokes. */
  lineNumber?: number
  label?: string
}

export type NarrationToken =
  | { kind: 'text'; text: string }
  | { kind: 'math'; tex: string; display: boolean }
  | { kind: 'marker'; marker: NarrationMarker; index: number }

export interface ParsedNarration {
  tokens: NarrationToken[]
  markers: NarrationMarker[]
  /** Trailing chars held back because a marker / math span is still streaming in. */
  pendingTail: string
}

const MARKER_RE = /\[\[([a-z]+)\|([^|\]]*)(?:\|([^\]]*))?\]\]/

function parseMarkerBody(role: string, target: string, label?: string): NarrationMarker | null {
  const r = role.trim().toLowerCase()
  if (
    r !== 'confirmed' &&
    r !== 'focus' &&
    r !== 'suggestion' &&
    r !== 'error' &&
    r !== 'write' &&
    r !== 'highlight'
  ) {
    return null
  }
  const marker: NarrationMarker = { role: r, label: label?.trim() || undefined }
  const t = target.trim()
  const lineM = t.match(/^line\s*[:=]\s*(\d+)$/i)
  const boxM = t.match(/^box\s*[:=]\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)$/i)
  if (lineM) {
    marker.lineNumber = Number(lineM[1])
  } else if (boxM) {
    marker.box = { x: Number(boxM[1]), y: Number(boxM[2]), w: Number(boxM[3]), h: Number(boxM[4]) }
  } else if (t) {
    marker.strokeIds = t
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (!marker.box && !marker.strokeIds?.length && marker.lineNumber == null) return null
  return marker
}

/**
 * Index of the earliest possibly-incomplete construct at the end of `s`. Run
 * regardless of `done` — a response cut off mid-stream by a token limit ends
 * with the exact same dangling "[[write|box:..." / stray "[" shape as a
 * normal in-flight chunk, and should be silently dropped rather than shown
 * as broken syntax once the stream reports itself finished.
 */
function incompleteTailStart(s: string, _done: boolean): number {
  // Incomplete marker: a "[[" (or partial "[") without its closing "]]" yet.
  const candidates: number[] = []
  const lastOpen = s.lastIndexOf('[[')
  if (lastOpen !== -1 && s.indexOf(']]', lastOpen) === -1) candidates.push(lastOpen)
  if (s.endsWith('[')) candidates.push(s.length - 1)

  // Incomplete inline math \( … or $ … without a closer.
  const lastInline = s.lastIndexOf('\\(')
  if (lastInline !== -1 && s.indexOf('\\)', lastInline) === -1) candidates.push(lastInline)
  const lastDisplay = s.lastIndexOf('\\[')
  if (lastDisplay !== -1 && s.indexOf('\\]', lastDisplay) === -1) candidates.push(lastDisplay)
  // Trailing lone backslash (start of \( arriving next chunk).
  if (/\\$/.test(s)) candidates.push(s.length - 1)
  const dollarCount = (s.match(/\$/g) || []).length
  if (dollarCount % 2 === 1) candidates.push(s.lastIndexOf('$'))

  return candidates.length ? Math.min(...candidates) : s.length
}

/**
 * Tokenize a (possibly partial) SAY stream. When `done` is false, trailing
 * text that could be an unfinished marker/math span is returned as
 * `pendingTail` instead of being tokenized.
 */
export function parseNarration(raw: string, done: boolean): ParsedNarration {
  const cut = incompleteTailStart(raw, done)
  const stable = raw.slice(0, cut)
  // Once done, a leftover dangling fragment is truncation debris, not
  // something to hold onto for a next chunk that will never arrive.
  const pendingTail = done ? '' : raw.slice(cut)

  const tokens: NarrationToken[] = []
  const markers: NarrationMarker[] = []

  // Split on markers first, then math spans within the text pieces.
  let rest = stable
  while (rest.length) {
    const m = rest.match(MARKER_RE)
    let before = m ? rest.slice(0, m.index) : rest
    rest = m ? rest.slice((m.index ?? 0) + m[0].length) : ''
    // A removed marker shouldn't leave doubled whitespace ("clean  —") or a
    // dangling space before punctuation ("here , but").
    if (m && /^[\s,.;:!?)]/.test(rest)) before = before.replace(/\s+$/, '')
    if (before) pushTextAndMath(tokens, before)
    if (!m) break
    const marker = parseMarkerBody(m[1], m[2] ?? '', m[3])
    if (marker) {
      tokens.push({ kind: 'marker', marker, index: markers.length })
      markers.push(marker)
    }
  }

  return { tokens, markers, pendingTail }
}

const MATH_RE = /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/

function pushTextAndMath(tokens: NarrationToken[], text: string) {
  let rest = text
  while (rest.length) {
    const m = rest.match(MATH_RE)
    if (!m) {
      tokens.push({ kind: 'text', text: rest })
      return
    }
    if (m.index) tokens.push({ kind: 'text', text: rest.slice(0, m.index) })
    const tex = m[1] ?? m[2] ?? m[3] ?? m[4] ?? ''
    tokens.push({ kind: 'math', tex: tex.trim(), display: !!(m[2] ?? m[3]) })
    rest = rest.slice(m.index! + m[0].length)
  }
}

/** Plain narration text with markers removed (for history / fallbacks). */
export function stripMarkers(raw: string): string {
  // Drop a truncated trailing marker fragment first so a token-limit cutoff
  // never surfaces as a stray "[" in the plain-text fallback.
  const stable = raw.slice(0, incompleteTailStart(raw, false))
  return stable.replace(new RegExp(MARKER_RE.source, 'g'), ' ').replace(/[ \t]+/g, ' ').trim()
}

/**
 * True when the narration contains a fully-parseable [[write|box:…]] marker.
 * A bare "[[write|" substring (truncated mid-stream) or a marker missing box
 * coords does NOT count — those never draw a write zone on the board.
 */
export function hasWriteMarker(raw: string): boolean {
  if (!raw) return false
  const { markers } = parseNarration(raw, true)
  return markers.some((m) => m.role === 'write' && !!m.box)
}

/**
 * Append a synthetic write-box marker so the board always gets a zone when the
 * model said "write in the box" but forgot (or truncated) the real marker.
 */
export function ensureWriteMarker(raw: string, label = 'your next line'): string {
  if (hasWriteMarker(raw)) return raw
  const cleanLabel = label.replace(/[|\]]/g, '').trim() || 'your next line'
  const trimmed = raw.replace(/\s+$/, '')
  // y≈520 keeps the synthetic marker near mid-board; the client still
  // repositions into blank space snug under the ink via findBlankWriteBox.
  return `${trimmed} [[write|box:180,520,480,140|${cleanLabel}]]`
}

/**
 * Line numbers from [[highlight|line:N]] / [[focus|line:N]] markers.
 * Pass `firedCount` (the typewriter's revealed-marker count) to only count
 * markers that have actually been shown to the student so far — otherwise a
 * highlight tied to text near the end of the response would glow the instant
 * the network call finishes, well before the typewriter reaches it.
 */
export function extractHighlightLineNumbers(raw: string, firedCount?: number): number[] {
  const nums = new Set<number>()
  const { markers } = parseNarration(raw, true)
  const relevant = typeof firedCount === 'number' ? markers.slice(0, firedCount) : markers
  for (const m of relevant) {
    if (m.lineNumber != null && (m.role === 'highlight' || m.role === 'focus')) {
      nums.add(m.lineNumber)
    }
  }
  return [...nums].sort((a, b) => a - b)
}

/**
 * Reveal-step count for a token list: each text char is one step; math spans
 * and markers are atomic single steps (so equations pop in whole and markers
 * fire at a precise instant).
 */
export function tokenSteps(token: NarrationToken): number {
  return token.kind === 'text' ? token.text.length : 1
}

export function totalSteps(tokens: NarrationToken[]): number {
  return tokens.reduce((n, t) => n + tokenSteps(t), 0)
}

/**
 * Slice tokens up to `steps` reveal steps. Returns the visible tokens and how
 * many markers have fired (markers are counted the moment they are crossed).
 */
export function revealTokens(
  tokens: NarrationToken[],
  steps: number
): { visible: NarrationToken[]; firedMarkers: number } {
  const visible: NarrationToken[] = []
  let fired = 0
  let left = steps
  for (const t of tokens) {
    if (left <= 0) break
    if (t.kind === 'text') {
      if (t.text.length <= left) {
        visible.push(t)
        left -= t.text.length
      } else {
        visible.push({ kind: 'text', text: t.text.slice(0, left) })
        left = 0
      }
    } else {
      if (t.kind === 'marker') fired = t.index + 1
      else visible.push(t)
      left -= 1
    }
  }
  return { visible, firedMarkers: fired }
}

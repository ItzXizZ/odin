/**
 * Live handwriting → LaTeX recognition over the board's vector ink.
 *
 * The whiteboard already stores pen input as vector strokes; this module sends
 * them (normalized to a positive-origin pixel space) to the server's MyScript
 * iink proxy and turns the JIIX result into an `InkModel`:
 *
 *   - whole-board LaTeX, and
 *   - one entry per recognized expression ("line") carrying the IDs of the
 *     strokes that formed it plus their bounding box in flow coordinates.
 *
 * That symbol→stroke-ID map is what lets the tutor say "look at your third
 * equation" and have exactly those strokes light up, and what gives the
 * hint-placement logic real occupied-space rectangles instead of guesses.
 */

import { authHeader } from './supabase'

export interface InkStrokeInput {
  id: string
  points: { x: number; y: number; t?: number; p?: number }[]
}

export interface BoundsRect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface RecognizedLine {
  /** 1-based, ordered top-to-bottom by bounds. */
  n: number
  /** Per-line LaTeX when the export could be split per expression. */
  latex?: string
  /** IDs of the board strokes that drew this expression. */
  strokeIds: string[]
  /** Bounding box of those strokes, in flow (board) coordinates. */
  bounds: BoundsRect
}

export interface InkModel {
  /** LaTeX of the whole board, straight from the recognizer. */
  latex?: string
  lines: RecognizedLine[]
}

/** Server has no MyScript keys — callers should stop retrying this session. */
export class RecognitionUnavailableError extends Error {}

/** iink returns JIIX geometry in millimetres at the DPI we declared (96). */
const MM_PER_PX = 25.4 / 96
const PX_PER_MM = 96 / 25.4
/** Margin added when translating flow coords to the recognizer's canvas. */
const MARGIN_PX = 20

interface JiixStrokeItem {
  type?: string
  X?: number[]
  Y?: number[]
}

/** Depth-first collection of every stroke item under a JIIX math node. */
function collectStrokeItems(node: unknown, out: JiixStrokeItem[]): void {
  if (!node || typeof node !== 'object') return
  const n = node as Record<string, unknown>
  if (Array.isArray(n.items)) {
    for (const it of n.items) {
      const item = it as JiixStrokeItem
      if (item && item.type === 'stroke' && Array.isArray(item.X) && Array.isArray(item.Y)) {
        out.push(item)
      }
    }
  }
  for (const key of ['operands', 'expressions', 'rows', 'cells']) {
    const children = n[key]
    if (Array.isArray(children)) for (const c of children) collectStrokeItems(c, out)
  }
}

function boundsOf(strokes: InkStrokeInput[]): BoundsRect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of strokes) {
    for (const p of s.points) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  return { minX, minY, maxX, maxY }
}

/**
 * Split a whole-board Math LaTeX export into per-expression strings. MyScript
 * separates expressions with `\\` (row breaks); only trust the split when it
 * matches the expression count, otherwise per-line latex stays undefined.
 */
function splitLatex(label: string | undefined, expressionCount: number): (string | undefined)[] {
  if (!label) return Array(expressionCount).fill(undefined)
  const parts = label
    .split(/\\\\/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === expressionCount) return parts
  if (expressionCount === 1) return [label.trim()]
  return Array(expressionCount).fill(undefined)
}

export async function recognizeInk(strokes: InkStrokeInput[]): Promise<InkModel> {
  const usable = strokes.filter((s) => s.points.length > 0)
  if (usable.length === 0) return { lines: [] }

  const raw = boundsOf(usable)
  const offX = raw.minX - MARGIN_PX
  const offY = raw.minY - MARGIN_PX

  const payload = {
    width: Math.ceil(raw.maxX - raw.minX + MARGIN_PX * 2),
    height: Math.ceil(raw.maxY - raw.minY + MARGIN_PX * 2),
    strokes: usable.map((s) => {
      const t0 = s.points[0].t
      return {
        id: s.id,
        x: s.points.map((p) => p.x - offX),
        y: s.points.map((p) => p.y - offY),
        // Relative ms keeps numbers small; missing timestamps are synthesized
        // server-side.
        t: t0 != null ? s.points.map((p) => (p.t ?? t0) - t0) : undefined,
        p: s.points.every((p) => p.p != null) ? s.points.map((p) => p.p) : undefined,
      }
    }),
  }

  const res = await fetch('/api/math/recognize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(payload),
  })
  if (res.status === 501) throw new RecognitionUnavailableError('recognition not configured')
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Recognition failed' }))
    throw new Error(err.error || 'Recognition failed')
  }

  const { jiix } = (await res.json()) as { jiix: Record<string, unknown> }
  const expressions = Array.isArray(jiix?.expressions) ? (jiix.expressions as unknown[]) : []
  const wholeLatex = typeof jiix?.label === 'string' ? (jiix.label as string) : undefined
  const perLine = splitLatex(wholeLatex, expressions.length)

  // Map a JIIX stroke (mm, recognizer space) back to one of our strokes by
  // nearest first-point — the engine may resample points but the pen-down
  // position survives. Tolerance is generous since it only has to beat the
  // distance to a DIFFERENT stroke's start.
  const starts = usable.map((s) => ({ id: s.id, x: s.points[0].x, y: s.points[0].y }))
  const matchStroke = (item: JiixStrokeItem): string | null => {
    if (!item.X?.length || !item.Y?.length) return null
    const fx = item.X[0] * PX_PER_MM + offX
    const fy = item.Y[0] * PX_PER_MM + offY
    let best: string | null = null
    let bestD = Infinity
    for (const st of starts) {
      const d = (st.x - fx) ** 2 + (st.y - fy) ** 2
      if (d < bestD) {
        bestD = d
        best = st.id
      }
    }
    return bestD <= 25 ** 2 ? best : null
  }

  const byId = new Map(usable.map((s) => [s.id, s]))
  const lines: RecognizedLine[] = []
  expressions.forEach((expr, i) => {
    const items: JiixStrokeItem[] = []
    collectStrokeItems(expr, items)
    const ids = new Set<string>()
    for (const item of items) {
      const id = matchStroke(item)
      if (id) ids.add(id)
    }
    if (ids.size === 0) return
    const own = [...ids].map((id) => byId.get(id)!).filter(Boolean)
    const exprNode = expr as Record<string, unknown>
    // Top-level expression nodes carry their own LaTeX label (verified against
    // the live API) — prefer it over splitting the whole-board string.
    const exprLabel = typeof exprNode.label === 'string' ? (exprNode.label as string) : undefined
    lines.push({
      n: 0, // assigned after sorting
      latex: exprLabel ?? perLine[i],
      strokeIds: [...ids],
      bounds: boundsOf(own),
    })
  })

  lines.sort((a, b) => a.bounds.minY - b.bounds.minY || a.bounds.minX - b.bounds.minX)
  lines.forEach((l, i) => (l.n = i + 1))

  return { latex: wholeLatex, lines }
}

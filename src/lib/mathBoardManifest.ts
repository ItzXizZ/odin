/** Normalized bounding box on the board image (0–1000 scale). */
export interface NormBox {
  x: number
  y: number
  w: number
  h: number
}

export interface BoardBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface StrokeManifestEntry {
  id: string
  bbox: NormBox
}

export type HighlightRole = 'confirmed' | 'focus' | 'suggestion' | 'error'

export interface TutorInkHighlight {
  strokeIds?: string[]
  box?: NormBox
  role: HighlightRole
  label?: string
}

interface Point {
  x: number
  y: number
}

interface StrokeLike {
  id: string
  points: Point[]
}

export function boundsFromPoints(points: Point[]): BoardBounds | null {
  if (!points.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return { minX, minY, maxX, maxY }
}

export function unionBounds(a: BoardBounds, b: BoardBounds): BoardBounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

/** Flow-coordinate bounds for everything inked on the board (padded). */
export function boardBoundsFromStrokes(
  strokes: StrokeLike[],
  pane?: BoardBounds | null
): BoardBounds {
  let bounds: BoardBounds | null = pane ?? null
  for (const st of strokes) {
    const b = boundsFromPoints(st.points)
    if (!b) continue
    bounds = bounds ? unionBounds(bounds, b) : b
  }
  if (!bounds) {
    return { minX: 0, minY: 0, maxX: 1000, maxY: 1000 }
  }
  const padX = Math.max(24, (bounds.maxX - bounds.minX) * 0.08)
  const padY = Math.max(24, (bounds.maxY - bounds.minY) * 0.08)
  return {
    minX: bounds.minX - padX,
    minY: bounds.minY - padY,
    maxX: bounds.maxX + padX,
    maxY: bounds.maxY + padY,
  }
}

export function normalizeBox(board: BoardBounds, box: BoardBounds): NormBox {
  const w = board.maxX - board.minX || 1
  const h = board.maxY - board.minY || 1
  return {
    x: ((box.minX - board.minX) / w) * 1000,
    y: ((box.minY - board.minY) / h) * 1000,
    w: ((box.maxX - box.minX) / w) * 1000,
    h: ((box.maxY - box.minY) / h) * 1000,
  }
}

export function denormalizeBox(board: BoardBounds, box: NormBox): BoardBounds {
  const w = board.maxX - board.minX
  const h = board.maxY - board.minY
  const x = board.minX + (box.x / 1000) * w
  const y = board.minY + (box.y / 1000) * h
  const bw = (box.w / 1000) * w
  const bh = (box.h / 1000) * h
  return { minX: x, minY: y, maxX: x + bw, maxY: y + bh }
}

export function buildStrokeManifest(strokes: StrokeLike[], board: BoardBounds): StrokeManifestEntry[] {
  return strokes
    .map((st) => {
      const b = boundsFromPoints(st.points)
      if (!b) return null
      return { id: st.id, bbox: normalizeBox(board, b) }
    })
    .filter((e): e is StrokeManifestEntry => e !== null)
}

/** Resolve stroke IDs from a normalized box by overlap. */
export function strokeIdsInNormBox(strokes: StrokeLike[], board: BoardBounds, box: NormBox): string[] {
  const flowBox = denormalizeBox(board, box)
  const cx = (flowBox.minX + flowBox.maxX) / 2
  const cy = (flowBox.minY + flowBox.maxY) / 2
  return strokes
    .filter((st) => {
      const b = boundsFromPoints(st.points)
      if (!b) return false
      const overlap =
        b.minX <= flowBox.maxX &&
        b.maxX >= flowBox.minX &&
        b.minY <= flowBox.maxY &&
        b.maxY >= flowBox.minY
      if (overlap) return true
      return cx >= b.minX && cx <= b.maxX && cy >= b.minY && cy <= b.maxY
    })
    .map((st) => st.id)
}

export function resolveHighlightStrokeIds(
  highlight: TutorInkHighlight,
  strokes: StrokeLike[],
  board: BoardBounds
): string[] {
  if (highlight.strokeIds?.length) {
    return highlight.strokeIds.filter((id) => strokes.some((s) => s.id === id))
  }
  if (highlight.box) return strokeIdsInNormBox(strokes, board, highlight.box)
  return []
}

/** Union bounding box in flow coordinates for a highlight target. */
function boxesOverlap(a: BoardBounds, b: BoardBounds, gap = 16): boolean {
  return !(
    a.maxX + gap <= b.minX ||
    b.maxX + gap <= a.minX ||
    a.maxY + gap <= b.minY ||
    b.maxY + gap <= a.minY
  )
}

/** True if a flow box intersects any stroke bbox (with padding). */
export function boxOverlapsInk(box: BoardBounds, strokes: StrokeLike[], pad = 24): boolean {
  for (const st of strokes) {
    const b = boundsFromPoints(st.points)
    if (!b) continue
    const padded = {
      minX: b.minX - pad,
      minY: b.minY - pad,
      maxX: b.maxX + pad,
      maxY: b.maxY + pad,
    }
    if (boxesOverlap(box, padded, 0)) return true
  }
  return false
}

/**
 * Place a large write box in blank board space — below existing ink first,
 * then to the right, scanning until a clear region is found.
 */
export function findBlankWriteBox(
  strokes: StrokeLike[],
  boardBounds: BoardBounds,
  avoidBoxes: BoardBounds[],
  minWidth: number,
  minHeight: number,
  occupied: BoardBounds[] = []
): BoardBounds {
  const margin = 28
  const inkGap = 36
  let inkBounds: BoardBounds | null = null
  for (const region of occupied) {
    inkBounds = inkBounds ? unionBounds(inkBounds, region) : region
  }
  for (const st of strokes) {
    const b = boundsFromPoints(st.points)
    if (b) inkBounds = inkBounds ? unionBounds(inkBounds, b) : b
  }

  const boardW = boardBounds.maxX - boardBounds.minX
  const width = Math.min(boardW - margin * 2, Math.max(minWidth, boardW * 0.88))
  const height = Math.max(minHeight, 260)

  const overlapsOccupied = (candidate: BoardBounds) =>
    occupied.some((region) => boxesOverlap(candidate, region, inkGap))

  const fits = (candidate: BoardBounds) =>
    !boxOverlapsInk(candidate, strokes, inkGap) &&
    !overlapsOccupied(candidate) &&
    !avoidBoxes.some((ab) => boxesOverlap(candidate, ab, 20))

  const startY = inkBounds ? inkBounds.maxY + inkGap : boardBounds.minY + margin
  const startX = boardBounds.minX + margin

  for (let y = startY; y + height <= boardBounds.maxY - margin; y += 36) {
    const candidate = { minX: startX, minY: y, maxX: startX + width, maxY: y + height }
    if (fits(candidate)) return candidate
  }

  if (inkBounds) {
    const rx = inkBounds.maxX + inkGap
    for (let y = boardBounds.minY + margin; y + height <= boardBounds.maxY - margin; y += 36) {
      if (rx + width > boardBounds.maxX - margin) break
      const candidate = { minX: rx, minY: y, maxX: rx + width, maxY: y + height }
      if (fits(candidate)) return candidate
    }
  }

  const fallbackY = Math.max(startY, boardBounds.maxY - height - margin)
  return { minX: startX, minY: fallbackY, maxX: startX + width, maxY: fallbackY + height }
}

/** Screen-space rect (pixels, relative to the board pane) used for hint-card placement. */
export interface ScreenRect {
  left: number
  top: number
  right: number
  bottom: number
}

function screenRectOverlapArea(a: ScreenRect, b: ScreenRect): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return Math.max(0, w) * Math.max(0, h)
}

/**
 * Choose a screen position for a hint card that minimizes overlap with
 * "obstacles" — ink strokes, pasted images, fixed UI chrome (toolbar, mic
 * button, zoom controls), and any other hint cards already placed this pass.
 *
 * Tries the four corners and four edge midpoints of the pane first (the spec:
 * "prefer the emptiest corner or screen edge over center or a fixed default"),
 * plus the caller's preferred/default spot so placement doesn't jitter when
 * nothing conflicts. Falls back to whichever candidate has the LEAST overlap
 * area when every candidate hits something, rather than the first slot tried.
 */
export function computeHintPlacement(params: {
  paneWidth: number
  paneHeight: number
  cardWidth: number
  cardHeight: number
  obstacles: ScreenRect[]
  margin?: number
  /** Default/last-known spot — used as a tie-break so the card doesn't teleport unnecessarily. */
  preferred?: { left: number; top: number }
}): { left: number; top: number } {
  const { paneWidth, paneHeight, cardWidth, cardHeight, obstacles, margin = 16 } = params

  const maxLeft = Math.max(margin, paneWidth - cardWidth - margin)
  const maxTop = Math.max(margin, paneHeight - cardHeight - margin)
  const clampX = (v: number) => Math.min(Math.max(v, margin), maxLeft)
  const clampY = (v: number) => Math.min(Math.max(v, margin), maxTop)
  const midX = clampX((paneWidth - cardWidth) / 2)
  const midY = clampY((paneHeight - cardHeight) / 2)
  const right = clampX(paneWidth - cardWidth - margin)
  const left0 = clampX(margin)
  const top0 = clampY(margin)
  const bottom = clampY(paneHeight - cardHeight - margin)

  // bias = small tie-break penalty (lower is preferred when overlap is equal).
  const candidates: { left: number; top: number; bias: number }[] = []
  if (params.preferred) {
    candidates.push({ left: clampX(params.preferred.left), top: clampY(params.preferred.top), bias: 0 })
  }
  candidates.push(
    { left: right, top: top0, bias: 1 }, // top-right
    { left: left0, top: top0, bias: 1 }, // top-left
    { left: right, top: bottom, bias: 1 }, // bottom-right
    { left: left0, top: bottom, bias: 1 }, // bottom-left
    { left: right, top: midY, bias: 2 }, // right edge
    { left: left0, top: midY, bias: 2 }, // left edge
    { left: midX, top: top0, bias: 2 }, // top edge
    { left: midX, top: bottom, bias: 2 }, // bottom edge
    { left: midX, top: midY, bias: 5 } // center — last resort
  )

  let best = candidates[0]
  let bestScore = Infinity
  for (const c of candidates) {
    const rect: ScreenRect = { left: c.left, top: c.top, right: c.left + cardWidth, bottom: c.top + cardHeight }
    let overlap = 0
    for (const ob of obstacles) overlap += screenRectOverlapArea(rect, ob)
    const score = overlap + c.bias
    if (score < bestScore - 0.5) {
      bestScore = score
      best = c
    }
  }
  return { left: best.left, top: best.top }
}

export function highlightFlowBox(
  highlight: TutorInkHighlight,
  strokes: StrokeLike[],
  board: BoardBounds,
  pad = 14
): BoardBounds | null {
  let bounds: BoardBounds | null = null

  if (highlight.box) {
    // Grid-box targeting: the model chose this box VISUALLY on the gridded
    // board image, so honor it — then snap outward to include the whole bbox
    // of any stroke whose center it covers (so a box that clips an equation
    // still rings the entire equation, never a lone symbol).
    bounds = denormalizeBox(board, highlight.box)
    for (const st of strokes) {
      const b = boundsFromPoints(st.points)
      if (!b) continue
      const cx = (b.minX + b.maxX) / 2
      const cy = (b.minY + b.maxY) / 2
      if (cx >= bounds.minX && cx <= bounds.maxX && cy >= bounds.minY && cy <= bounds.maxY) {
        bounds = unionBounds(bounds, b)
      }
    }
  } else {
    const ids = resolveHighlightStrokeIds(highlight, strokes, board)
    for (const id of ids) {
      const st = strokes.find((s) => s.id === id)
      if (!st) continue
      const b = boundsFromPoints(st.points)
      if (!b) continue
      bounds = bounds ? unionBounds(bounds, b) : b
    }
  }

  if (!bounds) return null

  return {
    minX: bounds.minX - pad,
    minY: bounds.minY - pad,
    maxX: bounds.maxX + pad,
    maxY: bounds.maxY + pad,
  }
}

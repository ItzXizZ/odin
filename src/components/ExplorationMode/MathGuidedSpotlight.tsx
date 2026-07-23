import { useMemo } from 'react'
import { motion } from 'framer-motion'
import type { BoardBounds } from '../../lib/mathBoardManifest'
import {
  denormalizeBox,
  findBlankWriteBox,
  highlightFlowBox,
  type HighlightRole,
} from '../../lib/mathBoardManifest'
import { parseNarration, type NarrationMarker } from '../../lib/tutorNarration'

interface Stroke {
  id: string
  points: { x: number; y: number }[]
}

export type WriteZoneState = 'open' | 'filled' | 'checking' | 'done'

export interface ResolvedWriteZone {
  cardId: string
  markerIndex: number
  box: BoardBounds
  label?: string
  state: WriteZoneState
}

/**
 * Typical line height of the student's handwriting (median stroke bbox height,
 * in flow units) — used to size write zones so the circled space actually fits
 * an equation written at their scale.
 */
function handwritingLineHeight(strokes: Stroke[]): number {
  const heights: number[] = []
  for (const st of strokes) {
    if (st.points.length < 3) continue
    let minY = Infinity
    let maxY = -Infinity
    for (const p of st.points) {
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
    const h = maxY - minY
    if (h > 6 && h < 400) heights.push(h)
  }
  if (!heights.length) return 48
  heights.sort((a, b) => a - b)
  return Math.min(150, Math.max(30, heights[Math.floor(heights.length / 2)]))
}

/** Size and reposition a write box into clear blank space at the student's scale. */
function sizeWriteBox(
  _box: BoardBounds,
  strokes: Stroke[],
  boardBounds: BoardBounds,
  avoidBoxes: BoardBounds[],
  occupied: BoardBounds[]
): BoardBounds {
  const lineH = handwritingLineHeight(strokes)
  const boardW = boardBounds.maxX - boardBounds.minX
  // ~one equation line wide, ~2–3 handwriting lines tall — snug under their
  // work, not a giant slab parked at the bottom of the board.
  const minW = Math.min(boardW * 0.68, Math.max(lineH * 11, boardW * 0.5))
  const minH = Math.min(lineH * 2.6, 120)
  return findBlankWriteBox(strokes, boardBounds, avoidBoxes, minW, Math.max(minH, 80), occupied)
}

const INK_HIGHLIGHT_ROLES = new Set(['confirmed', 'focus', 'suggestion', 'error', 'highlight'])

/**
 * Resolve fired narration markers into flow-coordinate boxes.
 *
 * Write boxes go in blank space. Highlight / focus / error markers ring
 * existing ink (via box or stroke ids). Line-number highlights are handled
 * separately by the ink glow layer (MyScript stroke ids).
 */
export function resolveFiredMarkers(
  say: string,
  firedCount: number,
  strokes: Stroke[],
  boardBounds: BoardBounds,
  _pad: number,
  occupied: BoardBounds[] = [],
  cachedBoxes: Record<number, BoardBounds> = {}
): {
  writes: { marker: NarrationMarker; box: BoardBounds; index: number }[]
  highlights: { marker: NarrationMarker; box: BoardBounds; index: number }[]
} {
  const { markers } = parseNarration(say, true)
  const fired = markers.slice(0, firedCount)
  const writes: { marker: NarrationMarker; box: BoardBounds; index: number }[] = []
  const highlights: { marker: NarrationMarker; box: BoardBounds; index: number }[] = []

  const placed: BoardBounds[] = []
  fired.forEach((marker, index) => {
    if (marker.role === 'write' && marker.box) {
      const box =
        cachedBoxes[index] ??
        sizeWriteBox(
          denormalizeBox(boardBounds, marker.box),
          strokes,
          boardBounds,
          placed,
          occupied
        )
      placed.push(box)
      writes.push({ marker, box, index })
      return
    }

    if (!INK_HIGHLIGHT_ROLES.has(marker.role)) return
    // Line-number highlights glow strokes directly — no box overlay needed.
    if (marker.lineNumber != null && !marker.box && !marker.strokeIds?.length) return

    const role: HighlightRole =
      marker.role === 'highlight' || marker.role === 'focus'
        ? 'focus'
        : marker.role === 'confirmed'
          ? 'confirmed'
          : marker.role === 'error'
            ? 'error'
            : 'suggestion'

    const box = highlightFlowBox(
      { role, box: marker.box, strokeIds: marker.strokeIds, label: marker.label },
      strokes,
      boardBounds
    )
    if (!box) return
    highlights.push({ marker, box, index })
  })

  return { writes, highlights }
}

/** Flow-coordinate boxes of the fired write zones (for overlap avoidance). */
export function firedWriteZoneBoxes(
  say: string,
  firedCount: number,
  strokes: Stroke[],
  boardBounds: BoardBounds,
  occupied: BoardBounds[] = [],
  cachedBoxes: Record<number, BoardBounds> = {}
): BoardBounds[] {
  return resolveFiredMarkers(say, firedCount, strokes, boardBounds, 0, occupied, cachedBoxes).writes.map(
    (w) => w.box
  )
}

/** True while the student still needs to write in (or submit) an open write box. */
export function hasActiveWriteZone(
  say: string,
  firedMarkers: number,
  writeStates: Record<number, WriteZoneState>,
  strokes: Stroke[],
  boardBounds: BoardBounds,
  occupied: BoardBounds[] = [],
  cachedBoxes: Record<number, BoardBounds> = {}
): boolean {
  const { writes } = resolveFiredMarkers(
    say,
    firedMarkers,
    strokes,
    boardBounds,
    0,
    occupied,
    cachedBoxes
  )
  return writes.some((w) => {
    const state = writeStates[w.index] ?? 'open'
    return state === 'open' || state === 'filled'
  })
}

/**
 * Board layer for one hint card: write boxes in blank space, plus ink
 * highlight rings when the tutor tool-calls [[highlight|…]] / [[focus|…]].
 */
export default function MathGuidedSpotlight({
  cardId,
  say,
  firedMarkers,
  strokes,
  boardBounds,
  writeStates,
  writeBoxes = {},
  heldZone,
  occupied = [],
}: {
  cardId: string
  say: string
  firedMarkers: number
  strokes: Stroke[]
  boardBounds: BoardBounds
  writeStates: Record<number, WriteZoneState>
  writeBoxes?: Record<number, BoardBounds>
  heldZone?: { box: BoardBounds; label?: string; state: 'checking' | 'done' }
  occupied?: BoardBounds[]
}) {
  const { writes, highlights } = useMemo(
    () => resolveFiredMarkers(say, firedMarkers, strokes, boardBounds, 0, occupied, writeBoxes),
    [say, firedMarkers, strokes, boardBounds, occupied, writeBoxes]
  )

  // The submitted box lives on the card; hide it once a NEW write box shows up.
  const showHeld = heldZone && (heldZone.state === 'checking' || writes.length === 0)

  if (!writes.length && !highlights.length && !showHeld) return null

  return (
    <>
      {highlights.map(({ marker, box, index }) => {
        const role =
          marker.role === 'error'
            ? 'error'
            : marker.role === 'confirmed'
              ? 'confirmed'
              : 'focus'
        return (
          <motion.div
            key={`hl-${cardId}-${index}`}
            data-html2canvas-ignore
            className={`math-ink-highlight math-ink-highlight--${role}`}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: 'spring', stiffness: 280, damping: 28 }}
            style={{
              position: 'absolute',
              left: box.minX,
              top: box.minY,
              width: box.maxX - box.minX,
              height: box.maxY - box.minY,
              zIndex: 2,
              pointerEvents: 'none',
            }}
          >
            {marker.label && <span className="math-ink-highlight-label">{marker.label}</span>}
          </motion.div>
        )
      })}

      {/* Blank space where the tutor asks the student to WRITE. */}
      {writes.map(({ marker, box, index }) => {
        const state = writeStates[index] ?? 'open'
        return (
          <motion.div
            key={`write-${cardId}-${index}`}
            data-html2canvas-ignore
            className={`math-write-zone math-write-zone--${state}`}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
            style={{
              position: 'absolute',
              left: box.minX,
              top: box.minY,
              width: box.maxX - box.minX,
              height: box.maxY - box.minY,
              zIndex: 3,
              pointerEvents: 'none',
            }}
          >
            <span className="math-write-zone-label">
              {state === 'checking' ? (
                <>reading your work…</>
              ) : (
                <>{marker.label || 'write it here'}</>
              )}
            </span>
          </motion.div>
        )
      })}

      {/* The box they submitted — stays put while the tutor reads it and after. */}
      {showHeld && heldZone && (
        <div
          key={`held-${cardId}`}
          data-html2canvas-ignore
          className={`math-write-zone math-write-zone--${heldZone.state}`}
          style={{
            position: 'absolute',
            left: heldZone.box.minX,
            top: heldZone.box.minY,
            width: heldZone.box.maxX - heldZone.box.minX,
            height: heldZone.box.maxY - heldZone.box.minY,
            zIndex: 3,
            pointerEvents: 'none',
          }}
        >
          <span className="math-write-zone-label">
            {heldZone.state === 'checking' ? <>reading your work…</> : <>{heldZone.label || 'checked'}</>}
          </span>
        </div>
      )}
    </>
  )
}

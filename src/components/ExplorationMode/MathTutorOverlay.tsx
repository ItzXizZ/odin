import { Loader2, Mic, MicOff, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import katex from 'katex'
import type { ReactFlowInstance } from 'reactflow'
import TalkingHead from './TalkingHead'
import Markdown from '../Markdown'
import {
  boundsFromPoints,
  computeHintPlacement,
  type BoardBounds,
  type ScreenRect,
} from '../../lib/mathBoardManifest'
import { firedWriteZoneBoxes, hasActiveWriteZone } from './MathGuidedSpotlight'
import {
  parseNarration,
  revealTokens,
  totalSteps,
  type NarrationToken,
} from '../../lib/tutorNarration'
import { HINT_TYPE_MAP, type HintTypeId } from '../../math/session'

export interface TutorSession {
  id: string
  anchor: { x: number; y: number }
  regionFlow?: { x: number; y: number; w: number; h: number }
  boardBounds?: BoardBounds
  /** Raw SAY narration (may contain [[...]] markers + inline LaTeX). */
  text: string
  strategy?: string
  step?: string
  status: 'loading' | 'streaming' | 'done' | 'error'
  error?: string
  mode: 'hint' | 'solve' | 'generalize' | 'voice'
  hintType?: HintTypeId
  level: number
  tracked: boolean
  responded?: boolean
  /** How many narration markers the typewriter has crossed so far. */
  firedMarkers?: number
  /** Locked positions for write boxes (set when each marker first fires). */
  writeBoxes?: Record<number, BoardBounds>
  /** Prior write-box regions — new boxes avoid these. */
  usedWriteBoxes?: BoardBounds[]
  heldZone?: { box: BoardBounds; label?: string; state: 'checking' | 'done' }
  writeStates?: Record<number, 'open' | 'filled' | 'checking' | 'done'>
  complete?: boolean
  nudgeCount?: number
  maxLevel?: number
  clarifications?: Array<{
    id: string
    question: string
    answer: string
    status: 'loading' | 'streaming' | 'done'
  }>
  /** Each STEP field parsed from this hint — only the last one may carry a write marker. */
  steps?: string[]
  /** How many of `steps` are currently revealed into `text`. */
  revealedSteps?: number
  /** Per-step-index count of "I'm confused" re-explain attempts. */
  reexplainCounts?: Record<number, number>
  /** True while a re-explain request for the currently-gating step is in flight. */
  reexplaining?: boolean
}

/** After this many "I'm confused" taps on the same step, stop offering another re-explain. */
const REEXPLAIN_CAP = 2

/** Typewriter reveal speed — one step (≈1 char) per this many ms. */
const STEP_MS = 30
/** If TTS hasn't started speaking after this long, start typing anyway. */
const SPEECH_WAIT_MS = 1600
const BUBBLE_W = 400

function renderTex(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode: display })
  } catch {
    return tex
  }
}

/** Inline text + KaTeX renderer for a fully-known line (no typewriter). */
export function RichLine({ text }: { text: string }) {
  const tokens = useMemo(() => parseNarration(text, true).tokens, [text])
  return (
    <>
      {tokens.map((t, i) =>
        t.kind === 'text' ? (
          <span key={i}>{t.text}</span>
        ) : t.kind === 'math' ? (
          <span key={i} dangerouslySetInnerHTML={{ __html: renderTex(t.tex, false) }} />
        ) : null
      )}
    </>
  )
}

/**
 * Typewriter narration, tutorial-style: reveals prose character by character
 * (equations pop in whole, KaTeX-rendered) and reports the moment each inline
 * board marker is crossed so the spotlight moves in sync with the words.
 */
function TutorNarration({
  say,
  status,
  talking,
  scrollRef,
  onMarkersFired,
  onRevealingChange,
}: {
  say: string
  status: TutorSession['status']
  /** True while the TTS voice is actually speaking. */
  talking: boolean
  scrollRef: React.RefObject<HTMLDivElement>
  onMarkersFired: (count: number) => void
  onRevealingChange: (revealing: boolean) => void
}) {
  const parsed = useMemo(
    () => parseNarration(say, status === 'done' || status === 'error'),
    [say, status]
  )
  const total = totalSteps(parsed.tokens)
  const totalRef = useRef(total)
  totalRef.current = total

  const [steps, setSteps] = useState(0)
  // Hold the typewriter until the TTS audio actually starts (it takes a moment
  // to synthesize), so the words on screen stay in step with the voice.
  const [go, setGo] = useState(false)

  // New narration (text reset) → restart the typewriter.
  const prevLenRef = useRef(say.length)
  useEffect(() => {
    if (say.length < prevLenRef.current) {
      setSteps(0)
      setGo(false)
    }
    prevLenRef.current = say.length
  }, [say])

  useEffect(() => {
    if (go) return
    if (talking) {
      setGo(true)
      return
    }
    if (!say.trim()) return
    // TTS unavailable/muted or just slow — don't stall forever.
    const t = setTimeout(() => setGo(true), SPEECH_WAIT_MS)
    return () => clearTimeout(t)
  }, [go, talking, say])

  useEffect(() => {
    if (!go || steps >= total) return
    const iv = setInterval(() => {
      setSteps((s) => (s < totalRef.current ? s + 1 : s))
    }, STEP_MS)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go, steps >= total])

  const { visible, firedMarkers } = useMemo(
    () => revealTokens(parsed.tokens, steps),
    [parsed.tokens, steps]
  )

  useEffect(() => {
    onMarkersFired(firedMarkers)
  }, [firedMarkers, onMarkersFired])

  // Keep the newest words in view as the bubble fills up.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [steps, scrollRef])

  // "Revealing" = words are actually appearing. Loading (no text yet) does NOT
  // count — the head must not flap its mouth while we're just waiting.
  const revealing = total > 0 && (steps < total || status === 'streaming')
  useEffect(() => {
    onRevealingChange(revealing)
  }, [revealing, onRevealingChange])

  if (!say.trim() && (status === 'loading' || status === 'streaming')) return null

  return (
    <p className="math-coach-say">
      {visible.map((t: NarrationToken, i: number) =>
        t.kind === 'text' ? (
          <span key={i}>{t.text}</span>
        ) : t.kind === 'math' ? (
          <span key={i} dangerouslySetInnerHTML={{ __html: renderTex(t.tex, false) }} />
        ) : null
      )}
      {revealing && <span className="math-coach-caret" />}
    </p>
  )
}

/** Drag handle: report pointer deltas so the parent can move the whole coach. */
function useDragHandle(onDragBy: (dx: number, dy: number) => void) {
  const last = useRef<{ x: number; y: number } | null>(null)
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return
      if ((e.target as HTMLElement).closest('button')) return
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
      } catch {
        /* synthetic pointers have no capturable id */
      }
      last.current = { x: e.clientX, y: e.clientY }
      e.preventDefault()
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!last.current) return
      onDragBy(e.clientX - last.current.x, e.clientY - last.current.y)
      last.current = { x: e.clientX, y: e.clientY }
    },
    onPointerUp: () => {
      last.current = null
    },
    onPointerCancel: () => {
      last.current = null
    },
  }
}

function CoachCard({
  session,
  talking,
  showHintActions,
  clarifyRecording,
  clarifyInterim,
  clarifyLiveTranscript,
  sttOK,
  onMarkersFired,
  onDragBy,
  onClose,
  onAnotherHint,
  onFullSolution,
  onGeneralize,
  onClarifyMic,
  onAdvanceStep,
  onReexplainStep,
}: {
  session: TutorSession
  talking: boolean
  showHintActions: boolean
  clarifyRecording: boolean
  clarifyInterim: string
  clarifyLiveTranscript: string
  sttOK: boolean
  onMarkersFired: (count: number) => void
  onDragBy: (dx: number, dy: number) => void
  onClose: () => void
  onAnotherHint: () => void
  onFullSolution: () => void
  onGeneralize?: () => void
  onClarifyMic: () => void
  onAdvanceStep: () => void
  onReexplainStep: () => void
}) {
  const [revealing, setRevealing] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const type = session.hintType ? HINT_TYPE_MAP[session.hintType] : null
  const drag = useDragHandle(onDragBy)
  const waiting =
    (session.status === 'loading' || session.status === 'streaming') && !session.text

  // A multi-step hint pauses after each non-final step until the student
  // confirms it made sense — the typewriter must have fully caught up first,
  // so speech/text never race ahead of what's visually settled.
  const totalStepCount = session.steps?.length ?? (session.text ? 1 : 0)
  const revealedStepCount = session.revealedSteps ?? 1
  const stepIndex = revealedStepCount - 1
  const awaitingCheckin =
    session.status === 'done' &&
    session.mode === 'hint' &&
    revealedStepCount < totalStepCount &&
    !revealing &&
    !session.reexplaining
  const reexplainAttempts = session.reexplainCounts?.[stepIndex] ?? 0

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session.clarifications, clarifyLiveTranscript, clarifyInterim, session.text])

  return (
    <div className="math-coach">
      <div className="math-coach-avatar" {...drag} style={{ cursor: 'grab', touchAction: 'none' }}>
        <TalkingHead talking={talking || revealing} size={64} />
        <button type="button" onClick={onClose} title="Dismiss" className="math-tutor-dismiss">
          <X size={11} />
        </button>
      </div>

      <div className="math-coach-bubble" style={{ maxWidth: BUBBLE_W }}>
        <div
          className="math-coach-meta"
          {...drag}
          style={{ cursor: 'grab', touchAction: 'none' }}
          title="Drag to move"
        >
          <span className="math-coach-name">Thales</span>
          {type && session.mode === 'hint' && (
            <span className="math-coach-type" style={{ color: type.color }} title={type.def}>
              {type.name}
            </span>
          )}
          {session.mode === 'voice' && (
            <span
              className="math-coach-type"
              style={{ color: '#0d9488' }}
              title="Voice question"
            >
              Chat
            </span>
          )}
          {session.mode === 'generalize' && (
            <span
              className="math-coach-type"
              style={{ color: '#7c3aed' }}
              title="The general playbook for this whole family of problems"
            >
              Generalized
            </span>
          )}
          <span className="math-coach-grip" aria-hidden>
            <span /><span /><span />
          </span>
        </div>

        <div className="math-coach-scroll" ref={bodyRef}>
          {waiting && (
            <p className="math-coach-say math-coach-waiting">
              <Loader2 size={13} className="animate-spin" /> reading your work…
            </p>
          )}

          {session.status === 'error' && (
            <p className="math-coach-say" style={{ color: '#b91c1c' }}>
              {session.error}
            </p>
          )}

          {session.mode === 'hint' ? (
            <TutorNarration
              say={session.text}
              status={session.status}
              talking={talking}
              scrollRef={bodyRef}
              onMarkersFired={onMarkersFired}
              onRevealingChange={setRevealing}
            />
          ) : (
            session.text && (
              <div className="math-coach-solve">
                {session.mode === 'voice' ? (
                  <p className="math-coach-say" style={{ marginTop: 0 }}>
                    <RichLine text={session.text} />
                  </p>
                ) : (
                  <Markdown size="text-sm">{session.text}</Markdown>
                )}
              </div>
            )
          )}

          {(session.clarifications?.length ?? 0) > 0 && (
            <div className="math-coach-clarifications">
              {session.clarifications!.map((cl) => (
                <div key={cl.id} className="math-coach-clarify">
                  <p className="math-coach-clarify-q">You asked: {cl.question}</p>
                  {cl.status === 'loading' && !cl.answer ? (
                    <p className="math-coach-say math-coach-waiting">
                      <Loader2 size={12} className="animate-spin" /> thinking…
                    </p>
                  ) : (
                    <p className="math-coach-clarify-a">
                      <RichLine text={cl.answer} />
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {clarifyRecording && (
            <div className="math-coach-clarify math-coach-clarify--live">
              <p className="math-coach-clarify-q">You asked:</p>
              <p className="math-coach-clarify-live">{clarifyLiveTranscript || 'Listening…'}</p>
            </div>
          )}
        </div>

        <div className="math-coach-footer">
          {session.status === 'done' && (session.mode === 'hint' || session.mode === 'voice') && (
            <button
              type="button"
              className={`math-coach-clarify-mic${clarifyRecording ? ' is-recording' : ''}`}
              onClick={onClarifyMic}
              disabled={!sttOK}
              title={sttOK ? 'Ask a clarifying question' : 'Voice needs Chrome/Edge'}
            >
              {clarifyRecording ? <MicOff size={14} /> : <Mic size={14} />}
              {clarifyRecording ? 'Tap when done' : 'Ask a question'}
            </button>
          )}

          {awaitingCheckin && (
            <div className="math-tutor-checkin">
              <span className="math-tutor-checkin-label">Does that make sense?</span>
              <div className="math-tutor-actions">
                <button type="button" className="math-tutor-actions-primary" onClick={onAdvanceStep}>
                  Makes sense, next step
                </button>
                <button
                  type="button"
                  className="math-tutor-actions-secondary"
                  onClick={onReexplainStep}
                  disabled={reexplainAttempts >= REEXPLAIN_CAP}
                  title={
                    reexplainAttempts >= REEXPLAIN_CAP
                      ? "Let's just move on to the next step"
                      : 'Explain this step a different way'
                  }
                >
                  I'm confused
                </button>
              </div>
            </div>
          )}

          {session.reexplaining && !waiting && (
            <p className="math-coach-say math-coach-waiting">
              <Loader2 size={13} className="animate-spin" /> let me put that another way…
            </p>
          )}

          {session.status === 'done' && session.mode === 'hint' && showHintActions && (
            <div className="math-tutor-actions">
              {session.complete ? (
                // Problem solved — the natural next step is extracting the lesson.
                <button
                  type="button"
                  className="math-tutor-actions-primary"
                  onClick={onGeneralize}
                  title="Learn the general approach for this whole type of problem"
                >
                  Generalize this problem type
                </button>
              ) : (
                <>
                  <button type="button" className="math-tutor-actions-primary" onClick={onAnotherHint}>
                    Give me another hint
                  </button>
                  <button type="button" className="math-tutor-actions-secondary" onClick={onFullSolution}>
                    Show full solution
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Amber box over the student's own selection — only while the tutor reads it, and never alongside a write box. */
export function MathTutorHighlight({ session, zoom }: { session: TutorSession; zoom: number }) {
  if (
    !session.regionFlow ||
    session.mode !== 'hint' ||
    (session.status !== 'loading' && session.status !== 'streaming') ||
    (session.firedMarkers ?? 0) > 0
  ) {
    return null
  }

  return (
    <div
      data-html2canvas-ignore
      style={{
        position: 'absolute',
        left: session.regionFlow.x,
        top: session.regionFlow.y,
        width: session.regionFlow.w,
        height: session.regionFlow.h,
        borderRadius: 10 / zoom,
        background: 'rgba(251,191,36,0.14)',
        boxShadow: 'inset 0 0 0 2px rgba(251,191,36,0.42), 0 0 24px rgba(251,191,36,0.18)',
        pointerEvents: 'none',
        animation: 'math-highlight-pulse 2.4s ease-in-out infinite',
      }}
    />
  )
}

function occupiedForSession(
  images: { x: number; y: number; w: number; h: number }[],
  session: TutorSession,
  extra: BoardBounds[] = []
): BoardBounds[] {
  const fromImages = images.map((im) => ({
    minX: im.x,
    minY: im.y,
    maxX: im.x + im.w,
    maxY: im.y + im.h,
  }))
  const fromBoxes: BoardBounds[] = [...(session.usedWriteBoxes ?? []), ...extra]
  for (const b of Object.values(session.writeBoxes ?? {})) fromBoxes.push(b)
  if (session.heldZone) fromBoxes.push(session.heldZone.box)
  return fromBoxes.length ? [...fromImages, ...fromBoxes] : fromImages
}

function intersects(a: ScreenRect, b: ScreenRect, margin = 12): boolean {
  return (
    a.left < b.right + margin &&
    a.right > b.left - margin &&
    a.top < b.bottom + margin &&
    a.bottom > b.top - margin
  )
}

function overlapArea(a: ScreenRect, b: ScreenRect): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return Math.max(0, w) * Math.max(0, h)
}

/** Interactive tutor layer above the pointer overlay (screen-relative coords). */
export function MathTutorScreenLayer({
  sessions,
  rf,
  zoom,
  viewportX,
  viewportY,
  strokes,
  images = [],
  occupied = [],
  chrome = [],
  getPaneRect,
  talkingFor,
  onMarkersFired,
  onClose,
  onAnotherHint,
  onFullSolution,
  onGeneralize,
  clarifyRecordingId,
  clarifyInterim,
  clarifyLiveTranscript,
  sttOK,
  onClarifyMic,
  onAdvanceStep,
  onReexplainStep,
}: {
  sessions: TutorSession[]
  rf: ReactFlowInstance
  zoom: number
  viewportX: number
  viewportY: number
  strokes: { id: string; points: { x: number; y: number }[] }[]
  images?: { x: number; y: number; w: number; h: number }[]
  occupied?: BoardBounds[]
  /** Fixed UI chrome (toolbar, mic button, zoom controls…) in screen space, relative to the pane. */
  chrome?: ScreenRect[]
  getPaneRect: () => DOMRect | null
  talkingFor: (id: string) => boolean
  onMarkersFired: (id: string, count: number) => void
  onClose: (id: string) => void
  onAnotherHint: (id: string) => void
  onFullSolution: (id: string) => void
  onGeneralize?: (id: string) => void
  clarifyRecordingId: string | null
  clarifyInterim: string
  clarifyLiveTranscript: string
  sttOK: boolean
  onClarifyMic: (id: string) => void
  onAdvanceStep: (id: string) => void
  onReexplainStep: (id: string) => void
}) {
  const [pane, setPane] = useState<DOMRect | null>(null)
  /** Manual drag offsets per card — once the user moves a bubble, we respect it. */
  const [dragOffsets, setDragOffsets] = useState<Record<string, { dx: number; dy: number }>>({})
  /**
   * The on-screen position each card was sitting at the moment it started
   * being dragged. `preferred`/`placement` below are recomputed every render
   * from the ink's bounding box, which shifts as the student keeps writing —
   * without freezing an anchor, adding the drag offset on top of a moving
   * base position made a dragged card visibly jump ("teleport") any time new
   * ink changed the board's bounds. Once set, an anchor never moves again.
   */
  const [dragAnchors, setDragAnchors] = useState<Record<string, { left: number; top: number }>>({})
  /**
   * The auto-placed (non-dragged) spot each card locked onto the first time
   * it rendered. Without this, `preferred` below gets recomputed from the
   * ink's live bounding box AND the card's live measured height on every
   * render — a modest height change (e.g. the "Give me another hint" footer
   * appearing the instant a hint finishes) can flip the placement search's
   * winner from the ink-docked spot to a screen corner, so the whole card
   * visibly teleports right when it finishes. Locking the first computed
   * spot (and only re-clamping it to stay on-screen, never recomputing it
   * from scratch) keeps it put for the card's whole lifetime.
   */
  const defaultPositionsRef = useRef<Record<string, { left: number; top: number }>>({})
  /** Measured bubble heights (for accurate overlap checks against write zones). */
  const [heights, setHeights] = useState<Record<string, number>>({})

  useLayoutEffect(() => {
    if (sessions.length === 0) {
      setPane(null)
      return
    }
    setPane(getPaneRect())
  }, [sessions, viewportX, viewportY, zoom, getPaneRect])

  const dragBy = useCallback((id: string, dx: number, dy: number, baseLeft: number, baseTop: number) => {
    setDragAnchors((a) => (a[id] ? a : { ...a, [id]: { left: baseLeft, top: baseTop } }))
    setDragOffsets((o) => ({
      ...o,
      [id]: { dx: (o[id]?.dx ?? 0) + dx, dy: (o[id]?.dy ?? 0) + dy },
    }))
  }, [])

  const measure = useCallback((id: string, el: HTMLDivElement | null) => {
    if (!el) return
    const h = el.offsetHeight
    setHeights((m) => (Math.abs((m[id] ?? 0) - h) > 6 ? { ...m, [id]: h } : m))
  }, [])

  // Screen-space footprint of everything already on the board (ink + pasted
  // images) — the general obstacle set the placement search avoids, on top of
  // the fixed UI `chrome` passed in by the caller.
  const inkAndImageRects = useMemo<ScreenRect[]>(() => {
    if (!pane) return []
    const toScreen = (b: BoardBounds): ScreenRect => {
      const tl = rf.flowToScreenPosition({ x: b.minX, y: b.minY })
      const br = rf.flowToScreenPosition({ x: b.maxX, y: b.maxY })
      return { left: tl.x - pane.left, top: tl.y - pane.top, right: br.x - pane.left, bottom: br.y - pane.top }
    }
    const rects: ScreenRect[] = []
    for (const st of strokes) {
      const b = boundsFromPoints(st.points)
      if (b) rects.push(toScreen(b))
    }
    for (const im of images) {
      rects.push(toScreen({ minX: im.x, minY: im.y, maxX: im.x + im.w, maxY: im.y + im.h }))
    }
    return rects
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strokes, images, rf, zoom, viewportX, viewportY, pane])

  // Union bounding box of everything drawn/pasted on screen — used to dock
  // the coach BESIDE the student's actual work in open space, rather than a
  // generic screen corner that can land far from what they're looking at.
  const inkUnionRect = useMemo<ScreenRect | null>(() => {
    if (!inkAndImageRects.length) return null
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const r of inkAndImageRects) {
      left = Math.min(left, r.left)
      top = Math.min(top, r.top)
      right = Math.max(right, r.right)
      bottom = Math.max(bottom, r.bottom)
    }
    return { left, top, right, bottom }
  }, [inkAndImageRects])

  if (sessions.length === 0 || !pane) return null

  return (
    <div
      data-html2canvas-ignore
      style={{ position: 'absolute', inset: 0, zIndex: 46, pointerEvents: 'none' }}
    >
      {(() => {
        // Cards already placed this pass become obstacles for the next one,
        // so multiple open hint cards never stack on top of each other.
        const placedRects: ScreenRect[] = []
        return sessions.map((session, idx) => {
        const cardW = BUBBLE_W + 96
        const cardH = heights[session.id] ?? 300
        const clampX = (v: number) => Math.max(10, Math.min(v, pane.width - cardW))
        const clampY = (v: number) => Math.max(10, Math.min(v, Math.max(10, pane.height - cardH - 10)))

        // Dock beside the student's actual work — to its right, vertically
        // centered on it, in whatever open space is there; below it if the
        // right side is too cramped. Only falls back to a generic screen
        // corner when the board is empty (nothing to sit beside yet). Only
        // ever computed ONCE per card (see defaultPositionsRef above) — every
        // render after that just re-clamps the locked spot to stay on-screen.
        const dockMargin = 24
        const preferred = (() => {
          const locked = defaultPositionsRef.current[session.id]
          if (locked) return { left: clampX(locked.left), top: clampY(locked.top) }
          const computed = (() => {
            if (inkUnionRect) {
              const spaceRight = pane.width - inkUnionRect.right - dockMargin
              if (spaceRight >= cardW * 0.6) {
                return {
                  left: clampX(inkUnionRect.right + dockMargin),
                  top: clampY((inkUnionRect.top + inkUnionRect.bottom) / 2 - cardH / 2 + idx * 48),
                }
              }
              const spaceBelow = pane.height - inkUnionRect.bottom - dockMargin
              if (spaceBelow >= cardH * 0.6) {
                return {
                  left: clampX(inkUnionRect.left),
                  top: clampY(inkUnionRect.bottom + dockMargin + idx * 48),
                }
              }
            }
            return {
              left: clampX(pane.width - cardW - 16),
              top: clampY(pane.height * 0.18 + idx * 48),
            }
          })()
          defaultPositionsRef.current[session.id] = computed
          return computed
        })()

        const sessionOccupied = occupiedForSession(images, session, occupied)

        // Pick the spot on screen that overlaps LEAST with ink, pasted images,
        // fixed UI chrome (toolbar/mic/zoom controls), and any card placed above —
        // preferring an empty corner/edge over the center or the fixed default.
        const placement = computeHintPlacement({
          paneWidth: pane.width,
          paneHeight: pane.height,
          cardWidth: cardW,
          cardHeight: cardH,
          obstacles: [...chrome, ...inkAndImageRects, ...placedRects],
          preferred,
        })
        let left = clampX(placement.left)
        let top = clampY(placement.top)

        const offset = dragOffsets[session.id]
        if (offset) {
          // The user placed it — their position wins, relative to a FROZEN
          // anchor (where the card was when dragging started), never the
          // live `preferred` dock point (which drifts as ink bounds change).
          const anchor = dragAnchors[session.id] ?? preferred
          left = clampX(anchor.left + offset.dx)
          top = clampY(anchor.top + offset.dy)
        } else if (session.boardBounds && (session.firedMarkers ?? 0) > 0) {
          // Never sit on top of the space we're asking the student to write in.
          const zones: ScreenRect[] = firedWriteZoneBoxes(
            session.text,
            session.firedMarkers ?? 0,
            strokes,
            session.boardBounds,
            sessionOccupied,
            session.writeBoxes ?? {}
          ).map((b) => {
            const tl = rf.flowToScreenPosition({ x: b.minX, y: b.minY })
            const br = rf.flowToScreenPosition({ x: b.maxX, y: b.maxY })
            return {
              left: tl.x - pane.left,
              top: tl.y - pane.top,
              right: br.x - pane.left,
              bottom: br.y - pane.top,
            }
          })
          const card = (): ScreenRect => ({ left, top, right: left + cardW, bottom: top + cardH })
          const hit = zones.find((z) => intersects(card(), z))
          if (hit) {
            // Stay docked to a side: slide along the right edge first, then
            // try the left edge — never drift into the middle of the board.
            const candidates: { l: number; t: number }[] = [
              { l: left, t: clampY(hit.top - cardH - 24) }, // right edge, above zone
              { l: left, t: clampY(hit.bottom + 24) }, // right edge, below zone
              { l: clampX(16), t: top }, // left edge
              { l: clampX(16), t: clampY(hit.top - cardH - 24) },
              { l: clampX(16), t: clampY(hit.bottom + 24) },
            ]
            // Prefer a spot fully clear of every zone; in cramped viewports
            // fall back to whichever candidate covers the zones least.
            let best = { l: left, t: top }
            let bestArea = zones.reduce((sum, z) => sum + overlapArea(card(), z), 0)
            for (const c of candidates) {
              const rect: ScreenRect = { left: c.l, top: c.t, right: c.l + cardW, bottom: c.t + cardH }
              const area = zones.reduce((sum, z) => sum + overlapArea(rect, z), 0)
              if (area < bestArea - 1) {
                best = c
                bestArea = area
              }
              if (area === 0) break
            }
            left = best.l
            top = best.t
          }
        }

        const showHintActions =
          session.status === 'done' &&
          session.mode === 'hint' &&
          !!session.boardBounds &&
          (session.revealedSteps ?? 1) >= (session.steps?.length ?? 1) &&
          !hasActiveWriteZone(
            session.text,
            session.firedMarkers ?? 0,
            session.writeStates ?? {},
            strokes,
            session.boardBounds,
            sessionOccupied,
            session.writeBoxes ?? {}
          )

        placedRects.push({ left, top, right: left + cardW, bottom: top + cardH })

        // Remember where the card actually ended up (not a dragged offset —
        // that's handled by dragAnchors) so next render's `preferred` starts
        // from HERE instead of the original ink-docked guess. That way the
        // placement search only ever moves the card again when something
        // genuinely new overlaps it, instead of re-litigating "docked spot
        // vs. screen corner" from scratch on every render.
        if (!offset) defaultPositionsRef.current[session.id] = { left, top }

        return (
          <div
            key={session.id}
            ref={(el) => measure(session.id, el)}
            className="math-tutor-presence"
            style={{ position: 'absolute', left, top, pointerEvents: 'none' }}
          >
            <CoachCard
              session={session}
              talking={talkingFor(session.id)}
              showHintActions={showHintActions}
              clarifyRecording={clarifyRecordingId === session.id}
              clarifyInterim={clarifyRecordingId === session.id ? clarifyInterim : ''}
              clarifyLiveTranscript={clarifyRecordingId === session.id ? clarifyLiveTranscript : ''}
              sttOK={sttOK}
              onMarkersFired={(n) => onMarkersFired(session.id, n)}
              onDragBy={(dx, dy) => dragBy(session.id, dx, dy, left, top)}
              onClose={() => onClose(session.id)}
              onAnotherHint={() => onAnotherHint(session.id)}
              onFullSolution={() => onFullSolution(session.id)}
              onGeneralize={onGeneralize ? () => onGeneralize(session.id) : undefined}
              onClarifyMic={() => onClarifyMic(session.id)}
              onAdvanceStep={() => onAdvanceStep(session.id)}
              onReexplainStep={() => onReexplainStep(session.id)}
            />
          </div>
        )
        })
      })()}
    </div>
  )
}

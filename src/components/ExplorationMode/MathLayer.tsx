import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { EdgeLabelRenderer, useReactFlow, useViewport } from 'reactflow'
import {
  X,
  Check,
  Loader2,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useStore } from '../../store/useStore'
import { streamMathHint, type HintTurn } from '../../lib/mathHint'
import {
  ladderTypeForLevel,
  isHintTypeId,
  type HintTypeId,
  type SessionPhase,
} from '../../math/session'
import {
  createRecognizer,
  speechRecognitionSupported,
  probeTTS,
  IncrementalSpeaker,
  cancelSpeech,
  type RecognizerHandle,
} from '../../lib/voiceTutor'
import { loadMathBoard, saveMathBoard, clearMathBoard } from '../../lib/mathBoardStorage'
import {
  recognizeInk,
  RecognitionUnavailableError,
  type InkModel,
} from '../../lib/inkRecognition'
import {
  boundsFromPoints,
  unionBounds,
  type BoardBounds,
  type ScreenRect,
} from '../../lib/mathBoardManifest'
import { parseNarration, stripMarkers, extractHighlightLineNumbers } from '../../lib/tutorNarration'
import { speakableMathText } from '../../lib/mathSpeech'
import { MathTutorHighlight, MathTutorScreenLayer } from './MathTutorOverlay'
import MathGuidedSpotlight, {
  resolveFiredMarkers,
  type WriteZoneState,
} from './MathGuidedSpotlight'

type Tool = 'off' | 'pen' | 'eraser' | 'highlight'

/** A single ink point. `t` (epoch ms) and `p` (pointer pressure 0–1) feed the
 * handwriting recognizer; both are optional so boards saved before they were
 * captured still load. */
interface InkPoint {
  x: number
  y: number
  t?: number
  p?: number
}

/** A pen stroke stored in flow (board) coordinates so it pans & zooms with the canvas. */
interface Stroke {
  id: string
  color: string
  /** Width in flow units (so it scales with zoom, like ink on paper). */
  width: number
  points: InkPoint[]
}

/** A pasted / uploaded image placed on the board, in flow coordinates. */
interface ImgEl {
  id: string
  src: string
  x: number
  y: number
  w: number
  h: number
}

/** Flow bounds of pasted problem images — treated as occupied board space. */
function imageOccupied(images: ImgEl[]): BoardBounds[] {
  return images.map((im) => ({ minX: im.x, minY: im.y, maxX: im.x + im.w, maxY: im.y + im.h }))
}

/** Pasted problems + prior write boxes on a hint card (so new boxes land in fresh space). */
function cardOccupied(images: ImgEl[], card?: HintCard): BoardBounds[] {
  const occupied = imageOccupied(images)
  if (!card) return occupied
  const extra: BoardBounds[] = [...(card.usedWriteBoxes ?? [])]
  for (const b of Object.values(card.writeBoxes ?? {})) extra.push(b)
  if (card.heldZone) extra.push(card.heldZone.box)
  return extra.length ? [...occupied, ...extra] : occupied
}

interface HintCard {
  id: string
  /** Where the tutor writes on the board (flow coordinates). */
  anchor: { x: number; y: number }
  /** Highlight region on the board (flow coordinates). */
  regionFlow?: { x: number; y: number; w: number; h: number }
  region?: string
  boardImage?: string
  /** Raw SAY narration — includes inline [[...]] board markers + LaTeX. */
  text: string
  strategy?: string
  step?: string
  status: 'loading' | 'streaming' | 'done' | 'error'
  error?: string
  history: HintTurn[]
  followup: string
  mode: 'hint' | 'solve' | 'generalize' | 'voice'
  level: number
  hintType?: HintTypeId
  tracked: boolean
  responded?: boolean
  /** How many inline markers the narration typewriter has crossed. */
  firedMarkers: number
  /** State of each fired write-zone marker, keyed by marker index. */
  writeStates: Record<number, WriteZoneState>
  /** Fixed flow bounds for each write box — locked when the marker first appears. */
  writeBoxes: Record<number, BoardBounds>
  /** Prior write-box regions on this card — keeps new boxes in fresh blank space. */
  usedWriteBoxes?: BoardBounds[]
  /**
   * A write box the student submitted for checking. Kept on the card (not the
   * narration) so it stays visible while/after the tutor reads it, instead of
   * vanishing the moment new narration replaces the old markers.
   */
  heldZone?: { box: BoardBounds; label?: string; state: 'checking' | 'done' }
  complete?: boolean
  boardBounds?: BoardBounds
  /** How many times the student clicked "Give me another hint" on this card. */
  nudgeCount?: number
  /** Max ladder rung chosen via Small/Medium/Large when the card was created. */
  maxLevel?: number
  /** Clarifying Q&A appended below the main hint — never replaces it. */
  clarifications?: Array<{
    id: string
    question: string
    answer: string
    status: 'loading' | 'streaming' | 'done'
  }>
  /** Each STEP field parsed from this hint — only `steps[steps.length - 1]` may carry a write marker. */
  steps: string[]
  /** How many of `steps` are currently revealed into `text` (gated behind a check-in response). */
  revealedSteps: number
  /** Per-step-index count of "I'm confused" re-explain attempts (capped in the UI). */
  reexplainCounts: Record<number, number>
  /** True while a re-explain request for the currently-gating step is in flight. */
  reexplaining?: boolean
}

const DEFAULT_HINT_PROMPT =
  'Read my work first: what strategy have I started and what step am I on? Then give ONE hint for my very next move from the equations I already wrote — not a shortcut from a different approach.'

const HINT_SIZES = [
  { level: 1 as const, label: 'Small', title: 'Small hint — gentle nudge' },
  { level: 2 as const, label: 'Medium', title: 'Medium hint — concept or strategy' },
  { level: 4 as const, label: 'Large', title: 'Large hint — concrete next step' },
]

/** Em dashes are banned from all tutor output — soften them into commas. */
function stripEmDashes(text: string): string {
  return text.replace(/\s*—\s*/g, ', ').replace(/—/g, ', ')
}

/**
 * Strip markdown the model sometimes emits despite instructions. By default
 * also strips [[...]] board markers (for plain display text like clarify/
 * voice, which never carry them anyway). Pass `keepMarkers` for hint-mode
 * STEP text, which MUST retain [[write|...]] / [[highlight|...]] syntax —
 * `card.text` is what TutorNarration's typewriter parses to fire them in
 * sync with the reveal; stripping them here would silently disable both
 * features. TutorNarration and speakableNarration already know to hide
 * marker syntax from what's shown/spoken, so keeping it in the stored text
 * is always safe.
 */
function cleanTutorProse(text: string, opts: { keepMarkers?: boolean } = {}): string {
  const cleaned = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/\nCOMPLETE:\s*(yes|no|true|false)\s*/gi, '\n')
  return stripEmDashes(opts.keepMarkers ? cleaned : stripMarkers(cleaned)).trim()
}

/** Small = 1 micro-step, Medium = up to 2, Large = up to 3 — mirrors server/math.js's cap. */
function maxStepsForLevel(level: number): number {
  if (level >= 4) return 3
  if (level === 2) return 2
  return 1
}

/**
 * Parse the structured hint format (WHERE / TYPE / COMPLETE / STEP 1 / STEP 2 / STEP 3).
 * Handles partial streams. `steps` holds each STEP field's text separately —
 * only `steps[steps.length - 1]` may legitimately carry a [[write|...]] marker.
 * Falls back to the legacy single SAY/HINT body (or a bare tail) for any
 * response that never produces a "STEP 1:" header, so older/deviating model
 * output still renders as a single-step hint instead of nothing.
 */
function parseHintResponse(acc: string): {
  type?: HintTypeId
  strategy?: string
  step?: string
  complete?: boolean
  hint: string
  steps: string[]
} {
  if (!acc.trim()) return { hint: '', steps: [] }

  const typeM = acc.match(/TYPE:\s*([a-z]+)/i)
  const type =
    typeM && isHintTypeId(typeM[1].toLowerCase()) ? (typeM[1].toLowerCase() as HintTypeId) : undefined

  const completeM = acc.match(/COMPLETE:\s*(yes|true|no|false)/i)
  const complete = completeM ? /^(yes|true)$/i.test(completeM[1]) : undefined

  const whereM = acc.match(
    /WHERE:\s*([\s\S]*?)(?=\n\s*TYPE:|\n\s*COMPLETE:|\n\s*(?:STEP\s*1|SAY|HINT):|$)/i
  )
  let strategy: string | undefined
  let step: string | undefined
  if (whereM) {
    strategy = whereM[1].match(/Strategy:\s*(.+)/i)?.[1]?.trim()
    step = whereM[1].match(/Step:\s*(.+)/i)?.[1]?.trim()
  }

  let steps: string[] = []
  let hint = ''

  const step1Idx = acc.search(/STEP\s*1\s*:/i)
  if (step1Idx !== -1) {
    // Split the body into each STEP field's raw text. parts[0] is always ''
    // (everything before the first "STEP 1:" match), so drop it.
    const body = acc.slice(step1Idx)
    steps = body
      .split(/STEP\s*\d+\s*:\s*/i)
      .slice(1)
      .map((s) => cleanTutorProse(s.trim(), { keepMarkers: true }))
      .filter(Boolean)
    hint = steps.join(' ')
  } else {
    const hintM = acc.match(/(?:SAY|HINT):\s*([\s\S]*)/i)
    hint = hintM ? hintM[1].trim() : ''

    // Legacy / in-progress: TYPE then body without a SAY:/HINT: label
    if (!hint && typeM) {
      const tail = acc.slice(acc.indexOf(typeM[0]) + typeM[0].length).trim()
      if (tail && !/^WHERE:/i.test(tail)) hint = tail.replace(/^(?:SAY|HINT):\s*/i, '').trim()
    }

    // Still streaming structural headers — hide partial noise
    if (!hint && !whereM && !typeM) {
      if (
        /^\s*(W(H(E(R(E(:)?)?)?)?)?)?$/i.test(acc) ||
        /^\s*T(Y(P(E(:\s*[a-z]*)?)?)?)?$/i.test(acc) ||
        /^\s*S(A(Y(:)?)?)?$/i.test(acc) ||
        /^\s*S(T(E(P(\s*1)?)?)?)?$/i.test(acc)
      ) {
        return { hint: '', steps: [] }
      }
      if (!/^WHERE:/i.test(acc)) hint = acc.trim()
    }

    hint = cleanTutorProse(hint, { keepMarkers: true })
    steps = hint ? [hint] : []
  }

  return { type, strategy, step, complete, hint, steps }
}

/**
 * Spoken form of the narration streamed so far: markers stripped, LaTeX
 * converted to words, and any still-incomplete trailing marker/math span held
 * back so speech never reads half a construct. Deterministic and append-only,
 * so deltas can be pushed to the incremental speaker.
 */
function speakableNarration(sayRaw: string, done: boolean): string {
  const { tokens, pendingTail } = parseNarration(sayRaw, done)
  let stable = ''
  for (const t of tokens) {
    if (t.kind === 'text') stable += t.text
    else if (t.kind === 'math') stable += ` \\(${t.tex}\\) `
    else stable += ' '
  }
  if (done && pendingTail) stable += ` ${stripMarkers(pendingTail)} `
  return speakableMathText(stable)
}

/** Speak an already-complete step's text aloud in one shot (used when a gated step is revealed). */
function speakStepAloud(speaker: IncrementalSpeaker | null, text: string) {
  if (!speaker || !text.trim()) return
  const spoken = speakableNarration(text, true)
  const parts = spoken.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? []
  for (const part of parts) speaker.pushSentence(part)
}

const PEN_COLORS = ['#1e293b', '#2563eb', '#dc2626', '#059669', '#d97706', '#0d9488']
const PEN_SIZES = [2.5, 4, 7]
const CAPTURE_BG = '#d7d7d7'
/** How long a student can stall (no drawing) before the tutor offers help. */
/** Frosted "selected" liquid-glass state — shared by every toolbar toggle. */
const ACTIVE_GLASS: React.CSSProperties = {
  background: 'linear-gradient(-75deg, rgba(255,255,255,0.55), rgba(255,255,255,0.82), rgba(255,255,255,0.5))',
  boxShadow:
    'inset 0 0 0 1.5px rgba(0,0,0,0.2), inset 0 0.125em 0.125em rgba(255,255,255,0.55), 0 1px 2px rgba(0,0,0,0.06)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  color: '#111',
  fontWeight: 600,
}

type ToolbarDock = 'top' | 'bottom' | 'left' | 'right' | 'free'
const TOOLBAR_DOCK_KEY = 'math-toolbar-dock-v1'
const TOOLBAR_SNAP_PX = 56

function readToolbarDock(): { dock: ToolbarDock; free: { x: number; y: number } } {
  try {
    const raw = sessionStorage.getItem(TOOLBAR_DOCK_KEY)
    if (raw) return JSON.parse(raw) as { dock: ToolbarDock; free: { x: number; y: number } }
  } catch {
    /* ignore */
  }
  return { dock: 'top', free: { x: 0, y: 0 } }
}

function snapToolbarDock(
  x: number,
  y: number,
  w: number,
  h: number,
  paneW: number,
  paneH: number,
): { dock: ToolbarDock; free: { x: number; y: number } } {
  const distTop = y
  const distBottom = paneH - y - h
  const distLeft = x
  const distRight = paneW - x - w
  const min = Math.min(distTop, distBottom, distLeft, distRight)
  if (min > TOOLBAR_SNAP_PX) return { dock: 'free', free: { x, y } }
  if (min === distTop) return { dock: 'top', free: { x: 0, y: 0 } }
  if (min === distBottom) return { dock: 'bottom', free: { x: 0, y: 0 } }
  if (min === distLeft) return { dock: 'left', free: { x: 0, y: 0 } }
  return { dock: 'right', free: { x: 0, y: 0 } }
}

type ToolbarSize = { w: number; h: number }

/** Screen-space rect for the faint dock preview while dragging.
 *  `size` must be the footprint the bar will have in that dock orientation. */
function toolbarDockGhostRect(
  dock: ToolbarDock,
  size: ToolbarSize,
  paneW: number,
  paneH: number,
  competition: boolean,
): { left: number; top: number; width: number; height: number } | null {
  if (dock === 'free') return null
  const topOffset = competition ? 12 : 8
  // Keep the preview above the mic / voice control at the bottom edge.
  const bottomOffset = competition ? 64 : 76
  const { w, h } = size
  switch (dock) {
    case 'top':
      return { left: (paneW - w) / 2, top: topOffset, width: w, height: h }
    case 'bottom':
      return { left: (paneW - w) / 2, top: paneH - bottomOffset - h, width: w, height: h }
    case 'left':
      return {
        left: 12,
        top: Math.max(topOffset, (paneH - h) / 2),
        width: w,
        height: h,
      }
    case 'right':
      return {
        left: paneW - 12 - w,
        top: Math.max(topOffset, (paneH - h) / 2),
        width: w,
        height: h,
      }
    default:
      return null
  }
}

/** Briefly flip the shell's flex layout off-screen to measure the other orientation. */
function measureToolbarOrientation(el: HTMLElement, vertical: boolean): ToolbarSize {
  const body = el.querySelector('.math-toolbar-body') as HTMLElement | null
  const prev = {
    className: el.className,
    cssText: el.style.cssText,
    bodyCss: body?.style.cssText ?? '',
    kids: [] as { el: HTMLElement; css: string }[],
  }
  if (body) {
    body.querySelectorAll<HTMLElement>(':scope > div').forEach((kid) => {
      prev.kids.push({ el: kid, css: kid.style.cssText })
    })
  }

  el.classList.toggle('is-vertical', vertical)
  el.classList.remove('is-dragging', 'dock-top', 'dock-bottom', 'dock-left', 'dock-right')
  el.style.position = 'absolute'
  el.style.left = '-10000px'
  el.style.top = '0'
  el.style.transform = 'none'
  el.style.right = 'auto'
  el.style.bottom = 'auto'
  el.style.visibility = 'hidden'
  el.style.pointerEvents = 'none'
  el.style.width = 'max-content'
  el.style.height = 'max-content'
  el.style.maxWidth = 'none'
  el.style.maxHeight = 'none'

  if (body) {
    body.style.display = 'flex'
    body.style.flexDirection = vertical ? 'column' : 'row'
    body.style.flexWrap = 'nowrap'
    body.style.alignItems = vertical ? 'stretch' : 'center'
    body.style.width = vertical ? '' : 'max-content'
    body.style.maxWidth = 'none'
    body.style.maxHeight = vertical ? 'min(70vh, 640px)' : 'none'
    body.style.overflow = vertical ? 'auto' : 'visible'
    prev.kids.forEach(({ el: kid }) => {
      kid.style.display = 'flex'
      kid.style.flexDirection = vertical ? 'column' : 'row'
      kid.style.alignItems = vertical ? 'stretch' : 'center'
    })
  }

  const size = { w: el.offsetWidth, h: el.offsetHeight }

  el.className = prev.className
  el.style.cssText = prev.cssText
  if (body) body.style.cssText = prev.bodyCss
  prev.kids.forEach(({ el: kid, css }) => {
    kid.style.cssText = css
  })

  return size
}

const TOOLBAR_FLIP_MS = 320
const TOOLBAR_FLIP_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** Positional styles are CSS classes / direct DOM — never React `style`, so
 *  re-renders mid-drag cannot clear the live translate3d. */
function toolbarShellStyle(
  free: { x: number; y: number },
  dock: ToolbarDock,
  dragging: boolean,
  snapping: boolean,
): CSSProperties {
  const base: CSSProperties = {
    position: 'absolute',
    zIndex: dragging || snapping ? 60 : 45,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 0,
  }
  if (dragging || snapping) {
    return { ...base, touchAction: 'none', userSelect: 'none', willChange: 'transform' }
  }
  // Free dock: commit left/top once. Docked edges use CSS classes instead.
  if (dock === 'free') {
    return { ...base, left: free.x, top: free.y }
  }
  return base
}

let seq = 0
const uid = () => `${Date.now().toString(36)}-${seq++}`

/**
 * The ink <svg> lives inside the (transformed) edge-label layer. A 0×0 svg with
 * overflow:visible is not reliably painted by Chrome, so we give it a large
 * real surface and shift all flow coordinates by INK_OFFSET into it.
 */
const INK_OFFSET = 100000

function pointsToPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return ''
  const c = (p: { x: number; y: number }) => `${p.x + INK_OFFSET} ${p.y + INK_OFFSET}`
  if (points.length === 1) {
    const p = points[0]
    return `M ${c(p)} L ${p.x + INK_OFFSET + 0.01} ${p.y + INK_OFFSET}`
  }
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${c(p)}`).join(' ')
}

function distToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function strokeHit(p: { x: number; y: number }, st: Stroke, threshold: number): boolean {
  const pts = st.points
  if (pts.length === 0) return false
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) < threshold + st.width
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(p, pts[i - 1], pts[i]) < threshold + st.width) return true
  }
  return false
}

function imageHit(p: { x: number; y: number }, im: ImgEl): boolean {
  return p.x >= im.x && p.x <= im.x + im.w && p.y >= im.y && p.y <= im.y + im.h
}

function screenRectToFlow(
  rect: { x: number; y: number; w: number; h: number },
  rf: ReturnType<typeof useReactFlow>,
  wrapRect: DOMRect
) {
  const tl = rf.screenToFlowPosition({ x: wrapRect.left + rect.x, y: wrapRect.top + rect.y })
  const br = rf.screenToFlowPosition({
    x: wrapRect.left + rect.x + rect.w,
    y: wrapRect.top + rect.y + rect.h,
  })
  return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y }
}

/** Place tutor note beside or below the highlighted work. */
function tutorAnchorFromRect(
  rect: { x: number; y: number; w: number; h: number },
  rf: ReturnType<typeof useReactFlow>,
  wrapRect: DOMRect
) {
  const preferBelow = rect.y + rect.h + 90 < wrapRect.height
  const screenX = preferBelow ? rect.x + 8 : rect.x + rect.w + 20
  const screenY = preferBelow ? rect.y + rect.h + 14 : rect.y + rect.h * 0.15
  return rf.screenToFlowPosition({ x: wrapRect.left + screenX, y: wrapRect.top + screenY })
}

function strokeCentroid(strokes: Stroke[]): { x: number; y: number } | null {
  let sx = 0
  let sy = 0
  let n = 0
  for (const st of strokes) {
    for (const p of st.points) {
      sx += p.x
      sy += p.y
      n++
    }
  }
  return n ? { x: sx / n, y: sy / n } : null
}

export default function MathLayer({
  adventureId,
  onHasContentChange,
  competition = false,
}: {
  adventureId?: string | null
  onHasContentChange?: (hasContent: boolean) => void
  /**
   * Competition-math mode (AMC page): no typed prompt input at the bottom
   * (voice + hints only), and boards never adopt orphaned ink from other
   * scopes — every board is created explicitly and starts blank.
   */
  competition?: boolean
} = {}) {
  const rf = useReactFlow()
  const { x, y, zoom } = useViewport()
  const apiKey = useStore((s) => s.apiKey)
  const adventures = useStore((s) => s.adventures)
  const adventuresRef = useRef(adventures)
  useEffect(() => void (adventuresRef.current = adventures), [adventures])

  const overlayRef = useRef<HTMLDivElement | null>(null)

  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState(PEN_COLORS[0])
  const [size, setSize] = useState(PEN_SIZES[1])
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [draft, setDraft] = useState<Stroke | null>(null)
  const draftRef = useRef<Stroke | null>(null)
  useEffect(() => void (draftRef.current = draft), [draft])
  const [images, setImages] = useState<ImgEl[]>([])
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null)
  const [cards, setCards] = useState<HintCard[]>([])
  const [hintSize, setHintSize] = useState<1 | 2 | 4>(2)
  const [sel, setSel] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [prompt, setPrompt] = useState('')

  // ── Live handwriting → LaTeX recognition (MyScript, via server proxy) ──
  // Debounced off every stroke mutation (draw, erase, undo, clear). The result
  // maps each recognized expression to the stroke IDs that drew it, which is
  // what powers "REF: n" hint highlighting.
  const [inkModel, setInkModel] = useState<InkModel>({ lines: [] })
  const inkModelRef = useRef(inkModel)
  useEffect(() => void (inkModelRef.current = inkModel), [inkModel])
  const [glowStrokeIds, setGlowStrokeIds] = useState<ReadonlySet<string>>(new Set())
  const recognitionOffRef = useRef(false) // set when the server has no MyScript keys
  const recognitionSeqRef = useRef(0)

  useEffect(() => {
    if (recognitionOffRef.current) return
    const seq = ++recognitionSeqRef.current
    if (strokes.length === 0) {
      setInkModel({ lines: [] })
      return
    }
    const timer = setTimeout(() => {
      void recognizeInk(strokes.map((s) => ({ id: s.id, points: s.points })))
        .then((model) => {
          if (recognitionSeqRef.current === seq) setInkModel(model)
        })
        .catch((err) => {
          if (err instanceof RecognitionUnavailableError) recognitionOffRef.current = true
          // Transient failures are non-fatal: hints still work from the images.
        })
    }, 800)
    return () => clearTimeout(timer)
  }, [strokes])

  /**
   * Glow the strokes behind the given recognized line numbers. Stays lit
   * until the NEXT highlight call replaces it (or the board changes under
   * it) — no auto fade-out, so it doesn't disappear mid-conversation while
   * you're still looking at it.
   */
  const highlightRecognizedLines = useCallback((lineNumbers: number[]) => {
    const ids = new Set<string>()
    for (const n of lineNumbers) {
      const line = inkModelRef.current.lines.find((l) => l.n === n)
      if (line) for (const id of line.strokeIds) ids.add(id)
    }
    if (ids.size === 0) return
    setGlowStrokeIds(ids)
  }, [])

  /** Numbered LaTeX transcript for the hint request (lines the recognizer could label). */
  const recognizedLinesPayload = useCallback(
    () =>
      inkModelRef.current.lines
        .filter((l) => !!l.latex)
        .map((l) => ({ n: l.n, latex: l.latex as string })),
    []
  )

  const [ttsOK, setTtsOK] = useState(false)
  const hintSpeakerRef = useRef<IncrementalSpeaker | null>(null)
  const speakerRef = useRef<IncrementalSpeaker | null>(null)
  const [hintSpeakingId, setHintSpeakingId] = useState<string | null>(null)
  const [speakerOn, setSpeakerOn] = useState(true)

  // Wait for the workspace store to hydrate before touching board storage —
  // pre-hydration the app runs with a throwaway default adventure id, and
  // loading/saving under it stole or clobbered the real board on every boot.
  // AMC (/amc) has its own auth and boards — skip the workspace gate there.
  const [storeHydrated, setStoreHydrated] = useState(
    () => competition || useStore.persist.hasHydrated()
  )
  useEffect(() => {
    if (competition || storeHydrated) return
    const unsub = useStore.persist.onFinishHydration(() => setStoreHydrated(true))
    return unsub
  }, [competition, storeHydrated])

  const boardHydratedRef = useRef(false)
  const boardAdventureRef = useRef<string | null>(null)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const promptRef = useRef(prompt)
  useEffect(() => void (promptRef.current = prompt), [prompt])

  const flushBoardPersist = useCallback((adventureOverride?: string) => {
    const id = adventureOverride ?? boardAdventureRef.current
    if (!id || !boardHydratedRef.current) return
    const strokes = strokesRef.current
    const images = imagesRef.current
    const promptValue = promptRef.current
    // StrictMode / remount races can flush empty refs right after restore and
    // upload that empty snapshot to the cloud — wiping real work on refresh.
    // Skip empty flushes when storage still has ink (intentional Clear ink
    // calls clearMathBoard first, so this guard won't block a real clear).
    if (strokes.length === 0 && images.length === 0 && !promptValue?.trim()) {
      const existing = loadMathBoard(id, [], { adoptOrphans: false })
      if (existing && (existing.strokes.length > 0 || existing.images.length > 0 || existing.prompt)) {
        return
      }
    }
    saveMathBoard(id, {
      strokes,
      images,
      prompt: promptValue,
    })
  }, [])

  // ── Restore whiteboard ink per adventure ──
  useEffect(() => {
    const boardReady = competition || storeHydrated
    if (!adventureId || !boardReady) return
    boardHydratedRef.current = false
    boardAdventureRef.current = adventureId

    const snap = loadMathBoard(
      adventureId,
      adventuresRef.current.map((a) => a.id),
      { adoptOrphans: !competition }
    )
    if (snap) {
      setStrokes(snap.strokes)
      setImages(snap.images)
      setPrompt(snap.prompt ?? '')
      // Sync the persist refs NOW, not on next render — otherwise an immediate
      // unmount (StrictMode remount, fast adventure switch, dev reload) flushes
      // the stale empty refs back over the snapshot we just loaded = data loss.
      strokesRef.current = snap.strokes
      imagesRef.current = snap.images
      promptRef.current = snap.prompt ?? ''
      setSelectedImageId(null)
      setCards([])
      setDraft(null)
      if (snap.strokes.length > 0 || snap.images.length > 0) {
        hasAttempt.current = true
        setPhase('working')
      } else {
        hasAttempt.current = false
        setPhase('awaiting_problem')
      }
    } else {
      setStrokes([])
      setImages([])
      setPrompt('')
      strokesRef.current = []
      imagesRef.current = []
      promptRef.current = ''
      setSelectedImageId(null)
      setCards([])
      setDraft(null)
      hasAttempt.current = false
      setPhase('awaiting_problem')
    }
    past.current = []
    future.current = []
    setHistTick((t) => t + 1)
    // Defer "hydrated" so the strokes=[] → strokesRef sync effect in THIS
    // commit can't run with hydrated=true and wipe the refs we just restored.
    const aid = adventureId
    queueMicrotask(() => {
      if (boardAdventureRef.current === aid) boardHydratedRef.current = true
    })

    return () => {
      // Force a flush on unmount even if the microtask hasn't flipped hydrated.
      boardHydratedRef.current = true
      flushBoardPersist(adventureId)
      boardHydratedRef.current = false
    }
  }, [adventureId, storeHydrated, competition, flushBoardPersist])

  useEffect(() => {
    if (!adventureId || !boardHydratedRef.current) return
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      if (boardAdventureRef.current === adventureId) flushBoardPersist()
    }, 600)
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    }
  }, [adventureId, strokes, images, prompt, flushBoardPersist])

  useEffect(() => {
    const onUnload = () => flushBoardPersist()
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushBoardPersist()
    }
    window.addEventListener('beforeunload', onUnload)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      document.removeEventListener('visibilitychange', onHide)
      flushBoardPersist()
    }
  }, [flushBoardPersist])

  // ── Tutoring session (problem → work → stuck → consent → hint → response) ──
  const [phase, setPhase] = useState<SessionPhase>('awaiting_problem')
  const phaseRef = useRef(phase)
  useEffect(() => void (phaseRef.current = phase), [phase])
  const lastActivity = useRef(Date.now())
  const stuckFired = useRef(false)
  const hasAttempt = useRef(false) // has the student drawn since the problem was set?

  /** Mark the moment a problem enters the board — starts the "watch" clock. */
  const markProblemSet = useCallback(() => {
    if (phaseRef.current !== 'awaiting_problem') return
    lastActivity.current = Date.now()
    stuckFired.current = false
    setPhase('working')
  }, [])

  /** Any drawing/erasing counts as progress — resets the stuck timer. */
  const noteActivity = useCallback(() => {
    lastActivity.current = Date.now()
    stuckFired.current = false
    hasAttempt.current = true
    const p = phaseRef.current
    if (p === 'awaiting_problem') markProblemSet()
    else if (p === 'stuck_prompt') setPhase('working')
  }, [markProblemSet])

  // Tell the host the moment there's any drawing/content so the empty state can hide.
  const hasContent = strokes.length > 0 || images.length > 0 || cards.length > 0 || !!draft
  useEffect(() => {
    onHasContentChange?.(hasContent)
  }, [hasContent, onHasContentChange])

  // Stuck auto-prompt removed — student requests hints explicitly via toolbar or Thales card.

  const drawing = useRef(false)
  const selStart = useRef<{ x: number; y: number } | null>(null)
  const selRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const toolRef = useRef(tool)
  useEffect(() => void (toolRef.current = tool), [tool])
  useEffect(() => {
    if (tool !== 'off') setSelectedImageId(null)
  }, [tool])

  // ── Undo / redo history (strokes + images) ──
  const strokesRef = useRef(strokes)
  const imagesRef = useRef(images)
  const cardsRef = useRef(cards)
  // Only mirror state → refs after restore has committed. The restore effect
  // writes refs directly; copying the initial [] here used to clobber them.
  useEffect(() => {
    if (!boardHydratedRef.current) return
    strokesRef.current = strokes
  }, [strokes])
  useEffect(() => {
    if (!boardHydratedRef.current) return
    imagesRef.current = images
  }, [images])
  useEffect(() => void (cardsRef.current = cards), [cards])
  const past = useRef<{ strokes: Stroke[]; images: ImgEl[] }[]>([])
  const future = useRef<{ strokes: Stroke[]; images: ImgEl[] }[]>([])
  const erasePushed = useRef(false)
  const imgGestureRef = useRef<{
    kind: 'drag' | 'resize'
    id: string
    startFlow: { x: number; y: number }
    startIm: ImgEl
  } | null>(null)
  const [, setHistTick] = useState(0) // re-render so toolbar enabled-state updates

  const snapshot = () => ({ strokes: strokesRef.current, images: imagesRef.current })
  const pushHistory = useCallback((snap?: { strokes: Stroke[]; images: ImgEl[] }) => {
    past.current.push(snap ?? snapshot())
    if (past.current.length > 60) past.current.shift()
    future.current = []
    setHistTick((t) => t + 1)
  }, [])

  const undo = useCallback(() => {
    if (past.current.length === 0) return
    future.current.push(snapshot())
    const prev = past.current.pop()!
    setStrokes(prev.strokes)
    setImages(prev.images)
    setHistTick((t) => t + 1)
  }, [])

  const redo = useCallback(() => {
    if (future.current.length === 0) return
    past.current.push(snapshot())
    const next = future.current.pop()!
    setStrokes(next.strokes)
    setImages(next.images)
    setHistTick((t) => t + 1)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return

      if (e.key === 'Escape') {
        setSelectedImageId(null)
        return
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selectedImageId) return
        e.preventDefault()
        pushHistory()
        setImages((prev) => prev.filter((im) => im.id !== selectedImageId))
        setSelectedImageId(null)
        return
      }

      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, selectedImageId, pushHistory])

  const paneRect = () => overlayRef.current?.getBoundingClientRect() ?? null

  // Fixed UI chrome the hint card must never cover: the top toolbar, the
  // bottom mic/voice bar, and React Flow's own zoom controls + minimap.
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const micBarRef = useRef<HTMLElement | null>(null)
  const [chromeRects, setChromeRects] = useState<ScreenRect[]>([])
  const savedToolbarDock = readToolbarDock()
  const [toolbarDock, setToolbarDock] = useState<ToolbarDock>(() => savedToolbarDock.dock)
  const [toolbarFree, setToolbarFree] = useState(() => savedToolbarDock.free)
  const [toolbarDragging, setToolbarDragging] = useState(false)
  const [toolbarSnapping, setToolbarSnapping] = useState(false)
  const [toolbarSnapDock, setToolbarSnapDock] = useState<ToolbarDock | null>(null)
  // Freeze side/top layout for the whole drag so the bar doesn't reshape
  // under the cursor the moment you grab it.
  const [toolbarDragVertical, setToolbarDragVertical] = useState(false)
  const toolbarDragOffset = useRef({ x: 0, y: 0 })
  const toolbarFreeRef = useRef(toolbarFree)
  const toolbarGhostRef = useRef<HTMLDivElement | null>(null)
  const toolbarDraggingRef = useRef(false)
  const toolbarPaneOrigin = useRef({ left: 0, top: 0, width: 0, height: 0 })
  const toolbarGrabClient = useRef<{ x: number; y: number } | null>(null)
  const toolbarFlipFirst = useRef<DOMRect | null>(null)
  /** Real measured footprints for each orientation — ghost previews the target, not a rotate of the live bar. */
  const toolbarOrientSize = useRef<{ horizontal: ToolbarSize | null; vertical: ToolbarSize | null }>({
    horizontal: null,
    vertical: null,
  })
  useEffect(() => {
    toolbarFreeRef.current = toolbarFree
  }, [toolbarFree])

  // Keep both orientation sizes fresh whenever the bar is settled.
  useLayoutEffect(() => {
    if (toolbarDragging || toolbarSnapping) return
    const el = toolbarRef.current
    if (!el) return
    const vertical = toolbarDock === 'left' || toolbarDock === 'right'
    const live = { w: el.offsetWidth, h: el.offsetHeight }
    if (live.w < 8 || live.h < 8) return
    if (vertical) toolbarOrientSize.current.vertical = live
    else toolbarOrientSize.current.horizontal = live

    const missing = vertical ? 'horizontal' : 'vertical'
    if (!toolbarOrientSize.current[missing]) {
      toolbarOrientSize.current[missing] = measureToolbarOrientation(el, missing === 'vertical')
    }
  }, [toolbarDock, toolbarDragging, toolbarSnapping, competition])

  // After React applies is-dragging (and drops dock transforms), put the
  // grab point back under the cursor so the bar never "slips" on pickup.
  useLayoutEffect(() => {
    if (!toolbarDragging) return
    const grab = toolbarGrabClient.current
    const el = toolbarRef.current
    if (!grab || !el) return
    const origin = toolbarPaneOrigin.current
    const next = {
      x: grab.x - origin.left - toolbarDragOffset.current.x,
      y: grab.y - origin.top - toolbarDragOffset.current.y,
    }
    toolbarFreeRef.current = next
    el.style.left = '0px'
    el.style.top = '0px'
    el.style.right = 'auto'
    el.style.bottom = 'auto'
    el.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`
  }, [toolbarDragging, toolbarDragVertical])

  // FLIP into the final dock: layout commits first, then we invert+play so
  // the bar morphs into place (including horizontal ↔ vertical) without a pop.
  useLayoutEffect(() => {
    if (!toolbarSnapping) return
    const el = toolbarRef.current
    const first = toolbarFlipFirst.current
    if (!el || !first) {
      setToolbarSnapping(false)
      return
    }

    el.style.transition = 'none'
    el.style.left = ''
    el.style.top = ''
    el.style.right = ''
    el.style.bottom = ''
    el.style.transform = ''
    el.style.transformOrigin = '0 0'

    const last = el.getBoundingClientRect()
    const dx = first.left - last.left
    const dy = first.top - last.top
    const firstVertical = first.height > first.width * 1.15
    const lastVertical = last.height > last.width * 1.15
    const orientChange = firstVertical !== lastVertical
    const sx = orientChange ? first.width / Math.max(last.width, 1) : 1
    const sy = orientChange ? first.height / Math.max(last.height, 1) : 1

    // Skip tiny moves — already home.
    if (Math.hypot(dx, dy) < 1.5 && Math.abs(sx - 1) < 0.02 && Math.abs(sy - 1) < 0.02) {
      toolbarFlipFirst.current = null
      el.style.transformOrigin = ''
      el.style.pointerEvents = ''
      el.style.willChange = ''
      setToolbarSnapping(false)
      return
    }

    const from =
      orientChange
        ? `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})`
        : `translate3d(${dx}px, ${dy}px, 0)`
    const to = orientChange ? 'translate3d(0,0,0) scale(1)' : 'translate3d(0,0,0)'
    el.style.transform = from

    let done = false
    let timeoutId = 0
    let raf1 = 0
    let raf2 = 0
    const finish = () => {
      if (done) return
      done = true
      window.clearTimeout(timeoutId)
      el.removeEventListener('transitionend', onEnd)
      el.style.transition = ''
      el.style.transform = ''
      el.style.transformOrigin = ''
      el.style.pointerEvents = ''
      el.style.willChange = ''
      toolbarFlipFirst.current = null
      setToolbarSnapping(false)
    }
    const onEnd = (te: TransitionEvent) => {
      if (te.propertyName && te.propertyName !== 'transform') return
      finish()
    }

    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        el.style.transition = `transform ${TOOLBAR_FLIP_MS}ms ${TOOLBAR_FLIP_EASE}`
        el.style.transform = to
        el.addEventListener('transitionend', onEnd)
        timeoutId = window.setTimeout(finish, TOOLBAR_FLIP_MS + 80)
      })
    })

    return () => {
      window.cancelAnimationFrame(raf1)
      window.cancelAnimationFrame(raf2)
      window.clearTimeout(timeoutId)
      el.removeEventListener('transitionend', onEnd)
    }
  }, [toolbarSnapping, toolbarDock])

  useLayoutEffect(() => {
    const update = () => {
      // Skip during drag/snap — measuring mid-motion causes jank.
      if (toolbarDraggingRef.current || toolbarSnapping) return
      const wrap = paneRect()
      if (!wrap) {
        setChromeRects([])
        return
      }
      const rects: ScreenRect[] = []
      const add = (el: Element | null | undefined) => {
        if (!el) return
        const r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) return
        rects.push({ left: r.left - wrap.left, top: r.top - wrap.top, right: r.right - wrap.left, bottom: r.bottom - wrap.top })
      }
      add(toolbarRef.current)
      add(micBarRef.current)
      const flowRoot = overlayRef.current?.closest('.react-flow')
      add(flowRoot?.querySelector('.react-flow__controls') ?? null)
      add(flowRoot?.querySelector('.react-flow__minimap') ?? null)
      setChromeRects(rects)
    }
    update()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    if (toolbarRef.current) ro?.observe(toolbarRef.current)
    window.addEventListener('resize', update)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [x, y, zoom, competition, toolbarDock, toolbarFree, toolbarDragging, toolbarSnapping])

  // ── Pointer handling ──
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const t = toolRef.current
    if (t === 'off') return
    e.preventDefault()
    try {
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    } catch {
      /* some pointer sources (e.g. simulated pens) have no capturable id */
    }

    if (t === 'highlight') {
      const r = paneRect()
      if (!r) return
      selStart.current = { x: e.clientX - r.left, y: e.clientY - r.top }
      const rect0 = { x: selStart.current.x, y: selStart.current.y, w: 0, h: 0 }
      selRef.current = rect0
      setSel(rect0)
      return
    }

    if (t === 'eraser') {
      drawing.current = true
      erasePushed.current = false
      noteActivity()
      eraseAt(e.clientX, e.clientY)
      return
    }

    // pen — record the pre-stroke state so this stroke can be undone
    drawing.current = true
    pushHistory()
    noteActivity()
    const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const pt: InkPoint = { ...pos, t: Date.now(), p: e.pressure > 0 ? e.pressure : undefined }
    setDraft({ id: uid(), color, width: size / zoom, points: [pt] })
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const t = toolRef.current
    if (t === 'highlight') {
      if (!selStart.current) return
      const r = paneRect()
      if (!r) return
      const cx = e.clientX - r.left
      const cy = e.clientY - r.top
      const s = selStart.current
      const rect = {
        x: Math.min(s.x, cx),
        y: Math.min(s.y, cy),
        w: Math.abs(cx - s.x),
        h: Math.abs(cy - s.y),
      }
      selRef.current = rect
      setSel(rect)
      return
    }

    if (!drawing.current) return
    if (t === 'eraser') {
      eraseAt(e.clientX, e.clientY)
      return
    }

    // pen
    const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const pt: InkPoint = { ...pos, t: Date.now(), p: e.pressure > 0 ? e.pressure : undefined }
    setDraft((d) => (d ? { ...d, points: [...d.points, pt] } : d))
  }

  const onPointerUp = () => {
    const t = toolRef.current
    if (t === 'highlight') {
      const rect = selRef.current
      selStart.current = null
      selRef.current = null
      if (rect && rect.w > 12 && rect.h > 12) void createHintFromRect(rect)
      setSel(null)
      return
    }
    if (drawing.current && t === 'pen') {
      const d = draftRef.current
      if (d && d.points.length > 0) {
        setStrokes((s) => [...s, d])
        noteStrokeForWriteZones(d)
      }
      setDraft(null)
    }
    if (drawing.current) noteActivity() // restart the "stuck" clock once they lift the pen
    drawing.current = false
  }

  const eraseAt = (clientX: number, clientY: number) => {
    const p = rf.screenToFlowPosition({ x: clientX, y: clientY })
    const threshold = 14 / zoom
    const curStrokes = strokesRef.current
    const curImages = imagesRef.current

    const hitImage = curImages.find((im) => imageHit(p, im))
    const nextImages = hitImage ? curImages.filter((im) => im.id !== hitImage.id) : curImages
    const nextStrokes = curStrokes.filter((st) => !strokeHit(p, st, threshold))

    if (nextImages.length === curImages.length && nextStrokes.length === curStrokes.length) return

    if (!erasePushed.current) {
      erasePushed.current = true
      pushHistory({ strokes: curStrokes, images: curImages })
    }
    if (hitImage && selectedImageId === hitImage.id) setSelectedImageId(null)
    if (nextImages !== curImages) setImages(nextImages)
    if (nextStrokes !== curStrokes) setStrokes(nextStrokes)
  }

  const onImagePointerDown = (e: React.PointerEvent, im: ImgEl, kind: 'drag' | 'resize') => {
    if (toolRef.current !== 'off') return
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setSelectedImageId(im.id)
    const startFlow = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    imgGestureRef.current = { kind, id: im.id, startFlow, startIm: { ...im } }
    if (kind === 'drag') pushHistory()
    if (kind === 'resize') pushHistory()
  }

  const onImagePointerMove = (e: React.PointerEvent) => {
    const g = imgGestureRef.current
    if (!g) return
    const cur = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const dx = cur.x - g.startFlow.x
    const dy = cur.y - g.startFlow.y
    setImages((prev) =>
      prev.map((im) => {
        if (im.id !== g.id) return im
        if (g.kind === 'drag') {
          return { ...im, x: g.startIm.x + dx, y: g.startIm.y + dy }
        }
        return {
          ...im,
          w: Math.max(40, g.startIm.w + dx),
          h: Math.max(40, g.startIm.h + dy),
        }
      })
    )
  }

  const onImagePointerUp = () => {
    imgGestureRef.current = null
  }

  // ── Paste / upload images (placed at viewport center, in flow coords) ──
  const placeImage = useCallback(
    (src: string) => {
      const img = new Image()
      img.onload = () => {
        const r = overlayRef.current?.getBoundingClientRect()
        // Slightly below the vertical middle so the pasted problem never lands
        // hidden behind the floating toolbar at the top of the board.
        const center = rf.screenToFlowPosition({
          x: (r?.left ?? 0) + (r?.width ?? 800) / 2,
          y: (r?.top ?? 0) + (r?.height ?? 600) * 0.58,
        })
        const maxW = 520
        const scale = Math.min(maxW / img.width, 1)
        const w = img.width * scale
        const h = img.height * scale
        pushHistory()
        const id = uid()
        setImages((prev) => [
          ...prev,
          { id, src, x: center.x - w / 2, y: center.y - h / 2, w, h },
        ])
        setSelectedImageId(id)
        setTool('off')
        markProblemSet()
      }
      img.src = src
    },
    [rf, pushHistory, markProblemSet]
  )

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            const reader = new FileReader()
            reader.onload = () => placeImage(String(reader.result))
            reader.readAsDataURL(file)
            e.preventDefault()
            return
          }
        }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [placeImage])

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => placeImage(String(reader.result))
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  // ── Capture a pane region as PNG ──
  // Ink and pasted images are composited manually (always reliable). The
  // exploration nodes/background are added best-effort via html2canvas, which
  // can throw on some CSS — if it does, we simply fall back to a clean canvas so
  // capturing NEVER fails.
  const captureRegion = async (rect: {
    x: number
    y: number
    w: number
    h: number
  }): Promise<{ region: string; board?: string }> => {
    const wrapRect = overlayRef.current!.getBoundingClientRect()
    const PX = 2.5 // output pixel density — higher = sharper handwriting for OCR

    // Best-effort node/background layer.
    let full: HTMLCanvasElement | null = null
    try {
      const paneEl = overlayRef.current!.closest('.react-flow') as HTMLElement
      const { default: html2canvas } = await import('html2canvas')
      full = await html2canvas(paneEl, {
        backgroundColor: CAPTURE_BG,
        scale: PX,
        useCORS: true,
        logging: false,
        ignoreElements: (el) => el.hasAttribute('data-html2canvas-ignore'),
      })
    } catch {
      full = null // fall back to a clean white board
    }
    const s = full ? full.width / wrapRect.width : PX

    const toCrop = (flowX: number, flowY: number, offX: number, offY: number, pxScale: number) => {
      const sp = rf.flowToScreenPosition({ x: flowX, y: flowY })
      return {
        x: (sp.x - wrapRect.left - offX) * pxScale,
        y: (sp.y - wrapRect.top - offY) * pxScale,
      }
    }

    const paintContent = (
      ctx: CanvasRenderingContext2D,
      offX: number,
      offY: number,
      pxScale: number
    ) => {
      // Pasted / uploaded images (from live DOM elements — same-origin data URLs)
      for (const im of images) {
        const el = document.querySelector<HTMLImageElement>(`img[data-mathimg="${im.id}"]`)
        if (!el || !el.complete) continue
        const tl = toCrop(im.x, im.y, offX, offY, pxScale)
        const br = toCrop(im.x + im.w, im.y + im.h, offX, offY, pxScale)
        try {
          ctx.drawImage(el, tl.x, tl.y, br.x - tl.x, br.y - tl.y)
        } catch {
          /* ignore a single bad image */
        }
      }
      // Ink
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (const st of strokes) {
        if (st.points.length === 0) continue
        ctx.strokeStyle = st.color
        ctx.lineWidth = Math.max(1, st.width * zoom * pxScale)
        ctx.beginPath()
        st.points.forEach((pt, i) => {
          const c = toCrop(pt.x, pt.y, offX, offY, pxScale)
          if (i === 0) ctx.moveTo(c.x, c.y)
          else ctx.lineTo(c.x, c.y)
        })
        ctx.stroke()
      }
    }

    // Region crop
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(rect.w * s))
    out.height = Math.max(1, Math.round(rect.h * s))
    const octx = out.getContext('2d')!
    octx.fillStyle = '#ffffff'
    octx.fillRect(0, 0, out.width, out.height)
    if (full) octx.drawImage(full, rect.x * s, rect.y * s, rect.w * s, rect.h * s, 0, 0, out.width, out.height)
    paintContent(octx, rect.x, rect.y, s)
    const region = out.toDataURL('image/png')

    // Whole-board context (downscaled) — optional
    let board: string | undefined
    try {
      const fullW = full ? full.width : Math.round(wrapRect.width * s)
      const fullH = full ? full.height : Math.round(wrapRect.height * s)
      const bScale = Math.min(1, 2000 / fullW)
      const bcanvas = document.createElement('canvas')
      bcanvas.width = Math.round(fullW * bScale)
      bcanvas.height = Math.round(fullH * bScale)
      const bctx = bcanvas.getContext('2d')!
      bctx.fillStyle = CAPTURE_BG
      bctx.fillRect(0, 0, bcanvas.width, bcanvas.height)
      if (full) bctx.drawImage(full, 0, 0, bcanvas.width, bcanvas.height)
      paintContent(bctx, 0, 0, s * bScale)
      board = bcanvas.toDataURL('image/jpeg', 0.82)
    } catch {
      /* board context is optional */
    }

    return { region, board }
  }

  const paneFlowBounds = useCallback((): BoardBounds | null => {
    const el = overlayRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    const tl = rf.screenToFlowPosition({ x: r.left, y: r.top })
    const br = rf.screenToFlowPosition({ x: r.right, y: r.bottom })
    return { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y }
  }, [rf])

  /**
   * Bounds of everything on the board (ink + pasted problem images), with a
   * generous bottom margin of blank space so the model has room to place
   * "write here" boxes below the student's last line. This is the 0–1000 grid
   * space the model targets, and the exact area the grid image renders.
   */
  const workBounds = useCallback((): BoardBounds => {
    let b: BoardBounds | null = null
    for (const st of strokesRef.current) {
      const sb = boundsFromPoints(st.points)
      if (sb) b = b ? unionBounds(b, sb) : sb
    }
    for (const im of imagesRef.current) {
      const ib = { minX: im.x, minY: im.y, maxX: im.x + im.w, maxY: im.y + im.h }
      b = b ? unionBounds(b, ib) : ib
    }
    if (!b) return paneFlowBounds() ?? { minX: 0, minY: 0, maxX: 1000, maxY: 1000 }
    const w = b.maxX - b.minX
    const h = b.maxY - b.minY
    const pad = Math.max(50, Math.min(w, h) * 0.08)
    return {
      minX: b.minX - pad,
      minY: b.minY - pad,
      maxX: b.maxX + pad,
      // Extra blank space below the work for large write boxes.
      maxY: b.maxY + Math.max(400, h * 0.6),
    }
  }, [paneFlowBounds])

  /**
   * Render the board (pasted images + ink, straight from vector points so
   * handwriting is always crisp regardless of viewport/zoom) onto a canvas
   * spanning `bounds`, optionally overlaid with a labeled 0–1000 coordinate
   * grid the model uses to visually pick highlight boxes.
   */
  const renderWorkImage = useCallback(
    (bounds: BoardBounds, opts: { grid: boolean }): string | undefined => {
      const w = bounds.maxX - bounds.minX
      const h = bounds.maxY - bounds.minY
      if (!(w > 0) || !(h > 0)) return undefined
      const TARGET = 1568 // Claude's max useful long edge
      const scale = Math.min(TARGET / w, TARGET / h, 4)
      const cw = Math.max(320, Math.round(w * scale))
      const ch = Math.max(320, Math.round(h * scale))
      const canvas = document.createElement('canvas')
      canvas.width = cw
      canvas.height = ch
      const ctx = canvas.getContext('2d')
      if (!ctx) return undefined
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, cw, ch)

      const fx = (x: number) => ((x - bounds.minX) / w) * cw
      const fy = (y: number) => ((y - bounds.minY) / h) * ch

      for (const im of imagesRef.current) {
        const el = document.querySelector<HTMLImageElement>(`img[data-mathimg="${im.id}"]`)
        if (!el || !el.complete) continue
        try {
          ctx.drawImage(el, fx(im.x), fy(im.y), (im.w / w) * cw, (im.h / h) * ch)
        } catch {
          /* skip a bad image */
        }
      }

      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (const st of strokesRef.current) {
        if (!st.points.length) continue
        ctx.strokeStyle = st.color
        ctx.lineWidth = Math.max(1.2, st.width * scale)
        ctx.beginPath()
        st.points.forEach((pt, i) => {
          if (i === 0) ctx.moveTo(fx(pt.x), fy(pt.y))
          else ctx.lineTo(fx(pt.x), fy(pt.y))
        })
        ctx.stroke()
      }

      if (opts.grid) {
        ctx.strokeStyle = 'rgba(37,99,235,0.20)'
        ctx.fillStyle = 'rgba(37,99,235,0.65)'
        ctx.lineWidth = 1
        ctx.font = `${Math.max(10, Math.round(cw / 120))}px sans-serif`
        for (let g = 0; g <= 1000; g += 100) {
          const x = (g / 1000) * cw
          const y = (g / 1000) * ch
          ctx.beginPath()
          ctx.moveTo(x, 0)
          ctx.lineTo(x, ch)
          ctx.stroke()
          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(cw, y)
          ctx.stroke()
          if (g > 0 && g < 1000) {
            ctx.fillText(String(g), x + 3, 12)
            ctx.fillText(String(g), 3, y + 12)
          }
        }
      }

      return canvas.toDataURL('image/png')
    },
    []
  )

  /** Gridded work image + matching bounds — the model's targeting space. */
  const gridCapture = useCallback(() => {
    const bounds = workBounds()
    return { boardBounds: bounds, gridImage: renderWorkImage(bounds, { grid: true }) }
  }, [workBounds, renderWorkImage])

  /** Pasted problem screenshots, always sent raw so the problem is in context. */
  const problemImages = useCallback(
    () => imagesRef.current.slice(0, 3).map((im) => im.src),
    []
  )

  /** Zoom out to show all work on the board (used when the problem is complete). */
  const fitAllWork = useCallback(() => {
    const r = paneRect()
    if (!r) return
    const bounds = workBounds()
    const bw = bounds.maxX - bounds.minX
    const bh = bounds.maxY - bounds.minY
    if (!(bw > 0) || !(bh > 0)) return
    const pad = 0.12
    const zoomX = (r.width * (1 - pad * 2)) / bw
    const zoomY = (r.height * (1 - pad * 2)) / bh
    const targetZoom = Math.min(zoomX, zoomY, 1)
    rf.setCenter((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, {
      zoom: Math.max(0.35, targetZoom),
      duration: 800,
    })
  }, [rf, workBounds, paneRect])

  /** Pan down so a newly placed write box is fully in view. */
  const panToWriteBox = useCallback(
    (box: BoardBounds) => {
      const r = paneRect()
      if (!r) return
      const boxW = box.maxX - box.minX
      const boxH = box.maxY - box.minY
      const cx = (box.minX + box.maxX) / 2
      const cy = box.minY + boxH * 0.55
      const zoomX = (r.width * 0.84) / boxW
      const zoomY = (r.height * 0.58) / boxH
      const targetZoom = Math.min(Math.max(zoom, 0.78), zoomX, zoomY, 1.08)
      rf.setCenter(cx, cy, { zoom: targetZoom, duration: 560 })
    },
    [rf, zoom, paneRect]
  )

  // ── Hint requests ──
  const runHint = useCallback(
    (
      cardId: string,
      opts: {
        region?: string
        boardImage?: string
        prompt: string
        history: HintTurn[]
        mode: 'hint' | 'solve' | 'generalize'
        level: number
        maxLevel?: number
        tracked: boolean
        nudgeCount?: number
        /** Internal: one retry when a follow-up nudge omits the write box. */
        writeBoxRetry?: boolean
        /** Internal: one retry when the model streams back nothing visible. */
        emptyRetry?: boolean
      }
    ) => {
      const { boardBounds, gridImage } =
        opts.mode === 'hint' ? gridCapture() : { boardBounds: undefined, gridImage: undefined }

      // Follow-up nudges are always a single step (server-enforced too); a
      // fresh hint gets the tier's step cap (Small=1, Medium=2, Large=3).
      const followUpNudge = (opts.nudgeCount ?? 0) > 0
      const stepCap = followUpNudge ? 1 : maxStepsForLevel(opts.level)

      setCards((cs) =>
        cs.map((c) =>
          c.id === cardId
            ? {
                ...c,
                status: 'loading',
                text: '',
                error: undefined,
                mode: opts.mode,
                level: opts.level,
                nudgeCount: opts.nudgeCount ?? c.nudgeCount ?? 0,
                responded: false,
                usedWriteBoxes: [
                  ...(c.usedWriteBoxes ?? []),
                  ...Object.values(c.writeBoxes ?? {}),
                  ...(c.heldZone ? [c.heldZone.box] : []),
                ],
                firedMarkers: 0,
                writeStates: {},
                writeBoxes: {},
                heldZone: undefined,
                regionFlow: undefined,
                complete: false,
                clarifications: [],
                boardBounds,
                steps: [],
                revealedSteps: 1,
                reexplainCounts: {},
                reexplaining: false,
              }
            : c
        )
      )
      if (opts.tracked) setPhase('hinting')

      if (opts.mode === 'hint') {
        cancelSpeech()
        speakerRef.current?.cancel()
        hintSpeakerRef.current?.cancel()
        setSpeakerOn(true)
        hintSpeakerRef.current = ttsOK
          ? new IncrementalSpeaker((on) => setHintSpeakingId(on ? cardId : null))
          : null
      } else {
        hintSpeakerRef.current?.cancel()
        setHintSpeakingId(null)
      }

      let acc = ''
      let parsedType: HintTypeId | undefined
      // Sentence-counted speech feed: every re-parse of the stream re-derives
      // the full spoken text, and we enqueue exactly the sentences that have
      // become complete since last time. Unlike the old string-prefix delta
      // (which silently DROPPED text whenever a marker/math span completing
      // changed earlier characters), this can never skip or reorder anything.
      let sentencesSpoken = 0
      const speakUpTo = (say: string, done: boolean) => {
        if (opts.mode !== 'hint' || !say) return
        const spoken = speakableNarration(say, done)
        const parts = spoken.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? []
        // The trailing part may still be mid-stream — hold it until done.
        const ready = done ? parts.length : Math.max(0, parts.length - 1)
        for (let i = sentencesSpoken; i < ready; i++) {
          hintSpeakerRef.current?.pushSentence(parts[i])
        }
        sentencesSpoken = Math.max(sentencesSpoken, ready)
      }
      void streamMathHint(
        {
          regionImage: opts.region,
          boardImage: opts.boardImage,
          gridImage,
          problemImages: problemImages(),
          recognizedLines: recognizedLinesPayload(),
          prompt: opts.prompt,
          history: opts.history,
          hintLevel: opts.level,
          mode: opts.mode,
          apiKey,
        },
        (chunk) => {
          acc += chunk
          const parsed = opts.mode !== 'hint' ? null : parseHintResponse(acc)
          const type = parsed?.type
          if (type) parsedType = type
          // Cap to the tier's step count and only surface step 1 live — steps
          // 2/3 stream in behind the scenes and stay hidden until confirmed.
          const cappedSteps = opts.mode === 'hint' ? (parsed?.steps ?? []).slice(0, stepCap) : []
          const revealedText = opts.mode !== 'hint' ? '' : cappedSteps[0] ?? ''
          if (revealedText) speakUpTo(revealedText, false)
          setCards((cs) =>
            cs.map((c) =>
              c.id === cardId
                ? {
                    ...c,
                    status: 'streaming',
                    text: opts.mode !== 'hint' ? stripEmDashes(acc) : revealedText,
                    steps: opts.mode === 'hint' ? cappedSteps : c.steps,
                    strategy: parsed?.strategy,
                    step: parsed?.step,
                    hintType: type ?? c.hintType,
                  }
                : c
            )
          )
        },
        () => {
          const parsed = opts.mode !== 'hint' ? null : parseHintResponse(acc)
          const finalType = parsed?.type ?? parsedType
          const displayed = opts.mode !== 'hint' ? stripEmDashes(acc) : parsed?.hint ?? acc
          const cappedSteps = opts.mode === 'hint' ? (parsed?.steps ?? []).slice(0, stepCap) : []
          const cappedJoined = cappedSteps.join(' ')
          let revealedText = opts.mode !== 'hint' ? displayed : cappedSteps[0] ?? displayed

          // The card must NEVER finish blank. A "COMPLETE: yes" with no prose
          // gets a stock congratulation; anything else empty gets one silent
          // retry, then a visible error state the student can recover from.
          if (!revealedText.trim()) {
            if (parsed?.complete) {
              revealedText = 'Great work — this problem is fully solved!'
            } else if (!opts.emptyRetry) {
              // The usual cause: the internal WHERE block (quoting all their
              // notation before ever reaching STEP 1) ate the whole token
              // budget on a token-limited tier, so generation got cut off
              // before any visible text existed. Push the retry to spend
              // fewer tokens grounding itself so it actually reaches STEP 1.
              runHint(cardId, {
                ...opts,
                emptyRetry: true,
                prompt: `${opts.prompt} REMINDER: your last attempt cut off before writing anything visible. Keep WHERE to at most one short sentence total this time, then get straight to STEP 1 — a short STEP the student can see is far more important than a thorough WHERE block.`,
              })
              return
            } else {
              hintSpeakerRef.current?.cancel()
              setHintSpeakingId(null)
              setCards((cs) =>
                cs.map((c) =>
                  c.id === cardId
                    ? { ...c, status: 'error', error: 'The tutor sent an empty response. Please try again.' }
                    : c
                )
              )
              if (opts.tracked) setPhase('working')
              return
            }
          }
          if (opts.mode === 'hint') {
            speakUpTo(revealedText, true)
            hintSpeakerRef.current?.flush()
          }
          if (opts.tracked && opts.mode === 'hint' && !parsed?.complete) setPhase('working')
          if (parsed?.complete) {
            fitAllWork()
            setPhase('working')
          }
          // Every hint that isn't a full-solve confirmation MUST end with a
          // write box — that's the one thing the student always does next.
          // Previously only enforced on follow-up nudges; now enforced on
          // every hint request, so it never silently comes back without one.
          const missingWriteBox =
            opts.mode === 'hint' &&
            !parsed?.complete &&
            !/\[\[write\|/i.test(cappedJoined) &&
            !opts.writeBoxRetry
          if (missingWriteBox) {
            runHint(cardId, {
              ...opts,
              writeBoxRetry: true,
              prompt: `${opts.prompt} REMINDER: you MUST end your last STEP with exactly ONE [[write|box:x,y,w,h|label]] in fresh blank space below my work — never finish a hint without one unless the problem is fully solved. State explicitly what to write.`,
            })
            return
          }
          setCards((cs) =>
            cs.map((c) =>
              c.id === cardId
                ? {
                    ...c,
                    status: 'done',
                    text: opts.mode === 'hint' ? revealedText : displayed,
                    steps: opts.mode === 'hint' ? cappedSteps : c.steps,
                    revealedSteps: 1,
                    strategy: parsed?.strategy,
                    step: parsed?.step,
                    hintType: finalType ?? c.hintType,
                    complete: parsed?.complete ?? false,
                    heldZone: c.heldZone ? { ...c.heldZone, state: 'done' } : undefined,
                    history: [
                      ...opts.history,
                      { role: 'user', content: opts.prompt },
                      { role: 'assistant', content: acc },
                    ],
                  }
                : c
            )
          )
        },
        (err) => {
          hintSpeakerRef.current?.cancel()
          setHintSpeakingId(null)
          setCards((cs) => cs.map((c) => (c.id === cardId ? { ...c, status: 'error', error: err } : c)))
          if (opts.tracked) setPhase('working')
        },
        (hl) => highlightRecognizedLines(hl.lines)
      )
    },
    [apiKey, ttsOK, gridCapture, problemImages, fitAllWork, recognizedLinesPayload, highlightRecognizedLines]
  )

  const createHintFromRect = useCallback(
    async (rect: { x: number; y: number; w: number; h: number }) => {
      const id = uid()
      const wrapRect = paneRect()
      if (!wrapRect) return
      const anchor = tutorAnchorFromRect(rect, rf, wrapRect)
      const regionFlow = screenRectToFlow(rect, rf, wrapRect)
      const userPrompt = prompt.trim() || DEFAULT_HINT_PROMPT

      if (phaseRef.current === 'awaiting_problem') markProblemSet()

      setCards((cs) => [
        ...cs,
        {
          id,
          anchor,
          regionFlow,
          text: '',
          status: 'loading',
          history: [],
          followup: '',
          mode: 'hint',
          level: hintSize,
          maxLevel: hintSize,
          tracked: true,
          nudgeCount: 0,
          firedMarkers: 0,
          writeStates: {},
          writeBoxes: {},
          steps: [],
          revealedSteps: 1,
          reexplainCounts: {},
        },
      ])

      try {
        const { region, board } = await captureRegion(rect)
        setCards((cs) => cs.map((c) => (c.id === id ? { ...c, region, boardImage: board } : c)))
        runHint(id, {
          region,
          boardImage: board,
          prompt: userPrompt,
          history: [],
          mode: 'hint',
          level: hintSize,
          maxLevel: hintSize,
          tracked: true,
          nudgeCount: 0,
        })
      } catch (err) {
        setCards((cs) =>
          cs.map((c) =>
            c.id === id
              ? { ...c, status: 'error', error: err instanceof Error ? err.message : 'Capture failed' }
              : c
          )
        )
      }
    },
    [prompt, runHint, markProblemSet, strokes, zoom, rf, hintSize]
  )
  const captureBoard = useCallback(async () => {
    const r = paneRect()
    if (!r) throw new Error('Math board not ready')
    return captureRegion({ x: 0, y: 0, w: r.width, h: r.height })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strokes, images, zoom])

  /**
   * Proactive, consented hint over the whole board at a given ladder rung.
   * Used by the "stuck → want a hint?" flow and its "still stuck" escalation.
   */
  const requestAutoHint = useCallback(
    async (level: number) => {
      const wrapRect = paneRect()
      if (!wrapRect) return
      const id = uid()
      const centroid = strokeCentroid(strokesRef.current)
      const anchor = centroid
        ? { x: centroid.x + 40, y: centroid.y + 50 }
        : rf.screenToFlowPosition({
            x: wrapRect.left + wrapRect.width * 0.35,
            y: wrapRect.top + wrapRect.height * 0.45,
          })
      const userPrompt =
        prompt.trim() ||
        `Re-read my latest work. Give a ${ladderTypeForLevel(level)} hint for my very next move from the equations I already wrote — not a new approach.`
      setCards((cs) => [
        ...cs,
        {
          id,
          anchor,
          text: '',
          status: 'loading',
          history: [],
          followup: '',
          mode: 'hint',
          level,
          maxLevel: level,
          nudgeCount: 0,
          tracked: true,
          firedMarkers: 0,
          writeStates: {},
          writeBoxes: {},
          steps: [],
          revealedSteps: 1,
          reexplainCounts: {},
        },
      ])
      try {
        const { region, board } = await captureBoard()
        setCards((cs) => cs.map((c) => (c.id === id ? { ...c, region: undefined, boardImage: board ?? region } : c)))
        runHint(id, { region: board ?? region, boardImage: board, prompt: userPrompt, history: [], mode: 'hint', level, tracked: true })
      } catch (err) {
        setCards((cs) =>
          cs.map((c) =>
            c.id === id
              ? { ...c, status: 'error', error: err instanceof Error ? err.message : 'Capture failed' }
              : c
          )
        )
        setPhase('working')
      }
    },
    [prompt, captureBoard, runHint, rf]
  )

  /** Toolbar hint — whole-board capture at the chosen hint size. */
  const requestBoardHint = useCallback(
    async (level: 1 | 2 | 4) => {
      if (strokesRef.current.length === 0 && imagesRef.current.length === 0) return
      const wrapRect = paneRect()
      if (!wrapRect) return
      const id = uid()
      const centroid = strokeCentroid(strokesRef.current)
      const anchor = centroid
        ? { x: centroid.x + 40, y: centroid.y + 50 }
        : rf.screenToFlowPosition({
            x: wrapRect.left + wrapRect.width * 0.72,
            y: wrapRect.top + wrapRect.height * 0.22,
          })
      const userPrompt =
        prompt.trim() ||
        `Read my work first: what strategy have I started and what step am I on? Then give ONE ${ladderTypeForLevel(level)} hint for my very next move from the equations I already wrote — not a shortcut from a different approach.`
      if (phaseRef.current === 'awaiting_problem') markProblemSet()
      setCards((cs) => [
        ...cs,
        {
          id,
          anchor,
          text: '',
          status: 'loading',
          history: [],
          followup: '',
          mode: 'hint',
          level,
          maxLevel: level,
          nudgeCount: 0,
          tracked: true,
          firedMarkers: 0,
          writeStates: {},
          writeBoxes: {},
          steps: [],
          revealedSteps: 1,
          reexplainCounts: {},
        },
      ])
      try {
        const { region, board } = await captureBoard()
        setCards((cs) => cs.map((c) => (c.id === id ? { ...c, region: undefined, boardImage: board ?? region } : c)))
        runHint(id, {
          region: board ?? region,
          boardImage: board,
          prompt: userPrompt,
          history: [],
          mode: 'hint',
          level,
          tracked: true,
        })
      } catch (err) {
        setCards((cs) =>
          cs.map((c) =>
            c.id === id
              ? { ...c, status: 'error', error: err instanceof Error ? err.message : 'Capture failed' }
              : c
          )
        )
      }
    },
    [prompt, captureBoard, runHint, rf, markProblemSet]
  )


  /**
   * "Generalize" — the tutor steps back from THIS problem and teaches the
   * general playbook for the whole problem TYPE ("generally, for problems like
   * this…"). Most valuable right after finishing a problem, but available any
   * time from the toolbar.
   */
  const requestGeneralize = useCallback(async () => {
    if (strokesRef.current.length === 0 && imagesRef.current.length === 0) return
    const wrapRect = paneRect()
    if (!wrapRect) return
    const id = uid()
    const anchor = rf.screenToFlowPosition({
      x: wrapRect.left + wrapRect.width * 0.5,
      y: wrapRect.top + wrapRect.height * 0.3,
    })
    setCards((cs) => [
      ...cs,
      {
        id,
        anchor,
        text: '',
        status: 'loading',
        history: [],
        followup: '',
        mode: 'generalize',
        level: 2,
        nudgeCount: 0,
        tracked: false,
        firedMarkers: 0,
        writeStates: {},
        writeBoxes: {},
        steps: [],
        revealedSteps: 1,
        reexplainCounts: {},
      },
    ])
    try {
      const { region, board } = await captureBoard()
      const boardImage = board ?? region
      setCards((cs) => cs.map((c) => (c.id === id ? { ...c, boardImage } : c)))
      runHint(id, {
        region: boardImage,
        boardImage,
        prompt:
          'I want the big picture now. Look at the problem I pasted and the work on my board, identify what TYPE of competition problem this is, and teach me the GENERAL approach for this whole family of problems — the way a coach debriefs after a solve.',
        history: [],
        mode: 'generalize',
        level: 2,
        tracked: false,
      })
    } catch (err) {
      setCards((cs) =>
        cs.map((c) =>
          c.id === id
            ? { ...c, status: 'error', error: err instanceof Error ? err.message : 'Capture failed' }
            : c
        )
      )
    }
  }, [captureBoard, runHint, rf])

  /** Re-capture the board so follow-up hints see the student's latest work. */
  const refreshCardCapture = useCallback(
    async (cardId: string, region?: string) => {
      try {
        if (region) {
          // Keep the original highlight if we have one — it's what the student asked about.
          const { board } = await captureBoard()
          setCards((cs) =>
            cs.map((c) => (c.id === cardId ? { ...c, region, boardImage: board } : c))
          )
          return { region, boardImage: board }
        }
        const { region: full, board } = await captureBoard()
        const boardImage = board ?? full
        setCards((cs) =>
          cs.map((c) => (c.id === cardId ? { ...c, region: undefined, boardImage } : c))
        )
        return { region: boardImage, boardImage }
      } catch {
        const card = cardsRef.current.find((c) => c.id === cardId)
        return { region: card?.region, boardImage: card?.boardImage }
      }
    },
    [captureBoard]
  )

  /**
   * The narration typewriter crossed a new inline marker — persist the count,
   * lock write-box positions, apply highlight/line glows, drop the yellow
   * selection highlight, and pan to any new write box.
   */
  const onMarkersFired = useCallback(
    (cardId: string, count: number) => {
      const card = cardsRef.current.find((c) => c.id === cardId)
      if (!card || count <= card.firedMarkers) return
      if (!card.boardBounds) {
        setCards((cs) => cs.map((c) => (c.id === cardId ? { ...c, firedMarkers: count } : c)))
        // Only glow lines whose [[highlight|...]] marker has actually been
        // typewriter-revealed so far — never the whole text's markers at once.
        const lines = extractHighlightLineNumbers(card.text, count)
        if (lines.length) highlightRecognizedLines(lines)
        return
      }
      const occupied = cardOccupied(imagesRef.current, card)
      const cached = card.writeBoxes ?? {}
      const { writes } = resolveFiredMarkers(
        card.text,
        count,
        strokesRef.current,
        card.boardBounds,
        12,
        occupied,
        cached
      )
      const writeBoxes = { ...cached }
      for (const w of writes) {
        if (!writeBoxes[w.index]) writeBoxes[w.index] = w.box
      }
      const hasWriteBox = writes.length > 0
      // Same rule: only markers revealed up to `count` so far can fire a glow.
      const lines = extractHighlightLineNumbers(card.text, count)
      if (lines.length) highlightRecognizedLines(lines)
      setCards((cs) =>
        cs.map((c) =>
          c.id === cardId
            ? {
                ...c,
                firedMarkers: count,
                writeBoxes,
                regionFlow: hasWriteBox ? undefined : c.regionFlow,
              }
            : c
        )
      )
      const latest = writes[writes.length - 1]
      if (!latest) return
      panToWriteBox(latest.box)
    },
    [panToWriteBox, highlightRecognizedLines]
  )

  // ── Write zones: the tutor circles blank space and asks for the next line ──
  // The student writes at their own pace; NOTHING is submitted until they tap
  // the check mark on the box. Then the camera hyperfocuses on the box, the
  // tutor reads exactly what's inside, and answers with a verdict.

  /** A committed pen stroke may have landed inside an open write zone. */
  const noteStrokeForWriteZones = useCallback((stroke: Stroke) => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of stroke.points) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    if (!Number.isFinite(minX)) return

    for (const card of cardsRef.current) {
      if (card.mode !== 'hint' || !card.boardBounds || card.firedMarkers === 0) continue
      const occupied = cardOccupied(imagesRef.current, card)
      const { writes } = resolveFiredMarkers(
        card.text,
        card.firedMarkers,
        strokesRef.current,
        card.boardBounds,
        12,
        occupied,
        card.writeBoxes ?? {}
      )
      for (const wz of writes) {
        const state = card.writeStates[wz.index] ?? 'open'
        if (state !== 'open') continue
        const overlap =
          minX <= wz.box.maxX && maxX >= wz.box.minX && minY <= wz.box.maxY && maxY >= wz.box.minY
        if (!overlap) continue
        setCards((cs) =>
          cs.map((c) =>
            c.id === card.id
              ? { ...c, writeStates: { ...c.writeStates, [wz.index]: 'filled' } }
              : c
          )
        )
      }
    }
  }, [])

  /** Student tapped the ✓ on a write box — hyperfocus and have the tutor grade it. */
  const checkWriteZone = useCallback(
    (cardId: string, markerIndex: number) => {
      const card = cardsRef.current.find((c) => c.id === cardId)
      if (!card || !card.boardBounds || card.status === 'loading' || card.status === 'streaming') return
      const occupied = cardOccupied(imagesRef.current, card)
      const { writes } = resolveFiredMarkers(
        card.text,
        card.firedMarkers,
        strokesRef.current,
        card.boardBounds,
        12,
        occupied,
        card.writeBoxes ?? {}
      )
      const wz = writes.find((w) => w.index === markerIndex)
      if (!wz) return
      const label = wz.marker.label

      setCards((cs) =>
        cs.map((c) =>
          c.id === cardId
            ? {
                ...c,
                writeStates: { ...c.writeStates, [markerIndex]: 'checking' },
                heldZone: { box: wz.box, label, state: 'checking' },
              }
            : c
        )
      )

      // Bring the submitted box to center. Keep the zoom familiar (never a
      // hard zoom jump) — only nudge in slightly if they're zoomed way out.
      rf.setCenter((wz.box.minX + wz.box.maxX) / 2, (wz.box.minY + wz.box.maxY) / 2, {
        zoom: Math.min(1.15, Math.max(zoom, 0.85)),
        duration: 500,
      })

      // Crisp vector crop of JUST the box contents for the model to read.
      const pad = 30
      const zoneCrop = renderWorkImage(
        {
          minX: wz.box.minX - pad,
          minY: wz.box.minY - pad,
          maxX: wz.box.maxX + pad,
          maxY: wz.box.maxY + pad,
        },
        { grid: false }
      )

      runHint(cardId, {
        region: zoneCrop,
        prompt: `I tapped the check mark on the box you circled${
          label ? ` ("${label}")` : ''
        } — I'm done writing in it. The focus image is EXACTLY that box. Read what I wrote inside it character by character, then give your verdict following the WRITE-BOX CHECK rules.`,
        history: card.history,
        mode: 'hint',
        level: card.level,
        tracked: true,
      })
    },
    [rf, zoom, renderWorkImage, runHint]
  )

  const resolveCard = (card: HintCard, mode: 'hint' | 'solve') => {
    const nudgeCount = (card.nudgeCount ?? 0) + 1
    const level = card.level
    void (async () => {
      const cap =
        mode === 'hint' ? await refreshCardCapture(card.id) : { region: card.region, boardImage: card.boardImage }
      runHint(card.id, {
        region: cap.region,
        boardImage: cap.boardImage,
        prompt:
          mode === 'solve'
            ? 'Please show the full step-by-step solution and the final answer.'
            : `FOLLOW-UP NUDGE #${nudgeCount}: I already got your previous hint (see our conversation). Give me ONE slightly more revealing nudge from my current work — reveal a single new observation I have not used yet (for example one coefficient fact like bd equals negative five), then ask ONE question. Do NOT list cases, steps, or a full plan. Stay at ${ladderTypeForLevel(level)} level. Not the full solution. You MUST end STEP 1 with exactly ONE [[write|box:x,y,w,h|label]] in fresh blank space below my work — state explicitly what to write in it.`,
        history: card.history,
        mode,
        level,
        nudgeCount,
        tracked: mode === 'hint',
      })
    })()
  }

  /** Student tapped "Makes sense, next step" — reveal the next gated micro-step. */
  const advanceStep = useCallback((cardId: string) => {
    setCards((cs) =>
      cs.map((c) => {
        if (c.id !== cardId) return c
        const next = c.revealedSteps + 1
        if (next > c.steps.length) return c
        const added = c.steps[next - 1]
        if (added) speakStepAloud(hintSpeakerRef.current, added)
        return { ...c, revealedSteps: next, text: c.steps.slice(0, next).join(' ') }
      })
    )
  }, [])

  /**
   * Student tapped "I'm confused" on the currently-gating step — re-explain
   * ONLY that one step, differently, and swap it in place. Never touches the
   * steps already confirmed before it.
   */
  const reexplainStep = useCallback(
    (cardId: string) => {
      const card = cardsRef.current.find((c) => c.id === cardId)
      if (!card) return
      const stepIndex = card.revealedSteps - 1
      if (stepIndex < 0 || stepIndex >= card.steps.length) return
      const baseline = card.steps.slice(0, stepIndex)
      const attempts = card.reexplainCounts[stepIndex] ?? 0
      const confusingStep = card.steps[stepIndex]

      setCards((cs) =>
        cs.map((c) =>
          c.id === cardId
            ? {
                ...c,
                reexplaining: true,
                status: 'streaming',
                text: baseline.join(' '),
                firedMarkers: 0,
                writeStates: {},
                writeBoxes: {},
              }
            : c
        )
      )

      void (async () => {
        const cap = await refreshCardCapture(cardId, card.region)

        cancelSpeech()
        speakerRef.current?.cancel()
        hintSpeakerRef.current?.cancel()
        setSpeakerOn(true)
        hintSpeakerRef.current = ttsOK
          ? new IncrementalSpeaker((on) => setHintSpeakingId(on ? cardId : null))
          : null

        let acc = ''
        let sentencesSpoken = 0
        const speakUpTo = (say: string, done: boolean) => {
          if (!say) return
          const spoken = speakableNarration(say, done)
          const parts = spoken.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? []
          const ready = done ? parts.length : Math.max(0, parts.length - 1)
          for (let i = sentencesSpoken; i < ready; i++) {
            hintSpeakerRef.current?.pushSentence(parts[i])
          }
          sentencesSpoken = Math.max(sentencesSpoken, ready)
        }

        await streamMathHint(
          {
            regionImage: cap.region,
            boardImage: cap.boardImage,
            problemImages: problemImages(),
            prompt: `REEXPLAIN STEP: the student is confused by this part of your last hint: "${confusingStep}". Re-explain ONLY this one idea a different way, still just ONE short step. Do NOT include a write box marker.`,
            history: card.history,
            hintLevel: card.level,
            mode: 'hint',
            apiKey,
          },
          (chunk) => {
            acc += chunk
            const parsed = parseHintResponse(acc)
            const stepText = parsed.steps[0] ?? parsed.hint ?? ''
            if (stepText) speakUpTo(stepText, false)
            setCards((cs) =>
              cs.map((c) => {
                if (c.id !== cardId) return c
                const newSteps = [...c.steps]
                newSteps[stepIndex] = stepText
                return { ...c, steps: newSteps, text: [...baseline, stepText].join(' ') }
              })
            )
          },
          () => {
            const parsed = parseHintResponse(acc)
            // Never blank: if the re-explanation came back empty, keep the
            // original step text instead of wiping it.
            const stepText = cleanTutorProse(parsed.steps[0] ?? parsed.hint ?? acc) || confusingStep
            speakUpTo(stepText, true)
            hintSpeakerRef.current?.flush()
            setCards((cs) =>
              cs.map((c) => {
                if (c.id !== cardId) return c
                const newSteps = [...c.steps]
                newSteps[stepIndex] = stepText
                return {
                  ...c,
                  status: 'done',
                  steps: newSteps,
                  text: [...baseline, stepText].join(' '),
                  reexplaining: false,
                  reexplainCounts: { ...c.reexplainCounts, [stepIndex]: attempts + 1 },
                }
              })
            )
          },
          (err) => {
            // Fall back to the original step text rather than stranding the
            // student on a dead-end error with no checkin buttons to recover.
            setCards((cs) =>
              cs.map((c) =>
                c.id === cardId
                  ? {
                      ...c,
                      status: 'done',
                      text: [...baseline, confusingStep].join(' '),
                      reexplaining: false,
                      error: err,
                    }
                  : c
              )
            )
          },
          (hl) => highlightRecognizedLines(hl.lines)
        )
      })()
    },
    [apiKey, problemImages, refreshCardCapture, ttsOK, highlightRecognizedLines]
  )

  const runClarifyHint = useCallback(
    (cardId: string, question: string) => {
      const card = cardsRef.current.find((c) => c.id === cardId)
      if (!card || !question.trim()) return
      const clarifyId = uid()
      setCards((cs) =>
        cs.map((c) =>
          c.id === cardId
            ? {
                ...c,
                clarifications: [
                  ...(c.clarifications ?? []),
                  { id: clarifyId, question: question.trim(), answer: '', status: 'loading' as const },
                ],
              }
            : c
        )
      )

      void (async () => {
        let boardImage = card.boardImage
        let gridImage: string | undefined
        try {
          const cap = await refreshCardCapture(cardId)
          boardImage = cap.boardImage ?? boardImage
          gridImage = gridCapture().gridImage
        } catch {
          /* optional */
        }

        cancelSpeech()
        speakerRef.current?.cancel()
        hintSpeakerRef.current?.cancel()
        setSpeakerOn(true)
        hintSpeakerRef.current = ttsOK
          ? new IncrementalSpeaker((on) => setHintSpeakingId(on ? cardId : null))
          : null

        let acc = ''
        let sentencesSpoken = 0
        const speakUpTo = (say: string, done: boolean) => {
          if (!say) return
          const spoken = speakableNarration(say, done)
          const parts = spoken.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? []
          const ready = done ? parts.length : Math.max(0, parts.length - 1)
          for (let i = sentencesSpoken; i < ready; i++) {
            hintSpeakerRef.current?.pushSentence(parts[i])
          }
          sentencesSpoken = Math.max(sentencesSpoken, ready)
        }

        await streamMathHint(
          {
            boardImage,
            gridImage,
            problemImages: problemImages(),
            recognizedLines: recognizedLinesPayload(),
            prompt: `Clarifying question about your last hint: ${question.trim()}`,
            history: card.history,
            hintLevel: card.level,
            mode: 'clarify',
            apiKey,
          },
          (chunk) => {
            acc += chunk
            const parsed = parseHintResponse(acc)
            const answer = cleanTutorProse(
              parsed.hint || acc.replace(/^SAY:\s*/i, '').trim()
            )
            const lines = extractHighlightLineNumbers(acc)
            if (lines.length) highlightRecognizedLines(lines)
            speakUpTo(answer, false)
            setCards((cs) =>
              cs.map((c) =>
                c.id === cardId
                  ? {
                      ...c,
                      clarifications: (c.clarifications ?? []).map((cl) =>
                        cl.id === clarifyId ? { ...cl, answer, status: 'streaming' as const } : cl
                      ),
                    }
                  : c
              )
            )
          },
          () => {
            const parsed = parseHintResponse(acc)
            const answer =
              cleanTutorProse(parsed.hint || acc.replace(/^SAY:\s*/i, '').trim()) ||
              "I didn't get an answer through — please ask that again."
            const lines = extractHighlightLineNumbers(acc)
            if (lines.length) highlightRecognizedLines(lines)
            speakUpTo(answer, true)
            hintSpeakerRef.current?.flush()
            setCards((cs) =>
              cs.map((c) =>
                c.id === cardId
                  ? {
                      ...c,
                      clarifications: (c.clarifications ?? []).map((cl) =>
                        cl.id === clarifyId ? { ...cl, answer, status: 'done' as const } : cl
                      ),
                    }
                  : c
              )
            )
          },
          (err) => {
            setCards((cs) =>
              cs.map((c) =>
                c.id === cardId
                  ? {
                      ...c,
                      clarifications: (c.clarifications ?? []).map((cl) =>
                        cl.id === clarifyId
                          ? { ...cl, answer: err, status: 'done' as const }
                          : cl
                      ),
                    }
                  : c
              )
            )
          },
          (hl) => highlightRecognizedLines(hl.lines)
        )
      })()
    },
    [apiKey, gridCapture, problemImages, refreshCardCapture, ttsOK, recognizedLinesPayload, highlightRecognizedLines]
  )

  const closeCard = (id: string) => {
    if (hintSpeakingId === id) {
      hintSpeakerRef.current?.cancel()
      setHintSpeakingId(null)
    }
    setCards((cs) => cs.filter((c) => c.id !== id))
  }

  // ── Voice tutor (mic in, spoken out; sees the board via Sonnet 5) ──
  const sttOK = speechRecognitionSupported()
  const [recording, setRecording] = useState(false)
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [interim, setInterim] = useState('')
  const [voiceUser, setVoiceUser] = useState('')
  const [voiceReply, setVoiceReply] = useState('')
  const [voiceError, setVoiceError] = useState<string | null>(null)

  const recordingRef = useRef(false)
  const recordingPurposeRef = useRef<'voice' | 'clarify'>('voice')
  const clarifyCardIdRef = useRef<string | null>(null)
  const [clarifyRecordingId, setClarifyRecordingId] = useState<string | null>(null)
  const [clarifyPending, setClarifyPending] = useState('')
  const pendingTranscriptRef = useRef('')
  const interimRef = useRef('')
  const finishRecordingRef = useRef(false)
  const speakingRef = useRef(false)
  useEffect(() => void (speakingRef.current = speaking), [speaking])
  const recognizerRef = useRef<RecognizerHandle | null>(null)
  const voiceHistoryRef = useRef<HintTurn[]>([])
  const voiceBusyRef = useRef(false)

  useEffect(() => {
    void probeTTS().then(setTtsOK)
  }, [])

  const askVoiceTutor = useCallback(
    async (text: string) => {
      if (voiceBusyRef.current) return
      const trimmed = text.trim()
      if (trimmed.length < 2) return

      // If Thales is already on the board, continue as a clarifying question
      // on the latest card (so highlight tool-calls land on that conversation).
      const latest = [...cardsRef.current].reverse().find(
        (c) => c.status === 'done' || c.status === 'streaming' || c.status === 'loading'
      )
      if (latest && (latest.mode === 'hint' || latest.mode === 'voice') && latest.status !== 'error') {
        runClarifyHint(latest.id, trimmed)
        return
      }

      voiceBusyRef.current = true
      cancelSpeech()
      hintSpeakerRef.current?.cancel()
      speakerRef.current?.cancel()
      setVoiceError(null)
      setThinking(true)
      if (phaseRef.current === 'awaiting_problem') markProblemSet()

      const id = uid()
      const wrapRect = paneRect()
      const anchor = wrapRect
        ? { x: wrapRect.width * 0.55, y: wrapRect.height * 0.2 }
        : { x: 420, y: 120 }

      setCards((cs) => [
        ...cs,
        {
          id,
          anchor,
          text: '',
          status: 'loading',
          history: [],
          followup: '',
          mode: 'voice',
          level: hintSize,
          maxLevel: hintSize,
          tracked: false,
          firedMarkers: 0,
          writeStates: {},
          writeBoxes: {},
          steps: [],
          revealedSteps: 1,
          reexplainCounts: {},
        },
      ])
      setHintSpeakingId(null)
      hintSpeakerRef.current = speakerOn && ttsOK
        ? new IncrementalSpeaker((on) => setHintSpeakingId(on ? id : null))
        : null

      let board: string | undefined
      let gridImage: string | undefined
      try {
        const cap = await Promise.race([
          captureBoard(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('capture-timeout')), 6000)
          ),
        ])
        board = cap.board ?? cap.region
        gridImage = gridCapture().gridImage
      } catch {
        /* board capture is optional — respond from text alone */
      }

      const history = voiceHistoryRef.current.slice(-6)
      let acc = ''
      let sentencesSpoken = 0
      const speakUpTo = (say: string, done: boolean) => {
        if (!say) return
        const spoken = speakableNarration(say, done)
        const parts = spoken.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? []
        const ready = done ? parts.length : Math.max(0, parts.length - 1)
        for (let i = sentencesSpoken; i < ready; i++) {
          hintSpeakerRef.current?.pushSentence(parts[i])
        }
        sentencesSpoken = Math.max(sentencesSpoken, ready)
      }

      await streamMathHint(
        {
          boardImage: board,
          gridImage,
          problemImages: problemImages(),
          recognizedLines: recognizedLinesPayload(),
          prompt: trimmed,
          history,
          mode: 'voice',
          apiKey,
        },
        (chunk) => {
          if (acc === '') setThinking(false)
          acc += chunk
          const display = cleanTutorProse(acc.replace(/^SAY:\s*/i, '').trim())
          const lines = extractHighlightLineNumbers(acc)
          if (lines.length) highlightRecognizedLines(lines)
          speakUpTo(display, false)
          setCards((cs) =>
            cs.map((c) =>
              c.id === id
                ? { ...c, text: display, status: 'streaming' as const, firedMarkers: Math.max(c.firedMarkers, 1) }
                : c
            )
          )
        },
        () => {
          const display =
            cleanTutorProse(acc.replace(/^SAY:\s*/i, '').trim()) ||
            "I didn't catch that — try asking again."
          const lines = extractHighlightLineNumbers(acc)
          if (lines.length) highlightRecognizedLines(lines)
          speakUpTo(display, true)
          hintSpeakerRef.current?.flush()
          voiceHistoryRef.current = display.trim()
            ? [
                ...history,
                { role: 'user', content: trimmed },
                { role: 'assistant', content: display },
              ]
            : history
          setCards((cs) =>
            cs.map((c) =>
              c.id === id
                ? {
                    ...c,
                    text: display,
                    status: 'done' as const,
                    history: voiceHistoryRef.current,
                    firedMarkers: Math.max(c.firedMarkers, 1),
                  }
                : c
            )
          )
          setThinking(false)
          voiceBusyRef.current = false
        },
        (err) => {
          setVoiceError(err)
          setThinking(false)
          voiceBusyRef.current = false
          setCards((cs) =>
            cs.map((c) => (c.id === id ? { ...c, status: 'error', error: err } : c))
          )
        },
        (hl) => highlightRecognizedLines(hl.lines)
      )
    },
    [
      apiKey,
      captureBoard,
      markProblemSet,
      speakerOn,
      ttsOK,
      hintSize,
      gridCapture,
      problemImages,
      recognizedLinesPayload,
      highlightRecognizedLines,
      runClarifyHint,
      paneRect,
    ]
  )

  const deliverRecording = useCallback(() => {
    const text = `${pendingTranscriptRef.current} ${interimRef.current}`.trim()
    pendingTranscriptRef.current = ''
    interimRef.current = ''
    setInterim('')
    if (recordingPurposeRef.current === 'clarify') {
      const cardId = clarifyCardIdRef.current
      clarifyCardIdRef.current = null
      setClarifyRecordingId(null)
      setClarifyPending('')
      recordingPurposeRef.current = 'voice'
      if (cardId && text.length > 1) runClarifyHint(cardId, text)
      return
    }
    if (text.length > 1) void askVoiceTutor(text)
  }, [askVoiceTutor, runClarifyHint])

  const stopRecording = useCallback(() => {
    if (!recordingRef.current) return
    recordingRef.current = false
    setRecording(false)
    setListening(false)
    finishRecordingRef.current = true
    recognizerRef.current?.stop()
    // Fallback if the browser never fires onend after stop().
    setTimeout(() => {
      if (!finishRecordingRef.current) return
      finishRecordingRef.current = false
      recognizerRef.current = null
      deliverRecording()
    }, 450)
  }, [deliverRecording])

  const cleanupVoice = useCallback(() => {
    recordingRef.current = false
    finishRecordingRef.current = false
    voiceBusyRef.current = false
    setRecording(false)
    setListening(false)
    setInterim('')
    setThinking(false)
    pendingTranscriptRef.current = ''
    interimRef.current = ''
    recognizerRef.current?.abort()
    recognizerRef.current = null
    speakerRef.current?.cancel()
    hintSpeakerRef.current?.cancel()
    setHintSpeakingId(null)
    cancelSpeech()
  }, [])

  const dismissVoicePanel = useCallback(() => {
    cleanupVoice()
    setVoiceUser('')
    setVoiceReply('')
    setVoiceError(null)
    setSpeaking(false)
  }, [cleanupVoice])

  const startRecording = useCallback(() => {
    if (!sttOK) {
      setVoiceError('Voice input needs a Chromium browser (Chrome/Edge).')
      return
    }
    if (voiceBusyRef.current) return
    recordingPurposeRef.current = 'voice'
    clarifyCardIdRef.current = null
    setClarifyRecordingId(null)
    setVoiceError(null)
    pendingTranscriptRef.current = ''
    interimRef.current = ''
    setVoiceUser('')
    setVoiceReply('')
    const rec = createRecognizer({
      onStart: () => setListening(true),
      onEnd: () => {
        setListening(false)
        if (finishRecordingRef.current) {
          finishRecordingRef.current = false
          recognizerRef.current = null
          deliverRecording()
          return
        }
        // Chrome ends the session after a pause — keep listening only while recording.
        if (recordingRef.current) recognizerRef.current?.start()
      },
      onError: (e) => {
        if (e === 'not-allowed' || e === 'service-not-allowed') {
          setVoiceError('Microphone permission was blocked.')
          cleanupVoice()
        } else if (e !== 'no-speech' && e !== 'aborted') {
          setVoiceError(e)
        }
      },
      onInterim: (t) => {
        interimRef.current = t
        setInterim(t)
        if (speakingRef.current) speakerRef.current?.cancel() // barge-in
      },
      onFinal: (t) => {
        interimRef.current = ''
        setInterim('')
        const trimmed = t.trim()
        if (!trimmed) return
        pendingTranscriptRef.current = pendingTranscriptRef.current
          ? `${pendingTranscriptRef.current} ${trimmed}`
          : trimmed
        setVoiceUser(pendingTranscriptRef.current)
      },
    })
    if (!rec) {
      setVoiceError('Voice input unavailable in this browser.')
      return
    }
    recognizerRef.current = rec
    recordingRef.current = true
    setRecording(true)
    rec.start()
  }, [sttOK, cleanupVoice, deliverRecording])

  const toggleRecording = useCallback(() => {
    if (recordingRef.current) stopRecording()
    else startRecording()
  }, [startRecording, stopRecording])

  const toggleClarifyMic = useCallback(
    (cardId: string) => {
      if (!sttOK) return
      if (recordingRef.current && clarifyCardIdRef.current === cardId) {
        stopRecording()
        return
      }
      if (recordingRef.current) stopRecording()
      recordingPurposeRef.current = 'clarify'
      clarifyCardIdRef.current = cardId
      setClarifyRecordingId(cardId)
      setClarifyPending('')
      pendingTranscriptRef.current = ''
      interimRef.current = ''
      setInterim('')
      const rec = createRecognizer({
        onStart: () => setListening(true),
        onEnd: () => {
          setListening(false)
          if (finishRecordingRef.current) {
            finishRecordingRef.current = false
            recognizerRef.current = null
            deliverRecording()
            return
          }
          if (recordingRef.current) recognizerRef.current?.start()
        },
        onError: () => {
          cleanupVoice()
          setClarifyRecordingId(null)
          setClarifyPending('')
        },
        onInterim: (t) => {
          interimRef.current = t
          setInterim(t)
        },
        onFinal: (t) => {
          interimRef.current = ''
          setInterim('')
          const trimmed = t.trim()
          if (!trimmed) return
          pendingTranscriptRef.current = pendingTranscriptRef.current
            ? `${pendingTranscriptRef.current} ${trimmed}`
            : trimmed
          setClarifyPending(pendingTranscriptRef.current)
        },
      })
      if (!rec) return
      recognizerRef.current = rec
      recordingRef.current = true
      setRecording(true)
      rec.start()
    },
    [sttOK, stopRecording, deliverRecording, cleanupVoice]
  )

  const submitPrompt = useCallback(() => {
    const q = prompt.trim()
    if (!q || voiceBusyRef.current || recordingRef.current) return
    setPrompt('')
    void askVoiceTutor(q)
  }, [prompt, askVoiceTutor])

  const toggleSpeaker = useCallback(() => {
    setSpeakerOn((on) => {
      if (on) {
        speakerRef.current?.cancel()
        hintSpeakerRef.current?.cancel()
        setHintSpeakingId(null)
        cancelSpeech()
      }
      return !on
    })
  }, [])

  useEffect(() => cleanupVoice, [cleanupVoice]) // stop mic/speech on unmount

  const cursor =
    tool === 'pen' || tool === 'highlight' ? 'crosshair' : tool === 'eraser' ? 'cell' : 'default'

  const toolBtn = (t: Tool, label: string) => (
    <button
      type="button"
      onClick={() => setTool(t)}
      title={label}
      className="btn-ghost"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: 12,
        padding: '6px 10px',
        ...(tool === t ? ACTIVE_GLASS : {}),
      }}
    >
      {label}
    </button>
  )

  const toolbarVertical = toolbarDragging
    ? toolbarDragVertical
    : toolbarDock === 'left' || toolbarDock === 'right'
  const toolbarGroupStyle: CSSProperties = {
    display: 'flex',
    gap: 4,
    alignItems: toolbarVertical ? 'stretch' : 'center',
    flexDirection: toolbarVertical ? 'column' : 'row',
  }
  // No max clamp — horizontal bar grows to fit every control on one line.
  const toolbarMaxWidth = 'none'

  const onToolbarDragStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const pane = paneRect()
    const el = toolbarRef.current
    if (!pane || !el) return

    const grip = e.currentTarget as HTMLElement
    try {
      grip.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }

    const bar = el.getBoundingClientRect()
    toolbarPaneOrigin.current = {
      left: pane.left,
      top: pane.top,
      width: pane.width,
      height: pane.height,
    }
    // Offset from the shell's visual top-left → stays glued to this grab point.
    toolbarDragOffset.current = {
      x: e.clientX - bar.left,
      y: e.clientY - bar.top,
    }
    toolbarGrabClient.current = { x: e.clientX, y: e.clientY }

    const start = {
      x: bar.left - pane.left,
      y: bar.top - pane.top,
    }
    const w0 = el.offsetWidth
    const h0 = el.offsetHeight
    const keepVertical = toolbarDock === 'left' || toolbarDock === 'right'
    // Record the live orientation; fill the other from cache or a one-shot measure.
    if (keepVertical) toolbarOrientSize.current.vertical = { w: w0, h: h0 }
    else toolbarOrientSize.current.horizontal = { w: w0, h: h0 }
    if (keepVertical && !toolbarOrientSize.current.horizontal) {
      toolbarOrientSize.current.horizontal = measureToolbarOrientation(el, false)
    } else if (!keepVertical && !toolbarOrientSize.current.vertical) {
      toolbarOrientSize.current.vertical = measureToolbarOrientation(el, true)
    }

    toolbarFreeRef.current = start
    toolbarDraggingRef.current = true
    setToolbarFree(start)
    setToolbarDragVertical(keepVertical)
    // Keep dock for layout orientation — only is-dragging takes over position.
    setToolbarDragging(true)

    // GPU-composited position. React style intentionally omits left/top while
    // dragging so re-renders cannot yank the bar back behind the cursor.
    el.style.left = '0px'
    el.style.top = '0px'
    el.style.right = 'auto'
    el.style.bottom = 'auto'
    el.style.transform = `translate3d(${start.x}px, ${start.y}px, 0)`
    el.style.pointerEvents = 'none'

    const sizeForDock = (dock: ToolbarDock, liveW: number, liveH: number): ToolbarSize => {
      const wantVertical = dock === 'left' || dock === 'right'
      if (wantVertical === keepVertical) return { w: liveW, h: liveH }
      const cached = wantVertical
        ? toolbarOrientSize.current.vertical
        : toolbarOrientSize.current.horizontal
      if (cached && cached.w > 8 && cached.h > 8) return cached
      // Last resort only — prefer cached real layout size above.
      return { w: liveH, h: liveW }
    }

    const placeGhost = (dock: ToolbarDock, liveW: number, liveH: number) => {
      const ghost = toolbarGhostRef.current
      if (!ghost) return
      const origin = toolbarPaneOrigin.current
      const size = sizeForDock(dock, liveW, liveH)
      const rect = toolbarDockGhostRect(dock, size, origin.width, origin.height, competition)
      if (!rect) {
        ghost.style.opacity = '0'
        return
      }
      ghost.style.opacity = '1'
      ghost.style.width = `${rect.width}px`
      ghost.style.height = `${rect.height}px`
      ghost.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`
    }

    let lastSnap: ToolbarDock = 'free'
    placeGhost('free', w0, h0)
    setToolbarSnapDock(null)

    const onMove = (ev: PointerEvent) => {
      const node = toolbarRef.current
      if (!node) return
      const origin = toolbarPaneOrigin.current
      const next = {
        x: ev.clientX - origin.left - toolbarDragOffset.current.x,
        y: ev.clientY - origin.top - toolbarDragOffset.current.y,
      }
      const w = node.offsetWidth
      const h = node.offsetHeight
      next.x = Math.max(-w + 40, Math.min(origin.width - 40, next.x))
      next.y = Math.max(0, Math.min(origin.height - 24, next.y))
      toolbarFreeRef.current = next
      node.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`

      const snapped = snapToolbarDock(next.x, next.y, w, h, origin.width, origin.height)
      placeGhost(snapped.dock, w, h)
      if (snapped.dock !== lastSnap) {
        lastSnap = snapped.dock
        setToolbarSnapDock(snapped.dock === 'free' ? null : snapped.dock)
      }
    }

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      try {
        grip.releasePointerCapture(ev.pointerId)
      } catch {
        /* ignore */
      }

      const node = toolbarRef.current
      const ghost = toolbarGhostRef.current
      const origin = toolbarPaneOrigin.current
      const pos = toolbarFreeRef.current
      setToolbarSnapDock(null)

      if (!node) {
        toolbarDraggingRef.current = false
        toolbarGrabClient.current = null
        setToolbarDragging(false)
        setToolbarDragVertical(false)
        if (ghost) ghost.style.opacity = '0'
        return
      }

      const w = node.offsetWidth
      const h = node.offsetHeight
      const snapped = snapToolbarDock(pos.x, pos.y, w, h, origin.width, origin.height)

      const clearDragInline = () => {
        node.style.transition = ''
        node.style.left = ''
        node.style.top = ''
        node.style.right = ''
        node.style.bottom = ''
        node.style.transform = ''
        node.style.pointerEvents = ''
        node.style.willChange = ''
      }

      const persist = () => {
        try {
          sessionStorage.setItem(TOOLBAR_DOCK_KEY, JSON.stringify(snapped))
        } catch {
          /* ignore */
        }
      }

      toolbarDraggingRef.current = false
      toolbarGrabClient.current = null

      // Free drop — settle where it is, no dock morph.
      if (snapped.dock === 'free') {
        if (ghost) ghost.style.opacity = '0'
        setToolbarDock('free')
        setToolbarFree(pos)
        setToolbarDragging(false)
        setToolbarDragVertical(false)
        clearDragInline()
        persist()
        return
      }

      // FLIP: capture the live rect, commit final dock layout, then invert+play.
      toolbarFlipFirst.current = node.getBoundingClientRect()
      if (ghost) {
        ghost.style.transition = `opacity ${TOOLBAR_FLIP_MS}ms ${TOOLBAR_FLIP_EASE}`
        ghost.style.opacity = '0'
      }
      setToolbarDock(snapped.dock)
      setToolbarFree(snapped.free)
      setToolbarDragVertical(false)
      setToolbarDragging(false)
      setToolbarSnapping(true)
      persist()
    }

    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const voiceStatus = thinking
    ? 'Thinking…'
    : speaking
    ? 'Speaking…'
    : listening
    ? 'Listening…'
    : recording
    ? 'Ready'
    : ''
  const voiceStatusColor = thinking ? '#2563eb' : speaking ? '#0d9488' : '#b45309'

  const clarifyLiveTranscript = clarifyRecordingId
    ? [clarifyPending, interim].filter(Boolean).join(' ')
    : ''

  const voicePanel =
    !clarifyRecordingId &&
    (recording || thinking || speaking || voiceReply || voiceError || interim || voiceUser) && (
    <div
      data-html2canvas-ignore
      className="card"
      style={{
        position: 'absolute',
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: 76,
        zIndex: 47,
        width: 'min(100% - 32px, 520px)',
        maxHeight: '40vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '9px 12px',
          background: 'rgba(255,255,255,0.4)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          borderBottom: '1px solid rgba(0,0,0,0.08)',
          borderTopLeftRadius: '1.25em',
          borderTopRightRadius: '1.25em',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 700, color: 'rgba(0,0,0,0.78)' }}>
          Voice tutor
          {voiceStatus && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 600, color: voiceStatusColor, background: 'rgba(255,255,255,0.55)', border: `1px solid ${voiceStatusColor}44`, borderRadius: 999, padding: '2px 8px' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: voiceStatusColor }} />
              {voiceStatus}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={dismissVoicePanel}
          title="Close voice tutor"
          aria-label="Close voice tutor"
          className="btn-ghost"
          style={{
            width: 26,
            height: 26,
            padding: 0,
            flexShrink: 0,
            color: 'rgba(0,0,0,0.55)',
          }}
        >
          <X size={13} />
        </button>
      </div>

      <div style={{ padding: '10px 12px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {voiceError && (
          <div style={{ fontSize: 12, color: '#b91c1c', lineHeight: 1.45 }}>{voiceError}</div>
        )}
        {(interim || voiceUser) && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', color: 'rgba(0,0,0,0.4)', marginBottom: 2 }}>You</div>
            <div style={{ fontSize: 13, color: interim ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.82)', lineHeight: 1.45 }}>
              {interim || voiceUser}
            </div>
          </div>
        )}
        {voiceReply && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', color: 'rgba(0,0,0,0.4)', marginBottom: 2 }}>Thales</div>
            <div style={{ fontSize: 13.5, color: 'rgba(0,0,0,0.85)', lineHeight: 1.5 }}>{voiceReply}</div>
          </div>
        )}
        {thinking && !voiceReply && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'rgba(0,0,0,0.5)' }}>
            <Loader2 size={13} className="animate-spin" /> Thinking…
          </div>
        )}
        {recording && !voiceReply && !interim && !voiceUser && !voiceError && (
          <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)', lineHeight: 1.5 }}>
            Recording — tap the mic again when you&apos;re done.
          </div>
        )}
      </div>
    </div>
  )

  const iconBtnStyle = (active: boolean, activeColor = '#0d766e'): CSSProperties => ({
    display: 'grid',
    placeItems: 'center',
    width: 36,
    height: 36,
    padding: 0,
    flexShrink: 0,
    color: active ? activeColor : 'rgba(0,0,0,0.7)',
    ...(active ? ACTIVE_GLASS : {}),
    ...(active ? { color: activeColor } : {}),
  })

  return (
    <>
      {/* Ink + pasted images live inside the viewport so they pan/zoom with the board.
          Images render FIRST (underneath) so pen strokes land visibly ON TOP of them. */}
      <EdgeLabelRenderer>
        {images.map((im) => {
          const selected = selectedImageId === im.id
          const interactive = tool === 'off'
          return (
            <div
              key={im.id}
              className="nodrag nopan"
              data-mathimg-wrap={im.id}
              data-html2canvas-ignore
              onPointerDown={(e) => onImagePointerDown(e, im, 'drag')}
              onPointerMove={onImagePointerMove}
              onPointerUp={onImagePointerUp}
              onPointerCancel={onImagePointerUp}
              style={{
                position: 'absolute',
                left: im.x,
                top: im.y,
                width: im.w,
                height: im.h,
                pointerEvents: interactive ? 'auto' : 'none',
                cursor: interactive ? (selected ? 'grab' : 'pointer') : 'default',
                borderRadius: 6,
                boxShadow: selected
                  ? '0 0 0 2px #2563eb, 0 2px 12px rgba(0,0,0,0.15)'
                  : '0 2px 12px rgba(0,0,0,0.15)',
              }}
            >
              <img
                src={im.src}
                alt="pasted"
                data-mathimg={im.id}
                draggable={false}
                style={{
                  width: '100%',
                  height: '100%',
                  pointerEvents: 'none',
                  borderRadius: 6,
                  display: 'block',
                  userSelect: 'none',
                }}
              />
              {selected && interactive && (
                <div
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    onImagePointerDown(e, im, 'resize')
                  }}
                  title="Resize"
                  style={{
                    position: 'absolute',
                    right: -6,
                    bottom: -6,
                    width: 14,
                    height: 14,
                    borderRadius: 4,
                    background: '#2563eb',
                    border: '2px solid #fff',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
                    cursor: 'nwse-resize',
                  }}
                />
              )}
            </div>
          )
        })}
        <svg
          data-html2canvas-ignore
          style={{
            position: 'absolute',
            left: -INK_OFFSET,
            top: -INK_OFFSET,
            width: INK_OFFSET * 2,
            height: INK_OFFSET * 2,
            overflow: 'visible',
            pointerEvents: 'none',
          }}
        >
          {/* Recognized-line highlight: a fat translucent under-stroke behind
              exactly the ink the tutor is referring to ("look at line 3"). */}
          {glowStrokeIds.size > 0 &&
            strokes
              .filter((st) => glowStrokeIds.has(st.id))
              .map((st) => (
                <path
                  key={`glow-${st.id}`}
                  d={pointsToPath(st.points)}
                  fill="none"
                  stroke="#fbbf24"
                  strokeWidth={Math.max(st.width * 4, st.width + 10)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.45}
                />
              ))}
          {strokes.map((st) => (
            <path
              key={st.id}
              d={pointsToPath(st.points)}
              fill="none"
              stroke={st.color}
              strokeWidth={st.width}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {draft && (
            <path
              d={pointsToPath(draft.points)}
              fill="none"
              stroke={draft.color}
              strokeWidth={draft.width}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>

        {cards.flatMap((card) =>
          card.mode === 'hint' && card.boardBounds && (card.firedMarkers > 0 || card.heldZone)
            ? [
                <MathGuidedSpotlight
                  key={`spot-${card.id}`}
                  cardId={card.id}
                  say={card.text}
                  firedMarkers={card.firedMarkers}
                  strokes={strokes}
                  boardBounds={card.boardBounds}
                  writeStates={card.writeStates}
                  writeBoxes={card.writeBoxes ?? {}}
                  heldZone={card.heldZone}
                  occupied={cardOccupied(images, card)}
                />,
              ]
            : []
        )}

        {cards.map((card) => (
          <MathTutorHighlight key={`hl-${card.id}`} session={card} zoom={zoom} />
        ))}
      </EdgeLabelRenderer>

      {/* Interaction overlay — only captures pointers when a math tool is active */}
      <div
        ref={overlayRef}
        data-html2canvas-ignore
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 40,
          cursor,
          touchAction: 'none',
          pointerEvents: tool === 'off' ? 'none' : 'auto',
        }}
      >
        {sel && (
          <div
            style={{
              position: 'absolute',
              left: sel.x,
              top: sel.y,
              width: sel.w,
              height: sel.h,
              border: '2px dashed rgba(0,0,0,0.5)',
              background: 'rgba(255,255,255,0.22)',
              backdropFilter: 'blur(2px)',
              WebkitBackdropFilter: 'blur(2px)',
              borderRadius: 6,
            }}
          />
        )}
      </div>

      {/* Write-box submit ✓ — screen-space so it stays tappable above the ink overlay */}
      <div
        data-html2canvas-ignore
        style={{ position: 'absolute', inset: 0, zIndex: 45, pointerEvents: 'none' }}
      >
        {cards.flatMap((card) => {
          if (
            card.mode !== 'hint' ||
            !card.boardBounds ||
            card.firedMarkers === 0 ||
            card.status === 'loading' ||
            card.status === 'streaming'
          ) {
            return []
          }
          const wrap = paneRect()
          if (!wrap) return []
          const occupied = cardOccupied(images, card)
          const { writes } = resolveFiredMarkers(
            card.text,
            card.firedMarkers,
            strokes,
            card.boardBounds,
            12,
            occupied,
            card.writeBoxes ?? {}
          )
          return writes.flatMap((wz) => {
            const state = card.writeStates[wz.index] ?? 'open'
            if (state !== 'open' && state !== 'filled') return []
            const br = rf.flowToScreenPosition({ x: wz.box.maxX, y: wz.box.maxY })
            return [
              <button
                key={`zcheck-${card.id}-${wz.index}`}
                type="button"
                className={`math-write-zone-check${state === 'filled' ? ' is-ready' : ''}`}
                title={
                  state === 'filled'
                    ? "I'm done — check my work"
                    : 'Write your answer in the box, then tap here'
                }
                style={{ left: br.x - wrap.left - 14, top: br.y - wrap.top - 14 }}
                onClick={() => state === 'filled' && checkWriteZone(card.id, wz.index)}
              >
                <Check size={14} strokeWidth={3} />
              </button>,
            ]
          })
        })}
      </div>

      <MathTutorScreenLayer
        sessions={cards}
        rf={rf}
        zoom={zoom}
        viewportX={x}
        viewportY={y}
        strokes={strokes}
        images={images}
        occupied={[]}
        chrome={chromeRects}
        getPaneRect={paneRect}
        // True only while the TTS voice is audibly speaking — the typewriter
        // waits for this so on-screen words stay in sync with the audio, and
        // the head animates from either signal (voice OR visible typing).
        talkingFor={(id) => hintSpeakingId === id}
        onMarkersFired={onMarkersFired}
        onClose={closeCard}
        clarifyRecordingId={clarifyRecordingId}
        clarifyInterim={clarifyRecordingId ? interim : ''}
        clarifyLiveTranscript={clarifyLiveTranscript}
        sttOK={sttOK}
        onClarifyMic={toggleClarifyMic}
        onAnotherHint={(id) => {
          const card = cardsRef.current.find((c) => c.id === id)
          if (card) resolveCard(card, 'hint')
        }}
        onFullSolution={(id) => {
          const card = cardsRef.current.find((c) => c.id === id)
          if (card) resolveCard(card, 'solve')
        }}
        onGeneralize={() => void requestGeneralize()}
        onAdvanceStep={advanceStep}
        onReexplainStep={reexplainStep}
      />

      {/* Dock preview — faint silhouette of where the bar will land */}
      <div
        ref={toolbarGhostRef}
        data-html2canvas-ignore
        className={`math-toolbar-dock-ghost${toolbarSnapDock ? ' is-visible' : ''}`}
        aria-hidden
      />

      {/* Toolbar */}
      <div
        ref={toolbarRef}
        data-html2canvas-ignore
        className={[
          'math-toolbar-shell',
          toolbarDragging ? 'is-dragging' : '',
          toolbarSnapping ? 'is-snapping' : '',
          toolbarVertical ? 'is-vertical' : '',
          // While dragging, drop dock-* so CSS transforms don't fight translate3d.
          // During FLIP snap, dock-* must be on so we measure the real end layout.
          !toolbarDragging && toolbarDock !== 'free' ? `dock-${toolbarDock}` : '',
          competition ? 'is-competition' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={toolbarShellStyle(toolbarFree, toolbarDock, toolbarDragging, toolbarSnapping)}
      >
        <div
          className="math-toolbar-grip"
          title="Move toolbar"
          onPointerDown={onToolbarDragStart}
        />
        <div
          className="card math-toolbar-body"
          style={{
            display: 'flex',
            alignItems: toolbarVertical ? 'stretch' : 'center',
            gap: 10,
            padding: '8px 10px',
            flexWrap: 'nowrap',
            flexDirection: toolbarVertical ? 'column' : 'row',
            width: toolbarVertical ? undefined : 'max-content',
            maxWidth: toolbarVertical ? 'none' : toolbarMaxWidth,
            maxHeight: toolbarVertical ? 'calc(100vh - 140px)' : undefined,
            overflow: toolbarVertical ? 'auto' : 'visible',
          }}
        >
        <div style={toolbarGroupStyle}>
          {toolBtn('off', 'Move')}
          {toolBtn('pen', 'Pen')}
          {toolBtn('eraser', 'Eraser')}
          {toolBtn('highlight', 'Hint select')}
        </div>

        <div className="math-hint-toolbar" style={toolbarGroupStyle}>
          {HINT_SIZES.map((s) => (
            <button
              key={s.level}
              type="button"
              className="btn-ghost math-hint-size-btn"
              title={s.title}
              onClick={() => setHintSize(s.level)}
              style={{
                fontSize: 11,
                padding: '5px 8px',
                ...(hintSize === s.level ? ACTIVE_GLASS : {}),
              }}
            >
              {s.label}
            </button>
          ))}
          <button
            type="button"
            className="btn-ghost math-hint-go-btn"
            title="Get a hint on your work"
            disabled={strokes.length === 0 && images.length === 0}
            onClick={() => void requestBoardHint(hintSize)}
            style={{
              fontSize: 12,
              padding: '6px 10px',
              opacity: strokes.length === 0 && images.length === 0 ? 0.45 : 1,
            }}
          >
            Hint
          </button>
          <button
            type="button"
            className="btn-ghost math-hint-go-btn"
            title="Step back: learn the general approach for this TYPE of problem"
            disabled={strokes.length === 0 && images.length === 0}
            onClick={() => void requestGeneralize()}
            style={{
              fontSize: 12,
              padding: '6px 10px',
              opacity: strokes.length === 0 && images.length === 0 ? 0.45 : 1,
            }}
          >
            Generalize
          </button>
        </div>

        <div style={{ ...toolbarGroupStyle, gap: 5 }}>
          {PEN_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                setColor(c)
                if (tool !== 'pen') setTool('pen')
              }}
              title={c}
              style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                background: c,
                border: color === c ? '2px solid #111' : '2px solid #fff',
                boxShadow: '0 0 0 1px rgba(0,0,0,0.15)',
                cursor: 'pointer',
                padding: 0,
              }}
            />
          ))}
        </div>

        <div style={toolbarGroupStyle}>
          {PEN_SIZES.map((sVal) => (
            <button
              key={sVal}
              type="button"
              onClick={() => setSize(sVal)}
              title={`${sVal}px`}
              className="btn-ghost"
              style={{
                width: 28,
                height: 28,
                display: 'grid',
                placeItems: 'center',
                padding: 0,
                ...(size === sVal ? ACTIVE_GLASS : {}),
              }}
            >
              <span
                style={{ width: sVal + 3, height: sVal + 3, borderRadius: '50%', background: '#111', display: 'block' }}
              />
            </button>
          ))}
        </div>

        <div style={toolbarGroupStyle}>
          <button
            type="button"
            className="btn-ghost"
            title="Undo (Ctrl+Z)"
            onClick={undo}
            disabled={past.current.length === 0}
            style={{ fontSize: 12, padding: '6px 10px', opacity: past.current.length === 0 ? 0.4 : 1 }}
          >
            Undo
          </button>
          <button
            type="button"
            className="btn-ghost"
            title="Redo (Ctrl+Y)"
            onClick={redo}
            disabled={future.current.length === 0}
            style={{ fontSize: 12, padding: '6px 10px', opacity: future.current.length === 0 ? 0.4 : 1 }}
          >
            Redo
          </button>
        </div>

        <div style={toolbarGroupStyle}>
          <label
            className="btn-ghost"
            title="Upload image"
            style={{ fontSize: 12, padding: '6px 10px', cursor: 'pointer' }}
          >
            Image
            <input type="file" accept="image/*" hidden onChange={onUpload} />
          </label>
          <button
            type="button"
            className="btn-ghost"
            title="Clear ink and images"
            onClick={() => {
              if (strokesRef.current.length === 0 && imagesRef.current.length === 0) return
              pushHistory()
              strokesRef.current = []
              imagesRef.current = []
              setStrokes([])
              setImages([])
              setSelectedImageId(null)
              if (boardAdventureRef.current) clearMathBoard(boardAdventureRef.current)
              // Persist the clear to cloud (storage already emptied above).
              if (boardAdventureRef.current) {
                saveMathBoard(boardAdventureRef.current, { strokes: [], images: [] })
              }
            }}
            style={{ fontSize: 12, padding: '6px 10px' }}
          >
            Clear ink
          </button>
        </div>
        </div>
      </div>

      {/* Bottom controls. Competition: mic asks Thales a question (pops the
          coach card); speaker toggles whether replies are read aloud. */}
      {competition ? (
        <div
          ref={(el) => {
            micBarRef.current = el
          }}
          data-html2canvas-ignore
          style={{
            position: 'absolute',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 48,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <button
            type="button"
            className={recording ? 'btn-danger' : 'btn-ghost'}
            onClick={toggleRecording}
            disabled={!sttOK || thinking}
            title={
              recording
                ? 'Tap when done asking'
                : sttOK
                  ? 'Ask Thales a question'
                  : 'Voice needs Chrome/Edge'
            }
            aria-label={recording ? 'Stop recording' : 'Ask Thales'}
            style={{
              width: 42,
              height: 42,
              padding: 0,
              flexShrink: 0,
              color: recording ? undefined : '#0d9488',
              opacity: sttOK && !thinking ? 1 : 0.4,
            }}
          >
            {recording ? <MicOff size={17} /> : <Mic size={17} />}
          </button>
          <button
            type="button"
            className={speakerOn ? 'btn-primary' : 'btn-ghost'}
            onClick={toggleSpeaker}
            disabled={!ttsOK}
            title={
              speakerOn
                ? 'Thales speaks out loud. Click to mute (text only).'
                : 'Muted. Thales replies with text only. Click to turn voice on.'
            }
            aria-label={speakerOn ? 'Mute Thales voice' : 'Unmute Thales voice'}
            style={{
              width: 36,
              height: 36,
              padding: 0,
              flexShrink: 0,
              color: speakerOn ? undefined : 'rgba(0,0,0,0.45)',
              opacity: ttsOK ? 1 : 0.4,
            }}
          >
            {speakerOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
          </button>
        </div>
      ) : (
        <div
          ref={(el) => {
            micBarRef.current = el
          }}
          data-html2canvas-ignore
          className="card"
          style={{
            position: 'absolute',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 48,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 10px',
            width: 'min(100% - 32px, 520px)',
          }}
        >
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submitPrompt()
              }
            }}
            placeholder="What do you want help with?"
            style={{
              flex: 1,
              minWidth: 0,
              background: 'rgba(0,0,0,0.04)',
              border: '1px solid rgba(0,0,0,0.1)',
              borderRadius: 10,
              padding: '8px 12px',
              fontSize: 13,
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={toggleRecording}
            title={recording ? 'Stop recording' : 'Record voice'}
            className="btn-ghost"
            disabled={!sttOK || thinking}
            style={{
              ...iconBtnStyle(recording),
              opacity: sttOK && !thinking ? 1 : 0.4,
            }}
          >
            {recording ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
          <button
            type="button"
            onClick={toggleSpeaker}
            title={speakerOn ? 'Mute tutor audio' : 'Enable tutor audio'}
            className="btn-ghost"
            disabled={!ttsOK}
            style={{
              ...iconBtnStyle(speakerOn, '#1d4ed8'),
              opacity: ttsOK ? 1 : 0.4,
            }}
          >
            {speakerOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
        </div>
      )}

      {voicePanel}
    </>
  )
}

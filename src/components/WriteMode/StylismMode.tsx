/**
 * Voice — one living map of the writer's voice.
 *
 * A single pannable/zoomable canvas. At its heart sits a big glass "+" node the
 * writer clicks to upload their proudest work; every other node repels from it
 * gently. As Odin reads, distilled principles bubble in as glass neurons whose
 * border is tinted by the document(s) they came from (blending when a trait
 * spans several). Connected principles wire into colonies that arrange
 * themselves around the center.
 *
 * Click a node (a quick tap, not a drag — dragging still moves it) to grow it
 * ~3× into a featured card that stays wired into the network. Because a circle
 * has limited room, its details are split into cyclable sections — the
 * principle, a good/bad contrast, and where it came from (source documents plus
 * emphasis/reinforcement signals) — navigated with side arrows or the dots.
 * Edit + delete live in the footer; click empty space to collapse. Documents
 * live in a collapsible rail on the left, the eloquent description of the voice
 * on the right (it opens itself once Odin starts talking), and Odin murmurs
 * about what it's learning in the bottom-left without getting in the way.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type CSSProperties,
} from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Plus,
  X,
  Trash2,
  Pencil,
  Check,
  FileText,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Files,
} from 'lucide-react'
import { useStore, useHasApiKey } from '../../store/useStore'
import OdinHead from '../OdinHead'
import {
  computeStyleEdges,
  connectedComponents,
  docHue,
  type StyleEdge,
  type StyleRule,
} from '../../lib/style'
import { readWritingFile, streamVoiceDeep, relevanceToWeight, type VoiceDocument } from '../../lib/voiceImport'
import { isOnboardingActive, markVoiceNodeExpanded } from '../../lib/onboarding'

interface SimNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  r: number
  targetR: number
  pinned: boolean
}

interface ReadingDoc {
  id: string
  name: string
  ext: string
  error?: string
}

const ACCEPT =
  '.txt,.md,.markdown,.pdf,.doc,.docx,text/plain,text/markdown,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const MIN_ZOOM = 0.3
const MAX_ZOOM = 2.4
const DEFAULT_ZOOM = 0.7
const MIN_R = 36
const MAX_R = 82
const ADD_R = 78 // radius of the central upload node (for repulsion)
const EXPANDED_R = 216 // radius an opened node grows to (stays a circle in-network)

function nodeRadius(weight: number, allWeights: number[]): number {
  if (allWeights.length === 0) return MIN_R + 8
  const logs = allWeights.map((w) => Math.log(w + 1))
  const lo = Math.min(...logs)
  const hi = Math.max(...logs)
  if (hi - lo < 1e-6) return MIN_R + 10
  const rel = (Math.log(weight + 1) - lo) / (hi - lo)
  const sigmoid = 1 / (1 + Math.exp(-6 * (rel - 0.5)))
  return MIN_R + sigmoid * (MAX_R - MIN_R)
}

function fileExt(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

function coverExcerpt(text: string, max = 480): string {
  const clean = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return clean.length > max ? clean.slice(0, max).trimEnd() + '…' : clean
}

function tintVars(sourceDocs: string[] | undefined): CSSProperties {
  const hues = (sourceDocs ?? []).map(docHue)
  if (hues.length === 0) {
    return { ['--tint']: 'rgba(120,124,140,0.42)', ['--tint2']: 'rgba(120,124,140,0.42)' } as CSSProperties
  }
  const c = (h: number) => `hsl(${h} 72% 60% / 0.85)`
  return { ['--tint']: c(hues[0]), ['--tint2']: c(hues[hues.length > 1 ? 1 : 0]) } as CSSProperties
}

let docSeq = 0

const ODIN_THINKING = [
  'Reading your cadence…',
  'Noticing how you open a paragraph…',
  'Mapping the words you reach for.',
  'Tracing your punctuation habits.',
  'Learning where you break the rules.',
  'Feeling out your rhythm.',
  'Watching how you land an ending.',
  'This is starting to sound like you.',
  'Replicating your voice, sentence by sentence.',
]

const ODIN_TYPE_MS = 42

/**
 * Odin murmuring in the bottom-left: his animated face beside a speech bubble
 * whose text types itself in — same living logo as the home screen. His mouth
 * moves while a line is being typed, then rests once the thought lands.
 */
function OdinMurmur({ line }: { line: string }) {
  const [displayed, setDisplayed] = useState('')
  const [typing, setTyping] = useState(false)

  useEffect(() => {
    setDisplayed('')
    setTyping(true)
    let i = 0
    const id = window.setInterval(() => {
      i += 1
      setDisplayed(line.slice(0, i))
      if (i >= line.length) {
        window.clearInterval(id)
        setTyping(false)
      }
    }, ODIN_TYPE_MS)
    return () => window.clearInterval(id)
  }, [line])

  return (
    <div className="voice-odin-bubble-wrap">
      <div className="voice-odin-bubble">
        <p className="voice-odin-text">
          {displayed}
          {typing && <span className="home-speech-cursor" aria-hidden="true" />}
        </p>
      </div>
      <OdinHead talking={typing} size={84} className="voice-odin-face" />
    </div>
  )
}

/* ── Gentle downward auto-scroll; loops once content overflows ── */
function useGentleAutoScroll(active: boolean) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const lastUser = useRef(0)
  const pos = useRef(0)

  useEffect(() => {
    const el = viewportRef.current
    if (!el || !active) return

    const SPEED = 0.16
    const PAUSE_MS = 1600

    let raf = 0
    pos.current = el.scrollTop
    const onWheel = () => {
      lastUser.current = Date.now()
      pos.current = el.scrollTop
    }
    const tick = () => {
      const max = el.scrollHeight - el.clientHeight
      if (max > 4 && Date.now() - lastUser.current > PAUSE_MS) {
        let next = pos.current + SPEED
        if (next >= max) next = 0
        pos.current = next
        el.scrollTop = next
      } else {
        pos.current = el.scrollTop
      }
      raf = requestAnimationFrame(tick)
    }

    el.addEventListener('wheel', onWheel, { passive: true })
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('wheel', onWheel)
    }
  }, [active])

  return viewportRef
}

type SectionKind = 'principle' | 'example' | 'source'

const SECTION_TAG: Record<SectionKind, string> = {
  principle: 'The principle',
  example: 'In practice', 
  source: 'Where it comes from',
}

function originLabel(source: StyleRule['source']): string {
  if (source === 'ai') return 'Distilled by Odin'
  if (source === 'user') return 'You added this'
  return 'House default'
}

/**
 * The opened neuron: a bigger glass circle that still lives in the network.
 * Because a circle has limited room, its details are split into sections the
 * writer cycles through (principle → example → sources & signals).
 */
function VoiceNodeCard({
  rule,
  editing,
  section,
  setSection,
  setEditing,
  onDelete,
  editStyleRule,
}: {
  rule: StyleRule
  editing: boolean
  section: number
  setSection: (n: number) => void
  setEditing: (v: boolean) => void
  onDelete: () => void
  editStyleRule: (id: string, patch: Partial<Pick<StyleRule, 'label' | 'instruction' | 'enabled' | 'example'>>) => void
}) {
  const hasExample = !!(rule.example && (rule.example.good || rule.example.bad))
  const sections: SectionKind[] = ['principle']
  if (hasExample || editing) sections.push('example')
  sections.push('source')

  const idx = Math.min(section, sections.length - 1)
  const kind = sections[idx]
  const go = (delta: number) =>
    setSection((((idx + delta) % sections.length) + sections.length) % sections.length)

  const ex = rule.example ?? { good: '', bad: '' }
  const patchExample = (patch: Partial<{ good: string; bad: string }>) =>
    editStyleRule(rule.id, { example: { ...ex, ...patch } })

  const sources = rule.sourceDocs ?? []

  return (
    <>
      <span className="voice-node-tag">{SECTION_TAG[kind]}</span>

      <div className="voice-node-inner">
        <div className="voice-node-head">
          {editing ? (
            <input
              className="voice-node-title-input"
              value={rule.label}
              onChange={(e) => editStyleRule(rule.id, { label: e.target.value })}
              placeholder="Principle name"
              autoFocus
            />
          ) : (
            <h3 className="voice-node-title">{rule.label}</h3>
          )}
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={kind + (editing ? '-edit' : '')}
            className="voice-node-section"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            {kind === 'principle' &&
              (editing ? (
                <textarea
                  className="voice-node-inst-input"
                  value={rule.instruction}
                  onChange={(e) => editStyleRule(rule.id, { instruction: e.target.value })}
                  placeholder="What should Odin do to write in this voice?"
                  rows={6}
                />
              ) : (
                <p className="voice-node-inst">
                  {rule.instruction || 'No description yet — hit edit to add one.'}
                </p>
              ))}

            {kind === 'example' &&
              (editing ? (
                <div className="voice-node-examples">
                  <label className="voice-node-ex-edit good">
                    <span className="voice-node-ex-tag">Like this</span>
                    <textarea
                      value={ex.good}
                      onChange={(e) => patchExample({ good: e.target.value })}
                      placeholder="A line that sounds like you"
                      rows={3}
                    />
                  </label>
                  <label className="voice-node-ex-edit bad">
                    <span className="voice-node-ex-tag">Not this</span>
                    <textarea
                      value={ex.bad}
                      onChange={(e) => patchExample({ bad: e.target.value })}
                      placeholder="A line that doesn't"
                      rows={3}
                    />
                  </label>
                </div>
              ) : (
                <div className="voice-node-examples">
                  {ex.good && (
                    <p className="voice-node-ex good">
                      <span className="voice-node-ex-tag">Like this</span>
                      {ex.good}
                    </p>
                  )}
                  {ex.bad && (
                    <p className="voice-node-ex bad">
                      <span className="voice-node-ex-tag">Not this</span>
                      {ex.bad}
                    </p>
                  )}
                </div>
              ))}

            {kind === 'source' && (
              <div className="voice-node-source">
                <div className="voice-node-meta-block">
                  <span className="voice-node-meta-key">Sources</span>
                  {sources.length ? (
                    <div className="voice-node-chips">
                      {sources.map((name) => (
                        <span
                          key={name}
                          className="voice-node-chip"
                          style={{ ['--chip']: `hsl(${docHue(name)} 70% 56%)` } as CSSProperties}
                          title={name}
                        >
                          <FileText size={10} />
                          {name}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="voice-node-meta-empty">Not tied to a document yet</span>
                  )}
                </div>

                <div className="voice-node-meta-grid">
                  <div className="voice-node-stat">
                    <span className="voice-node-stat-num">×{rule.weight.toFixed(1)}</span>
                    <span className="voice-node-stat-lbl">Emphasis</span>
                  </div>
                  <div className="voice-node-stat">
                    <span className="voice-node-stat-num">{rule.useCount}</span>
                    <span className="voice-node-stat-lbl">Reinforced</span>
                  </div>
                </div>

                <span className="voice-node-origin">{originLabel(rule.source)}</span>
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        {sections.length > 1 && (
          <div className="voice-node-nav">
            {sections.map((s, i) => (
              <button
                key={s}
                className={`voice-node-dot${i === idx ? ' active' : ''}`}
                onClick={() => setSection(i)}
                aria-label={SECTION_TAG[s]}
              />
            ))}
          </div>
        )}

        <div className="voice-node-foot">
          {editing ? (
            <button className="voice-node-btn primary" onClick={() => setEditing(false)}>
              <Check size={12} /> Done
            </button>
          ) : (
            <button className="voice-node-btn" onClick={() => setEditing(true)}>
              <Pencil size={12} /> Edit
            </button>
          )}
          <button className="voice-node-btn danger" onClick={onDelete}>
            <Trash2 size={12} /> Delete
          </button>
        </div>
      </div>

      {sections.length > 1 && (
        <>
          <button
            className="voice-node-cycle prev"
            onClick={() => go(-1)}
            aria-label="Previous section"
          >
            <ChevronLeft size={18} />
          </button>
          <button
            className="voice-node-cycle next"
            onClick={() => go(1)}
            aria-label="Next section"
          >
            <ChevronRight size={18} />
          </button>
        </>
      )}
    </>
  )
}

export default function StylismMode() {
  const styleRules = useStore((s) => s.styleRules)
  const styleConnections = useStore((s) => s.styleConnections)
  const voiceNotes = useStore((s) => s.voiceNotes)
  const voiceDocuments = useStore((s) => s.voiceDocuments)
  const apiKey = useStore((s) => s.apiKey)
  const hasApiKey = useHasApiKey()
  const {
    importStyleRules,
    editStyleRule,
    deleteStyleRule,
    setStyleRulePosition,
    appendVoiceNotes,
    addVoiceDocuments,
    removeVoiceDocument,
  } = useStore()

  const [readingDocs, setReadingDocs] = useState<ReadingDoc[]>([])
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [section, setSection] = useState(0)
  const [rightOpen, setRightOpen] = useState(true)
  const [odinLine, setOdinLine] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const nodeEls = useRef(new Map<string, HTMLDivElement>())
  const edgeEls = useRef(new Map<string, SVGLineElement>())
  const sim = useRef(new Map<string, SimNode>())
  const view = useRef({ x: 0, y: 0, k: DEFAULT_ZOOM })
  const viewReady = useRef(false)
  const rafId = useRef(0)
  const expandedRef = useRef<string | null>(null)
  expandedRef.current = expandedId

  // Always open a freshly-expanded node on its first section.
  useEffect(() => {
    setSection(0)
  }, [expandedId])

  useEffect(() => {
    if (expandedId && isOnboardingActive()) markVoiceNodeExpanded()
  }, [expandedId])

  const allDocsReady = readingDocs.length === 0 && voiceDocuments.length > 0
  const docsAutoScroll = allDocsReady && voiceDocuments.length >= 2
  const docsViewportRef = useGentleAutoScroll(docsAutoScroll)

  const notesComplete = !analyzing && voiceNotes.length > 0
  const notesAutoScroll = notesComplete && voiceNotes.length >= 2
  const notesViewportRef = useGentleAutoScroll(notesAutoScroll)
  const prevNoteCount = useRef(0)

  // While Odin is still writing notes, follow the latest one.
  useEffect(() => {
    if (notesAutoScroll) {
      prevNoteCount.current = voiceNotes.length
      return
    }
    if (voiceNotes.length <= prevNoteCount.current) {
      prevNoteCount.current = voiceNotes.length
      return
    }
    prevNoteCount.current = voiceNotes.length
    const el = notesViewportRef.current
    if (!el) return
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    })
  }, [voiceNotes.length, notesAutoScroll, notesViewportRef])

  const edges: StyleEdge[] = useMemo(
    () => computeStyleEdges(styleRules, styleConnections),
    [styleRules, styleConnections]
  )
  const edgesRef = useRef(edges)
  edgesRef.current = edges

  // Colonies: connected components arranged around the central upload node.
  const colonies = useMemo(() => {
    const ids = styleRules.map((r) => r.id)
    const comps = connectedComponents(ids, edges)
    comps.sort((a, b) => b.length - a.length)
    const compOf = new Map<string, number>()
    comps.forEach((group, i) => group.forEach((id) => compOf.set(id, i)))
    return { compOf, count: comps.length }
  }, [styleRules, edges])
  const coloniesRef = useRef(colonies)
  coloniesRef.current = colonies

  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    const v = view.current
    return {
      x: (clientX - (rect?.left ?? 0) - v.x) / v.k,
      y: (clientY - (rect?.top ?? 0) - v.y) / v.k,
    }
  }

  /* Sync sim nodes with the rule set. */
  useEffect(() => {
    const allWeights = styleRules.map((r) => r.weight)
    const live = new Set(styleRules.map((r) => r.id))
    for (const id of [...sim.current.keys()]) if (!live.has(id)) sim.current.delete(id)

    styleRules.forEach((rule, i) => {
      const targetR = nodeRadius(rule.weight, allWeights)
      const existing = sim.current.get(rule.id)
      if (existing) {
        existing.targetR = targetR
        return
      }
      const a = (i / Math.max(1, styleRules.length)) * Math.PI * 2
      const ring = 150 + Math.random() * 90
      sim.current.set(rule.id, {
        id: rule.id,
        x: rule.x ?? Math.cos(a) * ring,
        y: rule.y ?? Math.sin(a) * ring,
        vx: 0,
        vy: 0,
        r: existing ? targetR : 2,
        targetR,
        pinned: false,
      })
    })
  }, [styleRules])

  /* Physics + camera loop. World origin (0,0) holds the upload node. */
  useEffect(() => {
    const step = () => {
      const canvas = canvasRef.current
      const world = worldRef.current
      if (!canvas || !world) {
        rafId.current = requestAnimationFrame(step)
        return
      }
      const W = canvas.clientWidth
      const H = canvas.clientHeight
      if (!viewReady.current) {
        view.current = { x: W / 2, y: H / 2, k: DEFAULT_ZOOM }
        viewReady.current = true
      }
      const nodes = [...sim.current.values()]
      const { compOf, count } = coloniesRef.current

      // Use each node's *resting* radius for forces so an expanded node's
      // temporary inflation doesn't shove its neighbours across the canvas
      // (and then let them snap back when it collapses).
      const effR = (n: SimNode) => (expandedRef.current === n.id ? n.targetR : n.r)

      // Pairwise repulsion — generous separation.
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]
          const b = nodes[j]
          let dx = b.x - a.x
          let dy = b.y - a.y
          let d2 = dx * dx + dy * dy
          if (d2 < 1) {
            dx = (Math.random() - 0.5) * 2
            dy = (Math.random() - 0.5) * 2
            d2 = dx * dx + dy * dy
          }
          const d = Math.sqrt(d2)
          const minGap = effR(a) + effR(b) + 34
          let f = 26000 / d2
          if (d < minGap) f += (minGap - d) * 0.5
          f = Math.min(f, 9)
          const fx = (dx / d) * f
          const fy = (dy / d) * f
          if (!a.pinned) { a.vx -= fx; a.vy -= fy }
          if (!b.pinned) { b.vx += fx; b.vy += fy }
        }
      }

      // Edge springs pull connected principles together.
      for (const e of edgesRef.current) {
        const a = sim.current.get(e.a)
        const b = sim.current.get(e.b)
        if (!a || !b) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
        const rest = effR(a) + effR(b) + 74 - e.strength * 40
        const f = (d - rest) * 0.0045 * (0.45 + e.strength)
        const fx = (dx / d) * f
        const fy = (dy / d) * f
        if (!a.pinned) { a.vx += fx; a.vy += fy }
        if (!b.pinned) { b.vx -= fx; b.vy -= fy }
      }

      // Colony targets: spread components around the center.
      const colonyRadius = count <= 1 ? 0 : 210 + nodes.length * 6

      for (const n of nodes) {
        const frozen = n.pinned || expandedRef.current === n.id
        if (!frozen) {
          // Gentle push away from the central upload node.
          const cd = Math.sqrt(n.x * n.x + n.y * n.y) || 1
          const clear = ADD_R + n.r + 42
          if (cd < clear) {
            const push = (clear - cd) * 0.045
            n.vx += (n.x / cd) * push
            n.vy += (n.y / cd) * push
          }

          // Pull toward this colony's slot around the ring.
          const ci = compOf.get(n.id) ?? 0
          const ang = count <= 1 ? 0 : (ci / count) * Math.PI * 2
          const tx = Math.cos(ang) * colonyRadius
          const ty = Math.sin(ang) * colonyRadius
          n.vx += (tx - n.x) * 0.0016
          n.vy += (ty - n.y) * 0.0016

          n.vx *= 0.86
          n.vy *= 0.86
          n.x += n.vx
          n.y += n.vy
        } else {
          // Parked (pinned or expanded): discard any force accumulated this
          // frame so it can't discharge as a fling the instant it unfreezes.
          n.vx = 0
          n.vy = 0
        }
        const isExpanded = expandedRef.current === n.id
        const targetR = isExpanded ? EXPANDED_R : n.targetR
        n.r += (targetR - n.r) * (isExpanded ? 0.14 : 0.08)

        const el = nodeEls.current.get(n.id)
        if (el) {
          const d = n.r * 2
          el.style.transform = `translate(${n.x - n.r}px, ${n.y - n.r}px)`
          el.style.width = `${d}px`
          el.style.height = `${d}px`
          el.style.fontSize = isExpanded ? '' : `${Math.max(10, Math.min(15, n.r * 0.2))}px`
        }
      }

      const v = view.current
      world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`

      for (const e of edgesRef.current) {
        const line = edgeEls.current.get(`${e.a}|${e.b}`)
        const a = sim.current.get(e.a)
        const b = sim.current.get(e.b)
        if (!line || !a || !b) continue
        line.setAttribute('x1', String(a.x))
        line.setAttribute('y1', String(a.y))
        line.setAttribute('x2', String(b.x))
        line.setAttribute('y2', String(b.y))
      }

      rafId.current = requestAnimationFrame(step)
    }
    rafId.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(rafId.current)
  }, [])

  /* Persist positions on unmount. */
  useEffect(() => {
    return () => {
      for (const n of sim.current.values()) setStyleRulePosition(n.id, Math.round(n.x), Math.round(n.y))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* Wheel zoom. */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const v = view.current
      const k2 = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.k * Math.exp(-e.deltaY * 0.0016)))
      v.x = mx - ((mx - v.x) / v.k) * k2
      v.y = my - ((my - v.y) / v.k) * k2
      v.k = k2
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  /* Odin's murmur while it reads. */
  useEffect(() => {
    if (!analyzing) {
      if (odinLine) {
        const t = window.setTimeout(() => setOdinLine(null), 3600)
        return () => window.clearTimeout(t)
      }
      return
    }
    let i = 0
    setOdinLine(ODIN_THINKING[0])
    const id = window.setInterval(() => {
      i = (i + 1) % ODIN_THINKING.length
      setOdinLine(ODIN_THINKING[i])
    }, 2700)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyzing])

  /* ── Pan ── */
  const panState = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('.stylism-neuron') || target.closest('.voice-expand') || target.closest('.voice-upload-node'))
      return
    if (expandedRef.current) {
      setExpandedId(null)
      setEditing(false)
    }
    panState.current = { x: e.clientX, y: e.clientY, vx: view.current.x, vy: view.current.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onCanvasPointerMove = (e: React.PointerEvent) => {
    const p = panState.current
    if (!p) return
    view.current.x = p.vx + (e.clientX - p.x)
    view.current.y = p.vy + (e.clientY - p.y)
  }
  const onCanvasPointerUp = (e: React.PointerEvent) => {
    panState.current = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  }

  /* ── Node drag / click-to-expand ──
   * A quick tap opens the node; dragging only kicks in once the pointer is
   * held past HOLD_MS or moved past MOVE_PX, so a click is never mistaken for
   * a drag. A grab offset keeps the node from snapping to the cursor. */
  const HOLD_MS = 180
  const MOVE_PX = 6
  const dragState = useRef<{
    id: string
    startX: number
    startY: number
    offX: number
    offY: number
    grabbed: boolean
    moved: boolean
    holdTimer: number
  } | null>(null)
  // A left-click always emits a synthetic `click` right after `pointerup`.
  // When a tap expands a node, we must swallow that echo click so it doesn't
  // immediately re-trigger the "click empty space to collapse" handler.
  const suppressClick = useRef(false)

  const grabNode = () => {
    const d = dragState.current
    if (!d || d.grabbed) return
    const node = sim.current.get(d.id)
    if (!node) return
    d.grabbed = true
    node.pinned = true
  }

  const onNodePointerDown = (e: React.PointerEvent, id: string) => {
    if (expandedRef.current === id || e.button === 2) return
    e.preventDefault()
    e.stopPropagation()
    const node = sim.current.get(id)
    if (!node) return
    const { x, y } = toWorld(e.clientX, e.clientY)
    dragState.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      offX: node.x - x,
      offY: node.y - y,
      grabbed: false,
      moved: false,
      // Press and hold to pick the node up for dragging.
      holdTimer: window.setTimeout(grabNode, HOLD_MS),
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onNodePointerMove = (e: React.PointerEvent) => {
    const d = dragState.current
    if (!d) return
    const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY)
    // A deliberate drag also grabs the node the moment it travels far enough.
    if (!d.grabbed) {
      if (dist < MOVE_PX) return
      window.clearTimeout(d.holdTimer)
      grabNode()
    }
    if (dist >= MOVE_PX) d.moved = true
    const node = sim.current.get(d.id)
    if (!node) return
    const { x, y } = toWorld(e.clientX, e.clientY)
    node.x = x + d.offX
    node.y = y + d.offY
    node.vx = 0
    node.vy = 0
  }
  const onNodePointerUp = (e: React.PointerEvent, id: string) => {
    const d = dragState.current
    dragState.current = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    if (!d) return
    window.clearTimeout(d.holdTimer)
    const node = sim.current.get(id)
    if (node) node.pinned = false
    if (d.moved) {
      // The node was actually dragged — persist its new resting place.
      if (node) setStyleRulePosition(id, Math.round(node.x), Math.round(node.y))
      return
    }
    // A tap (or a hold that never moved) toggles the expanded card. Swallow the
    // synthetic echo click that follows, but never let the flag stick.
    suppressClick.current = true
    window.setTimeout(() => {
      suppressClick.current = false
    }, 350)
    setEditing(false)
    setExpandedId((prev) => (prev === id ? null : id))
  }

  /* ── Upload + streaming analysis ── */
  const ingestFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files)
      if (list.length === 0) return
      setError(null)
      setRightOpen(true)

      const staged: ReadingDoc[] = list.map((file) => ({
        id: `reading-${++docSeq}`,
        name: file.name,
        ext: fileExt(file.name),
      }))
      setReadingDocs((prev) => [...prev, ...staged])

      const readBatch: VoiceDocument[] = []
      const persistBatch: { name: string; ext: string; text: string }[] = []

      await Promise.all(
        staged.map(async (doc, i) => {
          try {
            const text = await readWritingFile(list[i])
            if (!text.trim()) throw new Error('No readable text found.')
            readBatch.push({ name: doc.name, text })
            persistBatch.push({ name: doc.name, ext: doc.ext, text })
            setReadingDocs((prev) => prev.filter((d) => d.id !== doc.id))
          } catch (err) {
            setReadingDocs((prev) =>
              prev.map((d) =>
                d.id === doc.id
                  ? { ...d, error: err instanceof Error ? err.message : 'Could not read file' }
                  : d
              )
            )
          }
        })
      )

      if (persistBatch.length > 0) addVoiceDocuments(persistBatch)

      if (readBatch.length === 0) return
      if (!hasApiKey) {
        setError('Add an API key in Settings to distill your voice from these documents.')
        return
      }

      const batchNames = readBatch.map((d) => d.name)
      setAnalyzing(true)
      try {
        await streamVoiceDeep({
          docs: readBatch,
          apiKey,
          existingRules: useStore.getState().styleRules,
          handlers: {
            onPrinciple: (rule) => {
              const named = (rule.docs ?? [])
                .map((n) => batchNames[n - 1])
                .filter((n): n is string => !!n)
              const sourceDocs = named.length ? [...new Set(named)] : batchNames
              importStyleRules([
                {
                  label: rule.label,
                  instruction: rule.instruction,
                  weight: relevanceToWeight(rule.relevance),
                  example: rule.example,
                  sourceDocs,
                },
              ])
            },
            onNote: (note) => appendVoiceNotes([note]),
          },
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Analysis failed')
      } finally {
        setAnalyzing(false)
        setReadingDocs([])
      }
    },
    [apiKey, hasApiKey, appendVoiceNotes, importStyleRules, addVoiceDocuments]
  )

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) void ingestFiles(e.target.files)
    e.target.value = ''
  }
  const removeDoc = (id: string) => removeVoiceDocument(id)

  const handleDelete = (id: string) => {
    deleteStyleRule(id)
    if (expandedId === id) {
      setExpandedId(null)
      setEditing(false)
    }
  }

  return (
    <div className="stylism-page">
      <div
        className="stylism-network"
        ref={canvasRef}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
      >
        <div className="stylism-world" ref={worldRef}>
          <svg className="stylism-edges">
            {edges.map((e) => (
              <line
                key={`${e.a}|${e.b}`}
                ref={(el) => {
                  if (el) edgeEls.current.set(`${e.a}|${e.b}`, el)
                  else edgeEls.current.delete(`${e.a}|${e.b}`)
                }}
                className={e.coActivations > 0 ? 'stylism-edge learned' : 'stylism-edge'}
                strokeWidth={1 + e.strength * 3.2}
              />
            ))}
          </svg>

          {/* Central upload node */}
          <button
            type="button"
            className="voice-upload-node"
            data-tour="voice-upload"
            onClick={() => fileInputRef.current?.click()}
            disabled={analyzing}
            title="Upload your proudest work (.pdf, .docx, .txt, .md)"
          >
            {analyzing ? <Loader2 size={32} className="animate-spin" /> : <Plus size={40} strokeWidth={2} />}
            <span className="voice-upload-label">{analyzing ? 'Reading…' : 'Upload work'}</span>
          </button>

          {styleRules.map((rule) => {
            const isOpen = expandedId === rule.id
            return (
              <div
                key={rule.id}
                data-tour="voice-node"
                ref={(el) => {
                  if (el) nodeEls.current.set(rule.id, el)
                  else nodeEls.current.delete(rule.id)
                }}
                className={[
                  'stylism-neuron',
                  rule.enabled ? 'enabled' : 'disabled',
                  isOpen ? 'is-expanded' : '',
                ].join(' ')}
                style={tintVars(rule.sourceDocs)}
                onPointerDown={(e) => onNodePointerDown(e, rule.id)}
                onPointerMove={onNodePointerMove}
                onPointerUp={(e) => onNodePointerUp(e, rule.id)}
                onClick={(e) => {
                  if (suppressClick.current) {
                    suppressClick.current = false
                    return
                  }
                  if (!isOpen || editing) return
                  if ((e.target as HTMLElement).closest('button, input, textarea, label')) return
                  setExpandedId(null)
                  setEditing(false)
                }}
                title={isOpen ? undefined : rule.label}
              >
                <span className="voice-neuron-ring" aria-hidden />
                {isOpen ? (
                  <VoiceNodeCard
                    rule={rule}
                    editing={editing}
                    section={section}
                    setSection={setSection}
                    setEditing={setEditing}
                    onDelete={() => handleDelete(rule.id)}
                    editStyleRule={editStyleRule}
                  />
                ) : (
                  <span className="stylism-neuron-label">{rule.label}</span>
                )}
              </div>
            )
          })}
        </div>

        {/* Odin's murmur — his talking face with a self-typing speech bubble */}
        <AnimatePresence>
          {odinLine && (
            <motion.div
              className="voice-odin"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.45, ease: 'easeOut' }}
            >
              <OdinMurmur key={odinLine} line={odinLine} />
            </motion.div>
          )}
        </AnimatePresence>

        <input ref={fileInputRef} type="file" accept={ACCEPT} multiple className="sr-only" onChange={onFileChange} />
      </div>

      {/* ── Left: uploaded documents (always visible) ── */}
      <aside className="voice-side voice-side--left voice-side--persistent">
        <div className="voice-side-head">
          <Files size={13} />
          <span>Your writing</span>
          <span className="voice-side-count">{voiceDocuments.length + readingDocs.length}</span>
        </div>
        {voiceDocuments.length === 0 && readingDocs.length === 0 ? (
          <div className="voice-side-body">
            <p className="voice-side-empty">Click the center node to add your proudest work.</p>
          </div>
        ) : (
          <div
            className={`voice-notes-viewport${docsAutoScroll ? ' is-looping' : ''}`}
            ref={docsViewportRef}
          >
            <div className="voice-notes-track">
              <AnimatePresence initial={false}>
                {readingDocs.map((doc) => (
                  <motion.article
                    key={doc.id}
                    className={`voice-doc-card voice-doc-card--reading`}
                    style={{ ['--tint']: `hsl(${docHue(doc.name)} 72% 58%)` } as CSSProperties}
                    initial={{ opacity: 0, y: 10, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.92 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 30 }}
                    layout
                  >
                    <div className="voice-doc-card__preview">
                      {doc.error ? (
                        <div className="voice-doc-card__status err">{doc.error}</div>
                      ) : (
                        <div className="voice-doc-card__status">
                          <Loader2 size={16} className="animate-spin" /> Reading…
                        </div>
                      )}
                    </div>
                    <p className="voice-doc-card__name" title={doc.name}>
                      {doc.name}
                    </p>
                  </motion.article>
                ))}
                {voiceDocuments.map((doc) => (
                  <motion.article
                    key={doc.id}
                    className="voice-doc-card voice-doc-card--ready"
                    style={{ ['--tint']: `hsl(${docHue(doc.name)} 72% 58%)` } as CSSProperties}
                    initial={{ opacity: 0, y: 10, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.92 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 30 }}
                    layout
                  >
                    <button className="voice-doc-card__remove" onClick={() => removeDoc(doc.id)} title="Remove">
                      <X size={12} />
                    </button>
                    <div className="voice-doc-card__preview">
                      <p className="voice-doc-card__excerpt">{coverExcerpt(doc.text)}</p>
                    </div>
                    <p className="voice-doc-card__name" title={doc.name}>
                      {doc.name}
                    </p>
                  </motion.article>
                ))}
              </AnimatePresence>
            </div>
          </div>
        )}
      </aside>

      {/* ── Right: the description of your voice ── */}
      {rightOpen ? (
        <aside className="voice-side voice-side--right">
          <div className="voice-side-head voice-side-head--bare">
            <button className="voice-side-collapse" onClick={() => setRightOpen(false)} title="Collapse">
              <ChevronRight size={15} />
            </button>
          </div>
          {voiceNotes.length === 0 ? (
            <div className="voice-side-body">
              <p className="voice-side-empty">
                {hasApiKey
                  ? 'Odin describes your voice here as it reads your work.'
                  : 'Add an API key in Settings, then upload work to reveal your voice.'}
              </p>
            </div>
          ) : (
            <div
              className={`voice-notes-viewport${notesAutoScroll ? ' is-looping' : ''}`}
              ref={notesViewportRef}
            >
              <div className="voice-notes-track">
                {voiceNotes.map((note, i) => (
                  <motion.p
                    key={`${i}-${note}`}
                    className="voice-note-card"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.35, ease: 'easeOut' }}
                  >
                    {note}
                  </motion.p>
                ))}
              </div>
            </div>
          )}
        </aside>
      ) : (
        <button className="voice-tab voice-tab--right" onClick={() => setRightOpen(true)} title="Show your voice">
          <ChevronLeft size={13} />
        </button>
      )}

      {error && <p className="voice-error voice-error--float">{error}</p>}
    </div>
  )
}

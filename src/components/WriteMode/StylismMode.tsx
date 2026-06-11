/**
 * Stylism — a living neural network of style rules, as its own mode.
 *
 * Each rule is a liquid-glass neuron whose size reflects its learned weight.
 * Edges combine baseline text similarity with Hebbian bonuses (rules
 * reinforced together wire together). When the writer gives stylistic feedback
 * in Write Mode chat, the referenced neurons fire and grow, and the signal
 * propagates stochastically to neighbors — mirroring Moneta's memory network.
 *
 * Rendering: DOM orbs + SVG edges in a pannable/zoomable world, positioned by
 * a custom force simulation (spring edges, pairwise repulsion, soft
 * centering). Drag the background to pan, scroll to zoom, drag neurons to
 * arrange. Positions persist. Activation effects (glow, pulse, traveling
 * signal particles) are applied imperatively inside the simulation loop.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Plus, RotateCcw, Trash2, Zap } from 'lucide-react'
import { useStore } from '../../store/useStore'
import { computeStyleEdges, type StyleEdge } from '../../lib/style'

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

interface Signal {
  fromId: string
  toId: string
  start: number
  duration: number
  el: HTMLDivElement
}

interface ViewTransform {
  x: number
  y: number
  k: number
}

const MIN_ZOOM = 0.35
const MAX_ZOOM = 2.5

/* Moneta-style proportional sizing: log scale + sigmoid, bounded. */
function nodeRadius(weight: number, allWeights: number[]): number {
  const MIN_R = 34
  const MAX_R = 78
  if (allWeights.length === 0) return MIN_R + 8
  const logs = allWeights.map((w) => Math.log(w + 1))
  const lo = Math.min(...logs)
  const hi = Math.max(...logs)
  if (hi - lo < 1e-6) return MIN_R + 8
  const rel = (Math.log(weight + 1) - lo) / (hi - lo)
  const sigmoid = 1 / (1 + Math.exp(-6 * (rel - 0.5)))
  return MIN_R + sigmoid * (MAX_R - MIN_R)
}

export default function StylismMode() {
  const styleRules = useStore((s) => s.styleRules)
  const styleConnections = useStore((s) => s.styleConnections)
  const lastStyleActivation = useStore((s) => s.lastStyleActivation)
  const {
    addStyleRule, editStyleRule, deleteStyleRule,
    setStyleRulePosition, resetStyleRules, clearStyleActivation,
  } = useStore()

  const [selectedId, setSelectedId] = useState<string | null>(null)

  const canvasRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const nodeEls = useRef(new Map<string, HTMLDivElement>())
  const edgeEls = useRef(new Map<string, SVGLineElement>())
  const sim = useRef(new Map<string, SimNode>())
  const signals = useRef<Signal[]>([])
  const view = useRef<ViewTransform>({ x: 0, y: 0, k: 1 })
  const rafId = useRef(0)
  const consumedActivationAt = useRef(0)

  const edges: StyleEdge[] = useMemo(
    () => computeStyleEdges(styleRules, styleConnections),
    [styleRules, styleConnections]
  )

  const edgesRef = useRef(edges)
  edgesRef.current = edges

  const selected = selectedId ? styleRules.find((r) => r.id === selectedId) : null

  /* Convert a client (screen) point into world coordinates. */
  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    const v = view.current
    return {
      x: ((clientX - (rect?.left ?? 0)) - v.x) / v.k,
      y: ((clientY - (rect?.top ?? 0)) - v.y) / v.k,
    }
  }

  /* ── Keep sim nodes in sync with rules ── */
  useEffect(() => {
    const canvas = canvasRef.current
    const W = canvas?.clientWidth ?? window.innerWidth
    const H = canvas?.clientHeight ?? window.innerHeight
    const allWeights = styleRules.map((r) => r.weight)

    const live = new Set(styleRules.map((r) => r.id))
    for (const id of [...sim.current.keys()]) {
      if (!live.has(id)) sim.current.delete(id)
    }

    styleRules.forEach((rule, i) => {
      const targetR = nodeRadius(rule.weight, allWeights)
      const existing = sim.current.get(rule.id)
      if (existing) {
        existing.targetR = targetR
        return
      }
      // Seed: persisted position, else a loose ring with jitter.
      const angle = (i / Math.max(1, styleRules.length)) * Math.PI * 2
      const ringR = Math.min(W, H) * 0.3
      sim.current.set(rule.id, {
        id: rule.id,
        x: rule.x ?? W / 2 + Math.cos(angle) * ringR + (Math.random() - 0.5) * 60,
        y: rule.y ?? H / 2 + Math.sin(angle) * ringR + (Math.random() - 0.5) * 60,
        vx: 0,
        vy: 0,
        r: targetR * 0.4, // newborn nodes inflate into place
        targetR,
        pinned: false,
      })
    })
  }, [styleRules])

  /* ── Force simulation + render loop ── */
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
      const nodes = [...sim.current.values()]
      const edgeList = edgesRef.current

      // Pairwise repulsion
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
          const minGap = a.r + b.r + 18
          // Soft long-range repulsion plus a firmer collision push.
          let f = 18500 / d2
          if (d < minGap) f += (minGap - d) * 0.35
          f = Math.min(f, 6)
          const fx = (dx / d) * f
          const fy = (dy / d) * f
          if (!a.pinned) { a.vx -= fx; a.vy -= fy }
          if (!b.pinned) { b.vx += fx; b.vy += fy }
        }
      }

      // Spring forces along edges (stronger connection = shorter rest length)
      for (const e of edgeList) {
        const a = sim.current.get(e.a)
        const b = sim.current.get(e.b)
        if (!a || !b) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
        const rest = a.r + b.r + 150 - e.strength * 80
        const f = (d - rest) * 0.0035 * (0.4 + e.strength)
        const fx = (dx / d) * f
        const fy = (dy / d) * f
        if (!a.pinned) { a.vx += fx; a.vy += fy }
        if (!b.pinned) { b.vx -= fx; b.vy -= fy }
      }

      // Centering + integration (world is unbounded; pan/zoom handles framing)
      for (const n of nodes) {
        if (!n.pinned) {
          n.vx += (W / 2 - n.x) * 0.0012
          n.vy += (H / 2 - n.y) * 0.0012
          n.vx *= 0.85
          n.vy *= 0.85
          n.x += n.vx
          n.y += n.vy
        }
        // Smooth radius growth
        n.r += (n.targetR - n.r) * 0.08

        const el = nodeEls.current.get(n.id)
        if (el) {
          const d = n.r * 2
          el.style.transform = `translate(${n.x - n.r}px, ${n.y - n.r}px)`
          el.style.width = `${d}px`
          el.style.height = `${d}px`
          el.style.fontSize = `${Math.max(9.5, Math.min(14, n.r * 0.21))}px`
        }
      }

      // Apply pan/zoom to the world
      const v = view.current
      world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`

      // Edge endpoints
      for (const e of edgeList) {
        const line = edgeEls.current.get(`${e.a}|${e.b}`)
        const a = sim.current.get(e.a)
        const b = sim.current.get(e.b)
        if (!line || !a || !b) continue
        line.setAttribute('x1', String(a.x))
        line.setAttribute('y1', String(a.y))
        line.setAttribute('x2', String(b.x))
        line.setAttribute('y2', String(b.y))
      }

      // Traveling signal particles
      const now = performance.now()
      signals.current = signals.current.filter((s) => {
        const a = sim.current.get(s.fromId)
        const b = sim.current.get(s.toId)
        const t = (now - s.start) / s.duration
        if (!a || !b || t >= 1) {
          s.el.remove()
          return false
        }
        if (t >= 0) {
          const ease = t * t * (3 - 2 * t)
          s.el.style.opacity = t < 0.1 ? String(t * 10) : t > 0.85 ? String((1 - t) / 0.15) : '1'
          s.el.style.transform = `translate(${a.x + (b.x - a.x) * ease - 5}px, ${a.y + (b.y - a.y) * ease - 5}px)`
        }
        return true
      })

      rafId.current = requestAnimationFrame(step)
    }

    rafId.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(rafId.current)
  }, [])

  /* ── Persist layout on unmount ── */
  useEffect(() => {
    return () => {
      for (const n of sim.current.values()) {
        setStyleRulePosition(n.id, Math.round(n.x), Math.round(n.y))
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── Zoom (wheel, toward cursor) — non-passive so we can preventDefault ── */
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

  /* ── Activation animation (fire → propagate → grow) ── */
  useEffect(() => {
    const act = lastStyleActivation
    if (!act || act.at === consumedActivationAt.current) return
    if (Date.now() - act.at > 20000) return // stale; weights already shown
    consumedActivationAt.current = act.at

    const world = worldRef.current
    if (!world) return

    const flash = (id: string, cls: string, ms: number, delay = 0) => {
      window.setTimeout(() => {
        const el = nodeEls.current.get(id)
        if (!el) return
        el.classList.add(cls)
        window.setTimeout(() => el.classList.remove(cls), ms)
      }, delay)
    }

    for (const id of act.directIds) flash(id, 'firing', 1800)
    for (const id of act.newRuleIds) flash(id, 'born', 2600)

    act.spill.forEach((sp, i) => {
      const delay = 350 + i * 160
      window.setTimeout(() => {
        const el = document.createElement('div')
        el.className = 'stylism-signal'
        world.appendChild(el)
        signals.current.push({
          fromId: sp.from,
          toId: sp.id,
          start: performance.now(),
          duration: 650,
          el,
        })
      }, delay)
      flash(sp.id, 'firing-soft', 1200, delay + 600)
    })

    const t = window.setTimeout(() => clearStyleActivation(), 4000)
    return () => window.clearTimeout(t)
  }, [lastStyleActivation, clearStyleActivation])

  /* ── Background pan ── */
  const panState = useRef<{ startX: number; startY: number; viewX: number; viewY: number } | null>(null)

  const onCanvasPointerDown = (e: React.PointerEvent) => {
    // Only pan when grabbing the background, not a neuron.
    if ((e.target as HTMLElement).closest('.stylism-neuron')) return
    panState.current = {
      startX: e.clientX,
      startY: e.clientY,
      viewX: view.current.x,
      viewY: view.current.y,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onCanvasPointerMove = (e: React.PointerEvent) => {
    const pan = panState.current
    if (!pan) return
    view.current.x = pan.viewX + (e.clientX - pan.startX)
    view.current.y = pan.viewY + (e.clientY - pan.startY)
  }

  const onCanvasPointerUp = (e: React.PointerEvent) => {
    panState.current = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  }

  /* ── Node dragging (with click detection) ── */
  const dragState = useRef<{ id: string; moved: number } | null>(null)

  const onNodePointerDown = (e: React.PointerEvent, id: string) => {
    e.preventDefault()
    e.stopPropagation()
    const node = sim.current.get(id)
    if (!node) return
    node.pinned = true
    dragState.current = { id, moved: 0 }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onNodePointerMove = (e: React.PointerEvent) => {
    const drag = dragState.current
    if (!drag) return
    const node = sim.current.get(drag.id)
    if (!node) return
    const { x, y } = toWorld(e.clientX, e.clientY)
    drag.moved += Math.abs(x - node.x) + Math.abs(y - node.y)
    node.x = x
    node.y = y
    node.vx = 0
    node.vy = 0
  }

  const onNodePointerUp = (e: React.PointerEvent, id: string) => {
    const drag = dragState.current
    dragState.current = null
    const node = sim.current.get(id)
    if (node) {
      node.pinned = false
      setStyleRulePosition(id, Math.round(node.x), Math.round(node.y))
    }
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    if (drag && drag.moved < 6) {
      setSelectedId((prev) => (prev === id ? null : id))
    }
  }

  const handleAdd = () => {
    const id = addStyleRule({
      label: 'New rule',
      instruction: '',
      source: 'user',
    })
    setSelectedId(id)
  }

  const handleDelete = (id: string) => {
    deleteStyleRule(id)
    if (selectedId === id) setSelectedId(null)
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
                strokeWidth={1 + e.strength * 3.5}
              />
            ))}
          </svg>

          {styleRules.map((rule) => (
            <div
              key={rule.id}
              ref={(el) => {
                if (el) nodeEls.current.set(rule.id, el)
                else nodeEls.current.delete(rule.id)
              }}
              className={[
                'stylism-neuron',
                rule.enabled ? 'enabled' : 'disabled',
                selectedId === rule.id ? 'selected' : '',
              ].join(' ')}
              onPointerDown={(e) => onNodePointerDown(e, rule.id)}
              onPointerMove={onNodePointerMove}
              onPointerUp={(e) => onNodePointerUp(e, rule.id)}
              title={rule.instruction || rule.label}
            >
              <span className="stylism-neuron-label">{rule.label}</span>
              {rule.useCount > 0 && (
                <span className="stylism-neuron-count">
                  <Zap size={8} />
                  {rule.useCount}
                </span>
              )}
            </div>
          ))}
        </div>

        <p className="stylism-hint">
          Drag the canvas to pan · scroll to zoom · drag neurons to arrange · click one to edit ·
          stylistic feedback in Write mode grows the network
        </p>

        <div className="stylism-fabs">
          <button className="btn-ghost text-xs flex items-center gap-1.5" onClick={resetStyleRules}>
            <RotateCcw size={12} />
            Reset
          </button>
          <button className="btn-ghost text-xs flex items-center gap-1.5" onClick={handleAdd}>
            <Plus size={12} />
            Add rule
          </button>
        </div>
      </div>

      <AnimatePresence>
        {selected && (
          <motion.aside
            key={selected.id}
            className="stylism-panel"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          >
            <div className="stylism-panel-head">
              <button
                className={`stylism-toggle ${selected.enabled ? 'on' : 'off'}`}
                onClick={() => editStyleRule(selected.id, { enabled: !selected.enabled })}
                title={selected.enabled ? 'Enabled' : 'Disabled'}
              >
                <span className="stylism-toggle-knob" />
              </button>
              <input
                className="stylism-label"
                value={selected.label}
                onChange={(e) => editStyleRule(selected.id, { label: e.target.value })}
                placeholder="Rule name"
              />
              <button
                className="stylism-delete"
                onClick={() => handleDelete(selected.id)}
                title="Delete rule"
              >
                <Trash2 size={14} />
              </button>
              <button
                className="stylism-delete"
                onClick={() => setSelectedId(null)}
                title="Close"
              >
                <X size={14} />
              </button>
            </div>
            <textarea
              className="stylism-instruction"
              value={selected.instruction}
              onChange={(e) => editStyleRule(selected.id, { instruction: e.target.value })}
              placeholder="Describe what the AI should (or shouldn't) do…"
              rows={5}
            />
            <div className="stylism-panel-stats">
              <span>weight {selected.weight.toFixed(2)}</span>
              <span>reinforced {selected.useCount}×</span>
              <span>
                {selected.source === 'ai'
                  ? 'learned from feedback'
                  : selected.source === 'user'
                  ? 'added by you'
                  : 'house default'}
              </span>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  )
}

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { motion } from 'framer-motion'
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node,
  type NodeChange,
  type Edge,
  type ReactFlowInstance,
  BackgroundVariant,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { Plus, Trash2, Sparkles, Maximize2, ChevronLeft, RefreshCw, Loader2 } from 'lucide-react'
import { nanoid } from 'nanoid'
import { useStore, type ExplorationNodeData } from '../../store/useStore'
import { streamChat, syncChat } from '../../lib/claude'
import {
  registerOnboardingCommand,
  getOnboardingTopic,
} from '../../lib/onboarding'
import { researchQuery } from '../../lib/research'
import ExplorationNode from './ExplorationNode'
import FloatingEdge from './FloatingEdge'
import { sanitizeNodesForStore } from './nodePersistence'
import {
  mergeEmbedScrollIntoNodes,
  resolveEmbedScrollTop,
  syncEmbedScrollFromNodes,
  writeEmbedScrollEntry,
} from '../../lib/embedScrollStorage'
import LiveSourceFeed from './LiveSourceFeed'
import AdventureMenu from './AdventureMenu'
import { aggregateSources, extractSourcesFromText, mergeSources, type SourceRef } from '../../lib/sources'
import { routeExploration } from '../../lib/route'
import { generateVisual, isVisualChoice, type VisualMessage } from '../../lib/visual'
import { uploadAsset } from '../../lib/cloud'

const nodeTypes = { exploration: ExplorationNode }
const edgeTypes = { floating: FloatingEdge }
const defaultEdgeOptions = { type: 'floating' }

// Approximate block footprint used for collision-free placement.
const NODE_W = 380
const NODE_H = 220
// Visual breathing room kept between neighbouring blocks.
const PLACEMENT_GAP = 26
// Fine search granularity — small steps let new blocks pack in snugly.
const PLACEMENT_GRID = 24

type XY = { x: number; y: number }

/**
 * Find an open spot for a new block near `preferred` without overlapping any
 * existing block. Existing blocks never move — we keep the newcomer as close to
 * its preferred spot as possible, nudging straight down in small steps first
 * (so siblings stack neatly), then trying adjacent columns.
 */
function findOpenSpot(preferred: XY, nodes: Node<ExplorationNodeData>[], selfId?: string): XY {
  const others = nodes
    .filter((n) => n.id !== selfId)
    .map((n) => ({
      x: n.position.x,
      y: n.position.y,
      w: (n as any).width ?? NODE_W,
      h: (n as any).height ?? NODE_H,
    }))

  const collides = (p: XY) =>
    others.some(
      (o) =>
        !(
          p.x + NODE_W + PLACEMENT_GAP <= o.x ||
          p.x >= o.x + o.w + PLACEMENT_GAP ||
          p.y + NODE_H + PLACEMENT_GAP <= o.y ||
          p.y >= o.y + o.h + PLACEMENT_GAP
        )
    )

  if (!collides(preferred)) return preferred

  const stepX = NODE_W + PLACEMENT_GAP
  // Search column-by-column, scanning downward in fine steps so the block lands
  // just below whatever it collided with rather than a full row away.
  for (let col = 0; col < 6; col++) {
    const x = preferred.x + col * stepX
    for (let dy = PLACEMENT_GRID; dy <= 2600; dy += PLACEMENT_GRID) {
      if (!collides({ x, y: preferred.y + dy })) return { x, y: preferred.y + dy }
    }
  }
  // Fallback: drop it just below everything.
  const maxBottom = others.reduce((m, o) => Math.max(m, o.y + o.h), preferred.y)
  return { x: preferred.x, y: maxBottom + PLACEMENT_GAP }
}

const FALLBACK_EXCERPT_QUESTIONS = [
  'Why does this matter?',
  'Can you give an example?',
  'How does this actually work?',
]

/** Pull a JSON string array out of a model reply, tolerant of fences/prose. */
function parseStringArray(raw: string): string[] {
  const t = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const a = t.indexOf('[')
  const b = t.lastIndexOf(']')
  if (a !== -1 && b > a) {
    try {
      const arr = JSON.parse(t.slice(a, b + 1))
      if (Array.isArray(arr)) {
        return arr.filter((x) => typeof x === 'string').map((s) => s.trim()).filter(Boolean)
      }
    } catch {
      /* fall through to line parsing */
    }
  }
  return t
    .split('\n')
    .map((l) => l.replace(/^[-*\d.)\s"]+/, '').replace(/"$/, '').trim())
    .filter(Boolean)
}

/** Ask the model for a few short follow-up questions about a highlighted excerpt. */
async function generateExcerptQuestions(
  excerpt: string,
  context: string,
  apiKey: string
): Promise<string[]> {
  if (!apiKey) return FALLBACK_EXCERPT_QUESTIONS
  try {
    const raw = await syncChat(
      [
        {
          role: 'user',
          content: `A reader highlighted this excerpt:\n"${excerpt}"\n\nFrom this passage:\n"""${context.slice(
            0,
            1500
          )}"""\n\nSuggest exactly 3 short, specific follow-up questions (about 4–8 words each) they might want to explore about the highlight. Reply ONLY as a JSON array of 3 strings.`,
        },
      ],
      'You propose concise, curious follow-up questions about a highlighted snippet. Reply with only a JSON array of strings.',
      apiKey,
      200
    )
    const qs = parseStringArray(raw).slice(0, 3)
    return qs.length ? qs : FALLBACK_EXCERPT_QUESTIONS
  } catch {
    return FALLBACK_EXCERPT_QUESTIONS
  }
}

function buildMessageChain(
  nodes: Node<ExplorationNodeData>[],
  edges: Edge[],
  startId?: string
): VisualMessage[] {
  const chain: VisualMessage[] = []
  let currentId = startId
  let depth = 0
  while (currentId && depth < 8) {
    const node = nodes.find((n) => n.id === currentId)
    if (!node) break
    if (node.data.response) {
      chain.unshift({ role: 'assistant', content: node.data.response.slice(0, 2000) })
    }
    chain.unshift({ role: 'user', content: node.data.prompt })
    const parentEdge = edges.find((e) => e.target === currentId)
    currentId = parentEdge?.source
    depth++
  }
  return chain
}

export default function ExplorationMode() {
  const {
    adventures,
    activeAdventureId,
    apiKey,
    setExplorationNodes,
    setExplorationEdges,
    updateNodeResponse,
    setAdventureThumbnail,
    getFullContext,
  } = useStore()

  const activeAdventure = adventures.find((a) => a.id === activeAdventureId)
  const savedNodes = activeAdventure?.nodes ?? []
  const savedEdges = activeAdventure?.edges ?? []
  const [nodes, setNodes, onNodesChange] = useNodesState<ExplorationNodeData>(savedNodes as any)
  const [edges, setEdges, onEdgesChange] = useEdgesState(savedEdges)
  const [prompt, setPrompt] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  const flowWrapperRef = useRef<HTMLDivElement>(null)
  const promptInputRef = useRef<HTMLInputElement>(null)
  const [rf, setRf] = useState<ReactFlowInstance | null>(null)
  const rfRef = useRef<ReactFlowInstance | null>(null)
  useEffect(() => {
    rfRef.current = rf
  }, [rf])

  // Pan (keeping zoom) so a freshly placed block sits comfortably in view.
  const focusPosition = useCallback((pos: XY) => {
    setTimeout(() => {
      const inst = rfRef.current
      if (!inst) return
      const zoom = Math.min(1, Math.max(0.6, inst.getZoom()))
      inst.setCenter(pos.x + NODE_W / 2, pos.y + NODE_H / 2, { zoom, duration: 600 })
    }, 90)
  }, [])

  // Excerpt captured from a highlight, shown above the bottom input
  const [pendingExcerpt, setPendingExcerpt] = useState<{
    sourceId: string
    text: string
    ratio: number
  } | null>(null)

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string; nodeKind?: string } | null>(null)
  // AI-suggested follow-up questions for the currently highlighted excerpt.
  const [excerptSuggestions, setExcerptSuggestions] = useState<string[]>([])
  const [suggestionsLoading, setSuggestionsLoading] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [linkPopup, setLinkPopup] = useState<{
    x: number
    y: number
    url: string
    sourceNodeId?: string
    linkText?: string
    embeddable: boolean | null  // null = checking
  } | null>(null)

  // Inject transient pending highlight into the source node (not persisted to store)
  const startFullReply = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId)
    setPendingExcerpt(null)
    setContextMenu(null)
    setTimeout(() => promptInputRef.current?.focus(), 0)
  }, [])

  const nodesWithFullReply = useMemo(() => {
    const exercised = new Set<string>()
    edges.forEach((e) => {
      if ((e as { data?: { branchType?: string } }).data?.branchType === 'full') {
        exercised.add(e.source)
      }
    })
    return exercised
  }, [edges])

  // Keep latest nodes/edges available for layout without stale closures
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const prevCountRef = useRef(0)
  /** Which adventure the local canvas belongs to — guards stale persists after switching. */
  const boardAdventureIdRef = useRef<string | null>(activeAdventureId)
  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])
  useEffect(() => {
    edgesRef.current = edges
  }, [edges])

  const nodesPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const embedScrollPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelPendingPersists = useCallback(() => {
    if (nodesPersistTimerRef.current) {
      clearTimeout(nodesPersistTimerRef.current)
      nodesPersistTimerRef.current = null
    }
    if (embedScrollPersistTimerRef.current) {
      clearTimeout(embedScrollPersistTimerRef.current)
      embedScrollPersistTimerRef.current = null
    }
  }, [])

  const resetExplorationUiState = useCallback(() => {
    setSelectedNodeId(null)
    setPendingExcerpt(null)
    setContextMenu(null)
    setPrompt('')
    setExcerptSuggestions([])
    setSuggestionsLoading(false)
    setSourcesOpen(false)
    setLinkPopup(null)
    useStore.getState().setLiveSourceContext('')
  }, [])

  const persistNodes = useCallback(
    (updated: Node<ExplorationNodeData>[]) => {
      if (!useStore.persist.hasHydrated()) return
      const boardId = boardAdventureIdRef.current
      const activeId = useStore.getState().activeAdventureId
      if (!boardId || boardId !== activeId) return
      const prevCount =
        useStore.getState().adventures.find((a) => a.id === boardId)?.nodes?.length ?? 0
      if (updated.length === 0 && prevCount > 0) return
      setExplorationNodes(sanitizeNodesForStore(updated) as any)
    },
    [setExplorationNodes]
  )

  const persistEdges = useCallback(
    (updated: Edge[]) => {
      if (!useStore.persist.hasHydrated()) return
      const boardId = boardAdventureIdRef.current
      const activeId = useStore.getState().activeAdventureId
      if (!boardId || boardId !== activeId) return
      setExplorationEdges(updated as any)
    },
    [setExplorationEdges]
  )

  const applyAdventureBoard = useCallback(
    (adventureId: string) => {
      if (!useStore.persist.hasHydrated()) return
      cancelPendingPersists()
      boardAdventureIdRef.current = adventureId

      const adventure = useStore.getState().adventures.find((a) => a.id === adventureId)
      if (!adventure) return

      const rawNodes = adventure.nodes.map((n: any) =>
        n.data?.isLoading
          ? {
              ...n,
              data: {
                ...n.data,
                isLoading: false,
                response: n.data.response || '⚠️ Loading was interrupted. Ask again to retry.',
              },
            }
          : n
      )
      const cleanNodes = mergeEmbedScrollIntoNodes(
        rawNodes as Node<ExplorationNodeData>[],
        adventureId
      )
      const cleanEdges = adventure.edges ?? []

      nodesRef.current = cleanNodes as any
      edgesRef.current = cleanEdges
      setNodes(cleanNodes as any)
      setEdges(cleanEdges)
      resetExplorationUiState()
      prevCountRef.current = cleanNodes.length
    },
    [cancelPendingPersists, resetExplorationUiState, setNodes, setEdges]
  )

  // Load the board only after persisted state has hydrated (avoids empty boot snapshot).
  const loadAdventureBoard = useCallback(() => {
    if (!useStore.persist.hasHydrated() || !activeAdventureId) return
    applyAdventureBoard(activeAdventureId)
  }, [activeAdventureId, applyAdventureBoard])

  useEffect(() => {
    if (useStore.persist.hasHydrated()) {
      loadAdventureBoard()
      return
    }
    return useStore.persist.onFinishHydration(() => {
      loadAdventureBoard()
    })
  }, [loadAdventureBoard])

  const flushEmbedScroll = useCallback(() => {
    if (!useStore.persist.hasHydrated()) return
    const boardId = boardAdventureIdRef.current
    if (!boardId || boardId !== useStore.getState().activeAdventureId) return
    syncEmbedScrollFromNodes(boardId, nodesRef.current)
    persistNodes(nodesRef.current)
  }, [persistNodes])

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushEmbedScroll()
    }
    window.addEventListener('beforeunload', flushEmbedScroll)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('beforeunload', flushEmbedScroll)
      document.removeEventListener('visibilitychange', onHide)
      if (embedScrollPersistTimerRef.current) clearTimeout(embedScrollPersistTimerRef.current)
    }
  }, [flushEmbedScroll])

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes)
      const finishedMove = changes.some(
        (c) => c.type === 'position' && 'dragging' in c && c.dragging === false
      )
      if (!finishedMove) return
      if (nodesPersistTimerRef.current) clearTimeout(nodesPersistTimerRef.current)
      nodesPersistTimerRef.current = setTimeout(() => {
        persistNodes(nodesRef.current)
      }, 0)
    },
    [onNodesChange, persistNodes]
  )

  /**
   * Once a freshly created block finishes loading and its real measured size is
   * known, nudge it out of any overlap so its text never sits on top of a block
   * it references. Only this block moves; existing blocks stay put. Uses real
   * measured dimensions (a finished answer can be far taller than the estimate).
   */
  const settleNodePosition = useCallback(
    (id: string) => {
      setNodes((prev) => {
        const me = prev.find((n) => n.id === id)
        if (!me) return prev
        const mw = (me as any).width ?? NODE_W
        const mh = (me as any).height ?? NODE_H
        const others = prev
          .filter((n) => n.id !== id)
          .map((n) => ({
            x: n.position.x,
            y: n.position.y,
            w: (n as any).width ?? NODE_W,
            h: (n as any).height ?? NODE_H,
          }))
        const collides = (p: XY) =>
          others.some(
            (o) =>
              !(
                p.x + mw + PLACEMENT_GAP <= o.x ||
                p.x >= o.x + o.w + PLACEMENT_GAP ||
                p.y + mh + PLACEMENT_GAP <= o.y ||
                p.y >= o.y + o.h + PLACEMENT_GAP
              )
          )
        if (!collides(me.position)) return prev
        const start = me.position
        const stepX = mw + PLACEMENT_GAP
        let found: XY | null = null
        for (let col = 0; col < 6 && !found; col++) {
          const x = start.x + col * stepX
          for (let dy = 0; dy <= 3200; dy += PLACEMENT_GRID) {
            if (!collides({ x, y: start.y + dy })) {
              found = { x, y: start.y + dy }
              break
            }
          }
        }
        if (!found) return prev
        const target = found
        const updated = prev.map((n) => (n.id === id ? { ...n, position: target } : n))
        persistNodes(updated)
        return updated
      })
    },
    [setNodes, persistNodes]
  )

  const updateEmbedScroll = useCallback(
    (nodeId: string, scrollTop: number, embedUrl?: string) => {
      if (activeAdventureId) writeEmbedScrollEntry(activeAdventureId, nodeId, scrollTop, embedUrl)
      setNodes((prev) => {
        const node = prev.find((n) => n.id === nodeId)
        if (!node || node.data.embedScrollTop === scrollTop) return prev
        return prev.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, embedScrollTop: scrollTop } } : n
        )
      })
      if (embedScrollPersistTimerRef.current) clearTimeout(embedScrollPersistTimerRef.current)
      embedScrollPersistTimerRef.current = setTimeout(() => {
        if (activeAdventureId) syncEmbedScrollFromNodes(activeAdventureId, nodesRef.current)
        persistNodes(nodesRef.current)
      }, 600)
    },
    [activeAdventureId, setNodes, persistNodes]
  )

  const handleEmbedExcerpt = useCallback(
    (nodeId: string, excerpt: { text: string; ratio: number }) => {
      setPendingExcerpt({ sourceId: nodeId, text: excerpt.text, ratio: excerpt.ratio })
      setSelectedNodeId(nodeId)
      setContextMenu(null)
      setTimeout(() => promptInputRef.current?.focus(), 0)
    },
    []
  )

  const flushAdventureToStore = useCallback(() => {
    const boardId = boardAdventureIdRef.current
    const activeId = useStore.getState().activeAdventureId
    if (!boardId || boardId !== activeId) return
    setExplorationNodes(sanitizeNodesForStore(nodesRef.current) as any)
    setExplorationEdges(edgesRef.current as any)
  }, [setExplorationNodes, setExplorationEdges])

  const createFreshAdventure = useCallback(() => {
    flushAdventureToStore()
    const newId = useStore.getState().createAdventure()
    applyAdventureBoard(newId)
    setTimeout(() => {
      rfRef.current?.zoomTo(0.55, { duration: 600 })
    }, 60)
    return newId
  }, [flushAdventureToStore, applyAdventureBoard])

  const handleLinkClick = useCallback(
    (sourceNodeId: string, url: string, x: number, y: number, linkText?: string) => {
      setLinkPopup({ x, y, url, sourceNodeId, linkText, embeddable: null })
      setContextMenu(null)
      // Check embeddability in the background
      fetch(`/api/can-embed?url=${encodeURIComponent(url)}`)
        .then((r) => r.json())
        .then((data: { embeddable: boolean }) => {
          setLinkPopup((prev) =>
            prev && prev.url === url ? { ...prev, embeddable: data.embeddable } : prev
          )
        })
        .catch(() => {
          setLinkPopup((prev) =>
            prev && prev.url === url ? { ...prev, embeddable: true } : prev
          )
        })
    },
    []
  )

  const createEmbedNode = useCallback(
    (url: string, sourceNodeId?: string, linkText?: string) => {
      const id = nanoid()
      const sourceNode = sourceNodeId ? nodesRef.current.find((n) => n.id === sourceNodeId) : null
      const pw = (sourceNode as any)?.width ?? 420

      const preferred = sourceNode
        ? { x: sourceNode.position.x + pw + 56, y: sourceNode.position.y }
        : rf
        ? rf.project({ x: window.innerWidth / 2 - 280, y: window.innerHeight / 2 - 240 })
        : { x: 200 + Math.random() * 160, y: 200 + nodesRef.current.length * 80 }
      const pos = findOpenSpot(preferred, nodesRef.current, id)
      focusPosition(pos)

      const newNode: Node<ExplorationNodeData> = {
        id,
        type: 'exploration',
        position: pos,
        data: {
          prompt: url,
          response: '',
          nodeKind: 'embed',
          embedUrl: url,
          connectionCount: 0,
        },
      }

      // Compute a rough ratio from where the link text appears in the source response
      const highlightId = nanoid()
      const sourceResponse = sourceNode?.data.response ?? ''
      const ratio = linkText && sourceResponse
        ? Math.max(0.1, Math.min(0.9, sourceResponse.indexOf(linkText) / Math.max(sourceResponse.length, 1)))
        : 0.5

      setNodes((prev) => {
        let updated = [...prev, newNode]
        if (sourceNodeId && linkText) {
          updated = updated.map((n) =>
            n.id === sourceNodeId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    highlights: [
                      ...(n.data.highlights ?? []),
                      { id: highlightId, text: linkText, ratio, childId: id },
                    ],
                  },
                }
              : n
          )
        }
        persistNodes(updated)
        return updated
      })

      if (sourceNodeId) {
        const edge = {
          id: `e-${sourceNodeId}-${id}`,
          source: sourceNodeId,
          target: id,
          type: 'floating',
          data: linkText
            ? { branchType: 'excerpt' as const }
            : { branchType: 'full' as const },
        }
        setEdges((prev) => {
          const updatedEdges = addEdge(edge, prev)
          setExplorationEdges(updatedEdges as any)
          const counts: Record<string, number> = {}
          updatedEdges.forEach((e) => {
            counts[e.source] = (counts[e.source] || 0) + 1
            counts[e.target] = (counts[e.target] || 0) + 1
          })
          setNodes((prevNodes) => {
            const updated = prevNodes.map((n) => ({
              ...n,
              data: { ...n.data, connectionCount: counts[n.id] || 0 },
            }))
            persistNodes(updated)
            return updated
          })
          return updatedEdges
        })
      }

      setLinkPopup(null)
    },
    [rf, setNodes, setEdges, setExplorationEdges, persistNodes, focusPosition]
  )

  // Amplify trackpad pinch-to-zoom (~3× more sensitive than React Flow's default).
  // We intercept wheel events where ctrlKey is true (trackpad pinch) in the capture
  // phase before React Flow's d3-zoom handler, apply a higher multiplier, then
  // stop propagation so d3-zoom doesn't double-count the event.
  useEffect(() => {
    const wrapper = flowWrapperRef.current
    if (!wrapper || !rf) return

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      const currentZoom = rf.getZoom()
      // d3-zoom default sensitivity ≈ 0.002; we use 0.006 for ~3× amplification
      const factor = Math.pow(2, -e.deltaY * 0.006)
      rf.zoomTo(Math.min(4, Math.max(0.1, currentZoom * factor)), { duration: 0 })
    }

    wrapper.addEventListener('wheel', handleWheel, { passive: false, capture: true })
    return () => wrapper.removeEventListener('wheel', handleWheel, { capture: true })
  }, [rf])

  // Debounced board screenshot — fires 2 s after the last node/edge change
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const captureBoard = useCallback(() => {
    if (captureTimerRef.current) clearTimeout(captureTimerRef.current)
    captureTimerRef.current = setTimeout(async () => {
      if (!flowWrapperRef.current || !activeAdventureId) return
      // Only capture if there are nodes with responses
      if (!nodesRef.current.some((n) => n.data.response)) return
      try {
        const el = flowWrapperRef.current.querySelector('.react-flow__viewport') as HTMLElement | null
        if (!el) return
        const { default: html2canvas } = await import('html2canvas')
        const canvas = await html2canvas(el, {
          scale: 0.45,
          useCORS: true,
          allowTaint: true,
          backgroundColor: 'rgb(215,215,215)',
          logging: false,
        })
        const dataUrl = canvas.toDataURL('image/jpeg', 0.72)
        const url = await uploadAsset(dataUrl, 'adventure-thumb')
        setAdventureThumbnail(activeAdventureId, url)
      } catch {
        // Non-critical — silently skip
      }
    }, 2000)
  }, [activeAdventureId, setAdventureThumbnail])

  // Auto-name a still-default adventure ("Adventure N") by its topic once it
  // has real content — so it reads meaningfully in the Context House picker.
  const labelingRef = useRef(false)
  const maybeLabelAdventure = useCallback(async () => {
    if (!apiKey || labelingRef.current) return
    const s = useStore.getState()
    const advId = s.activeAdventureId
    const adv = s.adventures.find((a) => a.id === advId)
    if (!adv || !advId) return
    if (!/^adventure\s*\d+$/i.test(adv.name.trim())) return // already custom-named
    const answered = adv.nodes.filter((n) => n.data.response)
    if (answered.length === 0) return
    labelingRef.current = true
    try {
      const basis = answered
        .slice(0, 3)
        .map((n) => `Q: ${n.data.prompt}\nA: ${(n.data.response || '').slice(0, 280)}`)
        .join('\n\n')
      const raw = await syncChat(
        [
          {
            role: 'user',
            content: `Give a short 2-4 word topic title (Title Case, no quotes, no trailing punctuation) for this exploration board:\n\n${basis}`,
          },
        ],
        'You name exploration boards by their topic. Reply with only the title, nothing else.',
        apiKey,
        24
      ).catch(() => '')
      const clean = raw
        .trim()
        .replace(/^["'`]|["'`]$/g, '')
        .split('\n')[0]
        .slice(0, 40)
        .trim()
      // Re-check the name didn't change underneath us before committing.
      const current = useStore.getState().adventures.find((a) => a.id === advId)
      if (clean && current && /^adventure\s*\d+$/i.test(current.name.trim())) {
        useStore.getState().renameAdventure(advId, clean)
      }
    } finally {
      labelingRef.current = false
    }
  }, [apiKey])

  const removeNodesById = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return
      const idSet = new Set(ids)

      const newEdges = edgesRef.current.filter((e) => !idSet.has(e.source) && !idSet.has(e.target))
      const counts: Record<string, number> = {}
      newEdges.forEach((e) => {
        counts[e.source] = (counts[e.source] || 0) + 1
        counts[e.target] = (counts[e.target] || 0) + 1
      })

      const newNodes = nodesRef.current
        .filter((n) => !idSet.has(n.id))
        .map((n) => ({
          ...n,
          data: {
            ...n.data,
            connectionCount: counts[n.id] || 0,
            highlights: (n.data.highlights ?? []).filter((h) => !idSet.has(h.childId)),
          },
        }))

      setNodes(newNodes)
      setEdges(newEdges)
      setExplorationNodes(sanitizeNodesForStore(newNodes) as any)
      setExplorationEdges(newEdges as any)

      if (selectedNodeId && idSet.has(selectedNodeId)) setSelectedNodeId(null)
      if (pendingExcerpt && idSet.has(pendingExcerpt.sourceId)) setPendingExcerpt(null)
      setContextMenu(null)
    },
    [
      setNodes,
      setEdges,
      setExplorationNodes,
      setExplorationEdges,
      selectedNodeId,
      pendingExcerpt,
    ]
  )

  const onNodesDelete = useCallback(
    (deleted: Node<ExplorationNodeData>[]) => {
      const idSet = new Set(deleted.map((n) => n.id))
      setEdges((prev) => {
        const newEdges = prev.filter((e) => !idSet.has(e.source) && !idSet.has(e.target))
        setExplorationEdges(newEdges as any)

        const counts: Record<string, number> = {}
        newEdges.forEach((e) => {
          counts[e.source] = (counts[e.source] || 0) + 1
          counts[e.target] = (counts[e.target] || 0) + 1
        })

        setNodes((prevNodes) => {
          const updated = prevNodes.map((n) => ({
            ...n,
            data: {
              ...n.data,
              connectionCount: counts[n.id] || 0,
              highlights: (n.data.highlights ?? []).filter((h) => !idSet.has(h.childId)),
            },
          }))
          persistNodes(updated)
          return updated
        })
        return newEdges
      })

      if (selectedNodeId && idSet.has(selectedNodeId)) setSelectedNodeId(null)
      if (pendingExcerpt && idSet.has(pendingExcerpt.sourceId)) setPendingExcerpt(null)
      setContextMenu(null)
    },
    [setEdges, setExplorationEdges, setNodes, persistNodes, selectedNodeId, pendingExcerpt]
  )

  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node<ExplorationNodeData>) => {
      e.preventDefault()
      setContextMenu({ x: e.clientX, y: e.clientY, nodeId: node.id, nodeKind: node.data.nodeKind })
    },
    []
  )

  // Forward handle to runVisualGeneration (declared later) so retryNode can call
  // it without a declaration-order TDZ in its dependency array.
  const runVisualGenerationRef = useRef<
    (
      id: string,
      req: { query: string; parentId?: string; excerpt?: string; method?: 'search' | 'generate' }
    ) => Promise<void>
  >()

  // Re-run the generation pipeline for an existing node in-place.
  const retryNode = useCallback(
    async (nodeId: string) => {
      const node = nodesRef.current.find((n) => n.id === nodeId)
      if (!node) return
      const { prompt: userPrompt } = node.data
      if (!userPrompt.trim()) return

      const parentEdge = edgesRef.current.find((e) => e.target === nodeId)
      const parentId = parentEdge?.source
      const parentNode = parentId ? nodesRef.current.find((n) => n.id === parentId) ?? null : null

      // Reset the node to a clean loading state
      setNodes((prev) => {
        const updated = prev.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                data: {
                  ...n.data,
                  response: '',
                  isLoading: true,
                  visual: undefined,
                  visualStatus: undefined,
                  visualChoice: undefined,
                  nodeKind: 'text' as const,
                  sources: [],
                },
              }
            : n
        )
        persistNodes(updated)
        return updated
      })

      if (!apiKey) {
        setNodes((prev) => {
          const updated = prev.map((n) =>
            n.id === nodeId ? { ...n, data: { ...n.data, response: '⚠️ No API key set.', isLoading: false } } : n
          )
          persistNodes(updated)
          return updated
        })
        return
      }

      const decision = await routeExploration({
        prompt: userPrompt,
        apiKey,
        context: getFullContext(),
        messageChain: buildMessageChain(nodesRef.current, edgesRef.current, parentId),
      })

      if (decision.action === 'generate' || decision.action === 'search') {
        await runVisualGenerationRef.current?.(nodeId, { query: decision.query, parentId, method: decision.action })
        return
      }

      if (decision.action === 'choose') {
        setNodes((prev) => {
          const updated = prev.map((n) =>
            n.id === nodeId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    nodeKind: 'visual' as const,
                    isLoading: false,
                    visualStatus: undefined,
                    visualChoice: {},
                    visualRequest: { query: decision.query, parentId },
                  },
                }
              : n
          )
          persistNodes(updated)
          return updated
        })
        return
      }

      // Text answer: research → stream
      let researchSources: SourceRef[] = []
      let researchContext = ''
      try {
        const research = await researchQuery(userPrompt)
        researchSources = research.sources
        researchContext = research.context
        setNodes((prev) => {
          const updated = prev.map((n) =>
            n.id === nodeId
              ? { ...n, data: { ...n.data, sources: mergeSources(researchSources, extractSourcesFromText(userPrompt)) } }
              : n
          )
          persistNodes(updated)
          return updated
        })
      } catch {
        researchSources = extractSourcesFromText(userPrompt)
      }

      const context = getFullContext()
      const system = `You are a research and writing assistant. Be thoughtful, analytical, and intellectually stimulating.
Give substantive responses that help the writer explore ideas deeply.

You MUST ground your answer in credible sources. Use the web research results below when provided.
Cite every external claim with a markdown link, e.g. [Article title](https://example.com).
Prefer sources from the research results; do not invent URLs.
When you can choose between equally good sources, link to ones that embed cleanly in an iframe (e.g. Wikipedia, official documentation, .gov/.edu pages, YouTube, arXiv, archive.org) and avoid sites that block embedding (e.g. Investopedia, Britannica, NYTimes, Bloomberg, WSJ, Reddit, Medium, Quora, X/Twitter, LinkedIn). The research results below are already ordered with embeddable sources first — favour the earlier ones.
If the user asks to see what something looks like, note that they can ask for a visual/image and the app will generate one — do not claim you cannot show images.
NEVER tell the user to "use the app's image generator" or paste a prompt elsewhere — if they want a sketch, diagram, or image, they should ask directly and the system handles it automatically.

${researchContext ? `=== WEB RESEARCH RESULTS ===\n${researchContext}\n` : 'No web research results were returned — rely on your knowledge and any background context, and cite well-known references where possible.'}
${context ? `\n=== BACKGROUND CONTEXT ===\n${context.slice(0, 3000)}` : ''}`

      const messages: { role: 'user' | 'assistant'; content: string }[] = []
      if (parentNode) {
        messages.push({ role: 'user', content: parentNode.data.prompt })
        if (parentNode.data.response) {
          messages.push({ role: 'assistant', content: parentNode.data.response })
        }
      }
      messages.push({ role: 'user', content: userPrompt })

      let retryResponse = ''
      await streamChat(
        messages,
        system,
        apiKey,
        (chunk) => {
          retryResponse += chunk
          setNodes((prev) =>
            prev.map((n) =>
              n.id === nodeId ? { ...n, data: { ...n.data, response: retryResponse, isLoading: true } } : n
            )
          )
        },
        () => {
          setNodes((prev) => {
            const updated = prev.map((n) => {
              if (n.id !== nodeId) return n
              const cited = extractSourcesFromText(retryResponse)
              return {
                ...n,
                data: {
                  ...n.data,
                  response: retryResponse,
                  isLoading: false,
                  sources: mergeSources(n.data.sources ?? researchSources, cited),
                },
              }
            })
            persistNodes(updated)
            return updated
          })
          captureBoard()
          void maybeLabelAdventure()
        },
        (errMessage) => {
          setNodes((prev) => {
            const updated = prev.map((n) =>
              n.id === nodeId
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      response: retryResponse || `⚠️ ${errMessage}. Please try again.`,
                      isLoading: false,
                    },
                  }
                : n
            )
            persistNodes(updated)
            return updated
          })
        }
      )
    },
    [apiKey, setNodes, persistNodes, getFullContext, captureBoard]
  )

  const onConnect = useCallback(
    (params: Connection) => {
      const updated = addEdge({ ...params, type: 'floating' }, edges)
      setEdges(updated)
      setExplorationEdges(updated as any)

      // Update connection counts
      const connectionCounts: Record<string, number> = {}
      updated.forEach((e) => {
        connectionCounts[e.source] = (connectionCounts[e.source] || 0) + 1
        connectionCounts[e.target] = (connectionCounts[e.target] || 0) + 1
      })
      setNodes((prev) => {
        const updated = prev.map((n) => ({
          ...n,
          data: { ...n.data, connectionCount: connectionCounts[n.id] || 0 },
        }))
        persistNodes(updated)
        return updated
      })
    },
    [edges, setEdges, setExplorationEdges, setNodes, persistNodes]
  )

  // Run (or re-run) visual generation for an existing node. Handles the slow
  // AI-generation path, the fast web-search path, and the ambiguous "needs choice" case.
  const runVisualGeneration = useCallback(
    async (
      id: string,
      req: { query: string; parentId?: string; excerpt?: string; method?: 'search' | 'generate' }
    ) => {
      if (!apiKey) return
      const parentNode = req.parentId ? nodesRef.current.find((n) => n.id === req.parentId) : null
      const status =
        req.method === 'search'
          ? 'Finding the best image…'
          : req.method === 'generate'
          ? 'Generating adapted visual…'
          : 'Preparing visual…'

      setNodes((prev) => {
        const updated = prev.map((n) =>
          n.id === id
            ? {
                ...n,
                data: {
                  ...n.data,
                  nodeKind: 'visual' as const,
                  isLoading: true,
                  visualStatus: status,
                  visualChoice: undefined,
                  visualRequest: { query: req.query, parentId: req.parentId, excerpt: req.excerpt },
                },
              }
            : n
        )
        persistNodes(updated)
        return updated
      })

      try {
        const result = await generateVisual({
          query: req.query,
          apiKey,
          context: getFullContext(),
          parentPrompt: parentNode?.data.prompt,
          parentResponse: parentNode?.data.response,
          excerpt: req.excerpt,
          messageChain: buildMessageChain(nodesRef.current, edgesRef.current, req.parentId),
          method: req.method,
        })

        if (isVisualChoice(result)) {
          setNodes((prev) => {
            const updated = prev.map((n) =>
              n.id === id
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      isLoading: false,
                      visualStatus: undefined,
                      visualChoice: { suggestion: result.suggestion },
                    },
                  }
                : n
            )
            persistNodes(updated)
            return updated
          })
          return
        }

        // Move the generated image off the local blob into Supabase Storage,
        // keeping only its URL in state (falls back to the data URL on failure).
        const storedVisual = result.imageDataUrl?.startsWith('data:')
          ? { ...result, imageDataUrl: await uploadAsset(result.imageDataUrl, 'visual') }
          : result

        setNodes((prev) => {
          const updated = prev.map((n) => {
            if (n.id !== id) return n
            const refSources: SourceRef[] = result.referenceUrl
              ? [
                  {
                    id: result.referenceUrl,
                    title: result.referenceTitle || 'Reference',
                    url: result.referenceUrl,
                  },
                ]
              : []
            return {
              ...n,
              data: {
                ...n.data,
                visual: storedVisual,
                response: result.caption,
                isLoading: false,
                visualStatus: undefined,
                visualChoice: undefined,
                sources: mergeSources(n.data.sources ?? [], refSources),
              },
            }
          })
          persistNodes(updated)
          return updated
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Visual generation failed'
        setNodes((prev) => {
          const updated = prev.map((n) =>
            n.id === id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    response: `⚠️ ${message}. Try rephrasing your visual request.`,
                    isLoading: false,
                    visualStatus: undefined,
                    visualChoice: undefined,
                  },
                }
              : n
          )
          persistNodes(updated)
          return updated
        })
      }
    },
    [apiKey, setNodes, persistNodes, getFullContext]
  )
  runVisualGenerationRef.current = runVisualGeneration

  const resolveVisualChoice = useCallback(
    (nodeId: string, method: 'search' | 'generate') => {
      const node = nodesRef.current.find((n) => n.id === nodeId)
      const req = node?.data.visualRequest
      if (!req) return
      runVisualGeneration(nodeId, { ...req, method })
    },
    [runVisualGeneration]
  )

  const flowNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          embedScrollTop:
            n.data.nodeKind === 'embed' && activeAdventureId
              ? resolveEmbedScrollTop(
                  activeAdventureId,
                  n.id,
                  n.data.embedUrl,
                  n.data.embedScrollTop
                )
              : n.data.embedScrollTop,
          pendingHighlight:
            pendingExcerpt?.sourceId === n.id ? pendingExcerpt.text : undefined,
          onReplyFull: nodesWithFullReply.has(n.id)
            ? undefined
            : () => startFullReply(n.id),
          isReplyTarget: selectedNodeId === n.id && !pendingExcerpt,
          onVisualChoice: n.data.visualChoice
            ? (method: 'search' | 'generate') => resolveVisualChoice(n.id, method)
            : undefined,
          onLinkClick: (url: string, x: number, y: number, linkText?: string) =>
            handleLinkClick(n.id, url, x, y, linkText),
          onEmbedScrollChange:
            n.data.nodeKind === 'embed'
              ? (scrollTop: number) => updateEmbedScroll(n.id, scrollTop, n.data.embedUrl)
              : undefined,
          onEmbedExcerpt:
            n.data.nodeKind === 'embed'
              ? (excerpt: { text: string; ratio: number }) => handleEmbedExcerpt(n.id, excerpt)
              : undefined,
        },
      })),
    [
      nodes,
      activeAdventureId,
      pendingExcerpt,
      startFullReply,
      selectedNodeId,
      nodesWithFullReply,
      resolveVisualChoice,
      handleLinkClick,
      updateEmbedScroll,
      handleEmbedExcerpt,
    ]
  )

  const createNode = useCallback(
    async (
      userPrompt: string,
      parentId?: string,
      opts?: {
        excerpt?: string
        position?: { x: number; y: number }
        highlight?: { id: string; text: string; ratio: number }
      }
    ) => {
      if (!userPrompt.trim()) return
      const adventureIdAtStart = boardAdventureIdRef.current
      if (!adventureIdAtStart) return
      const isStaleBoard = () => boardAdventureIdRef.current !== adventureIdAtStart

      const id = nanoid()
      const parentNode = parentId ? nodes.find((n) => n.id === parentId) : null
      const pw = (parentNode as any)?.width ?? 420
      const ph = (parentNode as any)?.height ?? 220
      const isFullReply = Boolean(parentNode && !opts?.highlight)
      const defaultPos = parentNode
        ? isFullReply
          ? { x: parentNode.position.x, y: parentNode.position.y + ph + 28 }
          : { x: parentNode.position.x + pw + 56, y: parentNode.position.y }
        : { x: 100 + Math.random() * 160, y: 100 + nodes.length * 120 }
      const pos = findOpenSpot(opts?.position ?? defaultPos, nodes, id)
      focusPosition(pos)

      const newNode: Node<ExplorationNodeData> = {
        id,
        type: 'exploration',
        position: pos,
        data: {
          prompt: userPrompt,
          response: '',
          isLoading: true,
          connectionCount: 0,
          nodeKind: 'text',
        },
      }

      setNodes((prev) => {
        if (isStaleBoard()) return prev
        let updated: Node<ExplorationNodeData>[] = [...prev, newNode]
        // Record the highlight on the parent so the marker + region handle persist
        if (parentId && opts?.highlight) {
          updated = updated.map((n) =>
            n.id === parentId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    highlights: [...(n.data.highlights ?? []), { ...opts.highlight!, childId: id }],
                  },
                }
              : n
          )
        }
        persistNodes(updated)
        return updated
      })

      if (parentId) {
        const edge = {
          id: `e-${parentId}-${id}`,
          source: parentId,
          target: id,
          type: 'floating',
          data: opts?.highlight ? { branchType: 'excerpt' as const } : { branchType: 'full' as const },
        }
        setEdges((prev) => {
          if (isStaleBoard()) return prev
          const updatedEdges = addEdge(edge, prev)
          persistEdges(updatedEdges as any)
          // Recompute connection counts so importance updates automatically
          const counts: Record<string, number> = {}
          updatedEdges.forEach((e) => {
            counts[e.source] = (counts[e.source] || 0) + 1
            counts[e.target] = (counts[e.target] || 0) + 1
          })
          setNodes((prevNodes) => {
            if (isStaleBoard()) return prevNodes
            const updated = prevNodes.map((n) => ({
              ...n,
              data: { ...n.data, connectionCount: counts[n.id] || 0 },
            }))
            persistNodes(updated)
            return updated
          })
          return updatedEdges
        })
      }

      setPrompt('')

      // Stream response from Claude
      if (!apiKey) {
        updateNodeResponse(id, '⚠️ No API key set. Go to Settings to add your Anthropic key.', false)
        setNodes((prev) => {
          const updated = prev.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, response: '⚠️ No API key set.', isLoading: false } } : n
          )
          persistNodes(updated)
          return updated
        })
        return
      }

      // Let the model decide — via tool-calling — how to handle this request:
      // a written answer, a custom generated image, a real web image, or asking the user.
      const decision = await routeExploration({
        prompt: userPrompt,
        apiKey,
        context: getFullContext(),
        excerpt: opts?.excerpt,
        messageChain: buildMessageChain(nodesRef.current, edgesRef.current, parentId),
      })
      if (isStaleBoard()) return

      if (decision.action === 'generate' || decision.action === 'search') {
        await runVisualGeneration(id, {
          query: decision.query,
          parentId,
          excerpt: opts?.excerpt,
          method: decision.action,
        })
        return
      }

      if (decision.action === 'choose') {
        setNodes((prev) => {
          const updated = prev.map((n) =>
            n.id === id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    nodeKind: 'visual' as const,
                    isLoading: false,
                    visualStatus: undefined,
                    visualChoice: {},
                    visualRequest: { query: decision.query, parentId, excerpt: opts?.excerpt },
                  },
                }
              : n
          )
          persistNodes(updated)
          return updated
        })
        return
      }

      // --- Text answer: research the web, then stream a grounded response ---
      let researchSources: SourceRef[] = []
      let researchContext = ''
      try {
        const research = await researchQuery(userPrompt)
        researchSources = research.sources
        researchContext = research.context
        setNodes((prev) => {
          const updated = prev.map((n) =>
            n.id === id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    sources: mergeSources(researchSources, extractSourcesFromText(userPrompt)),
                  },
                }
              : n
          )
          persistNodes(updated)
          return updated
        })
      } catch {
        // Continue with generation even if research fails
        researchSources = extractSourcesFromText(userPrompt)
        if (researchSources.length) {
          setNodes((prev) => {
            const updated = prev.map((n) =>
              n.id === id ? { ...n, data: { ...n.data, sources: researchSources } } : n
            )
            persistNodes(updated)
            return updated
          })
        }
      }

      const context = getFullContext()

      const system = `You are a research and writing assistant. Be thoughtful, analytical, and intellectually stimulating.
Give substantive responses that help the writer explore ideas deeply.

You MUST ground your answer in credible sources. Use the web research results below when provided.
Cite every external claim with a markdown link, e.g. [Article title](https://example.com).
Prefer sources from the research results; do not invent URLs.
When you can choose between equally good sources, link to ones that embed cleanly in an iframe (e.g. Wikipedia, official documentation, .gov/.edu pages, YouTube, arXiv, archive.org) and avoid sites that block embedding (e.g. Investopedia, Britannica, NYTimes, Bloomberg, WSJ, Reddit, Medium, Quora, X/Twitter, LinkedIn). The research results below are already ordered with embeddable sources first — favour the earlier ones.
If the user asks to see what something looks like, note that they can ask for a visual/image and the app will generate one — do not claim you cannot show images.
NEVER tell the user to "use the app's image generator" or paste a prompt elsewhere — if they want a sketch, diagram, or image, they should ask directly and the system handles it automatically.

${researchContext ? `=== WEB RESEARCH RESULTS ===\n${researchContext}\n` : 'No web research results were returned — rely on your knowledge and any background context, and cite well-known references where possible.'}
${context ? `\n=== BACKGROUND CONTEXT ===\n${context.slice(0, 3000)}` : ''}`

      // Build message chain from connected nodes
      const messages: { role: 'user' | 'assistant'; content: string }[] = []
      if (parentNode) {
        messages.push({ role: 'user', content: parentNode.data.prompt })
        if (parentNode.data.response) {
          messages.push({ role: 'assistant', content: parentNode.data.response })
        }
      }
      const finalContent = opts?.excerpt
        ? parentNode?.data.nodeKind === 'embed'
          ? `Regarding this excerpt from the embedded article${parentNode.data.embedUrl ? ` (${parentNode.data.embedUrl})` : ''}:\n"${opts.excerpt}"\n\n${userPrompt}`
          : `Regarding this excerpt from your previous response:\n"${opts.excerpt}"\n\n${userPrompt}`
        : userPrompt
      messages.push({ role: 'user', content: finalContent })

      let response = ''
      await streamChat(
        messages,
        system,
        apiKey,
        (chunk) => {
          if (isStaleBoard()) return
          response += chunk
          setNodes((prev) =>
            prev.map((n) =>
              n.id === id ? { ...n, data: { ...n.data, response, isLoading: true } } : n
            )
          )
        },
        () => {
          if (isStaleBoard()) return
          setNodes((prev) => {
            const updated = prev.map((n) => {
              if (n.id !== id) return n
              const cited = extractSourcesFromText(response)
              return {
                ...n,
                data: {
                  ...n.data,
                  response,
                  isLoading: false,
                  sources: mergeSources(n.data.sources ?? researchSources, cited),
                },
              }
            })
            persistNodes(updated)
            return updated
          })
          // Re-resolve placement now that the finished block's true height is
          // known, so it doesn't end up overlapping a block it references.
          ;[160, 520].forEach((d) => setTimeout(() => settleNodePosition(id), d))
          captureBoard()
          void maybeLabelAdventure()
        },
        (errMessage) => {
          setNodes((prev) => {
            const updated = prev.map((n) =>
              n.id === id
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      response: response || `⚠️ ${errMessage}. Please try again.`,
                      isLoading: false,
                    },
                  }
                : n
            )
            persistNodes(updated)
            return updated
          })
        }
      )
    },
    [
      nodes,
      apiKey,
      setNodes,
      setEdges,
      persistEdges,
      persistNodes,
      updateNodeResponse,
      getFullContext,
      runVisualGeneration,
      focusPosition,
      settleNodePosition,
    ]
  )

  // Keep a live ref so onboarding commands always call the latest createNode.
  const createNodeRef = useRef(createNode)
  useEffect(() => {
    createNodeRef.current = createNode
  }, [createNode])

  /* ── Onboarding helper: type a prompt, then run the real flow ── */

  // Type a known prompt into the input character-by-character, then run `done`.
  const typeIntoPrompt = useCallback((text: string, done?: () => void) => {
    setSelectedNodeId(null)
    setPendingExcerpt(null)
    promptInputRef.current?.focus()
    let i = 0
    const tick = () => {
      i++
      setPrompt(text.slice(0, i))
      if (i < text.length) {
        setTimeout(tick, 30)
      } else {
        setTimeout(() => {
          setPrompt('')
          done?.()
        }, 420)
      }
    }
    setTimeout(tick, 250)
  }, [])

  // Register imperative onboarding commands the coach can fire into this mode.
  // These drive the *real* app: Odin types a prompt, then the normal live flow
  // runs (real AI answer, real links, real image generation).
  useEffect(() => {
    const unNew = registerOnboardingCommand('newAdventure', () => {
      createFreshAdventure()
    })
    const unAdventure = registerOnboardingCommand('startAdventure', (topic) => {
      const t =
        (typeof topic === 'string' && topic.trim()) ||
        getOnboardingTopic() ||
        'a fascinating topic'
      typeIntoPrompt(
        `Give me an engaging overview of ${t} and why it's such a fascinating field to explore.`,
        () => {
          void createNodeRef.current(
            `Give me an engaging overview of ${t} and why it's such a fascinating field to explore.`
          )
        }
      )
    })
    const unAsk = registerOnboardingCommand('askResearchQuestion', (question) => {
      const q = (typeof question === 'string' && question.trim()) || ''
      if (!q) return
      typeIntoPrompt(q, () => {
        void createNodeRef.current(q)
      })
    })
    const unImg = registerOnboardingCommand('generateImage', () => {
      const t = getOnboardingTopic() || 'this topic'
      typeIntoPrompt(`Create an illustration that captures the essence of ${t}.`, () => {
        void createNodeRef.current(`Create an illustration that captures the essence of ${t}.`)
      })
    })
    const unZoom = registerOnboardingCommand('zoomOutExploration', () => {
      setTimeout(() => {
        if (!rf) return
        if (nodesRef.current.length > 0) rf.fitView({ padding: 0.6, duration: 600 })
        else rf.zoomTo(0.55, { duration: 600 })
      }, 60)
    })
    return () => {
      unNew()
      unAdventure()
      unAsk()
      unImg()
      unZoom()
    }
  }, [rf, typeIntoPrompt, createFreshAdventure])

  // Generate follow-up question pills whenever a new excerpt is highlighted.
  useEffect(() => {
    if (!pendingExcerpt) {
      setExcerptSuggestions([])
      setSuggestionsLoading(false)
      return
    }
    const excerpt = pendingExcerpt.text
    const node = nodesRef.current.find((n) => n.id === pendingExcerpt.sourceId)
    const context =
      node?.data.nodeKind === 'embed'
        ? node.data.embedUrl ?? ''
        : node?.data.response ?? ''
    let cancelled = false
    setExcerptSuggestions([])
    setSuggestionsLoading(true)
    ;(async () => {
      const qs = await generateExcerptQuestions(excerpt, context, apiKey)
      if (!cancelled) {
        setExcerptSuggestions(qs)
        setSuggestionsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pendingExcerpt, apiKey])

  // Ask one of the suggested questions about the current highlight.
  const submitExcerptQuestion = (question: string) => {
    if (!pendingExcerpt) return
    const sourceId = pendingExcerpt.sourceId
    const excerptText = pendingExcerpt.text
    const ratio = pendingExcerpt.ratio

    const parent = nodesRef.current.find((n) => n.id === sourceId)
    const pw = (parent as any)?.width ?? 420
    const ph = (parent as any)?.height ?? 220
    const pos = parent
      ? { x: parent.position.x + pw + 110, y: parent.position.y + Math.max(0, ratio * ph - 40) }
      : undefined
    void createNode(question, sourceId, {
      excerpt: excerptText,
      position: pos,
      highlight: { id: nanoid(), text: excerptText, ratio },
    })

    setPendingExcerpt(null)
    setSelectedNodeId(null)
    setExcerptSuggestions([])
    setSuggestionsLoading(false)
    setPrompt('')
  }

  const handleNewNode = (e: React.FormEvent) => {
    e.preventDefault()
    if (!prompt.trim()) return

    if (pendingExcerpt) {
      const parent = nodesRef.current.find((n) => n.id === pendingExcerpt.sourceId)
      const pw = (parent as any)?.width ?? 420
      const ph = (parent as any)?.height ?? 220
      const hid = nanoid()
      const pos = parent
        ? {
            x: parent.position.x + pw + 110,
            y: parent.position.y + Math.max(0, pendingExcerpt.ratio * ph - 40),
          }
        : undefined
      createNode(prompt, pendingExcerpt.sourceId, {
        excerpt: pendingExcerpt.text,
        position: pos,
        highlight: { id: hid, text: pendingExcerpt.text, ratio: pendingExcerpt.ratio },
      })
      setPendingExcerpt(null)
    } else {
      const parentId = selectedNodeId || undefined
      let position: { x: number; y: number } | undefined
      if (parentId) {
        const parent = nodesRef.current.find((n) => n.id === parentId)
        const ph = (parent as any)?.height ?? 220
        if (parent) position = { x: parent.position.x, y: parent.position.y + ph + 36 }
      }
      createNode(prompt, parentId, { position })
      if (parentId) setSelectedNodeId(null)
    }
  }

  // Highlighting text inside a node captures it as an excerpt for the bottom input
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('.exploration-prompt-bar')) return // don't disturb the input
      if (target.closest('.exp-reply-btn')) return // + button handles full-message reply
      if (target.closest('iframe')) return // embed iframes handle their own selections

      const sel = window.getSelection()
      const text = sel?.toString().trim() || ''
      if (!sel || sel.isCollapsed || !text) return

      let el = sel.anchorNode as HTMLElement | null
      if (el && el.nodeType === 3) el = el.parentElement // text node → element
      const nodeEl = el?.closest('.react-flow__node') as HTMLElement | null
      const sourceId = nodeEl?.getAttribute('data-id')
      if (!nodeEl || !sourceId) return

      const rect = sel.getRangeAt(0).getBoundingClientRect()
      const nodeRect = nodeEl.getBoundingClientRect()
      const ratio = nodeRect.height
        ? (rect.top + rect.height / 2 - nodeRect.top) / nodeRect.height
        : 0.5

      setPendingExcerpt({ sourceId, text, ratio })
      setSelectedNodeId(sourceId)
      sel.removeAllRanges()
      promptInputRef.current?.focus()
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPendingExcerpt(null)
        setContextMenu(null)
      }
    }

    document.addEventListener('mouseup', handler)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mouseup', handler)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  // Zoom out to frame every block at once (the "see them all" button).
  const fitAll = useCallback(() => {
    rf?.fitView({ padding: 0.2, duration: 500 })
  }, [rf])

  const rankedSources = useMemo(
    () =>
      aggregateSources(
        nodes
          .map((n, order) => ({ n, order }))
          .filter(({ n }) => n.data.response)
          .map(({ n, order }) => ({
            nodeId: n.id,
            response: n.data.response,
            sources: n.data.sources,
            connectionCount: n.data.connectionCount ?? 0,
            order,
          }))
      ),
    [nodes]
  )

  return (
    <div className="h-full flex relative overflow-hidden">
      {/* Whiteboard — always fills full width */}
      <div className="flex-1 relative" ref={flowWrapperRef}>
        <ReactFlow
          nodes={flowNodes}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          onInit={setRf}
          onNodeClick={(_, node) => {
            setContextMenu(null)
            setSelectedNodeId(node.id === selectedNodeId ? null : node.id)
          }}
          onPaneClick={() => {
            setContextMenu(null)
            setLinkPopup(null)
            setPendingExcerpt(null)
          }}
          onNodeContextMenu={onNodeContextMenu}
          onNodesDelete={onNodesDelete}
          fitView
          fitViewOptions={{ padding: 0.4 }}
          minZoom={0.15}
          deleteKeyCode="Delete"
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="rgba(255,255,255,0.05)" />
          <Controls />
          <MiniMap
            nodeColor="rgba(255,255,255,0.4)"
            maskColor="rgba(0,0,0,0.6)"
          />
        </ReactFlow>

        {contextMenu && (
          <div
            className="fixed z-50 min-w-[140px] overflow-hidden rounded-lg border border-black/10 bg-white py-1 shadow-lg"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {contextMenu.nodeKind !== 'embed' && (
              <button
                type="button"
                onClick={() => {
                  retryNode(contextMenu.nodeId)
                  setContextMenu(null)
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-black/70 hover:bg-black/5"
              >
                <RefreshCw size={14} />
                Retry
              </button>
            )}
            <button
              type="button"
              onClick={() => removeNodesById([contextMenu.nodeId])}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        )}

        {linkPopup && (
          <>
            {/* Backdrop to dismiss */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => setLinkPopup(null)}
            />
            <div
              className="fixed z-50 overflow-hidden rounded-xl border border-black/10 bg-white shadow-xl"
              style={{ left: linkPopup.x, top: linkPopup.y + 8 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-3 py-2 border-b border-black/6">
                <p className="max-w-[220px] truncate text-[11px] text-black/40">{linkPopup.url}</p>
              </div>
              <div className="p-1">
                <button
                  type="button"
                  onClick={() => {
                    window.open(linkPopup.url, '_blank', 'noopener,noreferrer')
                    setLinkPopup(null)
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-black/75 hover:bg-black/[0.04]"
                >
                  <Plus size={13} className="text-black/40" />
                  Open in new tab
                </button>

                {/* Only offer embedding when the site actually allows framing.
                    If it can't be framed there's no point — the user would just
                    have to open a new tab anyway. */}
                {linkPopup.embeddable === null && (
                  <div className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-black/40">
                    <Sparkles size={13} className="animate-pulse text-black/30" />
                    Checking if it can embed…
                  </div>
                )}
                {linkPopup.embeddable === true && (
                  <button
                    type="button"
                    onClick={() =>
                      createEmbedNode(linkPopup.url, linkPopup.sourceNodeId, linkPopup.linkText)
                    }
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-black/75 hover:bg-black/[0.04]"
                  >
                    <Sparkles size={13} className="text-black/40" />
                    Embed on canvas
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        <AdventureMenu onBeforeSwitch={flushAdventureToStore} onCreateAdventure={createFreshAdventure} />

        {/* See-all button — frame every block at once */}
        <button
          onClick={fitAll}
          disabled={nodes.length === 0}
          className="btn-ghost absolute top-4 right-4 z-20 flex items-center gap-2 text-xs disabled:opacity-40"
          title="See all blocks"
        >
          <Maximize2 size={12} />
          See all
        </button>

        {/* Prompt input overlay */}
        <div className="exploration-prompt-bar absolute bottom-4 left-1/2 -translate-x-1/2 w-full max-w-xl px-4" data-tour="exploration-prompt">
          {pendingExcerpt && (suggestionsLoading || excerptSuggestions.length > 0) && (
            <div className="exp-suggest-pills card">
              {suggestionsLoading ? (
                <span className="exp-suggest-loading">
                  <Loader2 size={12} className="animate-spin" />
                  Odin is thinking of questions…
                </span>
              ) : (
                <div className="exp-suggest-scroll" role="listbox" aria-label="Suggested questions">
                  {excerptSuggestions.map((q, i) => (
                    <button
                      key={i}
                      type="button"
                      role="option"
                      className="exp-suggest-pill"
                      onClick={() => submitExcerptQuestion(q)}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <form onSubmit={handleNewNode} className="card flex items-center gap-2 p-2 shadow-2xl">
            <input
              ref={promptInputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                pendingExcerpt
                  ? 'Ask about the highlight...'
                  : selectedNodeId
                  ? 'Reply to this message...'
                  : 'Ask a question to explore...'
              }
              className="flex-1 bg-transparent px-3 py-2 text-sm text-white/80 outline-none placeholder-white/25 font-caveat text-base"
            />
            {(selectedNodeId || pendingExcerpt) && (
              <button
                type="button"
                onClick={() => {
                  setSelectedNodeId(null)
                  setPendingExcerpt(null)
                }}
                className="text-xs text-white/30 hover:text-white/50 px-2 font-caveat"
              >
                clear
              </button>
            )}
            <button
              type="submit"
              disabled={!prompt.trim()}
              className="btn-primary flex items-center gap-2 text-sm py-2 disabled:opacity-40"
            >
              <Plus size={14} />
              Explore
            </button>
          </form>
          {(selectedNodeId || pendingExcerpt) && (
            <p className="mt-1 text-center text-xs text-white/50 font-caveat">
              {pendingExcerpt
                ? 'Branches a new block from your highlight'
                : 'Adds a connected block below this message'}
            </p>
          )}
        </div>

        {nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <p className="font-caveat text-2xl text-black/50">Start exploring ideas</p>
              <p className="mt-2 text-sm text-black/35">Type a question below to create your first node</p>
              <p className="mt-1 text-sm text-black/35">Use + below a block to reply, or highlight text to branch from it</p>
              <p className="mt-1 text-sm text-black/35">Ask for an image, diagram, or illustration to get a visual block</p>
            </div>
          </div>
        )}
      </div>

      {/* Sources drawer — slides in from the right */}
      <motion.div
        animate={{ x: sourcesOpen ? 0 : '100%' }}
        initial={false}
        transition={{ duration: 0.22, ease: [0.25, 1, 0.5, 1] }}
        className="absolute right-0 top-0 bottom-0 w-72 flex z-20"
      >
        {/* Toggle tab — peeks out from the left edge of the drawer */}
        <button
          type="button"
          onClick={() => setSourcesOpen((v) => !v)}
          className="absolute left-0 top-1/2 -translate-x-full -translate-y-1/2 h-20 w-6 flex flex-col items-center justify-center gap-1.5 rounded-l-lg border border-r-0 border-black/8 bg-white/55 backdrop-blur-sm hover:bg-white/80 transition-colors"
          title={sourcesOpen ? 'Hide sources' : 'Show sources'}
          data-tour="sources"
        >
          <ChevronLeft
            size={11}
            className={`transition-transform duration-[220ms] text-black/45 ${sourcesOpen ? '' : 'rotate-180'}`}
          />
          {rankedSources.length > 0 && (
            <span className="text-[9px] font-semibold text-black/38 leading-none tabular-nums">
              {rankedSources.length}
            </span>
          )}
        </button>

        {/* Panel content */}
        <div className="flex-1 border-l border-black/8 bg-white/20 flex flex-col overflow-hidden backdrop-blur-sm">
          <div className="flex-1 overflow-y-auto p-3 min-w-0">
            <LiveSourceFeed sources={rankedSources} />
          </div>
        </div>
      </motion.div>
    </div>
  )
}

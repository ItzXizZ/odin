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
  type Edge,
  type ReactFlowInstance,
  BackgroundVariant,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { Plus, Trash2, PenTool, Sparkles, LayoutGrid, ChevronLeft, RefreshCw } from 'lucide-react'
import { nanoid } from 'nanoid'
import { useStore, type ExplorationNodeData } from '../../store/useStore'
import { streamChat } from '../../lib/claude'
import { researchQuery } from '../../lib/research'
import ExplorationNode from './ExplorationNode'
import FloatingEdge from './FloatingEdge'
import LiveSourceFeed from './LiveSourceFeed'
import AdventureMenu from './AdventureMenu'
import { layoutTree } from './layout'
import { aggregateSources, extractSourcesFromText, mergeSources, type SourceRef } from '../../lib/sources'
import { routeExploration } from '../../lib/route'
import { generateVisual, isVisualChoice, type VisualMessage } from '../../lib/visual'
import { uploadAsset } from '../../lib/cloud'

const nodeTypes = { exploration: ExplorationNode }
const edgeTypes = { floating: FloatingEdge }
const defaultEdgeOptions = { type: 'floating' }

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
    setActiveTab,
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

  // Excerpt captured from a highlight, shown above the bottom input
  const [pendingExcerpt, setPendingExcerpt] = useState<{
    sourceId: string
    text: string
    ratio: number
  } | null>(null)

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string; nodeKind?: string } | null>(null)
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
  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])
  useEffect(() => {
    edgesRef.current = edges
  }, [edges])

  // Load the selected adventure's whiteboard when switching.
  // Clear any isLoading flags that were left mid-stream (e.g. adventure was switched
  // while a node was streaming — the completion callback would land on the wrong node
  // list and never clear the flag in the store).
  useEffect(() => {
    if (!activeAdventureId) return
    const cleanNodes = (activeAdventure?.nodes ?? []).map((n: any) =>
      n.data?.isLoading
        ? { ...n, data: { ...n.data, isLoading: false, response: n.data.response || '⚠️ Loading was interrupted. Ask again to retry.' } }
        : n
    )
    setNodes(cleanNodes as any)
    setEdges(activeAdventure?.edges ?? [])
    setSelectedNodeId(null)
    setPendingExcerpt(null)
    setContextMenu(null)
    setPrompt('')
    prevCountRef.current = cleanNodes.length
  }, [activeAdventureId]) // eslint-disable-line react-hooks/exhaustive-deps

  const persistNodes = useCallback(
    (updated: Node<ExplorationNodeData>[]) => {
      setExplorationNodes(updated as any)
    },
    [setExplorationNodes]
  )

  const flushAdventureToStore = useCallback(() => {
    setExplorationNodes(nodesRef.current as any)
    setExplorationEdges(edgesRef.current as any)
  }, [setExplorationNodes, setExplorationEdges])

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

      const pos = sourceNode
        ? { x: sourceNode.position.x + pw + 90, y: sourceNode.position.y }
        : rf
        ? rf.project({ x: window.innerWidth / 2 - 280, y: window.innerHeight / 2 - 240 })
        : { x: 200 + Math.random() * 200, y: 200 + nodesRef.current.length * 80 }

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
          setNodes((prevNodes) =>
            prevNodes.map((n) => ({
              ...n,
              data: { ...n.data, connectionCount: counts[n.id] || 0 },
            }))
          )
          return updatedEdges
        })
      }

      setLinkPopup(null)
    },
    [rf, setNodes, setEdges, setExplorationEdges, persistNodes]
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
      setExplorationNodes(newNodes as any)
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
      setNodes((prev) =>
        prev.map((n) => ({
          ...n,
          data: { ...n.data, connectionCount: connectionCounts[n.id] || 0 },
        }))
      )
    },
    [edges, setEdges, setExplorationEdges, setNodes]
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
        },
      })),
    [nodes, pendingExcerpt, startFullReply, selectedNodeId, nodesWithFullReply, resolveVisualChoice, handleLinkClick]
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

      const id = nanoid()
      const parentNode = parentId ? nodes.find((n) => n.id === parentId) : null
      const pw = (parentNode as any)?.width ?? 420
      const ph = (parentNode as any)?.height ?? 220
      const isFullReply = Boolean(parentNode && !opts?.highlight)
      const defaultPos = parentNode
        ? isFullReply
          ? { x: parentNode.position.x, y: parentNode.position.y + ph + 40 }
          : { x: parentNode.position.x + pw + 90, y: parentNode.position.y }
        : { x: 100 + Math.random() * 200, y: 100 + nodes.length * 160 }
      const pos = opts?.position ?? defaultPos

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
          const updatedEdges = addEdge(edge, prev)
          setExplorationEdges(updatedEdges as any)
          // Recompute connection counts so importance updates automatically
          const counts: Record<string, number> = {}
          updatedEdges.forEach((e) => {
            counts[e.source] = (counts[e.source] || 0) + 1
            counts[e.target] = (counts[e.target] || 0) + 1
          })
          setNodes((prevNodes) =>
            prevNodes.map((n) => ({
              ...n,
              data: { ...n.data, connectionCount: counts[n.id] || 0 },
            }))
          )
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
        ? `Regarding this excerpt from your previous response:\n"${opts.excerpt}"\n\n${userPrompt}`
        : userPrompt
      messages.push({ role: 'user', content: finalContent })

      let response = ''
      await streamChat(
        messages,
        system,
        apiKey,
        (chunk) => {
          response += chunk
          setNodes((prev) =>
            prev.map((n) =>
              n.id === id ? { ...n, data: { ...n.data, response, isLoading: true } } : n
            )
          )
        },
        () => {
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
          captureBoard()
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
      setExplorationEdges,
      persistNodes,
      updateNodeResponse,
      getFullContext,
      runVisualGeneration,
    ]
  )

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

  // Tidy left-to-right tree layout
  const organize = useCallback(() => {
    const positioned = layoutTree(nodesRef.current as any, edgesRef.current as any)
    setNodes((prev) => {
      const updated = prev.map((n) => (positioned[n.id] ? { ...n, position: positioned[n.id] } : n))
      persistNodes(updated)
      return updated
    })
    setTimeout(() => rf?.fitView({ padding: 0.2, duration: 400 }), 60)
  }, [setNodes, persistNodes, rf])

  const organizeRef = useRef(organize)
  useEffect(() => {
    organizeRef.current = organize
  }, [organize])

  // Auto-tidy whenever the number of nodes changes
  const nodeCount = nodes.length
  useEffect(() => {
    if (nodeCount !== prevCountRef.current) {
      prevCountRef.current = nodeCount
      const t = setTimeout(() => organizeRef.current(), 160)
      return () => clearTimeout(t)
    }
  }, [nodeCount])

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
          onNodesChange={onNodesChange}
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
          fitViewOptions={{ padding: 0.2 }}
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

                {/* Embed option — hidden when confirmed non-embeddable */}
                {linkPopup.embeddable !== false && (
                  <button
                    type="button"
                    disabled={linkPopup.embeddable === null}
                    onClick={() => createEmbedNode(linkPopup.url, linkPopup.sourceNodeId, linkPopup.linkText)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-black/75 hover:bg-black/[0.04] disabled:opacity-40 disabled:cursor-default"
                  >
                    <Sparkles size={13} className={linkPopup.embeddable === null ? 'animate-pulse text-black/30' : 'text-black/40'} />
                    {linkPopup.embeddable === null ? 'Checking…' : 'Embed on canvas'}
                  </button>
                )}

                {linkPopup.embeddable === false && (
                  <p className="px-3 py-2 text-[11px] text-black/35 italic">
                    This site doesn't allow embedding.
                  </p>
                )}
              </div>
            </div>
          </>
        )}

        <AdventureMenu onBeforeSwitch={flushAdventureToStore} />

        {/* Organize button */}
        <button
          onClick={organize}
          disabled={nodes.length === 0}
          className="btn-ghost absolute top-4 right-4 z-20 flex items-center gap-2 text-xs disabled:opacity-40"
          title="Tidy the layout"
        >
          <LayoutGrid size={12} />
          Organize
        </button>

        {/* Prompt input overlay */}
        <div className="exploration-prompt-bar absolute bottom-4 left-1/2 -translate-x-1/2 w-full max-w-xl px-4">
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
            <LiveSourceFeed sources={rankedSources} defaultOpen />
          </div>
          <div className="p-3 border-t border-black/8 min-w-0">
            <button
              onClick={() => setActiveTab('write')}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              <PenTool size={14} />
              Write
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
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
import { Plus, Trash2, PenTool, X, Sparkles, LayoutGrid } from 'lucide-react'
import { nanoid } from 'nanoid'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore, type ExplorationNodeData, type Takeaway } from '../../store/useStore'
import { streamChat } from '../../lib/claude'
import { researchQuery } from '../../lib/research'
import ExplorationNode from './ExplorationNode'
import FloatingEdge from './FloatingEdge'
import LiveSourceFeed from './LiveSourceFeed'
import AdventureMenu from './AdventureMenu'
import { layoutTree } from './layout'
import { aggregateSources, extractSourcesFromText, mergeSources, type SourceRef } from '../../lib/sources'
import { isVisualRequest, resolveVisualQuery } from '../../lib/visualDetect'
import { generateVisual, type VisualMessage } from '../../lib/visual'

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
    addTakeaway,
    removeTakeaway,
    setActiveTab,
    getFullContext,
  } = useStore()

  const activeAdventure = adventures.find((a) => a.id === activeAdventureId)
  const savedNodes = activeAdventure?.nodes ?? []
  const savedEdges = activeAdventure?.edges ?? []
  const takeaways = activeAdventure?.takeaways ?? []

  const [nodes, setNodes, onNodesChange] = useNodesState<ExplorationNodeData>(savedNodes as any)
  const [edges, setEdges, onEdgesChange] = useEdgesState(savedEdges)
  const [prompt, setPrompt] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [takeawayInput, setTakeawayInput] = useState('')

  const flowWrapperRef = useRef<HTMLDivElement>(null)
  const promptInputRef = useRef<HTMLInputElement>(null)
  const [rf, setRf] = useState<ReactFlowInstance | null>(null)

  // Excerpt captured from a highlight, shown above the bottom input
  const [pendingExcerpt, setPendingExcerpt] = useState<{
    sourceId: string
    text: string
    ratio: number
  } | null>(null)

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)

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
        },
      })),
    [nodes, edges, pendingExcerpt, startFullReply, selectedNodeId, nodesWithFullReply]
  )

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

  // Load the selected adventure's whiteboard when switching
  useEffect(() => {
    if (!activeAdventureId) return
    setNodes((activeAdventure?.nodes ?? []) as any)
    setEdges(activeAdventure?.edges ?? [])
    setSelectedNodeId(null)
    setPendingExcerpt(null)
    setContextMenu(null)
    setPrompt('')
    prevCountRef.current = activeAdventure?.nodes.length ?? 0
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
      setContextMenu({ x: e.clientX, y: e.clientY, nodeId: node.id })
    },
    []
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
      const visualCtx = {
        hasParentContext: Boolean(parentNode),
        hasExcerpt: Boolean(opts?.excerpt),
        parentPrompt: parentNode?.data.prompt,
        parentResponse: parentNode?.data.response,
        excerpt: opts?.excerpt,
      }
      const wantsVisual = isVisualRequest(userPrompt, visualCtx)
      const visualQuery = wantsVisual ? resolveVisualQuery(userPrompt, visualCtx) : userPrompt

      const newNode: Node<ExplorationNodeData> = {
        id,
        type: 'exploration',
        position: pos,
        data: {
          prompt: userPrompt,
          response: '',
          isLoading: true,
          connectionCount: 0,
          nodeKind: wantsVisual ? 'visual' : 'text',
          visualStatus: wantsVisual ? 'Preparing adapted visual…' : undefined,
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

      // Always research the web before generating a response
      let researchSources: SourceRef[] = []
      let researchContext = ''
      try {
        const research = await researchQuery(wantsVisual ? visualQuery : userPrompt)
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

      if (wantsVisual) {
        setNodes((prev) =>
          prev.map((n) =>
            n.id === id
              ? { ...n, data: { ...n.data, visualStatus: 'Generating adapted visual…' } }
              : n
          )
        )

        try {
          const visual = await generateVisual({
            query: visualQuery,
            apiKey,
            context,
            parentPrompt: parentNode?.data.prompt,
            parentResponse: parentNode?.data.response,
            excerpt: opts?.excerpt,
            messageChain: buildMessageChain(nodesRef.current, edgesRef.current, parentId),
          })

          setNodes((prev) => {
            const updated = prev.map((n) => {
              if (n.id !== id) return n
              const refSources: SourceRef[] = visual.referenceUrl
                ? [{ id: visual.referenceUrl, title: visual.referenceTitle || 'Reference photo', url: visual.referenceUrl }]
                : []
              return {
                ...n,
                data: {
                  ...n.data,
                  visual,
                  response: visual.caption,
                  isLoading: false,
                  visualStatus: undefined,
                  sources: mergeSources(n.data.sources ?? researchSources, refSources),
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
                    },
                  }
                : n
            )
            persistNodes(updated)
            return updated
          })
        }
        return
      }

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
        }
      )
    },
    [nodes, apiKey, setNodes, setEdges, setExplorationEdges, persistNodes, updateNodeResponse, getFullContext]
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

  const handleAddTakeaway = () => {
    if (!takeawayInput.trim()) return
    addTakeaway({ id: nanoid(), text: takeawayInput.trim() })
    setTakeawayInput('')
  }

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
    <div className="h-full flex">
      {/* Whiteboard */}
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
            className="fixed z-50 min-w-[120px] overflow-hidden rounded-lg border border-black/10 bg-white py-1 shadow-lg"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
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
          {/* Captured excerpt chip sits ABOVE the input */}
          {pendingExcerpt && (
            <div className="card mb-2 flex items-start gap-2 border-white/25 p-2 shadow-2xl animate-slide-up">
              <Sparkles size={12} className="mt-0.5 flex-shrink-0 text-white/60" />
              <p className="flex-1 text-xs italic text-white/60 line-clamp-2">
                "{pendingExcerpt.text}"
              </p>
              <button
                onClick={() => setPendingExcerpt(null)}
                className="flex-shrink-0 text-white/30 hover:text-white/60"
              >
                <X size={12} />
              </button>
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

      {/* Right sidebar */}
      <div className="w-72 border-l border-white/10 bg-[#0f0f0f] flex flex-col overflow-hidden">
        {/* Live Source Update — read-only feed, auto-updates from cited links */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 min-w-0">
          <div className="flex items-center justify-between">
            <span className="section-title text-sm">Live Source Update</span>
            <span className="text-xs text-white/30">by Relevance</span>
          </div>
          <LiveSourceFeed sources={rankedSources} />
        </div>

        {/* Takeaways */}
        <div className="border-t border-white/10 p-4 space-y-3">
          <span className="section-title text-sm">Takeaways</span>
          <p className="text-xs text-white/30">sorted by relevance</p>

          <div className="max-h-40 overflow-y-auto space-y-1">
            <AnimatePresence>
              {takeaways.map((t) => (
                <motion.div
                  key={t.id}
                  initial={{ opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                  className="group flex items-start gap-2 rounded-lg border border-white/8 bg-white/3 p-2"
                >
                  <p className="flex-1 text-xs text-white/60 leading-relaxed">{t.text}</p>
                  <button
                    onClick={() => removeTakeaway(t.id)}
                    className="hidden group-hover:block text-white/30 hover:text-red-400"
                  >
                    <Trash2 size={10} />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          <div className="flex gap-2">
            <input
              value={takeawayInput}
              onChange={(e) => setTakeawayInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddTakeaway()}
              placeholder="Add takeaway..."
              className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs 
                         text-white/70 outline-none focus:border-white/40 placeholder-white/20 font-caveat text-sm"
            />
            <button onClick={handleAddTakeaway} className="btn-ghost text-xs px-2">
              <Plus size={12} />
            </button>
          </div>
        </div>

        <div className="p-4 border-t border-white/10 min-w-0">
          <button onClick={() => setActiveTab('write')} className="btn-primary w-full flex items-center justify-center gap-2">
            <PenTool size={14} />
            Write
          </button>
        </div>
      </div>
    </div>
  )
}

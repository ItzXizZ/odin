import { memo, useEffect, useMemo, useRef } from 'react'
import { Handle, Position, type NodeProps } from 'reactflow'
import { Loader2, Plus } from 'lucide-react'
import type { ExplorationNodeData } from '../../store/useStore'
import Markdown from '../Markdown'
import ExplorationVisual from './ExplorationVisual'
import MessageSourcesPanel from './MessageSourcesPanel'
import { extractSourcesFromText, mergeSources } from '../../lib/sources'

/* ---------- persistent highlight marking (rough, line-by-line) ---------- */

function unwrapMarks(root: HTMLElement) {
  root.querySelectorAll('span.branch-mark, span.branch-mark-pending').forEach((span) => {
    const parent = span.parentNode
    if (!parent) return
    while (span.firstChild) parent.insertBefore(span.firstChild, span)
    parent.removeChild(span)
  })
  root.normalize()
}

function markPhrase(root: HTMLElement, phrase: string, className = 'branch-mark') {
  const target = phrase.trim()
  if (target.length < 2) return

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: { node: Text; start: number }[] = []
  let full = ''
  let n: Node | null
  while ((n = walker.nextNode())) {
    nodes.push({ node: n as Text, start: full.length })
    full += (n as Text).nodeValue ?? ''
  }

  const idx = full.indexOf(target)
  if (idx === -1) return
  const end = idx + target.length

  for (const { node, start } of nodes) {
    const nodeStart = start
    const nodeEnd = start + (node.nodeValue?.length ?? 0)
    if (nodeEnd <= idx || nodeStart >= end) continue

    const a = Math.max(idx, nodeStart) - nodeStart
    const b = Math.min(end, nodeEnd) - nodeStart

    let piece: Text = node
    if (a > 0) piece = piece.splitText(a)
    if (b - a < (piece.nodeValue?.length ?? 0)) piece.splitText(b - a)

    const span = document.createElement('span')
    span.className = className
    piece.parentNode?.insertBefore(span, piece)
    span.appendChild(piece)
  }
}

function applyMarks(root: HTMLElement, phrases: string[], pendingPhrase?: string) {
  unwrapMarks(root)
  for (const p of phrases) markPhrase(root, p)
  if (pendingPhrase) markPhrase(root, pendingPhrase, 'branch-mark-pending')
}

/* ----------------------------------------------------------------------- */

function ExplorationNode({ data, selected }: NodeProps<ExplorationNodeData>) {
  const {
    prompt,
    response,
    isLoading,
    nodeKind,
    visual,
    visualStatus,
    sources: storedSources = [],
    highlights = [],
    pendingHighlight,
    onReplyFull,
    isReplyTarget,
  } = data
  const responseRef = useRef<HTMLDivElement>(null)

  const isVisualNode = nodeKind === 'visual' || Boolean(visual)
  const len = response.length
  const width = isVisualNode
    ? Math.min(520, Math.max(360, 360 + Math.round(len / 16)))
    : Math.min(480, Math.max(300, 300 + Math.round(len / 9)))
  const maxHeight = isVisualNode ? 520 : 300

  const allSources = useMemo(
    () =>
      mergeSources(
        storedSources,
        extractSourcesFromText(prompt),
        extractSourcesFromText(response)
      ),
    [storedSources, prompt, response]
  )
  const sourcesLoading = isLoading && allSources.length === 0

  const highlightKey = highlights.map((h) => h.id + h.text).join('|')
  useEffect(() => {
    if (responseRef.current && !visual) {
      applyMarks(
        responseRef.current,
        highlights.map((h) => h.text),
        pendingHighlight
      )
    }
  }, [response, highlightKey, pendingHighlight, visual])

  const loadingMessage =
    visualStatus ||
    (nodeKind === 'visual' ? 'Creating visual…' : 'Thinking...')

  return (
    <div className="relative" style={{ width }}>
      <div
        className={`card transition-shadow duration-200 ${
          selected ? 'ring-1 ring-black/25 shadow-2xl' : ''
        }`}
      >
        <Handle id="t" type="target" position={Position.Left} className="exp-handle" isConnectable={false} />
        <Handle id="s" type="source" position={Position.Right} className="exp-handle" isConnectable={false} />

        <div className="relative z-[2] p-3">
          <div className="mb-2 rounded-lg bg-black/5 px-3 py-2">
            <p className="text-sm leading-snug text-black/85">{prompt}</p>
            {nodeKind === 'visual' && (
              <span className="mt-1 inline-block rounded-full bg-black/8 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-black/45">
                Visual
              </span>
            )}
          </div>

          <div
            ref={responseRef}
            className={`nodrag nowheel overflow-y-auto ${visual ? '' : 'select-text cursor-text'}`}
            style={{ maxHeight }}
          >
            {isLoading && !response && !visual ? (
              <div className="flex items-center gap-2 py-3">
                <Loader2 size={12} className="animate-spin text-black/50" />
                <span className="text-xs text-black/40">{loadingMessage}</span>
              </div>
            ) : visual ? (
              <ExplorationVisual visual={visual} caption={response || undefined} />
            ) : response ? (
              <Markdown size="text-xs" className="text-black/80">
                {response}
              </Markdown>
            ) : (
              <p className="text-xs italic text-black/30">No response yet</p>
            )}
          </div>

          <MessageSourcesPanel sources={allSources} isLoading={sourcesLoading} />
        </div>
      </div>

      {onReplyFull && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onReplyFull()
          }}
          className={`exp-reply-btn nodrag absolute left-1/2 top-[calc(100%+6px)] z-10 flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full border shadow-sm transition ${
            isReplyTarget
              ? 'border-black/30 bg-white text-black/70'
              : 'border-black/15 bg-white/90 text-black/35 hover:border-black/25 hover:bg-white hover:text-black/65'
          }`}
          title="Reply to entire message"
        >
          <Plus size={10} strokeWidth={2.5} />
        </button>
      )}
    </div>
  )
}

export default memo(ExplorationNode)

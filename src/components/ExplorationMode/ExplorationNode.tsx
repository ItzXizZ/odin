import { memo, useEffect, useMemo, useRef, useState } from 'react'

import { Handle, Position, type NodeProps } from 'reactflow'

import { Loader2, Plus, Search, Sparkles } from 'lucide-react'

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



/**
 * Shown when a visual request is ambiguous: let the user trade quality for speed.
 * AI adaptation is slow but tailored; web image search is fast but reuses real images.
 */
function VisualChoice({
  suggestion,
  onChoose,
}: {
  suggestion?: 'search' | 'generate'
  onChoose?: (method: 'search' | 'generate') => void
}) {
  const options = [
    {
      key: 'generate' as const,
      icon: Sparkles,
      title: 'AI adaptation',
      desc: 'Custom image built for your request · slower',
    },
    {
      key: 'search' as const,
      icon: Search,
      title: 'Image search',
      desc: 'Finds a real image from the web · quicker',
    },
  ]

  return (
    <div className="py-2">
      <p className="mb-2 text-xs text-black/55">How should I create this visual?</p>
      <div className="flex flex-col gap-2">
        {options.map(({ key, icon: Icon, title, desc }) => {
          const isSuggested = suggestion === key
          return (
            <button
              key={key}
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onChoose?.(key)
              }}
              className={`nodrag flex w-full items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition ${
                isSuggested
                  ? 'border-[rgba(100,150,255,0.55)] bg-[rgba(100,150,255,0.1)] ring-1 ring-[rgba(100,150,255,0.35)]'
                  : 'border-black/10 bg-white/40 hover:border-black/20 hover:bg-white/60'
              }`}
            >
              <Icon size={15} className="shrink-0 text-black/55" />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-xs font-medium text-black/80">
                  {title}
                  {isSuggested && (
                    <span className="rounded-full bg-[rgba(100,150,255,0.2)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[rgba(40,80,170,0.95)]">
                      Suggested
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-[10px] text-black/45">{desc}</span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}



/**
 * Image-generation progress bar. The image APIs don't expose real progress, so
 * we ease toward ~95% over time and let the bar disappear when the visual lands.
 */
function VisualProgressBar({ status }: { status: string }) {
  const [progress, setProgress] = useState(8)

  useEffect(() => {
    const start = Date.now()
    const id = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000
      const target = 95 * (1 - Math.exp(-elapsed / 22))
      setProgress((p) => Math.max(p, Math.min(95, target)))
    }, 250)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="py-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Loader2 size={11} className="shrink-0 animate-spin text-black/45" />
          <span className="truncate text-[11px] text-black/50">{status}</span>
        </div>
        <span className="shrink-0 text-[10px] font-medium tabular-nums text-black/35">
          {Math.round(progress)}%
        </span>
      </div>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-black/8 shadow-[inset_0_1px_1px_rgba(0,0,0,0.06)]">
        <div
          className="relative h-full rounded-full transition-[width] duration-500 ease-out"
          style={{
            width: `${progress}%`,
            background:
              'linear-gradient(90deg, rgba(100,150,255,0.55), rgba(120,170,255,0.9))',
          }}
        >
          <div className="exp-progress-shimmer absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-white/70 to-transparent" />
        </div>
      </div>
    </div>
  )
}



function ExplorationNode({ data, selected }: NodeProps<ExplorationNodeData>) {

  const {

    prompt,

    response,

    isLoading,

    nodeKind,

    visual,

    visualStatus,

    visualChoice,

    onVisualChoice,

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

            {visualChoice && !visual && !isLoading ? (

              <VisualChoice suggestion={visualChoice.suggestion} onChoose={onVisualChoice} />

            ) : isLoading && !response && !visual ? (

              isVisualNode ? (

                <VisualProgressBar status={loadingMessage} />

              ) : (

                <div className="flex items-center gap-2 py-3">

                  <Loader2 size={12} className="animate-spin text-black/50" />

                  <span className="text-xs text-black/40">{loadingMessage}</span>

                </div>

              )

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


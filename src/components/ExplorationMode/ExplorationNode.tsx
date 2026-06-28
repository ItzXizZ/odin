import { memo, useEffect, useMemo, useRef, useState } from 'react'

import { Handle, Position, useStoreApi, type NodeProps } from 'reactflow'

import { AlertCircle, ExternalLink, Loader2, Plus, Search, Sparkles } from 'lucide-react'

import type { ExplorationNodeData } from '../../store/useStore'

import Markdown from '../Markdown'

import ErrorBoundary from '../ErrorBoundary'

import ExplorationVisual from './ExplorationVisual'

import { getEmbedFrameSrc, isReaderProxySrc } from './embedUtils'

import {
  clearPendingEmbedHighlight,
  ensureEmbedHighlightStyles,
  showPendingEmbedHighlight,
} from './embedHighlights'

import { readIframeScrollTop, scheduleIframeScrollRestore } from '../../lib/embedScroll'

import { applyMarks, applyPersistedMarks } from './textMarks'



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



function ExplorationNode({ id, data, selected }: NodeProps<ExplorationNodeData>) {

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

    embedUrl,

    embedScrollTop,

    onEmbedScrollChange,

    onEmbedExcerpt,

    onLinkClick,

  } = data

  const responseRef = useRef<HTMLDivElement>(null)
  const gripRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollRestoreTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  const lastAppliedScrollRef = useRef<number | null>(null)
  const embedScrollTargetRef = useRef(embedScrollTop ?? 0)
  const highlightsRef = useRef(highlights)
  const pendingHighlightRef = useRef(pendingHighlight)
  const onEmbedExcerptRef = useRef(onEmbedExcerpt)
  const onEmbedScrollChangeRef = useRef(onEmbedScrollChange)

  useEffect(() => {
    embedScrollTargetRef.current = embedScrollTop ?? 0
  }, [embedScrollTop])

  useEffect(() => {
    highlightsRef.current = highlights
  }, [highlights])

  useEffect(() => {
    pendingHighlightRef.current = pendingHighlight
  }, [pendingHighlight])

  useEffect(() => {
    onEmbedExcerptRef.current = onEmbedExcerpt
    onEmbedScrollChangeRef.current = onEmbedScrollChange
  }, [onEmbedExcerpt, onEmbedScrollChange])

  const clearScrollRestoreTimers = () => {
    scrollRestoreTimers.current.forEach(clearTimeout)
    scrollRestoreTimers.current = []
  }

  const tryRestoreScroll = (doc: Document, target: number) => {
    if (target <= 0) return
    if (lastAppliedScrollRef.current === target && readIframeScrollTop(doc) >= target - 8) return
    clearScrollRestoreTimers()
    scheduleIframeScrollRestore(doc, target, scrollRestoreTimers.current)
    lastAppliedScrollRef.current = target
  }

  const rfStore = useStoreApi()

  const isVisualNode = nodeKind === 'visual' || Boolean(visual)

  const isEmbedNode = nodeKind === 'embed'

  const len = response.length

  const defaultWidth = isEmbedNode
    ? 560
    : isVisualNode
    ? Math.min(520, Math.max(360, 360 + Math.round(len / 16)))
    : Math.min(480, Math.max(300, 300 + Math.round(len / 9)))

  const defaultMaxHeight = isEmbedNode ? 520 : isVisualNode ? 520 : 300

  const [iframeError, setIframeError] = useState(false)
  const [userWidth, setUserWidth] = useState<number | null>(null)
  const [userHeight, setUserHeight] = useState<number | null>(null)

  const embedFrameSrc = embedUrl ? getEmbedFrameSrc(embedUrl) : ''
  const isReaderProxy = isReaderProxySrc(embedFrameSrc)

  const width = userWidth ?? defaultWidth
  const maxHeight = userHeight ?? defaultMaxHeight

  // Always-current refs so the native event closure reads the latest values
  const widthRef = useRef(width)
  const maxHeightRef = useRef(maxHeight)
  useEffect(() => { widthRef.current = width }, [width])
  useEffect(() => { maxHeightRef.current = maxHeight }, [maxHeight])

  // Ref to the outer wrapper div so we can mutate its style directly during drag
  const nodeWrapperRef = useRef<HTMLDivElement>(null)

  // Register a CAPTURE-phase native pointerdown listener on the grip.
  // Capture fires before d3-drag's bubble-phase listener on the node wrapper,
  // so stopImmediatePropagation() prevents d3 from ever seeing the event.
  // During drag we mutate DOM styles directly (zero React overhead = true 60fps).
  // React state is committed once on pointerup so React / React Flow stay in sync.
  useEffect(() => {
    const grip = gripRef.current
    if (!grip) return

    const onDown = (ev: PointerEvent) => {
      ev.preventDefault()
      ev.stopPropagation()
      ev.stopImmediatePropagation()

      grip.setPointerCapture(ev.pointerId)

      const startX = ev.clientX
      const startY = ev.clientY
      const startW = widthRef.current
      const startH = maxHeightRef.current
      let lastW = startW
      let lastH = startH

      const onMove = (e: PointerEvent) => {
        const zoom = rfStore.getState().transform[2] || 1
        lastW = Math.max(260, startW + (e.clientX - startX) / zoom)
        lastH = Math.max(120, startH + (e.clientY - startY) / zoom)
        // Mutate DOM directly — no React commit, no ResizeObserver feedback loop
        if (nodeWrapperRef.current) {
          nodeWrapperRef.current.style.width = `${lastW}px`
        }
        if (responseRef.current) {
          responseRef.current.style.maxHeight = `${lastH}px`
        }
      }

      const onUp = (e: PointerEvent) => {
        grip.releasePointerCapture(e.pointerId)
        grip.removeEventListener('pointermove', onMove)
        grip.removeEventListener('pointerup', onUp)
        // Commit final dimensions to React state once drag ends
        setUserWidth(lastW)
        setUserHeight(lastH)
      }

      grip.addEventListener('pointermove', onMove)
      grip.addEventListener('pointerup', onUp)
    }

    grip.addEventListener('pointerdown', onDown, { capture: true })
    return () => grip.removeEventListener('pointerdown', onDown, { capture: true })
  }, [rfStore])



  const highlightKey = highlights.map((h) => `${h.id}:${h.text}:${h.ratio}`).join('|')

  useEffect(() => {

    if (responseRef.current && !visual) {

      try {

        applyMarks(

          responseRef.current,

          highlights.map((h) => h.text),

          pendingHighlight

        )

      } catch {

        // Marking manipulates React-owned DOM; if it ever desyncs, skip
        // highlighting rather than letting it bubble up and crash the canvas.

      }

    }

  }, [response, highlightKey, pendingHighlight, visual])

  // Reader-proxied embeds: scroll persistence, highlight restore, text selection.
  useEffect(() => {
    if (!isEmbedNode || !isReaderProxy || iframeError) return
    const iframe = iframeRef.current
    if (!iframe) return

    let teardown: (() => void) | undefined
    let highlightTimers: ReturnType<typeof setTimeout>[] = []

    const paintHighlights = (doc: Document) => {
      ensureEmbedHighlightStyles(doc)
      const pending = pendingHighlightRef.current
      const marks = highlightsRef.current.map((h) => h.text)
      try {
        if (!pending) {
          clearPendingEmbedHighlight(doc)
          applyMarks(doc.body, marks)
        } else {
          applyPersistedMarks(doc.body, marks)
        }
      } catch {
        /* skip */
      }
    }

    const restoreScroll = (doc: Document) => {
      tryRestoreScroll(doc, embedScrollTargetRef.current)
    }

    const attach = () => {
      teardown?.()
      highlightTimers.forEach(clearTimeout)
      highlightTimers = []

      let doc: Document | null = null
      try {
        doc = iframe.contentDocument
      } catch {
        return
      }
      if (!doc?.body) return

      restoreScroll(doc)

      paintHighlights(doc)
      ;[120, 450, 1200].forEach((delay) => {
        highlightTimers.push(setTimeout(() => paintHighlights(doc!), delay))
      })

      const saveScroll = () => {
        const top = readIframeScrollTop(doc!)
        if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current)
        scrollSaveTimer.current = setTimeout(() => {
          onEmbedScrollChangeRef.current?.(top)
        }, 200)
      }

      const onMouseUp = () => {
        const sel = doc!.getSelection()
        const text = sel?.toString().trim() || ''
        if (!sel || sel.isCollapsed || text.length < 2) return

        const range = sel.getRangeAt(0).cloneRange()
        const rect = range.getBoundingClientRect()
        const rootRect = iframe.getBoundingClientRect()
        const ratio = rootRect.height
          ? (rect.top + rect.height / 2 - rootRect.top) / rootRect.height
          : 0.5

        showPendingEmbedHighlight(doc!, range)
        onEmbedExcerptRef.current?.({ text, ratio: Math.max(0, Math.min(1, ratio)) })
        sel.removeAllRanges()
      }

      doc.addEventListener('scroll', saveScroll, { passive: true, capture: true })
      doc.addEventListener('mouseup', onMouseUp)

      teardown = () => {
        try {
          if (doc) {
            if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current)
            onEmbedScrollChangeRef.current?.(readIframeScrollTop(doc))
          }
        } catch {
          /* ignore */
        }
        doc?.removeEventListener('scroll', saveScroll, true)
        doc?.removeEventListener('mouseup', onMouseUp)
        highlightTimers.forEach(clearTimeout)
        highlightTimers = []
        clearScrollRestoreTimers()
      }
    }

    const onLoad = () => attach()
    iframe.addEventListener('load', onLoad)
    if (iframe.contentDocument?.readyState === 'complete') attach()

    return () => {
      iframe.removeEventListener('load', onLoad)
      teardown?.()
      clearScrollRestoreTimers()
    }
  }, [isEmbedNode, isReaderProxy, iframeError, embedUrl, highlightKey, pendingHighlight])

  // Re-apply scroll when saved position arrives after async hydration.
  useEffect(() => {
    if (!isEmbedNode || !isReaderProxy || iframeError) return
    const doc = iframeRef.current?.contentDocument
    if (!doc?.body) return
    const target = embedScrollTop ?? 0
    embedScrollTargetRef.current = target
    lastAppliedScrollRef.current = null
    if (target <= 0) return
    tryRestoreScroll(doc, target)
  }, [isEmbedNode, isReaderProxy, iframeError, embedScrollTop, embedUrl])

  const loadingMessage =

    visualStatus ||

    (nodeKind === 'visual' ? 'Creating visual…' : 'Thinking...')



  return (

    <div ref={nodeWrapperRef} className="relative" style={{ width }}>

      <div

        className={`card transition-shadow duration-200 ${

          selected ? 'ring-1 ring-black/25 shadow-2xl' : ''

        }`}

      >

        <Handle id="t" type="target" position={Position.Left} className="exp-handle" isConnectable={false} />

        <Handle id="s" type="source" position={Position.Right} className="exp-handle" isConnectable={false} />



        <div className="relative z-[2] p-3">

          <div className="mb-2 rounded-lg bg-black/5 px-3 py-2">

            {isEmbedNode ? (

              <div className="flex items-center gap-1.5">

                <ExternalLink size={11} className="shrink-0 text-black/40" />

                <p className="truncate text-xs text-black/55">{embedUrl}</p>

              </div>

            ) : (

              <>

                <p className="text-sm leading-snug text-black/85">{prompt}</p>

                {nodeKind === 'visual' && (

                  <span className="mt-1 inline-block rounded-full bg-black/8 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-black/45">

                    Visual

                  </span>

                )}

              </>

            )}

          </div>



          <div

            ref={responseRef}

            className={`nodrag nowheel overflow-y-auto ${visual ? '' : 'select-text cursor-text'}`}

            style={{ maxHeight }}

          >

            {isEmbedNode && embedUrl ? (

              <div className="nodrag nowheel overflow-hidden rounded-lg border border-black/10">

                {iframeError ? (

                  <div className="flex flex-col items-center justify-center gap-3 bg-black/[0.03] p-6 text-center">

                    <AlertCircle size={20} className="text-black/30" />

                    <p className="text-xs text-black/50">This site doesn't allow embedding.</p>

                    <a

                      href={embedUrl}

                      target="_blank"

                      rel="noopener noreferrer"

                      className="flex items-center gap-1.5 rounded-lg border border-black/15 bg-white/70 px-3 py-1.5 text-xs text-black/70 hover:bg-white"

                    >

                      <ExternalLink size={11} />

                      Open in new tab

                    </a>

                  </div>

                ) : (

                  <div className="relative">

                    <iframe

                      ref={iframeRef}

                      src={embedFrameSrc}

                      title={embedUrl}

                      className={`h-[400px] w-full border-0 bg-white ${isReaderProxy ? 'select-text' : ''}`}

                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"

                      onError={() => setIframeError(true)}

                    />

                    {isReaderProxy && (
                      <p className="pointer-events-none absolute left-2 top-2 rounded-md bg-white/85 px-2 py-0.5 text-[9px] text-black/40 shadow-sm backdrop-blur-sm">
                        Select text to ask a follow-up
                      </p>
                    )}

                    <a

                      href={embedUrl}

                      target="_blank"

                      rel="noopener noreferrer"

                      className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md border border-black/10 bg-white/90 px-2 py-1 text-[10px] text-black/50 shadow-sm hover:bg-white hover:text-black/70 backdrop-blur-sm"

                      onClick={(e) => e.stopPropagation()}

                    >

                      <ExternalLink size={9} />

                      Open in new tab

                    </a>

                  </div>

                )}

              </div>

            ) : visualChoice && !visual && !isLoading ? (

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

              <ErrorBoundary resetKey={response + highlightKey}>

                <Markdown key={response + '|' + highlightKey} size="text-xs" className="text-black/80" onLinkClick={onLinkClick}>

                  {response}

                </Markdown>

              </ErrorBoundary>

            ) : (

              <p className="text-xs italic text-black/30">No response yet</p>

            )}

          </div>

        </div>

        {/* Resize grip — registered via native capture-phase listener in useEffect */}
        <div
          ref={gripRef}
          className="nodrag absolute bottom-0 right-0 z-10 flex h-6 w-6 cursor-se-resize select-none items-end justify-end pb-1 pr-1 text-black/20 hover:text-black/50 transition-colors"
          style={{ pointerEvents: 'auto', touchAction: 'none' }}
          title="Drag to resize"
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true" style={{ pointerEvents: 'none' }}>
            <line x1="1" y1="7" x2="7" y2="1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <line x1="4" y1="7" x2="7" y2="4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
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



// Custom comparator: skip re-renders caused solely by new callback references or
// node-position updates (React Flow recreates data objects on every drag frame).
// We re-render only when visible content or interactive state actually changes.
function explorationNodeEqual(
  prev: NodeProps<ExplorationNodeData>,
  next: NodeProps<ExplorationNodeData>
): boolean {
  if (prev.selected !== next.selected) return false
  const pd = prev.data
  const nd = next.data
  return (
    pd.response === nd.response &&
    pd.prompt === nd.prompt &&
    pd.isLoading === nd.isLoading &&
    pd.nodeKind === nd.nodeKind &&
    pd.visual === nd.visual &&
    pd.visualStatus === nd.visualStatus &&
    pd.visualChoice === nd.visualChoice &&
    pd.embedUrl === nd.embedUrl &&
    pd.embedScrollTop === nd.embedScrollTop &&
    pd.pendingHighlight === nd.pendingHighlight &&
    pd.isReplyTarget === nd.isReplyTarget &&
    pd.sources === nd.sources &&
    // compare highlights by content, not reference
    pd.highlights?.map((h) => `${h.id}:${h.text}:${h.ratio}`).join('|') ===
      nd.highlights?.map((h) => `${h.id}:${h.text}:${h.ratio}`).join('|') &&
    // onReplyFull presence matters (undefined = branch already exists), not the reference
    (pd.onReplyFull === undefined) === (nd.onReplyFull === undefined)
  )
}

export default memo(ExplorationNode, explorationNodeEqual)


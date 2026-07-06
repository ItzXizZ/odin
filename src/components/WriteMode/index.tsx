import { useState, useCallback, useEffect, useRef, type CSSProperties } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Underline from '@tiptap/extension-underline'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import {
  Bold, Italic, UnderlineIcon, AlignLeft, AlignCenter, AlignRight,
  Check, X, Loader2, Undo2, Redo2, Crosshair,
  Plus, PanelRightClose, PanelRightOpen, LayoutGrid, Inbox, Send, ChevronDown,
} from 'lucide-react'
import { diffWords } from 'diff'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore, useHasApiKey } from '../../store/useStore'
import { streamChat } from '../../lib/claude'
import { compileStyleGuide, parseEditResponse, parseAgentResponse, parseDraftResponse, applyEdits, type ParsedEdit } from '../../lib/style'
import { createAgentStreamParser, buildAgentStreamSystemPrompt } from '../../lib/agentStream'
import {
  runStyleAgentTurn,
  runConflictResolutionTurn,
  type StyleAgentAction,
  type StyleAgentResult,
} from '../../lib/styleAgent'
import type { DiffChange } from './DiffReview'
import { Insertion, Deletion, DiffReview as DiffReviewExt, resolveRange, docHasDiff } from './diffExtension'
import {
  normalizeAiResponse,
  applyRichFormattingToEditor,
  looksLikeMarkdown,
  looksLikeJsonResponse,
  markdownishToHtml,
} from '../../lib/aiText'
import { diffToHtml, diffToInlineHtml } from './diffHtml'
import RefinePanel from './TunnelVision'
import DocumentsMode from '../DocumentsMode'
import ContextHouse from '../ContextHouse'
import ComposeContextDock from './ComposeContextDock'
import {
  ensureTabChatState,
  createChatThread,
  type WriteChatMessage,
  type WriteChatThread,
  type AgentActivityStep,
} from './chatThreads'
import { subscribeWorkspaceSaveStatus, type WorkspaceSaveStatus } from '../../lib/workspaceStorage'
import { registerOnboardingCommand } from '../../lib/onboarding'

/** Highlight color marking the passage currently attached to the assistant. */
const REF_HIGHLIGHT_COLOR = '#ffe690'

/**
 * Render chat message text with inline bold/italic support.
 * Converts **bold** and *italic* markers to React elements while
 * preserving whitespace. No block-level markdown (no lists, headings, etc.).
 */
function InlineMd({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g)
  return (
    <span className="whitespace-pre-wrap">
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i}>{part.slice(2, -2)}</strong>
        }
        if (part.startsWith('*') && part.endsWith('*')) {
          return <em key={i}>{part.slice(1, -1)}</em>
        }
        return <span key={i}>{part}</span>
      })}
    </span>
  )
}

/** Collapsed work-log for agent steps — expands on demand, auto-opens while streaming. */
function ActivityStepsDropdown({ steps }: { steps: AgentActivityStep[] }) {
  const isLive = steps.some((s) => s.status === 'running')
  const [open, setOpen] = useState(isLive)

  useEffect(() => {
    if (isLive) setOpen(true)
    else setOpen(false)
  }, [isLive])

  if (steps.length === 0) return null

  return (
    <div className="agent-steps-dropdown">
      <button
        type="button"
        className="agent-steps-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronDown
          size={10}
          className={`agent-steps-chevron${open ? ' is-open' : ''}`}
        />
        <span>
          {steps.length} step{steps.length === 1 ? '' : 's'}
          {isLive ? '…' : ''}
        </span>
      </button>
      {open && (
        <div className="agent-steps">
          {steps.map((step) => (
            <div key={step.id} className={`agent-step agent-step--${step.status}`}>
              {step.status === 'running' ? (
                <Loader2 size={10} className="animate-spin flex-shrink-0" />
              ) : (
                <Check size={10} className="flex-shrink-0 text-emerald-600/80" />
              )}
              <span>{step.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface AISuggestion {
  id: string
  instruction: string
  diff: DiffChange[]
  accepted: boolean | null
}

interface ReviewState {
  suggestionId: string
  instruction: string
  diff: DiffChange[]
  /** Every suggestion stacked into this review (Cursor-style follow-up edits). */
  stackedIds: string[]
}

interface ChatEntry extends WriteChatMessage {}

function buildEditFallbackMessage(edits: ParsedEdit[]): string {
  if (edits.length === 0) {
    return "Your prose already meets a high standard — I found nothing that demands revision."
  }
  const describe = (e: ParsedEdit) => {
    if (!e.find && e.replace) return `added "${e.replace.slice(0, 48)}${e.replace.length > 48 ? '…' : ''}"`
    if (e.find && !e.replace) return `cut "${e.find.slice(0, 48)}${e.find.length > 48 ? '…' : ''}"`
    return `swapped "${e.find.slice(0, 32)}${e.find.length > 32 ? '…' : ''}" for "${e.replace.slice(0, 32)}${e.replace.length > 32 ? '…' : ''}"`
  }
  const preview = edits.slice(0, 2).map(describe).join('; ')
  const tail = edits.length > 2 ? ` — plus ${edits.length - 2} more tweak${edits.length - 2 === 1 ? '' : 's'}.` : '.'
  return `I've proposed ${edits.length} revision${edits.length === 1 ? '' : 's'}: ${preview}${tail} Approve or decline each one at your discretion.`
}

/** Re-apply the yellow attachment highlight for a passage thread. */
function highlightPassageInEditor(ed: Editor, thread: WriteChatThread) {
  if (!thread.passage) return
  clearReferenceHighlightIn(ed)
  const normalized = thread.passage.replace(/\s+/g, ' ').trim()
  if (
    thread.passageFrom != null &&
    thread.passageTo != null &&
    thread.passageTo > thread.passageFrom
  ) {
    const current = ed.state.doc.textBetween(thread.passageFrom, thread.passageTo, ' ')
    if (current.replace(/\s+/g, ' ').trim() === normalized) {
      ed.chain()
        .setTextSelection({ from: thread.passageFrom, to: thread.passageTo })
        .setHighlight({ color: REF_HIGHLIGHT_COLOR })
        .setTextSelection(thread.passageTo)
        .run()
      return
    }
  }
  const docText = ed.state.doc.textContent.replace(/\s+/g, ' ')
  const idx = docText.indexOf(normalized)
  if (idx === -1) return
  let charCount = 0
  let from = -1
  let to = -1
  ed.state.doc.descendants((node, pos) => {
    if (!node.isText || from !== -1) return
    const text = node.text ?? ''
    const nodeStart = charCount
    charCount += text.length
    if (from === -1 && idx >= nodeStart && idx < charCount) {
      from = pos + (idx - nodeStart)
      to = from + normalized.length
    }
  })
  if (from !== -1 && to > from) {
    ed.chain()
      .setTextSelection({ from, to })
      .setHighlight({ color: REF_HIGHLIGHT_COLOR })
      .setTextSelection(to)
      .run()
  }
}

interface SelectionMenu {
  top: number
  left: number
  text: string
  from: number
  to: number
}

interface TunnelState {
  sentence: string
  contextBefore: string
  contextAfter: string
  from: number
  to: number
}

function htmlHasText(html: string): boolean {
  return html.replace(/<[^>]+>/g, '').trim().length > 0
}

/**
 * Read the document text while a diff review is active.
 * 'original' ignores pending insertions; 'proposed' ignores pending deletions —
 * so follow-up AI edits can stack on the in-flight result, Cursor-style.
 */
function reviewTextFromDoc(ed: Editor, keep: 'original' | 'proposed'): string {
  const parts: string[] = []
  ed.state.doc.forEach((block) => {
    let text = ''
    block.descendants((node) => {
      if (!node.isText) return
      const ins = node.marks.some((m) => m.type.name === 'insertion')
      const del = node.marks.some((m) => m.type.name === 'deletion')
      if (keep === 'original' ? !ins : !del) text += node.text ?? ''
    })
    parts.push(text)
  })
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Remove every attachment-reference highlight mark from the document. */
function clearReferenceHighlightIn(ed: Editor) {
  const { state } = ed
  const type = state.schema.marks.highlight
  if (!type) return
  let tr = state.tr
  let found = false
  state.doc.descendants((node, pos) => {
    if (!node.isText) return
    for (const mark of node.marks) {
      if (mark.type === type && mark.attrs.color === REF_HIGHLIGHT_COLOR) {
        tr = tr.removeMark(pos, pos + node.nodeSize, type)
        found = true
      }
    }
  })
  if (found) ed.view.dispatch(tr)
}

export default function WriteMode() {
  const {
    activeTab: appTab,
    documents, activeDocumentId, apiKey, getFullContext,
    setDocumentContent, setDocumentTitle,
    addDocTab, deleteDocTab, renameDocTab, setActiveDocTab,
    updateActiveTabChat,
    styleRules,
    reinforceStyleRules, addStyleRule, editStyleRule, deleteStyleRule,
  } = useStore()
  const hasApiKey = useHasApiKey()

  const activeDoc = documents.find((d) => d.id === activeDocumentId) ?? documents[0]
  const documentTitle = activeDoc?.title ?? 'Untitled'
  const docTabs = activeDoc?.tabs ?? []
  const activeTabId = activeDoc?.activeTabId ?? null

  const [hydrated, setHydrated] = useState(() => useStore.persist.hasHydrated())
  const [aiPrompt, setAiPrompt] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [suggestions, setSuggestions] = useState<AISuggestion[]>([])
  const [review, setReview] = useState<ReviewState | null>(null)
  const [wordCount, setWordCount] = useState(0)
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenu | null>(null)
  const [tunnel, setTunnel] = useState<TunnelState | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(true)
  const [assistantWidth, setAssistantWidth] = useState(480)
  const railDragRef = useRef<{ startX: number; startW: number; dragged: boolean } | null>(null)
  const [showDocLibrary, setShowDocLibrary] = useState(false)
  const [showContextHouse, setShowContextHouse] = useState(false)
  /** Compose-only floating UI (tabs, dock, assistant, review bar). */
  const composeChromeVisible = appTab === 'write' && !showDocLibrary && !showContextHouse
  const [renamingTab, setRenamingTab] = useState<{ id: string; value: string } | null>(null)
  const [saveStatus, setSaveStatus] = useState<WorkspaceSaveStatus>('idle')

  const skipEmptySaveRef = useRef(true)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const editorScrollRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const reviewActiveRef = useRef(false)
  const reviewStateRef = useRef<ReviewState | null>(null)
  reviewStateRef.current = review
  const finishReviewRef = useRef<() => void>(() => {})
  const chatStateRef = useRef<ChatEntry[]>([])
  /** An unresolved Stylism rule conflict; the writer's next message resolves it. */
  const pendingConflictRef = useRef<{ ruleId: string; question: string } | null>(null)

  const activeTabData = docTabs.find((t) => t.id === activeTabId) ?? null
  const { threads: chatThreads, activeId: activeChatThreadId } = ensureTabChatState(activeTabData)
  const activeChatThread = chatThreads.find((t) => t.id === activeChatThreadId) ?? chatThreads[0]
  const chat = activeChatThread?.messages ?? []
  const attachedSelection = activeChatThread?.passage ?? ''
  chatStateRef.current = chat

  const updateThreadMessages = useCallback(
    (updater: (prev: ChatEntry[]) => ChatEntry[]) => {
      const tab = useStore.getState().getActiveTab()
      const { threads, activeId } = ensureTabChatState(tab)
      const nextThreads = threads.map((t) =>
        t.id === activeId
          ? { ...t, messages: updater(t.messages), updatedAt: Date.now() }
          : t
      )
      updateActiveTabChat({ chatThreads: nextThreads, activeChatThreadId: activeId })
    },
    [updateActiveTabChat]
  )

  const switchChatThread = useCallback(
    (threadId: string) => {
      const tab = useStore.getState().getActiveTab()
      const { threads } = ensureTabChatState(tab)
      updateActiveTabChat({ chatThreads: threads, activeChatThreadId: threadId })
      const thread = threads.find((t) => t.id === threadId)
      const ed = editorRef.current
      if (ed) {
        if (thread?.passage) highlightPassageInEditor(ed, thread)
        else clearReferenceHighlightIn(ed)
      }
    },
    [updateActiveTabChat]
  )

  const deleteChatThread = useCallback(
    (threadId: string) => {
      const tab = useStore.getState().getActiveTab()
      const { threads, activeId } = ensureTabChatState(tab)
      const deletingActive = threadId === activeId
      const idx = threads.findIndex((t) => t.id === threadId)
      if (idx === -1) return

      let nextThreads = threads.filter((t) => t.id !== threadId)
      if (nextThreads.length === 0) nextThreads = [createChatThread([])]

      let nextActiveId = activeId
      if (deletingActive) {
        nextActiveId = nextThreads[Math.min(idx, nextThreads.length - 1)]?.id ?? nextThreads[0].id
      } else if (!nextThreads.some((t) => t.id === activeId)) {
        nextActiveId = nextThreads[0].id
      }

      updateActiveTabChat({ chatThreads: nextThreads, activeChatThreadId: nextActiveId })

      const ed = editorRef.current
      if (ed && !reviewActiveRef.current && deletingActive) {
        const thread = nextThreads.find((t) => t.id === nextActiveId)
        if (thread?.passage) highlightPassageInEditor(ed, thread)
        else clearReferenceHighlightIn(ed)
      }
    },
    [updateActiveTabChat]
  )

  useEffect(() => {
    if (useStore.persist.hasHydrated()) {
      setHydrated(true)
      return
    }
    return useStore.persist.onFinishHydration(() => setHydrated(true))
  }, [])

  useEffect(() => subscribeWorkspaceSaveStatus(setSaveStatus), [])

  useEffect(() => {
    if (!hydrated) return
    if (documents.length > 0) return
    setShowContextHouse(false)
    setShowDocLibrary(true)
  }, [hydrated, documents.length])

  useEffect(() => {
    if (!hydrated) return
    const tab = useStore.getState().getActiveTab()
    if (tab && !tab.chatThreads?.length) {
      const docThread = createChatThread([])
      updateActiveTabChat({ chatThreads: [docThread], activeChatThreadId: docThread.id })
    }
  }, [hydrated, activeDocumentId, activeTabId, updateActiveTabChat])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat, review, isStreaming])

  const syncPromptHeight = useCallback(() => {
    const el = promptRef.current
    if (!el) return
    el.style.height = 'auto'
    const maxHeight = parseFloat(getComputedStyle(el).maxHeight)
    if (Number.isFinite(maxHeight) && el.scrollHeight > maxHeight) {
      el.style.height = `${maxHeight}px`
      el.style.overflowY = 'auto'
    } else {
      el.style.height = `${el.scrollHeight}px`
      el.style.overflowY = 'hidden'
    }
  }, [])

  const focusAssistantInput = useCallback(() => {
    setAssistantOpen(true)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = promptRef.current
        if (!el) return
        el.focus()
        syncPromptHeight()
      })
    })
  }, [syncPromptHeight])

  useEffect(() => {
    syncPromptHeight()
  }, [aiPrompt, syncPromptHeight])

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Underline,
        Highlight.configure({ multicolor: true }),
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Insertion,
        Deletion,
        DiffReviewExt.configure({
          isActive: () => reviewActiveRef.current,
          onResolveHunk: () => {
            const ed = editorRef.current
            if (ed && !docHasDiff(ed.state.doc)) finishReviewRef.current()
          },
        }),
        Placeholder.configure({
          placeholder:
            'Begin composing… Everything in The Context House, your research, and your journal informs every word.',
        }),
      ],
      content: useStore.getState().getActiveTab()?.content ?? '',
      onUpdate: ({ editor: ed }) => {
        // Never persist the transient merged-diff document while reviewing.
        if (reviewActiveRef.current) return
        if (skipEmptySaveRef.current && ed.isEmpty) {
          const stored = useStore.getState().getActiveTab()?.content ?? ''
          if (htmlHasText(stored)) return
        }
        skipEmptySaveRef.current = false
        setDocumentContent(ed.getHTML())
        setWordCount(ed.getText().split(/\s+/).filter(Boolean).length)
      },
    },
    [hydrated]
  )

  useEffect(() => {
    editorRef.current = editor
  }, [editor])

  useEffect(() => {
    if (!editor || !hydrated) return
    const stored = useStore.getState().getActiveTab()?.content ?? ''
    if (stored && editor.isEmpty) {
      skipEmptySaveRef.current = true
      editor.commands.setContent(stored, false)
      skipEmptySaveRef.current = false
    }
    clearReferenceHighlightIn(editor) // drop any stale attachment marks from a prior session
    setWordCount(editor.getText().split(/\s+/).filter(Boolean).length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, hydrated])

  /* ── Load the newly active document/tab into the editor when it changes ── */
  const loadedKeyRef = useRef<string | null>(null)
  const activeKey = `${activeDocumentId}:${activeTabId}`
  useEffect(() => {
    if (!editor || !hydrated) return
    if (loadedKeyRef.current === null) {
      loadedKeyRef.current = activeKey
      return
    }
    if (loadedKeyRef.current === activeKey) return
    loadedKeyRef.current = activeKey
    const tab = useStore.getState().getActiveTab()
    skipEmptySaveRef.current = true
    editor.commands.setContent(tab?.content ?? '', false)
    skipEmptySaveRef.current = false
    setWordCount(editor.getText().split(/\s+/).filter(Boolean).length)
    setSelectionMenu(null)
    const { threads, activeId } = ensureTabChatState(tab)
    const thread = threads.find((t) => t.id === activeId)
    if (thread?.passage) highlightPassageInEditor(editor, thread)
    else clearReferenceHighlightIn(editor)
  }, [activeKey, editor, hydrated])

  useEffect(() => {
    return () => {
      if (editor && !editor.isDestroyed && !editor.isEmpty && !reviewActiveRef.current) {
        setDocumentContent(editor.getHTML())
      }
    }
  }, [editor, setDocumentContent])

  /* ── Floating selection toolbar ── */
  useEffect(() => {
    if (!editor) return
    const update = () => {
      if (!editor.isEditable && !reviewActiveRef.current) {
        setSelectionMenu(null)
        return
      }
      const { from, to } = editor.state.selection
      if (from === to) {
        setSelectionMenu(null)
        return
      }
      const text = editor.state.doc.textBetween(from, to, ' ').trim()
      if (!text) {
        setSelectionMenu(null)
        return
      }
      try {
        const start = editor.view.coordsAtPos(from)
        const end = editor.view.coordsAtPos(to)
        setSelectionMenu({
          top: Math.min(start.top, end.top),
          left: (start.left + end.left) / 2,
          text,
          from,
          to,
        })
      } catch {
        setSelectionMenu(null)
      }
    }
    editor.on('selectionUpdate', update)
    return () => {
      editor.off('selectionUpdate', update)
    }
  }, [editor])

  useEffect(() => {
    if (showDocLibrary || showContextHouse || tunnel) setSelectionMenu(null)
  }, [showDocLibrary, showContextHouse, tunnel])

  /* ── Attachment reference highlight ──
     When a passage is attached to the assistant, it stays visibly highlighted
     in the editor so the writer always knows what they're referencing. */
  const attachSelection = useCallback((text: string, from?: number, to?: number) => {
    const tab = useStore.getState().getActiveTab()
    const { threads, activeId } = ensureTabChatState(tab)
    const trimmed = text.trim()
    if (!trimmed) return

    if (reviewActiveRef.current) {
      const newThread = createChatThread(threads)
      const passageThread: WriteChatThread = {
        ...newThread,
        label: trimmed.length > 26 ? `${trimmed.slice(0, 26)}…` : trimmed,
        passage: trimmed,
        passageFrom: from,
        passageTo: to,
        updatedAt: Date.now(),
      }
      updateActiveTabChat({
        chatThreads: [...threads, passageThread],
        activeChatThreadId: passageThread.id,
      })
      const ed = editorRef.current
      if (ed) highlightPassageInEditor(ed, passageThread)
      focusAssistantInput()
      return
    }

    const nextThreads = threads.map((t) =>
      t.id === activeId
        ? { ...t, passage: trimmed, passageFrom: from, passageTo: to, updatedAt: Date.now() }
        : t
    )
    updateActiveTabChat({ chatThreads: nextThreads, activeChatThreadId: activeId })

    const ed = editorRef.current
    const thread = nextThreads.find((t) => t.id === activeId)
    if (ed && thread) highlightPassageInEditor(ed, thread)
    focusAssistantInput()
  }, [updateActiveTabChat, focusAssistantInput])

  /* ── Finalize a review once all hunks are resolved ── */
  const finishReview = useCallback(() => {
    const ed = editorRef.current
    if (!ed) return
    reviewActiveRef.current = false
    ed.setEditable(true)
    clearReferenceHighlightIn(ed)
    applyRichFormattingToEditor(ed, () => {
      skipEmptySaveRef.current = true
    }, () => {
      skipEmptySaveRef.current = false
    })
    const html = ed.getHTML()
    setDocumentContent(html)
    setWordCount(ed.getText().split(/\s+/).filter(Boolean).length)
    setReview(null)
    const tab = useStore.getState().getActiveTab()
    const { threads, activeId } = ensureTabChatState(tab)
    const thread = threads.find((t) => t.id === activeId)
    if (thread?.passage) highlightPassageInEditor(ed, thread)
  }, [setDocumentContent])

  useEffect(() => {
    finishReviewRef.current = finishReview
  }, [finishReview])

  const enterReview = useCallback(
    (currentText: string, newText: string, instruction: string, assistantMessage?: string, edits?: ParsedEdit[]) => {
      const ed = editorRef.current
      if (!ed) return
      const diff = diffWords(currentText, newText) as DiffChange[]
      const html = diffToHtml(diff)
      const id = (Date.now() + 1).toString()
      // Follow-up edits during an open review stack onto it, Cursor-style.
      const stackedIds = reviewActiveRef.current && reviewStateRef.current
        ? [...reviewStateRef.current.stackedIds, id]
        : [id]

      reviewActiveRef.current = true
      skipEmptySaveRef.current = true
      ed.commands.setContent(html, false)
      skipEmptySaveRef.current = false
      ed.setEditable(false)
      // Nudge the view so the diff-widget decorations paint immediately.
      ed.view.dispatch(ed.state.tr.setMeta('diff-refresh', true))

      setSuggestions((prev) => [
        { id, instruction, diff, accepted: null },
        ...prev.slice(0, 9),
      ])
      setReview({ suggestionId: id, instruction, diff, stackedIds })

      const tab = useStore.getState().getActiveTab()
      const { threads, activeId } = ensureTabChatState(tab)
      const message =
        assistantMessage?.trim() ||
        (edits ? buildEditFallbackMessage(edits) : 'Here are the edits — accept or reject each one inline.')
      const nextThreads = threads.map((t) =>
        t.id === activeId
          ? {
              ...t,
              messages: [
                ...t.messages,
                { id, role: 'assistant' as const, content: message, suggestionId: id },
              ],
              updatedAt: Date.now(),
            }
          : t
      )
      updateActiveTabChat({ chatThreads: nextThreads, activeChatThreadId: activeId })
    },
    [updateActiveTabChat]
  )

  /** Localized diff review for a single passage (refine apply → inline accept/reject). */
  const enterPassageReview = useCallback(
    (from: number, to: number, originalText: string, newText: string, instruction: string) => {
      const ed = editorRef.current
      if (!ed) return
      const cleaned = normalizeAiResponse(newText)
      const proposed = looksLikeMarkdown(cleaned)
        ? cleaned.replace(/<[^>]+>/g, '').trim()
        : cleaned.trim()
      if (!proposed || proposed === originalText.trim()) return

      const diff = diffWords(originalText, proposed) as DiffChange[]
      const inlineHtml = diffToInlineHtml(diff)
      const id = (Date.now() + 1).toString()
      const stackedIds = reviewActiveRef.current && reviewStateRef.current
        ? [...reviewStateRef.current.stackedIds, id]
        : [id]

      reviewActiveRef.current = true
      skipEmptySaveRef.current = true
      ed.chain().focus().insertContentAt({ from, to }, inlineHtml).run()
      skipEmptySaveRef.current = false
      ed.setEditable(false)
      ed.view.dispatch(ed.state.tr.setMeta('diff-refresh', true))

      setSuggestions((prev) => [
        { id, instruction, diff, accepted: null },
        ...prev.slice(0, 9),
      ])
      setReview({ suggestionId: id, instruction, diff, stackedIds })

      const tab = useStore.getState().getActiveTab()
      const { threads, activeId } = ensureTabChatState(tab)
      const nextThreads = threads.map((t) =>
        t.id === activeId
          ? {
              ...t,
              messages: [
                ...t.messages,
                {
                  id,
                  role: 'assistant' as const,
                  content: 'Refinement ready — approve or decline each change inline in the document.',
                  suggestionId: id,
                },
              ],
              updatedAt: Date.now(),
            }
          : t
      )
      updateActiveTabChat({ chatThreads: nextThreads, activeChatThreadId: activeId })

      requestAnimationFrame(() => {
        try {
          const coords = ed.view.coordsAtPos(from)
          const scrollEl = editorScrollRef.current
          if (scrollEl) {
            const scrollRect = scrollEl.getBoundingClientRect()
            const targetTop = scrollEl.scrollTop + coords.top - scrollRect.top - 80
            scrollEl.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
          }
        } catch {
          /* coords unavailable */
        }
      })
    },
    [updateActiveTabChat]
  )

  /** Refresh the diff view as streamed edits land one at a time. */
  const updateProgressiveReview = useCallback(
    (baseText: string, proposedText: string, instruction: string, reviewId: string, isFirst: boolean) => {
      const ed = editorRef.current
      if (!ed) return
      const diff = diffWords(baseText, proposedText) as DiffChange[]
      const html = diffToHtml(diff)

      reviewActiveRef.current = true
      skipEmptySaveRef.current = true
      ed.commands.setContent(html, false)
      skipEmptySaveRef.current = false
      ed.setEditable(false)
      ed.view.dispatch(ed.state.tr.setMeta('diff-refresh', true))

      if (isFirst) {
        setSuggestions((prev) => [
          { id: reviewId, instruction, diff, accepted: null },
          ...prev.slice(0, 9),
        ])
        setReview({ suggestionId: reviewId, instruction, diff, stackedIds: [reviewId] })
      } else {
        setSuggestions((prev) =>
          prev.map((s) => (s.id === reviewId ? { ...s, diff } : s))
        )
        setReview((prev) => (prev ? { ...prev, diff } : prev))
      }
    },
    []
  )

  const acceptAll = useCallback(() => {
    const ed = editorRef.current
    if (!ed || !review) return
    resolveRange(ed.view, 0, ed.state.doc.content.size, 'accept')
    setSuggestions((prev) =>
      prev.map((s) => (review.stackedIds.includes(s.id) ? { ...s, accepted: true } : s))
    )
    finishReview()
  }, [review, finishReview])

  const rejectAll = useCallback(() => {
    const ed = editorRef.current
    if (!ed || !review) return
    resolveRange(ed.view, 0, ed.state.doc.content.size, 'reject')
    setSuggestions((prev) =>
      prev.map((s) => (review.stackedIds.includes(s.id) ? { ...s, accepted: false } : s))
    )
    finishReview()
  }, [review, finishReview])

  /* ── Stylism network maintenance ── */

  const postStyleMessage = useCallback((content: string) => {
    updateThreadMessages((prev) => [
      ...prev,
      { id: `style-${Date.now()}`, role: 'assistant', content, kind: 'style' },
    ])
  }, [updateThreadMessages])

  const applyStyleActions = useCallback(
    (actions: StyleAgentAction[]): string[] => {
      const rules = useStore.getState().styleRules
      const labelOf = (id: string) => rules.find((r) => r.id === id)?.label ?? 'a rule'
      const summary: string[] = []

      // Reinforce before create so the birth animation wins the final frame.
      for (const a of actions) {
        if (a.type !== 'reinforce' || a.ruleIds.length === 0) continue
        reinforceStyleRules(a.ruleIds)
        summary.push(`reinforced ${a.ruleIds.map((id) => `“${labelOf(id)}”`).join(', ')}`)
      }
      for (const a of actions) {
        switch (a.type) {
          case 'create':
            if (a.instruction.trim()) {
              addStyleRule({
                label: a.label,
                instruction: a.instruction,
                relatedRuleIds: a.relatedRuleIds,
                source: 'ai',
              })
              summary.push(`new rule “${a.label}”`)
            }
            break
          case 'edit':
            if (a.ruleId && a.instruction) {
              summary.push(`updated “${labelOf(a.ruleId)}”`)
              editStyleRule(a.ruleId, {
                instruction: a.instruction,
                ...(a.label ? { label: a.label } : {}),
              })
            }
            break
          case 'delete':
            if (a.ruleId) {
              summary.push(`removed “${labelOf(a.ruleId)}”`)
              deleteStyleRule(a.ruleId)
            }
            break
        }
      }
      return summary
    },
    [reinforceStyleRules, addStyleRule, editStyleRule, deleteStyleRule]
  )

  /**
   * After each exchange, the same Claude decides (via tools) whether the
   * writer's message was stylistic feedback and updates the network. Runs in
   * the background; failures are silent so writing flow is never blocked.
   */
  const maintainStyleNetwork = useCallback(
    async (instruction: string) => {
      if (!hasApiKey) return
      try {
        const rules = useStore.getState().styleRules
        const conflict = pendingConflictRef.current
        let result: StyleAgentResult

        if (conflict) {
          pendingConflictRef.current = null
          result = await runConflictResolutionTurn({
            apiKey,
            rules,
            conflictRuleId: conflict.ruleId,
            conflictQuestion: conflict.question,
            reply: instruction,
          })
        } else {
          result = await runStyleAgentTurn({
            apiKey,
            rules,
            instruction,
            recentChat: chatStateRef.current
              .filter((m) => m.kind !== 'style')
              .map((m) => ({ role: m.role, content: m.content })),
          })
        }

        const newConflict = result.actions.find((a) => a.type === 'conflict')
        const summary = applyStyleActions(result.actions)

        if (newConflict && newConflict.type === 'conflict') {
          const question =
            result.text ||
            `That counters your existing rule “${
              rules.find((r) => r.id === newConflict.ruleId)?.label ?? newConflict.ruleId
            }”. Should I edit it, make it more specific, or delete it?`
          pendingConflictRef.current = { ruleId: newConflict.ruleId, question }
          postStyleMessage(question)
        } else if (result.text) {
          postStyleMessage(result.text)
        } else if (summary.length > 0) {
          postStyleMessage(`Voice updated: ${summary.join(' · ')}.`)
        }
      } catch {
        // Network upkeep must never interrupt the writing flow.
      }
    },
    [apiKey, hasApiKey, applyStyleActions, postStyleMessage]
  )

  const handleAIAssist = useCallback(async (override?: string) => {
    const instruction = (typeof override === 'string' ? override : aiPrompt).trim()
    if (!instruction || !hasApiKey || !editor) return

    const userEntryId = Date.now().toString()
    updateThreadMessages((prev) => [...prev, { id: userEntryId, role: 'user', content: instruction }])
    if (typeof override !== 'string') setAiPrompt('')
    setIsStreaming(true)

    const passage = attachedSelection
    const inReview = reviewActiveRef.current
    const currentText = inReview
      ? reviewTextFromDoc(editor, 'proposed')
      : editor.getText({ blockSeparator: '\n\n' })
    const baseText = inReview ? reviewTextFromDoc(editor, 'original') : currentText
    const context = getFullContext()
    const styleGuide = compileStyleGuide(styleRules)
    const isEmptyDoc = currentText.trim().length === 0

    const historyForApi = chatStateRef.current
      .filter((m) => m.kind !== 'style' && m.kind !== 'agent' && m.id !== userEntryId)
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }))

    const system = isEmptyDoc
      ? `You are an expert writing assistant helping a writer draft prose. Be conversational and helpful.

Return ONLY a JSON object, no code fences:
{"message":"<one short sentence — what you wrote and why>","content":"<clean prose, paragraphs separated by blank lines>"}

The "message" is shown in chat: one sentence, direct, no lists, no em dashes, no bold. Speak like a human, not an AI status report.
JSON safety: never put a literal newline inside a string value — use \\n if needed.
Write plain prose only in "content" — no Markdown symbols.

${styleGuide ? styleGuide + '\n\n' : ''}${context ? `=== WRITER'S RESEARCH CONTEXT ===\n${context.slice(0, 4000)}` : ''}`
      : buildAgentStreamSystemPrompt({
          context,
          styleGuide,
          scope: passage ? 'passage' : 'document',
        })

    const user = isEmptyDoc
      ? `The document is empty.\n\nINSTRUCTION: ${instruction}`
      : `CURRENT DOCUMENT:
"""
${currentText.slice(0, 8000)}
"""
${
  passage
    ? `\nSELECTED PASSAGE:\n"""${passage.slice(0, 2000)}"""\nFor edits: work within this passage. For created content: it will be inserted after this passage.\n`
    : ''
}
INSTRUCTION: ${instruction}`

    const activityId = (Date.now() + 1).toString()
    let raw = ''
    let steps: AgentActivityStep[] = []
    let editsApplied = 0
    let proposedText = currentText
    let finalMessage = ''
    let streamMode: 'edit' | 'chat' | 'create' | null = null
    let reviewStarted = false

    const upsertActivity = (content: string, extra?: Partial<WriteChatMessage>) => {
      updateThreadMessages((prev) => {
        const without = prev.filter((m) => m.id !== activityId)
        return [
          ...without,
          {
            id: activityId,
            role: 'assistant' as const,
            kind: 'agent' as const,
            content,
            activity: [...steps],
            editsApplied,
            ...extra,
          },
        ]
      })
    }

    const pushStep = (text: string) => {
      steps = [
        ...steps.map((s) => ({ ...s, status: 'done' as const })),
        { id: `step-${steps.length}`, text, status: 'running' as const },
      ]
      upsertActivity(finalMessage || text)
    }

    const finishSteps = () => {
      steps = steps.map((s) => ({ ...s, status: 'done' as const }))
    }

    const parser = !isEmptyDoc
      ? createAgentStreamParser((event) => {
          if (event.type === 'step') {
            pushStep(event.text)
            return
          }

          if (event.type === 'edit') {
            streamMode = 'edit'
            const result = applyEdits(proposedText, [event.edit])
            if (result.applied === 0) return
            proposedText = result.text
            editsApplied++
            updateProgressiveReview(
              baseText,
              proposedText,
              instruction,
              activityId,
              !reviewStarted
            )
            reviewStarted = true
            if (event.note) {
              const noteStep = steps.find((s) => s.status === 'running')
              if (noteStep) noteStep.text = `${noteStep.text} — ${event.note}`
            }
            upsertActivity(
              finalMessage || `Applying edit ${editsApplied}…`
            )
            return
          }

          if (event.type === 'create') {
            streamMode = 'create'
            let newText: string
            if (passage) {
              const passageIdx = currentText.indexOf(passage)
              if (passageIdx !== -1) {
                const insertPos = passageIdx + passage.length
                newText =
                  currentText.slice(0, insertPos) +
                  '\n\n' +
                  event.content +
                  currentText.slice(insertPos)
              } else {
                newText = currentText + '\n\n' + event.content
              }
            } else {
              newText = currentText + '\n\n' + event.content
            }
            proposedText = newText
            editsApplied++
            updateProgressiveReview(baseText, proposedText, instruction, activityId, !reviewStarted)
            reviewStarted = true
            upsertActivity(finalMessage || 'Drafting new content…')
            return
          }

          if (event.type === 'message') {
            finalMessage = event.text
            upsertActivity(finalMessage)
            return
          }

          if (event.type === 'chat') {
            streamMode = 'chat'
            finalMessage = event.text
            finishSteps()
            upsertActivity(finalMessage)
          }
        })
      : null

    const finalizeStream = () => {
      setIsStreaming(false)
      raw = normalizeAiResponse(raw)
      finishSteps()

      if (isEmptyDoc) {
        const drafted = parseDraftResponse(raw)
        if (!drafted?.content) {
          updateThreadMessages((prev) => [
            ...prev.filter((m) => m.id !== activityId),
            {
              id: (Date.now() + 2).toString(),
              role: 'assistant',
              content: looksLikeJsonResponse(raw)
                ? "I couldn't read that draft cleanly — please try again."
                : 'Nothing was generated — try again.',
            },
          ])
          return
        }
        enterReview(baseText, drafted.content, instruction, drafted.message)
        return
      }

      if (streamMode === 'chat') {
        updateThreadMessages((prev) =>
          prev.map((m) =>
            m.id === activityId
              ? { ...m, kind: undefined, content: finalMessage || m.content }
              : m
          )
        )
        return
      }

      if (reviewStarted && (streamMode === 'edit' || streamMode === 'create')) {
        const message =
          finalMessage?.trim() ||
          (editsApplied > 0
            ? `I've proposed ${editsApplied} revision${editsApplied === 1 ? '' : 's'}. Approve or decline each one at your discretion.`
            : 'Here are the edits — accept or reject each one inline.')
        updateThreadMessages((prev) =>
          prev.map((m) =>
            m.id === activityId
              ? {
                  ...m,
                  kind: undefined,
                  content: message,
                  suggestionId: activityId,
                  activity: steps,
                }
              : m
          )
        )
        return
      }

      // Fallback: model didn't stream NDJSON — parse full response
      const agentResp = parseAgentResponse(raw)
      if (agentResp) {
        if (agentResp.type === 'chat') {
          updateThreadMessages((prev) => [
            ...prev.filter((m) => m.id !== activityId),
            { id: (Date.now() + 2).toString(), role: 'assistant', content: agentResp.message },
          ])
          return
        }
        if (agentResp.type === 'create') {
          let newText: string
          if (passage) {
            const passageIdx = currentText.indexOf(passage)
            if (passageIdx !== -1) {
              const insertPos = passageIdx + passage.length
              newText =
                currentText.slice(0, insertPos) +
                '\n\n' +
                agentResp.content +
                currentText.slice(insertPos)
            } else {
              newText = currentText + '\n\n' + agentResp.content
            }
          } else {
            newText = currentText + '\n\n' + agentResp.content
          }
          enterReview(baseText, newText, instruction, agentResp.message)
          return
        }
        if (agentResp.type === 'edit') {
          if (agentResp.edits.length === 0) {
            updateThreadMessages((prev) => [
              ...prev.filter((m) => m.id !== activityId),
              {
                id: (Date.now() + 2).toString(),
                role: 'assistant',
                content: agentResp.message?.trim() || 'No changes needed — your text already works here.',
              },
            ])
            return
          }
          const newText = applyEdits(currentText, agentResp.edits).text
          if (!newText.trim() || newText.trim() === currentText.trim()) {
            updateThreadMessages((prev) => [
              ...prev.filter((m) => m.id !== activityId),
              {
                id: (Date.now() + 2).toString(),
                role: 'assistant',
                content: agentResp.message?.trim() || 'No changes needed — your text already works here.',
              },
            ])
            return
          }
          enterReview(baseText, newText, instruction, agentResp.message, agentResp.edits)
          return
        }
      }

      const parsed = parseEditResponse(raw)
      if (parsed) {
        if (parsed.edits.length === 0) {
          updateThreadMessages((prev) => [
            ...prev.filter((m) => m.id !== activityId),
            {
              id: (Date.now() + 2).toString(),
              role: 'assistant',
              content: parsed.message?.trim() || 'No changes needed — your text already works here.',
            },
          ])
          return
        }
        const newText = applyEdits(currentText, parsed.edits).text
        if (newText.trim() && newText.trim() !== currentText.trim()) {
          enterReview(baseText, newText, instruction, parsed.message, parsed.edits)
          return
        }
      }

      updateThreadMessages((prev) => [
        ...prev.filter((m) => m.id !== activityId),
        {
          id: (Date.now() + 2).toString(),
          role: 'assistant',
          content: looksLikeJsonResponse(raw)
            ? "I couldn't apply that cleanly — please try again."
            : 'No changes needed — your text already works here.',
        },
      ])
    }

    if (!isEmptyDoc) {
      pushStep('Reading your request')
    }

    await streamChat(
      [...historyForApi, { role: 'user', content: user }],
      system,
      apiKey,
      (chunk) => {
        raw += chunk
        parser?.feed(chunk)
      },
      finalizeStream,
      (errMessage) => {
        setIsStreaming(false)
        updateThreadMessages((prev) => [
          ...prev.filter((m) => m.id !== activityId),
          { id: (Date.now() + 2).toString(), role: 'assistant', content: `⚠️ ${errMessage}. Please try again.` },
        ])
      }
    )

    void maintainStyleNetwork(instruction)
  }, [aiPrompt, apiKey, hasApiKey, editor, getFullContext, styleRules, attachedSelection, enterReview, updateProgressiveReview, maintainStyleNetwork, updateThreadMessages])

  /* ── Onboarding command hooks ── */
  const handleAIAssistRef = useRef(handleAIAssist)
  useEffect(() => {
    handleAIAssistRef.current = handleAIAssist
  }, [handleAIAssist])

  useEffect(() => {
    const unLib = registerOnboardingCommand('openDocLibrary', () => {
      setShowContextHouse(false)
      setAssistantOpen(false)
      setShowDocLibrary(true)
    })
    const unCtx = registerOnboardingCommand('openContextHouse', () => {
      setShowDocLibrary(false)
      setAssistantOpen(false)
      setShowContextHouse(true)
    })
    const unClose = registerOnboardingCommand('closeWritePanels', () => {
      setShowDocLibrary(false)
      setShowContextHouse(false)
      setAssistantOpen(true)
    })
    const unSummary = registerOnboardingCommand('writeContextSummary', () => {
      setShowDocLibrary(false)
      setShowContextHouse(false)
      setAssistantOpen(true)
      // Give the editor a beat to remount/clear before the empty-doc draft path.
      setTimeout(() => {
        void handleAIAssistRef.current(
          'Compose an opening summary from the materials in The Context House to begin this document.'
        )
      }, 250)
    })
    return () => {
      unLib()
      unCtx()
      unClose()
      unSummary()
    }
  }, [])

  /* ── Inline refine mode ── */
  const closeRefine = useCallback(() => {
    setTunnel(null)
  }, [])

  const openTunnel = useCallback(
    (from: number, to: number, text: string) => {
      if (reviewActiveRef.current) return
      const ed = editorRef.current
      if (!ed) return
      const size = ed.state.doc.content.size
      const contextBefore = ed.state.doc.textBetween(Math.max(0, from - 400), from, ' ')
      const contextAfter = ed.state.doc.textBetween(to, Math.min(size, to + 400), ' ')
      setSelectionMenu(null)
      setAssistantOpen(true)
      setTunnel({ sentence: text, contextBefore, contextAfter, from, to })
    },
    []
  )

  const applyTunnel = useCallback(
    (newText: string) => {
      const ed = editorRef.current
      if (!ed || !tunnel) return
      const originalText = ed.state.doc.textBetween(tunnel.from, tunnel.to, ' ')
      setTunnel(null)
      enterPassageReview(tunnel.from, tunnel.to, originalText, newText, 'Refine passage')
    },
    [tunnel, enterPassageReview]
  )

  /* ── Global keyboard ── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 's') {
        // Saving is live; just swallow the browser dialog.
        e.preventDefault()
        const ed = editorRef.current
        if (ed && !reviewActiveRef.current) setDocumentContent(ed.getHTML())
        return
      }
      if (e.key === 'Escape') {
        if (tunnel) { closeRefine(); return }
        if (showDocLibrary) { setShowDocLibrary(false); return }
        if (showContextHouse) { setShowContextHouse(false); return }
        if (reviewActiveRef.current) rejectAll()
        return
      }
      if (reviewActiveRef.current && mod && e.key === 'Enter') {
        e.preventDefault()
        acceptAll()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setDocumentContent, tunnel, closeRefine, acceptAll, rejectAll, showDocLibrary, showContextHouse])

  /* ── Drag selection into prompt ── */
  const handlePromptDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const text =
      e.dataTransfer.getData('text/plain') ||
      window.getSelection()?.toString() ||
      ''
    const trimmed = text.trim()
    if (!trimmed) return
    // If the drag came from the editor, its selection still marks the range.
    const sel = editorRef.current?.state.selection
    if (sel && !sel.empty) attachSelection(trimmed, sel.from, sel.to)
    else attachSelection(trimmed)
  }

  /* ── Document tabs (Google-Docs-style sub-documents) ── */
  const persistEditorContent = () => {
    const ed = editorRef.current
    if (ed && !reviewActiveRef.current) {
      clearReferenceHighlightIn(ed)
      setDocumentContent(ed.getHTML())
    }
  }

  const switchTab = (id: string) => {
    if (id === activeTabId || reviewActiveRef.current) return
    persistEditorContent()
    setActiveDocTab(id)
  }

  const handleNewTab = () => {
    if (reviewActiveRef.current) return
    persistEditorContent()
    addDocTab()
  }

  const commitTabRename = () => {
    if (renamingTab) {
      renameDocTab(renamingTab.id, renamingTab.value.trim())
      setRenamingTab(null)
    }
  }

  const ASSISTANT_WIDTH_MIN = 400
  const ASSISTANT_WIDTH_MAX = 560

  const onRailPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    railDragRef.current = {
      startX: e.clientX,
      startW: assistantOpen ? assistantWidth : ASSISTANT_WIDTH_MIN,
      dragged: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onRailPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = railDragRef.current
    if (!drag) return
    const delta = drag.startX - e.clientX
    if (Math.abs(delta) > 4) drag.dragged = true
    if (!drag.dragged) return
    if (!assistantOpen) setAssistantOpen(true)
    setAssistantWidth(
      Math.min(ASSISTANT_WIDTH_MAX, Math.max(ASSISTANT_WIDTH_MIN, drag.startW + delta))
    )
  }

  const onRailPointerUp = () => {
    const drag = railDragRef.current
    railDragRef.current = null
    if (drag && !drag.dragged) setAssistantOpen((v) => !v)
  }

  const writeModeStyle = {
    '--assistant-rail-offset': assistantOpen
      ? `calc(0.75rem + 12px + ${assistantWidth}px)`
      : 'calc(0.75rem + 12px)',
  } as CSSProperties

  const assistantPanelInner = (
    <>
      {chatThreads.length > 0 && (
        <div className="assistant-thread-bar">
          {chatThreads.map((thread) => (
            <div
              key={thread.id}
              role="tab"
              aria-selected={thread.id === activeChatThreadId}
              className={`assistant-thread-pill${thread.id === activeChatThreadId ? ' active' : ''}`}
              onClick={() => switchChatThread(thread.id)}
              title={
                thread.passage
                  ? `${thread.label} — focused on: ${thread.passage.slice(0, 120)}`
                  : thread.label
              }
            >
              <span className="assistant-thread-pill-label">{thread.label}</span>
              <button
                type="button"
                className="assistant-thread-pill-close"
                title="Delete chat"
                aria-label={`Delete ${thread.label}`}
                onClick={(e) => {
                  e.stopPropagation()
                  deleteChatThread(thread.id)
                }}
              >
                <X size={9} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="assistant-thread-pill assistant-thread-pill-add"
            onClick={() => {
              const tab = useStore.getState().getActiveTab()
              const { threads } = ensureTabChatState(tab)
              const newThread = createChatThread(threads)
              updateActiveTabChat({
                chatThreads: [...threads, newThread],
                activeChatThreadId: newThread.id,
              })
              const ed = editorRef.current
              if (ed && !reviewActiveRef.current) clearReferenceHighlightIn(ed)
            }}
            title="New chat"
          >
            <Plus size={11} />
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-3 pt-3 pb-3 space-y-3 min-h-0">
        {chat.map((entry) => {
          const suggestion = entry.suggestionId
            ? suggestions.find((s) => s.id === entry.suggestionId)
            : undefined

          return (
            <div key={entry.id} className="space-y-2">
              <div className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`chat-bubble ${
                    entry.role === 'user'
                      ? 'chat-bubble-user'
                      : entry.kind === 'style'
                      ? 'chat-bubble-style'
                      : 'chat-bubble-ai'
                  }`}
                >
                  {entry.kind === 'style' && (
                    <p className="mb-1 text-[10px] font-semibold text-violet-700/70">Voice</p>
                  )}
                  {entry.content && <p><InlineMd text={entry.content} /></p>}
                  {entry.activity && entry.activity.length > 0 && (
                    <ActivityStepsDropdown steps={entry.activity} />
                  )}
                  {entry.role === 'assistant' && suggestion?.accepted === true && (
                    <p className="mt-1.5 flex items-center gap-1 text-[10px] text-green-700">
                      <Check size={10} /> Applied
                    </p>
                  )}
                  {entry.role === 'assistant' && suggestion?.accepted === false && (
                    <p className="mt-1.5 flex items-center gap-1 text-[10px] text-black/40">
                      <X size={10} /> Rejected
                    </p>
                  )}
                </div>
              </div>
            </div>
          )
        })}

        {isStreaming && !chat.some((m) => m.kind === 'agent') && (
          <div className="flex justify-start">
            <div className="chat-bubble chat-bubble-ai">
              <div className="flex items-center gap-2 text-black/40">
                <Loader2 size={12} className="animate-spin" />
                Working…
              </div>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      <div
        className={`assistant-input-zone ${dragOver ? 'prompt-dropzone-active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handlePromptDrop}
      >
        {dragOver && <div className="prompt-drop-hint">Release to attach passage</div>}

        <div className="assistant-input-bar">
          <textarea
            ref={promptRef}
            value={aiPrompt}
            onChange={(e) => {
              setAiPrompt(e.target.value)
              requestAnimationFrame(syncPromptHeight)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleAIAssist()
              }
            }}
            rows={1}
            placeholder={
              attachedSelection
                ? 'How should this passage be refined?'
                : 'Request revisions or converse with your editor…'
            }
            className="assistant-textarea"
            disabled={isStreaming}
          />
          {isStreaming ? (
            <Loader2 size={14} className="assistant-input-spinner animate-spin flex-shrink-0" />
          ) : (
            <button
              type="button"
              className="glass-btn assistant-send-btn"
              onClick={() => handleAIAssist()}
              disabled={!aiPrompt.trim() || !hasApiKey}
              title="Send message"
              aria-label="Send message"
            >
              <Send size={14} />
            </button>
          )}
        </div>
      </div>
    </>
  )

  if (!hydrated) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-black/40">
        Loading document…
      </div>
    )
  }

  return (
    <div
      className={`write-mode h-full relative overflow-hidden${composeChromeVisible && assistantOpen ? ' assistant-open' : ''}`}
      style={writeModeStyle}
    >
      <div className="h-full flex flex-col overflow-hidden">
        {!showDocLibrary && !showContextHouse && (
          <div className="flex-shrink-0 flex items-center justify-between border-b border-black/8 bg-white/30 backdrop-blur px-4 py-2">
            <div className="flex items-center gap-1 min-w-0">
              <button
                onClick={() => { setShowDocLibrary(true); setAssistantOpen(false) }}
                className="rounded-lg p-1.5 text-black/35 transition hover:bg-black/5 hover:text-black/60 flex-shrink-0"
                title="Document library"
                data-tour="doclibrary"
              >
                <LayoutGrid size={14} />
              </button>
              <input
                value={documentTitle}
                onChange={(e) => setDocumentTitle(e.target.value)}
                className="write-doc-title"
                placeholder="Untitled"
              />
              <span className="text-black/15 mx-2">|</span>
              <button
                onClick={() => editor?.chain().focus().undo().run()}
                disabled={!editor?.can().undo()}
                title="Undo (Ctrl+Z)"
                className="rounded-lg p-1.5 text-black/40 transition hover:bg-black/5 hover:text-black/70 disabled:opacity-25"
              >
                <Undo2 size={14} />
              </button>
              <button
                onClick={() => editor?.chain().focus().redo().run()}
                disabled={!editor?.can().redo()}
                title="Redo (Ctrl+Shift+Z)"
                className="rounded-lg p-1.5 text-black/40 transition hover:bg-black/5 hover:text-black/70 disabled:opacity-25"
              >
                <Redo2 size={14} />
              </button>
              <span className="text-black/10 mx-1">|</span>
              {[
                { icon: <Bold size={14} />, action: () => editor?.chain().focus().toggleBold().run(), active: editor?.isActive('bold') },
                { icon: <Italic size={14} />, action: () => editor?.chain().focus().toggleItalic().run(), active: editor?.isActive('italic') },
                { icon: <UnderlineIcon size={14} />, action: () => editor?.chain().focus().toggleUnderline().run(), active: editor?.isActive('underline') },
              ].map((btn, i) => (
                <button
                  key={i}
                  onClick={btn.action}
                  className={`rounded-lg p-1.5 transition ${btn.active ? 'bg-black/10 text-black/80' : 'text-black/40 hover:bg-black/5 hover:text-black/70'}`}
                >
                  {btn.icon}
                </button>
              ))}
              <span className="text-black/10 mx-1">|</span>
              {[
                { icon: <AlignLeft size={14} />, action: () => editor?.chain().focus().setTextAlign('left').run() },
                { icon: <AlignCenter size={14} />, action: () => editor?.chain().focus().setTextAlign('center').run() },
                { icon: <AlignRight size={14} />, action: () => editor?.chain().focus().setTextAlign('right').run() },
              ].map((btn, i) => (
                <button key={i} onClick={btn.action} className="rounded-lg p-1.5 text-black/40 hover:bg-black/5 hover:text-black/70 transition">
                  {btn.icon}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <AnimatePresence mode="wait">
                {saveStatus !== 'idle' && (
                  <motion.span
                    key={saveStatus}
                    initial={{ opacity: 0, y: 2 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -2 }}
                    transition={{ duration: 0.15 }}
                    className={`flex items-center gap-1 text-xs mr-1 ${
                      saveStatus === 'error'
                        ? 'text-red-500/80'
                        : saveStatus === 'saved'
                          ? 'text-emerald-600/80'
                          : 'text-black/40'
                    }`}
                    aria-live="polite"
                  >
                    {saveStatus === 'saving' && (
                      <>
                        <Loader2 size={12} className="animate-spin" />
                        Preserving…
                      </>
                    )}
                    {saveStatus === 'saved' && (
                      <>
                        <Check size={12} />
                        Preserved
                      </>
                    )}
                    {saveStatus === 'error' && 'Save failed'}
                  </motion.span>
                )}
              </AnimatePresence>
              <span className="text-xs text-black/35 mr-1">{wordCount} words</span>
              <button
                onClick={() => { setShowContextHouse(true); setAssistantOpen(false) }}
                className="rounded-lg p-1.5 text-black/40 transition hover:bg-black/5 hover:text-black/70"
                title="The Context House — context the AI uses for this document"
                data-tour="context"
              >
                <Inbox size={15} />
              </button>
              <button
                onClick={() => { setAssistantOpen((v) => !v); setShowContextHouse(false) }}
                className="rounded-lg p-1.5 text-black/40 transition hover:bg-black/5 hover:text-black/70"
                title={assistantOpen ? 'Hide editor' : 'Show editor'}
                data-tour="assistant-toggle"
              >
                {assistantOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-hidden relative">
          {/* Editor — kept mounted; hidden when a full-screen panel is covering it */}
          <div
            ref={editorScrollRef}
            className={`write-editor-scroll h-full overflow-y-auto${showDocLibrary || showContextHouse ? ' invisible pointer-events-none' : ''}`}
          >
            <div className="compose-page">
              <div className="tiptap-editor compose-page__body min-h-full" data-tour="editor">
                <EditorContent editor={editor} className="min-h-full" />
              </div>
            </div>
          </div>

          {/* Documents library — slides up like a mode switch */}
          <AnimatePresence initial={false}>
            {showDocLibrary && (
              <motion.div
                key="doc-library"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
                className="absolute inset-0 overflow-hidden"
              >
                <DocumentsMode onClose={() => { setShowDocLibrary(false); setAssistantOpen(true) }} />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Context House — full-screen overlay, same style as doc library */}
          <AnimatePresence initial={false}>
            {showContextHouse && (
              <motion.div
                key="context-house"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
                className="absolute inset-0 overflow-hidden"
              >
                <ContextHouse onClose={() => { setShowContextHouse(false); setAssistantOpen(true) }} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Floating selection toolbar */}
        <AnimatePresence>
          {composeChromeVisible && selectionMenu && (
            <motion.div
              initial={{ opacity: 0, y: 6, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.96 }}
              transition={{ duration: 0.12 }}
              className="selection-toolbar"
              style={{
                top: selectionMenu.top - 46,
                left: selectionMenu.left,
              }}
              onMouseDown={(e) => e.preventDefault()}
            >
              <button
                className="selection-toolbar-btn"
                onClick={() => openTunnel(selectionMenu.from, selectionMenu.to, selectionMenu.text)}
              >
                <Crosshair size={13} />
                Refine
              </button>
              <span className="selection-toolbar-sep" />
              <button
                className="selection-toolbar-btn"
                onClick={() => {
                  attachSelection(selectionMenu.text, selectionMenu.from, selectionMenu.to)
                  setSelectionMenu(null)
                }}
              >
                {review ? 'New chat' : 'Add to editor'}
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Document tabs — fixed top-left, independent of context dock */}
      {composeChromeVisible && (
        <div className="doc-tabs-float" aria-label="Document tabs" data-tour="doctabs">
          {docTabs.map((tab) => (
            <div
              key={tab.id}
              className={`doc-tab ${tab.id === activeTabId ? 'active' : ''}`}
              onClick={() => switchTab(tab.id)}
              onDoubleClick={(e) => {
                e.stopPropagation()
                setRenamingTab({ id: tab.id, value: tab.name })
              }}
            >
              {renamingTab?.id === tab.id ? (
                <input
                  autoFocus
                  className="doc-tab-rename"
                  value={renamingTab.value}
                  onChange={(e) => setRenamingTab({ id: tab.id, value: e.target.value })}
                  onBlur={commitTabRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitTabRename()
                    if (e.key === 'Escape') setRenamingTab(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="doc-tab-name">{tab.name}</span>
              )}
              {docTabs.length > 1 && (
                <button
                  className="doc-tab-close"
                  title="Delete tab"
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteDocTab(tab.id)
                  }}
                >
                  <X size={10} />
                </button>
              )}
            </div>
          ))}
          <button className="doc-tab-add" onClick={handleNewTab} title="New tab">
            <Plus size={12} />
          </button>
        </div>
      )}

      {/* Context dock — fixed bottom-left */}
      {composeChromeVisible && (
        <ComposeContextDock
          onOpenContextHouse={() => {
            setShowContextHouse(true)
            setAssistantOpen(false)
          }}
        />
      )}

      {composeChromeVisible && (
      <div
        className={`assistant-rail${assistantOpen ? ' is-open' : ' is-collapsed'}`}
        data-tour="assistant"
      >
        <div
          className="assistant-rail-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={assistantOpen ? 'Drag to resize editor, click to collapse' : 'Open editor'}
          onPointerDown={onRailPointerDown}
          onPointerMove={onRailPointerMove}
          onPointerUp={onRailPointerUp}
        >
          <span className="assistant-rail-grip" aria-hidden />
        </div>
        <div
          className="assistant-panel"
          style={{ width: assistantOpen ? assistantWidth : 0 }}
          aria-hidden={!assistantOpen}
        >
          {assistantOpen && (
            tunnel ? (
              <RefinePanel
                sentence={tunnel.sentence}
                contextBefore={tunnel.contextBefore}
                contextAfter={tunnel.contextAfter}
                apiKey={apiKey}
                styleGuide={compileStyleGuide(styleRules)}
                researchContext={getFullContext()}
                onApply={applyTunnel}
                onClose={closeRefine}
              />
            ) : (
              assistantPanelInner
            )
          )}
        </div>
      </div>
      )}

      {/* Floating accept / reject all — does not shift document layout */}
      <AnimatePresence>
        {composeChromeVisible && review && (
          <motion.div
            key="review-float"
            initial={{ opacity: 0, y: 10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.96 }}
            transition={{ duration: 0.16, ease: [0.25, 1, 0.5, 1] }}
            className="review-float"
            onMouseDown={(e) => e.preventDefault()}
          >
            <span className="review-float-label">
              {review.stackedIds.length} edit{review.stackedIds.length === 1 ? '' : 's'}
            </span>
            <button type="button" className="review-float-btn review-float-accept" onClick={acceptAll}>
              <Check size={14} />
              Approve all
            </button>
            <button type="button" className="review-float-btn review-float-reject" onClick={rejectAll}>
              <X size={14} />
              Decline all
            </button>
            <span className="review-float-hint">Ctrl+Enter</span>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  )
}

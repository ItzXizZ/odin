import { useState, useCallback, useEffect, useRef } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Underline from '@tiptap/extension-underline'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import {
  Bold, Italic, UnderlineIcon, AlignLeft, AlignCenter, AlignRight,
  Check, X, Loader2, Undo2, Redo2, Crosshair,
  Plus, PanelRightClose, PanelRightOpen,
} from 'lucide-react'
import { diffWords } from 'diff'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../../store/useStore'
import { streamChat } from '../../lib/claude'
import { compileStyleGuide, buildEditSystemPrompt, parseEdits, applyEdits } from '../../lib/style'
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
  markdownishToHtml,
} from '../../lib/aiText'
import { diffToHtml } from './diffHtml'
import TunnelVision from './TunnelVision'

/** Highlight color marking the passage currently attached to the assistant. */
const REF_HIGHLIGHT_COLOR = '#ffe690'

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

interface ChatEntry {
  id: string
  role: 'user' | 'assistant'
  content: string
  suggestionId?: string
  /** Messages from the Stylism network curator (conflicts, confirmations). */
  kind?: 'style'
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
    documents, activeDocumentId, apiKey, getFullContext,
    setDocumentContent, setDocumentTitle,
    addDocTab, deleteDocTab, renameDocTab, setActiveDocTab,
    styleRules,
    reinforceStyleRules, addStyleRule, editStyleRule, deleteStyleRule,
  } = useStore()

  const activeDoc = documents.find((d) => d.id === activeDocumentId) ?? documents[0]
  const documentTitle = activeDoc?.title ?? 'Untitled'
  const docTabs = activeDoc?.tabs ?? []
  const activeTabId = activeDoc?.activeTabId ?? null

  const [hydrated, setHydrated] = useState(() => useStore.persist.hasHydrated())
  const [aiPrompt, setAiPrompt] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [suggestions, setSuggestions] = useState<AISuggestion[]>([])
  const [review, setReview] = useState<ReviewState | null>(null)
  const [chat, setChat] = useState<ChatEntry[]>([])
  const [wordCount, setWordCount] = useState(0)
  const [attachedSelection, setAttachedSelection] = useState('')
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenu | null>(null)
  const [tunnel, setTunnel] = useState<TunnelState | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(true)
  const [renamingTab, setRenamingTab] = useState<{ id: string; value: string } | null>(null)

  const skipEmptySaveRef = useRef(true)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const reviewActiveRef = useRef(false)
  const reviewStateRef = useRef<ReviewState | null>(null)
  reviewStateRef.current = review
  const finishReviewRef = useRef<() => void>(() => {})
  const chatStateRef = useRef<ChatEntry[]>([])
  chatStateRef.current = chat
  /** An unresolved Stylism rule conflict; the writer's next message resolves it. */
  const pendingConflictRef = useRef<{ ruleId: string; question: string } | null>(null)

  useEffect(() => {
    if (useStore.persist.hasHydrated()) {
      setHydrated(true)
      return
    }
    return useStore.persist.onFinishHydration(() => setHydrated(true))
  }, [])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat, review, isStreaming])

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
            'Begin writing… Your ideas from Context House, Stream, and Exploration are available to Claude.',
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
    setAttachedSelection('')
    setSelectionMenu(null)
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
      if (reviewActiveRef.current || !editor.isEditable) {
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

  /* ── Attachment reference highlight ──
     When a passage is attached to the assistant, it stays visibly highlighted
     in the editor so the writer always knows what they're referencing. */
  const attachSelection = useCallback((text: string, from?: number, to?: number) => {
    const ed = editorRef.current
    if (ed && !reviewActiveRef.current) {
      clearReferenceHighlightIn(ed)
      if (from != null && to != null && to > from) {
        ed.chain()
          .setTextSelection({ from, to })
          .setHighlight({ color: REF_HIGHLIGHT_COLOR })
          .setTextSelection(to)
          .run()
      }
    }
    setAttachedSelection(text)
  }, [])

  const detachSelection = useCallback(() => {
    const ed = editorRef.current
    if (ed && !reviewActiveRef.current) clearReferenceHighlightIn(ed)
    setAttachedSelection('')
  }, [])

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
    setAttachedSelection('')
  }, [setDocumentContent])

  useEffect(() => {
    finishReviewRef.current = finishReview
  }, [finishReview])

  const enterReview = useCallback(
    (currentText: string, newText: string, instruction: string) => {
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
      setChat((prev) => [
        ...prev,
        {
          id,
          role: 'assistant',
          content: `Proposed ${diff.filter((d) => d.added || d.removed).length} change${
            diff.filter((d) => d.added || d.removed).length === 1 ? '' : 's'
          }. Review them inline.`,
          suggestionId: id,
        },
      ])
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
    setChat((prev) => [
      ...prev,
      { id: `style-${Date.now()}`, role: 'assistant', content, kind: 'style' },
    ])
  }, [])

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
      if (!apiKey) return
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
          postStyleMessage(`Style network updated: ${summary.join(' · ')}.`)
        }
      } catch {
        // Network upkeep must never interrupt the writing flow.
      }
    },
    [apiKey, applyStyleActions, postStyleMessage]
  )

  const handleAIAssist = useCallback(async () => {
    if (!aiPrompt.trim() || !apiKey || !editor) return

    const instruction = aiPrompt.trim()
    const userEntryId = Date.now().toString()
    setChat((prev) => [...prev, { id: userEntryId, role: 'user', content: instruction }])
    setAiPrompt('')
    setIsStreaming(true)

    // While a review is open, follow-up edits stack: the AI edits the proposed
    // text, but the next diff is still shown against the original document.
    const stacking = reviewActiveRef.current
    const currentText = stacking
      ? reviewTextFromDoc(editor, 'proposed')
      : editor.getText({ blockSeparator: '\n\n' })
    const baseText = stacking ? reviewTextFromDoc(editor, 'original') : currentText
    const context = getFullContext()
    const styleGuide = compileStyleGuide(styleRules)
    const passage = attachedSelection
    const isEmptyDoc = currentText.trim().length === 0

    const system = isEmptyDoc
      ? `You are an expert writing assistant. Write the content the writer asks for as clean prose (paragraphs separated by blank lines). Return ONLY the prose — no commentary, no JSON, no code fences, and no Markdown (# headings, **bold**, bullet lists, or similar symbols).

${styleGuide ? styleGuide + '\n\n' : ''}${context ? `=== WRITER'S RESEARCH CONTEXT ===\n${context.slice(0, 4000)}` : ''}`
      : buildEditSystemPrompt({ context, styleGuide, scope: 'document' })

    const user = isEmptyDoc
      ? `The document is empty.\n\nINSTRUCTION: ${instruction}`
      : `CURRENT DOCUMENT:
"""
${currentText.slice(0, 8000)}
"""
${
  passage
    ? `\nFOCUS ONLY ON THIS PASSAGE (edit within it, leave everything else untouched):\n"""${passage.slice(0, 2000)}"""\n`
    : ''
}
INSTRUCTION: ${instruction}`

    let raw = ''
    await streamChat(
      [{ role: 'user', content: user }],
      system,
      apiKey,
      (chunk) => {
        raw += chunk
      },
      () => {
        setIsStreaming(false)
        raw = normalizeAiResponse(raw)
        if (isEmptyDoc) {
          const generated = raw.trim()
          if (!generated) {
            setChat((prev) => [
              ...prev,
              { id: (Date.now() + 1).toString(), role: 'assistant', content: 'Nothing was generated — try again.' },
            ])
            return
          }
          enterReview(baseText, generated, instruction)
          return
        }
        const edits = parseEdits(raw)
        let newText: string
        if (edits && edits.length > 0) {
          newText = applyEdits(currentText, edits).text
        } else if (edits && edits.length === 0) {
          setChat((prev) => [
            ...prev,
            { id: (Date.now() + 1).toString(), role: 'assistant', content: 'No changes needed — your text already works here.' },
          ])
          return
        } else {
          // Model ignored the JSON protocol; treat output as a full replacement.
          newText = raw.trim()
        }

        if (!newText.trim() || newText.trim() === currentText.trim()) {
          setChat((prev) => [
            ...prev,
            { id: (Date.now() + 1).toString(), role: 'assistant', content: 'No changes needed — your text already works here.' },
          ])
          return
        }
        enterReview(baseText, newText, instruction)
      },
      (errMessage) => {
        setIsStreaming(false)
        setChat((prev) => [
          ...prev,
          { id: (Date.now() + 1).toString(), role: 'assistant', content: `⚠️ ${errMessage}. Please try again.` },
        ])
      }
    )

    // Background turn: let Claude decide if this was stylistic feedback and
    // update the Stylism network (reinforce / create / flag conflicts).
    void maintainStyleNetwork(instruction)
  }, [aiPrompt, apiKey, editor, getFullContext, styleRules, attachedSelection, enterReview, maintainStyleNetwork])

  /* ── Tunnel vision ── */
  const openTunnel = useCallback(
    (from: number, to: number, text: string) => {
      const ed = editorRef.current
      if (!ed) return
      const size = ed.state.doc.content.size
      const contextBefore = ed.state.doc.textBetween(Math.max(0, from - 400), from, ' ')
      const contextAfter = ed.state.doc.textBetween(to, Math.min(size, to + 400), ' ')
      setSelectionMenu(null)
      setTunnel({ sentence: text, contextBefore, contextAfter, from, to })
    },
    []
  )

  const applyTunnel = useCallback(
    (newText: string) => {
      const ed = editorRef.current
      if (!ed || !tunnel) return
      const cleaned = normalizeAiResponse(newText)
      const content = looksLikeMarkdown(cleaned) ? markdownishToHtml(cleaned) : cleaned
      ed.chain().focus().insertContentAt({ from: tunnel.from, to: tunnel.to }, content).run()
      setDocumentContent(ed.getHTML())
      setWordCount(ed.getText().split(/\s+/).filter(Boolean).length)
      setTunnel(null)
    },
    [tunnel, setDocumentContent]
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
        if (tunnel) setTunnel(null)
        else if (reviewActiveRef.current) rejectAll()
        return
      }
      if (reviewActiveRef.current && mod && e.key === 'Enter') {
        e.preventDefault()
        acceptAll()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setDocumentContent, tunnel, acceptAll, rejectAll])

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

  if (!hydrated) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-black/40">
        Loading document…
      </div>
    )
  }

  return (
    <div className="write-mode h-full relative overflow-hidden">
      <div className="h-full flex flex-col overflow-hidden">
        <div className="flex-shrink-0 flex items-center justify-between border-b border-black/8 bg-white/30 backdrop-blur px-4 py-2">
          <div className="flex items-center gap-1 min-w-0">
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
          <div className="flex items-center gap-2.5 flex-shrink-0">
            <span className="text-xs text-black/35">{wordCount} words</span>
            <button
              onClick={() => setAssistantOpen((v) => !v)}
              className="rounded-lg p-1.5 text-black/40 transition hover:bg-black/5 hover:text-black/70"
              title={assistantOpen ? 'Hide assistant' : 'Show assistant'}
            >
              {assistantOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="tiptap-editor max-w-3xl mx-auto min-h-full">
            <EditorContent editor={editor} className="min-h-full" />
          </div>
        </div>

        {/* Floating selection toolbar */}
        <AnimatePresence>
          {selectionMenu && !review && (
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
                Focus
              </button>
              <span className="selection-toolbar-sep" />
              <button
                className="selection-toolbar-btn"
                onClick={() => {
                  attachSelection(selectionMenu.text, selectionMenu.from, selectionMenu.to)
                  setSelectionMenu(null)
                }}
              >
                Add to chat
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Floating vertical document tabs */}
      <div className="doc-tabs-float" aria-label="Document tabs">
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

      <AnimatePresence initial={false}>
        {assistantOpen && (
          <motion.div
            key="assistant"
            initial={{ opacity: 0, x: 16, scale: 0.98 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 16, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.25, 1, 0.5, 1] }}
            className="assistant-float"
          >
            <div className="assistant-panel">
              <div className="flex-1 overflow-y-auto px-3 pt-4 pb-44 space-y-3">
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
                            <p className="mb-1 text-[10px] font-semibold text-violet-700/70">Stylism</p>
                          )}
                          <p className="whitespace-pre-wrap">{entry.content}</p>
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

                {isStreaming && (
                  <div className="flex justify-start">
                    <div className="chat-bubble chat-bubble-ai">
                      <div className="flex items-center gap-2 text-black/40">
                        <Loader2 size={12} className="animate-spin" />
                        Composing precise edits…
                      </div>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Floating glass input */}
              <div
                className={`assistant-input-zone ${dragOver ? 'prompt-dropzone-active' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handlePromptDrop}
              >
                <AnimatePresence>
                  {attachedSelection && (
                    <motion.div
                      initial={{ opacity: 0, y: 8, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.97 }}
                      className="attached-popup"
                    >
                      <div className="flex items-start gap-2">
                        <span className="attached-popup-tag">Passage</span>
                        <p className="attached-popup-text">{attachedSelection}</p>
                        <button
                          type="button"
                          onClick={detachSelection}
                          className="text-black/30 hover:text-black/60 flex-shrink-0"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {dragOver && <div className="prompt-drop-hint">Drop to attach passage</div>}

                <div className="assistant-input-bar">
                  <textarea
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        handleAIAssist()
                      }
                    }}
                    rows={2}
                    placeholder={
                      attachedSelection
                        ? 'How should this passage change? Press Enter to send.'
                        : 'Press Enter to send…'
                    }
                    className="assistant-textarea"
                    disabled={isStreaming}
                  />
                  {isStreaming && (
                    <Loader2 size={14} className="assistant-input-spinner animate-spin flex-shrink-0" />
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating accept / reject all — does not shift document layout */}
      <AnimatePresence>
        {review && (
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
              Accept all
            </button>
            <button type="button" className="review-float-btn review-float-reject" onClick={rejectAll}>
              <X size={14} />
              Reject all
            </button>
            <span className="review-float-hint">Ctrl+Enter</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Overlays */}
      <AnimatePresence>
        {tunnel && editor && (
          <TunnelVision
            sentence={tunnel.sentence}
            contextBefore={tunnel.contextBefore}
            contextAfter={tunnel.contextAfter}
            apiKey={apiKey}
            styleGuide={compileStyleGuide(styleRules)}
            researchContext={getFullContext()}
            onApply={applyTunnel}
            onClose={() => setTunnel(null)}
          />
        )}
      </AnimatePresence>

    </div>
  )
}

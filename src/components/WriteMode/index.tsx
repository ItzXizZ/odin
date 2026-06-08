import { useState, useCallback, useEffect, useRef } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Underline from '@tiptap/extension-underline'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import {
  Bold, Italic, UnderlineIcon, AlignLeft, AlignCenter, AlignRight,
  Check, X, ChevronRight, ChevronDown, BookOpen, Mic, GitBranch,
  Star, Loader2, Lightbulb, Undo2, Redo2, Send, Save, Wand2, Crosshair, Sparkles,
} from 'lucide-react'
import { diffWords } from 'diff'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../../store/useStore'
import { streamChat } from '../../lib/claude'
import { compileStyleGuide, buildEditSystemPrompt, parseEdits, applyEdits } from '../../lib/style'
import DiffReview, { type DiffChange } from './DiffReview'
import { Insertion, Deletion, DiffReview as DiffReviewExt, resolveRange, docHasDiff } from './diffExtension'
import { diffToHtml } from './diffHtml'
import TunnelVision from './TunnelVision'
import StylismMode from './StylismMode'

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
}

interface ChatEntry {
  id: string
  role: 'user' | 'assistant'
  content: string
  suggestionId?: string
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

export default function WriteMode() {
  const {
    documentTitle, apiKey, getFullContext,
    setDocumentContent, setDocumentTitle, setActiveTab,
    pdfs, sessions, adventures,
    styleRules, setStyleRules, resetStyleRules,
  } = useStore()

  const takeawayCount = adventures.reduce((sum, a) => sum + a.takeaways.length, 0)

  const [hydrated, setHydrated] = useState(() => useStore.persist.hasHydrated())
  const [aiPrompt, setAiPrompt] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [suggestions, setSuggestions] = useState<AISuggestion[]>([])
  const [review, setReview] = useState<ReviewState | null>(null)
  const [chat, setChat] = useState<ChatEntry[]>([])
  const [contextExpanded, setContextExpanded] = useState<string | null>(null)
  const [wordCount, setWordCount] = useState(0)
  const [attachedSelection, setAttachedSelection] = useState('')
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenu | null>(null)
  const [tunnel, setTunnel] = useState<TunnelState | null>(null)
  const [stylismOpen, setStylismOpen] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const skipEmptySaveRef = useRef(true)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const reviewActiveRef = useRef(false)
  const finishReviewRef = useRef<() => void>(() => {})

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
      content: useStore.getState().documentContent,
      onUpdate: ({ editor: ed }) => {
        // Never persist the transient merged-diff document while reviewing.
        if (reviewActiveRef.current) return
        if (skipEmptySaveRef.current && ed.isEmpty) {
          const stored = useStore.getState().documentContent
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
    const stored = useStore.getState().documentContent
    if (stored && editor.isEmpty) {
      skipEmptySaveRef.current = true
      editor.commands.setContent(stored, false)
      skipEmptySaveRef.current = false
    }
    setWordCount(editor.getText().split(/\s+/).filter(Boolean).length)
  }, [editor, hydrated])

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

  /* ── Finalize a review once all hunks are resolved ── */
  const finishReview = useCallback(() => {
    const ed = editorRef.current
    if (!ed) return
    reviewActiveRef.current = false
    ed.setEditable(true)
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
      setReview({ suggestionId: id, instruction, diff })
      setChat((prev) => [
        ...prev,
        {
          id,
          role: 'assistant',
          content: `Proposed ${diff.filter((d) => d.added || d.removed).length} change${
            diff.filter((d) => d.added || d.removed).length === 1 ? '' : 's'
          }. Review them inline, or here.`,
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
      prev.map((s) => (s.id === review.suggestionId ? { ...s, accepted: true } : s))
    )
    finishReview()
  }, [review, finishReview])

  const rejectAll = useCallback(() => {
    const ed = editorRef.current
    if (!ed || !review) return
    resolveRange(ed.view, 0, ed.state.doc.content.size, 'reject')
    setSuggestions((prev) =>
      prev.map((s) => (s.id === review.suggestionId ? { ...s, accepted: false } : s))
    )
    finishReview()
  }, [review, finishReview])

  const handleAIAssist = useCallback(async () => {
    if (!aiPrompt.trim() || !apiKey || !editor || reviewActiveRef.current) return

    const instruction = aiPrompt.trim()
    const userEntryId = Date.now().toString()
    setChat((prev) => [...prev, { id: userEntryId, role: 'user', content: instruction }])
    setAiPrompt('')
    setIsStreaming(true)

    const currentText = editor.getText({ blockSeparator: '\n\n' })
    const context = getFullContext()
    const styleGuide = compileStyleGuide(styleRules)
    const passage = attachedSelection
    const isEmptyDoc = currentText.trim().length === 0

    const system = isEmptyDoc
      ? `You are an expert writing assistant. Write the content the writer asks for as clean prose (plain text, paragraphs separated by blank lines). Return ONLY the prose, no commentary, no JSON, no markdown fences.

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
        if (isEmptyDoc) {
          const generated = raw.trim()
          if (!generated) {
            setChat((prev) => [
              ...prev,
              { id: (Date.now() + 1).toString(), role: 'assistant', content: 'Nothing was generated — try again.' },
            ])
            return
          }
          enterReview(currentText, generated, instruction)
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
        enterReview(currentText, newText, instruction)
      },
      (errMessage) => {
        setIsStreaming(false)
        setChat((prev) => [
          ...prev,
          { id: (Date.now() + 1).toString(), role: 'assistant', content: `⚠️ ${errMessage}. Please try again.` },
        ])
      }
    )
  }, [aiPrompt, apiKey, editor, getFullContext, styleRules, attachedSelection, enterReview])

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
      ed.chain().focus().insertContentAt({ from: tunnel.from, to: tunnel.to }, newText).run()
      setDocumentContent(ed.getHTML())
      setWordCount(ed.getText().split(/\s+/).filter(Boolean).length)
      setTunnel(null)
    },
    [tunnel, setDocumentContent]
  )

  /* ── Save ── */
  const handleSave = useCallback(() => {
    const ed = editorRef.current
    if (ed && !reviewActiveRef.current) setDocumentContent(ed.getHTML())
    setSavedFlash(true)
    window.setTimeout(() => setSavedFlash(false), 1400)
  }, [setDocumentContent])

  /* ── Global keyboard ── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        handleSave()
        return
      }
      if (e.key === 'Escape') {
        if (tunnel) setTunnel(null)
        else if (stylismOpen) setStylismOpen(false)
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
  }, [handleSave, tunnel, stylismOpen, acceptAll, rejectAll])

  /* ── Drag selection into prompt ── */
  const handlePromptDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const text =
      e.dataTransfer.getData('text/plain') ||
      window.getSelection()?.toString() ||
      ''
    const trimmed = text.trim()
    if (trimmed) setAttachedSelection(trimmed)
  }

  const contextSections = [
    { id: 'pdfs', label: 'Documents', count: pdfs.length, icon: <BookOpen size={12} /> },
    { id: 'stream', label: 'Stream Sessions', count: sessions.length, icon: <Mic size={12} /> },
    { id: 'exploration', label: 'Adventures', count: adventures.length, icon: <GitBranch size={12} /> },
    { id: 'takeaways', label: 'Takeaways', count: takeawayCount, icon: <Lightbulb size={12} /> },
  ]

  const changeCount = review ? review.diff.filter((d) => d.added || d.removed).length : 0

  if (!hydrated) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-black/40">
        Loading document…
      </div>
    )
  }

  return (
    <div className="h-full flex overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden min-w-0 relative">
        <div className="flex-shrink-0 flex items-center justify-between border-b border-black/8 bg-white/30 backdrop-blur px-4 py-2">
          <div className="flex items-center gap-1 min-w-0">
            <input
              value={documentTitle}
              onChange={(e) => setDocumentTitle(e.target.value)}
              className="bg-transparent text-base font-semibold text-black/75 outline-none hover:text-black w-40 placeholder-black/30"
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
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-black/35">{wordCount} words</span>
            <button
              onClick={() => setStylismOpen(true)}
              className="btn-ghost flex items-center gap-1.5 text-xs"
              title="Tune the AI's writing style"
            >
              <Wand2 size={12} />
              Stylism
            </button>
            <button
              onClick={handleSave}
              className={`btn-ghost flex items-center gap-1.5 text-xs ${savedFlash ? 'text-green-700' : ''}`}
              title="Save (Ctrl+S)"
            >
              {savedFlash ? <Check size={12} /> : <Save size={12} />}
              {savedFlash ? 'Saved' : 'Save'}
            </button>
            <button onClick={() => setActiveTab('grade')} className="btn-ghost flex items-center gap-1.5 text-xs">
              <Star size={12} />
              Grade
            </button>
          </div>
        </div>

        {/* Inline review bar */}
        <AnimatePresence>
          {review && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="flex-shrink-0 flex items-center justify-between gap-3 border-b border-black/8 bg-blue-500/[0.06] px-4 py-2"
            >
              <span className="text-xs text-black/55">
                {changeCount} suggested change{changeCount === 1 ? '' : 's'} — review inline, or:
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={rejectAll}
                  className="flex items-center gap-1.5 rounded-lg border border-black/10 bg-black/[0.03] px-3 py-1.5 text-xs font-medium text-black/55 hover:bg-black/[0.06]"
                >
                  <X size={13} /> Reject all <kbd>Esc</kbd>
                </button>
                <button
                  onClick={acceptAll}
                  className="flex items-center gap-1.5 rounded-lg border border-green-600/25 bg-green-600/10 px-3 py-1.5 text-xs font-medium text-green-800 hover:bg-green-600/15"
                >
                  <Check size={13} /> Accept all <kbd>⌘↵</kbd>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

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
                  setAttachedSelection(selectionMenu.text)
                  setSelectionMenu(null)
                }}
              >
                <Sparkles size={13} />
                Add to chat
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <aside className="w-[340px] flex-shrink-0 border-l border-black/8 bg-white/25 backdrop-blur flex flex-col overflow-hidden">
        <div className="flex-shrink-0 border-b border-black/8 px-4 py-3">
          <p className="text-sm font-semibold text-black/70">Assistant</p>
          <p className="text-[11px] text-black/40 mt-0.5">
            Select text for Focus, or drag it into the prompt below
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {chat.length === 0 && !isStreaming && (
            <div className="rounded-xl border border-dashed border-black/10 p-4 text-center">
              <p className="text-xs text-black/40 leading-relaxed">
                Ask Claude to refine a passage. Edits are surgical and shown inline so you can
                accept or reject each one.
              </p>
            </div>
          )}

          {chat.map((entry) => {
            const suggestion = entry.suggestionId
              ? suggestions.find((s) => s.id === entry.suggestionId)
              : undefined
            const isActiveReview = review?.suggestionId === entry.suggestionId

            return (
              <div key={entry.id} className="space-y-2">
                <div className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[92%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                      entry.role === 'user'
                        ? 'bg-black/8 text-black/75'
                        : 'bg-white/60 border border-black/8 text-black/70'
                    }`}
                  >
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
                {isActiveReview && review && (
                  <DiffReview
                    instruction={review.instruction}
                    diff={review.diff}
                    onAccept={acceptAll}
                    onReject={rejectAll}
                  />
                )}
              </div>
            )
          })}

          {isStreaming && (
            <div className="flex justify-start">
              <div className="max-w-[92%] rounded-xl border border-black/8 bg-white/60 px-3 py-2 text-xs text-black/60">
                <div className="flex items-center gap-2 text-black/40">
                  <Loader2 size={12} className="animate-spin" />
                  Composing precise edits…
                </div>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <div className="flex-shrink-0 border-t border-black/8 px-3 py-2 max-h-36 overflow-y-auto">
          <button
            type="button"
            onClick={() => setContextExpanded(contextExpanded ? null : 'context')}
            className="w-full flex items-center justify-between text-left py-1"
          >
            <span className="text-[11px] font-medium text-black/50">Active context</span>
            {contextExpanded === 'context' ? (
              <ChevronDown size={12} className="text-black/30" />
            ) : (
              <ChevronRight size={12} className="text-black/30" />
            )}
          </button>
          <AnimatePresence initial={false}>
            {contextExpanded === 'context' && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden space-y-1 pb-1"
              >
                {contextSections.map((section) => (
                  <div key={section.id} className="flex items-center justify-between rounded-lg bg-black/[0.03] px-2 py-1.5">
                    <div className="flex items-center gap-1.5 text-black/55">
                      {section.icon}
                      <span className="text-[10px]">{section.label}</span>
                    </div>
                    <span className={`text-[10px] rounded-full px-1.5 py-0.5 ${section.count > 0 ? 'bg-black/8 text-black/60' : 'text-black/30'}`}>
                      {section.count}
                    </span>
                  </div>
                ))}
                {contextSections.every((s) => s.count === 0) && (
                  <button
                    type="button"
                    onClick={() => setActiveTab('context')}
                    className="text-[10px] text-black/45 hover:text-black/65 underline"
                  >
                    Add context in Context House
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div
          className={`flex-shrink-0 border-t border-black/8 p-3 space-y-2 relative ${dragOver ? 'prompt-dropzone-active' : ''}`}
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
                    onClick={() => setAttachedSelection('')}
                    className="text-black/30 hover:text-black/60 flex-shrink-0"
                  >
                    <X size={12} />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {dragOver && (
            <div className="prompt-drop-hint">Drop to attach passage</div>
          )}

          <div className="flex items-end gap-2">
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
              placeholder={attachedSelection ? 'How should this passage change?' : 'Ask Claude to refine your writing…'}
              className="glass-input flex-1 resize-none px-3 py-2 text-sm min-h-[2.5rem]"
            />
            <button
              type="button"
              onClick={handleAIAssist}
              disabled={isStreaming || !aiPrompt.trim() || !apiKey || !!review}
              className="btn-primary flex h-10 w-10 flex-shrink-0 items-center justify-center disabled:opacity-40"
              title="Send"
            >
              {isStreaming ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </button>
          </div>
        </div>
      </aside>

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

      <AnimatePresence>
        {stylismOpen && (
          <StylismMode
            rules={styleRules}
            onChange={setStyleRules}
            onReset={resetStyleRules}
            onClose={() => setStylismOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

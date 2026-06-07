import { useState, useCallback, useEffect, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Underline from '@tiptap/extension-underline'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import {
  Bold, Italic, UnderlineIcon, AlignLeft, AlignCenter, AlignRight,
  Check, X, ChevronRight, ChevronDown, BookOpen, Mic, GitBranch,
  Star, Loader2, Lightbulb, Undo2, Redo2, Send,
} from 'lucide-react'
import { diffWords } from 'diff'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../../store/useStore'
import { streamChat } from '../../lib/claude'
import DiffReview, { type DiffChange } from './DiffReview'

interface AISuggestion {
  id: string
  instruction: string
  originalText: string
  suggestedText: string
  diff: DiffChange[]
  accepted: boolean | null
}

interface ReviewState {
  suggestionId: string
  instruction: string
  diff: DiffChange[]
  isPassage: boolean
  passageText: string
  suggestedText: string
}

interface ChatEntry {
  id: string
  role: 'user' | 'assistant'
  content: string
  suggestionId?: string
}

function textToHtml(text: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${esc(para).replace(/\n/g, '<br/>')}</p>`)
    .join('')
}

function htmlHasText(html: string): boolean {
  return html.replace(/<[^>]+>/g, '').trim().length > 0
}

export default function WriteMode() {
  const {
    documentContent, documentTitle, apiKey, getFullContext,
    setDocumentContent, setDocumentTitle, setActiveTab, highlightedText, setHighlightedText,
    pdfs, sessions, adventures,
  } = useStore()

  const explorationNodeCount = adventures.reduce(
    (sum, a) => sum + a.nodes.filter((n) => n.data.response).length,
    0
  )
  const takeawayCount = adventures.reduce((sum, a) => sum + a.takeaways.length, 0)

  const [hydrated, setHydrated] = useState(() => useStore.persist.hasHydrated())
  const [aiPrompt, setAiPrompt] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamPreview, setStreamPreview] = useState('')
  const [suggestions, setSuggestions] = useState<AISuggestion[]>([])
  const [review, setReview] = useState<ReviewState | null>(null)
  const [chat, setChat] = useState<ChatEntry[]>([])
  const [contextExpanded, setContextExpanded] = useState<string | null>(null)
  const [wordCount, setWordCount] = useState(0)

  const skipEmptySaveRef = useRef(true)
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (useStore.persist.hasHydrated()) {
      setHydrated(true)
      return
    }
    return useStore.persist.onFinishHydration(() => setHydrated(true))
  }, [])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat, review, streamPreview, isStreaming])

  const captureSelectionToPrompt = (view: {
    state: { selection: { from: number; to: number }; doc: { textBetween: (a: number, b: number, c: string) => string } }
  }): boolean => {
    const { from, to } = view.state.selection
    if (from === to) return false
    const selected = view.state.doc.textBetween(from, to, ' ')
    setHighlightedText(selected)
    setAiPrompt((prev) => prev || `Improve this passage: "${selected.slice(0, 200)}"`)
    return true
  }

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Underline,
        Highlight.configure({ multicolor: true }),
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Placeholder.configure({
          placeholder:
            'Begin writing… Your ideas from Context House, Stream, and Exploration are available to Claude.',
        }),
      ],
      content: documentContent,
      onUpdate: ({ editor: ed }) => {
        if (skipEmptySaveRef.current && ed.isEmpty) {
          const stored = useStore.getState().documentContent
          if (htmlHasText(stored)) return
        }
        skipEmptySaveRef.current = false
        setDocumentContent(ed.getHTML())
        setWordCount(ed.getText().split(/\s+/).filter(Boolean).length)
      },
      editorProps: {
        handleKeyDown(view, event) {
          const mod = event.ctrlKey || event.metaKey
          const key = event.key.toLowerCase()

          if (mod && !event.shiftKey && key === 'z') {
            editor?.chain().focus().undo().run()
            return true
          }

          if (mod && (key === 'y' || (event.shiftKey && key === 'z'))) {
            if (key === 'y' && captureSelectionToPrompt(view)) return true
            editor?.chain().focus().redo().run()
            return true
          }

          if (event.altKey && event.shiftKey && key === 'a') {
            captureSelectionToPrompt(view)
            return true
          }

          return false
        },
      },
    },
    [hydrated]
  )

  useEffect(() => {
    if (!editor || !hydrated) return
    const stored = useStore.getState().documentContent
    if (stored && editor.isEmpty) {
      skipEmptySaveRef.current = true
      editor.commands.setContent(stored, false)
      skipEmptySaveRef.current = false
      setWordCount(editor.getText().split(/\s+/).filter(Boolean).length)
    } else if (stored) {
      setWordCount(editor.getText().split(/\s+/).filter(Boolean).length)
    }
  }, [editor, hydrated])

  useEffect(() => {
    return () => {
      if (editor && !editor.isDestroyed && !editor.isEmpty) {
        setDocumentContent(editor.getHTML())
      }
    }
  }, [editor, setDocumentContent])

  useEffect(() => {
    if (highlightedText && !aiPrompt) {
      setAiPrompt(`Improve: "${highlightedText.slice(0, 100)}"`)
    }
  }, [highlightedText, aiPrompt])

  const applySuggestionText = useCallback(
    (suggestedText: string, reviewState: ReviewState) => {
      if (!editor) return false
      if (reviewState.isPassage) {
        const fullText = editor.getText()
        if (!fullText.includes(reviewState.passageText)) return false
        const updated = fullText.replace(reviewState.passageText, suggestedText)
        skipEmptySaveRef.current = true
        editor.commands.setContent(textToHtml(updated))
        skipEmptySaveRef.current = false
        setDocumentContent(editor.getHTML())
      } else {
        skipEmptySaveRef.current = true
        editor.commands.setContent(textToHtml(suggestedText))
        skipEmptySaveRef.current = false
        setDocumentContent(editor.getHTML())
      }
      setWordCount(editor.getText().split(/\s+/).filter(Boolean).length)
      return true
    },
    [editor, setDocumentContent]
  )

  const handleAIAssist = useCallback(async () => {
    if (!aiPrompt.trim() || !apiKey || !editor) return

    const instruction = aiPrompt.trim()
    const userEntryId = Date.now().toString()
    setChat((prev) => [...prev, { id: userEntryId, role: 'user', content: instruction }])
    setAiPrompt('')
    setIsStreaming(true)
    setStreamPreview('')

    const currentText = editor.getText()
    const context = getFullContext()

    const system = `You are an expert writing assistant embedded in a writing tool.
You have access to the writer's research context below.

Your task: Given the writer's instruction and their current document, provide ONLY the improved/new text.
- If asked to improve a passage, return just the improved version
- If asked to write new content, return just the new content
- If asked for general help, return the full improved document text
- Do NOT include explanations, just the text
- Match the writer's existing voice and style
- Keep the same approximate length unless asked to expand/condense

${context ? `\n=== WRITER'S RESEARCH CONTEXT ===\n${context.slice(0, 4000)}` : ''}`

    const messages: { role: 'user' | 'assistant'; content: string }[] = [
      {
        role: 'user',
        content: `Current document:\n\n${currentText.slice(0, 6000)}\n\n---\nInstruction: ${instruction}`,
      },
    ]

    let suggestion = ''
    await streamChat(
      messages,
      system,
      apiKey,
      (chunk) => {
        suggestion += chunk
        setStreamPreview(suggestion)
      },
      () => {
        const isPassage = !!highlightedText
        const targetText = isPassage ? highlightedText : currentText
        const diffResult = diffWords(targetText, suggestion) as DiffChange[]
        const id = (Date.now() + 1).toString()
        const newSuggestion: AISuggestion = {
          id,
          instruction,
          originalText: targetText,
          suggestedText: suggestion,
          diff: diffResult,
          accepted: null,
        }
        setSuggestions((prev) => [newSuggestion, ...prev.slice(0, 9)])
        setReview({
          suggestionId: id,
          instruction,
          diff: diffResult,
          isPassage,
          passageText: targetText,
          suggestedText: suggestion,
        })
        setChat((prev) => [...prev, { id, role: 'assistant', content: suggestion, suggestionId: id }])
        setIsStreaming(false)
        setStreamPreview('')
      }
    )
  }, [aiPrompt, apiKey, editor, getFullContext, highlightedText])

  const acceptReview = () => {
    if (!review) return
    const ok = applySuggestionText(review.suggestedText, review)
    if (!ok) return
    setSuggestions((prev) =>
      prev.map((s) => (s.id === review.suggestionId ? { ...s, accepted: true } : s))
    )
    setReview(null)
    setHighlightedText('')
  }

  const rejectReview = () => {
    if (!review) return
    setSuggestions((prev) =>
      prev.map((s) => (s.id === review.suggestionId ? { ...s, accepted: false } : s))
    )
    setReview(null)
  }

  const contextSections = [
    { id: 'pdfs', label: 'Documents', count: pdfs.length, icon: <BookOpen size={12} /> },
    { id: 'stream', label: 'Stream Sessions', count: sessions.length, icon: <Mic size={12} /> },
    {
      id: 'exploration',
      label: 'Adventures',
      count: adventures.length,
      icon: <GitBranch size={12} />,
    },
    { id: 'takeaways', label: 'Takeaways', count: takeawayCount, icon: <Lightbulb size={12} /> },
  ]

  if (!hydrated) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-black/40">
        Loading document…
      </div>
    )
  }

  return (
    <div className="h-full flex overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
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
              title="Redo (Ctrl+Y)"
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
          <div className="flex items-center gap-3 flex-shrink-0">
            <span className="text-xs text-black/35">{wordCount} words</span>
            <button onClick={() => setActiveTab('grade')} className="btn-ghost flex items-center gap-2 text-xs">
              <Star size={12} />
              Grade
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="tiptap-editor max-w-3xl mx-auto min-h-full">
            <EditorContent editor={editor} className="min-h-full" />
          </div>
        </div>
      </div>

      <aside className="w-[340px] flex-shrink-0 border-l border-black/8 bg-white/25 backdrop-blur flex flex-col overflow-hidden">
        <div className="flex-shrink-0 border-b border-black/8 px-4 py-3">
          <p className="text-sm font-semibold text-black/70">Assistant</p>
          <p className="text-[11px] text-black/40 mt-0.5">Select text + Ctrl+Y to capture a passage</p>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {chat.length === 0 && !isStreaming && (
            <div className="rounded-xl border border-dashed border-black/10 p-4 text-center">
              <p className="text-xs text-black/40 leading-relaxed">
                Ask Claude to improve a passage, expand an idea, or rewrite a section.
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
                    {entry.role === 'user' ? (
                      <p>{entry.content}</p>
                    ) : (
                      <p className="line-clamp-6 whitespace-pre-wrap">{entry.content}</p>
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
                {isActiveReview && review && (
                  <DiffReview
                    instruction={review.instruction}
                    diff={review.diff}
                    onAccept={acceptReview}
                    onReject={rejectReview}
                  />
                )}
              </div>
            )
          })}

          {isStreaming && (
            <div className="flex justify-start">
              <div className="max-w-[92%] rounded-xl border border-black/8 bg-white/60 px-3 py-2 text-xs text-black/60">
                {streamPreview ? (
                  <p className="whitespace-pre-wrap line-clamp-8">{streamPreview}</p>
                ) : (
                  <div className="flex items-center gap-2 text-black/40">
                    <Loader2 size={12} className="animate-spin" />
                    Writing…
                  </div>
                )}
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

        <div className="flex-shrink-0 border-t border-black/8 p-3 space-y-2">
          {highlightedText && (
            <div className="flex items-center gap-2 rounded-lg bg-black/[0.04] px-2 py-1.5">
              <span className="text-[10px] text-black/45 flex-shrink-0">Selection:</span>
              <span className="text-[10px] text-black/55 line-clamp-1 flex-1">"{highlightedText.slice(0, 80)}"</span>
              <button type="button" onClick={() => setHighlightedText('')} className="text-black/30 hover:text-black/50">
                <X size={10} />
              </button>
            </div>
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
              placeholder="Ask Claude to help…"
              className="glass-input flex-1 resize-none px-3 py-2 text-sm min-h-[2.5rem]"
            />
            <button
              type="button"
              onClick={handleAIAssist}
              disabled={isStreaming || !aiPrompt.trim() || !apiKey}
              className="btn-primary flex h-10 w-10 flex-shrink-0 items-center justify-center disabled:opacity-40"
              title="Send"
            >
              {isStreaming ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </button>
          </div>
        </div>
      </aside>
    </div>
  )
}

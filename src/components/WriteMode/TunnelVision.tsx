import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { diffWords } from 'diff'
import { Loader2, Send, ArrowLeft } from 'lucide-react'
import { sanitizeAiProse } from '../../lib/aiText'
import { syncChat } from '../../lib/claude'
import { useHasApiKey } from '../../store/useStore'
import type { DiffChange } from './DiffReview'

export interface RefinePanelProps {
  sentence: string
  contextBefore: string
  contextAfter: string
  apiKey: string
  styleGuide: string
  researchContext: string
  onApply: (text: string) => void
  onClose: () => void
}

type Selection = 'original' | number

function parseRefineOptions(raw: string): string[] {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  try {
    const obj = JSON.parse(text)
    const arr = Array.isArray(obj) ? obj : obj?.options
    if (Array.isArray(arr)) {
      return arr.map((x) => sanitizeAiProse(String(x).trim())).filter(Boolean)
    }
  } catch {
    /* fall through */
  }
  const first = text.indexOf('[')
  const last = text.lastIndexOf(']')
  if (first !== -1 && last > first) {
    try {
      const arr = JSON.parse(text.slice(first, last + 1))
      if (Array.isArray(arr)) return arr.map((x) => sanitizeAiProse(String(x).trim())).filter(Boolean)
    } catch {
      /* ignore */
    }
  }
  return text
    .split(/\n+/)
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').replace(/^[-*]\s*/, '').trim())
    .map((l) => sanitizeAiProse(l))
    .filter(Boolean)
    .slice(0, 4)
}

function buildDiffParts(diff: DiffChange[]) {
  const parts: Array<{ type: 'same'; text: string } | { type: 'change'; removed: string; added: string }> = []
  let i = 0
  while (i < diff.length) {
    const seg = diff[i]
    if (!seg.added && !seg.removed) {
      parts.push({ type: 'same', text: seg.value })
      i++
    } else {
      let removed = ''
      let added = ''
      while (i < diff.length && (diff[i].added || diff[i].removed)) {
        if (diff[i].removed) removed += diff[i].value
        else added += diff[i].value
        i++
      }
      parts.push({ type: 'change', removed, added })
    }
  }
  return parts
}

function DiffPreview({ original, revised }: { original: string; revised: string }) {
  const parts = useMemo(
    () => buildDiffParts(diffWords(original, revised) as DiffChange[]),
    [original, revised]
  )
  return (
    <span className="refine-panel-diff">
      {parts.map((part, idx) => {
        if (part.type === 'same') return <span key={idx}>{part.text}</span>
        return (
          <span key={idx}>
            {part.removed && <span className="diff-remove">{part.removed}</span>}
            {part.added && <span className="diff-add">{part.added}</span>}
          </span>
        )
      })}
    </span>
  )
}

export default function RefinePanel({
  sentence,
  contextBefore,
  contextAfter,
  apiKey,
  styleGuide,
  researchContext,
  onApply,
  onClose,
}: RefinePanelProps) {
  const [options, setOptions] = useState<string[]>([])
  const [selection, setSelection] = useState<Selection>('original')
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const hasApiKey = useHasApiKey()

  const selectedText =
    selection === 'original' ? sentence : options[selection] ?? sentence

  const hasChanges = selectedText.trim() !== sentence.trim()

  useEffect(() => {
    promptRef.current?.focus()
  }, [])

  const generate = useCallback(
    async (instruction: string, refineFrom?: string) => {
      if (!hasApiKey) return
      const trimmed = instruction.trim() || 'Improve this passage while preserving its meaning.'
      setLoading(true)
      setOptions([])

      const system = `You are a sentence-level writing assistant. You generate alternative versions of ONE sentence or short passage.
Preserve the writer's meaning and intent. Keep roughly the same length unless asked otherwise.
Return ONLY JSON: {"options":["version 1","version 2","version 3"]}. Exactly 3 options, each a complete replacement. No commentary.

${styleGuide ? styleGuide + '\n\n' : ''}${researchContext ? `=== CONTEXT (for grounding) ===\n${researchContext.slice(0, 2000)}` : ''}`

      const refineNote = refineFrom
        ? `\n\nThe writer is iterating on this version:\n"${refineFrom}"\nTheir feedback: "${trimmed}"\nGenerate 3 new options that act on this feedback.`
        : ''

      const user = `Surrounding text (do not rewrite, for context only):
...${contextBefore.slice(-300)} [[PASSAGE]] ${contextAfter.slice(0, 300)}...

The passage to rework:
"${sentence}"

Instruction: ${trimmed}${refineNote}`

      try {
        const res = await syncChat([{ role: 'user', content: user }], system, apiKey, 1200)
        const opts = parseRefineOptions(res)
        if (opts.length > 0) {
          setOptions(opts)
          setSelection(0)
        }
      } catch {
        /* silent — user can retry */
      } finally {
        setLoading(false)
      }
    },
    [apiKey, hasApiKey, styleGuide, researchContext, contextBefore, contextAfter, sentence]
  )

  const handleSend = () => {
    const trimmed = prompt.trim()
    if (!trimmed || loading) return
    setPrompt('')
    const refineFrom =
      selection !== 'original' && options[selection as number]
        ? options[selection as number]
        : hasChanges
          ? selectedText
          : undefined
    void generate(trimmed, refineFrom)
  }

  const syncPromptHeight = () => {
    const el = promptRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    el.style.overflowY = 'hidden'
  }

  return (
    <div className="refine-panel write-mode h-full flex flex-col min-h-0">
      <div className="refine-panel-header">
        <button type="button" className="refine-panel-back" onClick={onClose} title="Exit refine (Esc)">
          <ArrowLeft size={14} />
        </button>
        <span className="refine-panel-title">Refine</span>
      </div>

      <div className="refine-panel-pills">
        <button
          type="button"
          className={`refine-panel-pill${selection === 'original' ? ' active' : ''}`}
          onClick={() => setSelection('original')}
        >
          Original
        </button>
        {options.map((_, i) => (
          <button
            key={i}
            type="button"
            className={`refine-panel-pill${selection === i ? ' active' : ''}`}
            onClick={() => setSelection(i)}
          >
            Option {i + 1}
          </button>
        ))}
        {loading && (
          <span className="refine-panel-pill refine-panel-pill--loading">
            <Loader2 size={11} className="animate-spin" />
          </span>
        )}
      </div>

      <div className="refine-panel-text">
        {loading ? (
          <div className="refine-panel-text-empty">
            <Loader2 size={13} className="animate-spin" />
            <span>Composing options…</span>
          </div>
        ) : selection === 'original' || !options[selection as number] ? (
          <p className="refine-panel-text-body">{sentence}</p>
        ) : (
          <p className="refine-panel-text-body">
            <DiffPreview original={sentence} revised={options[selection as number]} />
          </p>
        )}
      </div>

      <div className="refine-panel-input assistant-input-zone">
        <div className="assistant-input-bar">
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value)
              requestAnimationFrame(syncPromptHeight)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            rows={1}
            placeholder="Suggest something else…"
            className="assistant-textarea"
            disabled={loading}
          />
          {loading ? (
            <Loader2 size={14} className="assistant-input-spinner animate-spin flex-shrink-0" />
          ) : (
            <button
              type="button"
              className="glass-btn assistant-send-btn"
              onClick={handleSend}
              disabled={!prompt.trim() || !hasApiKey}
              title="Send"
              aria-label="Send"
            >
              <Send size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="refine-panel-footer">
        <button
          type="button"
          className="glass-btn w-full"
          onClick={() => onApply(selectedText)}
          disabled={!hasChanges}
        >
          Apply these changes
        </button>
      </div>
    </div>
  )
}

import { useState, useCallback, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, Sparkles, X, Check, RefreshCw, ArrowRight } from 'lucide-react'
import { syncChat } from '../../lib/claude'
import { useHasApiKey } from '../../store/useStore'

interface TunnelVisionProps {
  sentence: string
  contextBefore: string
  contextAfter: string
  apiKey: string
  styleGuide: string
  researchContext: string
  onApply: (text: string) => void
  onClose: () => void
}

function parseOptions(raw: string): string[] {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  try {
    const obj = JSON.parse(text)
    const arr = Array.isArray(obj) ? obj : obj?.options
    if (Array.isArray(arr)) {
      return arr.map((x) => String(x).trim()).filter(Boolean)
    }
  } catch {
    /* fall through */
  }
  const first = text.indexOf('[')
  const last = text.lastIndexOf(']')
  if (first !== -1 && last > first) {
    try {
      const arr = JSON.parse(text.slice(first, last + 1))
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean)
    } catch {
      /* ignore */
    }
  }
  // Last resort: split lines.
  return text
    .split(/\n+/)
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 4)
}

export default function TunnelVision({
  sentence,
  contextBefore,
  contextAfter,
  apiKey,
  styleGuide,
  researchContext,
  onApply,
  onClose,
}: TunnelVisionProps) {
  const [instruction, setInstruction] = useState('')
  const [feedback, setFeedback] = useState('')
  const [options, setOptions] = useState<string[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const hasApiKey = useHasApiKey()

  useEffect(() => {
    promptRef.current?.focus()
  }, [])

  const generate = useCallback(
    async (mode: 'fresh' | 'refine') => {
      if (!hasApiKey) {
        setError('No API key set.')
        return
      }
      const baseInstruction = instruction.trim() || 'Improve this sentence while preserving its meaning.'
      setLoading(true)
      setError('')

      const system = `You are a sentence-level writing assistant. You generate alternative versions of ONE sentence (or short passage).
Preserve the writer's meaning and intent. Keep roughly the same length unless asked otherwise.
Return ONLY JSON: {"options":["version 1","version 2","version 3"]}. Exactly 3 options, each a complete replacement for the sentence. No commentary.

${styleGuide ? styleGuide + '\n\n' : ''}${researchContext ? `=== CONTEXT (for grounding) ===\n${researchContext.slice(0, 2000)}` : ''}`

      const refineNote =
        mode === 'refine' && selected !== null
          ? `\n\nThe writer chose this version:\n"${options[selected]}"\nTheir feedback: "${feedback.trim() || 'make it stronger'}"\nGenerate 3 new options that act on this feedback.`
          : ''

      const user = `Surrounding text (do not rewrite, for context only):
...${contextBefore.slice(-300)} [[SENTENCE]] ${contextAfter.slice(0, 300)}...

The sentence to rework:
"${sentence}"

Instruction: ${baseInstruction}${refineNote}`

      try {
        const res = await syncChat([{ role: 'user', content: user }], system, apiKey, 1200)
        const opts = parseOptions(res)
        if (opts.length === 0) {
          setError('Could not parse options. Try again.')
        } else {
          setOptions(opts)
          setSelected(null)
          setFeedback('')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Generation failed.')
      } finally {
        setLoading(false)
      }
    },
    [apiKey, hasApiKey, instruction, styleGuide, researchContext, contextBefore, contextAfter, sentence, selected, options, feedback]
  )

  return (
    <motion.div
      className="tunnel-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
    >
      <button className="tunnel-close" onClick={onClose} title="Exit focus (Esc)">
        <X size={18} />
      </button>

      <div className="tunnel-content">
        <motion.div
          className="tunnel-context-line"
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.25 }}
          transition={{ delay: 0.1 }}
        >
          {contextBefore.slice(-160)}
        </motion.div>

        <motion.div
          className="tunnel-sentence"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
        >
          {sentence}
        </motion.div>

        <motion.div
          className="tunnel-context-line"
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.25 }}
          transition={{ delay: 0.1 }}
        >
          {contextAfter.slice(0, 160)}
        </motion.div>

        {/* Prompt */}
        <div className="tunnel-prompt-row">
          <textarea
            ref={promptRef}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                generate('fresh')
              }
            }}
            rows={1}
            placeholder="How should this sentence change? (e.g. make it sharper, add tension)"
            className="glass-input tunnel-input"
          />
          <button
            className="btn-primary tunnel-generate"
            onClick={() => generate('fresh')}
            disabled={loading}
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            Generate
          </button>
        </div>

        {error && <p className="tunnel-error">{error}</p>}

        {/* Options */}
        <AnimatePresence>
          {options.length > 0 && (
            <motion.div
              className="tunnel-options"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              {options.map((opt, i) => (
                <motion.button
                  key={i}
                  className={`tunnel-option ${selected === i ? 'selected' : ''}`}
                  onClick={() => setSelected(i)}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.06 }}
                >
                  <span className="tunnel-option-index">{i + 1}</span>
                  <span className="tunnel-option-text">{opt}</span>
                  {selected === i && <Check size={15} className="tunnel-option-check" />}
                </motion.button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Refine / apply */}
        <AnimatePresence>
          {selected !== null && (
            <motion.div
              className="tunnel-actions"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <div className="tunnel-refine-row">
                <input
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      generate('refine')
                    }
                  }}
                  placeholder="Feedback to refine the selected option…"
                  className="glass-input tunnel-feedback"
                />
                <button className="btn-ghost tunnel-refine-btn" onClick={() => generate('refine')} disabled={loading}>
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  Refine
                </button>
              </div>
              <button
                className="btn-primary tunnel-apply"
                onClick={() => selected !== null && onApply(options[selected])}
              >
                <ArrowRight size={15} />
                Use this version
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

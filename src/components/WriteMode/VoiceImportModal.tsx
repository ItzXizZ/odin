import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Upload, Loader2, FileText, Copy, Check, Sparkles } from 'lucide-react'
import {
  analyzeWritingForVoice,
  readWritingFile,
  filterNewVoiceRules,
  compileImportVoicePrompt,
  type ExtractedVoiceRule,
} from '../../lib/voiceImport'
import type { StyleRule } from '../../lib/style'

export interface VoiceImportResult {
  fileName: string
  rules: ExtractedVoiceRule[]
  promptText: string
  addedCount: number
}

interface Props {
  open: boolean
  onClose: () => void
  apiKey: string
  hasApiKey: boolean
  styleRules: StyleRule[]
  onImport: (rules: ExtractedVoiceRule[]) => string[]
  onComplete?: (result: VoiceImportResult) => void
}

const ACCEPT = '.txt,.md,.pdf,text/plain,text/markdown,application/pdf'

export default function VoiceImportModal({
  open,
  onClose,
  apiKey,
  hasApiKey,
  styleRules,
  onImport,
  onComplete,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [status, setStatus] = useState('Reading your writing…')
  const [error, setError] = useState<string | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [result, setResult] = useState<VoiceImportResult | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)
  const [copied, setCopied] = useState(false)

  const reset = () => {
    setDragOver(false)
    setStatus('Reading your writing…')
    setError(null)
    setAnalyzing(false)
    setResult(null)
    setShowPrompt(false)
    setCopied(false)
  }

  useEffect(() => {
    if (open) reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleClose = () => {
    reset()
    onClose()
  }

  const runImport = async (file: File) => {
    if (!hasApiKey) {
      setError('Add an API key in Settings to analyze your writing.')
      return
    }
    setError(null)
    setAnalyzing(true)
    setResult(null)
    setStatus('Reading your writing…')
    try {
      const raw = await readWritingFile(file)
      setStatus('Distilling voice principles from your prose…')
      const extracted = await analyzeWritingForVoice({
        text: raw,
        apiKey,
        existingRules: styleRules,
      })
      const toAdd = filterNewVoiceRules(extracted, styleRules)
      if (toAdd.length === 0) {
        setError(
          'No new principles to add — this sample matched what you already have. Delete nodes manually if you want to trim your voice.'
        )
        setAnalyzing(false)
        return
      }
      const addedIds = onImport(toAdd)
      const session: VoiceImportResult = {
        fileName: file.name,
        rules: toAdd,
        promptText: compileImportVoicePrompt(toAdd, file.name),
        addedCount: addedIds.length,
      }
      setResult(session)
      onComplete?.(session)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setAnalyzing(false)
    }
  }

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) void runImport(file)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) void runImport(file)
  }

  const copyPrompt = async () => {
    if (!result?.promptText) return
    try {
      await navigator.clipboard.writeText(result.promptText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="voice-import-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="voice-import-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !analyzing) handleClose()
      }}
    >
      <motion.div
        className="voice-import-modal"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      >
        <header className="voice-import-head">
          <div>
            <h2 id="voice-import-title" className="voice-import-title">
              {result ? 'Voice principles created' : 'Import your writing'}
            </h2>
            <p className="voice-import-sub">
              {result
                ? `${result.addedCount} new node${result.addedCount === 1 ? '' : 's'} added to your network`
                : 'Upload a sample — Odin reads your prose and grows new voice nodes'}
            </p>
          </div>
          {!analyzing && (
            <button type="button" className="voice-import-close" onClick={handleClose} aria-label="Close">
              <X size={18} />
            </button>
          )}
        </header>

        <div className="voice-import-body">
          <AnimatePresence mode="wait">
            {analyzing && (
              <motion.div
                key="loading"
                className="voice-import-loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <Loader2 size={28} className="animate-spin text-black/40" />
                <p>{status}</p>
              </motion.div>
            )}

            {!analyzing && error && !result && (
              <motion.div
                key="error"
                className="voice-import-error"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                <p>{error}</p>
                <button type="button" className="btn-ghost text-sm" onClick={() => setError(null)}>
                  Try again
                </button>
              </motion.div>
            )}

            {!analyzing && result && (
              <motion.div
                key="results"
                className="voice-import-results"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                <div className="voice-import-file">
                  <FileText size={14} />
                  <span>{result.fileName}</span>
                </div>

                <div className="voice-import-nodes">
                  {result.rules.map((rule, i) => (
                    <motion.article
                      key={`${rule.label}-${i}`}
                      className="voice-import-node"
                      initial={{ opacity: 0, y: 10, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={{ delay: i * 0.05, type: 'spring', stiffness: 420, damping: 28 }}
                    >
                      <div className="voice-import-node-orb" aria-hidden="true">
                        <Sparkles size={12} />
                      </div>
                      <div className="voice-import-node-text">
                        <h3>{rule.label}</h3>
                        <p>{rule.instruction}</p>
                      </div>
                    </motion.article>
                  ))}
                </div>

                <div className="voice-import-actions">
                  <button
                    type="button"
                    className="btn-ghost text-sm flex items-center gap-1.5"
                    onClick={() => setShowPrompt(true)}
                  >
                    <Copy size={14} />
                    Copy prompt
                  </button>
                  <button type="button" className="btn-primary text-sm" onClick={handleClose}>
                    Done
                  </button>
                </div>
              </motion.div>
            )}

            {!analyzing && !result && !error && (
              <motion.div
                key="upload"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <button
                  type="button"
                  className={`voice-import-dropzone ${dragOver ? 'active' : ''}`}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragOver(true)
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDrop}
                >
                  <Upload size={26} strokeWidth={1.5} />
                  <span className="voice-import-drop-title">Drop a file here or click to browse</span>
                  <span className="voice-import-drop-hint">.txt, .md, or .pdf — your voice stays private</span>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPT}
                  className="sr-only"
                  onChange={onFileChange}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      <AnimatePresence>
        {showPrompt && result && (
          <motion.div
            className="voice-import-prompt-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={(e) => {
              if (e.target === e.currentTarget) setShowPrompt(false)
            }}
          >
            <motion.div
              className="voice-import-prompt-panel"
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
            >
              <header className="voice-import-prompt-head">
                <h3>Generated voice prompt</h3>
                <button type="button" onClick={() => setShowPrompt(false)} aria-label="Close">
                  <X size={16} />
                </button>
              </header>
              <p className="voice-import-prompt-note">
                Paste this into any AI writing tool to approximate your voice from this document.
              </p>
              <pre className="voice-import-prompt-text">{result.promptText}</pre>
              <button
                type="button"
                className="btn-primary text-sm flex items-center gap-1.5 self-end"
                onClick={() => void copyPrompt()}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'Copied' : 'Copy to clipboard'}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, PenTool, Upload, FileText, X, BookOpen, AlertCircle, RotateCcw } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore, useHasApiKey, type GradeResult, type GradeAnnotation } from '../../store/useStore'
import { syncChat, uploadPDF } from '../../lib/claude'
import OdinHead from '../OdinHead'

/* ── Tiny typewriter so Odin's mouth has something to move for ── */
function useTypewriter(text: string, speed = 22) {
  const [shown, setShown] = useState('')
  useEffect(() => {
    setShown('')
    if (!text) return
    let i = 0
    const id = window.setInterval(() => {
      i++
      setShown(text.slice(0, i))
      if (i >= text.length) window.clearInterval(id)
    }, speed)
    return () => window.clearInterval(id)
  }, [text, speed])
  return { shown, done: shown.length >= text.length }
}

/** Odin's evaluative philosophy — straight from Zinsser's On Writing Well. */
const ZINSSER_CREED = `You are Odin, an exacting but warm writing critic who judges prose entirely through William Zinsser's "On Writing Well". Your convictions:
- Strip every sentence to its cleanest components; clutter is the enemy.
- Clear thinking becomes clear writing.
- Use active, working verbs; avoid passive constructions and "is/are" sentences.
- Most adverbs and adjectives are unnecessary — a weak adverb means the wrong verb.
- Prefer the simple, concrete word over the fancy or abstract one.
- Cut jargon and clichés. Keep paragraphs short.
- Style is humanity and warmth; let a real person speak.
You are specific, honest, and kind. You never flatter.`

/** Five evaluation dimensions when no rubric is supplied. */
const ZINSSER_DIMENSIONS = `Clarity & clutter, active verbs, voice & humanity, word choice & precision, and structure (lead, flow, ending).`

/* ── Category → colour (rgb triplet) + readable label ── */
function catRGB(cat: string): string {
  switch (cat) {
    case 'clutter':
    case 'wordy':
      return '170, 60, 60' // red — cut it
    case 'passive':
    case 'adverb':
    case 'adjective':
      return '176, 116, 28' // amber — weak verbs/modifiers
    case 'abstraction':
    case 'vague':
      return '124, 74, 162' // violet — too abstract
    case 'cliche':
    case 'jargon':
      return '22, 112, 122' // teal — tired language
    default:
      return '30, 65, 140' // blue — general note
  }
}
function catLabel(cat: string): string {
  const map: Record<string, string> = {
    clutter: 'Clutter',
    wordy: 'Wordiness',
    passive: 'Passive / weak verb',
    adverb: 'Adverb',
    adjective: 'Adjective',
    abstraction: 'Abstraction',
    vague: 'Vague',
    cliche: 'Cliché',
    jargon: 'Jargon',
    other: 'Note',
  }
  return map[cat] ?? 'Note'
}

/** Turn stored document HTML into clean paragraphs (entities decoded, tags gone). */
function htmlToParagraphs(html: string): string[] {
  if (!html) return []
  const withBreaks = html
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
  const tmp = document.createElement('div')
  tmp.innerHTML = withBreaks
  const text = tmp.textContent ?? ''
  return text
    .split(/\n{2,}/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function normalizeQuote(q: string): string {
  return q
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

interface Segment {
  text: string
  ann?: number
}

/** Locate each annotation's quote inside a paragraph and split into segments. */
function buildSegments(para: string, anns: GradeAnnotation[], claimed: Set<number>): Segment[] {
  const ranges: { start: number; end: number; idx: number }[] = []
  const lowerPara = para.toLowerCase()
  anns.forEach((ann, idx) => {
    if (claimed.has(idx)) return
    const q = normalizeQuote(ann.quote)
    if (q.length < 2) return
    let pos = para.indexOf(q)
    if (pos === -1) pos = lowerPara.indexOf(q.toLowerCase())
    if (pos === -1) return
    const end = pos + q.length
    if (ranges.some((r) => pos < r.end && end > r.start)) return
    ranges.push({ start: pos, end, idx })
    claimed.add(idx)
  })
  ranges.sort((a, b) => a.start - b.start)

  const segs: Segment[] = []
  let cur = 0
  for (const r of ranges) {
    if (r.start > cur) segs.push({ text: para.slice(cur, r.start) })
    segs.push({ text: para.slice(r.start, r.end), ann: r.idx })
    cur = r.end
  }
  if (cur < para.length) segs.push({ text: para.slice(cur) })
  return segs
}

export default function GradeMode() {
  const {
    documents,
    activeDocumentId,
    rubric,
    gradeResult,
    isGrading,
    apiKey,
    setRubric,
    setGradeResult,
    setIsGrading,
    setActiveTab,
  } = useStore()
  const hasApiKey = useHasApiKey()

  const [error, setError] = useState('')
  const [lens, setLens] = useState<'zinsser' | 'rubric'>('zinsser')
  const [rubricFileName, setRubricFileName] = useState('')
  const [uploadingRubric, setUploadingRubric] = useState(false)
  const [activeAnn, setActiveAnn] = useState<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const docScrollRef = useRef<HTMLDivElement>(null)
  const noteRefs = useRef<Record<number, HTMLButtonElement | null>>({})

  const activeDoc = documents.find((d) => d.id === activeDocumentId) ?? documents[0]
  const activeDocTab = activeDoc?.tabs.find((t) => t.id === activeDoc.activeTabId) ?? activeDoc?.tabs[0]
  const documentContent = activeDocTab?.content ?? ''
  const documentTitle = activeDoc?.title ?? 'Untitled'

  const paragraphs = useMemo(() => htmlToParagraphs(documentContent), [documentContent])
  const plainText = paragraphs.join(' ')
  const wordCount = plainText.split(/\s+/).filter(Boolean).length

  const annotations = gradeResult?.annotations ?? []

  /* Match annotations to paragraphs once per result/document. */
  const { rendered, matched } = useMemo(() => {
    const claimed = new Set<number>()
    const rendered = paragraphs.map((p) => buildSegments(p, annotations, claimed))
    return { rendered, matched: claimed }
  }, [paragraphs, annotations])

  const usingRubric = lens === 'rubric' && rubric.trim().length > 0

  /* ── Odin's spoken line ── */
  const odinLine = isGrading
    ? 'Reading closely. Hunting for clutter, limp verbs, and places your voice goes quiet…'
    : gradeResult
    ? gradeResult.odinVerdict || gradeResult.summary
    : plainText
    ? "Bring me your prose. I'll mark every word that doesn't earn its place."
    : 'Nothing here yet. Write something, then return and I will read every line.'
  const { shown: odinShown, done: odinDone } = useTypewriter(odinLine)
  const odinTalking = isGrading || !odinDone

  const focusNote = (idx: number) => {
    setActiveAnn(idx)
    noteRefs.current[idx]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
  const focusHighlight = (idx: number) => {
    setActiveAnn(idx)
    const el = docScrollRef.current?.querySelector<HTMLElement>(`[data-ann="${idx}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const handleRubricFile = async (file: File) => {
    setError('')
    setUploadingRubric(true)
    try {
      const name = file.name.toLowerCase()
      let text = ''
      if (file.type === 'application/pdf' || name.endsWith('.pdf')) {
        text = (await uploadPDF(file)).text
      } else {
        text = await file.text()
      }
      const cleaned = text.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
      if (!cleaned) throw new Error('No readable text found in that file.')
      setRubric(cleaned.slice(0, 6000))
      setRubricFileName(file.name)
      setLens('rubric')
    } catch (err: any) {
      setError(err.message || 'Could not read that rubric file.')
    } finally {
      setUploadingRubric(false)
    }
  }

  const handleGrade = async () => {
    if (!plainText.trim()) {
      setError('Nothing to grade yet — write something first.')
      return
    }
    if (!hasApiKey) {
      setError('No API key set. Open Settings to add one.')
      return
    }

    setIsGrading(true)
    setError('')
    setGradeResult(null)
    setActiveAnn(null)

    const lensBlock = usingRubric
      ? `Score against THIS rubric (use its own criterion names + point values), but apply Zinsser's principles throughout:\n${rubric}`
      : `No rubric was supplied. Judge the writing on Zinsser's core dimensions: ${ZINSSER_DIMENSIONS}`

    const prompt = `${lensBlock}

Then mark the specific PROBLEMATIC REGIONS in the text — the exact phrases that violate Zinsser's principles (clutter, passive/weak verbs, needless adverbs/adjectives, abstraction, vague wording, clichés, jargon). For each, copy the offending phrase VERBATIM from the document (2–12 words, exactly as written so it can be located), name its category, say what's wrong, and give a concrete fix. Flag the 6–14 most important regions.

DOCUMENT — "${documentTitle}" (${wordCount} words):
"""
${plainText.slice(0, 9000)}
"""

Respond with ONLY valid JSON, no markdown fences:
{
  "overallScore": <0-100>,
  "odinVerdict": "<1-2 sentences spoken in Odin's voice — the single most important judgment, warm but honest>",
  "summary": "<2-3 sentence overall assessment>",
  "annotations": [
    {
      "quote": "<verbatim phrase copied exactly from the document>",
      "category": "clutter | wordy | passive | adverb | adjective | abstraction | vague | cliche | jargon | other",
      "issue": "<what's wrong, grounded in Zinsser>",
      "suggestion": "<a concrete fix>"
    }
  ]
}`

    try {
      const response = await syncChat(
        [{ role: 'user', content: prompt }],
        `${ZINSSER_CREED}\n\nAlways respond with valid JSON only — no markdown fences, no prose outside the JSON.`,
        apiKey,
        3000
      )
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('Odin could not phrase his verdict. Try again.')
      const result: GradeResult = JSON.parse(jsonMatch[0])
      if (!Array.isArray(result.annotations)) result.annotations = []
      setGradeResult(result)
    } catch (err: any) {
      setError(err.message || 'Grading failed. Please try again.')
    } finally {
      setIsGrading(false)
    }
  }

  const scoreRGB = (pct: number) =>
    pct >= 85 ? '30, 110, 60' : pct >= 70 ? '30, 65, 140' : pct >= 55 ? '176, 116, 28' : '170, 60, 60'

  return (
    <div className="critic">
      {/* ── Header ── */}
      <div className="critic-header">
        <div className="min-w-0">
          <h1 className="critic-title">The Critic</h1>
          <p className="critic-sub">
            Odin marks your prose against Zinsser's <em>On Writing Well</em>
            {documentTitle !== 'Untitled' && ` · "${documentTitle}"`} · {wordCount} words
          </p>
        </div>
        <div className="critic-header-actions">
          <div className="critic-lens-toggle">
            <button
              className={`critic-lens-pill${lens === 'zinsser' ? ' active' : ''}`}
              onClick={() => setLens('zinsser')}
            >
              Zinsser
            </button>
            <button
              className={`critic-lens-pill${lens === 'rubric' ? ' active' : ''}`}
              onClick={() => setLens('rubric')}
            >
              Rubric
            </button>
          </div>
          <button onClick={() => setActiveTab('write')} className="btn-ghost flex items-center gap-2">
            <PenTool size={14} />
            Compose
          </button>
        </div>
      </div>

      {/* ── Rubric bar (only when the rubric lens is active) ── */}
      <AnimatePresence initial={false}>
        {lens === 'rubric' && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="critic-rubric-bar">
              <textarea
                value={rubric}
                onChange={(e) => setRubric(e.target.value)}
                placeholder="Criterion (X pts): description — one per line"
                className="critic-textarea"
              />
              <div className="critic-rubric-actions">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.txt,.md,.markdown"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) handleRubricFile(f)
                    e.target.value = ''
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingRubric}
                  className="btn-ghost flex items-center gap-2 disabled:opacity-50"
                >
                  {uploadingRubric ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                  Upload PDF
                </button>
                {rubricFileName && (
                  <span className="critic-file-chip">
                    <FileText size={12} />
                    <span className="truncate max-w-[10rem]">{rubricFileName}</span>
                    <button
                      type="button"
                      aria-label="Clear rubric"
                      onClick={() => {
                        setRubricFileName('')
                        setRubric('')
                      }}
                    >
                      <X size={12} />
                    </button>
                  </span>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Body: document on the left, Odin + notes on the right ── */}
      <div className="critic-body">
        {/* Document with live highlights */}
        <div className="critic-doc card">
          <div ref={docScrollRef} className="critic-doc-scroll">
            {paragraphs.length === 0 ? (
              <p className="critic-doc-empty">
                This document is empty. Head to Compose, write something, then come back to be read.
              </p>
            ) : (
              rendered.map((segs, pi) => (
                <p key={pi} className="critic-doc-p">
                  {segs.map((seg, si) =>
                    seg.ann != null ? (
                      <mark
                        key={si}
                        data-ann={seg.ann}
                        className={`critic-hl${activeAnn === seg.ann ? ' active' : ''}`}
                        style={{ ['--hl' as any]: catRGB(annotations[seg.ann]?.category ?? 'other') }}
                        onClick={() => focusNote(seg.ann!)}
                      >
                        {seg.text}
                      </mark>
                    ) : (
                      <span key={si}>{seg.text}</span>
                    )
                  )}
                </p>
              ))
            )}
          </div>
        </div>

        {/* Right rail */}
        <div className="critic-rail">
          {/* Odin */}
          <div className="critic-odin card">
            <motion.div
              className="critic-odin-avatar"
              animate={{ y: [0, -4, 0], rotate: [0, -2, 2, 0] }}
              transition={{ duration: 3.4, repeat: Infinity, ease: 'easeInOut' }}
            >
              <OdinHead talking={odinTalking} size={56} />
            </motion.div>
            <div className="critic-odin-body">
              <div className="critic-odin-meta">
                <span className="critic-odin-name">Odin</span>
                {gradeResult && !isGrading && (
                  <span
                    className="critic-score-pill"
                    style={{ ['--sc' as any]: scoreRGB(gradeResult.overallScore) }}
                  >
                    {gradeResult.overallScore}<span>/100</span>
                  </span>
                )}
              </div>
              <p className="critic-odin-say">
                {odinShown}
                {!odinDone && <span className="odin-caret" />}
              </p>
            </div>
          </div>

          {/* Evaluate action */}
          <div className="critic-actions">
            <button
              onClick={handleGrade}
              disabled={isGrading || !plainText || !hasApiKey}
              className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-40 py-2.5"
            >
              {isGrading ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  Reading…
                </>
              ) : (
                <>
                  <BookOpen size={15} />
                  {gradeResult ? 'Re-evaluate' : 'Ask Odin to evaluate'}
                </>
              )}
            </button>
            {gradeResult && !isGrading && (
              <button
                onClick={() => {
                  setGradeResult(null)
                  setActiveAnn(null)
                }}
                className="btn-ghost flex items-center justify-center gap-2 py-2"
                title="Clear verdict"
              >
                <RotateCcw size={13} />
              </button>
            )}
          </div>

          {error && (
            <p className="critic-error flex items-center gap-2">
              <AlertCircle size={14} />
              {error}
            </p>
          )}

          {/* Notes */}
          {gradeResult && annotations.length > 0 && (
            <div className="critic-notes card">
              <div className="critic-notes-head">
                {annotations.length} {annotations.length === 1 ? 'note' : 'notes'}
              </div>
              <div className="critic-notes-list">
                {annotations.map((ann, idx) => (
                  <button
                    key={idx}
                    ref={(el) => (noteRefs.current[idx] = el)}
                    className={`critic-note${activeAnn === idx ? ' active' : ''}${matched.has(idx) ? '' : ' unlocated'}`}
                    style={{ ['--hl' as any]: catRGB(ann.category) }}
                    onClick={() => (matched.has(idx) ? focusHighlight(idx) : setActiveAnn(idx))}
                  >
                    <span className="critic-note-cat">{catLabel(ann.category)}</span>
                    {ann.quote && <span className="critic-note-quote">"{normalizeQuote(ann.quote)}"</span>}
                    <span className="critic-note-issue">{ann.issue}</span>
                    <span className="critic-note-fix">
                      <span className="critic-note-fix-label">Try</span> {ann.suggestion}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

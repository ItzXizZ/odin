import { useState } from 'react'
import { Star, Loader2, RotateCcw, ChevronDown, ChevronUp, PenTool, CheckCircle, AlertCircle, TrendingUp } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore, type GradeResult } from '../../store/useStore'
import { syncChat } from '../../lib/claude'

export default function GradeMode() {
  const { documentContent, documentTitle, rubric, gradeResult, isGrading, apiKey, setRubric, setGradeResult, setIsGrading, setActiveTab } = useStore()

  const [expandedCriterion, setExpandedCriterion] = useState<number | null>(null)
  const [error, setError] = useState('')

  const plainText = documentContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  const wordCount = plainText.split(/\s+/).filter(Boolean).length

  const handleGrade = async () => {
    if (!plainText.trim()) {
      setError('No document to grade. Write something first.')
      return
    }
    if (!apiKey) {
      setError('No API key set. Go to Settings.')
      return
    }
    if (!rubric.trim()) {
      setError('Please enter a grading rubric.')
      return
    }

    setIsGrading(true)
    setError('')
    setGradeResult(null)

    const prompt = `You are an expert writing evaluator. Grade the following essay/document based on the provided rubric.

RUBRIC:
${rubric}

DOCUMENT (${wordCount} words):
"${plainText.slice(0, 8000)}"

Respond with ONLY valid JSON in this exact format:
{
  "overallScore": <number 0-100>,
  "rubricScores": [
    {
      "criterion": "<criterion name>",
      "score": <number>,
      "maxScore": <number from rubric or 25>,
      "feedback": "<2-3 sentences of specific feedback>"
    }
  ],
  "strengths": ["<strength 1>", "<strength 2>", "<strength 3>"],
  "improvements": ["<improvement 1>", "<improvement 2>", "<improvement 3>"],
  "summary": "<2-3 sentence overall assessment>"
}`

    try {
      const response = await syncChat(
        [{ role: 'user', content: prompt }],
        'You are an expert writing evaluator and academic grader. Be fair, specific, and constructive. Always respond with valid JSON only.',
        apiKey,
        2048
      )

      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('Could not parse grading response')

      const result: GradeResult = JSON.parse(jsonMatch[0])
      setGradeResult(result)
    } catch (err: any) {
      setError(err.message || 'Grading failed. Please try again.')
    } finally {
      setIsGrading(false)
    }
  }

  const scoreColor = (score: number, max: number) => {
    const pct = (score / max) * 100
    if (pct >= 85) return 'text-green-400'
    if (pct >= 70) return 'text-accent-gold'
    if (pct >= 55) return 'text-orange-400'
    return 'text-red-400'
  }

  const scoreRingOffset = (score: number) => {
    const circumference = 283
    return circumference - (score / 100) * circumference
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="font-caveat text-3xl font-bold text-white">AI Grader</h1>
            <p className="mt-1 text-sm text-white/40">
              {documentTitle !== 'Untitled' ? `"${documentTitle}"` : 'Your document'} · {wordCount} words
            </p>
          </div>
          <button onClick={() => setActiveTab('write')} className="btn-ghost flex items-center gap-2">
            <PenTool size={14} />
            Back to Write
          </button>
        </div>

        {/* Document preview */}
        {plainText && (
          <div className="card p-4">
            <p className="mb-2 text-xs text-white/30 font-caveat text-sm">Document preview</p>
            <p className="text-sm text-white/50 leading-relaxed line-clamp-3 font-writing">
              {plainText.slice(0, 400)}
              {plainText.length > 400 && '...'}
            </p>
          </div>
        )}

        {/* Rubric */}
        <div className="card p-5">
          <div className="mb-3 flex items-center gap-2">
            <Star size={14} className="text-accent-gold" />
            <span className="section-title text-sm">Grading Rubric</span>
          </div>
          <textarea
            value={rubric}
            onChange={(e) => setRubric(e.target.value)}
            placeholder="Define your grading criteria..."
            className="w-full h-36 resize-none rounded-xl border border-white/10 bg-white/5 p-4 
                       text-sm text-white/70 placeholder-white/20 outline-none 
                       transition-all focus:border-accent-gold/40 leading-relaxed"
          />
          <p className="mt-2 text-xs text-white/25">
            Format: "Criterion Name (X pts): description" — one per line
          </p>
        </div>

        {/* Grade button */}
        <div className="flex items-center gap-4">
          <button
            onClick={handleGrade}
            disabled={isGrading || !plainText || !apiKey}
            className="btn-primary flex items-center gap-2 disabled:opacity-40 px-6 py-3"
          >
            {isGrading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Grading...
              </>
            ) : (
              <>
                <Star size={16} />
                Grade with AI
              </>
            )}
          </button>

          {gradeResult && (
            <button
              onClick={() => setGradeResult(null)}
              className="btn-ghost flex items-center gap-2"
            >
              <RotateCcw size={14} />
              Re-grade
            </button>
          )}

          {error && (
            <p className="text-sm text-red-400 flex items-center gap-2">
              <AlertCircle size={14} />
              {error}
            </p>
          )}
        </div>

        {/* Grade Results */}
        <AnimatePresence>
          {gradeResult && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-4"
            >
              {/* Overall score */}
              <div className="card p-6 flex items-center gap-8">
                <div className="relative flex-shrink-0">
                  <svg width="100" height="100" className="transform">
                    <circle
                      cx="50" cy="50" r="45"
                      fill="none"
                      stroke="rgba(255,255,255,0.06)"
                      strokeWidth="8"
                    />
                    <circle
                      cx="50" cy="50" r="45"
                      fill="none"
                      stroke={
                        gradeResult.overallScore >= 85 ? '#ffffff' :
                        gradeResult.overallScore >= 70 ? '#cfcfcf' :
                        gradeResult.overallScore >= 55 ? '#9a9a9a' : '#6e6e6e'
                      }
                      strokeWidth="8"
                      strokeLinecap="round"
                      strokeDasharray="283"
                      strokeDashoffset={scoreRingOffset(gradeResult.overallScore)}
                      className="score-ring"
                      style={{ '--target-offset': scoreRingOffset(gradeResult.overallScore) } as any}
                      transform="rotate(-90 50 50)"
                    />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="font-caveat text-3xl font-bold text-white">{gradeResult.overallScore}</span>
                    <span className="text-xs text-white/30">/ 100</span>
                  </div>
                </div>

                <div className="flex-1 space-y-3">
                  <p className="font-writing text-sm text-white/70 leading-relaxed italic">
                    "{gradeResult.summary}"
                  </p>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl bg-green-500/10 border border-green-500/20 p-3">
                      <p className="mb-1 text-xs text-green-400/70 font-caveat">Strengths</p>
                      <ul className="space-y-1">
                        {gradeResult.strengths.map((s, i) => (
                          <li key={i} className="text-xs text-white/60 flex gap-1.5">
                            <CheckCircle size={10} className="text-green-400 mt-0.5 flex-shrink-0" />
                            {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="rounded-xl bg-accent-gold/5 border border-accent-gold/15 p-3">
                      <p className="mb-1 text-xs text-accent-gold/70 font-caveat">To Improve</p>
                      <ul className="space-y-1">
                        {gradeResult.improvements.map((s, i) => (
                          <li key={i} className="text-xs text-white/60 flex gap-1.5">
                            <TrendingUp size={10} className="text-accent-gold mt-0.5 flex-shrink-0" />
                            {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              </div>

              {/* Criterion breakdown */}
              <div className="card p-4 space-y-2">
                <p className="font-caveat text-lg text-white/70 mb-3">Criterion Breakdown</p>
                {gradeResult.rubricScores.map((item, i) => {
                  const pct = (item.score / item.maxScore) * 100
                  return (
                    <div key={i} className="rounded-xl border border-white/8 bg-white/3 overflow-hidden">
                      <button
                        onClick={() => setExpandedCriterion(expandedCriterion === i ? null : i)}
                        className="w-full flex items-center gap-4 p-3 text-left hover:bg-white/3 transition-colors"
                      >
                        <div className="flex-1">
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-sm text-white/70 font-medium">{item.criterion}</span>
                            <span className={`font-caveat text-lg font-bold ${scoreColor(item.score, item.maxScore)}`}>
                              {item.score}/{item.maxScore}
                            </span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                            <motion.div
                              initial={{ width: 0 }}
                              animate={{ width: `${pct}%` }}
                              transition={{ duration: 0.8, delay: i * 0.1 }}
                              className="h-full rounded-full"
                              style={{
                                background: pct >= 85 ? '#ffffff' : pct >= 70 ? '#cfcfcf' : pct >= 55 ? '#9a9a9a' : '#6e6e6e'
                              }}
                            />
                          </div>
                        </div>
                        {expandedCriterion === i ? <ChevronUp size={14} className="text-white/30" /> : <ChevronDown size={14} className="text-white/30" />}
                      </button>

                      <AnimatePresence>
                        {expandedCriterion === i && (
                          <motion.div
                            initial={{ height: 0 }}
                            animate={{ height: 'auto' }}
                            exit={{ height: 0 }}
                            className="overflow-hidden"
                          >
                            <div className="border-t border-white/8 px-4 py-3">
                              <p className="text-sm text-white/55 leading-relaxed font-writing">{item.feedback}</p>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )
                })}
              </div>

              {/* Revise CTA */}
              <div className="flex justify-center">
                <button
                  onClick={() => setActiveTab('write')}
                  className="btn-primary flex items-center gap-2 px-8 py-3"
                >
                  <PenTool size={16} />
                  Revise with AI Assistance
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {!gradeResult && !isGrading && (
          <div className="text-center py-8">
            <p className="font-caveat text-xl text-white/20">
              {plainText ? 'Ready to evaluate your writing' : 'Write something first, then come back to grade it'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

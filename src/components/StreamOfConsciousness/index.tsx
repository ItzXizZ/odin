import { useState, useRef, useEffect, useCallback } from 'react'
import { Mic, MicOff, Type, HelpCircle, Trash2, PenTool, Loader2, Plus } from 'lucide-react'
import { nanoid } from 'nanoid'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore, useHasApiKey } from '../../store/useStore'
import { streamChat, syncChat } from '../../lib/claude'
import { sanitizeAiProse } from '../../lib/aiText'

type Mode = 'audio' | 'text'

export default function StreamOfConsciousness() {
  const { apiKey, sessions, currentTranscript, addSession, updateCurrentTranscript, setActiveTab } = useStore()
  const hasApiKey = useHasApiKey()

  const [mode, setMode] = useState<Mode>('audio')
  const [isRecording, setIsRecording] = useState(false)
  const [textInput, setTextInput] = useState('')
  const [questions, setQuestions] = useState<string[]>([])
  const [liveTranscript, setLiveTranscript] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [questionBuffer, setQuestionBuffer] = useState('')

  const recognitionRef = useRef<any>(null)
  const questionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const accumulatedRef = useRef('')

  const generateQuestions = useCallback(
    async (text: string) => {
      if (!text.trim() || !hasApiKey) return
      setIsGenerating(true)
      setQuestionBuffer('')

      try {
        let buf = ''
        await streamChat(
          [
            {
              role: 'user',
              content: `Based on this stream of consciousness, generate 3 probing questions to deepen the thinking. Be Socratic and thought-provoking.\n\n"${text}"`,
            },
          ],
          'You are a Socratic writing coach. Generate short, incisive questions that push deeper thinking. Format as a numbered list.',
          apiKey,
          (chunk) => {
            buf += chunk
            setQuestionBuffer(buf)
          },
          () => {
            const qs = sanitizeAiProse(buf)
              .split('\n')
              .filter((l) => /^\d+\./.test(l.trim()))
              .map((l) => sanitizeAiProse(l.replace(/^\d+\.\s*/, '').trim()))
              .filter(Boolean)
            if (qs.length > 0) setQuestions((prev) => [...qs, ...prev].slice(0, 15))
            setQuestionBuffer('')
            setIsGenerating(false)
          },
          () => {
            setQuestionBuffer('')
            setIsGenerating(false)
          }
        )
      } catch {
        setIsGenerating(false)
      }
    },
    [apiKey, hasApiKey]
  )

  const scheduleQuestionGeneration = useCallback(
    (text: string) => {
      if (questionTimerRef.current) clearTimeout(questionTimerRef.current)
      questionTimerRef.current = setTimeout(() => generateQuestions(text), 4000)
    },
    [generateQuestions]
  )

  const startRecording = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) {
      alert('Speech recognition not supported. Use Chrome or Edge.')
      return
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'
    recognitionRef.current = recognition

    recognition.onresult = (event: any) => {
      let interim = ''
      let final = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript
        if (event.results[i].isFinal) final += transcript
        else interim += transcript
      }
      if (final) {
        accumulatedRef.current += ' ' + final
        setLiveTranscript(accumulatedRef.current.trim())
        scheduleQuestionGeneration(accumulatedRef.current)
      }
    }

    recognition.onerror = () => setIsRecording(false)
    recognition.onend = () => setIsRecording(false)

    recognition.start()
    setIsRecording(true)
    accumulatedRef.current = ''
    setLiveTranscript('')
  }

  const stopRecording = () => {
    recognitionRef.current?.stop()
    setIsRecording(false)
    if (accumulatedRef.current.trim()) {
      updateCurrentTranscript(accumulatedRef.current.trim())
    }
  }

  const handleTextSubmit = () => {
    if (!textInput.trim()) return
    setLiveTranscript(textInput)
    updateCurrentTranscript(textInput)
    generateQuestions(textInput)
  }

  const saveSession = () => {
    const text = liveTranscript || textInput
    if (!text.trim()) return
    addSession({
      id: nanoid(),
      transcript: text,
      questions: [...questions],
      createdAt: Date.now(),
    })
    setLiveTranscript('')
    setTextInput('')
    setQuestions([])
    accumulatedRef.current = ''
  }

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop()
      if (questionTimerRef.current) clearTimeout(questionTimerRef.current)
    }
  }, [])

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="font-display text-3xl font-bold text-white tracking-tight">The Journal</h1>
            <p className="mt-1 text-sm text-white/40">Unfiltered thought — Odin listens and probes deeper</p>
          </div>
          <button onClick={() => setActiveTab('write')} className="btn-primary flex items-center gap-2">
            <PenTool size={14} />
            Write
          </button>
        </div>

        <div className="grid grid-cols-3 gap-4 min-w-0">
          {/* Main recording/text area */}
          <div className="col-span-2 card p-5 flex flex-col gap-4 min-w-0">
            {/* Mode toggle */}
            <div className="flex gap-2">
              <button
                onClick={() => setMode('audio')}
                className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-caveat text-lg transition-all ${
                  mode === 'audio' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/60'
                }`}
              >
                <Mic size={14} />
                Audio
              </button>
              <button
                onClick={() => setMode('text')}
                className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-caveat text-lg transition-all ${
                  mode === 'text' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/60'
                }`}
              >
                <Type size={14} />
                Text
              </button>
            </div>

            {mode === 'audio' ? (
              <div className="flex flex-col items-center gap-6 py-6">
                {/* Recording button */}
                <button
                  onClick={isRecording ? stopRecording : startRecording}
                  className={`
                    relative w-24 h-24 rounded-2xl flex items-center justify-center transition-all duration-300
                    ${isRecording
                      ? 'bg-red-500/20 border-2 border-red-400/60 hover:bg-red-500/30'
                      : 'bg-white/5 border-2 border-white/20 hover:bg-white/10 hover:border-white/30'
                    }
                  `}
                >
                  {isRecording && (
                    <div className="absolute inset-0 rounded-2xl border-2 border-red-400/40 animate-ping" />
                  )}
                  {isRecording ? (
                    <MicOff size={32} className="text-red-400" />
                  ) : (
                    <Mic size={32} className="text-white/60" />
                  )}
                </button>

                {/* Waveform indicator */}
                {isRecording && (
                  <div className="flex items-center gap-1 h-8">
                    {[...Array(7)].map((_, i) => (
                      <div
                        key={i}
                        className="wave-bar w-1.5 bg-accent-gold/60 rounded-full"
                        style={{ animationDelay: `${i * 0.1}s`, height: '100%' }}
                      />
                    ))}
                  </div>
                )}

                <p className="label text-center">
                  {isRecording ? 'Recording... press to stop' : 'Press to record, press again to stop'}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <textarea
                  value={textInput}
                  onChange={(e) => {
                    setTextInput(e.target.value)
                    scheduleQuestionGeneration(e.target.value)
                  }}
                  placeholder="Write without filter. What demands your attention?"
                  className="h-48 w-full resize-none rounded-xl border border-white/10 bg-white/5 p-4 
                             font-writing text-base text-white/80 placeholder-white/20 outline-none 
                             transition-all focus:border-accent-gold/40"
                />
                <button onClick={handleTextSubmit} className="btn-ghost self-end">
                  Generate Questions
                </button>
              </div>
            )}

            {/* Live transcript */}
            {liveTranscript && (
              <div className="rounded-xl border border-white/10 bg-white/3 p-4">
                <p className="mb-1 text-xs text-white/30 font-caveat text-sm">Live transcript</p>
                <p className="font-writing text-sm text-white/70 leading-relaxed">{liveTranscript}</p>
              </div>
            )}

            {/* Save session */}
            {(liveTranscript || textInput) && (
              <button onClick={saveSession} className="btn-primary self-start flex items-center gap-2">
                <Plus size={14} />
                Save Session
              </button>
            )}

            {/* Mode switch button */}
            <button className="btn-ghost w-full mt-auto text-sm font-caveat text-base">
              Switch Between Text and Audio Mode
            </button>
          </div>

          {/* Questions panel */}
          <div className="card p-4 flex flex-col gap-3 min-w-0">
            <div className="flex items-center gap-2">
              <HelpCircle size={14} className="text-accent-gold/70" />
              <span className="section-title text-sm">Live Questions</span>
              {isGenerating && <Loader2 size={12} className="text-white/30 animate-spin ml-auto" />}
            </div>

            <p className="text-xs text-white/30 leading-relaxed">
              Claude generates questions as you speak to deepen your thinking
            </p>

            <div className="flex-1 space-y-2 overflow-y-auto min-w-0">
              {questionBuffer && (
                <div className="rounded-xl border border-accent-gold/20 bg-accent-gold/5 p-3">
                  <p className="text-xs text-accent-gold/70 whitespace-pre-wrap">{questionBuffer}</p>
                </div>
              )}
              <AnimatePresence>
                {questions.map((q, i) => (
                  <motion.div
                    key={`${q}-${i}`}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-xl border border-white/10 bg-white/3 p-3"
                  >
                    <p className="text-sm text-white/70 leading-relaxed">{q}</p>
                  </motion.div>
                ))}
              </AnimatePresence>

              {questions.length === 0 && !isGenerating && (
                <p className="text-xs text-white/20 text-center mt-8 label">
                  Questions appear as you speak...
                </p>
              )}
            </div>

            {/* Live transcription box */}
            <div className="rounded-xl border border-white/10 bg-white/3 p-3 min-h-[80px]">
              <p className="mb-1 text-xs text-white/30 font-caveat text-sm">Live transcription</p>
              <p className="text-xs text-white/50 leading-relaxed">
                {liveTranscript || <span className="text-white/20 italic">Transcript appears here...</span>}
              </p>
            </div>

            <button onClick={() => setActiveTab('write')} className="btn-ghost w-full text-sm font-caveat text-base">
              Write
            </button>
          </div>
        </div>

        {/* Past sessions */}
        {sessions.length > 0 && (
          <div className="mt-6">
            <h3 className="font-display text-xl text-white/60 mb-3 tracking-tight">Previous Sessions</h3>
            <div className="space-y-2">
              {sessions.slice(0, 5).map((sess) => (
                <div key={sess.id} className="card-hover p-4 flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white/70 leading-relaxed line-clamp-2">{sess.transcript}</p>
                    {sess.questions.length > 0 && (
                      <p className="mt-1 text-xs text-white/30">{sess.questions.length} questions generated</p>
                    )}
                  </div>
                  <span className="text-xs text-white/20 whitespace-nowrap">
                    {new Date(sess.createdAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

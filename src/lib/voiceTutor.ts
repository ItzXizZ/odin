/**
 * Voice tutor plumbing:
 *   • STT via the Web Speech API (SpeechRecognition) — accepts live mic audio.
 *   • TTS via ElevenLabs (server-proxied) when configured, else browser speechSynthesis.
 *     Sentences are spoken incrementally as the model streams.
 *
 * The "brain + vision" lives on the server (Claude Sonnet 5); this file handles
 * ears and mouth.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { speakableMathText } from './mathSpeech'

export interface RecognizerHandle {
  start: () => void
  stop: () => void
  abort: () => void
}

interface STTCallbacks {
  onInterim?: (text: string) => void
  onFinal?: (text: string) => void
  onError?: (err: string) => void
  onEnd?: () => void
  onStart?: () => void
}

export function speechRecognitionSupported(): boolean {
  return typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)
}

/** Create a continuous recognizer. Returns null if the browser lacks support. */
export function createRecognizer(cb: STTCallbacks): RecognizerHandle | null {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (!SR) return null
  const rec = new SR()
  rec.continuous = true
  rec.interimResults = true
  rec.lang = 'en-US'

  rec.onresult = (e: any) => {
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]
      const txt = (r[0]?.transcript ?? '').trim()
      if (!txt) continue
      if (r.isFinal) cb.onFinal?.(txt)
      else interim += txt + ' '
    }
    if (interim.trim()) cb.onInterim?.(interim.trim())
  }
  rec.onerror = (e: any) => cb.onError?.(String(e?.error || 'speech error'))
  rec.onend = () => cb.onEnd?.()
  rec.onstart = () => cb.onStart?.()

  return {
    start: () => {
      try {
        rec.start()
      } catch {
        /* start() throws if already started — ignore */
      }
    },
    stop: () => {
      try {
        rec.stop()
      } catch {
        /* ignore */
      }
    },
    abort: () => {
      try {
        rec.abort()
      } catch {
        /* ignore */
      }
    },
  }
}

// ── Text-to-speech ──────────────────────────────────────────────────────────

let preferredVoice: SpeechSynthesisVoice | null = null
let ttsReady = false
let useElevenLabs = false
let activeAudio: HTMLAudioElement | null = null

/**
 * Strictly-ordered speech queue. Audio synthesis is prefetched in parallel the
 * moment a sentence is enqueued, but playback ALWAYS follows enqueue order —
 * a later sentence whose audio arrives first must wait its turn. (The old
 * implementation queued on fetch completion, which made the voice read
 * sentences out of order whenever synthesis latencies varied.)
 */
interface SpeakItem {
  text: string
  urlPromise: Promise<string | null>
  onEnd?: () => void
}
const speakQueue: SpeakItem[] = []
let speakPumping = false
let speakGeneration = 0

function pickVoice() {
  if (typeof speechSynthesis === 'undefined') return
  const voices = speechSynthesis.getVoices()
  if (!voices.length) return
  preferredVoice =
    voices.find((v) => /en-GB/i.test(v.lang) && /(George|Daniel|Ryan|Oliver|Thomas)/i.test(v.name)) ||
    voices.find((v) => /en-US/i.test(v.lang) && /(Google US English|Natural|Adam|Guy|Davis)/i.test(v.name)) ||
    voices.find((v) => /en-GB/i.test(v.lang)) ||
    voices.find((v) => /en-US/i.test(v.lang)) ||
    voices.find((v) => /^en/i.test(v.lang)) ||
    voices[0] ||
    null
}

export function initVoices() {
  if (typeof speechSynthesis === 'undefined') return
  pickVoice()
  speechSynthesis.onvoiceschanged = pickVoice
}

/** Probe server for ElevenLabs; fall back to browser voices. */
export async function probeTTS(): Promise<boolean> {
  try {
    const res = await fetch('/api/tts/status')
    if (res.ok) {
      const data = await res.json()
      if (data.available && data.provider === 'elevenlabs') {
        useElevenLabs = true
        ttsReady = true
        return true
      }
    }
  } catch {
    /* dev without server — fall through */
  }

  useElevenLabs = false
  if (typeof speechSynthesis !== 'undefined') {
    initVoices()
    ttsReady = true
    return true
  }

  ttsReady = false
  return false
}

export function ttsSupported(): boolean {
  return ttsReady
}

function stopAudioQueue() {
  speakGeneration++
  if (activeAudio) {
    activeAudio.pause()
    if (activeAudio.src.startsWith('blob:')) URL.revokeObjectURL(activeAudio.src)
    activeAudio.src = ''
    activeAudio = null
  }
  speakQueue.length = 0
  speakPumping = false
}

export function cancelSpeech() {
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
  stopAudioQueue()
}

/**
 * Turn model text into clean spoken words: LaTeX spans become real spoken
 * English ("x squared plus 3 d"), markdown and stray symbols are scrubbed.
 */
function sanitizeForSpeech(text: string): string {
  return speakableMathText(text)
}

function speakSentenceBrowser(text: string, onEnd?: () => void) {
  const clean = sanitizeForSpeech(text)
  if (!clean) {
    onEnd?.()
    return
  }
  const u = new SpeechSynthesisUtterance(clean)
  if (preferredVoice) u.voice = preferredVoice
  u.rate = 1.02
  u.pitch = 1.0
  if (onEnd) u.onend = onEnd
  speechSynthesis.speak(u)
}

async function fetchElevenLabsAudio(text: string): Promise<string | null> {
  const clean = sanitizeForSpeech(text)
  if (!clean) return null
  try {
    const res = await fetch('/api/tts/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean }),
    })
    if (!res.ok) return null
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

async function pumpSpeakQueue() {
  if (speakPumping) return
  const item = speakQueue.shift()
  if (!item) return
  speakPumping = true
  const gen = speakGeneration

  const next = () => {
    speakPumping = false
    item.onEnd?.()
    if (gen === speakGeneration) void pumpSpeakQueue()
  }

  const url = await item.urlPromise.catch(() => null)
  if (gen !== speakGeneration) return // canceled while synthesizing

  if (!url) {
    // Synthesis failed → browser voice keeps the sentence (and the order).
    speakSentenceBrowser(item.text, next)
    return
  }
  const audio = new Audio(url)
  activeAudio = audio
  const finish = () => {
    if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src)
    if (activeAudio === audio) activeAudio = null
    next()
  }
  audio.onended = finish
  audio.onerror = finish
  void audio.play().catch(finish)
}

function speakSentence(text: string, onEnd?: () => void) {
  if (useElevenLabs) {
    // Prefetch immediately, but play strictly in enqueue order.
    speakQueue.push({ text, urlPromise: fetchElevenLabsAudio(text), onEnd })
    void pumpSpeakQueue()
  } else {
    speakSentenceBrowser(text, onEnd)
  }
}

/**
 * Speaks streamed text incrementally: feed it raw chunks and it flushes complete
 * sentences to the synth as they arrive, so speech tracks the stream in near
 * real time. Call `flush()` at the end to speak any trailing partial sentence.
 */
export class IncrementalSpeaker {
  private buffer = ''
  private onSpeakingChange?: (speaking: boolean) => void
  private pending = 0

  constructor(onSpeakingChange?: (speaking: boolean) => void) {
    this.onSpeakingChange = onSpeakingChange
  }

  private enqueue(sentence: string) {
    const s = sentence.trim()
    if (!s) return
    this.pending++
    this.onSpeakingChange?.(true)
    speakSentence(s, () => {
      this.pending = Math.max(0, this.pending - 1)
      if (this.pending === 0) this.onSpeakingChange?.(false)
    })
  }

  push(chunk: string) {
    this.buffer += chunk
    const re = /[^.!?…\n]*[.!?…\n]+/g
    let match: RegExpExecArray | null
    let lastIndex = 0
    while ((match = re.exec(this.buffer)) !== null) {
      this.enqueue(match[0])
      lastIndex = re.lastIndex
    }
    if (lastIndex > 0) this.buffer = this.buffer.slice(lastIndex)
  }

  /** Speak one already-complete sentence (bypasses the chunk buffer). */
  pushSentence(sentence: string) {
    this.enqueue(sentence)
  }

  flush() {
    if (this.buffer.trim()) this.enqueue(this.buffer)
    this.buffer = ''
  }

  cancel() {
    this.buffer = ''
    this.pending = 0
    cancelSpeech()
    this.onSpeakingChange?.(false)
  }
}

import { authHeader } from './supabase'

export interface HintTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface HintRequest {
  /** PNG data URL of the highlighted region the student wants help with. */
  regionImage?: string
  /** PNG data URL of the whole board, for extra context. */
  boardImage?: string
  /**
   * Vector-crisp render of ALL the work with a labeled 0–1000 coordinate grid
   * overlaid — the model picks its highlight boxes visually on this image.
   */
  gridImage?: string
  /** Pasted problem screenshots (original resolution) so the problem is always in context. */
  problemImages?: string[]
  /**
   * Machine-recognized transcript of the handwriting (MyScript), one entry per
   * expression, numbered top-to-bottom. Lets the model cite "REF: n" so the
   * client can glow exactly the strokes behind that line.
   */
  recognizedLines?: { n: number; latex: string }[]
  /** Optional typed question. */
  prompt?: string
  /** Prior hint exchanges (text only) to keep coaching coherent. */
  history?: HintTurn[]
  /** Rung on the fading ladder (1 = orienting … 4 = procedural). */
  hintLevel?: number
  /**
   * hint = Socratic nudge, solve = full solution, voice = spoken (no LaTeX),
   * clarify = short follow-up answer, generalize = the playbook for this
   * problem TYPE ("generally, for problems like this…").
   */
  mode?: 'hint' | 'solve' | 'voice' | 'clarify' | 'generalize'
  apiKey?: string
}

/** Abort if the model stalls for this long. */
const IDLE_TIMEOUT_MS = 60000

/** A real Claude tool call (highlight_board_lines) fired mid-stream. */
export interface HintHighlight {
  lines: number[]
  label?: string
}

/**
 * Stream a math hint from the vision model. Mirrors the /api/chat SSE protocol:
 * lines of `data: {"text":"..."}` then `data: [DONE]`, plus `data:
 * {"highlight":{"lines":[...],"label":"..."}}` events whenever the model
 * calls the highlight_board_lines tool.
 */
export async function streamMathHint(
  req: HintRequest,
  onChunk: (text: string) => void,
  onDone?: () => void,
  onError?: (err: string) => void,
  onHighlight?: (highlight: HintHighlight) => void
): Promise<void> {
  const controller = new AbortController()
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS)
  }

  try {
    resetIdle()
    const res = await fetch('/api/math/hint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(req),
      signal: controller.signal,
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }))
      onError?.(err.error || 'Request failed')
      return
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      resetIdle()

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (payload === '[DONE]') {
          onDone?.()
          return
        }
        try {
          const parsed = JSON.parse(payload)
          if (parsed.error) {
            onError?.(parsed.error)
            return
          }
          if (parsed.text) onChunk(parsed.text)
          if (parsed.highlight?.lines?.length) onHighlight?.(parsed.highlight)
        } catch {
          // ignore partial-chunk parse errors
        }
      }
    }

    onDone?.()
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError'
    onError?.(
      aborted
        ? 'The tutor timed out. Please try again.'
        : err instanceof Error
        ? err.message
        : 'Request failed'
    )
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }
}

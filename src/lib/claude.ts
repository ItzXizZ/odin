export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Abort the stream if no data arrives for this long, so a stalled response can't spin forever. */
const STREAM_IDLE_TIMEOUT_MS = 60000

export async function streamChat(
  messages: ChatMessage[],
  system: string,
  apiKey: string,
  onChunk: (text: string) => void,
  onDone?: () => void,
  onError?: (err: string) => void
): Promise<void> {
  const controller = new AbortController()
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS)
  }

  try {
    resetIdle()
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, system, apiKey }),
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
        } catch {
          // ignore parse errors on partial chunks
        }
      }
    }

    onDone?.()
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError'
    onError?.(
      aborted
        ? 'Response timed out. Please try again.'
        : err instanceof Error
        ? err.message
        : 'Request failed'
    )
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }
}

export async function syncChat(
  messages: ChatMessage[],
  system: string,
  apiKey: string,
  maxTokens = 2048
): Promise<string> {
  let res: Response
  try {
    res = await fetch('/api/chat/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, system, apiKey, maxTokens }),
      signal: AbortSignal.timeout(90000),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error('Request timed out. Please try again.')
    }
    throw new Error(err instanceof Error ? err.message : 'Request failed')
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || 'Request failed')
  }

  const data = await res.json()
  return data.content
}

export async function uploadPDF(file: File): Promise<{ text: string; pages: number }> {
  const form = new FormData()
  form.append('file', file)

  const res = await fetch('/api/upload-pdf', {
    method: 'POST',
    body: form,
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Upload failed' }))
    throw new Error(err.error || 'Upload failed')
  }

  return res.json()
}

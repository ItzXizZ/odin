import type { VisualAsset } from '../store/useStore'

export interface VisualMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface GenerateVisualOptions {
  query: string
  apiKey: string
  context?: string
  parentPrompt?: string
  parentResponse?: string
  excerpt?: string
  messageChain?: VisualMessage[]
}

export async function generateVisual(options: GenerateVisualOptions): Promise<VisualAsset> {
  const res = await fetch('/api/visual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Visual generation failed' }))
    throw new Error(err.error || 'Visual generation failed')
  }

  return res.json()
}

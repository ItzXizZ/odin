import type { VisualAsset } from '../store/useStore'

export interface VisualMessage {
  role: 'user' | 'assistant'
  content: string
}

export type VisualMethod = 'search' | 'generate'

export interface GenerateVisualOptions {
  query: string
  apiKey: string
  context?: string
  parentPrompt?: string
  parentResponse?: string
  excerpt?: string
  messageChain?: VisualMessage[]
  /** Force a specific method instead of letting the server decide. */
  method?: VisualMethod
}

/** Returned when the request is ambiguous and the user should pick a method. */
export interface VisualChoiceNeeded {
  needsChoice: true
  suggestion?: VisualMethod
}

export type GenerateVisualResult = VisualAsset | VisualChoiceNeeded

export function isVisualChoice(result: GenerateVisualResult): result is VisualChoiceNeeded {
  return (result as VisualChoiceNeeded).needsChoice === true
}

/** Image generation can legitimately take a while; cap it so the UI never spins forever. */
const VISUAL_TIMEOUT_MS = 240000

export async function generateVisual(options: GenerateVisualOptions): Promise<GenerateVisualResult> {
  let res: Response
  try {
    res = await fetch('/api/visual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(VISUAL_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error('Image generation timed out. Please try again.')
    }
    throw new Error(err instanceof Error ? err.message : 'Visual generation failed')
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Visual generation failed' }))
    throw new Error(err.error || 'Visual generation failed')
  }

  return res.json()
}

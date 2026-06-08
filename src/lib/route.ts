import type { VisualMessage } from './visual'

export type ExplorationAction =
  | { action: 'text' }
  | { action: 'generate'; query: string }
  | { action: 'search'; query: string }
  | { action: 'choose'; query: string }

export interface RouteOptions {
  prompt: string
  apiKey: string
  context?: string
  excerpt?: string
  messageChain?: VisualMessage[]
}

/**
 * Ask the model (via tool-calling on the server) how to handle a request:
 * write text, generate a custom image, find a real one, or ask the user.
 * Always resolves — on any failure it falls back to a text answer.
 */
export async function routeExploration(options: RouteOptions): Promise<ExplorationAction> {
  try {
    const res = await fetch('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) return { action: 'text' }

    const data = await res.json()
    if (data.action === 'generate' || data.action === 'search' || data.action === 'choose') {
      const query = typeof data.query === 'string' && data.query.trim() ? data.query.trim() : options.prompt
      return { action: data.action, query }
    }
    return { action: 'text' }
  } catch {
    return { action: 'text' }
  }
}

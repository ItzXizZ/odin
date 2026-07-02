import type { SourceRef } from './sources'
import { authHeader } from './supabase'

export interface ResearchResult {
  sources: SourceRef[]
  context: string
}

/** Run web research for a user query via the backend search API. */
export async function researchQuery(query: string): Promise<ResearchResult> {
  let res: Response
  try {
    res = await fetch('/api/research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30000),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error('Research timed out')
    }
    throw new Error(err instanceof Error ? err.message : 'Research failed')
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Research failed' }))
    throw new Error(err.error || 'Research failed')
  }

  return res.json()
}

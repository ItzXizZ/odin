import type { SourceRef } from './sources'

export interface ResearchResult {
  sources: SourceRef[]
  context: string
}

/** Run web research for a user query via the backend search API. */
export async function researchQuery(query: string): Promise<ResearchResult> {
  const res = await fetch('/api/research', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Research failed' }))
    throw new Error(err.error || 'Research failed')
  }

  return res.json()
}

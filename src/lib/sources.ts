export interface SourceRef {
  id: string
  title: string
  url: string
}

/** Deduplicate sources by normalized URL id. */
export function mergeSources(...lists: SourceRef[][]): SourceRef[] {
  const seen = new Set<string>()
  const out: SourceRef[] = []
  for (const list of lists) {
    for (const ref of list) {
      if (seen.has(ref.id)) continue
      seen.add(ref.id)
      out.push(ref)
    }
  }
  return out
}

export interface AggregatedSource extends SourceRef {
  referenceCount: number
  nodeIds: string[]
  relevanceScore: number
}

const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi
const BARE_URL_RE = /https?:\/\/[^\s<>\])"'.,;]+/gi

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url.trim())
    parsed.hash = ''
    let path = parsed.pathname.replace(/\/$/, '') || '/'
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${path}${parsed.search}`
  } catch {
    return url.trim().toLowerCase()
  }
}

function titleFromUrl(url: string): string {
  try {
    const { hostname, pathname } = new URL(url)
    const host = hostname.replace(/^www\./, '')
    const segment = pathname.split('/').filter(Boolean).pop()
    return segment ? `${host} — ${decodeURIComponent(segment).slice(0, 48)}` : host
  } catch {
    return url.slice(0, 60)
  }
}

function makeId(url: string): string {
  return normalizeUrl(url)
}

/** Extract cited sources from assistant markdown (links and bare URLs). */
export function extractSourcesFromText(text: string): SourceRef[] {
  if (!text.trim()) return []

  const seen = new Set<string>()
  const sources: SourceRef[] = []

  const add = (title: string, url: string) => {
    const clean = url.replace(/[.,;:!?)]+$/, '')
    const id = makeId(clean)
    if (seen.has(id)) return
    seen.add(id)
    sources.push({
      id,
      title: title.trim() || titleFromUrl(clean),
      url: clean,
    })
  }

  let match: RegExpExecArray | null
  MD_LINK_RE.lastIndex = 0
  while ((match = MD_LINK_RE.exec(text)) !== null) {
    add(match[1], match[2])
  }

  BARE_URL_RE.lastIndex = 0
  while ((match = BARE_URL_RE.exec(text)) !== null) {
    const url = match[0]
    if (!sources.some((s) => s.url === url.replace(/[.,;:!?)]+$/, ''))) {
      add(titleFromUrl(url), url)
    }
  }

  return sources
}

export interface SourceAggregationInput {
  nodeId: string
  response: string
  sources?: SourceRef[]
  connectionCount?: number
  order: number
}

/**
 * Aggregate sources across all exploration messages, ranked by frequency
 * and importance (connection count + recency).
 */
export function aggregateSources(inputs: SourceAggregationInput[], limit = 12): AggregatedSource[] {
  const map = new Map<string, AggregatedSource>()

  for (const { nodeId, response, sources = [], connectionCount = 0, order } of inputs) {
    const refs = mergeSources(sources, extractSourcesFromText(response))
    const recencyWeight = 1 + order * 0.05

    for (const ref of refs) {
      const existing = map.get(ref.id)
      if (existing) {
        existing.referenceCount += 1
        if (!existing.nodeIds.includes(nodeId)) existing.nodeIds.push(nodeId)
        existing.relevanceScore += 10 * recencyWeight + connectionCount
      } else {
        map.set(ref.id, {
          ...ref,
          referenceCount: 1,
          nodeIds: [nodeId],
          relevanceScore: 10 * recencyWeight + connectionCount,
        })
      }
    }
  }

  return [...map.values()]
    .sort((a, b) => b.relevanceScore - a.relevanceScore || b.referenceCount - a.referenceCount)
    .slice(0, limit)
}

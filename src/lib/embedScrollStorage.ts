import type { Node } from 'reactflow'
import type { ExplorationNodeData } from '../store/useStore'
import { getWorkspaceStorageUserId } from './workspaceStorage'

/** Per-adventure map of embed node id → scrollTop (localStorage mirror). */
export type EmbedScrollMap = Record<string, number>

function storageKey(adventureId: string): string {
  const userId = getWorkspaceStorageUserId()
  return userId ? `odin-embed-scroll:${userId}:${adventureId}` : `odin-embed-scroll:${adventureId}`
}

function readRaw(key: string): EmbedScrollMap {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const map: EmbedScrollMap = {}
    for (const [id, top] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof top === 'number' && Number.isFinite(top) && top >= 0) map[id] = top
    }
    return map
  } catch {
    return {}
  }
}

function writeRaw(key: string, map: EmbedScrollMap) {
  try {
    localStorage.setItem(key, JSON.stringify(map))
  } catch {
    /* quota / private mode */
  }
}

export function readEmbedScrollMap(adventureId: string): EmbedScrollMap {
  if (!adventureId) return {}
  return readRaw(storageKey(adventureId))
}

function urlScrollKey(embedUrl: string): string {
  return `url:${embedUrl}`
}

export function writeEmbedScrollEntry(
  adventureId: string,
  nodeId: string,
  scrollTop: number,
  embedUrl?: string
) {
  if (!adventureId || !nodeId || scrollTop < 0) return
  const key = storageKey(adventureId)
  const map = readRaw(key)
  if (map[nodeId] === scrollTop && (!embedUrl || map[urlScrollKey(embedUrl)] === scrollTop)) return
  map[nodeId] = scrollTop
  if (embedUrl) map[urlScrollKey(embedUrl)] = scrollTop
  writeRaw(key, map)
}

export function resolveEmbedScrollTop(
  adventureId: string,
  nodeId: string,
  embedUrl?: string,
  fromNode?: number
): number | undefined {
  const stored = readEmbedScrollMap(adventureId)
  const candidates = [fromNode ?? 0, stored[nodeId] ?? 0]
  if (embedUrl) candidates.push(stored[urlScrollKey(embedUrl)] ?? 0)
  const top = Math.max(...candidates)
  return top > 0 ? top : undefined
}

export function writeEmbedScrollMap(adventureId: string, map: EmbedScrollMap) {
  if (!adventureId) return
  writeRaw(storageKey(adventureId), map)
}

export function collectEmbedScrollMap(nodes: Node<ExplorationNodeData>[]): EmbedScrollMap {
  const map: EmbedScrollMap = {}
  for (const n of nodes) {
    if (n.data.nodeKind !== 'embed') continue
    const top = n.data.embedScrollTop
    if (top != null && top >= 0) {
      map[n.id] = top
      if (n.data.embedUrl) map[urlScrollKey(n.data.embedUrl)] = top
    }
  }
  return map
}

/** Merge localStorage scroll mirror into adventure nodes (local wins when higher). */
export function mergeEmbedScrollIntoNodes(
  nodes: Node<ExplorationNodeData>[],
  adventureId: string
): Node<ExplorationNodeData>[] {
  return nodes.map((n) => {
    if (n.data.nodeKind !== 'embed') return n
    const scrollTop = resolveEmbedScrollTop(adventureId, n.id, n.data.embedUrl, n.data.embedScrollTop)
    if (scrollTop == null || scrollTop <= 0) return n
    if (n.data.embedScrollTop === scrollTop) return n
    return { ...n, data: { ...n.data, embedScrollTop: scrollTop } }
  })
}

/** Sync every embed scroll from live nodes into the localStorage mirror. */
export function syncEmbedScrollFromNodes(
  adventureId: string,
  nodes: Node<ExplorationNodeData>[]
) {
  const map = collectEmbedScrollMap(nodes)
  if (Object.keys(map).length === 0) return
  const existing = readEmbedScrollMap(adventureId)
  const merged = { ...existing, ...map }
  writeEmbedScrollMap(adventureId, merged)
}

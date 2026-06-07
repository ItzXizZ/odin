import type { Node, Edge } from 'reactflow'

const GAP_X = 110
const GAP_Y = 36
const ROOT_GAP = 80
const DEFAULT_W = 420
const DEFAULT_H = 200

/**
 * Tidy left-to-right tree layout. Each node flows to the right of its parent;
 * siblings stack vertically (centered against the parent) without overlapping.
 * Returns a map of nodeId -> position.
 */
export function layoutTree(nodes: Node[], edges: Edge[]): Record<string, { x: number; y: number }> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const sizeOf = (id: string) => {
    const n = byId.get(id) as any
    return { w: n?.width || DEFAULT_W, h: n?.height || DEFAULT_H }
  }

  // parent -> ordered children (first edge wins as the structural parent)
  const children: Record<string, string[]> = {}
  const parentOf: Record<string, string> = {}
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue
    if (parentOf[e.target]) continue // keep a single parent → a clean tree
    parentOf[e.target] = e.source
    ;(children[e.source] ||= []).push(e.target)
  }

  const roots = nodes.filter((n) => !parentOf[n.id]).map((n) => n.id)

  // Depth per node (for column x), guarding against cycles
  const depth: Record<string, number> = {}
  const setDepth = (id: string, d: number, seen: Set<string>) => {
    if (seen.has(id)) return
    seen.add(id)
    depth[id] = d
    for (const c of children[id] || []) setDepth(c, d + 1, seen)
  }
  roots.forEach((r) => setDepth(r, 0, new Set()))

  // Column x positions based on the widest node at each depth
  const maxW: Record<number, number> = {}
  nodes.forEach((n) => {
    const d = depth[n.id] ?? 0
    maxW[d] = Math.max(maxW[d] || 0, sizeOf(n.id).w)
  })
  const xAt: Record<number, number> = {}
  let acc = 0
  Object.keys(maxW)
    .map(Number)
    .sort((a, b) => a - b)
    .forEach((d) => {
      xAt[d] = acc
      acc += maxW[d] + GAP_X
    })

  // Subtree heights
  const subH: Record<string, number> = {}
  const calcH = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return sizeOf(id).h
    seen.add(id)
    const kids = children[id] || []
    const { h } = sizeOf(id)
    if (!kids.length) return (subH[id] = h)
    let total = 0
    kids.forEach((k, i) => {
      total += calcH(k, seen)
      if (i < kids.length - 1) total += GAP_Y
    })
    return (subH[id] = Math.max(h, total))
  }

  const pos: Record<string, { x: number; y: number }> = {}
  const centerY: Record<string, number> = {}
  const assign = (id: string, top: number, seen: Set<string>) => {
    if (seen.has(id)) return
    seen.add(id)
    const { h } = sizeOf(id)
    const x = xAt[depth[id] ?? 0] ?? 0
    const kids = children[id] || []
    if (!kids.length) {
      pos[id] = { x, y: top + (subH[id] - h) / 2 }
      centerY[id] = top + subH[id] / 2
      return
    }
    let cy = top
    kids.forEach((k) => {
      assign(k, cy, seen)
      cy += subH[k] + GAP_Y
    })
    const first = centerY[kids[0]]
    const last = centerY[kids[kids.length - 1]]
    const c = (first + last) / 2
    pos[id] = { x, y: c - h / 2 }
    centerY[id] = c
  }

  let rootTop = 0
  roots.forEach((r) => {
    calcH(r, new Set())
    assign(r, rootTop, new Set())
    rootTop += subH[r] + ROOT_GAP
  })

  // Full-message replies stack vertically below their parent (same column)
  const fullChildren: Record<string, string[]> = {}
  for (const e of edges) {
    if ((e as any).data?.branchType !== 'full') continue
    if (!byId.has(e.source) || !byId.has(e.target)) continue
    ;(fullChildren[e.source] ||= []).push(e.target)
  }

  for (const [parentId, kids] of Object.entries(fullChildren)) {
    const parentPos = pos[parentId]
    if (!parentPos) continue
    const { h: ph } = sizeOf(parentId)
    let y = parentPos.y + ph + GAP_Y
    for (const kid of kids) {
      pos[kid] = { x: parentPos.x, y }
      y += sizeOf(kid).h + GAP_Y
    }
  }

  return pos
}

import { Position, type Node } from 'reactflow'

export type EdgeAnchorOpts = {
  /** Pin source anchor on the right edge at this vertical ratio (0–1). */
  sourceRatio?: number
}

// Anchor on a node border at a vertical ratio (used for highlight excerpt branches).
function getRatioAnchor(node: Node, ratio: number, side: Position) {
  const w = node.width ?? 0
  const h = node.height ?? 0
  const nx = node.positionAbsolute?.x ?? node.position.x
  const ny = node.positionAbsolute?.y ?? node.position.y
  const y = ny + Math.max(0.05, Math.min(0.95, ratio)) * h

  switch (side) {
    case Position.Right:
      return { x: nx + w, y }
    case Position.Left:
      return { x: nx, y }
    case Position.Top:
      return { x: nx + w / 2, y: ny }
    default:
      return { x: nx + w / 2, y: ny + h }
  }
}

// Intersection point of the line between two node centers with the border of `node`.
function getNodeIntersection(node: Node, other: Node) {
  const w = (node.width ?? 0) / 2
  const h = (node.height ?? 0) / 2
  const nx = (node.positionAbsolute?.x ?? node.position.x) + w
  const ny = (node.positionAbsolute?.y ?? node.position.y) + h
  const ox = (other.positionAbsolute?.x ?? other.position.x) + (other.width ?? 0) / 2
  const oy = (other.positionAbsolute?.y ?? other.position.y) + (other.height ?? 0) / 2

  if (w === 0 || h === 0) return { x: nx, y: ny }

  const xx1 = (ox - nx) / (2 * w) - (oy - ny) / (2 * h)
  const yy1 = (ox - nx) / (2 * w) + (oy - ny) / (2 * h)
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1)
  const xx3 = a * xx1
  const yy3 = a * yy1
  return {
    x: w * (xx3 + yy3) + nx,
    y: h * (-xx3 + yy3) + ny,
  }
}

function getEdgePosition(node: any, point: { x: number; y: number }): Position {
  const nx = Math.round((node.positionAbsolute?.x ?? node.position.x))
  const ny = Math.round((node.positionAbsolute?.y ?? node.position.y))
  const px = Math.round(point.x)
  const py = Math.round(point.y)

  if (px <= nx + 1) return Position.Left
  if (px >= nx + (node.width ?? 0) - 1) return Position.Right
  if (py <= ny + 1) return Position.Top
  return Position.Bottom
}

export function getEdgeParams(source: Node, target: Node, opts?: EdgeAnchorOpts) {
  const sp =
    opts?.sourceRatio != null
      ? getRatioAnchor(source, opts.sourceRatio, Position.Right)
      : getNodeIntersection(source, target)
  const tp = getNodeIntersection(target, source)
  return {
    sx: sp.x,
    sy: sp.y,
    tx: tp.x,
    ty: tp.y,
    sourcePos: getEdgePosition(source, sp),
    targetPos: getEdgePosition(target, tp),
  }
}

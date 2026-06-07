import { useCallback } from 'react'
import { getBezierPath, useStore, BaseEdge, type EdgeProps } from 'reactflow'
import type { ExplorationNodeData } from '../../store/useStore'
import { getEdgeParams } from './floating'

export default function FloatingEdge({ id, source, target, markerEnd, style, data }: EdgeProps) {
  const sourceNode = useStore(useCallback((s) => s.nodeInternals.get(source), [source]))
  const targetNode = useStore(useCallback((s) => s.nodeInternals.get(target), [target]))

  if (!sourceNode || !targetNode) return null

  const sourceData = sourceNode.data as ExplorationNodeData
  const sourceRatio =
    data?.branchType === 'excerpt'
      ? sourceData.highlights?.find((h) => h.childId === target)?.ratio
      : undefined

  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(
    sourceNode,
    targetNode,
    sourceRatio != null ? { sourceRatio } : undefined
  )

  const [path] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetPosition: targetPos,
    targetX: tx,
    targetY: ty,
  })

  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
}

import type { Node } from 'reactflow'
import type { ExplorationNodeData } from '../../store/useStore'

/** Strip transient callbacks/UI flags before writing nodes to the store. */
export function sanitizeNodesForStore(
  nodes: Node<ExplorationNodeData>[]
): Node<ExplorationNodeData>[] {
  return nodes.map((n) => ({
    ...n,
    data: {
      ...n.data,
      pendingHighlight: undefined,
      isReplyTarget: undefined,
      onReplyFull: undefined,
      onVisualChoice: undefined,
      onLinkClick: undefined,
      onEmbedScrollChange: undefined,
      onEmbedExcerpt: undefined,
    },
  }))
}

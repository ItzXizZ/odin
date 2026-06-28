/** Rough measure of exploration content in a persisted workspace blob. */
export function workspaceExplorationWeight(json: string): number {
  try {
    const state = JSON.parse(json) as { adventures?: { nodes?: unknown[]; edges?: unknown[] }[] }
    const adventures = state.adventures ?? []
    return adventures.reduce(
      (sum, a) => sum + (a.nodes?.length ?? 0) + (a.edges?.length ?? 0),
      0
    )
  } catch {
    return 0
  }
}

/** True when `next` would wipe meaningful exploration progress from `prev`. */
export function isDestructiveWorkspaceWipe(prev: string, next: string): boolean {
  const prevW = workspaceExplorationWeight(prev)
  const nextW = workspaceExplorationWeight(next)
  return prevW >= 2 && nextW === 0
}

export function isLocalWorkspaceRicher(local: string, cloud: string): boolean {
  return workspaceExplorationWeight(local) > workspaceExplorationWeight(cloud)
}

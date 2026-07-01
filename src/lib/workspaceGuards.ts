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

/** Voice network size in a persisted workspace blob. */
export function workspaceStyleRulesCount(json: string): number {
  try {
    const state = JSON.parse(json) as { styleRules?: unknown[] }
    return state.styleRules?.length ?? 0
  } catch {
    return 0
  }
}

/** True when `next` would wipe meaningful exploration progress from `prev`. */
export function isDestructiveWorkspaceWipe(prev: string, next: string): boolean {
  const prevW = workspaceExplorationWeight(prev)
  const nextW = workspaceExplorationWeight(next)
  if (prevW >= 2 && nextW === 0) return true

  const prevRules = workspaceStyleRulesCount(prev)
  const nextRules = workspaceStyleRulesCount(next)
  // Block boot/hydration races from wiping a populated voice network.
  if (prevRules >= 3 && nextRules === 0) return true

  return false
}

export function isLocalWorkspaceRicher(local: string, cloud: string): boolean {
  return (
    workspaceExplorationWeight(local) > workspaceExplorationWeight(cloud) ||
    workspaceStyleRulesCount(local) > workspaceStyleRulesCount(cloud)
  )
}

/**
 * Tiny imperative command bus for the guided onboarding ("talking Odin").
 *
 * The coach engine (tutorial.tsx) lives above the individual mode components,
 * but some onboarding steps need to reach *into* a mode and do something
 * imperative — zoom the exploration canvas out, open the document library,
 * trigger an AI context summary, etc. Mode components register a handler for
 * the commands they support while mounted; the coach fires them by name.
 *
 * This is deliberately framework-free (no React state) so it can be called
 * from anywhere without prop-drilling or extra context providers.
 */

export type OnboardingCommand =
  | 'zoomOutExploration'
  | 'newAdventure'
  | 'startAdventure'
  | 'askResearchQuestion'
  | 'generateImage'
  | 'openDocLibrary'
  | 'openContextHouse'
  | 'closeWritePanels'
  | 'writeContextSummary'

type Handler = (arg?: unknown) => void

const registry = new Map<OnboardingCommand, Handler>()

/* ── Onboarding topic ──
   The coach drives the *real* app during onboarding (live AI, real links,
   real images). We just remember which topic the user picked so the scripted
   prompts Odin types (overview, image) stay on-topic. */
let onboardingTopic: string | null = null
let onboardingActive = false

export function setOnboardingTopic(topic: string | null): void {
  onboardingTopic = topic ? topic.trim() : null
}
export function getOnboardingTopic(): string | null {
  return onboardingTopic
}
export function setOnboardingActive(active: boolean): void {
  onboardingActive = active
  if (!active) onboardingTopic = null
}
export function isOnboardingActive(): boolean {
  return onboardingActive
}

/** Register an imperative handler. Returns an unregister function. */
export function registerOnboardingCommand(cmd: OnboardingCommand, fn: Handler): () => void {
  registry.set(cmd, fn)
  return () => {
    if (registry.get(cmd) === fn) registry.delete(cmd)
  }
}

/** Fire a command if a handler is registered. Safe to call when none exists. */
export function runOnboardingCommand(cmd: OnboardingCommand, arg?: unknown): void {
  registry.get(cmd)?.(arg)
}

const ONBOARDED_KEY = 'odin-onboarded-v1'

/** Has this browser/user already seen (or dismissed) the guided onboarding? */
export function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === '1'
  } catch {
    return true // if storage is unavailable, don't nag
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(ONBOARDED_KEY, '1')
  } catch {
    /* ignore */
  }
}

/* ── Onboarding completion ──
   `hasOnboarded` flips true the moment the tour *starts* (so we never auto-run
   it twice). We track a separate "finished" flag for the moment the guided tour
   actually completes or is dismissed — that's our cue to prompt a guest to sign
   up. Listeners let the auth gate react the instant onboarding wraps up. */
const ONBOARDING_FINISHED_KEY = 'odin-onboarding-finished-v1'

const finishedListeners = new Set<() => void>()

/** Has the guided onboarding been completed or dismissed at least once? */
export function hasFinishedOnboarding(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_FINISHED_KEY) === '1'
  } catch {
    return true // if storage is unavailable, don't trap the user in the tour
  }
}

export function markOnboardingFinished(): void {
  try {
    localStorage.setItem(ONBOARDING_FINISHED_KEY, '1')
  } catch {
    /* ignore */
  }
  // Defer so listeners (which may setState) never run inside a React updater.
  const notify = () => finishedListeners.forEach((fn) => fn())
  if (typeof queueMicrotask === 'function') queueMicrotask(notify)
  else setTimeout(notify, 0)
}

export function clearOnboardingFinished(): void {
  try {
    localStorage.removeItem(ONBOARDING_FINISHED_KEY)
  } catch {
    /* ignore */
  }
}

/** Subscribe to onboarding completion. Returns an unsubscribe function. */
export function onOnboardingFinished(fn: () => void): () => void {
  finishedListeners.add(fn)
  return () => {
    finishedListeners.delete(fn)
  }
}

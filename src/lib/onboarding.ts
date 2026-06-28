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

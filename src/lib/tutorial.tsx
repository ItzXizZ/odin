/**
 * Guided onboarding: a "talking Odin" coach that walks a brand-new user
 * through the whole product, hands-on, section by section.
 *
 * Unlike a passive feature tour, most steps are *gated on a real action*: the
 * coach waits until the user actually creates a block, branches a highlight,
 * links an adventure, etc., before moving on. The provider owns the step
 * machine, switches modes, fires imperative commands into the mode components
 * (see lib/onboarding.ts), and continuously evaluates whether the current step
 * can advance. TutorialOverlay renders Odin + the spotlight.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useStore, hasUsableKey, type AppTab } from '../store/useStore'
import { syncChat } from './claude'
import {
  markOnboarded,
  markOnboardingFinished,
  runOnboardingCommand,
  setOnboardingTopic,
  setOnboardingActive,
} from './onboarding'

export type Placement = 'top' | 'bottom' | 'left' | 'right' | 'center'

/** Two phases: the full-screen intro conversation, then the guided coach tour. */
export type TutorialPhase = 'intro' | 'tour'

/** Fields offered as quick-pick pills in the intro (free text also allowed). */
export const INTEREST_FIELDS = [
  'Psychology',
  'Finance',
  'Neuroscience',
  'Chemistry',
  'Law',
  'Medicine',
  'Philosophy',
  'History',
]

function parseStringArray(raw: string): string[] {
  const t = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const a = t.indexOf('[')
  const b = t.lastIndexOf(']')
  if (a !== -1 && b > a) {
    try {
      const arr = JSON.parse(t.slice(a, b + 1))
      if (Array.isArray(arr)) {
        return arr.filter((x) => typeof x === 'string').map((s) => s.trim()).filter(Boolean)
      }
    } catch {
      /* fall through */
    }
  }
  return t
    .split('\n')
    .map((l) => l.replace(/^[-*\d.)\s"]+/, '').replace(/[",]+$/, '').trim())
    .filter(Boolean)
}

/** Generic, on-topic fallbacks if the model is unavailable. */
function fallbackSuggestions(field: string): string[] {
  const f = field.trim() || 'this field'
  return [
    `What's a surprising recent breakthrough in ${f}?`,
    `How does ${f} shape everyday decisions?`,
    `What big question is still unsolved in ${f}?`,
    `Who are the most influential thinkers in ${f}?`,
  ]
}

/** Ask the model for a few intriguing research questions tailored to a field. */
export async function generateResearchSuggestions(
  field: string,
  apiKey: string
): Promise<string[]> {
  if ((!apiKey && !hasUsableKey()) || !field.trim()) return fallbackSuggestions(field)
  try {
    const raw = await syncChat(
      [
        {
          role: 'user',
          content: `A discerning author is exploring "${field}". Suggest exactly 4 short, provocative research questions (5–9 words each) worthy of serious inquiry. Make them precise and intellectually compelling. Reply ONLY as a JSON array of 4 strings.`,
        },
      ],
      'You suggest concise, curious research questions for a given field. Reply with only a JSON array of strings.',
      apiKey,
      220
    )
    const qs = parseStringArray(raw).slice(0, 4)
    return qs.length ? qs : fallbackSuggestions(field)
  } catch {
    return fallbackSuggestions(field)
  }
}

/** A snapshot of the bits of app state the coach gates on. */
export interface TourSnapshot {
  docs: number
  nodes: number
  edges: number
  visuals: number
  embeds: number
  linkedAdv: number
  /** How many blocks are still streaming/generating right now. */
  loadingNodes: number
}

export function computeSnapshot(): TourSnapshot {
  const s = useStore.getState()
  const adv = s.adventures.find((a) => a.id === s.activeAdventureId)
  const nodes = adv?.nodes ?? []
  const ctx = s.getActiveDocumentContext()
  return {
    docs: s.documents.length,
    nodes: nodes.filter((n) => n.data.prompt).length,
    edges: (adv?.edges ?? []).length,
    visuals: nodes.filter((n) => n.data.visual || n.data.nodeKind === 'visual').length,
    embeds: nodes.filter((n) => n.data.nodeKind === 'embed').length,
    linkedAdv: ctx.linkedAdventureIds?.length ?? 0,
    loadingNodes: nodes.filter((n) => n.data.isLoading).length,
  }
}

/**
 * True when this isn't a clean first-run: the user already has adventures with
 * content, multiple adventures, or saved documents. We use this to decide
 * whether the tour should ask them to spin up a fresh adventure first (so the
 * walkthrough never disturbs their existing work).
 */
export function hasExistingWork(): boolean {
  const s = useStore.getState()
  const anyNodes = s.adventures.some((a) => (a.nodes ?? []).some((n) => n.data?.prompt))
  // Only treat documents with actual content/context as existing work
  // so genuinely new users still get the tour.
  const realDocs = s.documents.some((d) => {
    const hasText = (d.tabs ?? []).some((t) => (t.content ?? '').trim().length > 0)
    const ctx = d.context
    const hasContext = Boolean(
      ctx &&
        (ctx.pdfs?.length ||
          ctx.images?.length ||
          ctx.conversations?.length ||
          ctx.linkedAdventureIds?.length),
    )
    return hasText || hasContext
  })
  return s.adventures.length > 1 || anyNodes || realDocs
}

export interface TourStep {
  id: string
  /** Section to switch to before showing this step. */
  tab?: AppTab
  /** CSS selector of the element to spotlight. Omit to dim + float the coach. */
  target?: string
  placement?: Placement
  /**
   * Keep the spotlight on the target, but float the coach so it never covers
   * the thing it's pointing at. Use `coachSide` to pick the dock edge.
   */
  floatCoach?: boolean
  /** Where to dock the coach when `floatCoach` is true. */
  coachSide?: 'bottom-left' | 'left'
  /** Cap the spotlight height (px), useful for tall, full-height elements. */
  maxHeight?: number
  /** What Odin says on this step. */
  say: string
  /** Quick-pick chips (e.g. topics). Clicking one runs onChip(value). */
  chips?: string[]
  /** Pull chips dynamically from live tour state (e.g. AI research suggestions). */
  chipsSource?: 'suggestions'
  onChip?: (value: string) => void
  /** Run once when the step becomes active (open a panel, zoom out, etc.). */
  onEnter?: () => void
  /** Skip this step entirely when this returns true (evaluated at navigation). */
  skipWhen?: () => boolean
  /**
   * Gate: given the snapshot captured when the step opened and the live
   * snapshot, return true once the required action has happened.
   */
  advanceWhen?: (entry: TourSnapshot, live: TourSnapshot) => boolean
  /** Auto-advance the moment advanceWhen flips true (no click needed). */
  autoAdvance?: boolean
  /** Hide the Next button (the step must be completed via action/CTA). */
  hideNext?: boolean
  /** Text shown beside the spinner while waiting for a gated action. */
  waitText?: string
  /** A primary call-to-action button. */
  cta?: { label: string; run?: () => void; advance?: boolean }
  /** Label override for the Next button. */
  nextLabel?: string
}

const TOUR_STEPS: TourStep[] = [
  {
    id: 'new-adventure',
    tab: 'exploration',
    // Only shown to returning users who already have work; new users skip this.
    skipWhen: () => !hasExistingWork(),
    onEnter: () => runOnboardingCommand('zoomOutExploration'),
    say: "You already have work in progress, admirable. I'll open a pristine adventure canvas for this masterclass, leaving everything you've crafted untouched.",
    cta: {
      label: 'New adventure',
      run: () => runOnboardingCommand('newAdventure'),
    },
  },
  {
    id: 'research-question',
    tab: 'exploration',
    target: '[data-tour="exploration-prompt"]',
    placement: 'top',
    onEnter: () => runOnboardingCommand('zoomOutExploration'),
    say: "Every great work begins with a question worth pursuing. Pose one that genuinely compels you, or select from those I've curated for your discipline.",
    chipsSource: 'suggestions',
    onChip: (value) => {
      runOnboardingCommand('askResearchQuestion', value)
    },
    advanceWhen: (entry, live) => live.nodes > entry.nodes,
    autoAdvance: true,
    hideNext: true,
    waitText: 'Pose your question to begin…',
  },
  {
    id: 'research-wait',
    tab: 'exploration',
    say: "An excellent question. Allow the response to reach its full depth. I'll remain here until it's complete.",
    // Only move on once nothing is still generating.
    advanceWhen: (_entry, live) => live.loadingNodes === 0,
    autoAdvance: true,
    hideNext: true,
    waitText: 'Awaiting the full response…',
  },
  {
    id: 'explore-links',
    tab: 'exploration',
    say: 'Every citation is a gateway to primary source. Select an underlined reference, then open or embed the full page directly onto your canvas.',
    cta: { label: 'Understood' },
  },
  {
    id: 'explore-highlight',
    tab: 'exploration',
    say: 'Highlight any passage that demands deeper examination. Odin will propose follow-up questions and branch a new block from precisely that idea.',
    advanceWhen: (entry, live) => live.edges > entry.edges || live.nodes > entry.nodes,
    autoAdvance: true,
    hideNext: true,
    waitText: 'Highlight a passage to branch deeper…',
  },
  {
    id: 'explore-images',
    tab: 'exploration',
    say: "Research need not be purely textual. Observe, and I'll commission a visual representation of your subject as its own block.",
    cta: {
      label: 'Generate visual',
      run: () => runOnboardingCommand('generateImage'),
      advance: false,
    },
    advanceWhen: (entry, live) => live.visuals > entry.visuals,
    autoAdvance: true,
    waitText: 'Rendering your visual…',
    nextLabel: 'Skip',
  },
  {
    id: 'explore-sources',
    tab: 'exploration',
    target: '[data-tour="sources"]',
    placement: 'left',
    say: "Every answer rests on verified research. This panel reveals the sources behind each block. Read, verify, and cite with confidence.",
    cta: { label: 'Understood' },
  },
  {
    id: 'explore-continue',
    tab: 'exploration',
    say: "Continue your adventure as long as inspiration demands: branch, embed, dig deeper. When you're ready, we'll transform this into prose.",
    cta: {
      label: 'Begin composing',
      run: () => {
        useStore.getState().setActiveTab('write')
        runOnboardingCommand('openDocLibrary')
      },
    },
  },
  {
    id: 'write-documents',
    tab: 'write',
    target: '[data-tour="doclibrary"]',
    placement: 'right',
    onEnter: () => runOnboardingCommand('openDocLibrary'),
    say: 'Your document library holds every work you\'ve ever composed, impeccably preserved. Create a new document to begin.',
    advanceWhen: (entry, live) => live.docs > entry.docs,
    autoAdvance: true,
    hideNext: true,
    waitText: 'Create a new document to continue…',
  },
  {
    id: 'write-context',
    tab: 'write',
    target: '[data-tour="context"]',
    placement: 'right',
    floatCoach: true,
    onEnter: () => runOnboardingCommand('openContextHouse'),
    say: 'Before you write a single word, furnish The Context House. Link the adventure you just completed, and Odin will name it by subject. Then continue.',
    advanceWhen: (entry, live) => live.linkedAdv > entry.linkedAdv,
    waitText: 'Link your adventure, then continue…',
    nextLabel: 'Continue',
  },
  {
    id: 'write-summary',
    tab: 'write',
    target: '[data-tour="editor"]',
    placement: 'left',
    onEnter: () => {
      runOnboardingCommand('closeWritePanels')
    },
    say: "This is where research becomes prose. I can synthesize everything in The Context House into an opening draft. Shall I compose a summary to begin?",
    cta: {
      label: 'Compose summary',
      run: () => runOnboardingCommand('writeContextSummary'),
      advance: false,
    },
    nextLabel: 'Continue',
  },
  {
    id: 'write-feedback',
    tab: 'write',
    target: '[data-tour="assistant"]',
    placement: 'left',
    say: "When a sentence falls short of your standard, highlight it and tell me precisely what's wrong. Phrase it as a principle ('make this less formal') and I'll engrave it into your Voice.",
    cta: { label: 'Open Voice', run: () => useStore.getState().setActiveTab('stylism') },
  },
  {
    id: 'style-finish',
    tab: 'stylism',
    floatCoach: true,
    coachSide: 'left',
    say: "This is your Voice, a living network of principles learned from every correction you make. Over time, Odin writes indistinguishably from you. Research. Compose. Refine. You are ready.",
    nextLabel: 'Complete',
  },
]

/** Find the next step index (in direction dir) that isn't skipped right now. */
function nextVisibleIndex(from: number, dir: 1 | -1): number {
  let idx = from
  while (idx >= 0 && idx < TOUR_STEPS.length) {
    const step = TOUR_STEPS[idx]
    if (!step.skipWhen || !step.skipWhen()) return idx
    idx += dir
  }
  return idx
}

interface TutorialState {
  active: boolean
  /** 'intro' = full-screen conversation, 'tour' = guided coach walkthrough. */
  phase: TutorialPhase
  /** The field of interest the user picked in the intro. */
  field: string | null
  /** AI-generated research questions tailored to `field`. */
  suggestions: string[]
  suggestionsLoading: boolean
  stepIndex: number
  step: TourStep | null
  steps: TourStep[]
  /** True when the current gated step's required action is complete. */
  canAdvance: boolean
  start: () => void
  stop: () => void
  /** Intro: record the chosen field and kick off tailored suggestions. */
  chooseField: (field: string) => void
  /** Intro to tour: leave the conversation modal and begin the walkthrough. */
  beginTour: () => void
  next: () => void
  prev: () => void
}

const TutorialContext = createContext<TutorialState | undefined>(undefined)

export function TutorialProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false)
  const [phase, setPhase] = useState<TutorialPhase>('intro')
  const [field, setField] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [suggestionsLoading, setSuggestionsLoading] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)
  const [canAdvance, setCanAdvance] = useState(false)
  const entrySnapRef = useRef<TourSnapshot | null>(null)
  const suggestionReqRef = useRef(0)

  const enterStep = useCallback((i: number) => {
    const step = TOUR_STEPS[i]
    if (!step) return
    if (step.tab) useStore.getState().setActiveTab(step.tab)
    entrySnapRef.current = computeSnapshot()
    setCanAdvance(false)
    // Defer onEnter so the target mode has a chance to mount/register commands.
    if (step.onEnter) {
      setTimeout(() => step.onEnter?.(), 120)
    }
  }, [])

  const start = useCallback(() => {
    markOnboarded()
    setOnboardingActive(true)
    setField(null)
    setSuggestions([])
    setSuggestionsLoading(false)
    setStepIndex(0)
    setCanAdvance(false)
    setPhase('intro')
    setActive(true)
  }, [])

  const stop = useCallback(() => {
    markOnboarded()
    markOnboardingFinished()
    setOnboardingActive(false)
    setActive(false)
    setCanAdvance(false)
  }, [])

  const chooseField = useCallback((value: string) => {
    const f = value.trim()
    if (!f) return
    setField(f)
    setOnboardingTopic(f)
    setSuggestions([])
    setSuggestionsLoading(true)
    const reqId = ++suggestionReqRef.current
    const apiKey = useStore.getState().apiKey
    void generateResearchSuggestions(f, apiKey).then((qs) => {
      if (suggestionReqRef.current !== reqId) return
      setSuggestions(qs)
      setSuggestionsLoading(false)
    })
  }, [])

  const beginTour = useCallback(() => {
    const first = nextVisibleIndex(0, 1)
    setStepIndex(first)
    setPhase('tour')
    enterStep(first)
  }, [enterStep])

  const next = useCallback(() => {
    setStepIndex((i) => {
      const n = nextVisibleIndex(i + 1, 1)
      if (n >= TOUR_STEPS.length) {
        markOnboarded()
        markOnboardingFinished()
        setOnboardingActive(false)
        setActive(false)
        setCanAdvance(false)
        return i
      }
      enterStep(n)
      return n
    })
  }, [enterStep])

  const prev = useCallback(() => {
    setStepIndex((i) => {
      const p = nextVisibleIndex(i - 1, -1)
      if (p < 0) return i
      enterStep(p)
      return p
    })
  }, [enterStep])

  // Poll for gated-action completion while the guided tour is active.
  const nextRef = useRef(next)
  nextRef.current = next
  useEffect(() => {
    if (!active || phase !== 'tour') return
    const step = TOUR_STEPS[stepIndex]
    if (!step?.advanceWhen) {
      setCanAdvance(true)
      return
    }
    const tick = () => {
      const entry = entrySnapRef.current ?? computeSnapshot()
      const done = step.advanceWhen!(entry, computeSnapshot())
      if (done) {
        setCanAdvance(true)
        if (step.autoAdvance) nextRef.current()
      }
    }
    tick()
    const id = window.setInterval(tick, 450)
    return () => window.clearInterval(id)
  }, [active, phase, stepIndex])

  const value = useMemo<TutorialState>(
    () => ({
      active,
      phase,
      field,
      suggestions,
      suggestionsLoading,
      stepIndex,
      step: active && phase === 'tour' ? TOUR_STEPS[stepIndex] ?? null : null,
      steps: TOUR_STEPS,
      canAdvance,
      start,
      stop,
      chooseField,
      beginTour,
      next,
      prev,
    }),
    [
      active,
      phase,
      field,
      suggestions,
      suggestionsLoading,
      stepIndex,
      canAdvance,
      start,
      stop,
      chooseField,
      beginTour,
      next,
      prev,
    ]
  )

  return <TutorialContext.Provider value={value}>{children}</TutorialContext.Provider>
}

export function useTutorial(): TutorialState {
  const ctx = useContext(TutorialContext)
  if (!ctx) throw new Error('useTutorial must be used within a TutorialProvider')
  return ctx
}

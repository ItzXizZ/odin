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
          content: `A curious professional is interested in "${field}". Suggest exactly 4 short, intriguing research questions (5–9 words each) they'd love to explore in this field. Make them specific and thought-provoking. Reply ONLY as a JSON array of 4 strings.`,
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
  return s.adventures.length > 1 || anyNodes || s.documents.length > 0
}

export interface TourStep {
  id: string
  /** Section to switch to before showing this step. */
  tab?: AppTab
  /** CSS selector of the element to spotlight. Omit to dim + float the coach. */
  target?: string
  placement?: Placement
  /**
   * Keep the spotlight on the target, but float the coach in the bottom-left
   * corner so it never covers the very thing it's pointing at.
   */
  floatCoach?: boolean
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
    say: "Looks like you've already got some work here. Let's keep it tidy. I'll start a fresh adventure just for this walkthrough so nothing you've made gets touched.",
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
    say: "Let's begin with a spark of curiosity. Type a question you'd genuinely love to research, or tap one I've tailored to your field.",
    chipsSource: 'suggestions',
    onChip: (value) => {
      runOnboardingCommand('askResearchQuestion', value)
    },
    advanceWhen: (entry, live) => live.nodes > entry.nodes,
    autoAdvance: true,
    hideNext: true,
    waitText: 'Ask a question to begin…',
  },
  {
    id: 'research-wait',
    tab: 'exploration',
    say: "Beautiful question. Let's give that block a moment to finish writing. I'll wait right here, then we'll keep going.",
    // Only move on once nothing is still generating.
    advanceWhen: (_entry, live) => live.loadingNodes === 0,
    autoAdvance: true,
    hideNext: true,
    waitText: 'Letting the block finish…',
  },
  {
    id: 'explore-links',
    tab: 'exploration',
    say: 'See the underlined links in that block? Each one is a real source. Click one, then open it or embed the whole page right onto your canvas. Try it.',
    cta: { label: 'Got it' },
  },
  {
    id: 'explore-highlight',
    tab: 'exploration',
    say: 'Now highlight any sentence inside a block. Odin suggests questions and branches a new sub-block to dig deeper into exactly that idea.',
    advanceWhen: (entry, live) => live.edges > entry.edges || live.nodes > entry.nodes,
    autoAdvance: true,
    hideNext: true,
    waitText: 'Highlight a sentence to branch a sub-block…',
  },
  {
    id: 'explore-images',
    tab: 'exploration',
    say: "You can think visually too. Watch closely: I'll ask for an image of your topic and draw it as its own block.",
    cta: {
      label: 'Show image',
      run: () => runOnboardingCommand('generateImage'),
      advance: false,
    },
    advanceWhen: (entry, live) => live.visuals > entry.visuals,
    autoAdvance: true,
    waitText: 'Drawing your image…',
    nextLabel: 'Skip',
  },
  {
    id: 'explore-sources',
    tab: 'exploration',
    target: '[data-tour="sources"]',
    placement: 'left',
    say: "Every answer is grounded in real research. This tab on the right opens your Sources panel so you can read and cite what's behind each block.",
    cta: { label: 'Makes sense' },
  },
  {
    id: 'explore-continue',
    tab: 'exploration',
    say: "Keep exploring as long as you like: branch, ask, embed. When you're ready, let's turn this into actual writing.",
    cta: {
      label: "Let's write",
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
    say: 'This is your document library, where every writing project lives. Create a new document to start writing.',
    advanceWhen: (entry, live) => live.docs > entry.docs,
    autoAdvance: true,
    hideNext: true,
    waitText: 'Click “New document” to continue…',
  },
  {
    id: 'write-context',
    tab: 'write',
    target: '[data-tour="context"]',
    placement: 'right',
    floatCoach: true,
    onEnter: () => runOnboardingCommand('openContextHouse'),
    say: 'First, give Odin some context. In the Adventures slot, add the adventure you just explored. Odin even names it for you by topic. Then hit Next.',
    advanceWhen: (entry, live) => live.linkedAdv > entry.linkedAdv,
    waitText: 'Add your adventure, then press Next…',
    nextLabel: 'Next',
  },
  {
    id: 'write-summary',
    tab: 'write',
    target: '[data-tour="editor"]',
    placement: 'left',
    onEnter: () => {
      runOnboardingCommand('closeWritePanels')
    },
    say: "Here's the magic: I can turn everything in your Context House into a first draft. Want me to write a summary to get you started?",
    cta: {
      label: 'Summarize',
      run: () => runOnboardingCommand('writeContextSummary'),
      advance: false,
    },
    nextLabel: 'Next',
  },
  {
    id: 'write-feedback',
    tab: 'write',
    target: '[data-tour="assistant"]',
    placement: 'left',
    say: "Don't like a sentence? Highlight it, add it to chat, and tell me what's off. Phrase it like a rule, say “make this less formal”, and I'll remember your voice.",
    cta: { label: 'Open Style', run: () => useStore.getState().setActiveTab('stylism') },
  },
  {
    id: 'style-finish',
    tab: 'stylism',
    target: '[data-tour="main"]',
    placement: 'center',
    say: "This is your Style network. Every bit of feedback becomes a rule that wires into the others, so Odin writes more like you over time. That's the whole loop: explore, write, refine. You're all set!",
    nextLabel: 'Finish',
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

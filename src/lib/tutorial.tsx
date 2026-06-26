/**
 * Guided tutorial — walks a new user through Odin section by section with
 * spotlight + popup coach-marks. The provider owns the step sequence and
 * switches the active mode as you advance; TutorialOverlay does the rendering.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useStore, type AppTab } from '../store/useStore'

export type Placement = 'top' | 'bottom' | 'left' | 'right' | 'center'

export interface TourStep {
  id: string
  /** Section to switch to before showing this step. */
  tab?: AppTab
  /** CSS selector of the element to spotlight. Omit to dim + center the popup. */
  target?: string
  title: string
  body: string
  placement?: Placement
  /** Cap the spotlight height (px) — useful for tall, full-height elements. */
  maxHeight?: number
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    tab: 'home',
    target: '[data-tour="logo"]',
    placement: 'bottom',
    title: 'Welcome to Odin',
    body: 'A quick tour of your writing studio. Step through with Next — you can exit any time.',
  },
  {
    id: 'nav',
    tab: 'home',
    target: '[data-tour="nav"]',
    placement: 'bottom',
    title: 'Your three modes',
    body: 'Move between Write, Exploration, and Stylism from this bar whenever you like.',
  },
  {
    id: 'editor',
    tab: 'write',
    target: '[data-tour="editor"]',
    placement: 'right',
    maxHeight: 260,
    title: 'Write',
    body: 'This is your document — just start typing. Formatting and word count live along the top.',
  },
  {
    id: 'doctabs',
    tab: 'write',
    target: '[data-tour="doctabs"]',
    placement: 'right',
    title: 'Document tabs',
    body: 'A single document can hold several tabs — add, rename, or remove them here to keep related drafts together.',
  },
  {
    id: 'doclibrary',
    tab: 'write',
    target: '[data-tour="doclibrary"]',
    placement: 'bottom',
    title: 'Document library',
    body: 'Browse, create, and switch between all of your documents from the library.',
  },
  {
    id: 'context',
    tab: 'write',
    target: '[data-tour="context"]',
    placement: 'bottom',
    title: 'Context House',
    body: 'Add PDFs, notes, and research here so the assistant grounds its help in your own sources.',
  },
  {
    id: 'assistant',
    tab: 'write',
    target: '[data-tour="assistant"]',
    placement: 'left',
    title: 'AI assistant',
    body: 'Ask it to draft, rewrite, or tighten anything. Edits appear as a diff you accept or reject inline.',
  },
  {
    id: 'assistant-toggle',
    tab: 'write',
    target: '[data-tour="assistant-toggle"]',
    placement: 'bottom',
    title: 'Show / hide the assistant',
    body: 'Toggle the AI panel with this button whenever you want a clear, full-width writing space.',
  },
  {
    id: 'exploration',
    tab: 'exploration',
    target: '[data-tour="main"]',
    placement: 'center',
    title: 'Exploration',
    body: 'Branch ideas on an infinite canvas backed by live web research, then carry the best threads into your draft.',
  },
  {
    id: 'sources',
    tab: 'exploration',
    target: '[data-tour="sources"]',
    placement: 'left',
    title: 'Sources tab',
    body: 'Every answer is grounded in real web research. Open the Sources tab to read and cite the references behind it.',
  },
  {
    id: 'stylism',
    tab: 'stylism',
    target: '[data-tour="main"]',
    placement: 'center',
    title: 'Stylism',
    body: 'Give feedback like “less formal” and Odin saves it as a rule — learning your voice as you write.',
  },
  {
    id: 'account',
    tab: 'home',
    target: '[data-tour="account"]',
    placement: 'left',
    title: 'Your account',
    body: 'Everything saves to your Google account automatically. Sign out from here when you’re done.',
  },
  {
    id: 'done',
    tab: 'home',
    target: '[data-tour="logo"]',
    placement: 'bottom',
    title: 'You’re all set',
    body: 'Hit “Start writing” whenever you’re ready. You can reopen this tour from the home screen.',
  },
]

interface TutorialState {
  active: boolean
  stepIndex: number
  step: TourStep | null
  steps: TourStep[]
  start: () => void
  stop: () => void
  next: () => void
  prev: () => void
}

const TutorialContext = createContext<TutorialState | undefined>(undefined)

export function TutorialProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)

  const applyTab = useCallback((i: number) => {
    const tab = TOUR_STEPS[i]?.tab
    if (tab) useStore.getState().setActiveTab(tab)
  }, [])

  const start = useCallback(() => {
    setStepIndex(0)
    applyTab(0)
    setActive(true)
  }, [applyTab])

  const stop = useCallback(() => {
    setActive(false)
    useStore.getState().setActiveTab('home')
  }, [])

  const next = useCallback(() => {
    setStepIndex((i) => {
      const n = i + 1
      if (n >= TOUR_STEPS.length) {
        setActive(false)
        useStore.getState().setActiveTab('home')
        return i
      }
      applyTab(n)
      return n
    })
  }, [applyTab])

  const prev = useCallback(() => {
    setStepIndex((i) => {
      const p = Math.max(0, i - 1)
      applyTab(p)
      return p
    })
  }, [applyTab])

  const value = useMemo<TutorialState>(
    () => ({
      active,
      stepIndex,
      step: active ? TOUR_STEPS[stepIndex] ?? null : null,
      steps: TOUR_STEPS,
      start,
      stop,
      next,
      prev,
    }),
    [active, stepIndex, start, stop, next, prev]
  )

  return <TutorialContext.Provider value={value}>{children}</TutorialContext.Provider>
}

export function useTutorial(): TutorialState {
  const ctx = useContext(TutorialContext)
  if (!ctx) throw new Error('useTutorial must be used within a TutorialProvider')
  return ctx
}

import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore, type AppTab } from '../store/useStore'
import ExplorationMode from './ExplorationMode'
import WriteMode from './WriteMode'
import StylismMode from './WriteMode/StylismMode'
import HomeMode from './HomeMode'
import UserMenu from './UserMenu'
import TutorialOverlay from './TutorialOverlay'
import { TutorialProvider, useTutorial } from '../lib/tutorial'
import { hasOnboarded } from '../lib/onboarding'
import { hasExistingWork } from '../lib/tutorial'
import logo from './logo.png'

/**
 * Kicks off the guided "talking Odin" onboarding the first time a brand-new
 * user lands in the app (once the store has hydrated). Lives inside the
 * TutorialProvider so it can call start().
 *
 * We only auto-start for genuinely new users (no existing work). Returning
 * users who already have adventures/documents won't be interrupted — they can
 * launch the tour from the logo, and the tour will offer to spin up a fresh
 * adventure first so their work stays untouched.
 */
function OnboardingAutostart() {
  const { start } = useTutorial()
  const startedRef = useRef(false)

  useEffect(() => {
    if (hasOnboarded() || startedRef.current) return
    let cancelled = false
    const begin = () => {
      if (cancelled || startedRef.current || hasOnboarded()) return
      // Don't ambush a returning user mid-work with an auto-tour.
      if (hasExistingWork()) return
      startedRef.current = true
      start()
    }
    if (useStore.persist.hasHydrated()) {
      const t = setTimeout(begin, 700)
      return () => {
        cancelled = true
        clearTimeout(t)
      }
    }
    const unsub = useStore.persist.onFinishHydration(() => setTimeout(begin, 700))
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [start])

  return null
}

const TABS: { id: AppTab; label: string }[] = [
  { id: 'exploration', label: 'Exploration' },
  { id: 'write',       label: 'Write'       },
  { id: 'stylism',     label: 'Style'       },
]

export default function Layout() {
  const { activeTab, setActiveTab } = useStore()
  const navRef = useRef<HTMLDivElement>(null)

  /* Measure each nav-item's width and write CSS variables so the
     glass sliding highlight can position itself correctly. */
  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const items = nav.querySelectorAll<HTMLElement>('.nav-item')
    items.forEach((el, i) => {
      nav.style.setProperty(`--item-${i}-width`, `${el.offsetWidth}px`)
    })
    const activeIdx = TABS.findIndex((t) => t.id === activeTab)
    nav.setAttribute('data-active', String(activeIdx))
  }, [activeTab])

  return (
    <TutorialProvider>
      <div className="flex h-full flex-col overflow-hidden">
        {/* ── Top navigation bar ── */}
        <header
          className="flex-shrink-0 flex items-center px-5 py-3"
          style={{ background: 'transparent', position: 'relative' }}
        >
          {/* Logo — click to return to the home / welcome screen */}
          <button
            type="button"
            className="app-logo"
            aria-label="Odin home"
            data-tour="logo"
            onClick={() => setActiveTab('home')}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            <img src={logo} alt="" className="app-logo-img" />
            <span className="app-logo-text">Odin</span>
          </button>

          {/* Glass pill nav — absolutely centred in the header */}
          <div
            className="nav-wrap"
            style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)' }}
          >
            <div className="nav-shadow" aria-hidden="true" />
            <nav className="nav" ref={navRef} data-tour="nav">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  className={`nav-item${activeTab === tab.id ? ' active' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          </div>

          {/* Account menu — pushed to the far right */}
          <div style={{ marginLeft: 'auto' }} data-tour="account">
            <UserMenu />
          </div>

        </header>

        {/* ── Main content ── */}
        <main className="flex-1 overflow-hidden relative" data-tour="main">
          {/* Keep WriteMode mounted so the editor + in-progress work survive tab switches */}
          <div className={`h-full ${activeTab === 'write' ? '' : 'hidden'}`} aria-hidden={activeTab !== 'write'}>
            <WriteMode />
          </div>

          {activeTab !== 'write' && (
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
                className="h-full absolute inset-0"
              >
                {activeTab === 'home'        && <HomeMode />}
                {activeTab === 'exploration' && <ExplorationMode />}
                {activeTab === 'stylism'     && <StylismMode />}
              </motion.div>
            </AnimatePresence>
          )}
        </main>
      </div>

      <OnboardingAutostart />
      <TutorialOverlay />
    </TutorialProvider>
  )
}

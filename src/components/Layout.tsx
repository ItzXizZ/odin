import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore, type AppTab } from '../store/useStore'
import ExplorationMode from './ExplorationMode'
import WriteMode from './WriteMode'
import StylismMode from './WriteMode/StylismMode'
import HomeMode from './HomeMode'
import UserMenu from './UserMenu'
import logo from './logo.png'

const TABS: { id: AppTab; label: string }[] = [
  { id: 'write',       label: 'Write'      },
  { id: 'exploration', label: 'Exploration' },
  { id: 'stylism',     label: 'Stylism'    },
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
          <nav className="nav" ref={navRef}>
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
        <div style={{ marginLeft: 'auto' }}>
          <UserMenu />
        </div>

      </header>

      {/* ── Main content ── */}
      <main className="flex-1 overflow-hidden relative">
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
  )
}

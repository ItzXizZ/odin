import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Settings, BookOpen, FileText, GitBranch, PenTool, Share2 } from 'lucide-react'
import { useStore, type AppTab } from '../store/useStore'
import ContextHouse from './ContextHouse'
import DocumentsMode from './DocumentsMode'
import ExplorationMode from './ExplorationMode'
import WriteMode from './WriteMode'
import StylismMode from './WriteMode/StylismMode'
import logo from './logo.png'

const TABS: { id: AppTab; label: string; icon: React.ReactNode }[] = [
  { id: 'context',     label: 'Context House', icon: <BookOpen size={14} /> },
  { id: 'documents',   label: 'Documents',     icon: <FileText size={14} /> },
  { id: 'exploration', label: 'Exploration',   icon: <GitBranch size={14} /> },
  { id: 'write',       label: 'Write',         icon: <PenTool size={14} /> },
  { id: 'stylism',     label: 'Stylism',       icon: <Share2 size={14} /> },
]

export default function Layout() {
  const { activeTab, setActiveTab, setShowSettings } = useStore()
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
        className="flex-shrink-0 flex items-center justify-between px-5 py-3"
        style={{ background: 'transparent' }}
      >
        {/* Logo */}
        <div className="app-logo" aria-label="Odin">
          <img src={logo} alt="" className="app-logo-img" />
          <span className="app-logo-text">Odin</span>
        </div>

        {/* Glass pill nav */}
        <div className="nav-wrap" style={{ position: 'relative' }}>
          <div className="nav-shadow" aria-hidden="true" />
          <nav className="nav" ref={navRef}>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                className={`nav-item${activeTab === tab.id ? ' active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <span style={{ marginRight: '0.375em', opacity: 0.7, display: 'inline-flex', verticalAlign: 'middle' }}>
                  {tab.icon}
                </span>
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Settings button */}
        <div className="button-wrap" style={{ fontSize: '0.875rem' }}>
          <button
            onClick={() => setShowSettings(true)}
            title="Settings"
            style={{ padding: '0.55em 0.9em' }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35em', paddingInline: 0, paddingBlock: 0 }}>
              <Settings size={15} />
              <span style={{ fontSize: '0.875rem' }}>Settings</span>
            </span>
          </button>
          <div className="button-shadow" aria-hidden="true" />
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
              {activeTab === 'context'     && <ContextHouse />}
              {activeTab === 'documents'   && <DocumentsMode />}
              {activeTab === 'exploration' && <ExplorationMode />}
              {activeTab === 'stylism'     && <StylismMode />}
            </motion.div>
          </AnimatePresence>
        )}
      </main>
    </div>
  )
}

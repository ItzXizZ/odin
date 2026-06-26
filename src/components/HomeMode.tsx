import { motion } from 'framer-motion'
import { PenLine, Compass, Sparkles, ArrowRight } from 'lucide-react'
import { useStore, type AppTab } from '../store/useStore'
import logo from './logo.png'

interface ModeCard {
  id: Extract<AppTab, 'write' | 'exploration' | 'stylism'>
  label: string
  icon: React.ReactNode
  desc: string
}

const MODES: ModeCard[] = [
  {
    id: 'write',
    label: 'Write',
    icon: <PenLine size={18} />,
    desc: 'Draft alongside an AI editor that proposes precise, reviewable edits — accept or reject each one inline.',
  },
  {
    id: 'exploration',
    label: 'Exploration',
    icon: <Compass size={18} />,
    desc: 'Branch your thinking on an infinite canvas, backed by live web research and cited sources.',
  },
  {
    id: 'stylism',
    label: 'Stylism',
    icon: <Sparkles size={18} />,
    desc: 'Teach Odin your voice once. It learns your style and keeps to it everywhere you write.',
  },
]

const STEPS: { n: number; title: string; body: string }[] = [
  {
    n: 1,
    title: 'Gather your material',
    body: 'Open Context House inside Write to drop in PDFs, notes, and research. Odin reads it all so its help is grounded in your sources.',
  },
  {
    n: 2,
    title: 'Draft with the assistant',
    body: 'Type in the editor, or ask the assistant on the right to draft, rewrite, or tighten any passage. Every change is shown as a diff you control.',
  },
  {
    n: 3,
    title: 'Explore when you’re stuck',
    body: 'Jump to Exploration to branch ideas on a canvas and pull in fresh web research, then carry the best threads back into your draft.',
  },
  {
    n: 4,
    title: 'Shape your voice',
    body: 'Give feedback like “less formal” and Stylism records it as a rule — so Odin sounds more like you with every edit.',
  },
]

export default function HomeMode() {
  const setActiveTab = useStore((s) => s.setActiveTab)

  return (
    <div className="home-scroll">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="home-inner"
      >
        <img src={logo} alt="" className="home-logo" />
        <h1 className="home-title">Welcome to Odin</h1>
        <p className="home-sub">
          Your AI writing studio — research, draft, and refine your voice all in
          one calm space.
        </p>

        <button className="home-cta" onClick={() => setActiveTab('write')}>
          Start writing
          <ArrowRight size={16} />
        </button>

        <div className="home-modes">
          {MODES.map((m) => (
            <button key={m.id} className="home-mode-card" onClick={() => setActiveTab(m.id)}>
              <span className="home-mode-icon">{m.icon}</span>
              <span className="home-mode-label">{m.label}</span>
              <span className="home-mode-desc">{m.desc}</span>
              <span className="home-mode-open">
                Open <ArrowRight size={13} />
              </span>
            </button>
          ))}
        </div>

        <div className="home-tutorial">
          <h2 className="home-tutorial-title">How it works</h2>
          <div className="home-steps">
            {STEPS.map((s) => (
              <div key={s.n} className="home-step">
                <span className="home-step-num">{s.n}</span>
                <div className="home-step-text">
                  <strong>{s.title}</strong>
                  <span>{s.body}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="home-foot">Pick a mode above, or click the Odin logo any time to come back here.</p>
      </motion.div>
    </div>
  )
}

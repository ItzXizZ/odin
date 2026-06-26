import { motion } from 'framer-motion'
import { ArrowRight, PlayCircle } from 'lucide-react'
import { useStore } from '../store/useStore'
import { useTutorial } from '../lib/tutorial'
import logo from './logo.png'

export default function HomeMode() {
  const setActiveTab = useStore((s) => s.setActiveTab)
  const { start } = useTutorial()

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
        <p className="home-sub">Your AI writing studio</p>

        <div className="home-actions">
          <button className="home-cta" onClick={() => setActiveTab('write')}>
            Start writing
            <ArrowRight size={16} />
          </button>
          <button className="home-cta home-cta-secondary" onClick={() => start()}>
            <PlayCircle size={16} />
            Tutorial
          </button>
        </div>
      </motion.div>
    </div>
  )
}

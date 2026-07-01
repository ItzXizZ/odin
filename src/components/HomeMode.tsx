import { useEffect, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { useStore } from '../store/useStore'
import { useTutorial } from '../lib/tutorial'
import anim1 from './Animation 1.png'
import anim2 from './Animation 2.png'
import anim3 from './Animation 3.png'

const ODIN_FRAMES = [anim1, anim2, anim3, anim2]
const FRAME_MS = 130
const TYPE_MS = 52

const ODIN_SEGMENTS = [
  { text: 'Inspired by Odin, god of wisdom and runes. ' },
  { text: 'Odin is the best way to write and research.', bold: true },
  { text: ' Designed for demi-gods and professionals.' },
] as const

const ODIN_QUOTE = ODIN_SEGMENTS.map((s) => s.text).join('')

type TextSegment = { text: string; bold?: boolean }

function renderTypedSegments(
  displayed: string,
  segments: readonly TextSegment[],
  showCursor: boolean
) {
  let offset = 0
  const nodes: ReactNode[] = []
  const len = displayed.length

  for (const [idx, segment] of segments.entries()) {
    const segStart = offset
    const segEnd = offset + segment.text.length
    offset = segEnd

    if (len <= segStart) break

    const chunk = displayed.slice(segStart, Math.min(len, segEnd))
    const isActive = showCursor && len > segStart && len <= segEnd

    const inner = (
      <>
        {chunk}
        {isActive && <span className="home-speech-cursor" aria-hidden="true" />}
      </>
    )

    if (segment.bold) {
      nodes.push(<strong key={idx}>{inner}</strong>)
    } else {
      nodes.push(<span key={idx}>{inner}</span>)
    }
  }

  return nodes
}

function TypewriterText({
  text,
  segments,
  active,
  speed = TYPE_MS,
  onStart,
  onComplete,
}: {
  text: string
  segments?: readonly TextSegment[]
  active: boolean
  speed?: number
  onStart?: () => void
  onComplete?: () => void
}) {
  const [displayed, setDisplayed] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!active) return

    setDisplayed('')
    setDone(false)
    onStart?.()

    let i = 0
    const id = setInterval(() => {
      i += 1
      setDisplayed(text.slice(0, i))
      if (i >= text.length) {
        clearInterval(id)
        setDone(true)
        onComplete?.()
      }
    }, speed)

    return () => clearInterval(id)
  }, [text, speed, active]) // onStart/onComplete intentionally omitted

  return (
    <p className="home-speech-text">
      {segments
        ? renderTypedSegments(displayed, segments, active && !done)
        : (
            <>
              {displayed}
              {active && !done && <span className="home-speech-cursor" aria-hidden="true" />}
            </>
          )}
    </p>
  )
}

function SpeakingOdinLogo({ speaking }: { speaking: boolean }) {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    ODIN_FRAMES.forEach((src) => {
      const img = new Image()
      img.src = src
    })
  }, [])

  useEffect(() => {
    if (!speaking) {
      setFrame(0)
      return
    }

    const id = setInterval(() => {
      setFrame((f) => (f + 1) % ODIN_FRAMES.length)
    }, FRAME_MS)

    return () => clearInterval(id)
  }, [speaking])

  return <img src={ODIN_FRAMES[frame]} alt="" className="home-logo" />
}

export default function HomeMode() {
  const setActiveTab = useStore((s) => s.setActiveTab)
  const { start } = useTutorial()
  const [typingActive, setTypingActive] = useState(false)
  const [speaking, setSpeaking] = useState(false)

  return (
    <div className="home-scroll">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="home-inner"
      >
        <motion.div
          className="home-odin"
          animate={{ y: [0, -10, 0] }}
          transition={{ duration: 4.5, repeat: Infinity, ease: 'easeInOut' }}
        >
          <div className="home-speech-bubble-wrap">
            <motion.div
              className="home-speech-bubble"
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{
                opacity: { delay: 0.3, duration: 0.5, ease: [0.25, 1, 0.5, 1] },
                scale: { delay: 0.3, duration: 0.5, ease: [0.25, 1, 0.5, 1] },
              }}
              onAnimationComplete={() => setTypingActive(true)}
            >
              <TypewriterText
                text={ODIN_QUOTE}
                segments={ODIN_SEGMENTS}
                active={typingActive}
                onStart={() => setSpeaking(true)}
                onComplete={() => setSpeaking(false)}
              />
            </motion.div>
          </div>
          <SpeakingOdinLogo speaking={speaking} />
        </motion.div>

        <h1 className="home-title">Odin</h1>
        <p className="home-sub">The best writing tool ever conceived.</p>

        <div className="home-actions">
          <button className="home-cta" onClick={() => setActiveTab('write')}>
            Begin composing
          </button>
          <div className="home-tutorial-wrap">
            <button className="home-cta home-cta-secondary home-cta-circle" onClick={() => start()}>
              Masterclass
            </button>
            <span className="home-recommended">Essential</span>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

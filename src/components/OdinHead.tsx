import { useEffect, useRef, useState } from 'react'
import odin1 from './Animation 1.png'
import odin2 from './Animation 2.png'
import odin3 from './Animation 3.png'

/**
 * Odin's animated face. Three hand-drawn frames — mouth closed (1),
 * half-open (2), wide-open (3) — are cycled 1→2→3→2→1 while `talking`
 * is true to give the illusion of speech. When idle it rests on frame 1.
 */
const FRAMES = [odin1, odin2, odin3]
// 1→2→3→2 loops cleanly into a continuous 1→2→3→2→1→2→3… mouth motion.
const TALK_CYCLE = [0, 1, 2, 1]

interface OdinHeadProps {
  /** Animate the mouth as if speaking. */
  talking?: boolean
  /** Pixel diameter of the circular face. */
  size?: number
  className?: string
  /** Speed of the mouth animation in ms per frame. */
  frameMs?: number
}

export default function OdinHead({
  talking = false,
  size = 96,
  className = '',
  frameMs = 120,
}: OdinHeadProps) {
  const [frame, setFrame] = useState(0)
  const stepRef = useRef(0)

  useEffect(() => {
    if (!talking) {
      stepRef.current = 0
      setFrame(0)
      return
    }
    const id = window.setInterval(() => {
      stepRef.current = (stepRef.current + 1) % TALK_CYCLE.length
      setFrame(TALK_CYCLE[stepRef.current])
    }, frameMs)
    return () => window.clearInterval(id)
  }, [talking, frameMs])

  return (
    <div
      className={`odin-head ${talking ? 'is-talking' : ''} ${className}`.trim()}
      style={{ width: size, height: size }}
    >
      <div className="odin-head-glow" aria-hidden="true" />
      {FRAMES.map((src, i) => (
        <img
          key={i}
          src={src}
          alt={i === 0 ? 'Odin' : ''}
          aria-hidden={i !== 0}
          className="odin-head-frame"
          style={{ opacity: frame === i ? 1 : 0 }}
          draggable={false}
        />
      ))}
    </div>
  )
}

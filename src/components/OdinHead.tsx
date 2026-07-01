import { useEffect, useState } from 'react'
import odin1 from './Animation 1.png'
import odin2 from './Animation 2.png'
import odin3 from './Animation 3.png'

/**
 * Odin's animated face. Three hand-drawn frames — mouth closed (1),
 * half-open (2), wide-open (3) — are cycled 1→2→3→2 while `talking`
 * is true to give the illusion of speech. When idle it rests on frame 1.
 *
 * Uses a single <img> with instant src swaps (same as the home screen) so
 * frames never blend and cause a colour flash.
 */
const FRAMES = [odin1, odin2, odin3, odin2]
const DEFAULT_FRAME_MS = 130

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
  frameMs = DEFAULT_FRAME_MS,
}: OdinHeadProps) {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    FRAMES.forEach((src) => {
      const img = new Image()
      img.src = src
    })
  }, [])

  useEffect(() => {
    if (!talking) {
      setFrame(0)
      return
    }

    const id = window.setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length)
    }, frameMs)

    return () => window.clearInterval(id)
  }, [talking, frameMs])

  return (
    <div
      className={`odin-head ${talking ? 'is-talking' : ''} ${className}`.trim()}
      style={{ width: size, height: size }}
    >
      <img
        src={FRAMES[frame]}
        alt="Odin"
        className="odin-head-frame"
        draggable={false}
      />
    </div>
  )
}

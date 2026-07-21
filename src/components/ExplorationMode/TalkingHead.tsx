import { useEffect, useState } from 'react'
import frame01 from '../../math/assets/talking-frames/frame-01.png'
import frame02 from '../../math/assets/talking-frames/frame-02.png'
import frame03 from '../../math/assets/talking-frames/frame-03.png'
import frame04 from '../../math/assets/talking-frames/frame-04.png'
import frame05 from '../../math/assets/talking-frames/frame-05.png'
import frame06 from '../../math/assets/talking-frames/frame-06.png'
import frame07 from '../../math/assets/talking-frames/frame-07.png'
import frame08 from '../../math/assets/talking-frames/frame-08.png'
import frame09 from '../../math/assets/talking-frames/frame-09.png'
import frame10 from '../../math/assets/talking-frames/frame-10.png'
import frame11 from '../../math/assets/talking-frames/frame-11.png'
import frame12 from '../../math/assets/talking-frames/frame-12.png'

/** 12 pre-centered 512×512 frames — mouth cycles, head stays fixed. */
const FRAMES = [
  frame01,
  frame02,
  frame03,
  frame04,
  frame05,
  frame06,
  frame07,
  frame08,
  frame09,
  frame10,
  frame11,
  frame12,
]

const FRAME_MS = 95

/** Animated Odin talking-head for the math tutor. */
export default function TalkingHead({
  talking = false,
  size = 64,
}: {
  talking?: boolean
  size?: number
}) {
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
    const iv = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length)
    }, FRAME_MS)
    return () => clearInterval(iv)
  }, [talking])

  return (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: '50%',
        overflow: 'hidden',
        position: 'relative',
        background: 'rgba(255,255,255,0.85)',
        boxShadow: talking
          ? '0 0 0 2px rgba(37,99,235,0.28), 0 3px 12px rgba(0,0,0,0.1)'
          : '0 2px 8px rgba(0,0,0,0.08)',
      }}
    >
      <img
        src={FRAMES[talking ? frame : 0]}
        alt=""
        draggable={false}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          objectPosition: 'center center',
          display: 'block',
          userSelect: 'none',
        }}
      />
    </div>
  )
}

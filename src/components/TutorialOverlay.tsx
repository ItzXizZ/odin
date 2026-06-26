import { useEffect, useState, type CSSProperties } from 'react'
import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useTutorial, type Placement } from '../lib/tutorial'

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

const POP_WIDTH = 330

export default function TutorialOverlay() {
  const { active, step, stepIndex, steps, next, prev, stop } = useTutorial()
  const [rect, setRect] = useState<Rect | null>(null)

  // Measure the target after the section has switched/rendered. Retry a few
  // times so animated/lazy elements (editor, panels) are caught.
  useEffect(() => {
    if (!active || !step) {
      setRect(null)
      return
    }
    let cancelled = false
    const measure = () => {
      if (cancelled) return
      const el = step.target
        ? (document.querySelector(step.target) as HTMLElement | null)
        : null
      if (el) {
        const r = el.getBoundingClientRect()
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
      } else {
        setRect(null)
      }
    }
    const timers = [80, 280, 560, 900].map((d) => window.setTimeout(measure, d))
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      cancelled = true
      timers.forEach((t) => window.clearTimeout(t))
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [active, step, stepIndex])

  // Keyboard shortcuts while the tour is open.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stop()
      else if (e.key === 'ArrowRight' || e.key === 'Enter') next()
      else if (e.key === 'ArrowLeft') prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, next, prev, stop])

  if (!active || !step) return null

  const pad = 8
  const spot: Rect | null = rect
    ? {
        top: rect.top - pad,
        left: rect.left - pad,
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
      }
    : null

  const popStyle = computePopup(spot, step.placement ?? 'bottom')
  const isLast = stepIndex === steps.length - 1
  const isFirst = stepIndex === 0

  return (
    <div className="tour-root">
      {spot ? (
        <motion.div
          className="tour-spot"
          initial={false}
          animate={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }}
          transition={{ type: 'spring', stiffness: 320, damping: 32 }}
        />
      ) : (
        <div className="tour-dim-full" />
      )}

      <motion.div
        key={step.id}
        className="tour-pop"
        style={popStyle}
        initial={{ opacity: 0, scale: 0.96, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18 }}
      >
        <button className="tour-close" onClick={stop} aria-label="Exit tour">
          <X size={14} />
        </button>
        <div className="tour-count">
          Step {stepIndex + 1} of {steps.length}
        </div>
        <h3 className="tour-title">{step.title}</h3>
        <p className="tour-body">{step.body}</p>
        <div className="tour-actions">
          <button className="tour-skip" onClick={stop}>
            Skip tour
          </button>
          <div className="tour-nav">
            {!isFirst && (
              <button className="tour-btn tour-btn-ghost" onClick={prev}>
                Back
              </button>
            )}
            <button className="tour-btn" onClick={next}>
              {isLast ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

/** Position the popup card next to the spotlight, clamped to the viewport. */
function computePopup(spot: Rect | null, placement: Placement): CSSProperties {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const gap = 16
  const clampLeft = (l: number) => Math.max(12, Math.min(l, vw - POP_WIDTH - 12))
  const clampTop = (t: number) => Math.max(12, Math.min(t, vh - 230))

  if (!spot || placement === 'center') {
    return {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: POP_WIDTH,
    }
  }

  switch (placement) {
    case 'top':
      return {
        position: 'fixed',
        width: POP_WIDTH,
        left: clampLeft(spot.left + spot.width / 2 - POP_WIDTH / 2),
        top: clampTop(spot.top - gap - 200),
      }
    case 'left':
      return {
        position: 'fixed',
        width: POP_WIDTH,
        left: clampLeft(spot.left - gap - POP_WIDTH),
        top: clampTop(spot.top + spot.height / 2 - 90),
      }
    case 'right':
      return {
        position: 'fixed',
        width: POP_WIDTH,
        left: clampLeft(spot.left + spot.width + gap),
        top: clampTop(spot.top + spot.height / 2 - 90),
      }
    case 'bottom':
    default:
      return {
        position: 'fixed',
        width: POP_WIDTH,
        left: clampLeft(spot.left + spot.width / 2 - POP_WIDTH / 2),
        top: clampTop(spot.top + spot.height + gap),
      }
  }
}

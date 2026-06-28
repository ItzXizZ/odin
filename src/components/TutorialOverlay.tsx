import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Loader2, Sparkles } from 'lucide-react'
import { useTutorial, INTEREST_FIELDS, type Placement } from '../lib/tutorial'
import OdinHead from './OdinHead'

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

const COACH_WIDTH = 460

/* ── A tiny typewriter so Odin's mouth has something to move for ── */
function useTypewriter(text: string, speed = 18) {
  const [shown, setShown] = useState('')
  useEffect(() => {
    setShown('')
    if (!text) return
    let i = 0
    const id = window.setInterval(() => {
      i++
      setShown(text.slice(0, i))
      if (i >= text.length) window.clearInterval(id)
    }, speed)
    return () => window.clearInterval(id)
  }, [text, speed])
  return { shown, done: shown.length >= text.length }
}

export default function TutorialOverlay() {
  const tut = useTutorial()
  if (!tut.active) return null
  return tut.phase === 'intro' ? <IntroModal /> : <CoachTour />
}

/* ============================================================
   INTRO: full-screen, blurred, glassy conversation
   ============================================================ */
function IntroModal() {
  const { field, suggestions, suggestionsLoading, chooseField, beginTour, stop } = useTutorial()
  const [screen, setScreen] = useState<'greet' | 'field'>('greet')
  const [custom, setCustom] = useState('')

  const greeting =
    "Hello there, I'm Odin. The most refined way in the world to research and write, built for those who expect nothing less than the very best."
  const askField = 'Tell me, which field will you be putting me to work on?'

  const line = screen === 'greet' ? greeting : askField
  const { shown, done } = useTypewriter(line)

  const submitCustom = () => {
    const v = custom.trim()
    if (!v) return
    chooseField(v)
  }

  return (
    <motion.div
      className="odin-intro-root"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        className="odin-intro-card"
        initial={{ opacity: 0, scale: 0.94, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 26 }}
      >
        <button className="odin-intro-close" onClick={stop} aria-label="Skip intro">
          <X size={18} />
        </button>

        <motion.div
          className="odin-intro-head"
          animate={{ y: [0, -6, 0] }}
          transition={{ duration: 3.4, repeat: Infinity, ease: 'easeInOut' }}
        >
          <OdinHead talking={!done} size={132} />
        </motion.div>

        <p className="odin-intro-say">
          {shown}
          {!done && <span className="odin-caret" />}
        </p>

        <AnimatePresence mode="wait">
          {screen === 'greet' ? (
            <motion.div
              key="greet"
              className="odin-intro-actions"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
            >
              <button className="odin-glass-btn primary" onClick={() => setScreen('field')}>
                Continue
              </button>
            </motion.div>
          ) : (
            <motion.div
              key="field"
              className="odin-intro-field"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
            >
              <div className="odin-intro-bigfield">
                <input
                  autoFocus
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitCustom()}
                  placeholder="Type a field or interest, then press Enter"
                  className="odin-intro-bigfield-input"
                />
              </div>

              <span className="odin-intro-hint">or pick one</span>

              <div className="odin-carousel">
                {INTEREST_FIELDS.map((f) => (
                  <button
                    key={f}
                    className={`odin-pill ${field === f && !custom ? 'selected' : ''}`}
                    onClick={() => {
                      setCustom('')
                      chooseField(f)
                    }}
                  >
                    {f}
                  </button>
                ))}
              </div>

              <AnimatePresence>
                {field && (
                  <motion.div
                    className="odin-intro-confirm"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                  >
                    <p className="odin-intro-confirm-text">
                      <Sparkles size={14} />
                      {suggestionsLoading
                        ? `Lining up some ${field} questions for you…`
                        : `Perfect. I've prepared ${suggestions.length || 'a few'} ${field} questions to explore.`}
                    </p>
                    <button className="odin-glass-btn primary" onClick={beginTour}>
                      Start the tutorial
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>

        <button className="odin-intro-skip" onClick={stop}>
          Skip, I'll explore on my own
        </button>
      </motion.div>
    </motion.div>
  )
}

/* ============================================================
   TOUR: flying glass coach + spotlight
   ============================================================ */
function CoachTour() {
  const {
    step,
    stepIndex,
    steps,
    suggestions,
    suggestionsLoading,
    canAdvance,
    next,
    prev,
    stop,
  } = useTutorial()
  const [rect, setRect] = useState<Rect | null>(null)
  const coachRef = useRef<HTMLDivElement>(null)
  const [coachH, setCoachH] = useState(300)

  // Track the coach's real rendered height so we can keep it fully clear of
  // its target (the bubble grows tall when it shows suggestion chips).
  useEffect(() => {
    const el = coachRef.current
    if (!el) return
    const update = () => setCoachH(el.offsetHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Continuously track the spotlight target every frame so the coach glides
  // along with it when a panel slides open/closed (e.g. the Sources drawer),
  // rather than snapping only at fixed intervals.
  useEffect(() => {
    if (!step) {
      setRect(null)
      return
    }
    let raf = 0
    let last: Rect | null = null
    let didInitialClear = false
    const near = (a: number, b: number) => Math.abs(a - b) < 0.5
    const tick = () => {
      const el = step.target
        ? (document.querySelector(step.target) as HTMLElement | null)
        : null
      if (el) {
        didInitialClear = false
        const r = el.getBoundingClientRect()
        const next = { top: r.top, left: r.left, width: r.width, height: r.height }
        if (
          !last ||
          !near(last.top, next.top) ||
          !near(last.left, next.left) ||
          !near(last.width, next.width) ||
          !near(last.height, next.height)
        ) {
          last = next
          setRect(next)
        }
      } else if (last !== null) {
        last = null
        setRect(null)
      } else if (!didInitialClear) {
        // Step has no target: drop any stale rect from the previous step so
        // Odin floats in his bottom-left home instead of hovering the old spot.
        didInitialClear = true
        setRect(null)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [step, stepIndex])

  // Keyboard shortcuts (tour only).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stop()
      else if ((e.key === 'ArrowRight' || e.key === 'Enter') && canAdvance) next()
      else if (e.key === 'ArrowLeft') prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canAdvance, next, prev, stop])

  const { shown, done } = useTypewriter(step?.say ?? '')

  const pad = 8
  const cappedHeight =
    rect && step?.maxHeight ? Math.min(rect.height, step.maxHeight) : rect?.height ?? 0
  const spot: Rect | null = rect
    ? {
        top: rect.top - pad,
        left: rect.left - pad,
        width: rect.width + pad * 2,
        height: cappedHeight + pad * 2,
      }
    : null

  const placement = step?.placement ?? 'bottom'
  const floatCoach = step?.floatCoach ?? false
  const coach = useMemo(
    () => computeCoach(floatCoach ? null : spot, placement, coachH),
    [floatCoach, spot, placement, coachH],
  )

  if (!step) return null

  const isLast = stepIndex === steps.length - 1
  const isFirst = stepIndex === 0
  const showNext = !step.hideNext
  const waiting = step.hideNext && !canAdvance

  // Resolve chips: either a static list or live AI suggestions.
  const chips = step.chipsSource === 'suggestions' ? suggestions : step.chips ?? []
  const chipsBusy = step.chipsSource === 'suggestions' && suggestionsLoading

  return (
    <div className="tour-root">
      {spot && (
        <motion.div
          className="tour-spot"
          initial={false}
          animate={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }}
          transition={{ type: 'spring', stiffness: 320, damping: 32 }}
        />
      )}

      <motion.div
        ref={coachRef}
        className="odin-coach"
        initial={false}
        animate={{ left: coach.left, top: coach.top }}
        transition={{ type: 'spring', stiffness: 220, damping: 26 }}
        style={{ position: 'fixed', width: COACH_WIDTH }}
      >
        <motion.div
          className="odin-coach-avatar"
          animate={{ y: [0, -5, 0], rotate: [0, -2, 2, 0] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
        >
          <OdinHead talking={!done} size={92} />
        </motion.div>

        <div className="odin-coach-bubble">
          <button className="tour-close" onClick={stop} aria-label="Exit tour">
            <X size={14} />
          </button>

          <div className="odin-coach-meta">
            <span className="odin-coach-name">Odin</span>
            <span className="odin-coach-step">
              Step {stepIndex + 1} of {steps.length}
            </span>
          </div>

          <p className="odin-coach-say">
            {shown}
            {!done && <span className="odin-caret" />}
          </p>

          {(chips.length > 0 || chipsBusy) && (
            <div className="odin-coach-chips">
              {chipsBusy ? (
                <span className="odin-coach-chips-loading">
                  <Loader2 size={12} className="animate-spin" />
                  Tailoring questions to your field…
                </span>
              ) : (
                chips.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    className="odin-coach-chip"
                    onClick={() => step.onChip?.(chip)}
                  >
                    {chip}
                  </button>
                ))
              )}
            </div>
          )}

          <AnimatePresence>
            {waiting && (
              <motion.div
                className="odin-coach-wait"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <Loader2 size={12} className="animate-spin" />
                {step.waitText ?? 'Waiting for you…'}
              </motion.div>
            )}
          </AnimatePresence>

          <div className="odin-coach-actions">
            {(step.cta || showNext) && (
              <div className="coach-cta-row">
                {step.cta && (
                  <button
                    className={step.cta.advance === false ? 'tour-btn tour-btn-ghost' : 'tour-btn'}
                    onClick={() => {
                      step.cta?.run?.()
                      if (step.cta?.advance !== false) next()
                    }}
                  >
                    {step.cta.label}
                  </button>
                )}

                {showNext && (!step.cta || step.cta.advance === false) && (
                  <button
                    className="tour-btn"
                    onClick={next}
                    disabled={!canAdvance && Boolean(step.advanceWhen) && !step.nextLabel}
                  >
                    {isLast ? 'Finish' : step.nextLabel ?? 'Next'}
                  </button>
                )}
              </div>
            )}

            <div className="coach-meta-row">
              <button className="tour-skip" onClick={stop}>
                Skip tour
              </button>
              {!isFirst && (
                <button className="tour-link" onClick={prev}>
                  Back
                </button>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

interface CoachPos {
  left: number
  top: number
}

/** Position the coach near the spotlight, clamped to the viewport. */
function computeCoach(spot: Rect | null, placement: Placement, coachH = 300): CoachPos {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const gap = 26
  const clampLeft = (l: number) => Math.max(16, Math.min(l, vw - COACH_WIDTH - 16))
  const clampTop = (t: number) => Math.max(16, Math.min(t, vh - coachH - 16))

  // No target: float Odin in the bottom-left corner like a companion.
  if (!spot) {
    return { left: 28, top: Math.max(16, vh - coachH - 24) }
  }

  if (placement === 'center') {
    return {
      left: clampLeft(vw / 2 - COACH_WIDTH / 2),
      top: clampTop(vh / 2 - coachH / 2),
    }
  }

  switch (placement) {
    case 'top':
      return {
        left: clampLeft(spot.left + spot.width / 2 - COACH_WIDTH / 2),
        top: clampTop(spot.top - gap - coachH),
      }
    case 'left':
      return {
        left: clampLeft(spot.left - gap - COACH_WIDTH),
        top: clampTop(spot.top + spot.height / 2 - coachH / 2),
      }
    case 'right':
      return {
        left: clampLeft(spot.left + spot.width + gap),
        top: clampTop(spot.top + spot.height / 2 - coachH / 2),
      }
    case 'bottom':
    default:
      return {
        left: clampLeft(spot.left + spot.width / 2 - COACH_WIDTH / 2),
        top: clampTop(spot.top + spot.height + gap),
      }
  }
}


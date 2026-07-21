import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { useStore } from '../store/useStore'
import OdinHead from '../components/OdinHead'
import BlitzReveal, { type RevealResult } from './BlitzReveal'
import { randomBot } from './bots'
import { dailyNumber, dayKey } from './prompts'
import {
  fetchChallenge,
  findMatch,
  generateBotArgument,
  getArenaName,
  judgeDuel,
  pollRoom,
  reportProgress,
  revealChallenge,
  setArenaName,
  stancesFor,
  submitDaily,
} from '../lib/arena'
import type { ArenaPrompt, BotPersona, Side } from './types'

const ROUND_SECONDS = 300 // 5 minutes
const WORD_CAP = 150

export type PlayMode = 'quick' | 'daily' | 'challenge'

interface OpponentPlan {
  isBot: boolean
  name: string
  id?: string
  persona?: BotPersona
  /** For bots: full pre-generated text revealed progressively. */
  fullText?: string
  /** Match room id for human duels. */
  matchId?: string
  /** Challenger's fixed text (challenge mode). */
  fixedText?: string
}

type Phase = 'setup' | 'matching' | 'writing' | 'judging' | 'reveal' | 'error'

function wordCount(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}
function truncateWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/)
  return words.length <= max ? text.trim() : words.slice(0, max).join(' ')
}

export default function PlayFlow({
  prompt,
  mode,
  challengeId,
  onHome,
}: {
  prompt: ArenaPrompt
  mode: PlayMode
  challengeId?: string
  onHome: () => void
}) {
  const apiKey = useStore((s) => s.apiKey)

  const [phase, setPhase] = useState<Phase>('setup')
  const [error, setError] = useState('')
  const [name, setName] = useState(getArenaName())
  const [side, setSide] = useState<Side>(() => (Math.random() < 0.5 ? 'A' : 'B'))
  const [opponent, setOpponent] = useState<OpponentPlan | null>(null)
  const [text, setText] = useState('')
  const [secondsLeft, setSecondsLeft] = useState(ROUND_SECONDS)
  const [startAt, setStartAt] = useState(0)
  const [oppProgress, setOppProgress] = useState(0)
  const [oppDone, setOppDone] = useState(false)
  const [result, setResult] = useState<RevealResult | null>(null)

  // Challenge metadata (topic + challenger stance) loaded up front.
  const [challengeInfo, setChallengeInfo] = useState<{
    stance: string
    challengerName: string
  } | null>(null)

  const stances = useMemo(() => stancesFor(prompt, side), [prompt, side])
  const textRef = useRef(text)
  textRef.current = text

  // For challenge mode, load info + lock the friend to the opposite stance.
  useEffect(() => {
    if (mode !== 'challenge' || !challengeId) return
    let cancelled = false
    void (async () => {
      try {
        const info = await fetchChallenge(challengeId)
        if (cancelled) return
        // Friend defends the opposite of the challenger.
        const friendSide: Side = info.challengerStance === prompt.stanceA ? 'B' : 'A'
        setSide(friendSide)
        setChallengeInfo({ stance: info.challengerStance, challengerName: info.challengerName })
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load challenge')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mode, challengeId, prompt])

  // ── Start the round ──
  const beginWriting = useCallback(
    (plan: OpponentPlan) => {
      setOpponent(plan)
      setStartAt(Date.now())
      setSecondsLeft(ROUND_SECONDS)
      setPhase('writing')
    },
    [],
  )

  const startRound = useCallback(async () => {
    if (name.trim()) setArenaName(name.trim())
    setError('')

    // Challenge mode: opponent is the fixed challenger; no matchmaking.
    if (mode === 'challenge' && challengeId) {
      beginWriting({
        isBot: false,
        name: challengeInfo?.challengerName || 'Challenger',
        fixedText: 'pending',
        matchId: undefined,
      })
      return
    }

    // Daily mode: always a sparring bot.
    if (mode === 'daily') {
      startBotRound()
      return
    }

    // Quick mode: briefly look for a human, else fall back to a bot.
    setPhase('matching')
    try {
      const match = await findMatch(prompt.id)
      if (match.matched && match.matchId && match.opponent) {
        // The server assigned us a physical side; honour it.
        if (match.side) setSide(match.side)
        beginWriting({
          isBot: false,
          name: match.opponent.name,
          id: match.opponent.id,
          matchId: match.matchId,
        })
        return
      }
    } catch {
      /* fall through to bot */
    }
    startBotRound()
  }, [mode, challengeId, challengeInfo, name, prompt.id, beginWriting])

  const startBotRound = useCallback(async () => {
    const persona = randomBot()
    setPhase('matching')
    setOpponent({ isBot: true, name: persona.name, persona })
    try {
      const oppStance = stancesFor(prompt, side).opponent
      const fullText = await generateBotArgument(prompt.topic, oppStance, persona, apiKey)
      beginWriting({ isBot: true, name: persona.name, persona, fullText })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sparring partner failed to show up')
      setPhase('error')
    }
  }, [apiKey, prompt, side, beginWriting])

  // ── Countdown timer ──
  useEffect(() => {
    if (phase !== 'writing') return
    const id = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startAt) / 1000)
      const left = Math.max(0, ROUND_SECONDS - elapsed)
      setSecondsLeft(left)
      if (left <= 0) {
        clearInterval(id)
        void submitRound()
      }
    }, 250)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, startAt])

  // ── Live opponent feed: bot typing sim ──
  const botRevealCount = useMemo(() => {
    if (!opponent?.isBot || !opponent.fullText || !opponent.persona) return 0
    const elapsed = (ROUND_SECONDS - secondsLeft) // seconds
    const words = opponent.fullText.split(/\s+/)
    // Bot "types" at its wpm, with a small head start delay.
    const typed = Math.floor(((elapsed - 3) / 60) * opponent.persona.wpm)
    return Math.max(0, Math.min(words.length, typed))
  }, [opponent, secondsLeft])

  // ── Live opponent feed: human progress polling ──
  useEffect(() => {
    if (phase !== 'writing' || !opponent || opponent.isBot || !opponent.matchId) return
    const id = setInterval(async () => {
      try {
        const state = await pollRoom(opponent.matchId!)
        setOppProgress(state.opponentProgress)
        setOppDone(state.opponentDone)
      } catch {
        /* ignore transient */
      }
    }, 2500)
    return () => clearInterval(id)
  }, [phase, opponent])

  // Push our progress to the room so the human opponent sees our word count.
  useEffect(() => {
    if (phase !== 'writing' || !opponent || opponent.isBot || !opponent.matchId) return
    const id = setInterval(() => {
      void reportProgress(opponent.matchId!, { progress: wordCount(textRef.current) }).catch(() => {})
    }, 3000)
    return () => clearInterval(id)
  }, [phase, opponent])

  // ── Submit + judge ──
  const submittedRef = useRef(false)
  const submitRound = useCallback(async () => {
    if (submittedRef.current) return
    submittedRef.current = true
    setPhase('judging')

    const playerText = truncateWords(textRef.current, WORD_CAP) || '(no argument submitted)'

    try {
      let opponentText = ''
      let opponentName = opponent?.name || 'Opponent'
      let opponentIsBot = opponent?.isBot ?? true

      if (opponent?.isBot) {
        opponentText = opponent.fullText || ''
      } else if (mode === 'challenge' && challengeId) {
        const revealed = await revealChallenge(challengeId)
        opponentText = revealed.challenger.text
        opponentName = revealed.challenger.name
        opponentIsBot = false
      } else if (opponent?.matchId) {
        // Human duel: report done, then wait for the opponent to finish.
        let state = await reportProgress(opponent.matchId, {
          progress: wordCount(playerText),
          done: true,
          text: playerText,
          stance: stances.player,
        })
        const deadline = Date.now() + 70_000
        while (!state.bothDone && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2500))
          state = await pollRoom(opponent.matchId)
        }
        if (state.opponentText) {
          opponentText = state.opponentText
        } else {
          // Opponent forfeited: stand in a sparring bot so Odin can still judge.
          const persona = randomBot()
          opponentText = await generateBotArgument(prompt.topic, stances.opponent, persona, apiKey)
          opponentName = `${opponentName} (forfeit)`
          opponentIsBot = true
        }
      }

      const judged = await judgeDuel({
        topic: prompt.topic,
        promptId: prompt.id,
        stancePlayer: stances.player,
        playerText,
        stanceOpponent: stances.opponent,
        opponentText,
        opponentName,
        opponentIsBot,
        opponentId: opponent?.id,
        publish: mode !== 'challenge', // publish quick/daily duels to the gallery
        apiKey,
      })

      const reveal: RevealResult = {
        topic: prompt.topic,
        promptId: prompt.id,
        playerName: name.trim() || 'You',
        opponentName,
        playerStance: stances.player,
        opponentStance: stances.opponent,
        playerText,
        opponentText,
        verdict: judged.verdict,
        elo: judged.elo,
        playerWon: judged.playerWon,
        archetype: judged.archetype,
      }

      // Daily: record score on today's board.
      if (mode === 'daily') {
        try {
          const rank = await submitDaily({
            day: dayKey(),
            promptId: prompt.id,
            score: judged.verdict.a.score,
            roast: judged.verdict.roast,
            stance: stances.player,
          })
          reveal.blitzNumber = dailyNumber()
          reveal.dailyRank = rank.rank
          reveal.dailyTotal = rank.total
          reveal.dailyPercentile = rank.percentile
        } catch {
          reveal.blitzNumber = dailyNumber()
        }
      }

      setResult(reveal)
      setPhase('reveal')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Odin could not judge the round')
      setPhase('error')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opponent, mode, challengeId, prompt, stances, name, apiKey])

  const resetForRematch = useCallback(() => {
    submittedRef.current = false
    setResult(null)
    setText('')
    setOpponent(null)
    setOppProgress(0)
    setOppDone(false)
    setSide(Math.random() < 0.5 ? 'A' : 'B')
    setPhase('setup')
  }, [])

  // ── Render ──
  if (phase === 'reveal' && result) {
    return <BlitzReveal result={result} onRematch={resetForRematch} onHome={onHome} />
  }

  if (phase === 'error') {
    return (
      <div className="arena-wrap">
        <button className="arena-back" onClick={onHome}>
          ← Arena home
        </button>
        <div className="arena-card" style={{ padding: '2rem', textAlign: 'center' }}>
          <p className="arena-error" style={{ fontSize: '1rem' }}>
            {error}
          </p>
          <button className="arena-cta ghost" style={{ marginTop: 16 }} onClick={resetForRematch}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'matching') {
    return (
      <div className="arena-wrap">
        <div className="arena-card arena-matching">
          <div className="arena-spinner" />
          <p style={{ fontWeight: 600 }}>
            {opponent?.isBot ? `${opponent.name} is warming up…` : 'Finding an opponent…'}
          </p>
          <p className="arena-note">
            {opponent?.isBot
              ? 'Your sparring partner is preparing an argument.'
              : 'Matching you with a live writer (a sparring partner steps in if none is free).'}
          </p>
        </div>
      </div>
    )
  }

  if (phase === 'judging') {
    return (
      <div className="arena-wrap">
        <div className="arena-card arena-matching">
          <OdinHead talking size={64} />
          <p style={{ fontWeight: 600, marginTop: 8 }}>Odin is reading both arguments…</p>
        </div>
      </div>
    )
  }

  // ── Setup screen ──
  if (phase === 'setup') {
    return (
      <div className="arena-wrap">
        <button className="arena-back" onClick={onHome}>
          ← Arena home
        </button>
        <div className="arena-card arena-topic-card">
          <p className="arena-eyebrow">
            {mode === 'daily'
              ? `Daily Blitz #${dailyNumber()}`
              : mode === 'challenge'
                ? 'Challenge'
                : 'Quick Play'}{' '}
            · {prompt.tag}
          </p>
          <h1 className="arena-topic">{prompt.topic}</h1>
          <p className="arena-note" style={{ marginTop: 10 }}>
            5 minutes · {WORD_CAP} words max · Odin judges
          </p>
        </div>

        <div className="arena-field" style={{ maxWidth: 320, margin: '1.25rem auto 0' }}>
          <label className="arena-label">Your arena name</label>
          <input
            className="arena-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Pick a name for the leaderboard"
            maxLength={40}
          />
        </div>

        <div style={{ marginTop: 20 }}>
          <p className="arena-note" style={{ textAlign: 'center', marginBottom: 10 }}>
            {mode === 'challenge'
              ? 'You must defend the opposite side. No peeking — their argument stays hidden until you submit.'
              : 'You have been randomly assigned a side. Defend it well.'}
          </p>
          <div className="arena-stance-pick" style={{ maxWidth: 640, margin: '0 auto' }}>
            <div
              className="arena-stance-btn"
              style={{ borderColor: 'rgba(96,132,255,0.6)', cursor: 'default' }}
            >
              <span className="arena-stance-side">You defend</span>
              {stances.player}
            </div>
            <div
              className="arena-stance-btn"
              style={{ opacity: 0.6, cursor: 'default' }}
            >
              <span className="arena-stance-side">Opponent defends</span>
              {stances.opponent}
            </div>
          </div>
          {mode !== 'challenge' && (
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <button
                className="arena-btn"
                onClick={() => setSide((s) => (s === 'A' ? 'B' : 'A'))}
              >
                🔁 Switch sides
              </button>
            </div>
          )}
        </div>

        <div className="arena-round-actions" style={{ marginTop: 24 }}>
          <button className="arena-cta" onClick={startRound}>
            ⚔ Start 5-minute round
          </button>
        </div>
      </div>
    )
  }

  // ── Writing screen ──
  const wc = wordCount(text)
  const over = wc > WORD_CAP
  const mins = Math.floor(secondsLeft / 60)
  const secs = secondsLeft % 60
  const danger = secondsLeft <= 30

  const oppWords = opponent?.isBot && opponent.fullText ? opponent.fullText.split(/\s+/) : []
  const oppShown = oppWords.slice(0, botRevealCount)
  const oppTailStart = Math.max(0, oppShown.length - 8)

  return (
    <div className="arena-wrap">
      <div className="arena-round">
        <div className="arena-card arena-topic-card">
          <p className="arena-eyebrow">{prompt.topic}</p>
          <div className={`arena-timer ${danger ? 'danger' : ''}`}>
            {mins}:{String(secs).padStart(2, '0')}
          </div>
        </div>

        <div className="arena-battlefield">
          {/* Player side */}
          <div className="arena-card arena-side">
            <div className="arena-side-head">
              <span className="arena-side-who">✍️ {name.trim() || 'You'}</span>
              <span className="arena-badge">You defend</span>
            </div>
            <div className="arena-side-stance">{stances.player}</div>
            <textarea
              className="arena-editor"
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Make your case. Be sharp, be bold, be funny…"
            />
            <div className={`arena-wordcount ${over ? 'over' : ''}`}>
              {wc}/{WORD_CAP} words{over ? ' — over the limit (extra words ignored)' : ''}
            </div>
          </div>

          {/* Opponent side */}
          <div className="arena-card arena-side">
            <div className="arena-side-head">
              <span className="arena-side-who">
                {opponent?.persona?.glyph ?? '🎭'} {opponent?.name ?? 'Opponent'}
              </span>
              <span className="arena-badge">Opponent</span>
            </div>
            <div className="arena-side-stance">{stances.opponent}</div>

            {opponent?.isBot ? (
              <div className="arena-opp-feed">
                {oppShown.map((w, i) => (
                  <span key={i} className={i >= oppTailStart ? 'arena-opp-tail' : undefined}>
                    {w}{' '}
                  </span>
                ))}
                {botRevealCount < oppWords.length && <span className="arena-typing-dot" />}
              </div>
            ) : mode === 'challenge' ? (
              <div className="arena-opp-feed">
                <em>{opponent?.name} already locked in their argument. Hidden until you submit.</em>
              </div>
            ) : (
              <div className="arena-opp-feed">
                <em>Live opponent. You can see their pace, not their words.</em>
              </div>
            )}

            <div className="arena-opp-status">
              {opponent?.isBot ? (
                <>
                  <span className="arena-typing-dot" style={{ height: '0.8em' }} />
                  {opponent.name} is writing… {oppShown.length} words
                </>
              ) : mode === 'challenge' ? (
                <>Argument locked ✓</>
              ) : (
                <>
                  {oppDone ? 'Opponent submitted ✓' : `Opponent: ${oppProgress} words`}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="arena-round-actions">
          <motion.button
            className="arena-cta"
            onClick={() => void submitRound()}
            whileTap={{ scale: 0.97 }}
          >
            Submit argument →
          </motion.button>
        </div>
      </div>
    </div>
  )
}

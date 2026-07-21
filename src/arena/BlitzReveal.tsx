import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import OdinHead from '../components/OdinHead'
import ShareCard from './ShareCard'
import {
  createChallenge,
  dailyShareString,
  duelShareString,
  getArenaName,
} from '../lib/arena'
import type { EloState, Verdict } from './types'

export interface RevealResult {
  topic: string
  promptId?: string
  playerName: string
  opponentName: string
  playerStance: string
  opponentStance: string
  playerText: string
  opponentText: string
  verdict: Verdict
  elo: EloState
  playerWon: boolean
  archetype: string | null
  /** Daily Blitz number, when this was a daily round. */
  blitzNumber?: number
  /** Percentile on today's board, when this was a daily round. */
  dailyPercentile?: number
  dailyRank?: number
  dailyTotal?: number
}

const ARENA_URL = 'https://odinwrite.com/arena'

export default function BlitzReveal({
  result,
  onRematch,
  onHome,
}: {
  result: RevealResult
  onRematch: () => void
  onHome: () => void
}) {
  const [stage, setStage] = useState<0 | 1 | 2>(0)
  const [challengeUrl, setChallengeUrl] = useState<string | null>(null)
  const [challengeBusy, setChallengeBusy] = useState(false)

  // Dramatic 3-beat reveal: texts land, Odin deliberates, verdict drops.
  useEffect(() => {
    const t1 = setTimeout(() => setStage(1), 900)
    const t2 = setTimeout(() => setStage(2), 2200)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [])

  const { verdict, playerWon } = result
  const player = verdict.a
  const opponent = verdict.b

  const shareString =
    result.blitzNumber != null
      ? dailyShareString({
          blitzNumber: result.blitzNumber,
          percentile: result.dailyPercentile ?? 50,
          stance: result.playerStance,
          roast: verdict.roast,
          url: ARENA_URL,
        })
      : duelShareString({
          topic: result.topic,
          won: playerWon,
          opponentName: result.opponentName,
          roast: verdict.roast,
          rating: result.elo.rating,
          url: ARENA_URL,
        })

  async function handleChallenge() {
    setChallengeBusy(true)
    try {
      const { id } = await createChallenge({
        topic: result.topic,
        promptId: result.promptId,
        stance: result.playerStance,
        stanceOpponent: result.opponentStance,
        text: result.playerText,
        score: player.score,
        roast: verdict.roast,
      })
      const url = `${window.location.origin}/arena/challenge/${id}`
      setChallengeUrl(url)
      try {
        await navigator.clipboard.writeText(
          `Beat my take on "${result.topic}" — Odin scored me ${player.score}. Your turn (blind): ${url}`,
        )
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    } finally {
      setChallengeBusy(false)
    }
  }

  return (
    <div className="arena-wrap">
      <div className="arena-reveal">
        {/* Odin deliberating → verdict */}
        <motion.div
          className="arena-card arena-verdict-card"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <OdinHead talking={stage < 2} size={72} />
          </div>

          {stage < 2 ? (
            <p className="arena-verdict-text" style={{ marginTop: 12 }}>
              {stage === 0 ? 'The arguments are in.' : 'Odin deliberates.'}
              <span className="arena-typing-dot" />
            </p>
          ) : (
            <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}>
              <div className={`arena-winner-banner ${playerWon ? 'win' : 'lose'}`}>
                {playerWon ? 'Victory' : 'Defeat'}
              </div>
              <p className="arena-verdict-text">{verdict.verdict}</p>
              <p className="arena-roast">{verdict.roast}</p>
              {result.blitzNumber != null && result.dailyRank != null && (
                <p className="arena-note" style={{ marginTop: 12 }}>
                  Daily Blitz #{result.blitzNumber}: ranked <strong>#{result.dailyRank}</strong> of{' '}
                  {result.dailyTotal} today (top {100 - (result.dailyPercentile ?? 0)}%).
                </p>
              )}
              {result.archetype && (
                <div className="arena-archetype" style={{ marginTop: 14 }}>
                  🏷 Odin says you fight like {result.archetype}
                </div>
              )}
            </motion.div>
          )}
        </motion.div>

        {stage === 2 && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            {/* Scorecards */}
            <div className="arena-scorecards">
              <Scorecard
                name={result.playerName}
                score={player}
                isWinner={playerWon}
                you
              />
              <Scorecard
                name={result.opponentName}
                score={opponent}
                isWinner={!playerWon}
              />
            </div>

            {/* ELO strip */}
            <div className="arena-stats">
              <div className="arena-stat">
                <div className="arena-stat-val">{result.elo.rating}</div>
                <div className="arena-stat-label">Rating</div>
              </div>
              <div className="arena-stat">
                <div className="arena-stat-val">
                  {result.elo.wins}-{result.elo.losses}
                </div>
                <div className="arena-stat-label">Record</div>
              </div>
              <div className="arena-stat">
                <div className="arena-stat-val">
                  {result.elo.streak > 0 ? `W${result.elo.streak}` : `L${Math.abs(result.elo.streak)}`}
                </div>
                <div className="arena-stat-label">Streak</div>
              </div>
            </div>

            {/* Both texts revealed */}
            <div className="arena-reveal-texts" style={{ marginTop: 20 }}>
              <div className="arena-card arena-reveal-text">
                <div className="arena-badge" style={{ marginBottom: 8 }}>
                  {result.playerName} · {result.playerStance}
                </div>
                {result.playerText}
              </div>
              <div className="arena-card arena-reveal-text">
                <div className="arena-badge" style={{ marginBottom: 8 }}>
                  {result.opponentName} · {result.opponentStance}
                </div>
                {result.opponentText}
              </div>
            </div>

            {/* Share */}
            <div className="arena-card" style={{ padding: '1.4rem', marginTop: 20 }}>
              <ShareCard
                data={{
                  topic: result.topic,
                  playerName: result.playerName,
                  opponentName: result.opponentName,
                  playerScore: player.score,
                  opponentScore: opponent.score,
                  won: playerWon,
                  roast: verdict.roast,
                  rating: result.elo.rating,
                  footer:
                    result.blitzNumber != null
                      ? `Daily Blitz #${result.blitzNumber} · odinwrite.com/arena`
                      : 'odinwrite.com/arena',
                }}
                shareString={shareString}
              />
            </div>

            {/* Actions */}
            <div className="arena-round-actions" style={{ marginTop: 20 }}>
              <button className="arena-cta" onClick={onRematch}>
                Rematch
              </button>
              <button className="arena-btn" onClick={handleChallenge} disabled={challengeBusy}>
                {challengeUrl
                  ? 'Challenge link copied!'
                  : challengeBusy
                    ? 'Creating…'
                    : 'Challenge a friend'}
              </button>
              <button className="arena-btn" onClick={onHome}>
                Arena home
              </button>
            </div>
            {challengeUrl && (
              <p className="arena-note" style={{ textAlign: 'center', marginTop: 10 }}>
                Send this: they write blind, then see how they stacked up.{' '}
                <code style={{ fontSize: '0.8rem' }}>{challengeUrl}</code>
              </p>
            )}
          </motion.div>
        )}
      </div>
    </div>
  )
}

function Scorecard({
  name,
  score,
  isWinner,
  you,
}: {
  name: string
  score: Verdict['a']
  isWinner: boolean
  you?: boolean
}) {
  const dims: { label: string; val: number }[] = [
    { label: 'Persuasion', val: score.persuasion },
    { label: 'Wit', val: score.wit },
    { label: 'Clarity', val: score.clarity },
    { label: 'Boldness', val: score.boldness },
  ]
  return (
    <div className={`arena-card arena-scorecard${isWinner ? ' winner' : ''}`}>
      <div className="arena-score-top">
        <span className="arena-score-name">
          {name}
          {you ? ' (you)' : ''}
          {isWinner ? '  🏆' : ''}
        </span>
        <span className="arena-score-big">{score.score}</span>
      </div>
      <div className="arena-dims">
        {dims.map((d) => (
          <div className="arena-dim" key={d.label}>
            <span>{d.label}</span>
            <span className="arena-dim-bar">
              <span className="arena-dim-fill" style={{ width: `${(d.val / 10) * 100}%` }} />
            </span>
            <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{d.val}</span>
          </div>
        ))}
      </div>
      {score.tip && <p className="arena-tip">{score.tip}</p>}
    </div>
  )
}

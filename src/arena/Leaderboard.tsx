import { useEffect, useState } from 'react'
import { fetchDailyLeaderboard, fetchEloLeaderboard, getArenaName } from '../lib/arena'
import { dailyNumber } from './prompts'
import type { LeaderboardDailyEntry, LeaderboardEloEntry } from './types'

export default function Leaderboard() {
  const [tab, setTab] = useState<'daily' | 'elo'>('daily')
  const [daily, setDaily] = useState<LeaderboardDailyEntry[]>([])
  const [elo, setElo] = useState<LeaderboardEloEntry[]>([])
  const [loading, setLoading] = useState(true)
  const myName = getArenaName()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        if (tab === 'daily') {
          const data = await fetchDailyLeaderboard()
          if (!cancelled) setDaily(data.entries)
        } else {
          const data = await fetchEloLeaderboard()
          if (!cancelled) setElo(data.entries)
        }
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tab])

  return (
    <div className="arena-wrap">
      <h1 className="arena-section-title">Leaderboards</h1>
      <p className="arena-note" style={{ marginBottom: 16 }}>
        The ELO ladder is the season. The Daily board resets every day — today is Blitz #
        {dailyNumber()}.
      </p>

      <div className="arena-tabs">
        <button className={tab === 'daily' ? 'active' : ''} onClick={() => setTab('daily')}>
          Daily Blitz
        </button>
        <button className={tab === 'elo' ? 'active' : ''} onClick={() => setTab('elo')}>
          ELO Ladder
        </button>
      </div>

      {loading ? (
        <p className="arena-empty">Loading…</p>
      ) : tab === 'daily' ? (
        daily.length === 0 ? (
          <p className="arena-empty">No one has played today's Blitz yet. Be the first.</p>
        ) : (
          <ul className="arena-list">
            {daily.map((e) => (
              <li
                key={e.rank}
                className={`arena-row${e.rank === 1 ? ' first' : ''}${
                  e.name === myName ? ' me' : ''
                }`}
              >
                <span className="arena-rank">{e.rank}</span>
                <span style={{ minWidth: 0 }}>
                  <div className="arena-row-name">{e.name}</div>
                  {e.roast && <div className="arena-row-sub">“{e.roast}”</div>}
                </span>
                <span className="arena-row-score">{e.score}</span>
              </li>
            ))}
          </ul>
        )
      ) : elo.length === 0 ? (
        <p className="arena-empty">No ranked battles yet. Win a duel to enter the ladder.</p>
      ) : (
        <ul className="arena-list">
          {elo.map((e) => (
            <li
              key={e.rank}
              className={`arena-row${e.rank === 1 ? ' first' : ''}${e.name === myName ? ' me' : ''}`}
            >
              <span className="arena-rank">{e.rank}</span>
              <span style={{ minWidth: 0 }}>
                <div className="arena-row-name">{e.name}</div>
                <div className="arena-row-sub">
                  {e.wins}W {e.losses}L
                  {e.streak > 1 ? ` · 🔥 ${e.streak} streak` : ''}
                </div>
              </span>
              <span className="arena-row-score">{e.rating}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

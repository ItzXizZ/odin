import { useEffect, useState } from 'react'
import { fetchGallery, voteDuel } from '../lib/arena'
import type { GalleryDuel, Side } from './types'

export default function Gallery() {
  const [duels, setDuels] = useState<GalleryDuel[]>([])
  const [loading, setLoading] = useState(true)
  const [voted, setVoted] = useState<Record<string, Side>>({})

  useEffect(() => {
    let cancelled = false
    void fetchGallery()
      .then((d) => {
        if (!cancelled) setDuels(d.duels)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleVote(duel: GalleryDuel, side: Side) {
    if (voted[duel.id]) return
    setVoted((v) => ({ ...v, [duel.id]: side }))
    try {
      const res = await voteDuel(duel.id, side)
      setDuels((prev) =>
        prev.map((d) => (d.id === duel.id ? { ...d, votesA: res.votesA, votesB: res.votesB } : d)),
      )
    } catch {
      /* ignore */
    }
  }

  if (loading) return <div className="arena-wrap"><p className="arena-empty">Loading duels…</p></div>

  return (
    <div className="arena-wrap">
      <h1 className="arena-section-title">The Gallery</h1>
      <p className="arena-note" style={{ marginBottom: 18 }}>
        Real battles, judged by Odin. Read both sides and vote for who you think won. See if the
        crowd agrees with Odin.
      </p>

      {duels.length === 0 ? (
        <p className="arena-empty">No public duels yet. Play a round to fill the gallery.</p>
      ) : (
        <div className="arena-gallery">
          {duels.map((d) => {
            const totalVotes = d.votesA + d.votesB
            const myVote = voted[d.id]
            return (
              <div key={d.id} className="arena-card arena-duel">
                <p className="arena-duel-topic">{d.topic}</p>
                <div className="arena-duel-sides">
                  {(['A', 'B'] as Side[]).map((side) => {
                    const f = side === 'A' ? d.a : d.b
                    const votes = side === 'A' ? d.votesA : d.votesB
                    const pct = totalVotes ? Math.round((votes / totalVotes) * 100) : 0
                    return (
                      <div
                        key={side}
                        className={`arena-duel-side${d.winner === side ? ' odin-pick' : ''}`}
                        onClick={() => handleVote(d, side)}
                      >
                        <div className="arena-duel-side-name">
                          <span>
                            {f.isBot ? '🤖 ' : ''}
                            {f.name}
                          </span>
                          {d.winner === side && <span className="arena-vote-tag">ODIN'S PICK</span>}
                        </div>
                        <div className="arena-badge" style={{ marginBottom: 6 }}>
                          {f.stance}
                        </div>
                        <div className="arena-duel-side-text">{f.text}</div>
                        {(myVote || totalVotes > 0) && (
                          <div className="arena-row-sub" style={{ marginTop: 8, fontStyle: 'normal' }}>
                            {pct}% of crowd{myVote === side ? ' · your pick' : ''}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                {d.roast && <p className="arena-duel-verdict">Odin: “{d.roast}”</p>}
                {!myVote && (
                  <p className="arena-note" style={{ marginTop: 8 }}>
                    Tap a side to vote.
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

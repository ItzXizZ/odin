import { useEffect, useState } from 'react'
import { createPrompt, fetchCommunityPrompts } from '../lib/arena'
import type { ArenaPrompt } from './types'

export default function CreatePrompt({ onPlay }: { onPlay: (prompt: ArenaPrompt) => void }) {
  const [topic, setTopic] = useState('')
  const [stanceA, setStanceA] = useState('')
  const [stanceB, setStanceB] = useState('')
  const [judgeHint, setJudgeHint] = useState('')
  const [tag, setTag] = useState('community')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [prompts, setPrompts] = useState<ArenaPrompt[]>([])

  const load = () => {
    void fetchCommunityPrompts()
      .then((d) => setPrompts(d.prompts))
      .catch(() => {})
  }
  useEffect(load, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (topic.trim().length < 6) {
      setError('Give the topic a bit more substance.')
      return
    }
    if (!stanceA.trim() || !stanceB.trim()) {
      setError('Both opposing stances are required.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const created = await createPrompt({
        topic: topic.trim(),
        stanceA: stanceA.trim(),
        stanceB: stanceB.trim(),
        judgeHint: judgeHint.trim() || undefined,
        tag: tag.trim() || 'community',
      })
      setTopic('')
      setStanceA('')
      setStanceB('')
      setJudgeHint('')
      load()
      onPlay(created)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create prompt')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="arena-wrap">
      <h1 className="arena-section-title">Create a prompt</h1>
      <p className="arena-note" style={{ marginBottom: 18 }}>
        Design a battle. Give two opposing sides and, if you like, tell Odin how to judge it. Great
        for streamers and communities running their own ladder.
      </p>

      <form className="arena-card" style={{ padding: '1.4rem 1.5rem' }} onSubmit={handleCreate}>
        <div className="arena-field">
          <label className="arena-label">Topic / question</label>
          <input
            className="arena-input"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder='e.g. "Is texting back within 3 seconds a red flag?"'
            maxLength={140}
          />
        </div>
        <div className="arena-field">
          <label className="arena-label">Stance A (one side defends this)</label>
          <input
            className="arena-input"
            value={stanceA}
            onChange={(e) => setStanceA(e.target.value)}
            placeholder="Fast replies show confidence and respect"
            maxLength={100}
          />
        </div>
        <div className="arena-field">
          <label className="arena-label">Stance B (the opposite side)</label>
          <input
            className="arena-input"
            value={stanceB}
            onChange={(e) => setStanceB(e.target.value)}
            placeholder="Instant replies scream desperation"
            maxLength={100}
          />
        </div>
        <div className="arena-field">
          <label className="arena-label">Judge instructions (optional)</label>
          <textarea
            className="arena-textarea"
            value={judgeHint}
            onChange={(e) => setJudgeHint(e.target.value)}
            placeholder="e.g. Reward the funniest take. Punish anyone who hedges."
            maxLength={240}
          />
        </div>
        <div className="arena-field">
          <label className="arena-label">Tag</label>
          <input
            className="arena-input"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            maxLength={24}
            style={{ maxWidth: 200 }}
          />
        </div>
        {error && <p className="arena-error">{error}</p>}
        <button className="arena-cta" type="submit" disabled={busy} style={{ marginTop: 8 }}>
          {busy ? 'Creating…' : 'Create & play'}
        </button>
      </form>

      {prompts.length > 0 && (
        <>
          <h2 className="arena-section-title" style={{ fontSize: '1.15rem', margin: '2rem 0 0.75rem' }}>
            Community prompts
          </h2>
          <ul className="arena-list">
            {prompts.map((p) => (
              <li key={p.id} className="arena-row" style={{ gridTemplateColumns: '1fr auto' }}>
                <span style={{ minWidth: 0 }}>
                  <div className="arena-row-name">{p.topic}</div>
                  <div className="arena-row-sub">
                    {p.stanceA} vs {p.stanceB} · by {p.author}
                  </div>
                </span>
                <button className="arena-btn" onClick={() => onPlay(p)}>
                  Play
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

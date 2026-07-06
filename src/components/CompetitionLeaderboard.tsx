import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import logo from './logo.png'
import {
  createAffiliateLink,
  fetchAffiliateLeaderboard,
  fetchAffiliateLink,
  type AffiliateEntry,
} from '../lib/affiliate'
import {
  buildInviteUrl,
  getMyAffiliateCode,
  saveMyAffiliateCode,
} from '../lib/referral'

export default function CompetitionLeaderboard() {
  const [entries, setEntries] = useState<AffiliateEntry[]>([])
  const [enabled, setEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [myLink, setMyLink] = useState<{ code: string; name: string; url: string; signup_count: number } | null>(
    null,
  )
  const [copied, setCopied] = useState(false)

  const loadLeaderboard = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchAffiliateLeaderboard()
      setEnabled(data.enabled)
      setEntries(data.entries)
      const saved = getMyAffiliateCode()
      if (saved) {
        const mine = data.entries.find((e) => e.code === saved)
        if (mine) {
          setMyLink((prev) =>
            prev
              ? { ...prev, signup_count: mine.signup_count }
              : {
                  code: mine.code,
                  name: mine.name,
                  url: buildInviteUrl(mine.code),
                  signup_count: mine.signup_count,
                },
          )
        }
      }
    } catch {
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadLeaderboard()
  }, [loadLeaderboard])

  useEffect(() => {
    const refresh = () => void loadLeaderboard()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refresh()
    })
    return () => {
      window.removeEventListener('focus', refresh)
    }
  }, [loadLeaderboard])

  useEffect(() => {
    const saved = getMyAffiliateCode()
    if (!saved) return
    void fetchAffiliateLink(saved).then((link) => {
      if (link) {
        setMyLink({
          code: link.code,
          name: link.name,
          url: buildInviteUrl(link.code),
          signup_count: link.signup_count ?? 0,
        })
      }
    })
  }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length < 2) {
      setCreateError('Enter at least 2 characters')
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const link = await createAffiliateLink(trimmed)
      saveMyAffiliateCode(link.code)
      setMyLink({
        code: link.code,
        name: link.name,
        url: buildInviteUrl(link.code),
        signup_count: 0,
      })
      setName('')
      await loadLeaderboard()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create link')
    } finally {
      setCreating(false)
    }
  }

  async function handleCopy() {
    if (!myLink?.url) return
    try {
      await navigator.clipboard.writeText(myLink.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <div className="comp-page">
      <motion.div
        className="comp-wrap"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        <header className="comp-header">
          <img src={logo} alt="Odin" className="comp-logo" />
          <p className="guest-eyebrow">Competition</p>
          <h1 className="comp-headline guest-title">
            Most sign-ups wins <em>$500</em>
          </h1>
          <p className="comp-lede">
            Get a personal link, share it, and climb the board. Only new Odin accounts count.
          </p>
        </header>

        <div className="comp-grid">
          <section className="comp-panel card">
            <div className="comp-panel-top">
              <h2 className="comp-panel-title">Your link</h2>
              {myLink ? (
                <span className="comp-stat">
                  {myLink.signup_count} sign-up{myLink.signup_count === 1 ? '' : 's'}
                </span>
              ) : null}
            </div>

            {myLink ? (
              <div className="comp-link-block">
                <p className="comp-link-name">{myLink.name}</p>
                <div className="comp-link-row">
                  <code className="comp-link-url">{myLink.url}</code>
                  <button type="button" className="comp-copy" onClick={handleCopy}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            ) : (
              <p className="comp-panel-note">Enter your name below to generate a trackable link.</p>
            )}

            <form className="comp-form" onSubmit={handleCreate}>
              <input
                className="comp-input"
                type="text"
                placeholder={myLink ? 'Different name for another link' : 'Your name'}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                disabled={creating || !enabled}
              />
              <button type="submit" className="guest-cta comp-submit" disabled={creating || !enabled}>
                {creating ? 'One moment…' : myLink ? 'Make another link' : 'Create my link'}
              </button>
            </form>
            {createError ? <p className="comp-error">{createError}</p> : null}
            {!enabled ? (
              <p className="comp-empty">Competition tracking isn&apos;t available here yet.</p>
            ) : null}
          </section>

          <section className="comp-panel card">
            <div className="comp-panel-top">
              <h2 className="comp-panel-title">Standings</h2>
              <button
                type="button"
                className="comp-refresh"
                onClick={() => void loadLeaderboard()}
                disabled={loading}
              >
                {loading ? 'Updating…' : 'Refresh'}
              </button>
            </div>

            {loading && entries.length === 0 ? (
              <p className="comp-empty">Loading standings…</p>
            ) : entries.length === 0 ? (
              <p className="comp-empty">No entries yet.</p>
            ) : (
              <ol className="comp-standings">
                {entries.map((entry, i) => {
                  const rank = i + 1
                  const isMe = myLink?.code === entry.code
                  const isLeader = rank === 1
                  return (
                    <li
                      key={entry.code}
                      className={`comp-standing${isMe ? ' comp-standing--you' : ''}${isLeader ? ' comp-standing--first' : ''}`}
                    >
                      <span className="comp-standing-rank">{String(rank).padStart(2, '0')}</span>
                      <span className="comp-standing-name">{entry.name}</span>
                      <span className="comp-standing-score">{entry.signup_count}</span>
                    </li>
                  )
                })}
              </ol>
            )}

            {entries.length > 0 ? (
              <p className="comp-footnote">First place at close wins the $500 prize.</p>
            ) : null}
          </section>
        </div>
      </motion.div>
    </div>
  )
}

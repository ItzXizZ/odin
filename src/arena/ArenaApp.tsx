import { useCallback, useEffect, useState } from 'react'
import './arena.css'
import logo from '../components/logo.png'
import ArenaHome from './ArenaHome'
import PlayFlow, { type PlayMode } from './BlitzRound'
import Leaderboard from './Leaderboard'
import Gallery from './Gallery'
import CreatePrompt from './CreatePrompt'
import { fetchChallenge } from '../lib/arena'
import { promptById, randomPrompt, todaysPrompt } from './prompts'
import type { ArenaPrompt } from './types'

type Screen = 'home' | 'leaderboard' | 'gallery' | 'create'

interface PlaySession {
  mode: PlayMode
  prompt: ArenaPrompt
  challengeId?: string
}

export default function ArenaApp() {
  const [screen, setScreen] = useState<Screen>('home')
  const [play, setPlay] = useState<PlaySession | null>(null)
  const [challengeLoading, setChallengeLoading] = useState(false)
  const [challengeError, setChallengeError] = useState('')

  // Deep links: /arena/challenge/:id, /arena/daily, /arena/leaderboard, etc.
  useEffect(() => {
    const parts = window.location.pathname.split('/').filter(Boolean)
    const sub = parts[1]
    if (sub === 'challenge' && parts[2]) {
      void loadChallenge(parts[2])
    } else if (sub === 'daily') {
      setPlay({ mode: 'daily', prompt: todaysPrompt() })
    } else if (sub === 'leaderboard') {
      setScreen('leaderboard')
    } else if (sub === 'gallery') {
      setScreen('gallery')
    } else if (sub === 'create') {
      setScreen('create')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const nav = useCallback((path: string, next: () => void) => {
    window.history.pushState({}, '', path)
    next()
  }, [])

  const goHome = useCallback(() => {
    nav('/arena', () => {
      setPlay(null)
      setScreen('home')
      setChallengeError('')
    })
  }, [nav])

  async function loadChallenge(id: string) {
    setChallengeLoading(true)
    setChallengeError('')
    try {
      const info = await fetchChallenge(id)
      const prompt: ArenaPrompt = {
        id: info.promptId || 'challenge',
        topic: info.topic,
        // Reconstruct both sides: challenger's stance is A, friend defends B.
        stanceA: info.challengerStance,
        stanceB: info.friendStance,
        tag: 'challenge',
      }
      setPlay({ mode: 'challenge', prompt, challengeId: id })
    } catch (e) {
      setChallengeError(e instanceof Error ? e.message : 'Challenge not found')
    } finally {
      setChallengeLoading(false)
    }
  }

  const startQuick = useCallback(
    (prompt?: ArenaPrompt) => {
      nav('/arena', () => setPlay({ mode: 'quick', prompt: prompt || randomPrompt() }))
    },
    [nav],
  )
  const startDaily = useCallback(() => {
    nav('/arena/daily', () => setPlay({ mode: 'daily', prompt: todaysPrompt() }))
  }, [nav])

  // ── Render ──
  let body: React.ReactNode
  if (challengeLoading) {
    body = (
      <div className="arena-wrap">
        <div className="arena-card arena-matching">
          <div className="arena-spinner" />
          <p style={{ fontWeight: 600 }}>Loading challenge…</p>
        </div>
      </div>
    )
  } else if (challengeError) {
    body = (
      <div className="arena-wrap">
        <div className="arena-card" style={{ padding: '2rem', textAlign: 'center' }}>
          <p className="arena-error" style={{ fontSize: '1rem' }}>
            {challengeError}
          </p>
          <button className="arena-cta ghost" style={{ marginTop: 16 }} onClick={goHome}>
            Arena home
          </button>
        </div>
      </div>
    )
  } else if (play) {
    body = (
      <PlayFlow
        key={`${play.mode}-${play.prompt.id}-${play.challengeId ?? ''}`}
        prompt={play.prompt}
        mode={play.mode}
        challengeId={play.challengeId}
        onHome={goHome}
      />
    )
  } else if (screen === 'leaderboard') {
    body = <Leaderboard />
  } else if (screen === 'gallery') {
    body = <Gallery />
  } else if (screen === 'create') {
    body = <CreatePrompt onPlay={(p) => nav('/arena', () => setPlay({ mode: 'quick', prompt: p }))} />
  } else {
    body = (
      <ArenaHome
        onQuickPlay={startQuick}
        onDaily={startDaily}
        onLeaderboard={() => nav('/arena/leaderboard', () => setScreen('leaderboard'))}
        onGallery={() => nav('/arena/gallery', () => setScreen('gallery'))}
        onCreate={() => nav('/arena/create', () => setScreen('create'))}
      />
    )
  }

  const activeScreen = play ? '' : screen

  return (
    <div className="arena">
      <div className="arena-bar">
        <button className="arena-brand" onClick={goHome}>
          <img src={logo} alt="Odin" />
          <span className="arena-brand-tag">Arena</span>
        </button>
        <nav className="arena-nav">
          <button
            className={activeScreen === 'home' ? 'active' : ''}
            onClick={() => nav('/arena', () => { setPlay(null); setScreen('home') })}
          >
            Play
          </button>
          <button
            className={activeScreen === 'leaderboard' ? 'active' : ''}
            onClick={() => nav('/arena/leaderboard', () => { setPlay(null); setScreen('leaderboard') })}
          >
            Leaderboards
          </button>
          <button
            className={activeScreen === 'gallery' ? 'active' : ''}
            onClick={() => nav('/arena/gallery', () => { setPlay(null); setScreen('gallery') })}
          >
            Gallery
          </button>
          <button
            className={activeScreen === 'create' ? 'active' : ''}
            onClick={() => nav('/arena/create', () => { setPlay(null); setScreen('create') })}
          >
            Create
          </button>
        </nav>
        <div className="arena-bar-spacer" />
        <a className="arena-studio-link" href="/">
          Open Studio →
        </a>
      </div>
      {body}
    </div>
  )
}

import { motion } from 'framer-motion'
import OdinHead from '../components/OdinHead'
import { getLocalStats } from '../lib/arena'
import { dailyNumber, todaysPrompt } from './prompts'
import type { ArenaPrompt } from './types'

interface HomeProps {
  onQuickPlay: (prompt?: ArenaPrompt) => void
  onDaily: () => void
  onLeaderboard: () => void
  onGallery: () => void
  onCreate: () => void
}

export default function ArenaHome({
  onQuickPlay,
  onDaily,
  onLeaderboard,
  onGallery,
  onCreate,
}: HomeProps) {
  const stats = getLocalStats()
  const daily = todaysPrompt()

  const modes = [
    {
      glyph: '⚡',
      title: 'Quick Play',
      desc: '5-minute argument vs a live opponent or sparring bot. Random topic, random side.',
      action: () => onQuickPlay(),
    },
    {
      glyph: '🗓️',
      title: `Daily Blitz #${dailyNumber()}`,
      desc: `Today: "${daily.topic}" One shot, ranked on today's global board.`,
      action: onDaily,
    },
    {
      glyph: '🏆',
      title: 'Leaderboards',
      desc: 'Climb the ELO ladder and top the daily board. Seasonal resets keep it fresh.',
      action: onLeaderboard,
    },
    {
      glyph: '👀',
      title: 'The Gallery',
      desc: 'Watch real duels, read both sides, and vote against Odin.',
      action: onGallery,
    },
    {
      glyph: '✏️',
      title: 'Create a Prompt',
      desc: 'Design your own battle with custom judging. Perfect for streams and clubs.',
      action: onCreate,
    },
  ]

  return (
    <div className="arena-wrap">
      <div className="arena-hero">
        <div>
          <p className="arena-eyebrow">Odin Arena</p>
          <h1 className="arena-h1">
            5-minute <em>argument battles</em>. Odin picks the winner.
          </h1>
          <p className="arena-lede">
            Get a hot take, get 5 minutes, get judged. Defend the indefensible, roast the opposition,
            climb the ladder. Chat picks the topic, you do the talking.
          </p>
          <motion.button
            className="arena-cta"
            onClick={() => onQuickPlay()}
            whileTap={{ scale: 0.97 }}
          >
            ⚔ Enter the Arena
          </motion.button>

          {stats.battles > 0 && (
            <>
              <div className="arena-stats">
                <div className="arena-stat">
                  <div className="arena-stat-val">{stats.rating}</div>
                  <div className="arena-stat-label">Rating</div>
                </div>
                <div className="arena-stat">
                  <div className="arena-stat-val">
                    {stats.wins}-{stats.losses}
                  </div>
                  <div className="arena-stat-label">Record</div>
                </div>
                <div className="arena-stat">
                  <div className="arena-stat-val">
                    {stats.streak > 0
                      ? `W${stats.streak}`
                      : stats.streak < 0
                        ? `L${Math.abs(stats.streak)}`
                        : '–'}
                  </div>
                  <div className="arena-stat-label">Streak</div>
                </div>
              </div>
              {stats.archetype && (
                <div className="arena-archetype">🏷 You fight like {stats.archetype}</div>
              )}
            </>
          )}
        </div>

        <div className="arena-hero-odin">
          <motion.div
            animate={{ y: [0, -8, 0], rotate: [0, -2, 2, 0] }}
            transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
          >
            <OdinHead talking={false} size={150} />
          </motion.div>
        </div>
      </div>

      <div className="arena-modes">
        {modes.map((m) => (
          <button key={m.title} className="arena-mode" onClick={m.action}>
            <div className="arena-mode-glyph">{m.glyph}</div>
            <div className="arena-mode-title">{m.title}</div>
            <p className="arena-mode-desc">{m.desc}</p>
          </button>
        ))}
      </div>
    </div>
  )
}

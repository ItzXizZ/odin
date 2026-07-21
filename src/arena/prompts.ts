import type { ArenaPrompt } from './types'

/**
 * Curated brainrot / trend prompt bank. These are deliberately low-stakes and
 * internet-native: the comedy comes from being forced onto a side of a dumb
 * argument everyone already has in group chats. Swap/extend weekly.
 *
 * Each prompt is symmetric: two full opposing stances so writers can be
 * randomly assigned either side (which is what stops copying and creates the
 * funny "had to defend something I hate" moment).
 */
export const PROMPT_BANK: ArenaPrompt[] = [
  {
    id: 'six-seven',
    topic: 'Is "6-7" actually a cultural moment?',
    stanceA: '6-7 is a genuine, iconic piece of internet culture',
    stanceB: '6-7 is pure brainrot with zero meaning',
    tag: 'brainrot',
  },
  {
    id: 'mogging',
    topic: 'Does mogging actually matter?',
    stanceA: 'Mogging is real and quietly runs every social interaction',
    stanceB: 'Mogging is insecure cope invented online',
    tag: 'brainrot',
  },
  {
    id: 'looksmax',
    topic: 'Is looksmaxxing self-improvement or a scam?',
    stanceA: 'Looksmaxxing is legitimate self-improvement',
    stanceB: 'Looksmaxxing is a grift preying on insecurity',
    tag: 'brainrot',
  },
  {
    id: 'skibidi',
    topic: 'Is Skibidi Toilet art?',
    stanceA: 'Skibidi Toilet is genuinely inventive serialized storytelling',
    stanceB: 'Skibidi Toilet is the collapse of civilization',
    tag: 'brainrot',
  },
  {
    id: 'rizz',
    topic: 'Is rizz a real skill?',
    stanceA: 'Rizz is a learnable, legitimate social skill',
    stanceB: 'Rizz is a made-up word for basic confidence',
    tag: 'brainrot',
  },
  {
    id: 'delulu',
    topic: 'Is being delulu good for you?',
    stanceA: 'Delulu is the solulu: irrational optimism wins',
    stanceB: 'Delulu is just avoiding reality with extra steps',
    tag: 'brainrot',
  },
  {
    id: 'gyat',
    topic: 'Should "aura points" be a real social currency?',
    stanceA: 'Aura points are the most honest ranking system we have',
    stanceB: 'Aura points are meaningless chaos',
    tag: 'brainrot',
  },
  {
    id: 'touch-grass',
    topic: '"Touch grass" — good advice or lazy insult?',
    stanceA: 'Touch grass is the wisest advice of our generation',
    stanceB: 'Touch grass is a thought-terminating cliche',
    tag: 'discourse',
  },
  {
    id: 'pineapple',
    topic: 'Pineapple on pizza.',
    stanceA: 'Pineapple belongs on pizza and the haters are cowards',
    stanceB: 'Pineapple on pizza is a culinary crime',
    tag: 'chaos',
  },
  {
    id: 'cereal-soup',
    topic: 'Is cereal a soup?',
    stanceA: 'Cereal is unambiguously a soup',
    stanceB: 'Calling cereal a soup is deranged',
    tag: 'chaos',
  },
  {
    id: 'hotdog-sandwich',
    topic: 'Is a hot dog a sandwich?',
    stanceA: 'A hot dog is a sandwich, structurally undeniable',
    stanceB: 'A hot dog is its own category, never a sandwich',
    tag: 'chaos',
  },
  {
    id: 'audiobooks',
    topic: 'Do audiobooks count as reading?',
    stanceA: 'Audiobooks fully count as reading',
    stanceB: 'Audiobooks are listening, not reading',
    tag: 'discourse',
  },
  {
    id: 'reply-all',
    topic: 'Is hitting "reply-all" good etiquette?',
    stanceA: 'Reply-all is transparent and underrated',
    stanceB: 'Reply-all is a menace to society',
    tag: 'discourse',
  },
  {
    id: 'gymtok',
    topic: 'Is gym culture on TikTok inspiring or insufferable?',
    stanceA: 'GymTok genuinely motivates millions',
    stanceB: 'GymTok is vanity cosplaying as discipline',
    tag: 'discourse',
  },
  {
    id: 'sigma',
    topic: 'Is the "sigma male" a real archetype?',
    stanceA: 'The sigma male is a real and admirable type',
    stanceB: 'The sigma male is fan-fiction for lonely guys',
    tag: 'brainrot',
  },
  {
    id: 'npc',
    topic: 'Are most people NPCs?',
    stanceA: 'Most people really do run on autopilot',
    stanceB: 'Calling people NPCs is arrogant nonsense',
    tag: 'discourse',
  },
]

/** Deterministic Daily Blitz: same prompt for everyone on a given UTC day. */
export function dailyIndex(date = new Date()): number {
  const epochDay = Math.floor(date.getTime() / 86_400_000)
  return epochDay % PROMPT_BANK.length
}

/** Daily Blitz number, counting up from launch — used in share strings. */
const LAUNCH_EPOCH_DAY = Math.floor(Date.UTC(2026, 6, 1) / 86_400_000) // 2026-07-01
export function dailyNumber(date = new Date()): number {
  const epochDay = Math.floor(date.getTime() / 86_400_000)
  return Math.max(1, epochDay - LAUNCH_EPOCH_DAY + 1)
}

export function todaysPrompt(date = new Date()): ArenaPrompt {
  return PROMPT_BANK[dailyIndex(date)]
}

export function randomPrompt(exceptId?: string): ArenaPrompt {
  const pool = exceptId ? PROMPT_BANK.filter((p) => p.id !== exceptId) : PROMPT_BANK
  return pool[Math.floor(Math.random() * pool.length)]
}

export function promptById(id: string): ArenaPrompt | undefined {
  return PROMPT_BANK.find((p) => p.id === id)
}

/** UTC day key, e.g. "2026-07-07". */
export function dayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

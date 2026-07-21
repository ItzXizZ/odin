/** Shared types for Odin Arena. */

export interface ArenaPrompt {
  id: string
  topic: string
  /** The two opposing stances. A stance is a full defensible position. */
  stanceA: string
  stanceB: string
  /** Optional custom instruction that biases Odin's judging for this prompt. */
  judgeHint?: string
  tag: string
  /** Present on community-authored prompts. */
  author?: string
  plays?: number
  createdAt?: number
}

export interface BotPersona {
  id: string
  name: string
  /** One-line description of voice, fed to the model. */
  style: string
  /** Emoji/avatar glyph shown on screen. */
  glyph: string
  /** Rough typing speed in words-per-minute for the live-feed simulation. */
  wpm: number
  /** 0-1 chaos factor: how erratic the typing rhythm looks. */
  chaos: number
}

export interface FighterScore {
  score: number
  wit: number
  boldness: number
  clarity: number
  persuasion: number
  tip: string
}

export interface Verdict {
  winner: 'A' | 'B'
  winStyle: 'wit' | 'boldness' | 'clarity' | 'persuasion'
  verdict: string
  roast: string
  a: FighterScore
  b: FighterScore
}

export interface EloState {
  rating: number
  wins: number
  losses: number
  streak: number
  battles: number
}

export interface JudgeResponse {
  verdict: Verdict
  elo: EloState
  playerWon: boolean
  archetype: string | null
  duelId: string | null
}

export interface DailyRankResponse {
  rank: number
  total: number
  percentile: number
}

export interface LeaderboardDailyEntry {
  rank: number
  name: string
  score: number
  roast: string
  stance: string
}

export interface LeaderboardEloEntry {
  rank: number
  name: string
  rating: number
  wins: number
  losses: number
  streak: number
}

export interface GalleryDuel {
  id: string
  topic: string
  a: { name: string; stance: string; text: string; isBot: boolean }
  b: { name: string; stance: string; text: string; isBot: boolean }
  winner: 'A' | 'B'
  verdict: string
  roast: string
  votesA: number
  votesB: number
  createdAt: number
}

export type ArenaView =
  | { name: 'home' }
  | { name: 'play'; prompt?: ArenaPrompt }
  | { name: 'daily' }
  | { name: 'leaderboard' }
  | { name: 'create' }
  | { name: 'gallery' }
  | { name: 'challenge'; id: string }

/** Which side the human is assigned. */
export type Side = 'A' | 'B'

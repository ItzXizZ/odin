/**
 * Arena API client. Talks to the /api/arena/* routes for AI judging, bots,
 * leaderboards, ELO, challenges, community prompts, and the public gallery.
 *
 * Everything degrades gracefully: a stable guest id keeps unsigned players on
 * the boards, and local stats are cached so the profile card survives offline.
 */
import { authHeader } from './supabase'
import type {
  ArenaPrompt,
  BotPersona,
  EloState,
  GalleryDuel,
  JudgeResponse,
  DailyRankResponse,
  LeaderboardDailyEntry,
  LeaderboardEloEntry,
  Side,
  Verdict,
} from '../arena/types'

const GUEST_KEY = 'odin-arena-guest'
const NAME_KEY = 'odin-arena-name'
const STATS_KEY = 'odin-arena-stats'

export function getGuestId(): string {
  if (typeof window === 'undefined') return 'ssr'
  let id = localStorage.getItem(GUEST_KEY)
  if (!id) {
    id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`)
    localStorage.setItem(GUEST_KEY, id)
  }
  return id
}

export function getArenaName(): string {
  if (typeof window === 'undefined') return 'Writer'
  return localStorage.getItem(NAME_KEY) || ''
}

export function setArenaName(name: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(NAME_KEY, name.trim().slice(0, 40))
}

export interface LocalStats extends EloState {
  archetype: string | null
}

export function getLocalStats(): LocalStats {
  if (typeof window === 'undefined') {
    return { rating: 1200, wins: 0, losses: 0, streak: 0, battles: 0, archetype: null }
  }
  try {
    const raw = localStorage.getItem(STATS_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    /* ignore */
  }
  return { rating: 1200, wins: 0, losses: 0, streak: 0, battles: 0, archetype: null }
}

export function setLocalStats(stats: LocalStats): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(STATS_KEY, JSON.stringify(stats))
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    const preview = text.trimStart().slice(0, 80)
    if (preview.startsWith('<!DOCTYPE') || preview.startsWith('<html')) {
      throw new Error('Arena backend unavailable. Start the server (npm run dev).')
    }
    throw new Error('Server returned an invalid response')
  }
}

function baseBody(extra: object = {}) {
  return JSON.stringify({ guestId: getGuestId(), name: getArenaName() || undefined, ...extra })
}

function jsonHeaders() {
  return { 'Content-Type': 'application/json', ...authHeader() }
}

// ── Bot opponent ─────────────────────────────────────────────────────────────

export async function generateBotArgument(
  topic: string,
  stance: string,
  persona: BotPersona,
  apiKey: string,
): Promise<string> {
  const res = await fetch('/api/arena/bot', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ topic, stance, persona, apiKey }),
  })
  const data = await readJson<{ text: string; error?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Bot failed to argue')
  return data.text
}

// ── Judging ──────────────────────────────────────────────────────────────────

export interface JudgeArgs {
  topic: string
  promptId?: string
  stancePlayer: string
  playerText: string
  stanceOpponent: string
  opponentText: string
  opponentName: string
  opponentIsBot: boolean
  opponentId?: string
  publish: boolean
  apiKey: string
}

export async function judgeDuel(args: JudgeArgs): Promise<JudgeResponse> {
  const res = await fetch('/api/arena/judge', {
    method: 'POST',
    headers: jsonHeaders(),
    body: baseBody(args),
  })
  const data = await readJson<JudgeResponse & { error?: string }>(res)
  if (!res.ok) throw new Error((data as { error?: string }).error || 'Odin could not decide')
  // Mirror ELO locally so the profile card is instant + offline-friendly.
  setLocalStats({ ...data.elo, archetype: data.archetype })
  return data
}

/**
 * The player is always fighter "A" in a judge call, but which physical side of
 * the prompt they defend is random. This helper maps the human's assigned side
 * to the right stance strings.
 */
export function stancesFor(prompt: ArenaPrompt, playerSide: Side) {
  return playerSide === 'A'
    ? { player: prompt.stanceA, opponent: prompt.stanceB }
    : { player: prompt.stanceB, opponent: prompt.stanceA }
}

// ── Daily Blitz ──────────────────────────────────────────────────────────────

export async function submitDaily(args: {
  day: string
  promptId: string
  score: number
  roast: string
  stance: string
}): Promise<DailyRankResponse> {
  const res = await fetch('/api/arena/submit', {
    method: 'POST',
    headers: jsonHeaders(),
    body: baseBody(args),
  })
  const data = await readJson<DailyRankResponse & { error?: string }>(res)
  if (!res.ok) throw new Error((data as { error?: string }).error || 'Could not submit score')
  return data
}

export async function fetchDailyLeaderboard(day?: string): Promise<{
  day: string
  entries: LeaderboardDailyEntry[]
}> {
  const qs = day ? `?day=${encodeURIComponent(day)}` : ''
  const res = await fetch(`/api/arena/leaderboard/daily${qs}`)
  return readJson(res)
}

export async function fetchEloLeaderboard(): Promise<{ entries: LeaderboardEloEntry[] }> {
  const res = await fetch('/api/arena/leaderboard/elo')
  return readJson(res)
}

// ── Matchmaking ──────────────────────────────────────────────────────────────

export interface MatchResult {
  matched: boolean
  matchId?: string
  side?: Side
  opponent?: { id: string; name: string }
}

export async function findMatch(promptId: string): Promise<MatchResult> {
  const res = await fetch('/api/arena/match', {
    method: 'POST',
    headers: jsonHeaders(),
    body: baseBody({ promptId }),
  })
  return readJson<MatchResult>(res)
}

export interface RoomState {
  opponentProgress: number
  opponentDone: boolean
  opponentName: string
  opponentText: string | null
  opponentStance: string | null
  bothDone: boolean
}

export async function reportProgress(
  matchId: string,
  args: { progress: number; done?: boolean; text?: string; stance?: string },
): Promise<RoomState> {
  const res = await fetch(`/api/arena/room/${encodeURIComponent(matchId)}/progress`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: baseBody(args),
  })
  const data = await readJson<RoomState & { error?: string }>(res)
  if (!res.ok) throw new Error((data as { error?: string }).error || 'Room error')
  return data
}

export async function pollRoom(matchId: string): Promise<RoomState> {
  const res = await fetch(
    `/api/arena/room/${encodeURIComponent(matchId)}?guestId=${encodeURIComponent(getGuestId())}`,
  )
  const data = await readJson<RoomState & { error?: string }>(res)
  if (!res.ok) throw new Error((data as { error?: string }).error || 'Room error')
  return data
}

// ── Challenges ───────────────────────────────────────────────────────────────

export async function createChallenge(args: {
  topic: string
  promptId?: string
  stance: string
  stanceOpponent: string
  text: string
  score?: number
  roast?: string
}): Promise<{ id: string }> {
  const res = await fetch('/api/arena/challenge', {
    method: 'POST',
    headers: jsonHeaders(),
    body: baseBody(args),
  })
  const data = await readJson<{ id: string; error?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Could not create challenge')
  return data
}

export interface ChallengeInfo {
  id: string
  topic: string
  promptId: string | null
  challengerName: string
  challengerStance: string
  friendStance: string
  challengerScore: number | null
}

export async function fetchChallenge(id: string): Promise<ChallengeInfo> {
  const res = await fetch(`/api/arena/challenge/${encodeURIComponent(id)}`)
  const data = await readJson<ChallengeInfo & { error?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Challenge not found')
  return data
}

export interface ChallengeReveal {
  id: string
  topic: string
  challenger: { name: string; stance: string; text: string; score: number | null; roast: string }
}

export async function revealChallenge(id: string): Promise<ChallengeReveal> {
  const res = await fetch(`/api/arena/challenge/${encodeURIComponent(id)}/reveal`)
  const data = await readJson<ChallengeReveal & { error?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Challenge not found')
  return data
}

// ── Community prompts ────────────────────────────────────────────────────────

export async function createPrompt(args: {
  topic: string
  stanceA: string
  stanceB: string
  judgeHint?: string
  tag?: string
}): Promise<ArenaPrompt> {
  const res = await fetch('/api/arena/prompts', {
    method: 'POST',
    headers: jsonHeaders(),
    body: baseBody(args),
  })
  const data = await readJson<ArenaPrompt & { error?: string }>(res)
  if (!res.ok) throw new Error((data as { error?: string }).error || 'Could not create prompt')
  return data
}

export async function fetchCommunityPrompts(): Promise<{ prompts: ArenaPrompt[] }> {
  const res = await fetch('/api/arena/prompts')
  return readJson(res)
}

// ── Gallery ──────────────────────────────────────────────────────────────────

export async function fetchGallery(): Promise<{ duels: GalleryDuel[] }> {
  const res = await fetch('/api/arena/gallery')
  return readJson(res)
}

export async function voteDuel(
  id: string,
  side: Side,
): Promise<{ votesA: number; votesB: number; crowdWinner: Side }> {
  const res = await fetch(`/api/arena/gallery/${encodeURIComponent(id)}/vote`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ side }),
  })
  return readJson(res)
}

// ── Share strings ────────────────────────────────────────────────────────────

/** Wordle-style, spoiler-free Daily Blitz result. */
export function dailyShareString(args: {
  blitzNumber: number
  percentile: number
  stance: string
  roast: string
  url: string
}): string {
  const bands = percentileBands(args.percentile)
  return `Odin Blitz #${args.blitzNumber} 🗡️
${bands}  top ${100 - args.percentile}%
Stance: ${args.stance}
Odin: "${args.roast}"
${args.url}`
}

function percentileBands(percentile: number): string {
  // Five squares filled proportionally to how high you ranked.
  const filled = Math.round((percentile / 100) * 5)
  const squares: string[] = []
  for (let i = 0; i < 5; i++) {
    if (i < filled - 1) squares.push('🟩')
    else if (i < filled) squares.push('🟨')
    else squares.push('⬛')
  }
  return squares.join('')
}

export function duelShareString(args: {
  topic: string
  won: boolean
  opponentName: string
  roast: string
  rating: number
  url: string
}): string {
  return `Odin Arena ⚔️
${args.topic}
I ${args.won ? 'beat' : 'lost to'} ${args.opponentName}. Odin: "${args.roast}"
Rating: ${args.rating}
${args.url}`
}

export type { Verdict }

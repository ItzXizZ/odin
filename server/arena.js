/**
 * Odin Arena — the viral wing of odinwrite.com.
 *
 * A separate game surface: 5-minute argument battles on trending / brainrot
 * topics, judged by Odin. This module owns every server concern for the arena:
 *   - AI endpoints (bot opponents + Odin's verdict), deliberately NOT gated
 *     behind the studio subscription so the arena stays free and frictionless.
 *   - Persistence for the daily leaderboard, ELO ladder, friend challenges,
 *     the public duel gallery, and community-authored prompts.
 *   - A lightweight in-memory matchmaking queue with a bot fallback.
 *
 * Persistence strategy: everything lives in memory for speed, and (when
 * Supabase is configured) is mirrored to JSON blobs in the state bucket so it
 * survives restarts. Every persistence call is best-effort — a storage failure
 * never breaks a round.
 */

import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import ws from 'ws'
import { getUserFromToken } from './supabase.js'
import { augmentSystemPrompt } from './aiPolicy.js'

// ── Anthropic ────────────────────────────────────────────────────────────────

function getAnthropic(apiKey) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('No Anthropic API key provided')
  return new Anthropic({ apiKey: key })
}

const MODEL = 'claude-sonnet-4-5'

/** Strip stray ``` fences and grab the first {...} JSON object. */
function extractJson(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/)
  if (!match) throw new Error('No JSON found in model response')
  return JSON.parse(match[0])
}

function stripDashes(text) {
  return String(text || '')
    .replace(/[ \t]*[—–][ \t]*/g, ', ')
    .replace(/,[ \t]*,+/g, ', ')
    .trim()
}

// ── Persistence (in-memory + best-effort Supabase storage blobs) ─────────────

function supabaseCfg() {
  return {
    url: process.env.SUPABASE_URL,
    secret: process.env.SUPABASE_SECRET_KEY,
    bucket: process.env.SUPABASE_STATE_BUCKET || 'odin-state',
  }
}
function supabaseOn() {
  const { url, secret } = supabaseCfg()
  return Boolean(url && secret)
}

let _sb = null
function sb() {
  if (!supabaseOn()) return null
  if (!_sb) {
    const { url, secret } = supabaseCfg()
    _sb = createClient(url, secret, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: ws },
    })
  }
  return _sb
}

const BLOB_PREFIX = 'arena'
function blobPath(key) {
  return `${BLOB_PREFIX}/${key}.json`
}

async function loadBlob(key, fallback) {
  const client = sb()
  if (!client) return fallback
  try {
    const { bucket } = supabaseCfg()
    const { data, error } = await client.storage.from(bucket).download(blobPath(key))
    if (error) return fallback
    const text = await data.text()
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

async function saveBlob(key, value) {
  const client = sb()
  if (!client) return
  try {
    const { bucket } = supabaseCfg()
    const body = Buffer.from(JSON.stringify(value), 'utf-8')
    await client.storage
      .from(bucket)
      .upload(blobPath(key), body, { contentType: 'application/json', upsert: true })
  } catch (err) {
    console.warn('[arena] saveBlob failed:', key, err.message)
  }
}

/**
 * In-memory arena state, hydrated from storage on boot.
 *   submissions: daily leaderboard rows keyed by `${day}` → array
 *   elo:         { [userId|guestId]: { name, rating, wins, losses, streak } }
 *   duels:       public gallery duels (array, newest first)
 *   challenges:  { [id]: challenge }
 *   prompts:     community-authored prompts (array)
 */
const store = {
  submissions: {},
  elo: {},
  duels: [],
  challenges: {},
  prompts: [],
  loaded: false,
}

export async function ensureArenaSchema() {
  if (store.loaded) return
  const [submissions, elo, duels, challenges, prompts] = await Promise.all([
    loadBlob('submissions', {}),
    loadBlob('elo', {}),
    loadBlob('duels', []),
    loadBlob('challenges', {}),
    loadBlob('prompts', []),
  ])
  store.submissions = submissions || {}
  store.elo = elo || {}
  store.duels = Array.isArray(duels) ? duels : []
  store.challenges = challenges || {}
  store.prompts = Array.isArray(prompts) ? prompts : []
  store.loaded = true
  console.log('[arena] state hydrated (leaderboard, elo, gallery, challenges, prompts).')
}

// ── Identity ─────────────────────────────────────────────────────────────────

/** Resolve a display identity from the bearer token, or fall back to a guest id. */
async function resolveIdentity(req, bodyName, bodyGuestId) {
  const header = req.headers['authorization'] || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null
  if (token) {
    const user = await getUserFromToken(token)
    if (user) {
      const meta = user.user_metadata || {}
      return {
        id: `u:${user.id}`,
        name: (bodyName || meta.full_name || meta.name || 'Writer').toString().slice(0, 40),
        guest: false,
      }
    }
  }
  const gid = (bodyGuestId || randomUUID()).toString().slice(0, 60)
  return { id: `g:${gid}`, name: (bodyName || 'Guest').toString().slice(0, 40), guest: true }
}

// ── ELO ──────────────────────────────────────────────────────────────────────

const K_FACTOR = 32
const BASE_RATING = 1200

function expectedScore(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400))
}

function ratingFor(id) {
  return store.elo[id]?.rating ?? BASE_RATING
}

async function applyEloResult(player, playerWon, opponentRating) {
  const cur = store.elo[player.id] || {
    name: player.name,
    rating: BASE_RATING,
    wins: 0,
    losses: 0,
    streak: 0,
    battles: 0,
  }
  const expected = expectedScore(cur.rating, opponentRating)
  const actual = playerWon ? 1 : 0
  cur.rating = Math.round(cur.rating + K_FACTOR * (actual - expected))
  cur.name = player.name || cur.name
  cur.wins += playerWon ? 1 : 0
  cur.losses += playerWon ? 0 : 1
  cur.streak = playerWon ? Math.max(1, cur.streak + 1) : Math.min(-1, cur.streak - 1)
  cur.battles = (cur.battles || 0) + 1
  cur.updatedAt = Date.now()
  store.elo[player.id] = cur
  await saveBlob('elo', store.elo)
  return cur
}

/** Fighter archetype earned once a writer has enough battles + a win style. */
function archetypeFor(entry, winStyle) {
  if (!entry || (entry.battles || 0) < 5) return null
  if (winStyle === 'wit') return 'The Satirist'
  if (winStyle === 'boldness') return 'The Provocateur'
  if (winStyle === 'clarity') return 'The Prosecutor'
  if (winStyle === 'persuasion') return 'The Closer'
  return entry.rating >= 1400 ? 'The Champion' : 'The Contender'
}

// ── AI: bot opponent ─────────────────────────────────────────────────────────

const BOT_SYSTEM = `You are role-playing as a combatant in "Odin Arena", a fast, funny writing battle. You will be given a persona, a hot-button/brainrot topic, and a stance to defend. Write a SHORT punchy argument (max 150 words) in that persona's voice defending the assigned stance. Be witty, bold, meme-aware, and internet-native, but form a real argument. No preamble, no title, no hashtags, no emoji spam. Just the argument text.`

async function generateBotArgument({ topic, stance, persona, apiKey }) {
  const client = getAnthropic(apiKey)
  const prompt = `PERSONA: ${persona.name} — ${persona.style}
TOPIC: ${topic}
YOUR STANCE (defend this): ${stance}

Write ${persona.name}'s argument now. Max 150 words. Stay fully in character.`
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: augmentSystemPrompt(BOT_SYSTEM),
    messages: [{ role: 'user', content: prompt }],
    temperature: 1,
  })
  const text = response.content?.[0]?.text || ''
  return stripDashes(text).slice(0, 1400)
}

// ── AI: Odin's verdict ───────────────────────────────────────────────────────

const JUDGE_SYSTEM = `You are Odin, the judge of "Odin Arena" — a fast writing battle on a single topic where two writers defend OPPOSITE stances. You are a fight commentator: dramatic, sharp, a little theatrical, never a schoolteacher. You reward persuasion, wit, boldness, and clarity — NOT grammar-nagging or length. You are decisive: you always name a winner. You are brutally honest but never cruel about the person; roast the writing, not the human. Respond with STRICT JSON only, no markdown fences, no prose outside the JSON.`

async function judgeDuel({ topic, stanceA, textA, nameA, stanceB, textB, nameB, apiKey }) {
  const client = getAnthropic(apiKey)
  const prompt = `TOPIC: ${topic}

FIGHTER A — "${nameA}" (defending: ${stanceA}):
"""
${(textA || '').slice(0, 2000)}
"""

FIGHTER B — "${nameB}" (defending: ${stanceB}):
"""
${(textB || '').slice(0, 2000)}
"""

Judge the battle. Score each fighter 0-100 overall, and 0-10 on wit, boldness, clarity, persuasion. Pick a winner. Write a dramatic 2-sentence verdict in your fight-commentator voice, and a single devastating one-line roast aimed at the LOSER's writing. Also give each fighter one short, genuinely useful tip.

Respond with ONLY this JSON:
{
  "winner": "A" | "B",
  "winStyle": "wit" | "boldness" | "clarity" | "persuasion",
  "verdict": "<2 dramatic sentences>",
  "roast": "<one devastating line about the loser's writing>",
  "a": { "score": <0-100>, "wit": <0-10>, "boldness": <0-10>, "clarity": <0-10>, "persuasion": <0-10>, "tip": "<one tip>" },
  "b": { "score": <0-100>, "wit": <0-10>, "boldness": <0-10>, "clarity": <0-10>, "persuasion": <0-10>, "tip": "<one tip>" }
}`
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: augmentSystemPrompt(JUDGE_SYSTEM),
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
  })
  const raw = response.content?.[0]?.text || ''
  const parsed = extractJson(raw)
  parsed.verdict = stripDashes(parsed.verdict)
  parsed.roast = stripDashes(parsed.roast)
  if (parsed.a) parsed.a.tip = stripDashes(parsed.a.tip)
  if (parsed.b) parsed.b.tip = stripDashes(parsed.b.tip)
  return parsed
}

// ── Matchmaking (in-memory) ──────────────────────────────────────────────────

/**
 * Waiting players keyed by promptId. Each waiter holds a promise resolver so a
 * later arrival can pair with them. If nobody arrives before the timeout, the
 * caller falls back to a bot (handled client-side or via /bot).
 */
const queues = new Map() // promptId → [{ id, name, resolve, at }]
const rooms = new Map() // matchId → room

/** A live duel room holding both fighters' assigned sides + submissions. */
function createRoom(matchId, promptId, playerA, playerB) {
  const room = {
    matchId,
    promptId,
    createdAt: Date.now(),
    // Side A defends stanceA of the prompt, side B defends stanceB.
    A: { ...playerA, side: 'A', progress: 0, text: null, stance: null, done: false },
    B: { ...playerB, side: 'B', progress: 0, text: null, stance: null, done: false },
  }
  rooms.set(matchId, room)
  // Rooms are ephemeral; drop after 20 minutes.
  setTimeout(() => rooms.delete(matchId), 20 * 60 * 1000)
  return room
}

function roomSideFor(room, playerId) {
  if (room.A.id === playerId) return 'A'
  if (room.B.id === playerId) return 'B'
  return null
}

function enqueue(promptId, player, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const list = queues.get(promptId) || []
    // Pair with the oldest different waiter.
    const idx = list.findIndex((w) => w.id !== player.id)
    if (idx >= 0) {
      const opponent = list.splice(idx, 1)[0]
      queues.set(promptId, list)
      const matchId = randomUUID()
      // The waiter who was already queued becomes side A.
      createRoom(matchId, promptId, { id: opponent.id, name: opponent.name }, { id: player.id, name: player.name })
      opponent.resolve({
        matched: true,
        matchId,
        side: 'A',
        opponent: { id: player.id, name: player.name },
      })
      resolve({
        matched: true,
        matchId,
        side: 'B',
        opponent: { id: opponent.id, name: opponent.name },
      })
      return
    }
    const waiter = { ...player, resolve, at: Date.now() }
    list.push(waiter)
    queues.set(promptId, list)
    setTimeout(() => {
      const cur = queues.get(promptId) || []
      const pos = cur.indexOf(waiter)
      if (pos >= 0) {
        cur.splice(pos, 1)
        queues.set(promptId, cur)
        resolve({ matched: false })
      }
    }, timeoutMs)
  })
}

// ── Route registration ───────────────────────────────────────────────────────

export function registerArenaRoutes(app) {
  const guard = async (_req, res, next) => {
    try {
      await ensureArenaSchema()
      next()
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  }

  // Bot opponent — generate a full argument up front (client reveals it "live").
  app.post('/api/arena/bot', guard, async (req, res) => {
    const { topic, stance, persona, apiKey } = req.body || {}
    if (!topic || !stance || !persona?.name) {
      return res.status(400).json({ error: 'topic, stance, and persona are required' })
    }
    try {
      const text = await generateBotArgument({ topic, stance, persona, apiKey })
      res.json({ text })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Odin judges a duel, updates ELO, and (optionally) publishes to the gallery.
  app.post('/api/arena/judge', guard, async (req, res) => {
    const {
      topic,
      promptId,
      stancePlayer,
      playerText,
      stanceOpponent,
      opponentText,
      opponentName,
      opponentIsBot,
      opponentId,
      publish,
      guestId,
      name,
      apiKey,
    } = req.body || {}

    if (!topic || !playerText || !opponentText) {
      return res.status(400).json({ error: 'topic, playerText, and opponentText are required' })
    }

    try {
      const player = await resolveIdentity(req, name, guestId)
      const verdict = await judgeDuel({
        topic,
        stanceA: stancePlayer,
        textA: playerText,
        nameA: player.name,
        stanceB: stanceOpponent,
        textB: opponentText,
        nameB: opponentName || 'Opponent',
        apiKey,
      })

      const playerWon = verdict.winner === 'A'
      const opponentRating = opponentIsBot ? BASE_RATING : ratingFor(opponentId || 'g:unknown')
      const eloEntry = await applyEloResult(player, playerWon, opponentRating)

      // Update the human opponent's ELO too (if signed-in / known).
      if (!opponentIsBot && opponentId) {
        const oppEntry = store.elo[opponentId] || {
          name: opponentName || 'Opponent',
          rating: BASE_RATING,
          wins: 0,
          losses: 0,
          streak: 0,
          battles: 0,
        }
        const exp = expectedScore(oppEntry.rating, ratingFor(player.id))
        const act = playerWon ? 0 : 1
        oppEntry.rating = Math.round(oppEntry.rating + K_FACTOR * (act - exp))
        oppEntry.wins += playerWon ? 0 : 1
        oppEntry.losses += playerWon ? 1 : 0
        oppEntry.battles = (oppEntry.battles || 0) + 1
        store.elo[opponentId] = oppEntry
        await saveBlob('elo', store.elo)
      }

      const archetype = archetypeFor(eloEntry, playerWon ? verdict.winStyle : null)

      const duel = {
        id: randomUUID(),
        topic,
        promptId: promptId || null,
        a: { name: player.name, stance: stancePlayer, text: playerText, isBot: false },
        b: {
          name: opponentName || 'Opponent',
          stance: stanceOpponent,
          text: opponentText,
          isBot: !!opponentIsBot,
        },
        verdict,
        createdAt: Date.now(),
        votesA: 0,
        votesB: 0,
      }

      if (publish) {
        store.duels.unshift(duel)
        store.duels = store.duels.slice(0, 200)
        await saveBlob('duels', store.duels)
      }

      res.json({
        verdict,
        elo: {
          rating: eloEntry.rating,
          wins: eloEntry.wins,
          losses: eloEntry.losses,
          streak: eloEntry.streak,
          battles: eloEntry.battles,
        },
        playerWon,
        archetype,
        duelId: publish ? duel.id : null,
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Record a solo Daily Blitz score on today's board.
  app.post('/api/arena/submit', guard, async (req, res) => {
    const { day, promptId, score, roast, stance, name, guestId } = req.body || {}
    if (!day || typeof score !== 'number') {
      return res.status(400).json({ error: 'day and numeric score are required' })
    }
    try {
      const player = await resolveIdentity(req, name, guestId)
      const rows = store.submissions[day] || []
      const existing = rows.find((r) => r.id === player.id)
      if (existing) {
        if (score > existing.score) {
          existing.score = score
          existing.roast = roast || existing.roast
          existing.stance = stance || existing.stance
          existing.at = Date.now()
        }
      } else {
        rows.push({
          id: player.id,
          name: player.name,
          score,
          roast: roast || '',
          stance: stance || '',
          promptId: promptId || null,
          at: Date.now(),
        })
      }
      rows.sort((a, b) => b.score - a.score)
      store.submissions[day] = rows.slice(0, 500)
      await saveBlob('submissions', store.submissions)

      const rank = rows.findIndex((r) => r.id === player.id) + 1
      const percentile = Math.round((1 - (rank - 1) / rows.length) * 100)
      res.json({ rank, total: rows.length, percentile })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Daily leaderboard for a given day (defaults to today, UTC).
  app.get('/api/arena/leaderboard/daily', guard, (req, res) => {
    const day = (req.query.day || new Date().toISOString().slice(0, 10)).toString()
    const rows = (store.submissions[day] || []).slice(0, 100).map((r, i) => ({
      rank: i + 1,
      name: r.name,
      score: r.score,
      roast: r.roast,
      stance: r.stance,
    }))
    res.json({ day, entries: rows })
  })

  // Global ELO ladder.
  app.get('/api/arena/leaderboard/elo', guard, (_req, res) => {
    const entries = Object.values(store.elo)
      .filter((e) => (e.battles || 0) > 0)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 100)
      .map((e, i) => ({
        rank: i + 1,
        name: e.name,
        rating: e.rating,
        wins: e.wins,
        losses: e.losses,
        streak: e.streak,
      }))
    res.json({ entries })
  })

  // Matchmaking: try to pair with a human; resolve quickly so client can bot-fallback.
  app.post('/api/arena/match', guard, async (req, res) => {
    const { promptId, name, guestId } = req.body || {}
    if (!promptId) return res.status(400).json({ error: 'promptId is required' })
    try {
      const player = await resolveIdentity(req, name, guestId)
      const result = await enqueue(promptId, { id: player.id, name: player.name })
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Report live writing progress + final submission into a match room.
  app.post('/api/arena/room/:id/progress', guard, async (req, res) => {
    const room = rooms.get(req.params.id)
    if (!room) return res.status(404).json({ error: 'Room expired' })
    const player = await resolveIdentity(req, req.body?.name, req.body?.guestId)
    const side = roomSideFor(room, player.id)
    if (!side) return res.status(403).json({ error: 'Not in this room' })
    const slot = room[side]
    if (typeof req.body?.progress === 'number') slot.progress = req.body.progress
    if (req.body?.done) {
      slot.text = (req.body.text || '').toString().slice(0, 2000)
      slot.stance = (req.body.stance || '').toString().slice(0, 120)
      slot.done = true
    }
    const opp = room[side === 'A' ? 'B' : 'A']
    res.json({
      opponentProgress: opp.progress,
      opponentDone: opp.done,
      // Only reveal the opponent's text once both are done.
      opponentText: opp.done && slot.done ? opp.text : null,
      opponentStance: opp.done && slot.done ? opp.stance : null,
      opponentName: opp.name,
      bothDone: slot.done && opp.done,
    })
  })

  // Poll a room's state (used while waiting for the opponent to finish).
  app.get('/api/arena/room/:id', guard, async (req, res) => {
    const room = rooms.get(req.params.id)
    if (!room) return res.status(404).json({ error: 'Room expired' })
    const meId = (req.query.guestId ? `g:${req.query.guestId}` : null)
    // Best-effort: also try the bearer identity.
    let side = meId ? roomSideFor(room, meId) : null
    if (!side) {
      const player = await resolveIdentity(req, null, req.query.guestId)
      side = roomSideFor(room, player.id)
    }
    if (!side) return res.status(403).json({ error: 'Not in this room' })
    const me = room[side]
    const opp = room[side === 'A' ? 'B' : 'A']
    res.json({
      opponentProgress: opp.progress,
      opponentDone: opp.done,
      opponentName: opp.name,
      opponentText: opp.done && me.done ? opp.text : null,
      opponentStance: opp.done && me.done ? opp.stance : null,
      bothDone: me.done && opp.done,
    })
  })

  // Create a friend challenge (share a link; friend writes blind, then compares).
  app.post('/api/arena/challenge', guard, async (req, res) => {
    const { topic, promptId, stance, stanceOpponent, text, score, roast, name, guestId } =
      req.body || {}
    if (!topic || !text || !stance || !stanceOpponent) {
      return res.status(400).json({ error: 'topic, stance, stanceOpponent, and text are required' })
    }
    try {
      const player = await resolveIdentity(req, name, guestId)
      const id = randomUUID().slice(0, 8)
      store.challenges[id] = {
        id,
        topic,
        promptId: promptId || null,
        // The stance the friend must defend (the opposite of the challenger).
        friendStance: stanceOpponent,
        challenger: { name: player.name, stance, text, score: score ?? null, roast: roast || '' },
        createdAt: Date.now(),
        attempts: [],
      }
      await saveBlob('challenges', store.challenges)
      res.json({ id })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Fetch a challenge (challenger's text hidden until the friend has submitted).
  app.get('/api/arena/challenge/:id', guard, (req, res) => {
    const c = store.challenges[req.params.id]
    if (!c) return res.status(404).json({ error: 'Challenge not found' })
    res.json({
      id: c.id,
      topic: c.topic,
      promptId: c.promptId,
      challengerName: c.challenger.name,
      challengerStance: c.challenger.stance,
      friendStance: c.friendStance,
      challengerScore: c.challenger.score,
    })
  })

  // Reveal a challenge's full contents (after the friend submits their own).
  app.get('/api/arena/challenge/:id/reveal', guard, (req, res) => {
    const c = store.challenges[req.params.id]
    if (!c) return res.status(404).json({ error: 'Challenge not found' })
    res.json({ id: c.id, topic: c.topic, challenger: c.challenger })
  })

  // Community prompt creation.
  app.post('/api/arena/prompts', guard, async (req, res) => {
    const { topic, stanceA, stanceB, judgeHint, tag, name, guestId } = req.body || {}
    if (!topic || !stanceA || !stanceB) {
      return res.status(400).json({ error: 'topic, stanceA, and stanceB are required' })
    }
    try {
      const player = await resolveIdentity(req, name, guestId)
      const prompt = {
        id: randomUUID().slice(0, 8),
        topic: topic.toString().slice(0, 140),
        stanceA: stanceA.toString().slice(0, 100),
        stanceB: stanceB.toString().slice(0, 100),
        judgeHint: (judgeHint || '').toString().slice(0, 240),
        tag: (tag || 'community').toString().slice(0, 24),
        author: player.name,
        plays: 0,
        createdAt: Date.now(),
      }
      store.prompts.unshift(prompt)
      store.prompts = store.prompts.slice(0, 500)
      await saveBlob('prompts', store.prompts)
      res.json(prompt)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // List community prompts (newest first).
  app.get('/api/arena/prompts', guard, (_req, res) => {
    res.json({ prompts: store.prompts.slice(0, 100) })
  })

  // Public duel gallery.
  app.get('/api/arena/gallery', guard, (_req, res) => {
    const duels = store.duels.slice(0, 60).map((d) => ({
      id: d.id,
      topic: d.topic,
      a: { name: d.a.name, stance: d.a.stance, text: d.a.text, isBot: d.a.isBot },
      b: { name: d.b.name, stance: d.b.stance, text: d.b.text, isBot: d.b.isBot },
      winner: d.verdict?.winner,
      verdict: d.verdict?.verdict,
      roast: d.verdict?.roast,
      votesA: d.votesA,
      votesB: d.votesB,
      createdAt: d.createdAt,
    }))
    res.json({ duels })
  })

  // Crowd vote on a gallery duel.
  app.post('/api/arena/gallery/:id/vote', guard, async (req, res) => {
    const d = store.duels.find((x) => x.id === req.params.id)
    if (!d) return res.status(404).json({ error: 'Duel not found' })
    const side = (req.body?.side || '').toUpperCase()
    if (side === 'A') d.votesA += 1
    else if (side === 'B') d.votesB += 1
    else return res.status(400).json({ error: 'side must be A or B' })
    await saveBlob('duels', store.duels)
    res.json({ votesA: d.votesA, votesB: d.votesB, crowdWinner: d.votesA >= d.votesB ? 'A' : 'B' })
  })
}

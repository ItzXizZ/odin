/**
 * AMC Math Coach accounts + whiteboards.
 *
 * Deliberately independent from the Supabase Google-OAuth flow used by the
 * writing studio: students sign up with just a username and password and are
 * immediately in. Credentials are scrypt-hashed, sessions are opaque bearer
 * tokens, and every whiteboard auto-saves its full snapshot (strokes +
 * pasted images) to Supabase (amc_users / amc_sessions / amc_boards).
 * Run supabase/amc-schema.sql once on the project.
 */

import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import ws from 'ws'

const SCRYPT_KEYLEN = 64
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 90 // 90 days
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/
const MAX_BOARD_BYTES = 8 * 1024 * 1024 // pasted problems are data URLs; cap at 8MB

// ── Supabase client ───────────────────────────────────────────────────
// AMC has its OWN Supabase project (AMC_SUPABASE_*); falls back to the main
// app's project if only that one is configured.
let amcClient = null
function getServiceClient() {
  const url = process.env.AMC_SUPABASE_URL || process.env.SUPABASE_URL
  const secret = process.env.AMC_SUPABASE_SECRET_KEY || process.env.SUPABASE_SECRET_KEY
  if (!url || !secret) return null
  if (!amcClient) {
    amcClient = createClient(url, secret, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: ws },
    })
  }
  return amcClient
}

/** Require a working Supabase client + amc_* tables. Throws if unavailable. */
let readyPromise = null
async function requireDb() {
  if (readyPromise) return readyPromise
  readyPromise = (async () => {
    const supabase = getServiceClient()
    if (!supabase) {
      throw new Error(
        'AMC Supabase not configured (set AMC_SUPABASE_URL + AMC_SUPABASE_SECRET_KEY, or SUPABASE_*).'
      )
    }
    const { error } = await supabase.from('amc_users').select('username_lower').limit(1)
    if (error) {
      throw new Error(
        `AMC Supabase tables missing (run supabase/amc-schema.sql): ${error.message}`
      )
    }
    console.log('  AMC accounts: ✓ Supabase storage')
    return supabase
  })()
  try {
    return await readyPromise
  } catch (err) {
    readyPromise = null
    throw err
  }
}

// ── Password hashing ──────────────────────────────────────────────────

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex')
}

function verifyPassword(password, salt, expectedHex) {
  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN)
  const expected = Buffer.from(expectedHex, 'hex')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

// ── Users ─────────────────────────────────────────────────────────────

async function findUser(usernameLower) {
  const supabase = await requireDb()
  const { data: rows, error } = await supabase
    .from('amc_users')
    .select('username_lower, username, salt, hash')
    .eq('username_lower', usernameLower)
    .limit(1)
  if (error) throw new Error(error.message)
  return rows?.[0] ?? null
}

async function createUser(usernameLower, username, salt, hash) {
  const supabase = await requireDb()
  const { error } = await supabase
    .from('amc_users')
    .insert({ username_lower: usernameLower, username, salt, hash })
  if (error) {
    if (error.code === '23505') return false // unique violation — taken
    throw new Error(error.message)
  }
  return true
}

// ── Sessions ──────────────────────────────────────────────────────────

async function createSession(usernameLower) {
  const token = crypto.randomBytes(32).toString('hex')
  const supabase = await requireDb()
  const { error } = await supabase
    .from('amc_sessions')
    .insert({ token, username_lower: usernameLower })
  if (error) throw new Error(error.message)
  // Opportunistic prune of expired sessions.
  void supabase
    .from('amc_sessions')
    .delete()
    .lt('created_at', new Date(Date.now() - SESSION_TTL_MS).toISOString())
    .then(() => {})
  return token
}

async function deleteSession(token) {
  const supabase = await requireDb()
  await supabase.from('amc_sessions').delete().eq('token', token)
}

/** Resolve the bearer token on a request to { token, usernameLower, username } or null. */
async function sessionFromReq(req) {
  const auth = req.headers.authorization || ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  const token = m[1]

  const supabase = await requireDb()
  const { data: rows, error } = await supabase
    .from('amc_sessions')
    .select('token, username_lower, created_at, amc_users ( username )')
    .eq('token', token)
    .limit(1)
  if (error || !rows?.[0]) return null
  const s = rows[0]
  if (Date.now() - new Date(s.created_at).getTime() > SESSION_TTL_MS) {
    void deleteSession(token)
    return null
  }
  return {
    token,
    usernameLower: s.username_lower,
    username: s.amc_users?.username ?? s.username_lower,
  }
}

// ── Routes ────────────────────────────────────────────────────────────

export function registerAccountRoutes(app) {
  const guard = (handler) => async (req, res) => {
    try {
      await handler(req, res)
    } catch (err) {
      console.warn('  AMC route error:', err.message)
      const missing =
        /not configured|tables missing/i.test(err.message || '') ||
        err.message?.includes('AMC Supabase')
      res
        .status(missing ? 503 : 500)
        .json({ error: missing ? err.message : 'Server error, please try again.' })
    }
  }

  app.post(
    '/api/amc/register',
    guard(async (req, res) => {
      const username = String(req.body?.username ?? '').trim()
      const password = String(req.body?.password ?? '')

      if (!USERNAME_RE.test(username)) {
        return res
          .status(400)
          .json({ error: 'Username must be 3-20 characters: letters, numbers, underscores.' })
      }
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters.' })
      }

      const key = username.toLowerCase()
      const salt = crypto.randomBytes(16).toString('hex')
      const created = await createUser(key, username, salt, hashPassword(password, salt))
      if (!created) {
        return res.status(409).json({ error: 'That username is taken. Try another or log in.' })
      }
      const token = await createSession(key)
      res.json({ token, username })
    })
  )

  app.post(
    '/api/amc/login',
    guard(async (req, res) => {
      const username = String(req.body?.username ?? '').trim()
      const password = String(req.body?.password ?? '')
      const user = await findUser(username.toLowerCase())

      if (!user || !verifyPassword(password, user.salt, user.hash)) {
        return res.status(401).json({ error: 'Wrong username or password.' })
      }
      const token = await createSession(user.username_lower)
      res.json({ token, username: user.username })
    })
  )

  app.get(
    '/api/amc/me',
    guard(async (req, res) => {
      const session = await sessionFromReq(req)
      if (!session) return res.status(401).json({ error: 'Not signed in' })
      res.json({ username: session.username })
    })
  )

  app.post(
    '/api/amc/logout',
    guard(async (req, res) => {
      const session = await sessionFromReq(req)
      if (session) await deleteSession(session.token)
      res.json({ ok: true })
    })
  )

  // ── Whiteboards (auto-saved) ──

  app.get(
    '/api/amc/boards',
    guard(async (req, res) => {
      const session = await sessionFromReq(req)
      if (!session) return res.status(401).json({ error: 'Not signed in' })

      const supabase = await requireDb()
      const { data: rows, error } = await supabase
        .from('amc_boards')
        .select('id, name, created_at')
        .eq('username_lower', session.usernameLower)
        .order('created_at', { ascending: true })
      if (error) throw new Error(error.message)
      res.json({
        boards: rows.map((b) => ({
          id: b.id,
          name: b.name,
          createdAt: new Date(b.created_at).getTime(),
        })),
      })
    })
  )

  app.post(
    '/api/amc/boards',
    guard(async (req, res) => {
      const session = await sessionFromReq(req)
      if (!session) return res.status(401).json({ error: 'Not signed in' })

      const id = String(req.body?.id ?? '').slice(0, 120)
      const name = String(req.body?.name ?? '').trim().slice(0, 80) || 'Untitled'
      if (!id) return res.status(400).json({ error: 'Missing board id' })
      const createdAt = Date.now()

      const supabase = await requireDb()
      // defaultToNull: false — a bare create must not null out existing `data`
      // when the row already exists (PostgREST upsert would wipe the board).
      const { error } = await supabase
        .from('amc_boards')
        .upsert(
          { id, username_lower: session.usernameLower, name },
          { onConflict: 'id', defaultToNull: false }
        )
      if (error) throw new Error(error.message)
      res.json({ board: { id, name, createdAt } })
    })
  )

  app.get(
    '/api/amc/boards/:id',
    guard(async (req, res) => {
      const session = await sessionFromReq(req)
      if (!session) return res.status(401).json({ error: 'Not signed in' })
      const id = req.params.id

      const supabase = await requireDb()
      const { data: rows, error } = await supabase
        .from('amc_boards')
        .select('id, name, data')
        .eq('username_lower', session.usernameLower)
        .eq('id', id)
        .limit(1)
      if (error) throw new Error(error.message)
      if (!rows?.[0]) return res.status(404).json({ error: 'Board not found' })
      res.json({ board: rows[0] })
    })
  )

  app.put(
    '/api/amc/boards/:id',
    guard(async (req, res) => {
      const session = await sessionFromReq(req)
      if (!session) return res.status(401).json({ error: 'Not signed in' })
      const id = req.params.id
      const name =
        req.body?.name != null ? String(req.body.name).trim().slice(0, 80) : undefined
      const boardData = req.body?.data !== undefined ? req.body.data : undefined

      if (boardData !== undefined && JSON.stringify(boardData).length > MAX_BOARD_BYTES) {
        return res.status(413).json({ error: 'Board too large to sync' })
      }

      const incomingSavedAt =
        boardData && typeof boardData === 'object' && typeof boardData.savedAt === 'number'
          ? boardData.savedAt
          : null

      const supabase = await requireDb()
      // Reject out-of-order autosaves so an older in-flight PUT can't clobber
      // a newer snapshot after refresh.
      if (boardData !== undefined && incomingSavedAt != null) {
        const { data: existing, error: readErr } = await supabase
          .from('amc_boards')
          .select('data')
          .eq('username_lower', session.usernameLower)
          .eq('id', id)
          .limit(1)
        if (readErr) throw new Error(readErr.message)
        const prevSaved = existing?.[0]?.data?.savedAt
        if (typeof prevSaved === 'number' && incomingSavedAt < prevSaved) {
          return res.json({ ok: true, skipped: 'stale' })
        }
      }
      const patch = { updated_at: new Date().toISOString() }
      if (name !== undefined) patch.name = name || 'Untitled'
      if (boardData !== undefined) patch.data = boardData
      const { data: updated, error } = await supabase
        .from('amc_boards')
        .update(patch)
        .eq('username_lower', session.usernameLower)
        .eq('id', id)
        .select('id')
      if (error) throw new Error(error.message)
      // Race: auto-save PUT can land before the create POST. Upsert so ink
      // is never silently dropped when the row is missing.
      if (!updated?.length) {
        const { error: upErr } = await supabase.from('amc_boards').upsert({
          id,
          username_lower: session.usernameLower,
          name: name || 'Untitled',
          data: boardData !== undefined ? boardData : null,
          updated_at: patch.updated_at,
        })
        if (upErr) throw new Error(upErr.message)
      }
      res.json({ ok: true })
    })
  )

  app.delete(
    '/api/amc/boards/:id',
    guard(async (req, res) => {
      const session = await sessionFromReq(req)
      if (!session) return res.status(401).json({ error: 'Not signed in' })
      const id = req.params.id

      const supabase = await requireDb()
      const { error } = await supabase
        .from('amc_boards')
        .delete()
        .eq('username_lower', session.usernameLower)
        .eq('id', id)
      if (error) throw new Error(error.message)
      res.json({ ok: true })
    })
  )
}

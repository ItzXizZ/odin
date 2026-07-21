import { createClient } from '@supabase/supabase-js'
import { randomUUID, randomBytes } from 'crypto'
import ws from 'ws'

/** Storage path for a given user's workspace state blob. */
function statePath(userId) {
  return `workspace/${userId || 'default'}.json`
}

// Read lazily: dotenv.config() runs in server.js *after* this module is imported,
// so reading process.env at module top-level would see undefined values.
function cfg() {
  return {
    url: process.env.SUPABASE_URL,
    secret: process.env.SUPABASE_SECRET_KEY,
    assetsBucket: process.env.SUPABASE_ASSETS_BUCKET || 'odin-assets',
    stateBucket: process.env.SUPABASE_STATE_BUCKET || 'odin-state',
  }
}

export function isSupabaseConfigured() {
  const { url, secret } = cfg()
  return Boolean(url && secret)
}

/** Service-role client for other server modules (null when not configured). */
export function getServiceClient() {
  return getClient()
}

let client = null
function getClient() {
  if (!isSupabaseConfigured()) return null
  if (!client) {
    const { url, secret } = cfg()
    client = createClient(url, secret, {
      auth: { persistSession: false, autoRefreshToken: false },
      // Node 20 on Render has no native WebSocket; required for supabase-js RealtimeClient init.
      realtime: { transport: ws },
    })
  }
  return client
}

/** Create the storage buckets if they don't exist yet. Idempotent. */
export async function ensureBuckets() {
  const supabase = getClient()
  if (!supabase) return
  const { assetsBucket, stateBucket } = cfg()
  const buckets = [
    { name: assetsBucket, public: true },
    { name: stateBucket, public: false },
  ]
  for (const b of buckets) {
    const { error } = await supabase.storage.createBucket(b.name, {
      public: b.public,
      fileSizeLimit: '50MB',
    })
    if (error && !/already exists/i.test(error.message)) {
      console.warn(`[supabase] could not ensure bucket "${b.name}":`, error.message)
    }
  }
}

/**
 * Resolve the Supabase user for a bearer access token (the JWT minted by the
 * frontend after Google sign-in). Returns the user object or null if the token
 * is missing/invalid. Verification happens server-side against Supabase Auth.
 */
export async function getUserFromToken(token) {
  const supabase = getClient()
  if (!supabase || !token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data?.user) return null
  return data.user
}

/** Read a user's persisted workspace state blob. Returns the raw string or null. */
export async function getWorkspaceState(userId) {
  const supabase = getClient()
  if (!supabase) return null
  const { stateBucket } = cfg()
  const { data, error } = await supabase.storage.from(stateBucket).download(statePath(userId))
  if (error) {
    // "Object not found" is expected before the first save.
    if (!/not found/i.test(error.message)) {
      console.warn('[supabase] getWorkspaceState failed:', error.message)
    }
    return null
  }
  return await data.text()
}

/** Delete a user's persisted workspace state blob (no-op if missing). */
export async function deleteWorkspaceState(userId) {
  const supabase = getClient()
  if (!supabase) return
  const { stateBucket } = cfg()
  const { error } = await supabase.storage.from(stateBucket).remove([statePath(userId)])
  if (error && !/not found/i.test(error.message)) {
    console.warn('[supabase] deleteWorkspaceState failed:', error.message)
  }
}

/** Remove the legacy communal guest workspace blob (pre-auth isolation). */
export async function purgeSharedGuestWorkspace() {
  await deleteWorkspaceState('default')
}

/** Persist a user's workspace state blob (overwrites that user's object). */
export async function putWorkspaceState(userId, value) {
  const supabase = getClient()
  if (!supabase) throw new Error('Supabase not configured')
  const { stateBucket } = cfg()
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf-8')
  const { error } = await supabase.storage.from(stateBucket).upload(statePath(userId), body, {
    contentType: 'application/json',
    upsert: true,
  })
  if (error) throw new Error(error.message)
}

// ── Subscriptions (card-required free trial via PayPal) ──

const SUBSCRIPTIONS_TABLE = 'subscriptions'

/** Read a user's subscription row (or null if they've never subscribed). */
export async function getSubscription(userId) {
  const supabase = getClient()
  if (!supabase || !userId) return null
  const { data, error } = await supabase
    .from(SUBSCRIPTIONS_TABLE)
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) {
    console.warn('[supabase] getSubscription failed:', error.message)
    return null
  }
  return data
}

/** Look up a subscription row by its provider subscription id (used by webhooks). */
export async function getSubscriptionBySubId(subscriptionId) {
  const supabase = getClient()
  if (!supabase || !subscriptionId) return null
  const { data, error } = await supabase
    .from(SUBSCRIPTIONS_TABLE)
    .select('*')
    .eq('subscription_id', subscriptionId)
    .maybeSingle()
  if (error) {
    console.warn('[supabase] getSubscriptionBySubId failed:', error.message)
    return null
  }
  return data
}

/** Insert/update a user's subscription row. `fields` is merged over user_id. */
export async function upsertSubscription(userId, fields) {
  const supabase = getClient()
  if (!supabase) throw new Error('Supabase not configured')
  if (!userId) throw new Error('Missing userId')
  const row = { user_id: userId, ...fields, updated_at: new Date().toISOString() }
  const { error } = await supabase
    .from(SUBSCRIPTIONS_TABLE)
    .upsert(row, { onConflict: 'user_id' })
  if (error) throw new Error(error.message)
}

// ── Affiliate / invite links ──

const AFFILIATE_LINKS_TABLE = 'affiliate_links'
const AFFILIATE_SIGNUPS_TABLE = 'affiliate_signups'
const AFFILIATE_STORAGE_USER = '__affiliate__'

/** @type {'db' | 'storage' | null} */
let affiliateMode = null

const AFFILIATE_SCHEMA_SQL = `
create table if not exists public.affiliate_links (
  code text primary key,
  name text not null,
  signup_count integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.affiliate_links enable row level security;

create table if not exists public.affiliate_signups (
  user_id uuid primary key references auth.users(id) on delete cascade,
  affiliate_code text not null references public.affiliate_links(code),
  signed_up_at timestamptz not null default now()
);
alter table public.affiliate_signups enable row level security;
`

function supabaseProjectRef() {
  const url = cfg().url || ''
  const m = url.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i)
  return m?.[1] || null
}

async function resolveAffiliateMode() {
  if (affiliateMode) return affiliateMode
  const supabase = getClient()
  if (!supabase) return 'storage'

  const { error } = await supabase.from(AFFILIATE_LINKS_TABLE).select('code').limit(1)
  if (!error) {
    affiliateMode = 'db'
    return affiliateMode
  }

  if (!/does not exist|schema cache/i.test(error.message)) {
    console.warn('[supabase] affiliate schema check failed:', error.message)
    affiliateMode = 'storage'
    return affiliateMode
  }

  const token = (process.env.SUPABASE_ACCESS_TOKEN || '').trim()
  const ref = supabaseProjectRef()
  if (token && ref) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: AFFILIATE_SCHEMA_SQL }),
    })
    if (res.ok) {
      affiliateMode = 'db'
      console.log('[supabase] affiliate tables created (or already existed).')
      return affiliateMode
    }
    console.warn('[supabase] affiliate schema migration failed:', (await res.text()).slice(0, 300))
  }

  affiliateMode = 'storage'
  console.log('[supabase] affiliate tracking using storage fallback (no DB tables yet).')
  return affiliateMode
}

/** Create affiliate tables via Management API when possible; otherwise use storage. */
export async function ensureAffiliateSchema() {
  await resolveAffiliateMode()
}

function emptyAffiliateBlob() {
  return { links: {}, signups: {} }
}

async function readAffiliateBlob() {
  const raw = await getWorkspaceState(AFFILIATE_STORAGE_USER)
  if (!raw) return emptyAffiliateBlob()
  try {
    const parsed = JSON.parse(raw)
    return {
      links: parsed.links && typeof parsed.links === 'object' ? parsed.links : {},
      signups: parsed.signups && typeof parsed.signups === 'object' ? parsed.signups : {},
    }
  } catch {
    return emptyAffiliateBlob()
  }
}

async function writeAffiliateBlob(data) {
  await putWorkspaceState(AFFILIATE_STORAGE_USER, JSON.stringify(data))
}

function sortAffiliateLinks(links, limit = 50) {
  return Object.values(links)
    .sort((a, b) => {
      if (b.signup_count !== a.signup_count) return b.signup_count - a.signup_count
      return String(a.name).localeCompare(String(b.name))
    })
    .slice(0, limit)
}

function affiliateSlug(name) {
  const slug = String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
  return slug || 'friend'
}

function affiliateSuffix() {
  return randomBytes(3).toString('hex')
}

/** Create a unique affiliate link for a display name. */
export async function createAffiliateLink(name) {
  const supabase = getClient()
  if (!supabase) throw new Error('Supabase not configured')

  const trimmed = String(name || '').trim()
  if (!trimmed || trimmed.length < 2) throw new Error('Name must be at least 2 characters')
  if (trimmed.length > 60) throw new Error('Name must be 60 characters or fewer')

  const base = affiliateSlug(trimmed)
  const candidates = [base, `${base}-${affiliateSuffix()}`, `${base}-${affiliateSuffix()}`]
  const mode = await resolveAffiliateMode()

  if (mode === 'storage') {
    const blob = await readAffiliateBlob()
    for (const code of candidates) {
      if (blob.links[code]) continue
      blob.links[code] = {
        code,
        name: trimmed,
        signup_count: 0,
        created_at: new Date().toISOString(),
      }
      await writeAffiliateBlob(blob)
      return { code, name: trimmed }
    }
    throw new Error('Could not generate a unique link — try again')
  }

  for (const code of candidates) {
    const { data: existing } = await supabase
      .from(AFFILIATE_LINKS_TABLE)
      .select('code')
      .eq('code', code)
      .maybeSingle()
    if (existing) continue

    const { error } = await supabase.from(AFFILIATE_LINKS_TABLE).insert({
      code,
      name: trimmed,
      signup_count: 0,
    })
    if (!error) return { code, name: trimmed }
    if (!/duplicate|unique/i.test(error.message)) throw new Error(error.message)
  }

  throw new Error('Could not generate a unique link — try again')
}

/** Leaderboard sorted by signup count (desc), then name. */
export async function getAffiliateLeaderboard(limit = 50) {
  const supabase = getClient()
  if (!supabase) return []

  const mode = await resolveAffiliateMode()
  if (mode === 'storage') {
    const blob = await readAffiliateBlob()
    return sortAffiliateLinks(blob.links, limit)
  }

  const { data, error } = await supabase
    .from(AFFILIATE_LINKS_TABLE)
    .select('code, name, signup_count, created_at')
    .order('signup_count', { ascending: false })
    .order('name', { ascending: true })
    .limit(limit)

  if (error) {
    console.warn('[supabase] getAffiliateLeaderboard failed:', error.message)
    return []
  }
  return data ?? []
}

/** Look up a single affiliate link by code. */
export async function getAffiliateLink(code) {
  const supabase = getClient()
  if (!supabase || !code) return null

  const normalized = String(code).toLowerCase().trim()
  const mode = await resolveAffiliateMode()
  if (mode === 'storage') {
    const blob = await readAffiliateBlob()
    return blob.links[normalized] ?? null
  }

  const { data, error } = await supabase
    .from(AFFILIATE_LINKS_TABLE)
    .select('code, name, signup_count, created_at')
    .eq('code', normalized)
    .maybeSingle()

  if (error) {
    console.warn('[supabase] getAffiliateLink failed:', error.message)
    return null
  }
  return data
}

/**
 * Attribute a new sign-up to an affiliate code (once per user).
 * Returns { ok, reason?, link? }.
 */
export async function claimAffiliateSignup(userId, code, userCreatedAt) {
  const supabase = getClient()
  if (!supabase) throw new Error('Supabase not configured')
  if (!userId || !code) return { ok: false, reason: 'missing' }

  const normalized = String(code).toLowerCase().trim()
  if (!normalized) return { ok: false, reason: 'invalid_code' }

  const link = await getAffiliateLink(normalized)
  if (!link) return { ok: false, reason: 'unknown_code' }

  if (userCreatedAt) {
    const ageMs = Date.now() - new Date(userCreatedAt).getTime()
    // Only attribute brand-new accounts (not returning users who clicked a link).
    if (ageMs > 48 * 60 * 60 * 1000) return { ok: false, reason: 'too_late' }
  }

  const mode = await resolveAffiliateMode()
  if (mode === 'storage') {
    const blob = await readAffiliateBlob()
    if (blob.signups[userId]) return { ok: false, reason: 'already_claimed' }
    blob.signups[userId] = normalized
    blob.links[normalized].signup_count = (blob.links[normalized].signup_count || 0) + 1
    await writeAffiliateBlob(blob)
    return { ok: true, link: blob.links[normalized] }
  }

  const { data: existing } = await supabase
    .from(AFFILIATE_SIGNUPS_TABLE)
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (existing) return { ok: false, reason: 'already_claimed' }

  const { error: insertError } = await supabase.from(AFFILIATE_SIGNUPS_TABLE).insert({
    user_id: userId,
    affiliate_code: normalized,
  })
  if (insertError) {
    if (/duplicate|unique/i.test(insertError.message)) return { ok: false, reason: 'already_claimed' }
    throw new Error(insertError.message)
  }

  const { data: updated, error: countError } = await supabase
    .from(AFFILIATE_LINKS_TABLE)
    .update({ signup_count: link.signup_count + 1 })
    .eq('code', normalized)
    .select('code, name, signup_count')
    .single()

  if (countError) console.warn('[supabase] increment affiliate signup_count failed:', countError.message)

  return { ok: true, link: updated ?? { ...link, signup_count: link.signup_count + 1 } }
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) return null
  return { contentType: match[1], buffer: Buffer.from(match[2], 'base64') }
}

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
}

/**
 * Upload a binary asset and return its public URL.
 * Accepts either a data URL or an explicit base64 + contentType.
 */
export async function uploadAsset({ dataUrl, base64, contentType, name, userId }) {
  const supabase = getClient()
  if (!supabase) throw new Error('Supabase not configured')
  const { assetsBucket } = cfg()

  let buffer
  let mime = contentType
  if (dataUrl) {
    const parsed = parseDataUrl(dataUrl)
    if (!parsed) throw new Error('Invalid data URL')
    buffer = parsed.buffer
    mime = mime || parsed.contentType
  } else if (base64) {
    buffer = Buffer.from(base64, 'base64')
  } else {
    throw new Error('No asset data provided')
  }
  mime = mime || 'application/octet-stream'

  const ext = EXT_BY_MIME[mime] || 'bin'
  const safeName = (name || 'asset').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
  const owner = userId || 'shared'
  const path = `${owner}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${safeName}.${ext}`

  const { error } = await supabase.storage.from(assetsBucket).upload(path, buffer, {
    contentType: mime,
    upsert: false,
  })
  if (error) throw new Error(error.message)

  const { data } = supabase.storage.from(assetsBucket).getPublicUrl(path)
  return data.publicUrl
}

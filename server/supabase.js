import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
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

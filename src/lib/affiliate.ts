import { getAccessToken } from './supabase'
import { buildInviteUrl } from './referral'

export interface AffiliateEntry {
  code: string
  name: string
  signup_count: number
  created_at: string
}

export interface AffiliateLink {
  code: string
  name: string
  url: string
  signup_count?: number
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    const preview = text.trimStart().slice(0, 80)
    if (preview.startsWith('<!DOCTYPE') || preview.startsWith('<html')) {
      throw new Error(
        'Backend API unavailable — restart the server (npm run dev) so /api routes are live.',
      )
    }
    throw new Error('Server returned an invalid response')
  }
}

export async function fetchAffiliateLeaderboard(): Promise<{
  enabled: boolean
  entries: AffiliateEntry[]
}> {
  const res = await fetch('/api/affiliate/leaderboard')
  const data = await readJson<{ enabled: boolean; entries: AffiliateEntry[]; error?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Could not load leaderboard')
  return data
}

export async function createAffiliateLink(name: string): Promise<AffiliateLink> {
  const res = await fetch('/api/affiliate/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const data = await readJson<AffiliateLink & { error?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Could not create link')
  return data
}

export async function fetchAffiliateLink(code: string): Promise<AffiliateLink | null> {
  const res = await fetch(`/api/affiliate/${encodeURIComponent(code)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error('Could not load link')
  return readJson<AffiliateLink>(res)
}

export async function claimAffiliateReferral(
  code: string,
  accessToken?: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  const token = accessToken ?? (await getAccessToken())
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch('/api/affiliate/claim', {
    method: 'POST',
    headers,
    body: JSON.stringify({ code: code.trim().toLowerCase() }),
  })
  if (res.status === 401) return { ok: false, reason: 'unauthorized' }
  const data = await readJson<{ ok: boolean; reason?: string; error?: string }>(res)
  if (!res.ok) throw new Error(data.error || 'Claim failed')
  return data
}

export { buildInviteUrl }

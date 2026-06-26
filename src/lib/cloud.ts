/**
 * Client helpers for Supabase-backed storage, routed through the Express API
 * (the frontend never holds the Supabase secret key — only the user's access
 * token, which the server verifies before scoping the upload to that account).
 */
import { getAccessToken } from './supabase'

/**
 * Upload a binary asset (data URL) to Supabase Storage and return its public URL.
 *
 * Degrades gracefully: if the upload fails (offline, Supabase not configured,
 * server down), it returns the original data URL so the app keeps working —
 * the only downside is that blob still lives in the local state until re-saved.
 */
export async function uploadAsset(dataUrl: string, name = 'asset'): Promise<string> {
  // Already a remote URL (or empty) — nothing to upload.
  if (!dataUrl || !dataUrl.startsWith('data:')) return dataUrl
  try {
    const token = await getAccessToken()
    const res = await fetch('/api/storage/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ dataUrl, name }),
    })
    if (!res.ok) return dataUrl
    const { url } = await res.json()
    return typeof url === 'string' && url ? url : dataUrl
  } catch {
    return dataUrl
  }
}

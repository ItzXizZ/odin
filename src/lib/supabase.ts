/**
 * Frontend Supabase client — used ONLY for authentication (Google OAuth).
 *
 * This holds the *publishable* (anon) key, which is safe to expose to the
 * browser. All data writes still flow through the Express API, which verifies
 * the user's access token with the server-side secret key before persisting.
 *
 * If the auth env vars are missing the client is null and the app runs in
 * legacy "local mode" (no login required, shared/local persistence).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isAuthConfigured = Boolean(url && anonKey)

export const supabase: SupabaseClient | null = isAuthConfigured
  ? createClient(url as string, anonKey as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null

/** Current access token (JWT) for authorizing API calls, or null if signed out. */
export async function getAccessToken(): Promise<string | null> {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

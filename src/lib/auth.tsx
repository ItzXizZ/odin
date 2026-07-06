/**
 * Auth context — wraps the app with Supabase Google authentication.
 *
 * Responsibilities:
 *  - Track the current session/user.
 *  - Tell the persistence layer which user is active (so cloud + local data is
 *    scoped per person) and (re)hydrate the Zustand store when identity changes.
 *  - Expose sign-in / sign-out actions.
 *
 * When Supabase auth isn't configured, the provider runs in "local mode":
 * it hydrates immediately and never requires a login.
 */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase, isAuthConfigured, setCachedAccessToken } from './supabase'
import { useStore } from '../store/useStore'
import { setWorkspaceUser } from './workspaceStorage'
import {
  clearSignupCompleteLandingUrl,
  isSignupCompleteLanding,
  oauthSignInUrl,
  oauthSignupCompleteUrl,
  trackSignupConversion,
} from './oauthRedirect'
import { claimAffiliateReferral } from './affiliate'
import {
  captureReferralFromUrl,
  clearStoredReferralCode,
  getStoredReferralCode,
  persistReferralCode,
  restorePendingReferralCode,
} from './referral'

interface AuthState {
  /** Whether Google auth is configured (and therefore a login is required). */
  authEnabled: boolean
  /** True once the initial session check has finished. */
  ready: boolean
  user: User | null
  session: Session | null
  signInWithGoogle: (options?: { afterSignup?: boolean }) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const lastUserId = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    // Local mode — no auth configured. Hydrate the store and render the app.
    if (!isAuthConfigured || !supabase) {
      setWorkspaceUser(null)
      void useStore.persist.rehydrate()
      setReady(true)
      return
    }

    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      // Synchronous, lock-safe work only inside the callback.
      setCachedAccessToken(sess?.access_token ?? null)
      setSession(sess)
      setUser(sess?.user ?? null)

      const uid = sess?.user?.id ?? null
      const identityChanged = uid !== lastUserId.current
      lastUserId.current = uid

      // Defer anything that might touch Supabase or trigger store rehydration:
      // supabase-js holds an auth lock during this callback, so calling auth
      // methods now (directly or via getAccessToken) would deadlock.
      setTimeout(() => {
        // Only (re)hydrate when the identity actually changes — not on every
        // token refresh, which would clobber unsaved in-memory edits.
        if (identityChanged) {
          setWorkspaceUser(uid)
          void useStore.persist.rehydrate()
        }
        setReady(true)
      }, 0)
    })

    return () => sub.subscription.unsubscribe()
  }, [])

  async function signInWithGoogle(options?: { afterSignup?: boolean }) {
    if (!supabase) return
    captureReferralFromUrl()
    const ref = getStoredReferralCode()
    if (ref) persistReferralCode(ref)

    const redirectTo = options?.afterSignup
      ? oauthSignupCompleteUrl()
      : oauthSignInUrl()
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    })
  }

  async function signOut() {
    if (!supabase) return
    await supabase.auth.signOut()
    // Hard reload so the next person starts from a clean in-memory store.
    window.location.reload()
  }

  return (
    <AuthContext.Provider
      value={{
        authEnabled: isAuthConfigured,
        ready,
        user,
        session,
        signInWithGoogle,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}

/** After Google OAuth, normalize the signup-complete URL and track conversions. */
export function SignupCompleteHandler() {
  const { ready, user } = useAuth()

  useEffect(() => {
    if (!ready || !user || !isSignupCompleteLanding()) return
    trackSignupConversion(user)
    clearSignupCompleteLandingUrl()
  }, [ready, user])

  return null
}

/** Attribute a new sign-up to a stored ?ref= code once auth finishes. */
export function ReferralClaimHandler() {
  useEffect(() => {
    if (!supabase) return

    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      if (!sess?.user || !sess.access_token) return
      if (event !== 'SIGNED_IN' && event !== 'INITIAL_SESSION') return

      restorePendingReferralCode()

      const ref = getStoredReferralCode()
      if (!ref) return

      const userId = sess.user.id
      const doneKey = `odin-ref-claimed-${userId}`
      if (sessionStorage.getItem(doneKey)) return

      const accountAge = Date.now() - new Date(sess.user.created_at).getTime()
      const oneHour = 60 * 60 * 1000

      if (event === 'INITIAL_SESSION' && accountAge > oneHour) {
        if (accountAge > 7 * 24 * 60 * 60 * 1000) clearStoredReferralCode()
        return
      }

      if (event !== 'SIGNED_IN' && accountAge > oneHour) return

      void (async () => {
        let retries = 0
        while (retries < 5) {
          const result = await claimAffiliateReferral(ref, sess.access_token)
          if (result.ok || result.reason === 'already_claimed' || result.reason === 'too_late') {
            sessionStorage.setItem(doneKey, '1')
            clearStoredReferralCode()
            return
          }
          if (result.reason !== 'unauthorized') return
          retries++
          await new Promise((r) => setTimeout(r, 300 * retries))
        }
      })()
    })

    return () => sub.subscription.unsubscribe()
  }, [])

  return null
}

/** Capture ?ref= from invite links on any page load. */
export function ReferralCapture() {
  useEffect(() => {
    captureReferralFromUrl()
  }, [])
  return null
}

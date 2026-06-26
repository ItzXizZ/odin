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
import { supabase, isAuthConfigured } from './supabase'
import { useStore } from '../store/useStore'
import { setWorkspaceUser } from './workspaceStorage'

interface AuthState {
  /** Whether Google auth is configured (and therefore a login is required). */
  authEnabled: boolean
  /** True once the initial session check has finished. */
  ready: boolean
  user: User | null
  session: Session | null
  signInWithGoogle: () => Promise<void>
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
      setSession(sess)
      setUser(sess?.user ?? null)

      const uid = sess?.user?.id ?? null
      // Only (re)hydrate when the identity actually changes — not on every
      // token refresh, which would clobber unsaved in-memory edits.
      if (uid !== lastUserId.current) {
        lastUserId.current = uid
        setWorkspaceUser(uid)
        void useStore.persist.rehydrate()
      }
      setReady(true)
    })

    return () => sub.subscription.unsubscribe()
  }, [])

  async function signInWithGoogle() {
    if (!supabase) return
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
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

import type { StateStorage } from 'zustand/middleware'
import { getAccessToken } from './supabase'

/**
 * Persistence adapter for the Zustand store.
 *
 * Source of truth is Supabase (via the Express `/api/workspace` endpoints), with
 * localStorage kept as an offline mirror and as the migration source for users
 * who already have local data. Data is scoped per signed-in user: each request
 * carries the user's access token, and the local mirror key is namespaced by
 * user id so multiple people on one browser never see each other's work.
 *
 * Saving rules (designed for "constantly saving" without hammering the network):
 *  - writes are debounced ~800ms after the last change,
 *  - but force-flushed at least every MAX_WAIT_MS during continuous editing,
 *  - and flushed on tab close.
 *
 * Two correctness guards learned the hard way:
 *  - Normal saves must NOT use `fetch(keepalive:true)` — keepalive caps the body
 *    at 64KB, so larger workspaces would silently fail to save. keepalive is only
 *    used for the best-effort flush during page unload.
 *  - Cloud writes are gated until the initial load (getItem) completes, so the
 *    app's default boot state can never overwrite real saved data (hydration race).
 */

const DEBOUNCE_MS = 800
const MAX_WAIT_MS = 5000
const SAVED_NOTICE_MS = 2000

export type WorkspaceSaveStatus = 'idle' | 'saving' | 'saved' | 'error'

let hydrated = false
let pendingValue: string | null = null
let firstPendingAt = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null
let saveStatus: WorkspaceSaveStatus = 'idle'
let savedNoticeTimer: ReturnType<typeof setTimeout> | null = null
const saveStatusListeners = new Set<(status: WorkspaceSaveStatus) => void>()

function setSaveStatus(next: WorkspaceSaveStatus) {
  if (saveStatus === next) return
  saveStatus = next
  for (const listener of saveStatusListeners) listener(next)
}

export function getWorkspaceSaveStatus(): WorkspaceSaveStatus {
  return saveStatus
}

/** Subscribe to cloud sync status (local mirror updates are instant and not reported). */
export function subscribeWorkspaceSaveStatus(listener: (status: WorkspaceSaveStatus) => void) {
  saveStatusListeners.add(listener)
  listener(saveStatus)
  return () => {
    saveStatusListeners.delete(listener)
  }
}

/** Active user id — set by the auth layer so storage can be scoped per person. */
let currentUserId: string | null = null

/**
 * Bind persistence to a specific user (or null for local/anonymous mode).
 * Called by the auth provider whenever the signed-in identity changes; it also
 * resets the hydration gate so the next load is treated as a fresh boot.
 */
export function setWorkspaceUser(userId: string | null) {
  if (userId === currentUserId) return
  currentUserId = userId
  hydrated = false
  clearTimer()
  pendingValue = null
  firstPendingAt = 0
}

/** Namespace the local mirror key per user to avoid cross-account leakage. */
function localKey(name: string): string {
  return currentUserId ? `${name}:${currentUserId}` : name
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function mirrorToLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Quota exceeded or unavailable — cloud copy is authoritative, so ignore.
  }
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

async function pushToCloud(value: string, useKeepalive = false): Promise<boolean> {
  try {
    const res = await fetch('/api/workspace', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ value }),
      ...(useKeepalive ? { keepalive: true } : {}),
    })
    return res.ok
  } catch {
    return false
  }
}

function clearTimer() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

function flushNow(useKeepalive = false) {
  clearTimer()
  if (pendingValue == null) return
  const value = pendingValue
  pendingValue = null
  firstPendingAt = 0
  if (savedNoticeTimer) {
    clearTimeout(savedNoticeTimer)
    savedNoticeTimer = null
  }
  setSaveStatus('saving')
  void pushToCloud(value, useKeepalive).then((ok) => {
    if (pendingValue != null) {
      setSaveStatus('saving')
      schedule()
      return
    }
    if (ok) {
      setSaveStatus('saved')
      savedNoticeTimer = setTimeout(() => {
        savedNoticeTimer = null
        if (pendingValue == null) setSaveStatus('idle')
      }, SAVED_NOTICE_MS)
    } else {
      setSaveStatus('error')
    }
  })
}

function schedule() {
  clearTimer()
  const elapsed = Date.now() - firstPendingAt
  const wait = Math.min(DEBOUNCE_MS, Math.max(0, MAX_WAIT_MS - elapsed))
  flushTimer = setTimeout(() => flushNow(false), wait)
}

// Make sure the last edit isn't lost when the tab closes (best-effort).
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => flushNow(true))
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow(true)
  })
}

export const workspaceStorage: StateStorage = {
  async getItem(name) {
    const key = localKey(name)
    try {
      const res = await fetch('/api/workspace', { headers: await authHeaders() })
      if (res.ok) {
        const { value } = (await res.json()) as { value: string | null }
        if (value != null) {
          mirrorToLocal(key, value)
          return value
        }
        // Cloud is empty — migrate existing local data up, if any.
        const local = readLocal(key)
        if (local != null) void pushToCloud(local)
        return local
      }
    } catch {
      // Network/server error — fall through to the local mirror.
    } finally {
      hydrated = true
    }
    return readLocal(key)
  },

  setItem(name, value) {
    // Always keep the local mirror fresh (cheap, offline-friendly).
    mirrorToLocal(localKey(name), value)
    // Don't let pre-hydration boot state overwrite real saved data.
    if (!hydrated) return
    pendingValue = value
    if (!firstPendingAt) firstPendingAt = Date.now()
    if (savedNoticeTimer) {
      clearTimeout(savedNoticeTimer)
      savedNoticeTimer = null
    }
    setSaveStatus('saving')
    schedule()
  },

  removeItem(name) {
    try {
      localStorage.removeItem(localKey(name))
    } catch {
      // ignore
    }
    clearTimer()
    pendingValue = null
    firstPendingAt = 0
  },
}

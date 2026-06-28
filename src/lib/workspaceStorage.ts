import type { StateStorage } from 'zustand/middleware'
import { getAccessToken } from './supabase'
import { useStore } from '../store/useStore'
import {
  isDestructiveWorkspaceWipe,
  isLocalWorkspaceRicher,
} from './workspaceGuards'

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
 * Correctness guards (each learned the hard way — they prevent silent DATA LOSS):
 *  - Normal saves must NOT use `fetch(keepalive:true)` — keepalive caps the body
 *    at 64KB, so larger workspaces would silently fail to save. keepalive is only
 *    used for the best-effort flush during page unload.
 *  - Cloud writes are gated until the initial load (getItem) *positively
 *    succeeds*. If the load fails (network blip, server cold-start 502/503, etc.)
 *    we still render from the local mirror, but we DO NOT push to the cloud —
 *    otherwise a stale/default boot state would overwrite the user's real saved
 *    data the moment the server comes back. A background loader keeps retrying so
 *    sync resumes automatically once the server is reachable again.
 */

const DEBOUNCE_MS = 800
const MAX_WAIT_MS = 5000
const SAVED_NOTICE_MS = 2000
const LOAD_TIMEOUT_MS = 15000
const LOAD_RETRIES = 2 // initial-load attempts beyond the first (so 3 total)
const RECOVERY_INTERVAL_MS = 8000
const RECOVERY_MAX_ATTEMPTS = 30

export type WorkspaceSaveStatus = 'idle' | 'saving' | 'saved' | 'error'

let hydrated = false
/**
 * True only after the cloud load *confirmed* a reachable backend (returned data,
 * or confirmed-empty). Until this is true we never PUT to the cloud, so a failed
 * load can't let boot/default/stale state clobber real saved data.
 */
let cloudWritable = false
/** Whether the user has changed state since the last (attempted) load. */
let editedSinceLoad = false
let pendingValue: string | null = null
let firstPendingAt = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null
let recoveryTimer: ReturnType<typeof setTimeout> | null = null
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
 * resets the load/hydration gates so the next load is treated as a fresh boot.
 */
export function setWorkspaceUser(userId: string | null) {
  if (userId === currentUserId) return
  currentUserId = userId
  hydrated = false
  cloudWritable = false
  editedSinceLoad = false
  clearTimer()
  stopRecovery()
  pendingValue = null
  firstPendingAt = 0
}

/** For namespacing other local mirrors (e.g. embed scroll positions). */
export function getWorkspaceStorageUserId(): string | null {
  return currentUserId
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

type LoadResult =
  | { status: 'ok'; value: string }
  | { status: 'empty' }
  | { status: 'localMode' } // backend reachable but Supabase not configured (501)
  | { status: 'error' }

/** Single attempt to read the workspace blob from the cloud. */
async function loadWorkspaceOnce(): Promise<LoadResult> {
  try {
    const res = await fetch('/api/workspace', {
      headers: await authHeaders(),
      signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
    })
    if (res.ok) {
      const { value } = (await res.json()) as { value: string | null }
      return value != null ? { status: 'ok', value } : { status: 'empty' }
    }
    // 501 → Supabase not configured: there is no cloud, run local-only.
    if (res.status === 501) return { status: 'localMode' }
    // 401/5xx/etc → couldn't confirm the cloud state this time.
    return { status: 'error' }
  } catch {
    return { status: 'error' }
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

function stopRecovery() {
  if (recoveryTimer) {
    clearTimeout(recoveryTimer)
    recoveryTimer = null
  }
}

function flushNow(useKeepalive = false) {
  clearTimer()
  if (pendingValue == null) return
  // Hard guard: never write to the cloud before a confirmed successful load.
  if (!cloudWritable) {
    pendingValue = null
    firstPendingAt = 0
    return
  }
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

/**
 * Recover sync after a failed initial load (e.g. the server was cold-starting).
 * Retries the cloud read in the background. Once it succeeds:
 *  - if the user hasn't edited yet, re-hydrate from the cloud (adopt real data);
 *  - if they have edited, enable cloud writes so their in-memory work syncs up
 *    (their explicit edits win over the stale snapshot we booted from).
 * It never blindly overwrites the cloud with default boot state.
 */
function startRecovery(localKeyName: string) {
  stopRecovery()
  let attempts = 0
  const tick = async () => {
    attempts++
    const result = await loadWorkspaceOnce()
    if (result.status === 'error') {
      if (attempts >= RECOVERY_MAX_ATTEMPTS) {
        stopRecovery()
        return
      }
      recoveryTimer = setTimeout(tick, RECOVERY_INTERVAL_MS)
      return
    }
    stopRecovery()
    if (result.status === 'localMode') return // no cloud to sync with

    // Backend is reachable again.
    if (!editedSinceLoad) {
      // Safe to adopt the cloud copy — the user hasn't changed anything yet.
      void useStore.persist.rehydrate()
    } else {
      // Preserve the user's edits and let them flow up to the cloud.
      if (result.status === 'ok') mirrorToLocal(localKeyName, result.value)
      cloudWritable = true
      if (pendingValue != null) schedule()
    }
  }
  recoveryTimer = setTimeout(tick, RECOVERY_INTERVAL_MS)
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
    cloudWritable = false
    editedSinceLoad = false
    stopRecovery()

    let result: LoadResult = { status: 'error' }
    for (let attempt = 0; attempt <= LOAD_RETRIES; attempt++) {
      result = await loadWorkspaceOnce()
      if (result.status !== 'error') break
      // brief backoff before retrying (covers a server cold-start window)
      if (attempt < LOAD_RETRIES) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
    }

    hydrated = true

    if (result.status === 'ok') {
      cloudWritable = true
      const local = readLocal(key)
      // Never let a stale/empty cloud snapshot clobber a richer local mirror.
      if (local != null && isLocalWorkspaceRicher(local, result.value)) {
        mirrorToLocal(key, local)
        void pushToCloud(local)
        return local
      }
      mirrorToLocal(key, result.value)
      return result.value
    }

    if (result.status === 'empty') {
      // Cloud reachable but empty — safe to write, and migrate local data up.
      cloudWritable = true
      const local = readLocal(key)
      if (local != null) void pushToCloud(local)
      return local
    }

    if (result.status === 'localMode') {
      // No cloud backend; run purely on the local mirror.
      return readLocal(key)
    }

    // status === 'error': render from the local mirror but keep the cloud
    // read-only until we can confirm its contents, so we never clobber it.
    setSaveStatus('error')
    startRecovery(key)
    return readLocal(key)
  },

  setItem(name, value) {
    const key = localKey(name)
    const existing = readLocal(key)
    // Block boot/hydration races from wiping real saved progress.
    if (existing && isDestructiveWorkspaceWipe(existing, value)) {
      return
    }
    // Always keep the local mirror fresh (cheap, offline-friendly).
    mirrorToLocal(key, value)
    // Don't let pre-hydration boot state overwrite real saved data.
    if (!hydrated) return
    editedSinceLoad = true
    // Cloud writes are gated on a confirmed successful load (see file header).
    if (!cloudWritable) return
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
    stopRecovery()
    pendingValue = null
    firstPendingAt = 0
  },
}

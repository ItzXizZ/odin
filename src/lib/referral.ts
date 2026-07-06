const REF_KEY = 'odin-affiliate-ref'
const SESSION_REF_KEY = 'odin-affiliate-ref-oauth'
const MY_LINK_KEY = 'odin-my-affiliate-code'

/** Persist referral code in both storages so it survives the OAuth round-trip. */
export function persistReferralCode(code: string): void {
  if (typeof window === 'undefined') return
  const normalized = code.trim().toLowerCase()
  localStorage.setItem(REF_KEY, normalized)
  sessionStorage.setItem(REF_KEY, normalized)
  sessionStorage.setItem(SESSION_REF_KEY, normalized)
}

/** Read `?ref=` from the URL and persist it for later signup attribution. */
export function captureReferralFromUrl(): void {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.search)
  const ref = params.get('ref')?.trim().toLowerCase()
  if (!ref) return

  persistReferralCode(ref)

  params.delete('ref')
  const qs = params.toString()
  const next = `${window.location.pathname}${qs ? `?${qs}` : ''}`
  window.history.replaceState({}, '', next)
}

/** Restore referral code from sessionStorage after OAuth redirect. */
export function restorePendingReferralCode(): void {
  if (typeof window === 'undefined') return
  if (localStorage.getItem(REF_KEY)) return
  const pending =
    sessionStorage.getItem(SESSION_REF_KEY) || sessionStorage.getItem(REF_KEY)
  if (pending) localStorage.setItem(REF_KEY, pending)
}

export function getStoredReferralCode(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(REF_KEY) || sessionStorage.getItem(SESSION_REF_KEY)
}

export function clearStoredReferralCode(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(REF_KEY)
  sessionStorage.removeItem(REF_KEY)
  sessionStorage.removeItem(SESSION_REF_KEY)
}

export function saveMyAffiliateCode(code: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(MY_LINK_KEY, code.toLowerCase())
}

export function getMyAffiliateCode(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(MY_LINK_KEY)
}

export function buildInviteUrl(code: string, origin = window.location.origin): string {
  return `${origin}/?ref=${encodeURIComponent(code)}`
}

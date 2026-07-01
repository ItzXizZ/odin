import type { User } from '@supabase/supabase-js'

/** Post–Google OAuth landing path (whitelist in Supabase redirect URLs). */
export const OAUTH_SIGNUP_COMPLETE_PATH = '/signup-complete'

export function oauthSignupCompleteUrl(origin = window.location.origin): string {
  return `${origin}${OAUTH_SIGNUP_COMPLETE_PATH}`
}

export function oauthSignInUrl(origin = window.location.origin): string {
  return `${origin}/`
}

/** True on the dedicated signup-complete page or legacy `/?signup=success`. */
export function isSignupCompleteLanding(): boolean {
  if (typeof window === 'undefined') return false
  if (window.location.pathname === OAUTH_SIGNUP_COMPLETE_PATH) return true
  return new URLSearchParams(window.location.search).get('signup') === 'success'
}

/** Strip signup landing markers once Supabase has finished exchanging the OAuth code. */
export function clearSignupCompleteLandingUrl(): void {
  if (typeof window === 'undefined') return
  if (!isSignupCompleteLanding()) return
  window.history.replaceState({}, '', '/')
}

const CONVERSION_KEY = 'odin-signup-conversion-fired'

/** Fire Google Ads / GTM signup conversion once per browser session. */
export function trackSignupConversion(user: User | null): void {
  if (!user || typeof window === 'undefined') return
  if (sessionStorage.getItem(CONVERSION_KEY)) return
  sessionStorage.setItem(CONVERSION_KEY, '1')

  const sendTo = import.meta.env.VITE_GOOGLE_ADS_CONVERSION as string | undefined
  const gtag = (window as Window & { gtag?: (...args: unknown[]) => void }).gtag
  if (sendTo && typeof gtag === 'function') {
    gtag('event', 'conversion', { send_to: sendTo })
  }

  const dataLayer = (window as Window & { dataLayer?: Record<string, unknown>[] }).dataLayer
  dataLayer?.push({ event: 'signup_complete', user_id: user.id })
}

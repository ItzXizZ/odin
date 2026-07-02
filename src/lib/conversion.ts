/**
 * Google Ads conversion tracking for the free-trial funnel.
 *
 * The meaningful conversion for a paid trial is the moment the trial *starts*
 * (card captured on Stripe), not the Google sign-in. This fires the "Subscribe"
 * conversion once per browser session when the user returns from a successful
 * checkout.
 */

// The Google Ads "Subscribe" conversion label. Overridable via env, with the
// dashboard-provided value as the default.
const TRIAL_CONVERSION_SEND_TO =
  (import.meta.env.VITE_GOOGLE_ADS_TRIAL_CONVERSION as string | undefined) ||
  'AW-18286640073/C_9JCPqw0skcEMn3349E'

const FIRED_KEY = 'odin-trial-conversion-fired'

/** Fire the Google Ads trial-start conversion (idempotent per browser session). */
export function trackTrialConversion(): void {
  if (typeof window === 'undefined') return
  if (sessionStorage.getItem(FIRED_KEY)) return

  const gtag = (window as Window & { gtag?: (...args: unknown[]) => void }).gtag
  if (typeof gtag !== 'function') return

  sessionStorage.setItem(FIRED_KEY, '1')
  gtag('event', 'conversion', { send_to: TRIAL_CONVERSION_SEND_TO })

  const dataLayer = (window as Window & { dataLayer?: Record<string, unknown>[] }).dataLayer
  dataLayer?.push({ event: 'trial_started' })
}

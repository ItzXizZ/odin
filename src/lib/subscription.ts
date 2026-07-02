/**
 * Frontend subscription helpers — the card-required free trial paywall.
 *
 * The server owns the truth (a Supabase `subscriptions` row updated via Stripe
 * webhooks). The frontend asks "is this user entitled?" and, if not, redirects
 * to Stripe's hosted Checkout to start the trial.
 */
import { authHeader } from './supabase'

export interface SubscriptionStatus {
  /** True when the trial or paid subscription is currently valid. */
  active: boolean
  status: string
  currentPeriodEnd?: string | null
  /** False when Stripe billing isn't configured (dev/local) — the gate is skipped. */
  billingEnabled: boolean
  /** True when the session is invalid/expired (e.g. the user was deleted). */
  unauthorized?: boolean
}

/** Ask the server whether the signed-in user may use the app. */
export async function fetchSubscriptionStatus(): Promise<SubscriptionStatus> {
  try {
    const res = await fetch('/api/subscription', {
      headers: { ...authHeader() },
    })
    // 401 = the session no longer maps to a valid user (deleted/expired). Do NOT
    // fail open — the caller should sign out / show the paywall.
    if (res.status === 401) {
      return { active: false, status: 'unauthorized', billingEnabled: true, unauthorized: true }
    }
    if (!res.ok) {
      // On any other server hiccup, fail OPEN so we never lock out a paying user.
      return { active: true, status: 'error', billingEnabled: false }
    }
    return (await res.json()) as SubscriptionStatus
  } catch {
    return { active: true, status: 'error', billingEnabled: false }
  }
}

/**
 * Confirm a completed Checkout Session as soon as the user returns from Stripe,
 * so entitlement is granted immediately without waiting on the webhook.
 */
export async function confirmCheckout(sessionId: string): Promise<SubscriptionStatus> {
  try {
    const res = await fetch('/api/stripe/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ sessionId }),
    })
    if (!res.ok) return { active: false, status: 'error', billingEnabled: true }
    return (await res.json()) as SubscriptionStatus
  } catch {
    return { active: false, status: 'error', billingEnabled: true }
  }
}

/**
 * Open the Stripe Customer Portal (cancel / update payment / invoices) and
 * return its URL for the caller to redirect to.
 */
export async function openBillingPortal(): Promise<string> {
  const res = await fetch('/api/stripe/create-portal-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Could not open billing portal' }))
    throw new Error(err.error || 'Could not open billing portal')
  }
  const { url } = (await res.json()) as { url?: string }
  if (!url) throw new Error('Billing portal did not return a URL')
  return url
}

/**
 * Create a Stripe Checkout Session and return its hosted URL. The caller
 * redirects the browser there to collect the card and start the free trial.
 */
export async function createCheckoutSession(): Promise<string> {
  const res = await fetch('/api/stripe/create-checkout-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Could not start checkout' }))
    throw new Error(err.error || 'Could not start checkout')
  }
  const { url } = (await res.json()) as { url?: string }
  if (!url) throw new Error('Checkout session did not return a URL')
  return url
}

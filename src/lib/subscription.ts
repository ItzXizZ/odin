/**
 * Frontend subscription helpers — the card-required free trial paywall.
 *
 * The server owns the truth (a Supabase `subscriptions` row updated via PayPal
 * webhooks). The frontend just asks "is this user entitled?" and, if not, renders
 * the PayPal subscribe button which starts the trial.
 */
import { authHeader } from './supabase'

export interface SubscriptionStatus {
  /** True when the trial or paid subscription is currently valid. */
  active: boolean
  status: string
  currentPeriodEnd?: string | null
  /** False when PayPal billing isn't configured (dev/local) — the gate is skipped. */
  billingEnabled: boolean
}

export interface PayPalConfig {
  clientId: string | null
  planId: string | null
  env: string
  configured: boolean
}

/** Ask the server whether the signed-in user may use the app. */
export async function fetchSubscriptionStatus(): Promise<SubscriptionStatus> {
  try {
    const res = await fetch('/api/subscription', {
      headers: { ...authHeader() },
    })
    if (!res.ok) {
      // On any server hiccup, fail OPEN so we never lock out a paying user.
      return { active: true, status: 'error', billingEnabled: false }
    }
    return (await res.json()) as SubscriptionStatus
  } catch {
    return { active: true, status: 'error', billingEnabled: false }
  }
}

/** Public PayPal config for initialising the JS SDK. */
export async function fetchPayPalConfig(): Promise<PayPalConfig> {
  const res = await fetch('/api/paypal/config')
  return (await res.json()) as PayPalConfig
}

/** Record an approved subscription against the current user; returns entitlement. */
export async function activateSubscription(subscriptionId: string): Promise<SubscriptionStatus> {
  const res = await fetch('/api/paypal/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ subscriptionId }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Activation failed' }))
    throw new Error(err.error || 'Activation failed')
  }
  return (await res.json()) as SubscriptionStatus
}

// ── PayPal JS SDK loader ──

const SDK_ID = 'paypal-sdk'
let sdkPromise: Promise<unknown> | null = null

/**
 * Inject the PayPal JS SDK configured for subscriptions. Resolves with
 * `window.paypal`. Memoised so it only loads once.
 */
export function loadPayPalSdk(clientId: string): Promise<unknown> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'))
  const w = window as unknown as { paypal?: unknown }
  if (w.paypal) return Promise.resolve(w.paypal)
  if (sdkPromise) return sdkPromise

  sdkPromise = new Promise((resolve, reject) => {
    const existing = document.getElementById(SDK_ID)
    if (existing) {
      existing.addEventListener('load', () => resolve(w.paypal))
      existing.addEventListener('error', () => reject(new Error('PayPal SDK failed to load')))
      return
    }
    const script = document.createElement('script')
    script.id = SDK_ID
    const params = new URLSearchParams({
      'client-id': clientId,
      vault: 'true',
      intent: 'subscription',
    })
    script.src = `https://www.paypal.com/sdk/js?${params.toString()}`
    script.async = true
    script.onload = () => resolve(w.paypal)
    script.onerror = () => reject(new Error('PayPal SDK failed to load'))
    document.head.appendChild(script)
  })
  return sdkPromise
}

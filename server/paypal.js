/**
 * PayPal Subscriptions integration — powers the card-required free trial.
 *
 * Flow:
 *  1. The frontend loads the PayPal JS SDK (with the public client id) and renders
 *     a subscription button bound to a PayPal *Plan* that has a trial billing
 *     cycle (price 0) followed by the paid cycle. PayPal collects the card up
 *     front and auto-charges when the trial ends.
 *  2. On approval the frontend posts the new subscription id to /api/paypal/activate,
 *     which verifies it against PayPal and records the status in Supabase.
 *  3. PayPal also calls /api/paypal/webhook for lifecycle events (renewals,
 *     cancellations, payment failures) so the stored status stays authoritative.
 *
 * All secrets stay server-side. Only PAYPAL_CLIENT_ID + PAYPAL_PLAN_ID are ever
 * exposed to the browser (they're safe to be public).
 */

const LIVE_API = 'https://api-m.paypal.com'
const SANDBOX_API = 'https://api-m.sandbox.paypal.com'

// Read env lazily: dotenv.config() runs in server.js after this module imports.
function cfg() {
  return {
    clientId: process.env.PAYPAL_CLIENT_ID,
    secret: process.env.PAYPAL_SECRET,
    planId: process.env.PAYPAL_PLAN_ID,
    webhookId: process.env.PAYPAL_WEBHOOK_ID,
    env: (process.env.PAYPAL_ENV || 'live').toLowerCase(),
  }
}

export function paypalApiBase() {
  return cfg().env === 'sandbox' ? SANDBOX_API : LIVE_API
}

/** True once the minimum config needed to sell a subscription is present. */
export function isPayPalConfigured() {
  const { clientId, secret, planId } = cfg()
  return Boolean(clientId && secret && planId)
}

/** Public config for the frontend SDK (client id + plan id are safe to expose). */
export function paypalPublicConfig() {
  const { clientId, planId, env } = cfg()
  return {
    clientId: clientId || null,
    planId: planId || null,
    env,
    configured: isPayPalConfigured(),
  }
}

// Cache the OAuth token so we don't re-auth on every call.
let tokenCache = { token: null, expiresAt: 0 }

export async function getAccessToken() {
  const { clientId, secret } = cfg()
  if (!clientId || !secret) throw new Error('PayPal not configured')
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) {
    return tokenCache.token
  }
  const auth = Buffer.from(`${clientId}:${secret}`).toString('base64')
  const res = await fetch(`${paypalApiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`PayPal token request failed (${res.status}): ${text.slice(0, 160)}`)
  }
  const data = await res.json()
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3000) * 1000,
  }
  return data.access_token
}

/** Fetch the full subscription resource from PayPal. */
export async function getSubscriptionDetails(subscriptionId) {
  const token = await getAccessToken()
  const res = await fetch(
    `${paypalApiBase()}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`PayPal subscription lookup failed (${res.status}): ${text.slice(0, 160)}`)
  }
  return res.json()
}

/**
 * Verify a webhook came from PayPal (guards against forged status updates).
 * Requires PAYPAL_WEBHOOK_ID. `event` is the parsed JSON body.
 */
export async function verifyWebhookSignature(headers, event) {
  const { webhookId } = cfg()
  if (!webhookId) return false
  const token = await getAccessToken()
  const res = await fetch(`${paypalApiBase()}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: webhookId,
      webhook_event: event,
    }),
  })
  if (!res.ok) return false
  const data = await res.json().catch(() => ({}))
  return data.verification_status === 'SUCCESS'
}

/**
 * Map a PayPal subscription status onto our internal one.
 * Note: during the free trial PayPal reports the subscription as ACTIVE, so
 * "active" covers both the trial and the paid phase (i.e. access is granted).
 */
export function mapStatus(paypalStatus) {
  switch ((paypalStatus || '').toUpperCase()) {
    case 'ACTIVE':
    case 'APPROVAL_PENDING':
    case 'APPROVED':
      return 'active'
    case 'SUSPENDED':
      return 'suspended'
    case 'CANCELLED':
      return 'cancelled'
    case 'EXPIRED':
      return 'expired'
    default:
      return 'none'
  }
}

/** Pull the next billing / period-end timestamp out of a subscription resource. */
export function periodEndFrom(subscription) {
  const next = subscription?.billing_info?.next_billing_time
  if (next) return next
  return null
}

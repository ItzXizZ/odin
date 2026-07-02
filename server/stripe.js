/**
 * Stripe integration — powers the card-required free trial.
 *
 * Flow:
 *  1. The signed-in user hits the paywall and clicks "Start free trial".
 *  2. The server creates a Stripe Checkout Session in `subscription` mode with a
 *     trial period and `payment_method_collection: 'always'`, which forces the
 *     card to be captured up front. Stripe hosts the payment page.
 *  3. Stripe redirects back on success; the `checkout.session.completed` +
 *     `customer.subscription.*` webhooks update the stored status in Supabase.
 *
 * Secrets stay server-side. The publishable key is never needed because we use
 * hosted Checkout (a redirect), not client-side Stripe.js.
 */
import Stripe from 'stripe'

// Read env lazily: dotenv.config() runs in server.js after this module imports.
function cfg() {
  return {
    secretKey: process.env.STRIPE_SECRET_KEY,
    priceId: process.env.STRIPE_PRICE_ID,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    trialDays: Number(process.env.STRIPE_TRIAL_DAYS || 7),
  }
}

let stripeClient = null
export function getStripe() {
  const { secretKey } = cfg()
  if (!secretKey) return null
  if (!stripeClient) {
    stripeClient = new Stripe(secretKey, { apiVersion: '2024-06-20' })
  }
  return stripeClient
}

/** True once the minimum config to sell a subscription is present. */
export function isStripeConfigured() {
  const { secretKey, priceId } = cfg()
  return Boolean(secretKey && priceId)
}

/**
 * Create a hosted Checkout Session for the card-required free trial and return
 * its URL. Reuses/creates a Stripe customer keyed to the Supabase user id.
 */
export async function createCheckoutSession({ userId, email, origin }) {
  const stripe = getStripe()
  if (!stripe) throw new Error('Stripe not configured')
  const { priceId, trialDays } = cfg()

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    // Force the card to be collected even though the trial charges $0 now.
    payment_method_collection: 'always',
    subscription_data: {
      trial_period_days: trialDays,
      // Echoed onto the subscription so webhooks can map back to our user.
      metadata: { user_id: userId },
    },
    // Also on the session/customer for lookups.
    client_reference_id: userId,
    customer_email: email || undefined,
    metadata: { user_id: userId },
    allow_promotion_codes: true,
    success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?checkout=cancel`,
  })
  return session.url
}

/** Retrieve a Checkout Session with its subscription expanded. */
export async function getCheckoutSession(sessionId) {
  const stripe = getStripe()
  if (!stripe) throw new Error('Stripe not configured')
  return stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] })
}

/** Verify + parse a Stripe webhook. `rawBody` must be the untouched request body. */
export function constructEvent(rawBody, signature) {
  const stripe = getStripe()
  const { webhookSecret } = cfg()
  if (!stripe || !webhookSecret) throw new Error('Stripe webhook not configured')
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)
}

/** Fetch a subscription resource by id. */
export async function getSubscription(subscriptionId) {
  const stripe = getStripe()
  if (!stripe) throw new Error('Stripe not configured')
  return stripe.subscriptions.retrieve(subscriptionId)
}

/**
 * Map a Stripe subscription status onto our internal one. `trialing` and
 * `active` both grant access; everything else does not.
 */
export function mapStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'trialing':
    case 'active':
      return 'active'
    case 'past_due':
      return 'past_due'
    case 'canceled':
      return 'cancelled'
    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired':
    case 'paused':
      return 'inactive'
    default:
      return 'none'
  }
}

/** ISO period-end from a Stripe subscription object. */
export function periodEndFrom(subscription) {
  const secs = subscription?.current_period_end
  return secs ? new Date(secs * 1000).toISOString() : null
}

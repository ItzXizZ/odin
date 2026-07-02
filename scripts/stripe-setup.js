/**
 * One-off Stripe provisioning script.
 *
 * Creates:
 *   1. A Product for the app.
 *   2. A recurring monthly Price (the paid rate after the trial).
 *   3. A Webhook endpoint pointing at /api/stripe/webhook (only if
 *      STRIPE_WEBHOOK_URL is set) and prints its signing secret.
 *
 * The free trial itself is applied per-checkout via STRIPE_TRIAL_DAYS, so it
 * lives on the Checkout Session, not the price.
 *
 * Reads from .env:
 *   STRIPE_SECRET_KEY, STRIPE_PRICE (default 20), STRIPE_CURRENCY (default USD),
 *   STRIPE_WEBHOOK_URL (e.g. https://odinwrite.com/api/stripe/webhook)
 *
 * Run: node scripts/stripe-setup.js
 */
import dotenv from 'dotenv'
import Stripe from 'stripe'

dotenv.config()

const PRICE = String(process.env.STRIPE_PRICE || '20')
const CURRENCY = (process.env.STRIPE_CURRENCY || 'USD').toLowerCase()
const WEBHOOK_URL = (process.env.STRIPE_WEBHOOK_URL || '').trim()

async function main() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY must be set in .env')
  const stripe = new Stripe(key, { apiVersion: '2024-06-20' })

  console.log(`Creating product + price: ${PRICE} ${CURRENCY.toUpperCase()}/month\n`)

  const product = await stripe.products.create({
    name: 'Odin',
    description: 'Odin — the definitive writing studio',
  })
  console.log(`✓ Product created: ${product.id}`)

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: Math.round(Number(PRICE) * 100),
    currency: CURRENCY,
    recurring: { interval: 'month' },
  })
  console.log(`✓ Price created: ${price.id}`)

  let webhookSecret = null
  if (WEBHOOK_URL) {
    const webhook = await stripe.webhookEndpoints.create({
      url: WEBHOOK_URL,
      enabled_events: [
        'checkout.session.completed',
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'invoice.payment_failed',
        'invoice.payment_succeeded',
      ],
    })
    webhookSecret = webhook.secret
    console.log(`✓ Webhook created: ${webhook.id} → ${WEBHOOK_URL}`)
  } else {
    console.log('○ Skipping webhook (set STRIPE_WEBHOOK_URL to create one).')
  }

  console.log('\n──────── Paste these into .env ────────')
  console.log(`STRIPE_PRICE_ID=${price.id}`)
  if (webhookSecret) console.log(`STRIPE_WEBHOOK_SECRET=${webhookSecret}`)
  console.log('───────────────────────────────────────')
}

main().catch((err) => {
  console.error('\n✗ Setup failed:', err.message)
  process.exit(1)
})

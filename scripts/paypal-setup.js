/**
 * One-off PayPal provisioning script.
 *
 * Creates (idempotently enough for a first run):
 *   1. A catalog Product for the app.
 *   2. A Billing Plan with a free TRIAL cycle (price 0) followed by the paid
 *      monthly cycle — this is what makes the card-required free trial work.
 *   3. A Webhook pointing at /api/paypal/webhook (only if PAYPAL_WEBHOOK_URL set).
 *
 * It prints the PAYPAL_PLAN_ID and PAYPAL_WEBHOOK_ID to paste into .env.
 *
 * Reads config from .env:
 *   PAYPAL_ENV, PAYPAL_CLIENT_ID, PAYPAL_SECRET
 *   PAYPAL_TRIAL_DAYS (default 14), PAYPAL_PRICE (default 10), PAYPAL_CURRENCY (default USD)
 *   PAYPAL_WEBHOOK_URL (e.g. https://your-app.onrender.com/api/paypal/webhook)
 *
 * Run: node scripts/paypal-setup.js
 */
import dotenv from 'dotenv'
import { getAccessToken, paypalApiBase } from '../server/paypal.js'

dotenv.config()

const TRIAL_DAYS = Number(process.env.PAYPAL_TRIAL_DAYS || 14)
const PRICE = String(process.env.PAYPAL_PRICE || '10')
const CURRENCY = (process.env.PAYPAL_CURRENCY || 'USD').toUpperCase()
const WEBHOOK_URL = (process.env.PAYPAL_WEBHOOK_URL || '').trim()

async function api(method, path, body) {
  const token = await getAccessToken()
  const res = await fetch(`${paypalApiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // A unique id keeps product/plan creation idempotent per run.
      'PayPal-Request-Id': `odin-${path}-${Date.now()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data).slice(0, 500)}`)
  }
  return data
}

async function createProduct() {
  const product = await api('POST', '/v1/catalogs/products', {
    name: 'Odin',
    description: 'Odin — the definitive writing studio',
    type: 'SERVICE',
    category: 'SOFTWARE',
  })
  console.log(`✓ Product created: ${product.id}`)
  return product.id
}

async function createPlan(productId) {
  const plan = await api('POST', '/v1/billing/plans', {
    product_id: productId,
    name: `Odin Membership (${TRIAL_DAYS}-day free trial)`,
    description: `${TRIAL_DAYS}-day free trial, then ${PRICE} ${CURRENCY}/month`,
    status: 'ACTIVE',
    billing_cycles: [
      {
        frequency: { interval_unit: 'DAY', interval_count: TRIAL_DAYS },
        tenure_type: 'TRIAL',
        sequence: 1,
        total_cycles: 1,
        pricing_scheme: { fixed_price: { value: '0', currency_code: CURRENCY } },
      },
      {
        frequency: { interval_unit: 'MONTH', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 2,
        total_cycles: 0, // 0 = bill forever until cancelled
        pricing_scheme: { fixed_price: { value: PRICE, currency_code: CURRENCY } },
      },
    ],
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee: { value: '0', currency_code: CURRENCY },
      setup_fee_failure_action: 'CONTINUE',
      payment_failure_threshold: 3,
    },
  })
  console.log(`✓ Plan created: ${plan.id}`)
  return plan.id
}

async function createWebhook() {
  if (!WEBHOOK_URL) {
    console.log('○ Skipping webhook (set PAYPAL_WEBHOOK_URL to create one).')
    return null
  }
  const webhook = await api('POST', '/v1/notifications/webhooks', {
    url: WEBHOOK_URL,
    event_types: [
      { name: 'BILLING.SUBSCRIPTION.ACTIVATED' },
      { name: 'BILLING.SUBSCRIPTION.CANCELLED' },
      { name: 'BILLING.SUBSCRIPTION.SUSPENDED' },
      { name: 'BILLING.SUBSCRIPTION.EXPIRED' },
      { name: 'BILLING.SUBSCRIPTION.UPDATED' },
      { name: 'PAYMENT.SALE.COMPLETED' },
    ],
  })
  console.log(`✓ Webhook created: ${webhook.id} → ${WEBHOOK_URL}`)
  return webhook.id
}

async function main() {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_SECRET) {
    throw new Error('PAYPAL_CLIENT_ID and PAYPAL_SECRET must be set in .env')
  }
  console.log(`PayPal env: ${(process.env.PAYPAL_ENV || 'live')} (${paypalApiBase()})`)
  console.log(`Trial: ${TRIAL_DAYS} days → then ${PRICE} ${CURRENCY}/month\n`)

  const productId = await createProduct()
  const planId = await createPlan(productId)
  const webhookId = await createWebhook()

  console.log('\n──────── Paste these into .env ────────')
  console.log(`PAYPAL_PLAN_ID=${planId}`)
  if (webhookId) console.log(`PAYPAL_WEBHOOK_ID=${webhookId}`)
  console.log('───────────────────────────────────────')
}

main().catch((err) => {
  console.error('\n✗ Setup failed:', err.message)
  process.exit(1)
})

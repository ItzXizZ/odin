import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useAuth } from '../lib/auth'
import { createCheckoutSession, fetchSubscriptionStatus } from '../lib/subscription'
import logo from './logo.png'

/**
 * Shown to a signed-in user without an active subscription. Sends them to
 * Stripe's hosted Checkout to subscribe (with an optional free trial when
 * STRIPE_FREE_TRIAL_ENABLED is set on the server).
 */
export default function TrialPaywall() {
  const { signOut } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [freeTrialEnabled, setFreeTrialEnabled] = useState(false)

  useEffect(() => {
    fetchSubscriptionStatus().then((s) => setFreeTrialEnabled(!!s.freeTrialEnabled))
  }, [])

  async function handleStart() {
    setBusy(true)
    setError(null)
    try {
      const url = await createCheckoutSession()
      window.location.href = url
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start checkout.')
      setBusy(false)
    }
  }

  const title = freeTrialEnabled ? 'Start your free trial' : 'Subscribe to Odin'
  const description = freeTrialEnabled
    ? "Add a card to unlock your studio. You won't be charged during the trial, and you can cancel anytime before it ends."
    : 'Add a card to unlock your studio. You can cancel anytime from Settings.'
  const cta = freeTrialEnabled ? 'Start free trial' : 'Subscribe'

  return (
    <div
      className="h-full w-full flex items-center justify-center px-6"
      style={{ background: 'rgb(215,215,215)' }}
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="w-full max-w-md flex flex-col items-center text-center"
        style={{
          background: 'rgba(255,255,255,0.72)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(255,255,255,0.6)',
          borderRadius: 24,
          padding: '40px 32px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.12)',
        }}
      >
        <img src={logo} alt="Odin" style={{ height: 56, width: 'auto', display: 'block' }} />
        <h1
          style={{
            marginTop: 20,
            fontSize: 24,
            fontWeight: 600,
            color: 'rgba(30,30,30,0.92)',
            letterSpacing: '-0.02em',
          }}
        >
          {title}
        </h1>
        <p
          style={{
            marginTop: 10,
            fontSize: 14.5,
            lineHeight: 1.55,
            color: 'rgba(60,60,60,0.72)',
          }}
        >
          {description}
        </p>

        <button
          onClick={handleStart}
          disabled={busy}
          style={{
            marginTop: 26,
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '13px 16px',
            borderRadius: 12,
            background: busy ? 'rgba(30,30,30,0.55)' : 'rgba(30,30,30,0.92)',
            border: 'none',
            cursor: busy ? 'default' : 'pointer',
            fontSize: 15,
            fontWeight: 600,
            color: '#fff',
            transition: 'transform 0.12s ease, background 0.12s ease',
          }}
          onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.98)')}
          onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
          onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
        >
          {busy ? 'Opening secure checkout…' : cta}
        </button>

        {error && (
          <p style={{ marginTop: 14, fontSize: 13, color: 'rgba(170,40,40,0.95)' }}>{error}</p>
        )}

        <p style={{ marginTop: 20, fontSize: 12, color: 'rgba(60,60,60,0.5)' }}>
          Payments are processed securely by Stripe. Your card details never touch our servers.
        </p>

        <button
          type="button"
          onClick={() => void signOut()}
          style={{
            marginTop: 18,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontSize: 12.5,
            color: 'rgba(60,60,60,0.55)',
            textDecoration: 'underline',
          }}
        >
          Sign out
        </button>
      </motion.div>
    </div>
  )
}

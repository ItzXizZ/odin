import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { useAuth } from '../lib/auth'
import {
  activateSubscription,
  fetchPayPalConfig,
  loadPayPalSdk,
} from '../lib/subscription'
import logo from './logo.png'

/** Minimal shape of the PayPal Buttons API we use. */
interface PayPalButtons {
  Buttons: (opts: {
    style?: Record<string, unknown>
    createSubscription: (
      data: unknown,
      actions: { subscription: { create: (payload: Record<string, unknown>) => Promise<string> } }
    ) => Promise<string>
    onApprove: (data: { subscriptionID?: string }) => Promise<void> | void
    onError?: (err: unknown) => void
    onCancel?: () => void
  }) => { render: (selector: string | HTMLElement) => Promise<void> }
}

/**
 * Shown to a signed-in user who hasn't started their trial. Collects a card via
 * PayPal (which starts the free trial and auto-charges when it ends), then hands
 * control back to the app once the subscription is active.
 */
export default function TrialPaywall({ onActivated }: { onActivated: () => void }) {
  const { user, signOut } = useAuth()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activating, setActivating] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        const config = await fetchPayPalConfig()
        if (!config.configured || !config.clientId || !config.planId) {
          throw new Error('Billing is not configured yet. Please try again shortly.')
        }
        const paypal = (await loadPayPalSdk(config.clientId)) as PayPalButtons
        if (cancelled || !containerRef.current) return

        containerRef.current.innerHTML = ''
        await paypal
          .Buttons({
            style: { layout: 'vertical', shape: 'pill', color: 'gold', label: 'subscribe' },
            createSubscription: (_data, actions) =>
              actions.subscription.create({
                plan_id: config.planId as string,
                // Echoed back on webhooks so we can map to this user.
                custom_id: user?.id,
              }),
            onApprove: async (data) => {
              if (!data.subscriptionID) {
                setError('Subscription could not be confirmed. Please try again.')
                return
              }
              setActivating(true)
              try {
                const status = await activateSubscription(data.subscriptionID)
                if (status.active) onActivated()
                else setError('Your subscription is pending. Give it a moment and refresh.')
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Activation failed.')
              } finally {
                setActivating(false)
              }
            },
            onError: () => setError('Something went wrong with PayPal. Please try again.'),
          })
          .render(containerRef.current)

        if (!cancelled) setLoading(false)
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not start checkout.')
          setLoading(false)
        }
      }
    }

    void init()
    return () => {
      cancelled = true
    }
  }, [user?.id, onActivated])

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
          Start your free trial
        </h1>
        <p
          style={{
            marginTop: 10,
            fontSize: 14.5,
            lineHeight: 1.55,
            color: 'rgba(60,60,60,0.72)',
          }}
        >
          Add a card to unlock your studio. You won't be charged during the trial,
          and you can cancel anytime before it ends.
        </p>

        <div style={{ marginTop: 26, width: '100%', minHeight: 52 }}>
          {loading && (
            <div style={{ fontSize: 13, color: 'rgba(60,60,60,0.6)' }}>
              Loading secure checkout…
            </div>
          )}
          {activating && (
            <div style={{ fontSize: 13, color: 'rgba(60,60,60,0.6)' }}>
              Confirming your subscription…
            </div>
          )}
          <div ref={containerRef} />
        </div>

        {error && (
          <p style={{ marginTop: 14, fontSize: 13, color: 'rgba(170,40,40,0.95)' }}>{error}</p>
        )}

        <p style={{ marginTop: 20, fontSize: 12, color: 'rgba(60,60,60,0.5)' }}>
          Payments are processed securely by PayPal. Your card details never touch our servers.
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

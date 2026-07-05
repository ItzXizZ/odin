import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import Layout from './components/Layout'
import LoginScreen from './components/LoginScreen'
import TrialPaywall from './components/TrialPaywall'
import IphoneUnsupportedScreen, { isIPhoneDevice } from './components/IphoneUnsupportedScreen'
import { AuthProvider, SignupCompleteHandler, useAuth } from './lib/auth'
import { confirmCheckout, fetchSubscriptionStatus } from './lib/subscription'
import { trackTrialConversion } from './lib/conversion'
import { clearOnboardingFinished, hasFinishedOnboarding, onOnboardingFinished } from './lib/onboarding'
import { useStore } from './store/useStore'
import OdinHead from './components/OdinHead'
import logo from './components/logo.png'

function ServerBanner() {
  const [serverOk, setServerOk] = useState<boolean | null>(null)
  const setServerHasKey = useStore((s) => s.setServerHasKey)

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => {
        setServerOk(d.ok)
        setServerHasKey(!!d.hasKey)
      })
      .catch(() => setServerOk(false))
  }, [setServerHasKey])

  if (serverOk !== false) return null
  const isProd = import.meta.env.PROD
  return (
    <div
      className="flex-shrink-0 px-4 py-2 text-center text-sm"
      style={{
        background: 'rgba(200,50,50,0.12)',
        borderBottom: '1px solid rgba(180,40,40,0.2)',
        color: 'rgba(140,30,30,1)',
      }}
    >
      {isProd ? (
        <>Backend unavailable — check Render logs or try again in a moment.</>
      ) : (
        <>
          Backend server not running — start it with{' '}
          <code
            className="rounded px-1 font-mono"
            style={{ background: 'rgba(200,50,50,0.12)', fontSize: '0.85em' }}
          >
            npm run dev
          </code>
        </>
      )}
    </div>
  )
}

function Splash() {
  return (
    <div
      className="h-full w-full flex items-center justify-center"
      style={{ background: 'rgb(215,215,215)' }}
    >
      <motion.img
        src={logo}
        alt="Odin"
        style={{ height: 52, width: 'auto', display: 'block' }}
        animate={{ opacity: [0.4, 1, 0.4] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
      />
    </div>
  )
}

/**
 * Logged-out landing screen. Heavily favours starting the guided tutorial via a
 * big primary button, with a quiet "Already have an account?" link below for
 * returning users who just want to sign in.
 */
function useTypewriter(text: string, speed = 45, startDelay = 500) {
  const [shown, setShown] = useState('')
  useEffect(() => {
    setShown('')
    if (!text) return
    let i = 0
    let interval: ReturnType<typeof setInterval> | null = null
    const startTimer = setTimeout(() => {
      interval = setInterval(() => {
        i++
        setShown(text.slice(0, i))
        if (i >= text.length && interval) clearInterval(interval)
      }, speed)
    }, startDelay)
    return () => {
      clearTimeout(startTimer)
      if (interval) clearInterval(interval)
    }
  }, [text, speed, startDelay])
  return { shown, done: shown.length >= text.length }
}

const landingContainer = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.05 } },
}
const landingItem = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] as const } },
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.85.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.01-2.34z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  )
}

function GuestLanding({
  onStart,
  onSignIn,
}: {
  onStart: () => void
  onSignIn: () => void
}) {
  const greeting = "Hi there, I'm Odin."
  const { shown, done } = useTypewriter(greeting)

  return (
    <div className="guest-landing">
      <motion.div
        className="guest-landing-inner"
        variants={landingContainer}
        initial="hidden"
        animate="show"
      >
        <motion.div variants={landingItem} className="guest-odin-wrap">
          <div className="guest-odin">
            <OdinHead talking={!done} size={108} />
          </div>
          <div className="guest-bubble">
            {shown}
            {!done && <span className="odin-caret" />}
          </div>
        </motion.div>

        <motion.h1 variants={landingItem} className="guest-title">
          You are about to discover <em>the best</em> way to <em>research</em> and{' '}
          <em>write</em>
        </motion.h1>

        <motion.button variants={landingItem} className="guest-cta" onClick={onStart}>
          Start the tutorial
        </motion.button>

        <motion.button variants={landingItem} className="guest-signin" onClick={onSignIn}>
          Already have an account? <u>Sign in</u>
        </motion.button>
      </motion.div>
    </div>
  )
}

/**
 * Shown to a logged-out user the moment they finish the guided tutorial: celebrate
 * completion and prompt an explicit Google sign-up to keep their work and continue.
 */
function TutorialCompleteScreen({
  onSignIn,
  onReturnToTutorial,
}: {
  onSignIn: () => void
  onReturnToTutorial: () => void
}) {
  const { signInWithGoogle } = useAuth()
  const [busy, setBusy] = useState(false)
  const greeting = "That's the grand tour."
  const { shown, done } = useTypewriter(greeting)

  async function handleSignUp() {
    setBusy(true)
    try {
      await signInWithGoogle({ afterSignup: true })
    } catch {
      setBusy(false)
    }
  }

  return (
    <div className="guest-landing">
      <button
        type="button"
        className="guest-return-tutorial"
        onClick={onReturnToTutorial}
      >
        Return to the tutorial screen
      </button>
      <motion.div
        className="guest-landing-inner"
        variants={landingContainer}
        initial="hidden"
        animate="show"
      >
        <motion.div variants={landingItem} className="guest-odin-wrap">
          <div className="guest-odin">
            <OdinHead talking={!done} size={108} />
          </div>
          <div className="guest-bubble">
            {shown}
            {!done && <span className="odin-caret" />}
          </div>
        </motion.div>

        <motion.h1 variants={landingItem} className="guest-title">
          Your tutorial is <em>complete</em>. Now it's time to begin on your own.
        </motion.h1>

        <motion.button
          variants={landingItem}
          className="guest-google"
          onClick={handleSignUp}
          disabled={busy}
        >
          <GoogleMark />
          {busy ? 'Opening Google…' : 'Sign up with Google'}
        </motion.button>

        <motion.button variants={landingItem} className="guest-signin" onClick={onSignIn}>
          Already have an account? <u>Sign in</u>
        </motion.button>
      </motion.div>
    </div>
  )
}

/**
 * Signed-in gate: when STRIPE_PAYWALL_ENABLED is on, new users must subscribe
 * (or start a card trial) before reaching the studio. Fails open whenever billing
 * is off or the status check errors, so a real subscriber is never locked out.
 */
function EntitledApp() {
  const { signOut } = useAuth()
  const [state, setState] = useState<'checking' | 'entitled' | 'paywall'>('checking')

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams(window.location.search)
    const returned = params.get('checkout')
    const sessionId = params.get('session_id')

    const cleanUrl = () => {
      if (returned) window.history.replaceState({}, '', '/')
    }

    async function resolveEntitlement() {
      // Returning from Stripe: confirm the session directly (instant, no webhook needed).
      if (returned === 'success' && sessionId) {
        const confirmed = await confirmCheckout(sessionId)
        if (cancelled) return
        if (confirmed.active) {
          trackTrialConversion()
          cleanUrl()
          setState('entitled')
          return
        }
      }

      // Otherwise (or as a fallback) read status, polling briefly if we just paid.
      const attempts = returned === 'success' ? 6 : 1
      for (let i = 0; i < attempts; i++) {
        const status = await fetchSubscriptionStatus()
        if (cancelled) return
        // Stale/deleted session: clear it so the user re-signs in (and hits the paywall).
        if (status.unauthorized) {
          void signOut()
          return
        }
        if (status.active || !status.billingEnabled) {
          // Only count as a conversion when they just returned from checkout.
          if (returned === 'success' && status.billingEnabled) trackTrialConversion()
          cleanUrl()
          setState('entitled')
          return
        }
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500))
      }
      if (cancelled) return
      cleanUrl()
      setState('paywall')
    }

    void resolveEntitlement()
    return () => {
      cancelled = true
    }
  }, [signOut])

  if (state === 'checking') return <Splash />
  if (state === 'paywall') return <TrialPaywall />

  return (
    <>
      <ServerBanner />
      <Layout />
    </>
  )
}

type GuestView = 'landing' | 'tutorial' | 'signin'

function Gate() {
  const { authEnabled, ready, user } = useAuth()
  // Once the guided tour finishes (or is skipped) we prompt the guest to sign up.
  const [tutorialFinished, setTutorialFinished] = useState(hasFinishedOnboarding)
  const [guestView, setGuestView] = useState<GuestView>('landing')

  useEffect(() => onOnboardingFinished(() => setTutorialFinished(true)), [])

  if (!ready) return <Splash />

  // Guests (auth required, not signed in): show the landing screen first, which
  // steers them into the tutorial. Sign-in is a quiet secondary path, and we
  // prompt sign-up once the tutorial is complete.
  if (authEnabled && !user) {
    // Returning users who explicitly chose "sign in" get the plain login screen.
    if (guestView === 'signin') return <LoginScreen />
    // Finished the tutorial: prompt an explicit sign-up.
    if (tutorialFinished) {
      return (
        <TutorialCompleteScreen
          onSignIn={() => setGuestView('signin')}
          onReturnToTutorial={() => {
            clearOnboardingFinished()
            setTutorialFinished(false)
            setGuestView('landing')
          }}
        />
      )
    }
    if (guestView === 'tutorial') {
      return (
        <>
          <ServerBanner />
          <Layout guestTutorial />
        </>
      )
    }
    return (
      <GuestLanding
        onStart={() => setGuestView('tutorial')}
        onSignIn={() => setGuestView('signin')}
      />
    )
  }

  // Signed in (or local mode): enforce the trial/subscription before the studio.
  return <EntitledApp />
}

export default function App() {
  if (isIPhoneDevice()) {
    return (
      <div
        className="h-screen w-screen overflow-hidden flex flex-col"
        style={{ background: 'rgb(215,215,215)' }}
      >
        <IphoneUnsupportedScreen />
      </div>
    )
  }

  return (
    <div
      className="h-screen w-screen overflow-hidden flex flex-col"
      style={{ background: 'rgb(215,215,215)' }}
    >
      <AuthProvider>
        <SignupCompleteHandler />
        <Gate />
      </AuthProvider>
    </div>
  )
}

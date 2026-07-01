import { useState } from 'react'
import { motion } from 'framer-motion'
import { useAuth } from '../lib/auth'
import logo from './logo.png'

export default function LoginScreen() {
  const { signInWithGoogle } = useAuth()
  const [busy, setBusy] = useState(false)

  async function handleSignIn() {
    setBusy(true)
    try {
      await signInWithGoogle()
    } catch {
      setBusy(false)
    }
  }

  return (
    <div
      className="h-full w-full flex items-center justify-center px-6"
      style={{ background: 'rgb(215,215,215)' }}
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="w-full max-w-sm flex flex-col items-center text-center"
        style={{
          background: 'rgba(255,255,255,0.7)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(255,255,255,0.6)',
          borderRadius: 24,
          padding: '40px 32px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.12)',
        }}
      >
        <img src={logo} alt="Odin" style={{ height: 64, width: 'auto', display: 'block' }} />
        <h1
          style={{
            marginTop: 20,
            fontSize: 26,
            fontWeight: 600,
            color: 'rgba(30,30,30,0.92)',
            letterSpacing: '-0.02em',
          }}
        >
          Odin
        </h1>
        <p
          style={{
            marginTop: 8,
            fontSize: 14.5,
            lineHeight: 1.5,
            color: 'rgba(60,60,60,0.7)',
          }}
        >
          Sign in to your private studio. Your documents, research, and voice profile
          are preserved with absolute discretion.
        </p>

        <button
          onClick={handleSignIn}
          disabled={busy}
          className="group"
          style={{
            marginTop: 28,
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: '12px 16px',
            borderRadius: 12,
            background: '#fff',
            border: '1px solid rgba(0,0,0,0.12)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
            fontSize: 15,
            fontWeight: 500,
            color: 'rgba(30,30,30,0.9)',
            transition: 'transform 0.12s ease, box-shadow 0.12s ease',
          }}
          onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.98)')}
          onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
          onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
        >
          <GoogleMark />
          {busy ? 'Entering studio…' : 'Sign in with Google'}
        </button>

        <p style={{ marginTop: 18, fontSize: 12, color: 'rgba(60,60,60,0.5)' }}>
          Authentication only. Your work remains entirely private.
        </p>

        <p style={{ marginTop: 12, fontSize: 12, color: 'rgba(60,60,60,0.45)' }}>
          <a href="/privacy" style={{ color: 'inherit', textDecoration: 'underline' }}>
            Privacy
          </a>
          {' · '}
          <a href="/terms" style={{ color: 'inherit', textDecoration: 'underline' }}>
            Terms
          </a>
        </p>
      </motion.div>
    </div>
  )
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

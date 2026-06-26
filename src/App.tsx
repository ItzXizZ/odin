import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import Layout from './components/Layout'
import LoginScreen from './components/LoginScreen'
import { AuthProvider, useAuth } from './lib/auth'
import logo from './components/logo.png'

function ServerBanner() {
  const [serverOk, setServerOk] = useState<boolean | null>(null)

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => setServerOk(d.ok))
      .catch(() => setServerOk(false))
  }, [])

  if (serverOk !== false) return null
  return (
    <div
      className="flex-shrink-0 px-4 py-2 text-center text-sm"
      style={{
        background: 'rgba(200,50,50,0.12)',
        borderBottom: '1px solid rgba(180,40,40,0.2)',
        color: 'rgba(140,30,30,1)',
      }}
    >
      Backend server not running — start it with{' '}
      <code
        className="rounded px-1 font-mono"
        style={{ background: 'rgba(200,50,50,0.12)', fontSize: '0.85em' }}
      >
        npm run dev
      </code>
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

function Gate() {
  const { authEnabled, ready, user } = useAuth()

  if (!ready) return <Splash />
  if (authEnabled && !user) return <LoginScreen />

  return (
    <>
      <ServerBanner />
      <Layout />
    </>
  )
}

export default function App() {
  return (
    <div
      className="h-screen w-screen overflow-hidden flex flex-col"
      style={{ background: 'rgb(215,215,215)' }}
    >
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </div>
  )
}

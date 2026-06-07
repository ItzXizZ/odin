import { useEffect, useState } from 'react'
import { useStore } from './store/useStore'
import Layout from './components/Layout'
import SettingsModal from './components/SettingsModal'

export default function App() {
  const { showSettings, apiKey } = useStore()
  const [serverOk, setServerOk] = useState<boolean | null>(null)

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => setServerOk(d.ok))
      .catch(() => setServerOk(false))
  }, [])

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col" style={{ background: 'rgb(215,215,215)' }}>
      {serverOk === false && (
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
      )}
      {!apiKey && serverOk !== false && (
        <div
          className="flex-shrink-0 px-4 py-2 text-center text-sm"
          style={{
            background: 'rgba(100,150,255,0.1)',
            borderBottom: '1px solid rgba(100,150,255,0.2)',
            color: 'rgba(30,65,140,1)',
          }}
        >
          No API key set —{' '}
          <button
            onClick={() => useStore.getState().setShowSettings(true)}
            className="underline"
            style={{ all: 'unset', cursor: 'pointer', textDecoration: 'underline', color: 'rgba(50,90,180,1)' }}
          >
            add your Anthropic key in Settings
          </button>
        </div>
      )}
      <Layout />
      {showSettings && <SettingsModal />}
    </div>
  )
}

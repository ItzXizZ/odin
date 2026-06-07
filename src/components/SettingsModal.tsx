import { useState } from 'react'
import { X, Key, CheckCircle } from 'lucide-react'
import { useStore } from '../store/useStore'

export default function SettingsModal() {
  const { apiKey, setApiKey, setShowSettings } = useStore()
  const [draft, setDraft] = useState(apiKey)
  const [saved, setSaved] = useState(false)

  const handleSave = () => {
    setApiKey(draft.trim())
    setSaved(true)
    setTimeout(() => {
      setSaved(false)
      setShowSettings(false)
    }, 1000)
  }

  return (
    /* Overlay */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in"
      style={{
        background: 'rgba(0,0,0,0.1)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        padding: '2rem',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) setShowSettings(false) }}
    >
      {/* Modal wrap + shadow */}
      <div
        className="animate-slide-up"
        style={{ position: 'relative', zIndex: 2, borderRadius: '1.25em', width: '100%', maxWidth: '440px' }}
      >
        {/* Blurred shadow layer */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            width: 'calc(100% + 2em)',
            height: 'calc(100% + 2em)',
            top: '-1em',
            left: '-1em',
            filter: 'blur(12px)',
            pointerEvents: 'none',
            borderRadius: '1.25em',
            overflow: 'visible',
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '1.25em',
              background: 'linear-gradient(180deg, rgba(0,0,0,0.2), rgba(0,0,0,0.1))',
              width: 'calc(100% - 2.25em)',
              height: 'calc(100% - 2.25em)',
              top: '1.5em',
              left: '1.125em',
              padding: '0.125em',
              boxSizing: 'border-box',
              maskImage: 'linear-gradient(#000 0 0)',
              WebkitMaskImage: 'linear-gradient(#000 0 0)',
            }}
          />
        </div>

        {/* Glass modal surface */}
        <div
          className="modal-glass"
          style={{
            position: 'relative',
            zIndex: 3,
            background: 'linear-gradient(-75deg, rgba(255,255,255,0.08), rgba(255,255,255,0.25), rgba(255,255,255,0.08))',
            borderRadius: '1.25em',
            boxShadow:
              'inset 0 0.125em 0.125em rgba(0,0,0,0.05), ' +
              'inset 0 -0.125em 0.125em rgba(255,255,255,0.5), ' +
              '0 0.25em 0.125em -0.125em rgba(0,0,0,0.2), ' +
              '0 0 0.1em 0.25em inset rgba(255,255,255,0.2)',
            backdropFilter: 'blur(clamp(1px, 0.125em, 4px))',
            WebkitBackdropFilter: 'blur(clamp(1px, 0.125em, 4px))',
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '1.4em 1.5em 1em',
              borderBottom: '1px solid rgba(0,0,0,0.06)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: '1.125rem',
                fontWeight: 600,
                letterSpacing: '-0.03em',
                color: 'rgba(40,40,40,1)',
                textShadow: '0 0.05em 0.05em rgba(0,0,0,0.08)',
              }}
            >
              Settings
            </h2>
            <button
              onClick={() => setShowSettings(false)}
              style={{
                all: 'unset',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '1.75em',
                height: '1.75em',
                borderRadius: '0.5em',
                color: 'rgba(80,80,80,0.7)',
                transition: 'all 200ms',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(0,0,0,0.06)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div style={{ padding: '1.25em 1.5em', display: 'flex', flexDirection: 'column', gap: '1em' }}>
            {/* API Key field */}
            <div>
              <label
                className="label"
                style={{ display: 'flex', alignItems: 'center', gap: '0.4em', marginBottom: '0.5em' }}
              >
                <Key size={12} />
                Anthropic API Key
              </label>
              <input
                type="password"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="sk-ant-..."
                className="glass-input"
                style={{ padding: '0.75em 1em', fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}
                onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              />
              <p style={{ marginTop: '0.5em', fontSize: '0.75rem', color: 'rgba(100,100,100,0.6)' }}>
                Stored locally. Never sent anywhere except Anthropic's API.
              </p>
            </div>

            {/* Instructions */}
            <div
              style={{
                borderRadius: '0.875em',
                padding: '0.875em 1em',
                background: 'rgba(255,255,255,0.25)',
                border: '1px solid rgba(0,0,0,0.07)',
                fontSize: '0.78rem',
                color: 'rgba(80,80,80,0.8)',
                lineHeight: 1.6,
                display: 'flex',
                flexDirection: 'column',
                gap: '0.2em',
              }}
            >
              <p style={{ margin: 0, fontWeight: 600, color: 'rgba(50,50,50,1)' }}>Getting an API key</p>
              <p style={{ margin: 0 }}>1. Go to console.anthropic.com</p>
              <p style={{ margin: 0 }}>2. Create an account and add billing</p>
              <p style={{ margin: 0 }}>3. Generate an API key under "API Keys"</p>
            </div>
          </div>

          {/* Footer */}
          <div
            style={{
              padding: '0.875em 1.5em 1.4em',
              borderTop: '1px solid rgba(0,0,0,0.06)',
              display: 'flex',
              gap: '0.75em',
              justifyContent: 'flex-end',
            }}
          >
            <button onClick={() => setShowSettings(false)} className="btn-ghost">
              Cancel
            </button>
            <button onClick={handleSave} className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4em' }}>
              {saved ? (
                <>
                  <CheckCircle size={13} />
                  Saved!
                </>
              ) : (
                'Save Key'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

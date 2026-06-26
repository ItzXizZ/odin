import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { LogOut } from 'lucide-react'
import { useAuth } from '../lib/auth'

export default function UserMenu() {
  const { authEnabled, user, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  // Nothing to show in local mode (no auth configured) or before sign-in.
  if (!authEnabled || !user) return null

  const meta = user.user_metadata ?? {}
  const name: string = meta.full_name || meta.name || user.email || 'Account'
  const avatar: string | undefined = meta.avatar_url || meta.picture
  const initial = (name || '?').trim().charAt(0).toUpperCase()

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
        style={{
          width: 34,
          height: 34,
          borderRadius: '50%',
          overflow: 'hidden',
          border: '1px solid rgba(0,0,0,0.12)',
          background: 'rgba(255,255,255,0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          fontSize: 14,
          fontWeight: 600,
          color: 'rgba(40,40,40,0.85)',
          padding: 0,
        }}
      >
        {avatar ? (
          <img
            src={avatar}
            alt=""
            referrerPolicy="no-referrer"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          initial
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            style={{
              position: 'absolute',
              right: 0,
              top: 'calc(100% + 8px)',
              minWidth: 220,
              background: 'rgba(255,255,255,0.85)',
              backdropFilter: 'blur(18px)',
              WebkitBackdropFilter: 'blur(18px)',
              border: '1px solid rgba(0,0,0,0.08)',
              borderRadius: 14,
              boxShadow: '0 16px 40px rgba(0,0,0,0.16)',
              padding: 8,
              zIndex: 50,
            }}
          >
            <div style={{ padding: '8px 10px 10px' }}>
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: 'rgba(30,30,30,0.9)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {name}
              </div>
              {user.email && (
                <div
                  style={{
                    fontSize: 12,
                    color: 'rgba(60,60,60,0.6)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {user.email}
                </div>
              )}
            </div>
            <div style={{ height: 1, background: 'rgba(0,0,0,0.07)', margin: '2px 0 6px' }} />
            <button
              onClick={() => {
                setOpen(false)
                void signOut()
              }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 10px',
                borderRadius: 9,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontSize: 13.5,
                color: 'rgba(40,40,40,0.9)',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(0,0,0,0.05)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <LogOut size={16} />
              Sign out
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

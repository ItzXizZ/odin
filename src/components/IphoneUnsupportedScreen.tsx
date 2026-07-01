import { motion } from 'framer-motion'
import logo from './logo.png'

export function isIPhoneDevice(): boolean {
  return typeof navigator !== 'undefined' && /iPhone/i.test(navigator.userAgent)
}

export default function IphoneUnsupportedScreen() {
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
          iPhone experience arriving soon
        </h1>
        <p
          style={{
            marginTop: 8,
            fontSize: 14.5,
            lineHeight: 1.5,
            color: 'rgba(60,60,60,0.7)',
          }}
        >
          Odin is engineered for the desktop experience. Please visit from a Mac or PC
          to access the full studio.
        </p>
      </motion.div>
    </div>
  )
}

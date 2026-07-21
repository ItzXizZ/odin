import { useEffect, useRef, useState } from 'react'

/**
 * Renders a shareable verdict image on a <canvas> and offers download / native
 * share / copy-text. The image is the viral unit: prompt + scores + Odin's
 * roast, with no essay exposure.
 */
export interface ShareCardData {
  topic: string
  playerName: string
  opponentName: string
  playerScore: number
  opponentScore: number
  won: boolean
  roast: string
  rating?: number
  footer?: string
}

export default function ShareCard({
  data,
  shareString,
}: {
  data: ShareCardData
  shareString: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = 1200
    const H = 630
    canvas.width = W
    canvas.height = H

    // Background
    const grad = ctx.createLinearGradient(0, 0, W, H)
    grad.addColorStop(0, '#1a1a20')
    grad.addColorStop(1, '#0e0e12')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, W, H)

    // Accent glow
    const glow = ctx.createRadialGradient(W / 2, -100, 100, W / 2, -100, 700)
    glow.addColorStop(0, 'rgba(96,132,255,0.35)')
    glow.addColorStop(1, 'rgba(96,132,255,0)')
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, W, H)

    ctx.textAlign = 'center'

    // Eyebrow
    ctx.fillStyle = 'rgba(96,132,255,1)'
    ctx.font = '700 26px Inter, Arial, sans-serif'
    ctx.fillText('ODIN ARENA  ⚔', W / 2, 90)

    // Topic
    ctx.fillStyle = '#ffffff'
    ctx.font = '700 46px Inter, Arial, sans-serif'
    wrapText(ctx, data.topic, W / 2, 165, W - 200, 54)

    // Score line
    ctx.font = '800 120px Inter, Arial, sans-serif'
    const scoreY = 360
    ctx.fillStyle = data.won ? '#5be08a' : '#ffffff'
    ctx.textAlign = 'right'
    ctx.fillText(String(data.playerScore), W / 2 - 60, scoreY)
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.textAlign = 'center'
    ctx.font = '700 60px Inter, Arial, sans-serif'
    ctx.fillText('vs', W / 2, scoreY - 20)
    ctx.font = '800 120px Inter, Arial, sans-serif'
    ctx.fillStyle = !data.won ? '#ff7a7a' : 'rgba(255,255,255,0.85)'
    ctx.textAlign = 'left'
    ctx.fillText(String(data.opponentScore), W / 2 + 60, scoreY)

    // Names
    ctx.textAlign = 'center'
    ctx.font = '500 24px Inter, Arial, sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.fillText(`${data.playerName}   ·   ${data.opponentName}`, W / 2, scoreY + 45)

    // Roast
    ctx.fillStyle = 'rgba(255,255,255,0.92)'
    ctx.font = 'italic 500 30px Inter, Arial, sans-serif'
    wrapText(ctx, `"${data.roast}"`, W / 2, 470, W - 220, 40)

    // Footer
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '600 24px Inter, Arial, sans-serif'
    ctx.fillText(data.footer || 'odinwrite.com/arena', W / 2, H - 45)
  }, [data])

  const filename = 'odin-arena.png'

  async function handleDownload() {
    const canvas = canvasRef.current
    if (!canvas) return
    const url = canvas.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
  }

  async function handleShare() {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
      if (blob && navigator.canShare?.({ files: [new File([blob], filename, { type: 'image/png' })] })) {
        await navigator.share({
          files: [new File([blob], filename, { type: 'image/png' })],
          text: shareString,
        })
        return
      }
      if (navigator.share) {
        await navigator.share({ text: shareString })
        return
      }
    } catch {
      /* user cancelled or unsupported */
    }
    void handleCopy()
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(shareString)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <div className="arena-share">
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          maxWidth: 480,
          borderRadius: 16,
          boxShadow: '0 16px 40px rgba(0,0,0,0.25)',
        }}
      />
      <div className="arena-share-btns">
        <button className="arena-btn primary" onClick={handleShare}>
          Share
        </button>
        <button className="arena-btn" onClick={handleDownload}>
          Download image
        </button>
        <button className="arena-btn" onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy result'}
        </button>
      </div>
      <pre className="arena-share-string">{shareString}</pre>
    </div>
  )
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
) {
  const words = text.split(' ')
  let line = ''
  let cursorY = y
  for (const word of words) {
    const test = line ? `${line} ${word}` : word
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, cursorY)
      line = word
      cursorY += lineHeight
    } else {
      line = test
    }
  }
  if (line) ctx.fillText(line, x, cursorY)
}

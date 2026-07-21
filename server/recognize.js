/**
 * Handwriting → LaTeX recognition proxy for the math whiteboard.
 *
 * The browser sends raw vector ink (per-stroke x/y/t/p arrays, already
 * normalized to a positive-origin pixel space); this endpoint signs the
 * request with the MyScript HMAC key (which must never reach the client)
 * and forwards it to the iink Cloud batch REST API.
 *
 * We ask for a single JIIX export configured with:
 *   - math-label  → whole-board LaTeX string
 *   - strokes     → each recognized expression carries the ink that formed it,
 *                   which the client maps back to its own stroke IDs (the
 *                   backbone for "look at your third equation" highlighting)
 *   - bounding-box / ids for good measure
 */

import crypto from 'crypto'

const IINK_URL = 'https://cloud.myscript.com/api/v4.0/iink/batch'
const MAX_STROKES = 1500
const MAX_POINTS_PER_STROKE = 4000

function hmacOf(body, appKey, hmacKey) {
  return crypto.createHmac('sha512', appKey + hmacKey).update(body).digest('hex')
}

export function registerRecognizeRoutes(app) {
  app.post('/api/math/recognize', async (req, res) => {
    const appKey = process.env.MYSCRIPT_APP_KEY
    const hmacKey = process.env.MYSCRIPT_HMAC_KEY
    if (!appKey || !hmacKey) {
      return res.status(501).json({ error: 'Handwriting recognition is not configured on this server.' })
    }

    const { strokes, width, height } = req.body || {}
    if (!Array.isArray(strokes) || strokes.length === 0) {
      return res.status(400).json({ error: 'No strokes to recognize.' })
    }
    if (strokes.length > MAX_STROKES) {
      return res.status(400).json({ error: 'Too many strokes for one recognition request.' })
    }

    const cleaned = []
    for (const s of strokes) {
      if (!s || !Array.isArray(s.x) || !Array.isArray(s.y)) continue
      const n = Math.min(s.x.length, s.y.length, MAX_POINTS_PER_STROKE)
      if (n === 0) continue
      const stroke = {
        x: s.x.slice(0, n).map(Number),
        y: s.y.slice(0, n).map(Number),
        pointerType: 'PEN',
      }
      // iink requires t to line up with x/y when present; synthesize a steady
      // 10ms cadence for pre-timestamp strokes loaded from old boards.
      const t = Array.isArray(s.t) && s.t.length >= n ? s.t.slice(0, n).map(Number) : null
      stroke.t = t ?? Array.from({ length: n }, (_, i) => i * 10)
      if (Array.isArray(s.p) && s.p.length >= n) stroke.p = s.p.slice(0, n).map(Number)
      cleaned.push(stroke)
    }
    if (cleaned.length === 0) {
      return res.status(400).json({ error: 'No valid strokes to recognize.' })
    }

    const payload = {
      contentType: 'Math',
      width: Math.max(100, Math.round(Number(width) || 2000)),
      height: Math.max(100, Math.round(Number(height) || 2000)),
      xDPI: 96,
      yDPI: 96,
      configuration: {
        math: {
          mimeTypes: ['application/vnd.myscript.jiix'],
          solver: { enable: false },
        },
        export: {
          jiix: {
            strokes: true,
            'bounding-box': true,
            'math-label': true,
            ids: true,
          },
        },
      },
      strokeGroups: [{ strokes: cleaned }],
    }

    const body = JSON.stringify(payload)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    try {
      const upstream = await fetch(IINK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/vnd.myscript.jiix',
          applicationKey: appKey,
          hmac: hmacOf(body, appKey, hmacKey),
        },
        body,
        signal: controller.signal,
      })

      const text = await upstream.text()
      if (!upstream.ok) {
        console.error('[recognize] iink error', upstream.status, text.slice(0, 500))
        return res
          .status(upstream.status === 401 ? 502 : 502)
          .json({ error: `Recognition service error (${upstream.status}).` })
      }

      let jiix
      try {
        jiix = JSON.parse(text)
      } catch {
        return res.status(502).json({ error: 'Recognition service returned an unreadable result.' })
      }
      res.json({ jiix })
    } catch (err) {
      const aborted = err?.name === 'AbortError'
      console.error('[recognize] request failed:', aborted ? 'timeout' : err?.message)
      res.status(502).json({ error: aborted ? 'Recognition timed out.' : 'Recognition request failed.' })
    } finally {
      clearTimeout(timer)
    }
  })
}

/**
 * ElevenLabs TTS proxy — keeps the API key server-side.
 * Bill: deep, warm American baritone — trusted-teacher / documentary tone.
 */

const ELEVENLABS_API = 'https://api.elevenlabs.io/v1'

/** Premade voice — Bill (deep American baritone, history-teacher vibe). */
const DEFAULT_VOICE_ID = 'pqHfZKP75CvOlQylNhV4'
const DEFAULT_MODEL = 'eleven_turbo_v2_5'

export function isElevenLabsConfigured() {
  return Boolean(process.env.ELEVENLABS_API_KEY?.trim())
}

function voiceId() {
  return process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE_ID
}

function modelId() {
  return process.env.ELEVENLABS_MODEL_ID?.trim() || DEFAULT_MODEL
}

export function registerTtsRoutes(app) {
  app.get('/api/tts/status', (_req, res) => {
    if (!isElevenLabsConfigured()) {
      return res.json({ available: false })
    }
    res.json({
      available: true,
      provider: 'elevenlabs',
      voice: process.env.ELEVENLABS_VOICE_NAME?.trim() || 'Bill',
    })
  })

  app.post('/api/tts/speak', async (req, res) => {
    if (!isElevenLabsConfigured()) {
      return res.status(503).json({ error: 'TTS not configured' })
    }

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
    if (!text) return res.status(400).json({ error: 'text required' })
    if (text.length > 1200) return res.status(400).json({ error: 'text too long' })

    try {
      const upstream = await fetch(`${ELEVENLABS_API}/text-to-speech/${voiceId()}`, {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: modelId(),
          voice_settings: {
            stability: 0.62,
            similarity_boost: 0.78,
            style: 0.12,
            use_speaker_boost: true,
          },
        }),
      })

      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '')
        console.warn('[tts] ElevenLabs error:', upstream.status, detail.slice(0, 200))
        return res.status(502).json({ error: 'TTS synthesis failed' })
      }

      const audio = Buffer.from(await upstream.arrayBuffer())
      res.setHeader('Content-Type', 'audio/mpeg')
      res.setHeader('Cache-Control', 'no-store')
      res.send(audio)
    } catch (err) {
      console.warn('[tts] request failed:', err.message)
      res.status(500).json({ error: err.message })
    }
  })
}

// One-shot sanity check of the MyScript iink batch API with the .env keys.
// Sends a vertical stroke (should recognize as "1") and prints the JIIX.
import crypto from 'crypto'
import dotenv from 'dotenv'
dotenv.config()

const appKey = process.env.MYSCRIPT_APP_KEY
const hmacKey = process.env.MYSCRIPT_HMAC_KEY
if (!appKey || !hmacKey) throw new Error('MyScript keys missing from .env')

const ys = Array.from({ length: 20 }, (_, i) => 100 + i * 3)
const payload = {
  contentType: 'Math',
  width: 400,
  height: 300,
  xDPI: 96,
  yDPI: 96,
  configuration: {
    math: { mimeTypes: ['application/vnd.myscript.jiix'], solver: { enable: false } },
    export: { jiix: { strokes: true, 'bounding-box': true, 'math-label': true, ids: true } },
  },
  strokeGroups: [
    {
      strokes: [
        {
          x: ys.map(() => 120),
          y: ys,
          t: ys.map((_, i) => i * 12),
          pointerType: 'PEN',
        },
        // A second "1" well below — should segment as a separate expression.
        {
          x: ys.map(() => 125),
          y: ys.map((y) => y + 120),
          t: ys.map((_, i) => 2000 + i * 12),
          pointerType: 'PEN',
        },
      ],
    },
  ],
}

const body = JSON.stringify(payload)
const hmac = crypto.createHmac('sha512', appKey + hmacKey).update(body).digest('hex')

const res = await fetch('https://cloud.myscript.com/api/v4.0/iink/batch', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/vnd.myscript.jiix',
    applicationKey: appKey,
    hmac,
  },
  body,
})

console.log('status:', res.status)
const text = await res.text()
console.log(text.slice(0, 2000))

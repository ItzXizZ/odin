// Integration test of /api/math/recognize without booting the whole server.
import express from 'express'
import dotenv from 'dotenv'
import { registerRecognizeRoutes } from '../server/recognize.js'
dotenv.config()

const app = express()
app.use(express.json({ limit: '10mb' }))
registerRecognizeRoutes(app)
const srv = app.listen(3999)

// "1 + 1" as three strokes, pre-normalized like the client does (positive px).
const vert = (x0, y0) => ({
  id: `s-${x0}-${y0}`,
  x: Array.from({ length: 15 }, () => x0),
  y: Array.from({ length: 15 }, (_, i) => y0 + i * 4),
  t: Array.from({ length: 15 }, (_, i) => i * 10),
})
const horiz = (x0, y0) => ({
  id: `h-${x0}-${y0}`,
  x: Array.from({ length: 15 }, (_, i) => x0 + i * 3),
  y: Array.from({ length: 15 }, () => y0),
  t: Array.from({ length: 15 }, (_, i) => i * 10),
})

const res = await fetch('http://localhost:3999/api/math/recognize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    width: 500,
    height: 300,
    strokes: [
      vert(100, 100), // 1
      horiz(150, 125), // + (horizontal bar)
      vert(172, 105), // + (vertical bar)
      vert(220, 100), // 1
    ],
  }),
})

console.log('status:', res.status)
const data = await res.json()
console.log('label:', data.jiix?.label)
console.log('expressions:', data.jiix?.expressions?.length)
srv.close()

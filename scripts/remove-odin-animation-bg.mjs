import sharp from 'sharp'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

function sampleBackground(data, width, height, channels) {
  const points = [
    [2, 2],
    [width - 3, 2],
    [2, height - 3],
    [width - 3, height - 3],
    [Math.floor(width / 2), 2],
    [2, Math.floor(height / 2)],
    [width - 3, Math.floor(height / 2)],
    [Math.floor(width / 2), height - 3],
  ]
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (const [x, y] of points) {
    const i = (y * width + x) * channels
    if (data[i + 3] < 128) continue
    r += data[i]
    g += data[i + 1]
    b += data[i + 2]
    n++
  }
  if (!n) return [243, 243, 243]
  return [r / n, g / n, b / n]
}

function colorDist(r, g, b, bg) {
  return Math.sqrt((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2)
}

function isBackgroundPixel(data, idx, channels, bg, threshold) {
  const i = idx * channels
  return colorDist(data[i], data[i + 1], data[i + 2], bg) <= threshold
}

/** Push off-white interior fills to pure #fff without bleaching line art. */
function whitenInteriors(data, channels) {
  for (let i = 0; i < data.length; i += channels) {
    const a = data[i + 3]
    if (a === 0) continue

    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const min = Math.min(r, g, b)
    const max = Math.max(r, g, b)

    if (min >= 192) {
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      continue
    }

    if (min >= 155 && max >= 182) {
      const t = Math.min(1, (min - 155) / 48)
      data[i] = Math.round(r + (255 - r) * t)
      data[i + 1] = Math.round(g + (255 - g) * t)
      data[i + 2] = Math.round(b + (255 - b) * t)
    }
  }
}

function boostContrast(data, channels) {
  const contrast = 1.06
  for (let i = 0; i < data.length; i += channels) {
    const a = data[i + 3]
    if (a === 0) continue
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    if (Math.min(r, g, b) < 120) {
      for (let c = 0; c < 3; c++) {
        const v = data[i + c]
        data[i + c] = Math.max(0, Math.min(255, Math.round((v - 128) * contrast + 128)))
      }
    }
  }
}

export async function processOdinFrame(filePath, { removeBg = true } = {}) {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width, height, channels } = info
  const opaqueCorners = sampleBackground(data, width, height, channels)
  const cornersTransparent = opaqueCorners.every((_, idx) => {
    const points = [[2, 2], [width - 3, 2]]
    return points.some(([x, y]) => data[(y * width + x) * channels + 3] < 128)
  })

  if (removeBg && !cornersTransparent) {
    const bg = opaqueCorners
    const threshold = 50
    const visited = new Uint8Array(width * height)
    const queue = []

    const tryPush = (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return
      const idx = y * width + x
      if (visited[idx]) return
      if (!isBackgroundPixel(data, idx, channels, bg, threshold)) return
      visited[idx] = 1
      queue.push(idx)
    }

    for (let x = 0; x < width; x++) {
      tryPush(x, 0)
      tryPush(x, height - 1)
    }
    for (let y = 0; y < height; y++) {
      tryPush(0, y)
      tryPush(width - 1, y)
    }

    while (queue.length) {
      const idx = queue.pop()
      const pi = idx * channels
      data[pi + 3] = 0
      const x = idx % width
      const y = Math.floor(idx / width)
      tryPush(x - 1, y)
      tryPush(x + 1, y)
      tryPush(x, y - 1)
      tryPush(x, y + 1)
    }

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x
        const pi = idx * channels
        if (data[pi + 3] === 0) continue
        let transparentNeighbors = 0
        for (const [nx, ny] of [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ]) {
          const ni = (ny * width + nx) * channels
          if (data[ni + 3] === 0) transparentNeighbors++
        }
        if (transparentNeighbors > 0) {
          const d = colorDist(data[pi], data[pi + 1], data[pi + 2], bg)
          if (d < threshold + 28) {
            data[pi + 3] = Math.round(data[pi + 3] * Math.min(1, (d - threshold) / 28))
          }
        }
      }
    }
  }

  boostContrast(data, channels)
  whitenInteriors(data, channels)

  await sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .trim({ threshold: 12 })
    .toFile(filePath)

  console.log(`Processed ${path.basename(filePath)}`)
}

const DEFAULT_FILES = [
  path.join(root, 'src', 'components', 'Animation 1.png'),
  path.join(root, 'src', 'components', 'Animation 2.png'),
  path.join(root, 'src', 'components', 'Animation 3.png'),
]

const files = process.argv.slice(2).map((f) => path.resolve(f))
const targets = files.length ? files : DEFAULT_FILES

for (const file of targets) {
  await processOdinFrame(file, { removeBg: false })
}

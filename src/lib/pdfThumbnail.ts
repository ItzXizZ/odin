import * as pdfjsLib from 'pdfjs-dist'
// Vite bundles the worker as a separate asset and gives us its URL
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — Vite ?url suffix is not in TS types but works at build time
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc as string

/**
 * Renders the first page of a PDF File to a JPEG data URL suitable for use
 * as a thumbnail. Returns null on failure so callers can degrade gracefully.
 */
export async function renderPDFThumbnail(
  file: File,
  targetWidth = 220
): Promise<string | null> {
  try {
    const arrayBuffer = await file.arrayBuffer()
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer })
    const pdf = await loadingTask.promise

    const page = await pdf.getPage(1)
    const viewport = page.getViewport({ scale: 1 })

    const scale = targetWidth / viewport.width
    const scaled = page.getViewport({ scale })

    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(scaled.width)
    canvas.height = Math.floor(scaled.height)

    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    await page.render({ canvasContext: ctx, viewport: scaled, canvas }).promise

    return canvas.toDataURL('image/jpeg', 0.82)
  } catch (err) {
    console.warn('[pdfThumbnail] render failed:', err)
    return null
  }
}

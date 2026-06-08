import type { DiffChange } from './DiffReview'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Plain text → paragraph HTML (double newlines split paragraphs). */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${esc(para).replace(/\n/g, '<br/>') || '<br/>'}</p>`)
    .join('')
}

function wrapPiece(piece: string, cls: 'insert' | 'delete' | null): string {
  if (piece === '') return ''
  const html = esc(piece).replace(/\n/g, '<br/>')
  if (!cls) return html
  const klass = cls === 'insert' ? 'diff-ins' : 'diff-del'
  return `<span data-diff="${cls}" class="${klass}">${html}</span>`
}

/**
 * Convert a word-level diff into paragraph HTML where added text carries the
 * insertion mark and removed text carries the deletion mark, so the editor can
 * show both inline and resolve them per-hunk.
 */
export function diffToHtml(diff: DiffChange[]): string {
  const paras: string[] = []
  let cur = ''
  for (const part of diff) {
    const cls: 'insert' | 'delete' | null = part.added ? 'insert' : part.removed ? 'delete' : null
    const segments = part.value.split(/\n{2,}/)
    segments.forEach((seg, i) => {
      if (i > 0) {
        paras.push(cur)
        cur = ''
      }
      cur += wrapPiece(seg, cls)
    })
  }
  paras.push(cur)
  return paras.map((p) => `<p>${p || '<br/>'}</p>`).join('')
}

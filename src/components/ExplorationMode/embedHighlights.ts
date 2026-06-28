import { wrapRangeWithMark } from './textMarks'

const STYLE_ID = 'odin-embed-highlight-styles'

const PERSISTED = {
  bg: 'rgba(255, 196, 46, 0.42)',
  border: '2px solid rgba(180, 120, 0, 0.75)',
}
const PENDING = {
  bg: 'rgba(255, 196, 46, 0.65)',
  border: '2.5px solid rgba(160, 100, 0, 0.9)',
}

/** Styles injected into the iframe so marks survive hostile site CSS. */
export function ensureEmbedHighlightStyles(doc: Document) {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    ::highlight(odin-pending) {
      background-color: ${PENDING.bg};
      color: inherit;
    }
    ::highlight(odin-mark) {
      background-color: ${PERSISTED.bg};
      color: inherit;
    }
    span.branch-mark,
    span.branch-mark-pending {
      display: inline !important;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
      color: inherit !important;
    }
    span.branch-mark {
      background-color: ${PERSISTED.bg} !important;
      border-bottom: ${PERSISTED.border} !important;
      border-radius: 2px;
    }
    span.branch-mark-pending {
      background-color: ${PENDING.bg} !important;
      border-bottom: ${PENDING.border} !important;
      border-radius: 2px;
      box-shadow: 0 0 0 2px rgba(255, 196, 46, 0.35);
    }
  `
  doc.head.appendChild(style)
}

function cssHighlights(doc: Document) {
  return doc.defaultView?.CSS?.highlights
}

function canUseCssHighlights(doc: Document): boolean {
  return typeof doc.defaultView?.Highlight === 'function' && !!cssHighlights(doc)
}

/** Paint pending selection — CSS Highlight API when available, else inline spans. */
export function showPendingEmbedHighlight(doc: Document, range: Range): boolean {
  ensureEmbedHighlightStyles(doc)
  clearPendingEmbedHighlight(doc)

  if (canUseCssHighlights(doc)) {
    try {
      const HighlightCtor = doc.defaultView!.Highlight as typeof Highlight
      cssHighlights(doc)!.set('odin-pending', new HighlightCtor(range))
      return true
    } catch {
      /* fall through to DOM marks */
    }
  }

  return wrapRangeWithMark(range, 'branch-mark-pending')
}

export function clearPendingEmbedHighlight(doc: Document) {
  cssHighlights(doc)?.delete('odin-pending')
  doc.querySelectorAll('span.branch-mark-pending').forEach((span) => {
    const parent = span.parentNode
    if (!parent) return
    while (span.firstChild) parent.insertBefore(span.firstChild, span)
    parent.removeChild(span)
  })
}

export function clearAllCssHighlights(doc: Document) {
  cssHighlights(doc)?.delete('odin-pending')
  cssHighlights(doc)?.delete('odin-mark')
}

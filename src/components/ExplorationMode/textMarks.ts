/** Collapse whitespace for fuzzy matching across block boundaries. */
function normalizeSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function unwrapMarks(root: HTMLElement) {
  root.querySelectorAll('span.branch-mark, span.branch-mark-pending').forEach((span) => {
    const parent = span.parentNode
    if (!parent) return
    while (span.firstChild) parent.insertBefore(span.firstChild, span)
    parent.removeChild(span)
  })
}

/** Map a normalized-string index back to an index in the raw concatenated text. */
function buildNormMap(raw: string): { norm: string; toOrig: number[] } {
  let norm = ''
  const toOrig: number[] = []
  let prevSpace = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (/\s/.test(ch)) {
      if (!prevSpace && norm.length > 0) {
        toOrig[norm.length] = i
        norm += ' '
        prevSpace = true
      }
    } else {
      toOrig[norm.length] = i
      norm += ch
      prevSpace = false
    }
  }
  return { norm, toOrig }
}

function collectTextNodes(root: HTMLElement): { nodes: { node: Text; start: number }[]; full: string } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: { node: Text; start: number }[] = []
  let full = ''
  let n: Node | null
  while ((n = walker.nextNode())) {
    nodes.push({ node: n as Text, start: full.length })
    full += (n as Text).nodeValue ?? ''
  }
  return { nodes, full }
}

function wrapTextSegment(node: Text, start: number, end: number, className: string) {
  if (start >= end) return false

  let piece: Text = node
  if (start > 0) piece = piece.splitText(start)
  const len = end - start
  if (len < (piece.nodeValue?.length ?? 0)) piece.splitText(len)

  const span = node.ownerDocument!.createElement('span')
  span.className = className
  const pending = className.includes('pending')
  span.style.setProperty('display', 'inline', 'important')
  span.style.setProperty(
    'background-color',
    pending ? 'rgba(255, 196, 46, 0.65)' : 'rgba(255, 196, 46, 0.42)',
    'important'
  )
  span.style.setProperty(
    'border-bottom',
    pending ? '2.5px solid rgba(160, 100, 0, 0.9)' : '2px solid rgba(180, 120, 0, 0.75)',
    'important'
  )
  span.style.setProperty('border-radius', '2px')
  span.style.setProperty('color', 'inherit', 'important')
  if (pending) {
    span.style.setProperty('box-shadow', '0 0 0 2px rgba(255, 196, 46, 0.35)')
  }
  piece.parentNode?.insertBefore(span, piece)
  span.appendChild(piece)
  return true
}

function wrapTextSlice(
  nodes: { node: Text; start: number }[],
  start: number,
  end: number,
  className: string
) {
  for (const { node, start: nodeStart } of nodes) {
    const nodeEnd = nodeStart + (node.nodeValue?.length ?? 0)
    if (nodeEnd <= start || nodeStart >= end) continue

    const a = Math.max(start, nodeStart) - nodeStart
    const b = Math.min(end, nodeEnd) - nodeStart
    wrapTextSegment(node, a, b, className)
  }
}

function textNodeIntersectsRange(range: Range, textNode: Text): boolean {
  if (typeof range.intersectsNode === 'function') {
    try {
      return range.intersectsNode(textNode)
    } catch {
      /* fall through */
    }
  }
  const doc = textNode.ownerDocument
  if (!doc) return false
  const nodeRange = doc.createRange()
  nodeRange.selectNodeContents(textNode)
  return (
    range.compareBoundaryPoints(Range.END_TO_START, nodeRange) <= 0 &&
    range.compareBoundaryPoints(Range.START_TO_END, nodeRange) >= 0
  )
}

/** Text slices covered by a range — never pulls block elements out of place. */
function getTextSegmentsFromRange(range: Range): { node: Text; start: number; end: number }[] {
  if (range.collapsed) return []

  if (
    range.startContainer === range.endContainer &&
    range.startContainer.nodeType === Node.TEXT_NODE
  ) {
    const node = range.startContainer as Text
    const start = range.startOffset
    const end = range.endOffset
    return start < end ? [{ node, start, end }] : []
  }

  const ancestor = range.commonAncestorContainer
  const root: Node | null =
    ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentNode
  if (!root) return []

  const segments: { node: Text; start: number; end: number }[] = []
  const walker = (root.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let textNode: Node | null

  while ((textNode = walker.nextNode())) {
    const tn = textNode as Text
    const len = tn.length
    if (len === 0 || !textNodeIntersectsRange(range, tn)) continue

    const start = range.startContainer === tn ? range.startOffset : 0
    const end = range.endContainer === tn ? range.endOffset : len
    if (start < end) segments.push({ node: tn, start, end })
  }

  return segments
}

function findPhraseBounds(
  root: HTMLElement,
  phrase: string
): { nodes: { node: Text; start: number }[]; start: number; end: number } | null {
  const target = phrase.trim()
  if (target.length < 2) return null

  const { nodes, full } = collectTextNodes(root)

  let idx = full.indexOf(target)
  if (idx !== -1) return { nodes, start: idx, end: idx + target.length }

  const { norm, toOrig } = buildNormMap(full)
  const normTarget = normalizeSpaces(target)
  const nIdx = norm.indexOf(normTarget)
  if (nIdx === -1) return null

  const start = toOrig[nIdx]
  const endChar = toOrig[nIdx + normTarget.length - 1]
  if (start == null || endChar == null) return null
  return { nodes, start, end: endChar + 1 }
}

function markPhrase(root: HTMLElement, phrase: string, className = 'branch-mark') {
  const bounds = findPhraseBounds(root, phrase)
  if (!bounds) return
  wrapTextSlice(bounds.nodes, bounds.start, bounds.end, className)
}

/**
 * Highlight a live selection by wrapping only the affected text nodes in inline
 * spans — never restructures block elements (no surroundContents/extractContents).
 */
export function wrapRangeWithMark(range: Range, className: string): boolean {
  const segments = getTextSegmentsFromRange(range)
  if (segments.length === 0) return false

  // Reverse order so splitText on an earlier segment doesn't shift later offsets.
  let wrapped = false
  for (let i = segments.length - 1; i >= 0; i--) {
    const { node, start, end } = segments[i]
    if (wrapTextSegment(node, start, end, className)) wrapped = true
  }
  return wrapped
}

export function applyPersistedMarks(root: HTMLElement, phrases: string[]) {
  root.querySelectorAll('span.branch-mark').forEach((span) => {
    const parent = span.parentNode
    if (!parent) return
    while (span.firstChild) parent.insertBefore(span.firstChild, span)
    parent.removeChild(span)
  })
  for (const p of phrases) markPhrase(root, p)
}

export function applyMarks(
  root: HTMLElement,
  phrases: string[],
  pendingPhrase?: string,
  opts?: { keepExistingPending?: boolean }
) {
  const keepPending =
    opts?.keepExistingPending &&
    pendingPhrase &&
    root.querySelector('span.branch-mark-pending')

  if (keepPending) {
    root.querySelectorAll('span.branch-mark').forEach((span) => {
      const parent = span.parentNode
      if (!parent) return
      while (span.firstChild) parent.insertBefore(span.firstChild, span)
      parent.removeChild(span)
    })
    for (const p of phrases) markPhrase(root, p)
  } else {
    unwrapMarks(root)
    for (const p of phrases) markPhrase(root, p)
    if (pendingPhrase) markPhrase(root, pendingPhrase, 'branch-mark-pending')
  }
}

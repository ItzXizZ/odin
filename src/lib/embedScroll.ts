/** Find every element that may carry the main document scroll inside a proxied iframe. */
export function getIframeScrollRoots(doc: Document): HTMLElement[] {
  const seen = new Set<HTMLElement>()
  const roots: HTMLElement[] = []

  const add = (el: Element | null | undefined) => {
    if (!(el instanceof HTMLElement) || seen.has(el)) return
    seen.add(el)
    roots.push(el)
  }

  add(doc.scrollingElement as HTMLElement | null)
  add(doc.documentElement)
  add(doc.body)

  if (doc.body) {
    for (const el of doc.body.querySelectorAll('*')) {
      if (!(el instanceof HTMLElement)) continue
      const oy = doc.defaultView?.getComputedStyle(el).overflowY
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue
      if (el.scrollHeight > el.clientHeight + 4) add(el)
    }
  }

  return roots
}

export function readIframeScrollTop(doc: Document): number {
  let max = 0
  for (const el of getIframeScrollRoots(doc)) {
    if (el.scrollTop > max) max = el.scrollTop
  }
  return max
}

/** Apply scroll to every plausible root — article layouts differ on which node actually scrolls. */
export function writeIframeScrollTop(doc: Document, top: number) {
  if (top <= 0) return
  for (const el of getIframeScrollRoots(doc)) {
    el.scrollTop = top
  }
}

/** Retry scroll restore while late-loading assets expand the document. */
export function scheduleIframeScrollRestore(
  doc: Document,
  top: number,
  timers: ReturnType<typeof setTimeout>[]
) {
  if (top <= 0) return

  const apply = () => writeIframeScrollTop(doc, top)

  apply()
  requestAnimationFrame(apply)
  for (const delay of [50, 150, 400, 900, 1800, 3200, 5000]) {
    timers.push(setTimeout(apply, delay))
  }
}

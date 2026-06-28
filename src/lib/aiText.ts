/** Strip ``` fences the model adds despite instructions. */
export function stripCodeFences(text: string): string {
  let t = text.trim()
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
  }
  return t
}

const MARKDOWNISH =
  /(^|\n)#{1,6}\s|(^|\n)#{1,6}$|\*\*[^*\n]+\*\*|__[^_\n]+__|(^|\n)\s*[-*+]\s+|(^|\n)\s*\d+[.)]\s+|`[^`\n]+`|(^|\n)>\s|(^|\n)(-{3,}|\*{3,}|_{3,})\s*$|\[[^\]\n]+\]\([^)\n]+\)/

/** True when AI text still carries Markdown syntax. */
export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWNISH.test(text)
}

/** Normalize a raw model response before parsing or diffing. */
export function normalizeAiResponse(raw: string): string {
  return stripCodeFences(raw)
}

/** Turn model escape sequences into real whitespace after JSON.parse. */
export function unescapeModelText(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
}

/** True when output looks like structured JSON rather than plain prose. */
export function looksLikeJsonResponse(raw: string): boolean {
  const t = stripCodeFences(raw).trim()
  return t.startsWith('{') && (t.includes('"content"') || t.includes('"edits"') || t.includes('"type"'))
}

/** Convert Markdown Claude tends to emit into TipTap-friendly HTML. */
export function markdownishToHtml(text: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

  const out: string[] = []
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    let para: string[] = []
    let list: { tag: 'ul' | 'ol'; items: string[] } | null = null
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`)
      para = []
    }
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`)
      list = null
    }
    for (const line of lines) {
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
        flushPara()
        flushList()
        out.push('<hr>')
        continue
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/) ?? line.match(/^(#{1,6})(.+)$/)
      const bullet = line.match(/^[-*+]\s+(.*)$/)
      const numbered = line.match(/^\d+[.)]\s+(.*)$/)
      const quote = line.match(/^>\s?(.*)$/)
      if (heading) {
        flushPara()
        flushList()
        const level = Math.min(heading[1].length, 3)
        const body = heading[2] ?? ''
        out.push(`<h${level}>${inline(body)}</h${level}>`)
      } else if (quote) {
        flushPara()
        flushList()
        out.push(`<blockquote><p>${inline(quote[1])}</p></blockquote>`)
      } else if (bullet || numbered) {
        flushPara()
        const tag = bullet ? 'ul' : 'ol'
        const item = inline((bullet ?? numbered)![1])
        if (list && list.tag === tag) list.items.push(item)
        else {
          flushList()
          list = { tag, items: [item] }
        }
      } else {
        flushList()
        para.push(line)
      }
    }
    flushPara()
    flushList()
  }
  return out.join('').replace(/<\/ul><ul>/g, '').replace(/<\/ol><ol>/g, '')
}

/** After accepting AI edits, turn any leftover Markdown into rich document HTML. */
export function applyRichFormattingToEditor(
  ed: { getText: (opts?: { blockSeparator?: string }) => string; commands: { setContent: (c: string, emitUpdate?: boolean) => boolean } },
  onBeforeSet?: () => void,
  onAfterSet?: () => void
): void {
  const text = ed.getText({ blockSeparator: '\n\n' })
  if (!looksLikeMarkdown(text)) return
  onBeforeSet?.()
  ed.commands.setContent(markdownishToHtml(text), false)
  onAfterSet?.()
}

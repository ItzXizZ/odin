import { Mark, Extension, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

/** Marks added text from an AI suggestion (rendered green). */
export const Insertion = Mark.create({
  name: 'insertion',
  inclusive: false,
  parseHTML() {
    return [{ tag: 'span[data-diff="insert"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-diff': 'insert', class: 'diff-ins' }), 0]
  },
})

/** Marks removed text from an AI suggestion (rendered red, struck through). */
export const Deletion = Mark.create({
  name: 'deletion',
  inclusive: false,
  parseHTML() {
    return [{ tag: 'span[data-diff="delete"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-diff': 'delete', class: 'diff-del' }), 0]
  },
})

export interface Hunk {
  from: number
  to: number
}

/** Group adjacent insertion/deletion text into reviewable hunks. */
export function buildHunks(doc: PMNode): Hunk[] {
  const hunks: Hunk[] = []
  let cur: Hunk | null = null
  doc.descendants((node, pos) => {
    if (!node.isText) return
    const changed = node.marks.some(
      (m) => m.type.name === 'insertion' || m.type.name === 'deletion'
    )
    if (!changed) return
    const start = pos
    const end = pos + node.nodeSize
    // Merge segments that touch (deletion directly followed by insertion, etc.).
    if (cur && start - cur.to <= 1) {
      cur.to = end
    } else {
      if (cur) hunks.push(cur)
      cur = { from: start, to: end }
    }
  })
  if (cur) hunks.push(cur)
  return hunks
}

/** True while the document still contains un-resolved diff marks. */
export function docHasDiff(doc: PMNode): boolean {
  let found = false
  doc.descendants((node) => {
    if (found) return false
    if (
      node.isText &&
      node.marks.some((m) => m.type.name === 'insertion' || m.type.name === 'deletion')
    ) {
      found = true
      return false
    }
    return true
  })
  return found
}

type Mode = 'accept' | 'reject'

/**
 * Resolve every diff within [from, to].
 * - accept: drop deletions, keep insertions (unmarked)
 * - reject: drop insertions, keep deletions (unmarked)
 */
export function resolveRange(view: EditorView, from: number, to: number, mode: Mode) {
  const { state } = view
  const insMark = state.schema.marks.insertion
  const delMark = state.schema.marks.deletion
  if (!insMark || !delMark) return

  type Op =
    | { kind: 'delete'; from: number; to: number }
    | { kind: 'unmark'; from: number; to: number; mark: typeof insMark }
  const ops: Op[] = []

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return
    const start = Math.max(pos, from)
    const end = Math.min(pos + node.nodeSize, to)
    if (start >= end) return
    const hasIns = node.marks.some((m) => m.type.name === 'insertion')
    const hasDel = node.marks.some((m) => m.type.name === 'deletion')
    if (!hasIns && !hasDel) return

    if (mode === 'accept') {
      if (hasDel) ops.push({ kind: 'delete', from: start, to: end })
      else if (hasIns) ops.push({ kind: 'unmark', from: start, to: end, mark: insMark })
    } else {
      if (hasIns) ops.push({ kind: 'delete', from: start, to: end })
      else if (hasDel) ops.push({ kind: 'unmark', from: start, to: end, mark: delMark })
    }
  })

  if (ops.length === 0) return
  // Apply from the end backwards so earlier positions stay valid.
  ops.sort((a, b) => b.from - a.from)
  const tr = state.tr
  for (const op of ops) {
    if (op.kind === 'delete') tr.delete(op.from, op.to)
    else tr.removeMark(op.from, op.to, op.mark)
  }
  // Strip both diff marks across the touched range to be safe.
  view.dispatch(tr)
}

export const diffPluginKey = new PluginKey('diff-review')

export interface DiffReviewOptions {
  isActive: () => boolean
  onResolveHunk: () => void
}

function makeButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = className
  btn.textContent = label
  btn.contentEditable = 'false'
  // mousedown (not click) so the editor selection doesn't swallow it.
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onClick()
  })
  return btn
}

/**
 * Extension that paints per-hunk accept/reject controls directly in the
 * document while a review is active.
 */
export const DiffReview = Extension.create<DiffReviewOptions>({
  name: 'diffReview',

  addOptions() {
    return {
      isActive: () => false,
      onResolveHunk: () => {},
    }
  },

  addProseMirrorPlugins() {
    const options = this.options
    return [
      new Plugin({
        key: diffPluginKey,
        props: {
          decorations(state) {
            if (!options.isActive()) return null
            const hunks = buildHunks(state.doc)
            if (hunks.length === 0) return null
            const decos: Decoration[] = hunks.map((hunk) =>
              Decoration.widget(
                hunk.to,
                (view) => {
                  const box = document.createElement('span')
                  box.className = 'diff-hunk-actions'
                  box.appendChild(
                    makeButton('✓', 'diff-hunk-btn diff-hunk-accept', () => {
                      const h = currentHunkAt(view, hunk)
                      if (h) resolveRange(view, h.from, h.to, 'accept')
                      options.onResolveHunk()
                    })
                  )
                  box.appendChild(
                    makeButton('✕', 'diff-hunk-btn diff-hunk-reject', () => {
                      const h = currentHunkAt(view, hunk)
                      if (h) resolveRange(view, h.from, h.to, 'reject')
                      options.onResolveHunk()
                    })
                  )
                  return box
                },
                { side: 1, ignoreSelection: true }
              )
            )
            return DecorationSet.create(state.doc, decos)
          },
        },
      }),
    ]
  },
})

/**
 * Re-resolve the hunk that currently sits at (or just before) the widget anchor.
 * Decorations rebuild every transaction, so the closed-over `hunk` is already
 * fresh; this is a safety net that re-derives the live boundaries.
 */
function currentHunkAt(view: EditorView, approx: Hunk): Hunk | null {
  const hunks = buildHunks(view.state.doc)
  if (hunks.length === 0) return null
  // Pick the hunk whose end is closest to the approximate anchor.
  let best = hunks[0]
  let bestDist = Math.abs(best.to - approx.to)
  for (const h of hunks) {
    const d = Math.abs(h.to - approx.to)
    if (d < bestDist) {
      best = h
      bestDist = d
    }
  }
  return best
}

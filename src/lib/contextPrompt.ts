/**
 * Tiered, budget-aware context assembly for AI prompts.
 * Summaries and takeaways are prioritized over raw text dumps.
 */

import type { Adventure, DocumentContext, WritingDocument } from '../store/useStore'

const TOTAL_BUDGET = 8000

interface ContextInput {
  doc: WritingDocument | null
  ctx: DocumentContext
  adventures: Adventure[]
}

function takeBudget(remaining: number, share: number, min = 120): number {
  return Math.max(min, Math.floor(remaining * share))
}

export function buildPrioritizedContext(input: ContextInput): string {
  const { doc, ctx, adventures } = input
  const parts: string[] = []
  let budget = TOTAL_BUDGET

  if (doc) {
    const line = `=== ACTIVE DOCUMENT: ${doc.title} ===`
    parts.push(line)
    budget -= line.length + 4
  }

  const linkedAdventures = ctx.linkedAdventureIds
    .map((id) => adventures.find((a) => a.id === id))
    .filter((a): a is Adventure => a != null)
    .filter((a) => a.nodes.some((n) => n.data.response) || a.takeaways.length > 0)

  // Tier 1 — PDF summaries (highest signal per token)
  if (ctx.pdfs.length > 0 && budget > 200) {
    const tierBudget = takeBudget(budget, 0.22, 200)
    const chunks: string[] = ['=== CONTEXT PDFs (summaries first) ===']
    let used = chunks[0].length
    for (const pdf of ctx.pdfs) {
      const header = `[${pdf.name}]`
      const summary = pdf.summary?.trim()
      const block = summary
        ? `${header}\nSummary: ${summary}`
        : `${header}\n${pdf.text.slice(0, Math.min(600, tierBudget - used - header.length - 8))}`
      if (used + block.length > tierBudget) break
      chunks.push(block)
      used += block.length + 2
    }
    parts.push(chunks.join('\n\n'))
    budget -= used
  }

  // Tier 2 — Adventure takeaways + concise Q&A
  if (linkedAdventures.length > 0 && budget > 200) {
    const tierBudget = takeBudget(budget, 0.38, 300)
    const chunks: string[] = ['=== LINKED RESEARCH (takeaways + key findings) ===']
    let used = chunks[0].length
    for (const adventure of linkedAdventures) {
      const header = `--- ${adventure.name} ---`
      const takeawayBlock =
        adventure.takeaways.length > 0
          ? `Takeaways:\n${adventure.takeaways.map((t) => `• ${t.text}`).join('\n')}`
          : ''
      const qa = adventure.nodes
        .filter((n) => n.data.response)
        .slice(0, 4)
        .map((n) => `Q: ${n.data.prompt}\nA: ${n.data.response.slice(0, 320)}`)
        .join('\n\n')
      const block = [header, takeawayBlock, qa].filter(Boolean).join('\n')
      if (used + block.length > tierBudget) {
        const trimmed = block.slice(0, tierBudget - used - 1) + '…'
        chunks.push(trimmed)
        used += trimmed.length
        break
      }
      chunks.push(block)
      used += block.length + 2
    }
    parts.push(chunks.join('\n\n'))
    budget -= used
  }

  // Tier 3 — PDF source excerpts (when summaries exist, shorter excerpts)
  if (ctx.pdfs.length > 0 && budget > 200) {
    const tierBudget = takeBudget(budget, 0.55, 200)
    const chunks: string[] = ['=== PDF EXCERPTS (for grounding) ===']
    let used = chunks[0].length
    for (const pdf of ctx.pdfs) {
      const excerptLen = pdf.summary ? 900 : 2200
      const block = `[${pdf.name}]\n${pdf.text.slice(0, excerptLen)}`
      if (used + block.length > tierBudget) break
      chunks.push(block)
      used += block.length + 2
    }
    if (chunks.length > 1) {
      parts.push(chunks.join('\n\n'))
      budget -= used
    }
  }

  // Tier 4 — Image references
  if (ctx.images.length > 0 && budget > 80) {
    const tierBudget = Math.min(budget, 500)
    const chunks: string[] = ['=== REFERENCE IMAGES ===']
    let used = chunks[0].length
    for (const img of ctx.images) {
      const block = `[${img.name}]: ${img.description || 'Visual reference attached to this document'}`
      if (used + block.length > tierBudget) break
      chunks.push(block)
      used += block.length + 2
    }
    parts.push(chunks.join('\n\n'))
  }

  return parts.join('\n\n')
}

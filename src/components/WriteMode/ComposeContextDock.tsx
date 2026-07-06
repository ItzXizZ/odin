import { useMemo, type ReactNode } from 'react'
import type { CSSProperties } from 'react'
import { FileText, Image as ImageIcon, GitBranch } from 'lucide-react'
import { useStore } from '../../store/useStore'
import type { Adventure } from '../../store/useStore'

function deckRotations(n: number): number[] {
  const count = Math.min(n, 5)
  if (count === 0) return []
  if (count === 1) return [0]
  const spread = Math.min(9, count * 2.5)
  return Array.from({ length: count }, (_, i) =>
    count === 1 ? 0 : -spread + (i * (spread * 2)) / (count - 1)
  )
}

function AdvThumb({ adv }: { adv: Adventure }) {
  if (adv.thumbnail) {
    return <img src={adv.thumbnail} alt="" className="compose-ctx-ghost-thumb" />
  }
  const nodes = adv.nodes.filter((n) => n.data.response || n.data.prompt)
  if (nodes.length === 0) return <GitBranch size={14} />
  return (
    <svg viewBox="0 0 60 40" width="100%" height="100%" className="compose-ctx-ghost-thumb">
      <rect width="60" height="40" fill="rgb(215,215,215)" rx="3" />
      {nodes.slice(0, 3).map((n, i) => (
        <rect key={n.id} x={6 + i * 16} y={8 + i * 4} width={14} height={10} rx="2" fill="rgba(255,255,255,0.85)" />
      ))}
    </svg>
  )
}

interface ContextSlotProps {
  label: string
  count: number
  emptyLabel: string
  children?: ReactNode
}

function ContextSlot({ label, count, emptyLabel, children }: ContextSlotProps) {
  const hasItems = count > 0
  return (
    <div className="compose-ctx-slot">
      {hasItems && children}
      <div className={`compose-ctx-face${hasItems ? '' : ' is-empty'}`}>
        <span className="compose-ctx-label">{label}</span>
        {hasItems ? (
          <span className="compose-ctx-count">{count}</span>
        ) : (
          <span className="compose-ctx-empty">{emptyLabel}</span>
        )}
      </div>
    </div>
  )
}

interface ComposeContextDockProps {
  onOpenContextHouse: () => void
}

export default function ComposeContextDock({ onOpenContextHouse }: ComposeContextDockProps) {
  const ctx = useStore((s) => s.getActiveDocumentContext())
  const adventures = useStore((s) => s.adventures)

  const linkedAdventures = useMemo(
    () =>
      ctx.linkedAdventureIds
        .map((id) => adventures.find((a) => a.id === id))
        .filter((a): a is Adventure => a != null),
    [ctx.linkedAdventureIds, adventures]
  )

  const pdfCount = ctx.pdfs.length
  const imgCount = ctx.images.length
  const advCount = linkedAdventures.length
  const hasAny = pdfCount > 0 || imgCount > 0 || advCount > 0

  return (
    <div className="compose-context-dock" data-tour="context-dock">
      <div className="compose-ctx-stack">
        <ContextSlot label="Sources" count={pdfCount} emptyLabel="No sources">
          <div className="compose-ctx-ghost-deck">
            {ctx.pdfs.slice(0, 5).map((pdf, i) => {
              const rots = deckRotations(Math.min(pdfCount, 5))
              return (
                <div
                  key={pdf.id}
                  className="compose-ctx-ghost-card"
                  style={{ '--rot': `${rots[i]}deg`, zIndex: i } as CSSProperties}
                >
                  {pdf.thumbnail ? (
                    <img src={pdf.thumbnail} alt="" className="compose-ctx-ghost-thumb" />
                  ) : (
                    <FileText size={14} />
                  )}
                </div>
              )
            })}
          </div>
        </ContextSlot>

        <ContextSlot label="Images" count={imgCount} emptyLabel="No images">
          <div className="compose-ctx-ghost-deck">
            {ctx.images.slice(0, 5).map((img, i) => {
              const rots = deckRotations(Math.min(imgCount, 5))
              return (
                <div
                  key={img.id}
                  className="compose-ctx-ghost-card compose-ctx-ghost-image"
                  style={{ '--rot': `${rots[i]}deg`, zIndex: i } as CSSProperties}
                >
                  {img.dataUrl ? (
                    <img src={img.dataUrl} alt="" className="compose-ctx-ghost-thumb" />
                  ) : (
                    <ImageIcon size={14} />
                  )}
                </div>
              )
            })}
          </div>
        </ContextSlot>

        <ContextSlot label="Adventures" count={advCount} emptyLabel="No adventures">
          <div className="compose-ctx-ghost-deck">
            {linkedAdventures.slice(0, 5).map((adv, i) => {
              const rots = deckRotations(Math.min(advCount, 5))
              return (
                <div
                  key={adv.id}
                  className="compose-ctx-ghost-card compose-ctx-ghost-adv"
                  style={{ '--rot': `${rots[i]}deg`, zIndex: i } as CSSProperties}
                >
                  <AdvThumb adv={adv} />
                </div>
              )
            })}
          </div>
        </ContextSlot>
      </div>

      <button type="button" className="compose-ctx-edit-btn" onClick={onOpenContextHouse}>
        {hasAny ? 'Edit context' : 'Add context'}
      </button>
    </div>
  )
}

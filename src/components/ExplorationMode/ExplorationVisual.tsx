import { memo } from 'react'
import type { VisualAsset } from '../../store/useStore'
import Markdown from '../Markdown'

interface ExplorationVisualProps {
  visual: VisualAsset
  caption?: string
}

const PROVIDER_LABELS: Record<string, string> = {
  pubchem: 'PubChem · accurate chemistry',
  openai: 'GPT Image',
  google: 'Gemini Imagen',
  replicate: 'Flux Pro',
  web: 'Web reference',
}

function modeLabel(visual: VisualAsset): string | null {
  if (visual.provider && PROVIDER_LABELS[visual.provider]) {
    return PROVIDER_LABELS[visual.provider]
  }
  if (visual.mode === 'chemical_structure') return 'PubChem · accurate chemistry'
  if (visual.mode === 'reference_photo') return 'Reference photograph'
  if (visual.mode === 'generated') return 'AI-generated'
  return null
}

function ExplorationVisual({ visual, caption }: ExplorationVisualProps) {
  const text = caption || visual.caption
  const badge = modeLabel(visual)

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-lg border border-black/8 bg-white/40">
        <img
          src={visual.imageDataUrl}
          alt={visual.caption || 'Generated visual'}
          className="block h-auto w-full object-contain"
          draggable={false}
        />
      </div>

      {badge && (
        <p className="text-[10px] font-medium uppercase tracking-wide text-black/40">{badge}</p>
      )}

      {visual.referenceUrl && visual.mode !== 'chemical_structure' && (
        <p className="text-[10px] text-black/40">
          Source:{' '}
          <a
            href={visual.referenceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-black/60"
          >
            {visual.referenceTitle || 'reference'}
          </a>
        </p>
      )}

      {visual.mode === 'chemical_structure' && visual.referenceUrl && (
        <p className="text-[10px] text-black/40">
          Structure data from{' '}
          <a
            href={visual.referenceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-black/60"
          >
            PubChem
          </a>
        </p>
      )}

      {text && (
        <Markdown size="text-xs" className="text-black/80">
          {text}
        </Markdown>
      )}
    </div>
  )
}

export default memo(ExplorationVisual)

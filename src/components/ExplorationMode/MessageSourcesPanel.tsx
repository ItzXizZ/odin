import { useState } from 'react'
import { ChevronDown, ExternalLink, Loader2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import type { SourceRef } from '../../lib/sources'

interface MessageSourcesPanelProps {
  sources: SourceRef[]
  label?: string
  isLoading?: boolean
}

export default function MessageSourcesPanel({
  sources,
  label = 'sources',
  isLoading = false,
}: MessageSourcesPanelProps) {
  const [open, setOpen] = useState(false)
  const hasSources = sources.length > 0
  const canExpand = hasSources

  return (
    <div className="mt-1.5 nodrag">
      <button
        type="button"
        disabled={!canExpand}
        onClick={(e) => {
          e.stopPropagation()
          if (canExpand) setOpen((v) => !v)
        }}
        className={`flex w-full items-center gap-1.5 rounded-md border border-black/8 bg-black/[0.03] px-2 py-1 text-left transition ${
          canExpand ? 'hover:bg-black/[0.06] cursor-pointer' : 'cursor-default'
        }`}
        aria-expanded={canExpand ? open : undefined}
        aria-label={
          isLoading && !hasSources
            ? `Researching ${label}`
            : hasSources
              ? `${sources.length} ${label}`
              : `No ${label}`
        }
      >
        {isLoading && !hasSources ? (
          <Loader2 size={10} className="flex-shrink-0 animate-spin text-black/35" />
        ) : (
          <ChevronDown
            size={10}
            className={`flex-shrink-0 text-black/35 transition-transform ${open && canExpand ? 'rotate-180' : ''} ${
              !canExpand ? 'opacity-40' : ''
            }`}
          />
        )}
        <span className="text-[10px] text-black/45">
          {isLoading && !hasSources
            ? 'Researching sources…'
            : hasSources
              ? `${sources.length} source${sources.length === 1 ? '' : 's'}`
              : 'No sources yet'}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="mt-1 space-y-1 rounded-md border border-black/8 bg-black/[0.02] p-1.5">
              {sources.map((source) => (
                <a
                  key={source.id}
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-start gap-1.5 rounded px-1.5 py-1 hover:bg-black/[0.04]"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="flex-1 text-[10px] text-black/55 leading-snug group-hover:text-black/75 truncate">
                    {source.title}
                  </span>
                  <ExternalLink size={9} className="flex-shrink-0 mt-0.5 text-black/25 group-hover:text-black/45" />
                </a>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

import { ExternalLink } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import type { AggregatedSource } from '../../lib/sources'

interface LiveSourceFeedProps {
  sources: AggregatedSource[]
}

export default function LiveSourceFeed({ sources }: LiveSourceFeedProps) {
  if (sources.length === 0) {
    return (
      <p className="text-xs text-white/20 text-center mt-6 label leading-relaxed">
        Sources appear here as messages are researched and cited…
      </p>
    )
  }

  return (
    <div className="space-y-1.5">
      <AnimatePresence initial={false}>
        {sources.map((source) => (
          <motion.div
            key={source.id}
            layout
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="rounded-lg border border-white/8 bg-white/3 px-2.5 py-2"
          >
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-start gap-2 min-w-0"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="flex-1 text-xs text-white/60 leading-snug group-hover:text-white/80 transition-colors truncate">
                {source.title}
              </span>
              <ExternalLink
                size={10}
                className="flex-shrink-0 mt-0.5 text-white/25 group-hover:text-white/50 transition-colors"
              />
            </a>
            {source.referenceCount > 1 && (
              <p className="mt-1 text-[10px] text-white/25 tabular-nums">
                cited {source.referenceCount}×
              </p>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

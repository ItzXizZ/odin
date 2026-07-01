import { ExternalLink } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import type { AggregatedSource } from '../../lib/sources'

interface LiveSourceFeedProps {
  sources: AggregatedSource[]
}

export default function LiveSourceFeed({ sources }: LiveSourceFeedProps) {
  const count = sources.length

  return (
    <div className="exp-sources-panel nodrag">
      <div className="exp-sources-header">
        <span className="exp-sources-title">Source Intelligence</span>
        <span className="exp-sources-meta">
          {count > 0 ? `${count} · relevance` : 'by relevance'}
        </span>
      </div>

      <div className="exp-sources-body">
        {count === 0 ? (
          <p className="exp-sources-empty">
            Sources surface here as research is verified and cited…
          </p>
        ) : (
          <div className="exp-sources-list">
            <AnimatePresence initial={false}>
              {sources.map((source) => (
                <motion.div
                  key={source.id}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="exp-source-card"
                >
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="exp-source-link group"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="exp-source-title">{source.title}</span>
                    <ExternalLink size={10} className="exp-source-icon" />
                  </a>
                  {source.referenceCount > 1 && (
                    <p className="exp-source-cited">cited {source.referenceCount}×</p>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  )
}

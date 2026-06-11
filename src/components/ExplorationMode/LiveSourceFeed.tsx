import { useState } from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import type { AggregatedSource } from '../../lib/sources'

interface LiveSourceFeedProps {
  sources: AggregatedSource[]
  defaultOpen?: boolean
}

export default function LiveSourceFeed({ sources, defaultOpen = true }: LiveSourceFeedProps) {
  const [open, setOpen] = useState(defaultOpen)
  const count = sources.length

  return (
    <div className="exp-sources-panel nodrag">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="exp-sources-header"
        aria-expanded={open}
      >
        <ChevronDown
          size={14}
          className={`exp-sources-chevron flex-shrink-0 ${open ? 'open' : ''}`}
        />
        <span className="exp-sources-title">Live Source Update</span>
        <span className="exp-sources-meta">
          {count > 0 ? `${count} · relevance` : 'by relevance'}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="sources-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
            className="overflow-hidden"
          >
            <div className="exp-sources-body">
              {count === 0 ? (
                <p className="exp-sources-empty">
                  Sources appear here as messages are researched and cited…
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

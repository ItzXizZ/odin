import { useState } from 'react'
import { FileText, Plus, Trash2, X } from 'lucide-react'
import { useStore, type WritingDocument } from '../../store/useStore'

function docPreview(doc: WritingDocument): string {
  const tab = doc.tabs.find((t) => t.id === doc.activeTabId) ?? doc.tabs[0]
  const text = (tab?.content ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return text.slice(0, 140) || 'Empty document'
}

function wordCount(doc: WritingDocument): number {
  const tab = doc.tabs.find((t) => t.id === doc.activeTabId) ?? doc.tabs[0]
  const text = (tab?.content ?? '').replace(/<[^>]+>/g, ' ')
  return text.split(/\s+/).filter(Boolean).length
}

export default function DocumentsMode({ onClose }: { onClose?: () => void }) {
  const {
    documents,
    activeDocumentId,
    createDocument,
    deleteDocument,
    setActiveDocumentId,
    setDocumentTitle,
  } = useStore()

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const openDocument = (id: string) => {
    setActiveDocumentId(id)
    onClose?.()
  }

  const handleNew = () => {
    createDocument()
    onClose?.()
  }

  const startRename = (doc: WritingDocument) => {
    setRenamingId(doc.id)
    setRenameValue(doc.title || 'Untitled')
  }

  const commitRename = () => {
    if (!renamingId) return
    if (renamingId === activeDocumentId) {
      setDocumentTitle(renameValue.trim() || 'Untitled')
    } else {
      const doc = documents.find((d) => d.id === renamingId)
      if (doc) {
        useStore.setState({
          documents: documents.map((d) =>
            d.id === renamingId
              ? { ...d, title: renameValue.trim() || 'Untitled', updatedAt: Date.now() }
              : d
          ),
        })
      }
    }
    setRenamingId(null)
  }

  const sorted = [...documents].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-shrink-0 px-6 pt-6 pb-4">
        <div className="mx-auto max-w-5xl flex items-end justify-between gap-4">
          <div>
            <h1 className="font-caveat text-3xl font-bold text-white">Documents</h1>
            <p className="mt-1 text-sm text-white/40">All your writing projects in one place</p>
          </div>
          <div className="flex items-center gap-2">
          <button type="button" onClick={handleNew} className="doc-library-new-btn">
            <Plus size={14} />
            New document
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-white/50 transition hover:bg-white/10 hover:text-white/80"
              title="Close (Esc)"
            >
              <X size={16} />
            </button>
          )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-8">
        <div className="mx-auto max-w-5xl">
          {sorted.length === 0 ? (
            <div className="doc-library-empty">
              <FileText size={28} className="text-black/25" />
              <p>No documents yet</p>
              <button type="button" onClick={handleNew} className="doc-library-new-btn">
                <Plus size={14} />
                Create your first document
              </button>
            </div>
          ) : (
            <div className="doc-library-grid">
              {sorted.map((doc) => {
                const isActive = doc.id === activeDocumentId
                const isRenaming = renamingId === doc.id

                return (
                  <article
                    key={doc.id}
                    className={`doc-library-card ${isActive ? 'active' : ''}`}
                  >
                    <div className="doc-library-card-head-wrap">
                      <div className="doc-library-card-head">
                        {isRenaming ? (
                          <input
                            autoFocus
                            className="doc-library-rename"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename()
                              if (e.key === 'Escape') setRenamingId(null)
                            }}
                          />
                        ) : (
                          <h2
                            className="doc-library-card-title"
                            onDoubleClick={() => startRename(doc)}
                          >
                            {doc.title || 'Untitled'}
                          </h2>
                        )}
                        <div className="doc-library-card-head-right">
                          <span className="doc-library-card-meta">
                            {new Date(doc.updatedAt).toLocaleDateString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}
                          </span>
                          {documents.length > 1 && (
                            <button
                              type="button"
                              className="doc-library-delete"
                              title="Delete document"
                              onClick={() => deleteDocument(doc.id)}
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="doc-library-card-open"
                      onClick={() => openDocument(doc.id)}
                    >
                      <p className="doc-library-card-preview">{docPreview(doc)}</p>
                      <div className="doc-library-card-foot">
                        <span>{wordCount(doc)} words</span>
                        <span>{doc.tabs.length} tab{doc.tabs.length === 1 ? '' : 's'}</span>
                      </div>
                    </button>
                  </article>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

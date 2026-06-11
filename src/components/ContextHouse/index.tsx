import { useRef, useState } from 'react'
import {
  FileText,
  Image as ImageIcon,
  Plus,
  X,
  Loader2,
  PenTool,
  GitBranch,
  ChevronDown,
  Link2,
} from 'lucide-react'
import { nanoid } from 'nanoid'
import { useStore } from '../../store/useStore'
import { uploadPDF, syncChat } from '../../lib/claude'
import { compressImageToDataUrl } from '../../lib/image'

export default function ContextHouse() {
  const {
    documents,
    activeDocumentId,
    setActiveDocumentId,
    adventures,
    apiKey,
    addPDF,
    removePDF,
    updatePDFSummary,
    addImage,
    removeImage,
    linkAdventure,
    unlinkAdventure,
    getActiveDocumentContext,
    setActiveTab,
  } = useStore()

  const activeDoc = documents.find((d) => d.id === activeDocumentId) ?? documents[0]
  const ctx = getActiveDocumentContext()
  const { pdfs, images, linkedAdventureIds } = ctx

  const pdfInputRef = useRef<HTMLInputElement>(null)
  const imgInputRef = useRef<HTMLInputElement>(null)
  const [uploadingPdf, setUploadingPdf] = useState(false)
  const [uploadingImg, setUploadingImg] = useState(false)
  const [expandedPdf, setExpandedPdf] = useState<string | null>(null)
  const [lightboxImage, setLightboxImage] = useState<string | null>(null)
  const [showDocPicker, setShowDocPicker] = useState(false)
  const [showAdventurePicker, setShowAdventurePicker] = useState(false)

  const linkedAdventures = linkedAdventureIds
    .map((id) => adventures.find((a) => a.id === id))
    .filter((a) => a != null)

  const totalItems = pdfs.length + images.length + linkedAdventureIds.length

  const handlePDFUpload = async (files: FileList | null) => {
    if (!files) return
    setUploadingPdf(true)
    for (const file of Array.from(files)) {
      try {
        const { text, pages } = await uploadPDF(file)
        const id = nanoid()
        const pdf = { id, name: file.name, text, pages, uploadedAt: Date.now() }
        addPDF(pdf)

        if (apiKey && text.length > 100) {
          const summary = await syncChat(
            [{ role: 'user', content: `Summarize this document in 2-3 sentences for writing context:\n\n${text.slice(0, 4000)}` }],
            'You are a research assistant. Provide concise, useful summaries.',
            apiKey,
            256
          ).catch(() => '')
          if (summary) updatePDFSummary(id, summary)
        }
      } catch (err) {
        console.error('PDF upload failed:', err)
      }
    }
    setUploadingPdf(false)
  }

  const handleImageUpload = async (files: FileList | null) => {
    if (!files) return
    setUploadingImg(true)
    for (const file of Array.from(files)) {
      try {
        const dataUrl = await compressImageToDataUrl(file)
        addImage({ id: nanoid(), name: file.name, dataUrl, uploadedAt: Date.now() })
      } catch (err) {
        console.error('Image upload failed:', err)
      }
    }
    setUploadingImg(false)
  }

  const handleDrop = (e: React.DragEvent, type: 'pdf' | 'image') => {
    e.preventDefault()
    const files = e.dataTransfer.files
    if (type === 'pdf') handlePDFUpload(files)
    else handleImageUpload(files)
  }

  const availableAdventures = adventures.filter(
    (a) => !linkedAdventureIds.includes(a.id)
  )

  return (
    <div className="h-full flex flex-col context-house">
      <div className="flex-shrink-0 px-6 pt-6 pb-4">
        <div className="mx-auto max-w-6xl flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="context-house-header-title">Context House</h1>
            <p className="context-house-header-sub">
              Research materials scoped to each document — PDFs, images, and exploration threads
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowDocPicker((v) => !v)}
                className="context-doc-picker-btn"
              >
                <FileText size={14} />
                <span className="truncate max-w-[10rem]">{activeDoc?.title ?? 'Select document'}</span>
                <ChevronDown size={14} className="opacity-50" />
              </button>
              {showDocPicker && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowDocPicker(false)} />
                  <div className="context-picker-menu z-50">
                    <p className="context-picker-label">Context for document</p>
                    {documents.map((doc) => {
                      const count =
                        (doc.context?.pdfs?.length ?? 0) +
                        (doc.context?.images?.length ?? 0) +
                        (doc.context?.linkedAdventureIds?.length ?? 0)
                      return (
                        <button
                          key={doc.id}
                          type="button"
                          onClick={() => {
                            setActiveDocumentId(doc.id)
                            setShowDocPicker(false)
                          }}
                          className={`context-picker-item${doc.id === activeDocumentId ? ' active' : ''}`}
                        >
                          <span className="truncate">{doc.title || 'Untitled'}</span>
                          {count > 0 && <span className="context-picker-badge">{count}</span>}
                        </button>
                      )
                    })}
                  </div>
                </>
              )}
            </div>
            <button type="button" onClick={() => setActiveTab('write')} className="btn-primary flex items-center gap-2">
              <PenTool size={14} />
              Write
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        <div className="mx-auto max-w-6xl space-y-4">
          {/* PDFs */}
          <section
            className="context-section card p-4"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleDrop(e, 'pdf')}
          >
            <div className="context-section-head">
              <div className="flex items-center gap-2">
                <FileText size={16} className="context-section-icon pdf" />
                <span className="section-title">PDFs</span>
              </div>
              <span className="context-section-count">{pdfs.length}</span>
            </div>

            <div className="context-pdf-grid">
              {pdfs.map((pdf) => (
                <div key={pdf.id} className="context-pdf-card group">
                  <button
                    type="button"
                    onClick={() => setExpandedPdf(expandedPdf === pdf.id ? null : pdf.id)}
                    className="context-pdf-thumb"
                  >
                    <FileText size={28} className="context-section-icon pdf" />
                    <span className="context-pdf-name">{pdf.name}</span>
                    <span className="context-pdf-meta">{pdf.pages} pages</span>
                    {pdf.summary && <span className="context-pdf-summary">{pdf.summary}</span>}
                  </button>
                  <button
                    type="button"
                    onClick={() => removePDF(pdf.id)}
                    className="context-remove-btn"
                    aria-label="Remove PDF"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => pdfInputRef.current?.click()}
                className="context-upload-slot"
                disabled={uploadingPdf}
              >
                {uploadingPdf ? (
                  <Loader2 size={22} className="animate-spin" />
                ) : (
                  <>
                    <Plus size={22} />
                    <span>Add PDF</span>
                  </>
                )}
              </button>
            </div>
            <input
              ref={pdfInputRef}
              type="file"
              accept=".pdf"
              multiple
              className="hidden"
              onChange={(e) => handlePDFUpload(e.target.files)}
            />
          </section>

          {/* Images */}
          <section
            className="context-section card p-4"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleDrop(e, 'image')}
          >
            <div className="context-section-head">
              <div className="flex items-center gap-2">
                <ImageIcon size={16} className="context-section-icon image" />
                <span className="section-title">Images</span>
              </div>
              <span className="context-section-count">{images.length}</span>
            </div>

            <div className="context-image-grid">
              {images.map((img) => (
                <div key={img.id} className="context-image-card group">
                  <button
                    type="button"
                    onClick={() => setLightboxImage(img.dataUrl || null)}
                    className="context-image-thumb"
                  >
                    {img.dataUrl ? (
                      <img src={img.dataUrl} alt={img.name} className="context-image-preview" />
                    ) : (
                      <div className="context-image-placeholder">
                        <ImageIcon size={24} />
                        <span>Preview unavailable</span>
                      </div>
                    )}
                    <span className="context-image-name">{img.name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeImage(img.id)}
                    className="context-remove-btn"
                    aria-label="Remove image"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => imgInputRef.current?.click()}
                className="context-upload-slot context-upload-slot-image"
                disabled={uploadingImg}
              >
                {uploadingImg ? (
                  <Loader2 size={22} className="animate-spin" />
                ) : (
                  <>
                    <ImageIcon size={22} />
                    <span>Add Image</span>
                  </>
                )}
              </button>
            </div>
            <input
              ref={imgInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => handleImageUpload(e.target.files)}
            />
          </section>

          {/* Adventures */}
          <section className="context-section card p-4">
            <div className="context-section-head">
              <div className="flex items-center gap-2">
                <GitBranch size={16} className="context-section-icon adv" />
                <span className="section-title">Exploration Adventures</span>
              </div>
              <div className="context-section-actions">
                {availableAdventures.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAdventurePicker((v) => !v)}
                    className="context-link-btn"
                  >
                    <Link2 size={12} />
                    Link Adventure
                  </button>
                )}
                <span className="context-section-count">{linkedAdventureIds.length}</span>
              </div>
            </div>

            {showAdventurePicker && availableAdventures.length > 0 && (
              <div className="context-inline-picker mb-3">
                {availableAdventures.map((adv) => {
                  const nodeCount = adv.nodes.filter((n) => n.data.response).length
                  return (
                    <button
                      key={adv.id}
                      type="button"
                      onClick={() => {
                        linkAdventure(adv.id)
                        setShowAdventurePicker(false)
                      }}
                      className="context-inline-picker-item"
                    >
                      <span className="font-medium">{adv.name}</span>
                      <span className="context-inline-picker-meta">
                        {nodeCount} nodes · {adv.takeaways.length} takeaways
                      </span>
                    </button>
                  )
                })}
              </div>
            )}

            <div className="context-adv-grid">
              {linkedAdventures.map((adv) => {
                const nodeCount = adv.nodes.filter((n) => n.data.response).length
                const previewNode = adv.nodes.find((n) => n.data.response)
                return (
                  <div key={adv.id} className="context-adv-card group">
                    <div className="context-adv-content">
                      <GitBranch size={16} className="context-section-icon adv" />
                      <p className="context-adv-name">{adv.name}</p>
                      <p className="context-adv-meta">
                        {nodeCount} research nodes · {adv.takeaways.length} takeaways
                      </p>
                      {previewNode && (
                        <p className="context-adv-preview">
                          {previewNode.data.prompt.slice(0, 100)}…
                        </p>
                      )}
                      {adv.takeaways.length > 0 && (
                        <ul className="context-adv-takeaways">
                          {adv.takeaways.slice(0, 2).map((t) => (
                            <li key={t.id}>• {t.text.slice(0, 60)}{t.text.length > 60 ? '…' : ''}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => unlinkAdventure(adv.id)}
                      className="context-remove-btn"
                      aria-label="Unlink adventure"
                    >
                      <X size={12} />
                    </button>
                  </div>
                )
              })}
              {linkedAdventures.length === 0 && (
                <p className="context-empty-hint col-span-full">
                  Link exploration threads from Exploration mode to include research in this document&apos;s context
                </p>
              )}
            </div>
          </section>

          {/* Expanded PDF panel */}
          {expandedPdf && (() => {
            const pdf = pdfs.find((p) => p.id === expandedPdf)
            if (!pdf) return null
            return (
              <div className="card context-expanded-pdf animate-slide-up">
                <div className="context-expanded-pdf-head">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileText size={16} className="context-section-icon pdf flex-shrink-0" />
                    <span className="context-expanded-pdf-title">{pdf.name}</span>
                    <span className="context-expanded-pdf-meta">{pdf.pages} pages</span>
                  </div>
                  <button type="button" onClick={() => setExpandedPdf(null)} className="context-close-btn">
                    <X size={16} />
                  </button>
                </div>
                {pdf.summary && (
                  <div className="context-expanded-pdf-summary">
                    <p>{pdf.summary}</p>
                  </div>
                )}
                <div className="context-expanded-pdf-body">
                  <pre>
                    {pdf.text.slice(0, 4000)}
                    {pdf.text.length > 4000 && '…[truncated]'}
                  </pre>
                </div>
              </div>
            )
          })()}

          {totalItems > 0 && (
            <div className="context-summary-bar">
              <p>
                <strong>Active context for {activeDoc?.title}:</strong>{' '}
                {pdfs.length > 0 && `${pdfs.length} PDF${pdfs.length > 1 ? 's' : ''}`}
                {pdfs.length > 0 && (images.length > 0 || linkedAdventureIds.length > 0) && ' · '}
                {images.length > 0 && `${images.length} image${images.length > 1 ? 's' : ''}`}
                {images.length > 0 && linkedAdventureIds.length > 0 && ' · '}
                {linkedAdventureIds.length > 0 && `${linkedAdventureIds.length} adventure${linkedAdventureIds.length > 1 ? 's' : ''}`}
                . Claude uses only this document&apos;s context in Write mode.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Image lightbox */}
      {lightboxImage && (
        <div
          className="context-lightbox"
          onClick={() => setLightboxImage(null)}
          role="dialog"
          aria-modal="true"
        >
          <button type="button" className="context-lightbox-close" onClick={() => setLightboxImage(null)}>
            <X size={20} />
          </button>
          <img src={lightboxImage} alt="Reference image preview" className="context-lightbox-img" />
        </div>
      )}
    </div>
  )
}

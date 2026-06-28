import { useRef, useState, useMemo, useEffect } from 'react'
import type { CSSProperties } from 'react'
import {
  FileText,
  Image as ImageIcon,
  Plus,
  X,
  Loader2,
  PenTool,
  GitBranch,
  ChevronDown,
  Layers,
  ArrowRight,
} from 'lucide-react'
import { useTutorial } from '../../lib/tutorial'
import { nanoid } from 'nanoid'
import { useStore, useHasApiKey } from '../../store/useStore'
import type { Adventure } from '../../store/useStore'
import { uploadPDF, syncChat } from '../../lib/claude'
import { compressImageToDataUrl } from '../../lib/image'
import { renderPDFThumbnail } from '../../lib/pdfThumbnail'
import { uploadAsset } from '../../lib/cloud'

type OpenSection = 'pdf' | 'image' | 'adventure' | null

/** Returns rotations (degrees) for a deck of N cards (max 5). */
function deckRotations(n: number): number[] {
  const count = Math.min(n, 5)
  if (count === 0) return []
  if (count === 1) return [0]
  const spread = Math.min(9, count * 2.5)
  return Array.from({ length: count }, (_, i) =>
    count === 1 ? 0 : -spread + (i * (spread * 2)) / (count - 1)
  )
}

/* ── Faithful whiteboard replica — looks like an actual board screenshot ── */
function AdventurePreview({ adv }: { adv: Adventure }) {
  // If a real captured image exists, show it directly
  if (adv.thumbnail) {
    return (
      <img
        src={adv.thumbnail}
        alt=""
        className="ctx-ghost-page-thumb"
        style={{ borderRadius: 'inherit' }}
      />
    )
  }

  const nodes = adv.nodes.filter((n) => n.data.response || n.data.prompt)
  const edges = adv.edges

  if (nodes.length === 0) {
    return (
      <div className="ctx-ghost-adv-empty">
        <GitBranch size={18} />
      </div>
    )
  }

  // SVG canvas size
  const W = 180
  const H = 120
  const PAD = 12

  // Actual node card dimensions in the real board (approximate)
  const REAL_CARD_W = 260
  const REAL_CARD_H = 120

  // Bounding box accounting for card extents
  const xs = nodes.map((n) => n.position.x)
  const ys = nodes.map((n) => n.position.y)
  const bMinX = Math.min(...xs) - 10
  const bMaxX = Math.max(...xs) + REAL_CARD_W + 10
  const bMinY = Math.min(...ys) - 10
  const bMaxY = Math.max(...ys) + REAL_CARD_H + 10

  const rangeX = Math.max(bMaxX - bMinX, REAL_CARD_W * 1.5)
  const rangeY = Math.max(bMaxY - bMinY, REAL_CARD_H * 1.5)

  const scaleX = (W - PAD * 2) / rangeX
  const scaleY = (H - PAD * 2) / rangeY
  const scale = Math.min(scaleX, scaleY, 0.35) // cap scale

  const cardW = REAL_CARD_W * scale
  const cardH = REAL_CARD_H * scale
  const fontSize = Math.max(3.5, Math.min(5.5, cardH * 0.28))

  const toX = (x: number) => PAD + (x - bMinX) * scale
  const toY = (y: number) => PAD + (y - bMinY) * scale

  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const uid = adv.id.slice(0, 8)

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height="100%"
      style={{ display: 'block', borderRadius: 'inherit' }}
    >
      <defs>
        {/* Dot grid — same as the app background */}
        <pattern id={`grid-${uid}`} width="10" height="10" patternUnits="userSpaceOnUse">
          <circle cx="5" cy="5" r="0.65" fill="rgba(0,0,0,0.18)" />
        </pattern>
        {/* Subtle card drop-shadow filter */}
        <filter id={`shadow-${uid}`} x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodOpacity="0.12" />
        </filter>
      </defs>

      {/* Background — same colour as the app */}
      <rect width={W} height={H} fill="rgb(215,215,215)" />
      <rect width={W} height={H} fill={`url(#grid-${uid})`} />

      {/* Edges — bezier curves like the app */}
      {edges.map((e) => {
        const src = nodeById.get(e.source)
        const tgt = nodeById.get(e.target)
        if (!src || !tgt) return null
        const x1 = toX(src.position.x) + cardW / 2
        const y1 = toY(src.position.y) + cardH
        const x2 = toX(tgt.position.x) + cardW / 2
        const y2 = toY(tgt.position.y)
        const cy = (y1 + y2) / 2
        return (
          <path
            key={e.id}
            d={`M ${x1} ${y1} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${y2}`}
            stroke="rgba(0,0,0,0.22)"
            strokeWidth="0.9"
            fill="none"
          />
        )
      })}

      {/* Node cards */}
      {nodes.map((n) => {
        const cx = toX(n.position.x)
        const cy = toY(n.position.y)
        const label = (n.data.prompt || '').slice(0, 32) + ((n.data.prompt?.length ?? 0) > 32 ? '…' : '')
        const hasResponse = !!n.data.response

        return (
          <g key={n.id} filter={`url(#shadow-${uid})`}>
            {/* Glass card background */}
            <rect
              x={cx}
              y={cy}
              width={cardW}
              height={cardH}
              rx={cardW * 0.07}
              fill={hasResponse ? 'rgba(255,255,255,0.86)' : 'rgba(255,255,255,0.55)'}
              stroke="rgba(255,255,255,0.7)"
              strokeWidth="0.5"
            />
            {/* Top colour bar matching app node style */}
            <rect
              x={cx}
              y={cy}
              width={cardW}
              height={cardH * 0.22}
              rx={cardW * 0.07}
              fill={hasResponse ? 'rgba(100,150,255,0.1)' : 'rgba(200,200,200,0.4)'}
            />
            {/* Prompt text */}
            <text
              x={cx + cardW * 0.08}
              y={cy + cardH * 0.42}
              fontSize={fontSize}
              fill="rgba(30,30,30,0.82)"
              fontFamily="Inter, sans-serif"
              fontWeight="500"
            >
              {label}
            </text>
            {/* Response indicator bar */}
            {hasResponse && (
              <rect
                x={cx + cardW * 0.08}
                y={cy + cardH * 0.58}
                width={cardW * 0.75}
                height={fontSize * 0.55}
                rx="1"
                fill="rgba(60,60,60,0.12)"
              />
            )}
            {hasResponse && (
              <rect
                x={cx + cardW * 0.08}
                y={cy + cardH * 0.72}
                width={cardW * 0.5}
                height={fontSize * 0.55}
                rx="1"
                fill="rgba(60,60,60,0.08)"
              />
            )}
          </g>
        )
      })}
    </svg>
  )
}

/* Memoised so the SVG only re-renders when the adventure changes */
const AdventurePreviewMemo = ({ adv }: { adv: Adventure }) => {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => <AdventurePreview adv={adv} />, [adv.nodes, adv.edges, adv.thumbnail])
}

export default function ContextHouse({ onClose }: { onClose?: () => void }) {
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
  } = useStore()
  const hasApiKey = useHasApiKey()

  const activeDoc = documents.find((d) => d.id === activeDocumentId) ?? documents[0]
  const ctx = getActiveDocumentContext()
  const { pdfs, images, linkedAdventureIds } = ctx

  const pdfInputRef = useRef<HTMLInputElement>(null)
  const imgInputRef = useRef<HTMLInputElement>(null)
  const [uploadingPdf, setUploadingPdf] = useState(false)
  const [uploadingImg, setUploadingImg] = useState(false)
  const [expandedSection, setExpandedSection] = useState<OpenSection>(null)
  const [expandedPdf, setExpandedPdf] = useState<string | null>(null)
  const [lightboxImage, setLightboxImage] = useState<string | null>(null)
  const [showDocPicker, setShowDocPicker] = useState(false)

  const linkedAdventures = linkedAdventureIds
    .map((id) => adventures.find((a) => a.id === id))
    .filter((a) => a != null)

  const availableAdventures = adventures.filter((a) => !linkedAdventureIds.includes(a.id))

  const { active: tourActive, step: tourStep, next: tourNext } = useTutorial()
  const onboarding = tourActive && tourStep?.id === 'write-context'

  // During onboarding, open the Adventures slot so the user can link theirs.
  useEffect(() => {
    if (onboarding) setExpandedSection('adventure')
  }, [onboarding])

  const toggleSection = (s: Exclude<OpenSection, null>) => {
    setExpandedSection((prev) => (prev === s ? null : s))
    if (s !== 'pdf') setExpandedPdf(null)
  }

  const handlePDFUpload = async (files: FileList | null) => {
    if (!files) return
    setUploadingPdf(true)
    for (const file of Array.from(files)) {
      try {
        const [{ text, pages }, thumbnail] = await Promise.all([
          uploadPDF(file),
          renderPDFThumbnail(file, 220),
        ])
        const id = nanoid()
        const thumbUrl = thumbnail ? await uploadAsset(thumbnail, `${file.name}-thumb`) : undefined
        const pdf = { id, name: file.name, text, pages, thumbnail: thumbUrl, uploadedAt: Date.now() }
        addPDF(pdf)

        if (hasApiKey && text.length > 100) {
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
        const url = await uploadAsset(dataUrl, file.name)
        addImage({ id: nanoid(), name: file.name, dataUrl: url, uploadedAt: Date.now() })
      } catch (err) {
        console.error('Image upload failed:', err)
      }
    }
    setUploadingImg(false)
  }

  return (
    <div className="h-full flex flex-col context-house">
      {/* ── Header ── */}
      <div className="flex-shrink-0 px-6 pt-6 pb-4">
        <div className="mx-auto max-w-4xl flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="context-house-header-title">Context House</h1>
            <p className="context-house-header-sub">
              Research materials scoped to each document
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowDocPicker((v) => !v)}
                className="context-doc-picker-btn"
              >
                <FileText size={13} />
                <span className="truncate max-w-[8rem]">{activeDoc?.title ?? 'Select document'}</span>
                <ChevronDown size={13} className="opacity-50" />
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
            {onboarding ? (
              <button
                type="button"
                onClick={() => tourNext()}
                className="btn-primary flex items-center gap-2"
              >
                Next
                <ArrowRight size={13} />
              </button>
            ) : (
              onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  className="btn-primary flex items-center gap-2"
                >
                  <PenTool size={13} />
                  Write
                </button>
              )
            )}
          </div>
        </div>
      </div>

      {/* ── Three-column layout ── */}
      <div className="flex-1 overflow-y-auto px-6 pb-6" style={{ scrollbarGutter: 'stable' }}>
        <div className="mx-auto max-w-4xl">
          <div className="ctx-three-cols">

            {/* ── PDF Slot ── */}
            <div className="ctx-slot-wrap">
              <div
                className="ctx-slot"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); handlePDFUpload(e.dataTransfer.files) }}
              >
                {pdfs.length > 0 && (
                  <div className="ctx-ghost-deck">
                    {pdfs.slice(0, 5).map((pdf, i) => {
                      const rots = deckRotations(Math.min(pdfs.length, 5))
                      return (
                        <div
                          key={pdf.id}
                          className="ctx-ghost-card ctx-ghost-pdf"
                          style={{ '--rot': `${rots[i]}deg`, zIndex: i } as CSSProperties}
                        >
                          {pdf.thumbnail
                            ? (
                              <img
                                src={pdf.thumbnail}
                                alt=""
                                className="ctx-ghost-page-thumb"
                              />
                            )
                            : (
                              <>
                                <FileText size={16} />
                                <span className="ctx-ghost-label">
                                  {pdf.name.replace(/\.pdf$/i, '').slice(0, 12)}
                                </span>
                              </>
                            )
                          }
                        </div>
                      )
                    })}
                  </div>
                )}

                <div className="ctx-slot-face">
                  <div className="ctx-slot-top">
                    <span className="ctx-slot-title">Documents</span>
                    {pdfs.length > 0 && <span className="ctx-count-pill">{pdfs.length}</span>}
                  </div>
                  <button
                    type="button"
                    className="ctx-plus-btn"
                    onClick={() => pdfInputRef.current?.click()}
                    disabled={uploadingPdf}
                    aria-label="Add PDF"
                  >
                    {uploadingPdf
                      ? <Loader2 size={22} className="animate-spin" />
                      : <Plus size={26} strokeWidth={2} />
                    }
                  </button>
                  {pdfs.length === 0 && !uploadingPdf && (
                    <p className="ctx-empty-hint">Drop PDF or click +</p>
                  )}
                </div>
              </div>

              {pdfs.length > 0 && (
                <button
                  type="button"
                  className="ctx-manage-btn"
                  onClick={() => toggleSection('pdf')}
                >
                  <Layers size={10} />
                  {pdfs.length} doc{pdfs.length !== 1 ? 's' : ''}
                  <ChevronDown
                    size={10}
                    style={{
                      transform: expandedSection === 'pdf' ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 160ms ease',
                    }}
                  />
                </button>
              )}

              {expandedSection === 'pdf' && (
                <div className="ctx-panel">
                  {pdfs.map((pdf) => (
                    <div key={pdf.id}>
                      <div className="ctx-panel-item">
                        <button
                          type="button"
                          className="ctx-panel-item-main"
                          onClick={() => setExpandedPdf(expandedPdf === pdf.id ? null : pdf.id)}
                        >
                          {pdf.thumbnail
                            ? <img src={pdf.thumbnail} alt="" className="ctx-panel-pdf-thumb" />
                            : <FileText size={12} className="ctx-slot-icon-pdf flex-shrink-0" />
                          }
                          <p className="ctx-panel-name">{pdf.name.replace(/\.pdf$/i, '')}</p>
                        </button>
                        <button
                          type="button"
                          className="ctx-panel-delete"
                          onClick={() => { if (expandedPdf === pdf.id) setExpandedPdf(null); removePDF(pdf.id) }}
                          aria-label="Remove PDF"
                        >
                          <X size={11} />
                        </button>
                      </div>
                      {expandedPdf === pdf.id && (
                        <div className="ctx-panel-preview">
                          {pdf.summary && (
                            <p className="ctx-panel-summary">{pdf.summary}</p>
                          )}
                          <pre className="ctx-panel-text">
                            {pdf.text.slice(0, 2000)}{pdf.text.length > 2000 ? '…' : ''}
                          </pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <input
                ref={pdfInputRef}
                type="file"
                accept=".pdf"
                multiple
                className="hidden"
                onChange={(e) => handlePDFUpload(e.target.files)}
              />
            </div>

            {/* ── Image Slot ── */}
            <div className="ctx-slot-wrap">
              <div
                className="ctx-slot"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); handleImageUpload(e.dataTransfer.files) }}
              >
                {images.length > 0 && (
                  <div className="ctx-ghost-deck">
                    {images.slice(0, 5).map((img, i) => {
                      const rots = deckRotations(Math.min(images.length, 5))
                      return (
                        <div
                          key={img.id}
                          className="ctx-ghost-card ctx-ghost-image"
                          style={{ '--rot': `${rots[i]}deg`, zIndex: i } as CSSProperties}
                        >
                          {img.dataUrl
                            ? (
                              <img
                                src={img.dataUrl}
                                alt=""
                                className="ctx-ghost-page-thumb"
                              />
                            )
                            : <ImageIcon size={16} />
                          }
                        </div>
                      )
                    })}
                  </div>
                )}

                <div className="ctx-slot-face">
                  <div className="ctx-slot-top">
                    <span className="ctx-slot-title">Images</span>
                    {images.length > 0 && <span className="ctx-count-pill">{images.length}</span>}
                  </div>
                  <button
                    type="button"
                    className="ctx-plus-btn"
                    onClick={() => imgInputRef.current?.click()}
                    disabled={uploadingImg}
                    aria-label="Add Image"
                  >
                    {uploadingImg
                      ? <Loader2 size={22} className="animate-spin" />
                      : <Plus size={26} strokeWidth={2} />
                    }
                  </button>
                  {images.length === 0 && !uploadingImg && (
                    <p className="ctx-empty-hint">Drop image or click +</p>
                  )}
                </div>
              </div>

              {images.length > 0 && (
                <button
                  type="button"
                  className="ctx-manage-btn"
                  onClick={() => toggleSection('image')}
                >
                  <Layers size={10} />
                  {images.length} image{images.length !== 1 ? 's' : ''}
                  <ChevronDown
                    size={10}
                    style={{
                      transform: expandedSection === 'image' ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 160ms ease',
                    }}
                  />
                </button>
              )}

              {expandedSection === 'image' && (
                <div className="ctx-panel">
                  {images.map((img) => (
                    <div key={img.id} className="ctx-panel-item">
                      <button
                        type="button"
                        className="ctx-panel-item-main"
                        onClick={() => setLightboxImage(img.dataUrl || null)}
                      >
                        {img.dataUrl
                          ? <img src={img.dataUrl} alt={img.name} className="ctx-panel-img-thumb" />
                          : <ImageIcon size={12} className="ctx-slot-icon-image flex-shrink-0" />
                        }
                        <p className="ctx-panel-name">{img.name}</p>
                      </button>
                      <button
                        type="button"
                        className="ctx-panel-delete"
                        onClick={() => removeImage(img.id)}
                        aria-label="Remove image"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <input
                ref={imgInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => handleImageUpload(e.target.files)}
              />
            </div>

            {/* ── Adventure Slot ── */}
            <div className="ctx-slot-wrap">
              <div className="ctx-slot">
                {linkedAdventures.length > 0 && (
                  <div className="ctx-ghost-deck">
                    {linkedAdventures.slice(0, 5).map((adv, i) => {
                      const rots = deckRotations(Math.min(linkedAdventures.length, 5))
                      return (
                        <div
                          key={adv.id}
                          className="ctx-ghost-card ctx-ghost-adv"
                          style={{ '--rot': `${rots[i]}deg`, zIndex: i } as CSSProperties}
                        >
                          <AdventurePreviewMemo adv={adv} />
                        </div>
                      )
                    })}
                  </div>
                )}

                <div className="ctx-slot-face">
                  <div className="ctx-slot-top">
                    <span className="ctx-slot-title">Adventures</span>
                    {linkedAdventures.length > 0 && (
                      <span className="ctx-count-pill">{linkedAdventures.length}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="ctx-plus-btn"
                    onClick={() => toggleSection('adventure')}
                    aria-label="Link adventure"
                  >
                    <Plus size={26} strokeWidth={2} />
                  </button>
                  {linkedAdventures.length === 0 && (
                    <p className="ctx-empty-hint">Link exploration threads</p>
                  )}
                </div>
              </div>

              {linkedAdventures.length > 0 && (
                <button
                  type="button"
                  className="ctx-manage-btn"
                  onClick={() => toggleSection('adventure')}
                >
                  <Layers size={10} />
                  {linkedAdventures.length} adventure{linkedAdventures.length !== 1 ? 's' : ''}
                  <ChevronDown
                    size={10}
                    style={{
                      transform: expandedSection === 'adventure' ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 160ms ease',
                    }}
                  />
                </button>
              )}

              {expandedSection === 'adventure' && (
                <div className="ctx-panel">
                  {availableAdventures.length > 0 && (
                    <div className="ctx-adv-picker-section">
                      <p className="ctx-adv-picker-label">Link an adventure</p>
                      {availableAdventures.map((adv) => (
                        <button
                          key={adv.id}
                          type="button"
                          className="ctx-adv-picker-item"
                          onClick={() => linkAdventure(adv.id)}
                        >
                          <GitBranch size={12} className="ctx-slot-icon-adv flex-shrink-0" />
                          <p className="ctx-panel-name">{adv.name}</p>
                          <Plus size={12} className="flex-shrink-0 opacity-40" />
                        </button>
                      ))}
                    </div>
                  )}

                  {linkedAdventures.length === 0 && availableAdventures.length === 0 && (
                    <p className="ctx-empty-hint" style={{ padding: '0.65rem' }}>
                      Create an adventure in Exploration mode first
                    </p>
                  )}

                  {linkedAdventures.map((adv) => (
                    <div key={adv.id} className="ctx-panel-item">
                      <div className="ctx-panel-item-display">
                        <GitBranch size={12} className="ctx-slot-icon-adv flex-shrink-0" />
                        <p className="ctx-panel-name">{adv.name}</p>
                      </div>
                      <button
                        type="button"
                        className="ctx-panel-delete"
                        onClick={() => unlinkAdventure(adv.id)}
                        aria-label="Unlink adventure"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
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
          <button
            type="button"
            className="context-lightbox-close"
            onClick={() => setLightboxImage(null)}
          >
            <X size={20} />
          </button>
          <img src={lightboxImage} alt="Reference image preview" className="context-lightbox-img" />
        </div>
      )}
    </div>
  )
}

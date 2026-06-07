import { useRef, useState } from 'react'
import { FileText, Image as ImageIcon, Plus, X, Loader2, ChevronDown, ChevronUp, PenTool } from 'lucide-react'
import { nanoid } from 'nanoid'
import { useStore } from '../../store/useStore'
import { uploadPDF, syncChat } from '../../lib/claude'

export default function ContextHouse() {
  const { pdfs, images, apiKey, addPDF, removePDF, updatePDFSummary, addImage, removeImage, updateImageDescription, setActiveTab } = useStore()

  const pdfInputRef = useRef<HTMLInputElement>(null)
  const imgInputRef = useRef<HTMLInputElement>(null)
  const [uploadingId, setUploadingId] = useState<string | null>(null)
  const [expandedPdf, setExpandedPdf] = useState<string | null>(null)

  const handlePDFUpload = async (files: FileList | null) => {
    if (!files) return
    for (const file of Array.from(files)) {
      const id = nanoid()
      setUploadingId(id)
      try {
        const { text, pages } = await uploadPDF(file)
        const pdf = { id, name: file.name, text, pages, uploadedAt: Date.now() }
        addPDF(pdf)

        // Auto-summarize if API key available
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
      } finally {
        setUploadingId(null)
      }
    }
  }

  const handleImageUpload = async (files: FileList | null) => {
    if (!files) return
    for (const file of Array.from(files)) {
      const id = nanoid()
      const reader = new FileReader()
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string
        addImage({ id, name: file.name, dataUrl, uploadedAt: Date.now() })
      }
      reader.readAsDataURL(file)
    }
  }

  const handleDrop = (e: React.DragEvent, type: 'pdf' | 'image') => {
    e.preventDefault()
    const files = e.dataTransfer.files
    if (type === 'pdf') handlePDFUpload(files)
    else handleImageUpload(files)
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 px-6 pt-6 pb-4">
        <div className="mx-auto max-w-5xl flex items-end justify-between">
          <div>
            <h1 className="font-caveat text-3xl font-bold text-white">Context House</h1>
            <p className="mt-1 text-sm text-white/40">Load research materials that Claude can draw on while you write</p>
          </div>
          <button onClick={() => setActiveTab('write')} className="btn-primary flex items-center gap-2">
            <PenTool size={14} />
            Write
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        <div className="mx-auto max-w-5xl">
        <div className="grid grid-cols-3 gap-4 min-w-0">
          {/* PDF Suite */}
          <div
            className="col-span-2 card p-4 min-w-0"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleDrop(e, 'pdf')}
          >
            <div className="mb-4 flex items-center justify-between">
              <span className="section-title">PDF Suite</span>
              <span className="text-xs text-white/30">{pdfs.length} document{pdfs.length !== 1 ? 's' : ''}</span>
            </div>

            {/* PDF grid */}
            <div className="grid grid-cols-4 gap-2 min-w-0">
              {pdfs.map((pdf) => (
                <div key={pdf.id} className="group relative min-w-0">
                  <button
                    onClick={() => setExpandedPdf(expandedPdf === pdf.id ? null : pdf.id)}
                    className="card-hover w-full aspect-[3/4] flex flex-col items-center justify-center gap-2 p-3 text-center"
                  >
                    <FileText size={24} className="text-accent-gold/70" />
                    <span className="label text-xs leading-tight line-clamp-2">{pdf.name}</span>
                    <span className="text-[10px] text-white/25">{pdf.pages}p</span>
                  </button>
                  <button
                    onClick={() => removePDF(pdf.id)}
                    className="absolute -right-1.5 -top-1.5 hidden group-hover:flex items-center justify-center w-5 h-5 rounded-full bg-red-500/80 text-white"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}

              {/* Upload slot */}
              <button
                onClick={() => pdfInputRef.current?.click()}
                className="card-hover w-full min-w-0 aspect-[3/4] flex flex-col items-center justify-center gap-2 border-dashed"
              >
                {uploadingId ? (
                  <Loader2 size={20} className="text-white/30 animate-spin" />
                ) : (
                  <>
                    <Plus size={20} className="text-white/30" />
                    <span className="label text-xs">Add PDF</span>
                  </>
                )}
              </button>
            </div>

            <p className="mt-3 text-center text-xs text-white/25">
              Click "+" to upload · Drag & drop supported
            </p>

            <input
              ref={pdfInputRef}
              type="file"
              accept=".pdf"
              multiple
              className="hidden"
              onChange={(e) => handlePDFUpload(e.target.files)}
            />
          </div>

          {/* Image Suite */}
          <div
            className="card p-4 flex flex-col min-w-0"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleDrop(e, 'image')}
          >
            <div className="mb-4 flex items-center justify-between">
              <span className="section-title">Image Suite</span>
              <span className="text-xs text-white/30">{images.length}</span>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto min-w-0">
              {images.map((img) => (
                <div key={img.id} className="group relative rounded-xl overflow-hidden border border-white/10">
                  <img src={img.dataUrl} alt={img.name} className="w-full h-20 object-cover" />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <button onClick={() => removeImage(img.id)} className="text-red-400 hover:text-red-300">
                      <X size={16} />
                    </button>
                  </div>
                </div>
              ))}

              <button
                onClick={() => imgInputRef.current?.click()}
                className="card-hover w-full py-4 flex flex-col items-center gap-2 border-dashed"
              >
                <ImageIcon size={20} className="text-white/30" />
                <span className="label text-xs">Add Image</span>
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

            <button onClick={() => setActiveTab('write')} className="btn-ghost w-full mt-3 text-center">
              Write
            </button>
          </div>
        </div>

        {/* Expanded PDF viewer */}
        {expandedPdf && (() => {
          const pdf = pdfs.find((p) => p.id === expandedPdf)
          if (!pdf) return null
          return (
            <div className="mt-4 card p-5 animate-slide-up">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText size={16} className="text-accent-gold" />
                  <span className="font-medium text-white/80">{pdf.name}</span>
                  <span className="text-xs text-white/30">{pdf.pages} pages</span>
                </div>
                <button onClick={() => setExpandedPdf(null)} className="text-white/40 hover:text-white/70">
                  <X size={16} />
                </button>
              </div>

              {pdf.summary && (
                <div className="mb-3 rounded-xl border border-accent-gold/20 bg-accent-gold/5 p-3">
                  <p className="text-sm text-white/70 leading-relaxed">{pdf.summary}</p>
                </div>
              )}

              <div className="max-h-48 overflow-y-auto rounded-xl bg-white/3 p-3">
                <pre className="whitespace-pre-wrap text-xs text-white/50 font-mono leading-relaxed">
                  {pdf.text.slice(0, 2000)}
                  {pdf.text.length > 2000 && '...[truncated]'}
                </pre>
              </div>
            </div>
          )
        })()}

        {/* Context summary */}
        {(pdfs.length > 0 || images.length > 0) && (
          <div className="mt-4 rounded-xl border border-white/5 bg-white/2 p-4">
            <p className="text-xs text-white/40 leading-relaxed">
              <span className="text-white/60 font-medium">Active context: </span>
              {pdfs.length > 0 && `${pdfs.length} PDF${pdfs.length > 1 ? 's' : ''} loaded`}
              {pdfs.length > 0 && images.length > 0 && ' · '}
              {images.length > 0 && `${images.length} image${images.length > 1 ? 's' : ''} uploaded`}
              . Claude will reference this material when you ask for help in Write mode.
            </p>
          </div>
        )}
        </div>
      </div>
    </div>
  )
}

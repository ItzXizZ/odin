import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { nanoid } from 'nanoid'
import type { Node, Edge } from 'reactflow'
import type { SourceRef } from '../lib/sources'
import { DEFAULT_STYLE_RULES, type StyleRule } from '../lib/style'

export type AppTab = 'context' | 'stream' | 'exploration' | 'write' | 'grade'

export interface PDFDocument {
  id: string
  name: string
  text: string
  pages: number
  summary?: string
  uploadedAt: number
}

export interface ImageDocument {
  id: string
  name: string
  dataUrl: string
  description?: string
  uploadedAt: number
}

export interface TranscriptSession {
  id: string
  transcript: string
  questions: string[]
  createdAt: number
}

export interface NodeHighlight {
  id: string
  text: string
  ratio: number
  childId: string
}

export interface VisualAsset {
  imageDataUrl: string
  caption: string
  referenceUrl?: string
  referenceTitle?: string
  referenceImageUrl?: string
  mode: 'chemical_structure' | 'reference_photo' | 'adapted' | 'generated'
  provider?: 'pubchem' | 'openai' | 'google' | 'replicate' | 'web'
}

export interface ExplorationNodeData {
  prompt: string
  response: string
  isLoading?: boolean
  /** When set, the node is optimized for visual output (user asked for an image). */
  nodeKind?: 'text' | 'visual'
  /** Generated or adapted visual for this node. */
  visual?: VisualAsset
  /** Status message while a visual is being prepared. */
  visualStatus?: string
  /** When the request is ambiguous, the user picks how to create the visual. */
  visualChoice?: { suggestion?: 'search' | 'generate' }
  /** Stored request params so a visual can be (re)generated after a choice. */
  visualRequest?: { query: string; parentId?: string; excerpt?: string }
  /** Transient callback injected by ExplorationMode — not persisted. */
  onVisualChoice?: (method: 'search' | 'generate') => void
  /** Web research + cited sources captured for this message. */
  sources?: SourceRef[]
  connectionCount?: number
  highlights?: NodeHighlight[]
  /** Transient UI-only mark while user branches from a selection (not persisted). */
  pendingHighlight?: string
  /** Transient callback injected by ExplorationMode — not persisted. */
  onReplyFull?: () => void
  /** Transient: this node is the target for a full-message reply (not persisted). */
  isReplyTarget?: boolean
}

export interface Takeaway {
  id: string
  text: string
  sourceNodeId?: string
  relevanceScore?: number
}

export interface Adventure {
  id: string
  name: string
  createdAt: number
  nodes: Node<ExplorationNodeData>[]
  edges: Edge[]
  takeaways: Takeaway[]
}

function makeAdventure(name: string): Adventure {
  return {
    id: nanoid(),
    name,
    createdAt: Date.now(),
    nodes: [],
    edges: [],
    takeaways: [],
  }
}

function patchActiveAdventure(
  adventures: Adventure[],
  activeAdventureId: string | null,
  patch: (adventure: Adventure) => Adventure
): Adventure[] {
  if (!activeAdventureId) return adventures
  return adventures.map((a) => (a.id === activeAdventureId ? patch(a) : a))
}

export interface GradeResult {
  overallScore: number
  rubricScores: { criterion: string; score: number; maxScore: number; feedback: string }[]
  strengths: string[]
  improvements: string[]
  summary: string
}

interface AppState {
  // Navigation
  activeTab: AppTab
  apiKey: string
  showSettings: boolean

  // Context House
  pdfs: PDFDocument[]
  images: ImageDocument[]

  // Stream of Consciousness
  sessions: TranscriptSession[]
  currentTranscript: string

  // Exploration Mode
  adventures: Adventure[]
  activeAdventureId: string | null
  liveSourceContext: string

  // Write Mode
  documentContent: string
  documentTitle: string
  writingPrompt: string
  highlightedText: string
  styleRules: StyleRule[]

  // Grade Mode
  rubric: string
  gradeResult: GradeResult | null
  isGrading: boolean

  // Actions
  setActiveTab: (tab: AppTab) => void
  setApiKey: (key: string) => void
  setShowSettings: (v: boolean) => void

  addPDF: (pdf: PDFDocument) => void
  removePDF: (id: string) => void
  updatePDFSummary: (id: string, summary: string) => void

  addImage: (img: ImageDocument) => void
  removeImage: (id: string) => void
  updateImageDescription: (id: string, description: string) => void

  addSession: (session: TranscriptSession) => void
  updateCurrentTranscript: (text: string) => void

  setExplorationNodes: (nodes: Node<ExplorationNodeData>[]) => void
  setExplorationEdges: (edges: Edge[]) => void
  addExplorationNode: (node: Node<ExplorationNodeData>) => void
  updateNodeResponse: (id: string, response: string, isLoading?: boolean) => void
  addTakeaway: (takeaway: Takeaway) => void
  removeTakeaway: (id: string) => void
  createAdventure: (name?: string) => string
  deleteAdventure: (id: string) => void
  renameAdventure: (id: string, name: string) => void
  setActiveAdventureId: (id: string) => void
  setLiveSourceContext: (text: string) => void

  setDocumentContent: (content: string) => void
  setDocumentTitle: (title: string) => void
  setWritingPrompt: (prompt: string) => void
  setHighlightedText: (text: string) => void
  setStyleRules: (rules: StyleRule[]) => void
  resetStyleRules: () => void

  setRubric: (rubric: string) => void
  setGradeResult: (result: GradeResult | null) => void
  setIsGrading: (v: boolean) => void

  getFullContext: () => string
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      activeTab: 'context',
      apiKey: '',
      showSettings: false,

      pdfs: [],
      images: [],

      sessions: [],
      currentTranscript: '',

      ...(() => {
        const first = makeAdventure('Adventure 1')
        return { adventures: [first], activeAdventureId: first.id }
      })(),
      liveSourceContext: '',

      documentContent: '',
      documentTitle: 'Untitled',
      writingPrompt: '',
      highlightedText: '',
      styleRules: DEFAULT_STYLE_RULES,

      rubric: `Thesis & Argument (25 pts): Clear, debatable thesis with well-supported arguments
Evidence & Analysis (25 pts): Relevant evidence with deep critical analysis
Organization & Structure (20 pts): Logical flow with effective transitions
Style & Voice (15 pts): Engaging prose with appropriate academic tone
Grammar & Mechanics (15 pts): Correct grammar, punctuation, and citation format`,
      gradeResult: null,
      isGrading: false,

      setActiveTab: (tab) => set({ activeTab: tab }),
      setApiKey: (key) => set({ apiKey: key }),
      setShowSettings: (v) => set({ showSettings: v }),

      addPDF: (pdf) => set((s) => ({ pdfs: [...s.pdfs, pdf] })),
      removePDF: (id) => set((s) => ({ pdfs: s.pdfs.filter((p) => p.id !== id) })),
      updatePDFSummary: (id, summary) =>
        set((s) => ({ pdfs: s.pdfs.map((p) => (p.id === id ? { ...p, summary } : p)) })),

      addImage: (img) => set((s) => ({ images: [...s.images, img] })),
      removeImage: (id) => set((s) => ({ images: s.images.filter((i) => i.id !== id) })),
      updateImageDescription: (id, description) =>
        set((s) => ({ images: s.images.map((i) => (i.id === id ? { ...i, description } : i)) })),

      addSession: (session) => set((s) => ({ sessions: [session, ...s.sessions] })),
      updateCurrentTranscript: (text) => set({ currentTranscript: text }),

      setExplorationNodes: (nodes) =>
        set((s) => ({
          adventures: patchActiveAdventure(s.adventures, s.activeAdventureId, (a) => ({
            ...a,
            nodes,
          })),
        })),
      setExplorationEdges: (edges) =>
        set((s) => ({
          adventures: patchActiveAdventure(s.adventures, s.activeAdventureId, (a) => ({
            ...a,
            edges,
          })),
        })),
      addExplorationNode: (node) =>
        set((s) => ({
          adventures: patchActiveAdventure(s.adventures, s.activeAdventureId, (a) => ({
            ...a,
            nodes: [...a.nodes, node],
          })),
        })),
      updateNodeResponse: (id, response, isLoading = false) =>
        set((s) => ({
          adventures: patchActiveAdventure(s.adventures, s.activeAdventureId, (a) => ({
            ...a,
            nodes: a.nodes.map((n) =>
              n.id === id ? { ...n, data: { ...n.data, response, isLoading } } : n
            ),
          })),
        })),
      addTakeaway: (takeaway) =>
        set((s) => ({
          adventures: patchActiveAdventure(s.adventures, s.activeAdventureId, (a) => ({
            ...a,
            takeaways: [...a.takeaways, takeaway],
          })),
        })),
      removeTakeaway: (id) =>
        set((s) => ({
          adventures: patchActiveAdventure(s.adventures, s.activeAdventureId, (a) => ({
            ...a,
            takeaways: a.takeaways.filter((t) => t.id !== id),
          })),
        })),
      createAdventure: (name) => {
        const adventure = makeAdventure(name ?? `Adventure ${get().adventures.length + 1}`)
        set((s) => ({
          adventures: [adventure, ...s.adventures],
          activeAdventureId: adventure.id,
        }))
        return adventure.id
      },
      deleteAdventure: (id) =>
        set((s) => {
          if (s.adventures.length <= 1) return s
          const next = s.adventures.filter((a) => a.id !== id)
          const activeAdventureId =
            s.activeAdventureId === id ? next[0]?.id ?? null : s.activeAdventureId
          return { adventures: next, activeAdventureId }
        }),
      renameAdventure: (id, name) =>
        set((s) => ({
          adventures: s.adventures.map((a) => (a.id === id ? { ...a, name: name.trim() || a.name } : a)),
        })),
      setActiveAdventureId: (id) =>
        set((s) => (s.adventures.some((a) => a.id === id) ? { activeAdventureId: id } : s)),
      setLiveSourceContext: (text) => set({ liveSourceContext: text }),

      setDocumentContent: (content) => set({ documentContent: content }),
      setDocumentTitle: (title) => set({ documentTitle: title }),
      setWritingPrompt: (prompt) => set({ writingPrompt: prompt }),
      setHighlightedText: (text) => set({ highlightedText: text }),
      setStyleRules: (rules) => set({ styleRules: rules }),
      resetStyleRules: () => set({ styleRules: DEFAULT_STYLE_RULES }),

      setRubric: (rubric) => set({ rubric }),
      setGradeResult: (result) => set({ gradeResult: result }),
      setIsGrading: (v) => set({ isGrading: v }),

      getFullContext: () => {
        const s = get()
        const parts: string[] = []

        if (s.pdfs.length > 0) {
          parts.push('=== CONTEXT DOCUMENTS ===')
          s.pdfs.forEach((pdf) => {
            parts.push(`[${pdf.name}]`)
            if (pdf.summary) parts.push(`Summary: ${pdf.summary}`)
            parts.push(pdf.text.slice(0, 3000))
          })
        }

        if (s.images.length > 0) {
          parts.push('=== REFERENCE IMAGES ===')
          s.images.forEach((img) => {
            parts.push(`[${img.name}]: ${img.description || 'No description'}`)
          })
        }

        if (s.sessions.length > 0) {
          parts.push('=== STREAM OF CONSCIOUSNESS ===')
          s.sessions.forEach((sess) => {
            parts.push(`Transcript: ${sess.transcript}`)
            if (sess.questions.length > 0) {
              parts.push('Generated Questions: ' + sess.questions.join(' | '))
            }
          })
        }

        const adventuresWithContent = s.adventures.filter(
          (a) => a.nodes.some((n) => n.data.response) || a.takeaways.length > 0
        )
        if (adventuresWithContent.length > 0) {
          parts.push('=== EXPLORATION ADVENTURES ===')
          adventuresWithContent.forEach((adventure) => {
            parts.push(`--- ${adventure.name} ---`)
            adventure.nodes.forEach((node) => {
              if (node.data.response) {
                parts.push(`Q: ${node.data.prompt}`)
                parts.push(`A: ${node.data.response.slice(0, 500)}`)
              }
            })
            if (adventure.takeaways.length > 0) {
              parts.push('Takeaways:')
              adventure.takeaways.forEach((t) => parts.push(`• ${t.text}`))
            }
          })
        }

        return parts.join('\n\n')
      },
    }),
    {
      name: 'scribe-storage',
      version: 2,
      migrate: (persisted, version) => {
        const state = persisted as Record<string, unknown>
        if (version < 2) {
          const legacyNodes = (state.explorationNodes as Adventure['nodes']) ?? []
          const legacyEdges = (state.explorationEdges as Adventure['edges']) ?? []
          const legacyTakeaways = (state.takeaways as Takeaway[]) ?? []
          const hasLegacy =
            legacyNodes.length > 0 || legacyEdges.length > 0 || legacyTakeaways.length > 0
          const adventure = makeAdventure('Adventure 1')
          if (hasLegacy) {
            adventure.nodes = legacyNodes
            adventure.edges = legacyEdges
            adventure.takeaways = legacyTakeaways
          }
          delete state.explorationNodes
          delete state.explorationEdges
          delete state.takeaways
          return {
            ...state,
            adventures: [adventure],
            activeAdventureId: adventure.id,
          }
        }
        return persisted
      },
      partialize: (s) => ({
        apiKey: s.apiKey,
        pdfs: s.pdfs.map((p) => ({ ...p, text: p.text.slice(0, 5000) })),
        images: s.images.map((i) => ({ ...i, dataUrl: '' })),
        sessions: s.sessions,
        documentContent: s.documentContent,
        documentTitle: s.documentTitle,
        styleRules: s.styleRules,
        rubric: s.rubric,
        adventures: s.adventures,
        activeAdventureId: s.activeAdventureId,
      }),
    }
  )
)

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { nanoid } from 'nanoid'
import { workspaceStorage } from '../lib/workspaceStorage'
import type { Node, Edge } from 'reactflow'
import type { SourceRef } from '../lib/sources'
import {
  DEFAULT_STYLE_RULES,
  migrateStyleRule,
  computeStyleEdges,
  connectionKey,
  ruleSimilarity,
  type StyleRule,
  type StyleConnectionBonus,
  type StyleActivation,
} from '../lib/style'

export type AppTab = 'home' | 'stream' | 'exploration' | 'write' | 'stylism' | 'grade'

import type { WriteChatThread } from '../components/WriteMode/chatThreads'

/** A sub-document within a writing project, like Google Docs tabs. */
export interface DocTab {
  id: string
  name: string
  content: string
  chatThreads?: WriteChatThread[]
  activeChatThreadId?: string | null
}

export interface ContextConversation {
  id: string
  name: string
  transcript: string
  questions?: string[]
  source: 'upload' | 'stream'
  sourceSessionId?: string
  uploadedAt: number
}

export interface DocumentContext {
  pdfs: PDFDocument[]
  images: ImageDocument[]
  conversations: ContextConversation[]
  linkedAdventureIds: string[]
}

export interface WritingDocument {
  id: string
  title: string
  tabs: DocTab[]
  activeTabId: string
  context: DocumentContext
  createdAt: number
  updatedAt: number
}

function emptyDocumentContext(): DocumentContext {
  return { pdfs: [], images: [], conversations: [], linkedAdventureIds: [] }
}

function makeDocument(title = 'Untitled', content = ''): WritingDocument {
  const now = Date.now()
  const tab: DocTab = { id: nanoid(), name: 'Tab 1', content }
  return {
    id: nanoid(),
    title,
    tabs: [tab],
    activeTabId: tab.id,
    context: emptyDocumentContext(),
    createdAt: now,
    updatedAt: now,
  }
}

function isBlankDocument(doc: {
  title?: string
  tabs?: DocTab[]
  context?: DocumentContext
}): boolean {
  const title = (doc.title ?? '').trim()
  const tabs = doc.tabs ?? []
  const hasText = tabs.some((t) => (t.content ?? '').replace(/<[^>]+>/g, '').trim().length > 0)
  const ctx = doc.context ?? emptyDocumentContext()
  const hasContext = Boolean(
    ctx.pdfs.length ||
      ctx.images.length ||
      ctx.conversations.length ||
      ctx.linkedAdventureIds.length
  )
  return (!title || title === 'Untitled') && !hasText && !hasContext
}

function patchActiveDocContext(
  s: { documents: WritingDocument[]; activeDocumentId: string | null },
  patch: (ctx: DocumentContext) => DocumentContext
): WritingDocument[] {
  return patchActiveDoc(s, (d) => ({
    ...d,
    context: patch(d.context ?? emptyDocumentContext()),
  }))
}

function patchActiveDoc(
  s: { documents: WritingDocument[]; activeDocumentId: string | null },
  patch: (doc: WritingDocument) => WritingDocument
): WritingDocument[] {
  return s.documents.map((d) =>
    d.id === s.activeDocumentId ? { ...patch(d), updatedAt: Date.now() } : d
  )
}

export interface PDFDocument {
  id: string
  name: string
  text: string
  pages: number
  summary?: string
  thumbnail?: string
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
  nodeKind?: 'text' | 'visual' | 'embed'
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
  /** URL to embed when nodeKind === 'embed'. */
  embedUrl?: string
  /** Saved scroll position inside a reader-proxied embed (persisted with the adventure). */
  embedScrollTop?: number
  /** Transient callback injected by ExplorationMode — not persisted. */
  onEmbedScrollChange?: (scrollTop: number) => void
  /** Transient: user selected text inside an embed for branching (not persisted). */
  onEmbedExcerpt?: (excerpt: { text: string; ratio: number }) => void
  /** Transient callback injected by ExplorationMode — not persisted. */
  onLinkClick?: (url: string, x: number, y: number, linkText?: string) => void
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
  /** Captured board screenshot (data URL) – set by ExplorationMode on save. */
  thumbnail?: string
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

/* ── Stylism neural mechanics ── */
const DIRECT_GAIN = 1.0 // weight added to a directly referenced rule
const HOP_DECAY = 0.55 // signal strength multiplier per hop (Moneta uses 0.85 visually; weights need a steeper falloff)
const MAX_HOPS = 2
const HEBBIAN_STEP = 0.08 // connection bonus added per co-activation
const HEBBIAN_CAP = 0.6

/**
 * Spread activation from directly reinforced rules through the network.
 * Neighbors fire stochastically: stronger edges are more likely to carry the
 * signal, and the carried gain is itself jittered, so growth around a hot
 * neuron is organic rather than uniform.
 */
function spreadActivation(
  rules: StyleRule[],
  connections: StyleConnectionBonus[],
  directIds: string[]
): { id: string; from: string; amount: number }[] {
  const edges = computeStyleEdges(rules, connections)
  const neighbors = new Map<string, { id: string; strength: number }[]>()
  for (const e of edges) {
    if (!neighbors.has(e.a)) neighbors.set(e.a, [])
    if (!neighbors.has(e.b)) neighbors.set(e.b, [])
    neighbors.get(e.a)!.push({ id: e.b, strength: e.strength })
    neighbors.get(e.b)!.push({ id: e.a, strength: e.strength })
  }

  const spill: { id: string; from: string; amount: number }[] = []
  const visited = new Set(directIds)
  let frontier = directIds.map((id) => ({ id, signal: DIRECT_GAIN }))

  for (let hop = 1; hop <= MAX_HOPS; hop++) {
    const next: { id: string; signal: number }[] = []
    for (const { id, signal } of frontier) {
      for (const nb of neighbors.get(id) ?? []) {
        if (visited.has(nb.id)) continue
        // Stochastic firing: edge strength sets the odds the synapse carries.
        const fireChance = 0.25 + nb.strength * 0.65
        if (Math.random() > fireChance) continue
        visited.add(nb.id)
        const jitter = 0.6 + Math.random() * 0.8
        const amount = signal * HOP_DECAY * nb.strength * jitter
        if (amount < 0.02) continue
        spill.push({ id: nb.id, from: id, amount })
        next.push({ id: nb.id, signal: signal * HOP_DECAY * nb.strength })
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }
  return spill
}

function bumpHebbian(
  connections: StyleConnectionBonus[],
  pairs: [string, string][]
): StyleConnectionBonus[] {
  const map = new Map(connections.map((c) => [`${c.a}|${c.b}`, { ...c }]))
  for (const [rawA, rawB] of pairs) {
    const [a, b] = connectionKey(rawA, rawB)
    if (a === b) continue
    const key = `${a}|${b}`
    const existing = map.get(key)
    if (existing) {
      existing.bonus = Math.min(HEBBIAN_CAP, existing.bonus + HEBBIAN_STEP)
      existing.coActivations += 1
    } else {
      map.set(key, { a, b, bonus: HEBBIAN_STEP, coActivations: 1 })
    }
  }
  return [...map.values()]
}

/** A single problematic region Odin flags inside the document. */
export interface GradeAnnotation {
  /** Verbatim snippet copied from the document so it can be located + underlined. */
  quote: string
  /** Issue family, used to colour the highlight. */
  category:
    | 'clutter'
    | 'wordy'
    | 'passive'
    | 'adverb'
    | 'adjective'
    | 'abstraction'
    | 'vague'
    | 'cliche'
    | 'jargon'
    | 'other'
  /** What's wrong, grounded in Zinsser. */
  issue: string
  /** A concrete fix. */
  suggestion: string
}

export interface GradeResult {
  overallScore: number
  /** A short, spoken-aloud verdict delivered by Odin (1–2 sentences). */
  odinVerdict?: string
  summary: string
  /** Problematic regions Odin underlines live in the document. */
  annotations: GradeAnnotation[]
}

interface AppState {
  // Navigation
  activeTab: AppTab
  /** User-supplied key (in-app Settings). Empty means "use the server's key". */
  apiKey: string
  /** Whether the backend has its own ANTHROPIC_API_KEY (from /api/health). */
  serverHasKey: boolean
  showSettings: boolean

  // Stream of Consciousness
  sessions: TranscriptSession[]
  currentTranscript: string

  // Exploration Mode
  adventures: Adventure[]
  activeAdventureId: string | null
  liveSourceContext: string

  // Write Mode — multiple documents/projects
  documents: WritingDocument[]
  activeDocumentId: string | null
  writingPrompt: string
  highlightedText: string
  styleRules: StyleRule[]
  /** Learned Hebbian connection bonuses between style rules. */
  styleConnections: StyleConnectionBonus[]
  /** Last reinforcement event — consumed by the Stylism network animation. */
  lastStyleActivation: StyleActivation | null

  // Grade Mode
  rubric: string
  gradeResult: GradeResult | null
  isGrading: boolean

  // Actions
  setActiveTab: (tab: AppTab) => void
  setApiKey: (key: string) => void
  setServerHasKey: (v: boolean) => void
  setShowSettings: (v: boolean) => void

  addPDF: (pdf: PDFDocument) => void
  removePDF: (id: string) => void
  updatePDFSummary: (id: string, summary: string) => void

  addImage: (img: ImageDocument) => void
  removeImage: (id: string) => void
  updateImageDescription: (id: string, description: string) => void

  linkAdventure: (adventureId: string) => void
  unlinkAdventure: (adventureId: string) => void
  getActiveDocumentContext: () => DocumentContext

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
  setAdventureThumbnail: (id: string, thumbnail: string) => void
  setActiveAdventureId: (id: string) => void
  setLiveSourceContext: (text: string) => void

  setDocumentContent: (content: string) => void
  setDocumentTitle: (title: string) => void
  createDocument: (title?: string) => string
  deleteDocument: (id: string) => void
  setActiveDocumentId: (id: string) => void
  getActiveDocument: () => WritingDocument | null
  addDocTab: (name?: string) => string
  deleteDocTab: (tabId: string) => void
  renameDocTab: (tabId: string, name: string) => void
  setActiveDocTab: (tabId: string) => void
  getActiveTab: () => DocTab | null
  updateActiveTabChat: (updates: {
    chatThreads?: WriteChatThread[]
    activeChatThreadId?: string | null
  }) => void
  setWritingPrompt: (prompt: string) => void
  setHighlightedText: (text: string) => void
  setStyleRules: (rules: StyleRule[]) => void
  /**
   * Reinforce rules from stylistic feedback: direct hits grow fully, then the
   * signal spreads stochastically through connected neighbors (2 hops, decaying
   * like Moneta's neural propagation). Rules reinforced together wire together.
   */
  reinforceStyleRules: (ruleIds: string[]) => void
  /** Add a rule born from feedback, wired to its related rules. Returns id. */
  addStyleRule: (rule: { label: string; instruction: string; relatedRuleIds?: string[]; source?: StyleRule['source'] }) => string
  /** Bulk-add principles from a writing sample analysis; wires similarity edges once. */
  importStyleRules: (items: { label: string; instruction: string }[]) => string[]
  editStyleRule: (id: string, patch: Partial<Pick<StyleRule, 'label' | 'instruction' | 'enabled'>>) => void
  deleteStyleRule: (id: string) => void
  setStyleRulePosition: (id: string, x: number, y: number) => void
  clearStyleActivation: () => void

  setRubric: (rubric: string) => void
  setGradeResult: (result: GradeResult | null) => void
  setIsGrading: (v: boolean) => void

  getFullContext: () => string
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      activeTab: 'home',
      // SECURITY: never inline the Anthropic key into the frontend bundle.
      // Leaving this empty makes the browser send no key; the server then uses
      // its own server-side ANTHROPIC_API_KEY (see server.js). Users may still
      // paste a personal key via the in-app Settings panel.
      apiKey: '',
      serverHasKey: false,
      showSettings: false,

      sessions: [],
      currentTranscript: '',

      ...(() => {
        const first = makeAdventure('Adventure 1')
        return { adventures: [first], activeAdventureId: first.id }
      })(),
      liveSourceContext: '',

      documents: [] as WritingDocument[],
      activeDocumentId: null as string | null,
      writingPrompt: '',
      highlightedText: '',
      styleRules: DEFAULT_STYLE_RULES,
      styleConnections: [],
      lastStyleActivation: null,

      rubric: `Thesis & Argument (25 pts): Clear, debatable thesis with well-supported arguments
Evidence & Analysis (25 pts): Relevant evidence with deep critical analysis
Organization & Structure (20 pts): Logical flow with effective transitions
Style & Voice (15 pts): Engaging prose with appropriate academic tone
Grammar & Mechanics (15 pts): Correct grammar, punctuation, and citation format`,
      gradeResult: null,
      isGrading: false,

      setActiveTab: (tab) => set({ activeTab: tab }),
      setApiKey: (key) => set({ apiKey: key }),
      setServerHasKey: (v) => set({ serverHasKey: v }),
      setShowSettings: (v) => set({ showSettings: v }),

      addPDF: (pdf) =>
        set((s) => ({ documents: patchActiveDocContext(s, (ctx) => ({ ...ctx, pdfs: [...ctx.pdfs, pdf] })) })),
      removePDF: (id) =>
        set((s) => ({
          documents: patchActiveDocContext(s, (ctx) => ({ ...ctx, pdfs: ctx.pdfs.filter((p) => p.id !== id) })),
        })),
      updatePDFSummary: (id, summary) =>
        set((s) => ({
          documents: patchActiveDocContext(s, (ctx) => ({
            ...ctx,
            pdfs: ctx.pdfs.map((p) => (p.id === id ? { ...p, summary } : p)),
          })),
        })),

      addImage: (img) =>
        set((s) => ({ documents: patchActiveDocContext(s, (ctx) => ({ ...ctx, images: [...ctx.images, img] })) })),
      removeImage: (id) =>
        set((s) => ({
          documents: patchActiveDocContext(s, (ctx) => ({ ...ctx, images: ctx.images.filter((i) => i.id !== id) })),
        })),
      updateImageDescription: (id, description) =>
        set((s) => ({
          documents: patchActiveDocContext(s, (ctx) => ({
            ...ctx,
            images: ctx.images.map((i) => (i.id === id ? { ...i, description } : i)),
          })),
        })),

      linkAdventure: (adventureId) =>
        set((s) => {
          if (!s.adventures.some((a) => a.id === adventureId)) return s
          return {
            documents: patchActiveDocContext(s, (ctx) =>
              ctx.linkedAdventureIds.includes(adventureId)
                ? ctx
                : { ...ctx, linkedAdventureIds: [...ctx.linkedAdventureIds, adventureId] }
            ),
          }
        }),
      unlinkAdventure: (adventureId) =>
        set((s) => ({
          documents: patchActiveDocContext(s, (ctx) => ({
            ...ctx,
            linkedAdventureIds: ctx.linkedAdventureIds.filter((id) => id !== adventureId),
          })),
        })),
      getActiveDocumentContext: () => {
        const doc = get().getActiveDocument()
        return doc?.context ?? emptyDocumentContext()
      },

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
      setAdventureThumbnail: (id, thumbnail) =>
        set((s) => ({
          adventures: s.adventures.map((a) => (a.id === id ? { ...a, thumbnail } : a)),
        })),
      setActiveAdventureId: (id) =>
        set((s) => (s.adventures.some((a) => a.id === id) ? { activeAdventureId: id } : s)),
      setLiveSourceContext: (text) => set({ liveSourceContext: text }),

      setDocumentContent: (content) =>
        set((s) => ({
          documents: patchActiveDoc(s, (d) => ({
            ...d,
            tabs: d.tabs.map((t) => (t.id === d.activeTabId ? { ...t, content } : t)),
          })),
        })),
      setDocumentTitle: (title) =>
        set((s) => ({
          documents: patchActiveDoc(s, (d) => ({ ...d, title })),
        })),
      createDocument: (title) => {
        const doc = makeDocument(title ?? 'Untitled')
        set((s) => ({ documents: [doc, ...s.documents], activeDocumentId: doc.id }))
        return doc.id
      },
      deleteDocument: (id) =>
        set((s) => {
          const documents = s.documents.filter((d) => d.id !== id)
          if (documents.length === s.documents.length) return s
          const activeDocumentId =
            s.activeDocumentId === id ? documents[0]?.id ?? null : s.activeDocumentId
          return { documents, activeDocumentId }
        }),
      setActiveDocumentId: (id) =>
        set((s) => (s.documents.some((d) => d.id === id) ? { activeDocumentId: id } : s)),
      getActiveDocument: () => {
        const s = get()
        return s.documents.find((d) => d.id === s.activeDocumentId) ?? s.documents[0] ?? null
      },
      addDocTab: (name) => {
        const tab: DocTab = { id: nanoid(), name: name ?? '', content: '' }
        set((s) => ({
          documents: patchActiveDoc(s, (d) => ({
            ...d,
            tabs: [...d.tabs, { ...tab, name: tab.name || `Tab ${d.tabs.length + 1}` }],
            activeTabId: tab.id,
          })),
        }))
        return tab.id
      },
      deleteDocTab: (tabId) =>
        set((s) => ({
          documents: patchActiveDoc(s, (d) => {
            if (d.tabs.length <= 1) return d
            const tabs = d.tabs.filter((t) => t.id !== tabId)
            return {
              ...d,
              tabs,
              activeTabId: d.activeTabId === tabId ? tabs[0].id : d.activeTabId,
            }
          }),
        })),
      renameDocTab: (tabId, name) =>
        set((s) => ({
          documents: patchActiveDoc(s, (d) => ({
            ...d,
            tabs: d.tabs.map((t) => (t.id === tabId ? { ...t, name: name || t.name } : t)),
          })),
        })),
      setActiveDocTab: (tabId) =>
        set((s) => ({
          documents: patchActiveDoc(s, (d) =>
            d.tabs.some((t) => t.id === tabId) ? { ...d, activeTabId: tabId } : d
          ),
        })),
      getActiveTab: () => {
        const s = get()
        const doc = s.documents.find((d) => d.id === s.activeDocumentId) ?? s.documents[0]
        if (!doc) return null
        return doc.tabs.find((t) => t.id === doc.activeTabId) ?? doc.tabs[0] ?? null
      },
      updateActiveTabChat: (updates) =>
        set((s) => ({
          documents: patchActiveDoc(s, (d) => ({
            ...d,
            tabs: d.tabs.map((t) =>
              t.id === d.activeTabId
                ? {
                    ...t,
                    chatThreads: updates.chatThreads ?? t.chatThreads,
                    activeChatThreadId:
                      updates.activeChatThreadId !== undefined
                        ? updates.activeChatThreadId
                        : t.activeChatThreadId,
                  }
                : t
            ),
          })),
        })),
      setWritingPrompt: (prompt) => set({ writingPrompt: prompt }),
      setHighlightedText: (text) => set({ highlightedText: text }),
      setStyleRules: (rules) => set({ styleRules: rules }),

      reinforceStyleRules: (ruleIds) =>
        set((s) => {
          const valid = ruleIds.filter((id) => s.styleRules.some((r) => r.id === id))
          if (valid.length === 0) return s

          const spill = spreadActivation(s.styleRules, s.styleConnections, valid)
          const gains = new Map<string, number>()
          for (const id of valid) gains.set(id, DIRECT_GAIN)
          for (const sp of spill) gains.set(sp.id, (gains.get(sp.id) ?? 0) + sp.amount)

          const now = Date.now()
          const styleRules = s.styleRules.map((r) => {
            const gain = gains.get(r.id)
            if (!gain) return r
            return {
              ...r,
              weight: r.weight + gain,
              useCount: valid.includes(r.id) ? r.useCount + 1 : r.useCount,
              lastActivatedAt: now,
            }
          })

          // Fire together, wire together: every directly co-reinforced pair.
          const pairs: [string, string][] = []
          for (let i = 0; i < valid.length; i++)
            for (let j = i + 1; j < valid.length; j++) pairs.push([valid[i], valid[j]])

          return {
            styleRules,
            styleConnections: pairs.length
              ? bumpHebbian(s.styleConnections, pairs)
              : s.styleConnections,
            lastStyleActivation: {
              directIds: valid,
              spill: spill.map((sp) => ({ from: sp.from, id: sp.id, amount: sp.amount })),
              newRuleIds: [],
              at: now,
            },
          }
        }),

      addStyleRule: ({ label, instruction, relatedRuleIds = [], source = 'ai' }) => {
        const id = nanoid()
        set((s) => {
          const now = Date.now()
          const newRule: StyleRule = {
            id,
            label,
            instruction,
            enabled: true,
            weight: 1 + DIRECT_GAIN, // born from feedback, so it starts reinforced
            useCount: 1,
            lastActivatedAt: now,
            createdAt: now,
            source,
          }
          // Wire the newborn neuron: explicit relations plus organic similarity.
          const related = new Set(
            relatedRuleIds.filter((rid) => s.styleRules.some((r) => r.id === rid))
          )
          for (const r of s.styleRules) {
            if (ruleSimilarity(newRule, r) >= 0.18) related.add(r.id)
          }
          const pairs: [string, string][] = [...related].map((rid) => [id, rid])

          return {
            styleRules: [...s.styleRules, newRule],
            styleConnections: pairs.length
              ? bumpHebbian(s.styleConnections, pairs)
              : s.styleConnections,
            lastStyleActivation: {
              directIds: [id],
              spill: [],
              newRuleIds: [id],
              at: now,
            },
          }
        })
        return id
      },

      importStyleRules: (items) => {
        if (items.length === 0) return []
        const ids: string[] = []
        set((s) => {
          const existingKeys = new Set(
            s.styleRules.map((r) => `${r.label.toLowerCase().trim()}|${r.instruction.toLowerCase().trim()}`)
          )
          const toAdd = items.filter((item) => {
            const key = `${item.label.toLowerCase().trim()}|${item.instruction.toLowerCase().trim()}`
            if (existingKeys.has(key)) return false
            existingKeys.add(key)
            return true
          })
          if (toAdd.length === 0) return s

          const now = Date.now()
          const born: StyleRule[] = []
          const pairs: [string, string][] = []

          for (const item of toAdd) {
            const id = nanoid()
            ids.push(id)
            const rule: StyleRule = {
              id,
              label: item.label,
              instruction: item.instruction,
              enabled: true,
              weight: 1.4,
              useCount: 1,
              lastActivatedAt: now,
              createdAt: now,
              source: 'ai',
            }
            born.push(rule)
            const pool = [...s.styleRules, ...born.slice(0, -1)]
            for (const other of pool) {
              if (other.id === id) continue
              if (ruleSimilarity(rule, other) >= 0.18) pairs.push([id, other.id])
            }
          }

          return {
            styleRules: [...s.styleRules, ...born],
            styleConnections: pairs.length
              ? bumpHebbian(s.styleConnections, pairs)
              : s.styleConnections,
            lastStyleActivation: {
              directIds: ids,
              spill: [],
              newRuleIds: ids,
              at: now,
            },
          }
        })
        return ids
      },

      editStyleRule: (id, patch) =>
        set((s) => ({
          styleRules: s.styleRules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
        })),

      deleteStyleRule: (id) =>
        set((s) => ({
          styleRules: s.styleRules.filter((r) => r.id !== id),
          styleConnections: s.styleConnections.filter((c) => c.a !== id && c.b !== id),
        })),

      setStyleRulePosition: (id, x, y) =>
        set((s) => ({
          styleRules: s.styleRules.map((r) => (r.id === id ? { ...r, x, y } : r)),
        })),

      clearStyleActivation: () => set({ lastStyleActivation: null }),

      setRubric: (rubric) => set({ rubric }),
      setGradeResult: (result) => set({ gradeResult: result }),
      setIsGrading: (v) => set({ isGrading: v }),

      getFullContext: () => {
        const s = get()
        const parts: string[] = []
        const ctx = s.getActiveDocumentContext()
        const doc = s.getActiveDocument()

        if (doc) {
          parts.push(`=== ACTIVE DOCUMENT: ${doc.title} ===`)
        }

        if (ctx.pdfs.length > 0) {
          parts.push('=== CONTEXT PDFs ===')
          ctx.pdfs.forEach((pdf) => {
            parts.push(`[${pdf.name}]`)
            if (pdf.summary) parts.push(`Summary: ${pdf.summary}`)
            parts.push(pdf.text.slice(0, 3000))
          })
        }

        if (ctx.images.length > 0) {
          parts.push('=== REFERENCE IMAGES ===')
          ctx.images.forEach((img) => {
            parts.push(`[${img.name}]: ${img.description || 'Visual reference image attached to this document'}`)
          })
        }

        const linkedAdventures = ctx.linkedAdventureIds
          .map((id) => s.adventures.find((a) => a.id === id))
          .filter((a): a is Adventure => a != null)
          .filter((a) => a.nodes.some((n) => n.data.response) || a.takeaways.length > 0)

        if (linkedAdventures.length > 0) {
          parts.push('=== LINKED EXPLORATION ADVENTURES ===')
          linkedAdventures.forEach((adventure) => {
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
      version: 8,
      // Hydration is deferred to the auth layer so we load the *correct* user's
      // data once their identity is known (see AuthProvider).
      skipHydration: true,
      storage: createJSONStorage(() => workspaceStorage),
      migrate: (persisted, version) => {
        const state = persisted as Record<string, unknown>
        if (version < 8 && Array.isArray(state.documents)) {
          const docs = state.documents as Record<string, unknown>[]
          state.documents = docs.filter((d) => !isBlankDocument(d as WritingDocument))
          const activeId = state.activeDocumentId as string | null | undefined
          if (
            activeId &&
            !(state.documents as Record<string, unknown>[]).some((d) => d.id === activeId)
          ) {
            state.activeDocumentId =
              ((state.documents as Record<string, unknown>[])[0]?.id as string | undefined) ?? null
          }
        }
        if (version < 7 && Array.isArray(state.documents)) {
          state.documents = (state.documents as Record<string, unknown>[]).map((d) => {
            const tabs = d.tabs as DocTab[] | undefined
            if (!Array.isArray(tabs)) return d
            return {
              ...d,
              tabs: tabs.map((t) => ({
                ...t,
                chatThreads: t.chatThreads ?? [],
                activeChatThreadId: t.activeChatThreadId ?? null,
              })),
            }
          })
        }
        if (version < 6) {
          const legacyPdfs = (state.pdfs as PDFDocument[]) ?? []
          const legacyImages = (state.images as ImageDocument[]) ?? []
          const legacySessions = (state.sessions as TranscriptSession[]) ?? []
          const activeId = state.activeDocumentId as string | undefined

          if (Array.isArray(state.documents)) {
            state.documents = (state.documents as Record<string, unknown>[]).map((d, index) => {
              const docId = d.id as string
              const isTarget = activeId ? docId === activeId : index === 0
              const existing = d.context as DocumentContext | undefined
              const context: DocumentContext = existing ?? emptyDocumentContext()

              if (!existing && isTarget) {
                context.pdfs = legacyPdfs
                context.images = legacyImages
                if (legacySessions.length > 0) {
                  context.conversations = legacySessions.map((sess) => ({
                    id: nanoid(),
                    name: `Stream · ${new Date(sess.createdAt).toLocaleDateString()}`,
                    transcript: sess.transcript,
                    questions: sess.questions.length > 0 ? [...sess.questions] : undefined,
                    source: 'stream' as const,
                    sourceSessionId: sess.id,
                    uploadedAt: sess.createdAt,
                  }))
                }
              }

              return { ...d, context }
            })
          }

          delete state.pdfs
          delete state.images
        }
        if (version < 5 && Array.isArray(state.documents)) {
          // Flat documents → documents with Google-Docs-style tabs.
          state.documents = (state.documents as Record<string, unknown>[]).map((d) => {
            if (Array.isArray(d.tabs) && d.tabs.length > 0) return d
            const tab: DocTab = {
              id: nanoid(),
              name: 'Tab 1',
              content: typeof d.content === 'string' ? d.content : '',
            }
            const { content: _content, ...rest } = d
            return { ...rest, tabs: [tab], activeTabId: tab.id }
          })
        }
        if (version < 4) {
          // Single document → multi-document workspace.
          const legacyContent = typeof state.documentContent === 'string' ? state.documentContent : ''
          const legacyTitle = typeof state.documentTitle === 'string' ? state.documentTitle : 'Untitled'
          const doc = makeDocument(legacyTitle, legacyContent)
          state.documents = [doc]
          state.activeDocumentId = doc.id
          delete state.documentContent
          delete state.documentTitle
        }
        if (version < 3) {
          const legacyRules = (state.styleRules as (Partial<StyleRule> & { id: string })[]) ?? []
          state.styleRules = legacyRules.length
            ? legacyRules.map(migrateStyleRule)
            : DEFAULT_STYLE_RULES
          state.styleConnections = []
        }
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
        sessions: s.sessions,
        documents: s.documents,
        activeDocumentId: s.activeDocumentId,
        styleRules: s.styleRules,
        styleConnections: s.styleConnections,
        rubric: s.rubric,
        adventures: s.adventures,
        activeAdventureId: s.activeAdventureId,
      }),
    }
  )
)

/**
 * A usable key exists if the user supplied one OR the backend holds its own.
 * The frontend never needs the actual key value — when apiKey is empty the
 * server falls back to its server-side ANTHROPIC_API_KEY.
 */
export function hasUsableKey(): boolean {
  const s = useStore.getState()
  return !!s.apiKey || s.serverHasKey
}

/** Reactive variant for components. */
export const useHasApiKey = () => useStore((s) => !!s.apiKey || s.serverHasKey)

// Dev-only handle for inspecting/driving the store from the console.
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__odinStore = useStore
}

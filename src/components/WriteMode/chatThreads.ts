import { nanoid } from 'nanoid'

export interface AgentActivityStep {
  id: string
  text: string
  status: 'running' | 'done'
}

export interface WriteChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  suggestionId?: string
  kind?: 'style' | 'agent'
  /** Cursor-style step list shown while the agent works. */
  activity?: AgentActivityStep[]
  editsApplied?: number
}

export interface WriteChatThread {
  id: string
  label: string
  /** Passage-scoped threads carry the attached text; document threads omit this. */
  passage?: string
  passageFrom?: number
  passageTo?: number
  messages: WriteChatMessage[]
  createdAt: number
  updatedAt: number
}

export function createChatThread(existingThreads: WriteChatThread[]): WriteChatThread {
  const now = Date.now()
  const n = existingThreads.length + 1
  return {
    id: nanoid(),
    label: n === 1 ? 'Chat' : `Chat ${n}`,
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function ensureTabChatState(tab: {
  chatThreads?: WriteChatThread[]
  activeChatThreadId?: string | null
} | null): {
  threads: WriteChatThread[]
  activeId: string
} {
  const threads = tab?.chatThreads?.length ? tab.chatThreads : [createChatThread([])]
  const activeId =
    tab?.activeChatThreadId && threads.some((t) => t.id === tab.activeChatThreadId)
      ? tab.activeChatThreadId
      : threads[0].id
  return { threads, activeId }
}

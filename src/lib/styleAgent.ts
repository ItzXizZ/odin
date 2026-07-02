/**
 * Style network agent.
 *
 * After every Write Mode exchange, the same Claude that wrote the edits gets a
 * follow-up turn with tools to maintain the Stylism network. It only acts when
 * the writer's message contains STYLISTIC feedback (how the prose should
 * sound), never for content/substance instructions. Conflicts with existing
 * rules are surfaced conversationally: the agent explains the clash and asks
 * whether to edit, narrow, or delete the rule, and the writer's next message
 * resolves it.
 */

import type { StyleRule } from './style'
import { authHeader } from './supabase'

export interface ChatToolMessage {
  role: 'user' | 'assistant'
  content: string
}

export type StyleAgentAction =
  | { type: 'reinforce'; ruleIds: string[]; reason: string }
  | { type: 'create'; label: string; instruction: string; relatedRuleIds: string[] }
  | { type: 'conflict'; ruleId: string; explanation: string }
  | { type: 'edit'; ruleId: string; label?: string; instruction?: string }
  | { type: 'delete'; ruleId: string }
  | { type: 'none'; reason: string }

export interface StyleAgentResult {
  /** Conversational text from the agent (conflict questions, confirmations). */
  text: string
  actions: StyleAgentAction[]
}

const STYLE_AGENT_TOOLS = [
  {
    name: 'reinforce_rules',
    description:
      'Reinforce existing style rules because the writer\'s stylistic feedback restates, references, or aligns with them. The referenced neurons grow and excite their neighbors. Only call this when the feedback is genuinely stylistic.',
    input_schema: {
      type: 'object',
      properties: {
        rule_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of the existing rules this feedback reinforces.',
        },
        reason: {
          type: 'string',
          description: 'One short sentence: how the feedback maps to these rules.',
        },
      },
      required: ['rule_ids', 'reason'],
    },
  },
  {
    name: 'create_style_rule',
    description:
      'Create a new style rule when the writer expresses a stylistic preference that no existing rule covers and that does not contradict any existing rule. Write the instruction as a durable, reusable directive (imperative voice), not a one-off request.',
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short name for the rule (2-5 words).' },
        instruction: {
          type: 'string',
          description: 'The full directive the writing model must follow, phrased generally.',
        },
        related_rule_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of existing rules most related in meaning (0-3), used to wire the new neuron into the network.',
        },
      },
      required: ['label', 'instruction'],
    },
  },
  {
    name: 'flag_rule_conflict',
    description:
      'Use when the writer\'s stylistic feedback CONTRADICTS an existing rule. Do not silently edit or delete. Flag the rule, then in your text response explicitly tell the writer which rule it counters and ask whether the rule should be edited, made more specific, or deleted.',
    input_schema: {
      type: 'object',
      properties: {
        rule_id: { type: 'string', description: 'ID of the conflicting existing rule.' },
        explanation: {
          type: 'string',
          description: 'Plain description of the contradiction.',
        },
      },
      required: ['rule_id', 'explanation'],
    },
  },
  {
    name: 'edit_style_rule',
    description:
      'Rewrite an existing rule. Only use this after the writer has confirmed how a conflicted rule should change (e.g. narrowed to a specific case), or when they explicitly ask to modify a rule.',
    input_schema: {
      type: 'object',
      properties: {
        rule_id: { type: 'string' },
        new_label: { type: 'string', description: 'Updated short name (optional).' },
        new_instruction: { type: 'string', description: 'The updated directive.' },
      },
      required: ['rule_id', 'new_instruction'],
    },
  },
  {
    name: 'delete_style_rule',
    description:
      'Remove a rule from the network. Only use after the writer has confirmed deletion, or when they explicitly ask to remove a rule.',
    input_schema: {
      type: 'object',
      properties: {
        rule_id: { type: 'string' },
      },
      required: ['rule_id'],
    },
  },
  {
    name: 'no_style_action',
    description:
      'Use when the writer\'s message contains no stylistic feedback (it is about content, structure, facts, research, or anything other than how the prose should sound). The style network must not change.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why no network update is warranted.' },
      },
      required: ['reason'],
    },
  },
]

function formatRules(rules: StyleRule[]): string {
  const sorted = [...rules].sort((a, b) => b.weight - a.weight)
  return sorted
    .map(
      (r) =>
        `- id: ${r.id}\n  label: ${r.label}\n  enabled: ${r.enabled}\n  weight: ${r.weight.toFixed(2)} (reinforced ${r.useCount}x)\n  instruction: ${r.instruction}`
    )
    .join('\n')
}

function buildAgentSystem(rules: StyleRule[]): string {
  return `You are the curator of a writer's STYLE NETWORK inside a writing tool. The network is a living graph of style rules (neurons). Rules grow stronger when the writer reinforces them and the strongest rules dominate how the writing AI sounds.

Your ONLY job in this turn: decide whether the writer's latest message contains STYLISTIC feedback, and update the network with the tools provided.

WHAT COUNTS AS STYLISTIC FEEDBACK — feedback about HOW the prose should sound or read:
- tone, voice, register, formality ("make it sound like a high schooler", "less stiff")
- diction and vocabulary ("stop using fancy words", "no semicolons")
- rhythm, sentence length, punctuation habits
- structural voice habits ("don't end with a question", "stop hedging")
- complaints that the AI's writing sounds artificial or violates a preference

WHAT IS NOT STYLISTIC — never touch the network for:
- content instructions ("add a paragraph about X", "make the argument stronger")
- factual corrections, research requests, length/scope changes ("shorten this")
- formatting mechanics unrelated to voice ("use bullet points here")
- general approval or thanks with no stylistic substance

DECISION PROCEDURE (follow in order):
1. Not stylistic → call no_style_action. Nothing else.
2. Stylistic and CONTRADICTS an existing rule → call flag_rule_conflict for that rule. In your text response, explicitly name the rule it counters, quote its instruction, and ask the writer whether the rule should be edited, made more specific, or deleted. Do NOT edit or delete yet.
3. Stylistic and matches existing rule(s) → call reinforce_rules with every rule the feedback references or restates (be inclusive; partial overlap counts).
4. Stylistic and genuinely new → call create_style_rule, and also call reinforce_rules for any partially-related rules.
You may combine reinforce_rules with create_style_rule in one turn. Multiple rules reinforced together wire together, so include all that apply.

CURRENT STYLE NETWORK (sorted by weight, strongest first):
${formatRules(rules)}

Text response rules: one sentence only, plain prose, no bullet lists, no em dashes, no bold. Only produce text when you flagged a conflict (one sentence naming the conflict, asking edit/narrow/delete) or created a rule (one sentence saying what you'll do differently). For pure reinforcement or no action, return no text.`
}

function buildResolutionSystem(rules: StyleRule[], conflictRuleId: string): string {
  const rule = rules.find((r) => r.id === conflictRuleId)
  return `You are the curator of a writer's STYLE NETWORK inside a writing tool.

You previously flagged that the writer's stylistic feedback conflicts with this existing rule:
- id: ${conflictRuleId}
- label: ${rule?.label ?? 'unknown'}
- instruction: ${rule?.instruction ?? 'unknown'}

You asked the writer whether the rule should be edited, made more specific, or deleted. Their reply follows.

DECISION PROCEDURE:
1. If they want the rule changed or narrowed → call edit_style_rule with the rewritten instruction reflecting their wishes. If their new preference deserves its own rule too, also call create_style_rule.
2. If they want it removed → call delete_style_rule, and call create_style_rule if their new preference should replace it.
3. If they want to keep the rule as is → call reinforce_rules for it.
4. If their reply is unrelated to the conflict (it is a new writing instruction instead) → call no_style_action with reason "writer moved on"; the conflict is dropped.

CURRENT STYLE NETWORK:
${formatRules(rules)}

Reply with one sentence confirming what you did. No lists, no em dashes. If their reply was ambiguous, ask one short clarifying question instead of acting.`
}

interface ToolUseBlock {
  type: 'tool_use'
  name: string
  input: Record<string, unknown>
}

interface TextBlock {
  type: 'text'
  text: string
}

type ContentBlock = ToolUseBlock | TextBlock | { type: string }

function parseActions(blocks: ContentBlock[]): StyleAgentAction[] {
  const actions: StyleAgentAction[] = []
  for (const block of blocks) {
    if (block.type !== 'tool_use') continue
    const { name, input } = block as ToolUseBlock
    const inp = input ?? {}
    switch (name) {
      case 'reinforce_rules':
        actions.push({
          type: 'reinforce',
          ruleIds: Array.isArray(inp.rule_ids) ? (inp.rule_ids as string[]) : [],
          reason: String(inp.reason ?? ''),
        })
        break
      case 'create_style_rule':
        actions.push({
          type: 'create',
          label: String(inp.label ?? 'New rule'),
          instruction: String(inp.instruction ?? ''),
          relatedRuleIds: Array.isArray(inp.related_rule_ids)
            ? (inp.related_rule_ids as string[])
            : [],
        })
        break
      case 'flag_rule_conflict':
        actions.push({
          type: 'conflict',
          ruleId: String(inp.rule_id ?? ''),
          explanation: String(inp.explanation ?? ''),
        })
        break
      case 'edit_style_rule':
        actions.push({
          type: 'edit',
          ruleId: String(inp.rule_id ?? ''),
          label: typeof inp.new_label === 'string' ? inp.new_label : undefined,
          instruction: typeof inp.new_instruction === 'string' ? inp.new_instruction : undefined,
        })
        break
      case 'delete_style_rule':
        actions.push({ type: 'delete', ruleId: String(inp.rule_id ?? '') })
        break
      case 'no_style_action':
        actions.push({ type: 'none', reason: String(inp.reason ?? '') })
        break
    }
  }
  return actions
}

async function callToolEndpoint(
  messages: ChatToolMessage[],
  system: string,
  apiKey: string
): Promise<StyleAgentResult> {
  const res = await fetch('/api/chat/tools', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ messages, system, apiKey, tools: STYLE_AGENT_TOOLS, maxTokens: 1024 }),
    signal: AbortSignal.timeout(45000),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Style agent request failed' }))
    throw new Error(err.error || 'Style agent request failed')
  }

  const data = await res.json()
  const blocks: ContentBlock[] = Array.isArray(data.content) ? data.content : []
  const text = blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n')

  return { text, actions: parseActions(blocks) }
}

/**
 * Run the network-update turn after a Write Mode exchange. `recentChat` gives
 * the agent enough context to tell stylistic feedback from content direction.
 */
export async function runStyleAgentTurn(opts: {
  apiKey: string
  rules: StyleRule[]
  instruction: string
  recentChat: ChatToolMessage[]
}): Promise<StyleAgentResult> {
  const { apiKey, rules, instruction, recentChat } = opts

  const transcript = recentChat
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'WRITER' : 'ASSISTANT'}: ${m.content.slice(0, 400)}`)
    .join('\n')

  const user = `Recent conversation in the writing assistant:
${transcript || '(no prior messages)'}

WRITER'S LATEST MESSAGE:
"""
${instruction.slice(0, 1500)}
"""

Decide whether this contains stylistic feedback and update the style network with your tools.`

  return callToolEndpoint([{ role: 'user', content: user }], buildAgentSystem(rules), apiKey)
}

/** Run the follow-up turn that resolves a previously flagged rule conflict. */
export async function runConflictResolutionTurn(opts: {
  apiKey: string
  rules: StyleRule[]
  conflictRuleId: string
  conflictQuestion: string
  reply: string
}): Promise<StyleAgentResult> {
  const { apiKey, rules, conflictRuleId, conflictQuestion, reply } = opts

  const messages: ChatToolMessage[] = [
    { role: 'assistant', content: conflictQuestion },
    { role: 'user', content: reply.slice(0, 1500) },
  ]

  return callToolEndpoint(messages, buildResolutionSystem(rules, conflictRuleId), apiKey)
}

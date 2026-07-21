/**
 * Odin Math — the tutoring "session" model.
 *
 * A session is the structured, labeled sequence that makes the dataset a moat:
 * every problem attempt is decomposed into (problem → attempt → intervention →
 * response → outcome), and every tutor intervention is tagged with exactly one
 * of five scientifically-grounded HINT TYPES. Logging each of these as a typed
 * event is what turns raw tutoring into per-student longitudinal training data.
 */

/** The five categorical hint types (grounded in intelligent-tutoring theory). */
export type HintTypeId =
  | 'orienting'
  | 'conceptual'
  | 'strategic'
  | 'procedural'
  | 'corrective'

export interface HintType {
  id: HintTypeId
  /** Human label. */
  name: string
  /** One-line scientific definition (what cognitive gap it targets). */
  def: string
  /**
   * Position on the assistance / fading ladder (1 = least directive).
   * `corrective` is contextual (fired on a detected error), so it has no fixed
   * rung — marked 0.
   */
  level: number
  /** Muted accent used for the trace chip (no purple — glass palette). */
  color: string
}

/**
 * Ordered least → most directive. This ordering is the escalation ladder: a
 * session starts at `orienting` and fades toward `procedural` only as the
 * student stays stuck, so support is titrated to need rather than dumped.
 * `corrective` is orthogonal — the tutor jumps to it the moment it detects a
 * concrete error, regardless of the current rung.
 */
export const HINT_TYPES: HintType[] = [
  {
    id: 'orienting',
    name: 'Orienting',
    def: 'Redirects attention to the salient given or structure the student overlooked.',
    level: 1,
    color: '#0d9488',
  },
  {
    id: 'conceptual',
    name: 'Conceptual',
    def: 'Surfaces the governing principle, definition, or theorem the step requires.',
    level: 2,
    color: '#2563eb',
  },
  {
    id: 'strategic',
    name: 'Strategic',
    def: 'Proposes a solution plan or heuristic (work backward, exploit symmetry, count the complement).',
    level: 3,
    color: '#b45309',
  },
  {
    id: 'procedural',
    name: 'Procedural',
    def: 'Specifies the concrete next operation to execute.',
    level: 4,
    color: '#475569',
  },
  {
    id: 'corrective',
    name: 'Corrective',
    def: 'Localizes and diagnoses the first error in the student’s work.',
    level: 0,
    color: '#dc2626',
  },
]

export const HINT_TYPE_MAP: Record<HintTypeId, HintType> = HINT_TYPES.reduce(
  (acc, t) => ((acc[t.id] = t), acc),
  {} as Record<HintTypeId, HintType>
)

/** The escalation ladder used when a student stays stuck after a hint. */
export const LADDER: HintTypeId[] = ['orienting', 'conceptual', 'strategic', 'procedural']

export function ladderTypeForLevel(level: number): HintTypeId {
  return LADDER[Math.min(Math.max(level, 1), LADDER.length) - 1]
}

export function isHintTypeId(x: unknown): x is HintTypeId {
  return typeof x === 'string' && x in HINT_TYPE_MAP
}

/** The phases of one problem attempt — the "process" the tutor walks through. */
export type SessionPhase =
  | 'awaiting_problem' // nothing pasted/drawn yet
  | 'working' // student is attempting; tutor is watching for "stuck"
  | 'stuck_prompt' // tutor detected a stall and is asking consent to help
  | 'hinting' // a typed hint is being generated / read
  | 'awaiting_response' // hint delivered; did it click?
  | 'resolved' // outcome recorded (solved / not solved)

export type TraceKind =
  | 'problem'
  | 'attempt'
  | 'stuck'
  | 'intervention'
  | 'response'
  | 'outcome'

/** One labeled row in the session sequence. */
export interface TraceEvent {
  id: string
  t: number
  kind: TraceKind
  label: string
  /** For interventions: which of the five categories was used. */
  hintType?: HintTypeId
  /** For interventions: rung on the fading ladder. */
  level?: number
  /** For responses: did the hint click for the student? */
  clicked?: boolean
  /** For outcomes: was the problem solved? */
  solved?: boolean
  detail?: string
}

export const PHASE_LABEL: Record<SessionPhase, string> = {
  awaiting_problem: 'Waiting for a problem',
  working: 'Watching you work',
  stuck_prompt: 'Noticed you paused',
  hinting: 'Thinking of a hint',
  awaiting_response: 'Did that help?',
  resolved: 'Session complete',
}

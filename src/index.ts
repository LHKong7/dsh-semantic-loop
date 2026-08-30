/** Event-sourced semantic checkpoints and a verified completion tool. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import {
  CHECKPOINT_TOOL,
  FINISH_TOOL,
  PLUGIN,
  STATE_TOOL,
  currentTurnObservedCallIds,
  latestEnvironmentResultSeq,
  latestTurnStartSeq,
  successfulEnvironmentCallIds,
} from './protocol.ts'
import { semanticCompletionStatusInTurn } from './projection.ts'
import {
  renderSemanticCheckpoint,
  renderSemanticCheckpointReceipt,
  resolveSemanticCheckpoint,
  semanticEvidenceCallIds,
  semanticStatePositionOf,
  semanticStateOf,
} from './state.ts'
import type { SemanticCheckpointInput } from './state.ts'
import type { SemanticState } from './types.ts'

export type * from './types.ts'
export {
  decodeSemanticCheckpointSource,
  foldSemanticState,
  foldSemanticStates,
  foldSemanticStatePosition,
  isSemanticCheckpointMessage,
  renderSemanticCheckpoint,
  renderSemanticCheckpointReceipt,
  resolveSemanticCheckpoint,
  semanticEvidenceCallIds,
  semanticStateOf,
} from './state.ts'
export {
  semanticCompletionInTurn,
  semanticEvidenceOf,
  semanticTelemetryOf,
} from './projection.ts'

/** Cordis plugin name. */
export const name = 'semantic-loop'
/** Services required by the semantic-loop consumer. */
export const inject = ['agents', 'tools', 'systemPrompt']

const DEFAULT_MAX_REPAIR_STEPS = 3
const DEFAULT_MAX_CHECKPOINT_BYTES = 65_536

/** Runtime policy for refusal-to-follow-protocol repair. */
export interface Config {
  /** Maximum consecutive stopping-boundary repairs without a new checkpoint revision. */
  readonly maxRepairSteps?: number
  /** Maximum UTF-8 size of the canonical checkpoint and its model-visible rendering. */
  readonly maxCheckpointBytes?: number
  /** Require a ready checkpoint to cite at least one successful environment-tool result from the current turn. */
  readonly requireToolEvidence?: boolean
}

/** Loader schema for the experimental semantic loop. */
export const Config: z<Config> = z.object({
  maxRepairSteps: z.number().step(1).min(1).default(DEFAULT_MAX_REPAIR_STEPS),
  maxCheckpointBytes: z.number().step(1).min(1).default(DEFAULT_MAX_CHECKPOINT_BYTES),
  requireToolEvidence: z.boolean().default(false),
})

/** Fully materialized plugin configuration. */
interface ResolvedConfig {
  readonly maxRepairSteps: number
  readonly maxCheckpointBytes: number
  readonly requireToolEvidence: boolean
}

/** One stopping-boundary repair streak. */
interface RepairState {
  readonly turn: number
  readonly revision: number
  readonly count: number
}

/** Validate config when apply is called without Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const maxRepairSteps = config.maxRepairSteps ?? DEFAULT_MAX_REPAIR_STEPS
  if (!Number.isSafeInteger(maxRepairSteps) || maxRepairSteps < 1) {
    throw new TypeError('maxRepairSteps must be a positive safe integer')
  }
  const maxCheckpointBytes = config.maxCheckpointBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES
  if (!Number.isSafeInteger(maxCheckpointBytes) || maxCheckpointBytes < 1) {
    throw new TypeError('maxCheckpointBytes must be a positive safe integer')
  }
  const requireToolEvidence = config.requireToolEvidence ?? false
  if (typeof requireToolEvidence !== 'boolean') {
    throw new TypeError('requireToolEvidence must be a boolean')
  }
  return { maxRepairSteps, maxCheckpointBytes, requireToolEvidence }
}

/** Require a live calling agent for session-owned semantic state. */
function callingAgent(agent: Agent | undefined, tool: string): Agent {
  if (agent === undefined) throw new Error(`${tool} requires an owning agent session`)
  return agent
}

/** Compact JSON Schema shared by semantic tool results. */
const CHECKPOINT_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    revision: { type: 'integer', required: true },
    status: { type: 'string', required: true, enum: ['exploring', 'ready'] },
    openGaps: { type: 'integer', required: true },
    unmetCriteria: { type: 'integer', required: true },
    evidenceToolResults: { type: 'integer', required: true },
    observedToolResults: { type: 'integer', required: true },
  },
} as const

const FINISH_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    revision: { type: 'integer', required: true },
    answer: { type: 'string', required: true },
  },
} as const

const STATE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    revision: { type: 'integer', required: true },
    status: { type: 'string', required: true, enum: ['exploring', 'ready'] },
    snapshot: { type: 'string', required: true },
  },
} as const

/** Generic pending presentation for semantic controls. */
function present(title: string, rawInput: unknown): GenericCallView {
  return { card: 'generic', title, kind: 'other', rawInput }
}

/** Corrective instruction for the current gate state. */
function repairText(state: SemanticState | undefined): string {
  if (state === undefined) {
    return `Semantic completion is not initialized. Call ${CHECKPOINT_TOOL} with the objective, explicit completion criteria, current evidence, open gaps, and next action before attempting to finish.`
  }
  if (state.checkpoint.status === 'ready') {
    return `Semantic state r${state.revision} is ready. Submit the final answer through ${FINISH_TOOL}; ordinary assistant text does not satisfy the completion protocol.`
  }
  const unmet = state.checkpoint.criteria.filter(item => item.status === 'unmet').map(item => item.id)
  const gaps = state.checkpoint.gaps.map(item => item.id)
  const blockers = [
    ...unmet.length === 0 ? [] : [`unmet criteria: ${unmet.join(', ')}`],
    ...gaps.length === 0 ? [] : [`open gaps: ${gaps.join(', ')}`],
  ]
  return `Semantic state r${state.revision} is still exploring${blockers.length === 0 ? '' : ` (${blockers.join('; ')})`}. Continue the next action, then replace the whole state with ${CHECKPOINT_TOOL}.`
}

/** Model policy for the semantic checkpoint protocol. */
const POLICY = `This session uses the semantic agent loop. Maintain a concise semantic state of externally checkable commitments, not hidden chain-of-thought.

Before acting in each user turn, call semantic_checkpoint to refresh the objective, explicit completion criteria, evidence-backed facts, open gaps, and next action. Use expected_revision 0 only before the first checkpoint in the session. A new user turn does not reset the revision; otherwise use the exact current revision shown in the latest semantic receipt. After every material observation, replace the whole checkpoint. A met criterion and every retained fact require concise evidence. For each criterion or fact supported by tools, cite the relevant successful environment-tool call ids in evidence_call_ids. The checkpoint separately records every successful environment-tool result observed in the current turn. A ready checkpoint must have at least one criterion, every criterion met, and no open gaps. The checkpoint call already contains the complete state, so its following context is only a compact receipt. Call semantic_state only when resume or compaction has hidden the latest complete checkpoint; do not read it after every update.

Before semantic_finish succeeds, emit tool calls without accompanying ordinary assistant narration. Do not give the final answer before the completion gate. When and only when the current-turn checkpoint is ready, call semantic_finish with its exact revision and the complete final answer. After that tool accepts the answer, do not call another tool; return the approved answer verbatim as the next and final ordinary assistant text.`

/**
 * Register the semantic protocol, tools, and stopping-boundary repair.
 *
 * @param ctx Cordis context that owns the plugin effects.
 * @param config Repair policy for the completion gate.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const repairs = new Map<Agent, RepairState>()

  ctx.systemPrompt.section({
    name: 'tool:semantic-loop',
    order: 115,
    text: POLICY,
  })

  ctx.tools.register(defineTool({
    name: CHECKPOINT_TOOL,
    description: 'Replace the complete event-sourced semantic state. Use expected_revision 0 only when the session has no checkpoint; revisions persist across user turns.',
    parameters: {
      expected_revision: { type: 'integer', required: true, description: '0 only when the session has no checkpoint; otherwise the exact current revision, including after a new user turn.' },
      objective: { type: 'string', required: true, description: 'Concrete objective currently being solved.' },
      criteria: {
        type: 'array',
        required: true,
        description: 'Explicit completion conditions. met requires evidence; unmet requires empty evidence. Cite supporting successful environment-tool calls by id.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Stable lower-kebab-case id.' },
            description: { type: 'string', required: true },
            status: { type: 'string', required: true, enum: ['unmet', 'met'] },
            evidence: { type: 'string', required: true, description: 'Concise evidence when met; empty when unmet.' },
            evidence_call_ids: {
              type: 'array',
              required: true,
              description: 'Successful environment-tool call ids supporting this criterion.',
              items: { type: 'string' },
            },
          },
        },
      },
      facts: {
        type: 'array',
        required: true,
        description: 'Only facts supported by a material observation.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Stable lower-kebab-case id.' },
            statement: { type: 'string', required: true },
            evidence: { type: 'string', required: true, description: 'Tool output, query result, or file location.' },
            evidence_call_ids: {
              type: 'array',
              required: true,
              description: 'Successful environment-tool call ids supporting this fact.',
              items: { type: 'string' },
            },
          },
        },
      },
      gaps: {
        type: 'array',
        required: true,
        description: 'Unresolved questions or missing verification.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Stable lower-kebab-case id.' },
            description: { type: 'string', required: true },
          },
        },
      },
      next_action: { type: 'string', required: true, description: 'One concrete next action selected from this state.' },
      status: { type: 'string', required: true, enum: ['exploring', 'ready'] },
    },
    output: {
      schema: CHECKPOINT_RESULT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `Semantic checkpoint r${value.revision}: ${value.status}; ${value.openGaps} open gaps; ${value.unmetCriteria} unmet criteria; ${value.evidenceToolResults} cited and ${value.observedToolResults} observed environment-tool results.`,
      }],
    },
    execute(args, exec) {
      const agent = callingAgent(exec.agent, CHECKPOINT_TOOL)
      const current = semanticStateOf(agent)
      const expected = current?.revision ?? 0
      if (args.expected_revision !== expected) {
        throw new Error(`semantic checkpoint stale revision: expected ${expected}, got ${args.expected_revision}`)
      }
      const input: SemanticCheckpointInput = {
        objective: args.objective,
        criteria: args.criteria.map(criterion => ({
          id: criterion.id,
          description: criterion.description,
          status: criterion.status,
          evidence: criterion.evidence,
          evidenceCallIds: criterion.evidence_call_ids,
        })),
        facts: args.facts.map(fact => ({
          id: fact.id,
          statement: fact.statement,
          evidence: fact.evidence,
          evidenceCallIds: fact.evidence_call_ids,
        })),
        gaps: args.gaps,
        nextAction: args.next_action,
        status: args.status,
      }
      const observedCallIds = currentTurnObservedCallIds(agent.session.events)
      const availableCallIds = successfulEnvironmentCallIds(agent.session.events)
      const checkpoint = resolveSemanticCheckpoint(input, observedCallIds, availableCallIds)
      const evidenceCallIds = semanticEvidenceCallIds(checkpoint)
      if (resolved.requireToolEvidence && checkpoint.status === 'ready'
        && !evidenceCallIds.some(callId => observedCallIds.includes(callId))) {
        throw new Error('ready semantic checkpoint requires a current-turn environment-tool result linked to a criterion or fact')
      }
      const state = { revision: expected + 1, checkpoint }
      const rendered = renderSemanticCheckpoint(state)
      const serializedBytes = Buffer.byteLength(JSON.stringify(checkpoint), 'utf8')
      const renderedBytes = Buffer.byteLength(rendered, 'utf8')
      const checkpointBytes = Math.max(serializedBytes, renderedBytes)
      if (checkpointBytes > resolved.maxCheckpointBytes) {
        throw new Error(`semantic checkpoint exceeds maxCheckpointBytes: ${checkpointBytes} > ${resolved.maxCheckpointBytes}`)
      }
      exec.deferContext(createUserMessage({
        source: {
          kind: 'semantic-checkpoint',
          version: 4,
          sessionId: agent.id,
          checkpointCallId: exec.callId,
          revision: state.revision,
          checkpoint,
        },
        content: [{ type: 'text', text: renderSemanticCheckpointReceipt(state) }],
      }))
      return Promise.resolve({
        revision: state.revision,
        status: checkpoint.status,
        openGaps: checkpoint.gaps.length,
        unmetCriteria: checkpoint.criteria.filter(criterion => criterion.status === 'unmet').length,
        evidenceToolResults: evidenceCallIds.length,
        observedToolResults: checkpoint.observedCallIds.length,
      })
    },
    presentCall: args => present('Update semantic state', args),
  }))

  ctx.tools.register(defineTool({
    name: STATE_TOOL,
    description: 'Read the latest complete semantic checkpoint after resume or compaction has hidden its original checkpoint call. Do not call after every update.',
    parameters: {},
    output: {
      schema: STATE_RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.snapshot }],
    },
    execute(_args, exec) {
      const agent = callingAgent(exec.agent, STATE_TOOL)
      const state = semanticStateOf(agent)
      if (state === undefined) throw new Error('semantic state is not initialized')
      return Promise.resolve({
        revision: state.revision,
        status: state.checkpoint.status,
        snapshot: renderSemanticCheckpoint(state),
      })
    },
    presentCall: args => present('Read semantic state', args),
  }))

  ctx.tools.register(defineTool({
    name: FINISH_TOOL,
    description: 'Approve the complete final answer at the exact latest ready semantic checkpoint revision. The next assistant message must return the approved answer verbatim.',
    parameters: {
      expected_revision: { type: 'integer', required: true, description: 'Exact latest ready checkpoint revision.' },
      answer: { type: 'string', required: true, description: 'Complete final answer returned to the caller.' },
    },
    output: {
      schema: FINISH_RESULT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `Semantic completion accepted at revision ${value.revision}. Return this approved answer verbatim as the final assistant message:\n\n${value.answer}`,
      }],
    },
    execute(args, exec) {
      const agent = callingAgent(exec.agent, FINISH_TOOL)
      const position = semanticStatePositionOf(agent)
      const current = position?.state
      if (position === undefined || current === undefined) throw new Error('semantic completion requires an initialized checkpoint')
      const turnStartSeq = latestTurnStartSeq(agent.session.events)
      if (turnStartSeq !== undefined && position.checkpointCallSeq <= turnStartSeq) {
        throw new Error('semantic completion requires a checkpoint created in the current turn')
      }
      const environmentResultSeq = latestEnvironmentResultSeq(agent.session.events)
      if (environmentResultSeq !== undefined && position.checkpointCallSeq <= environmentResultSeq) {
        throw new Error('semantic completion requires a checkpoint created after the latest environment-tool result')
      }
      if (args.expected_revision !== current.revision) {
        throw new Error(`semantic completion stale revision: expected ${current.revision}, got ${args.expected_revision}`)
      }
      if (current.checkpoint.status !== 'ready') {
        throw new Error(`semantic completion requires ready state; revision ${current.revision} is exploring`)
      }
      const answer = args.answer.trim()
      if (answer.length === 0) throw new Error('semantic completion answer must be non-empty')
      return Promise.resolve({ revision: current.revision, answer })
    },
    presentCall: args => present('Submit semantic answer', args.answer),
  }))

  ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: AgentStatus }) => {
    if (status === 'idle') repairs.delete(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => { repairs.delete(agent) })
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const state = semanticStateOf(agent)
    const completion = semanticCompletionStatusInTurn(agent, turn)
    if (completion.kind === 'complete') {
      repairs.delete(agent)
      return
    }
    const revision = state?.revision ?? 0
    const prior = repairs.get(agent)
    const count = prior?.turn === turn && prior.revision === revision ? prior.count + 1 : 1
    if (count > resolved.maxRepairSteps) {
      throw new Error(`semantic completion protocol did not progress after ${resolved.maxRepairSteps} repair steps at revision ${revision}`)
    }
    repairs.set(agent, { turn, revision, count })
    let text: string
    if (completion.kind === 'unapproved') {
      text = repairText(state)
    } else if (completion.reason === 'mismatched-final-answer' || completion.reason === 'missing-final-answer') {
      text = `Semantic completion approved an answer, but the next ordinary assistant message did not match it. Return the following answer verbatim and do not call another tool:\n\n${completion.approval.answer}`
    } else {
      text = `Tool or checkpoint activity after semantic_finish invalidated its approval. Re-establish a ready checkpoint after the latest observation, call ${FINISH_TOOL} again with the exact revision, then return that answer verbatim without another tool call.`
    }
    agent.steer(createUserMessage({
      source: { kind: 'plugin', plugin: PLUGIN, form: 'notice', summary: 'Semantic completion gate requires another step.' },
      content: [{ type: 'text', text }],
    }))
  })
}

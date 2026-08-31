/** Event-sourced semantic checkpoints and a verified completion tool. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { assertSemanticArtifactTransition } from './artifacts.ts'
import {
  missingSemanticCapabilities,
  requiredSemanticCapabilities,
  resolveConfiguredCapabilities,
  resolveSemanticCapabilities,
} from './capabilities.ts'
import { assertSemanticTransition } from './plan.ts'
import { semanticProgressOf, semanticProgressTimeline } from './progress.ts'
import {
  CAPABILITIES_TOOL,
  CHECKPOINT_TOOL,
  FINISH_TOOL,
  PLUGIN,
  STATE_TOOL,
  VERIFY_TOOL,
  currentTurnObservedCallIds,
  latestEnvironmentResultSeq,
  latestTurnStartSeq,
  successfulEnvironmentCallIds,
} from './protocol.ts'
import { semanticCompletionStatusInTurn, semanticEvidenceOf } from './projection.ts'
import {
  renderSemanticCheckpoint,
  renderSemanticCheckpointReceipt,
  resolveSemanticCheckpoint,
  semanticEvidenceCallIds,
  foldSemanticStateHistory,
  semanticStatePositionOf,
  semanticStateOf,
} from './state.ts'
import type { SemanticCheckpointInput } from './state.ts'
import type { SemanticCapability, SemanticState, SemanticVerificationReceipt } from './types.ts'
import {
  renderSemanticVerificationReceipt,
  semanticCheckpointHash,
  semanticVerificationOf,
  semanticVerificationPositionOf,
  verifySemanticCheckpoint,
} from './verification.ts'

export type * from './types.ts'
export {
  assertSemanticArtifacts,
  assertSemanticArtifactTransition,
  semanticArtifactKey,
  semanticArtifactStatus,
  semanticCurrentArtifact,
} from './artifacts.ts'
export {
  missingSemanticCapabilities,
  requiredSemanticCapabilities,
  resolveConfiguredCapabilities,
  resolveSemanticCapabilities,
} from './capabilities.ts'
export { assertSemanticGoal, assertSemanticPlan, assertSemanticTransition } from './plan.ts'
export { semanticMaterialChanges, semanticProgressOf, semanticProgressTimeline } from './progress.ts'
export {
  decodeSemanticCheckpointSource,
  foldSemanticState,
  foldSemanticStateHistory,
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
export {
  builtinSemanticVerification,
  decodeSemanticVerificationSource,
  foldSemanticVerificationPosition,
  isSemanticVerificationMessage,
  renderSemanticVerificationReceipt,
  semanticCheckpointHash,
  semanticVerificationMessages,
  semanticVerificationOf,
  semanticVerificationPositionOf,
  semanticVerificationVerdict,
  verifySemanticCheckpoint,
} from './verification.ts'

/** Cordis plugin name. */
export const name = 'semantic-loop'
/** Services required by the semantic-loop consumer. */
export const inject = ['agents', 'tools', 'systemPrompt']

const DEFAULT_MAX_REPAIR_STEPS = 3
const DEFAULT_MAX_CHECKPOINT_BYTES = 65_536
const DEFAULT_MAX_STAGNANT_REVISIONS = 3

/** Runtime policy for refusal-to-follow-protocol repair. */
export interface Config {
  /** Maximum consecutive stopping-boundary repairs without a new checkpoint revision. */
  readonly maxRepairSteps?: number
  /** Maximum UTF-8 size of the canonical checkpoint and its model-visible rendering. */
  readonly maxCheckpointBytes?: number
  /** Maximum consecutive accepted checkpoint revisions without material semantic progress. */
  readonly maxStagnantRevisions?: number
  /** Require a ready checkpoint to cite at least one successful environment-tool result from the current turn. */
  readonly requireToolEvidence?: boolean
  /** Deployment-declared semantic capabilities available to this preset. */
  readonly capabilities?: readonly SemanticCapability[]
}

/** Loader schema for the experimental semantic loop. */
export const Config: z<Config> = z.object({
  maxRepairSteps: z.number().step(1).min(1).default(DEFAULT_MAX_REPAIR_STEPS),
  maxCheckpointBytes: z.number().step(1).min(1).default(DEFAULT_MAX_CHECKPOINT_BYTES),
  maxStagnantRevisions: z.number().step(1).min(0).default(DEFAULT_MAX_STAGNANT_REVISIONS),
  requireToolEvidence: z.boolean().default(false),
  capabilities: z.array(z.object({
    id: z.string(),
    description: z.string(),
  })).default([]),
})

/** Fully materialized plugin configuration. */
interface ResolvedConfig {
  readonly maxRepairSteps: number
  readonly maxCheckpointBytes: number
  readonly maxStagnantRevisions: number
  readonly requireToolEvidence: boolean
  readonly capabilities: readonly SemanticCapability[]
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
  const maxStagnantRevisions = config.maxStagnantRevisions ?? DEFAULT_MAX_STAGNANT_REVISIONS
  if (!Number.isSafeInteger(maxStagnantRevisions) || maxStagnantRevisions < 0) {
    throw new TypeError('maxStagnantRevisions must be a non-negative safe integer')
  }
  const requireToolEvidence = config.requireToolEvidence ?? false
  if (typeof requireToolEvidence !== 'boolean') {
    throw new TypeError('requireToolEvidence must be a boolean')
  }
  const capabilities = resolveConfiguredCapabilities(config.capabilities ?? [])
  return { maxRepairSteps, maxCheckpointBytes, maxStagnantRevisions, requireToolEvidence, capabilities }
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
    materialProgress: { type: 'boolean', required: true },
    progressSignals: { type: 'integer', required: true },
    stagnantRevisions: { type: 'integer', required: true },
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

const CAPABILITIES_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    providers: { type: 'integer', required: true },
    available: { type: 'array', required: true, items: { type: 'string' } },
    required: { type: 'array', required: true, items: { type: 'string' } },
    missing: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const VERIFY_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    revision: { type: 'integer', required: true },
    checkpointHash: { type: 'string', required: true },
    verdict: { type: 'string', required: true, enum: ['passed', 'failed', 'unknown'] },
    verifierReports: { type: 'integer', required: true },
    requiredChecks: { type: 'integer', required: true },
    provedRequiredChecks: { type: 'integer', required: true },
  },
} as const

/** Generic pending presentation for semantic controls. */
function present(title: string, rawInput: unknown): GenericCallView {
  return { card: 'generic', title, kind: 'other', rawInput }
}

/** Corrective instruction for the current gate state. */
function repairText(
  state: SemanticState | undefined,
  verification: SemanticVerificationReceipt | undefined,
): string {
  if (state === undefined) {
    return `Semantic completion is not initialized. Call ${CHECKPOINT_TOOL} with the objective, explicit completion criteria, current evidence, open gaps, and next action before attempting to finish.`
  }
  if (state.checkpoint.status === 'ready') {
    const hash = semanticCheckpointHash(state.checkpoint)
    if (verification === undefined || verification.revision !== state.revision
      || verification.checkpointHash !== hash || verification.verdict !== 'passed') {
      return `Semantic state r${state.revision} is ready but lacks a current passing verification receipt. Call ${VERIFY_TOOL} with expected_revision ${state.revision}; revise the checkpoint if a required check is violated or unknown.`
    }
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

Before acting in each user turn, call semantic_checkpoint to refresh the stable goal contract, global plan graph, append-only versioned semantic artifacts, explicit completion criteria, evidence-backed facts, open gaps, active plan node, and next action. Goal ids and definitions remain immutable within one goal version. Completion-criterion ids and descriptions also remain stable. A changed plan graph increments plan.revision and states a new concrete change_reason; a new goal id increments goal.version and starts plan revision 1 without inherited artifacts. Keep semantic operations independent of concrete tools and declare their required capabilities, input artifact ids, and output artifact id. Call semantic_capabilities before relying on a declared capability and after runtime composition may have changed. A missing capability is a plan gap: acquire a provider, choose a supported operation, or ask for help instead of substituting an unverified regex or ad-hoc pipeline. Preserve every committed artifact version and append replacements with the next version. Derived artifacts cite exact input versions; a changed plan or newer upstream version makes dependent artifacts stale. Use locators and content digests instead of copying large payloads into summaries. Use expected_revision 0 only before the first checkpoint in the session. A new user turn does not reset the revision; otherwise use the exact current revision shown in the latest semantic receipt. After every material observation, replace the whole checkpoint. A met criterion and every retained fact require concise evidence. For each criterion, fact, or artifact supported by tools, cite the relevant successful environment-tool call ids in evidence_call_ids. The checkpoint separately records every successful environment-tool result observed in the current turn. Tool-call count, a changed next_action, or active-node movement alone is not material progress. Repeated no-progress revisions are bounded; revise the plan, append or correct an artifact, meet a criterion, close a gap, or request a missing capability. A ready checkpoint must have at least one criterion, every criterion met, no open gaps, no active plan node, and a current artifact for every required plan node. The checkpoint call already contains the complete state, so its following context is only a compact receipt. Call semantic_state only when resume or compaction has hidden the latest complete checkpoint; do not read it after every update.

Before semantic_finish succeeds, emit tool calls without accompanying ordinary assistant narration. Do not give the final answer before the completion gate. When the current-turn checkpoint is ready, call semantic_verify with its exact revision. Verification obligations come from the runtime and registered providers, not from agent-authored criteria. If any required check is violated or unknown, use its detail or counterexample to revise the plan, artifacts, or checkpoint and verify again. When and only when the exact latest ready revision has a passing receipt, call semantic_finish with that revision and the complete final answer. After that tool accepts the answer, do not call another tool; return the approved answer verbatim as the next and final ordinary assistant text.`

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
    description: 'Replace the complete event-sourced semantic state, including its stable goal contract and global plan graph. Use expected_revision 0 only when the session has no checkpoint.',
    parameters: {
      expected_revision: { type: 'integer', required: true, description: '0 only when the session has no checkpoint; otherwise the exact current revision, including after a new user turn.' },
      goal: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'Stable task contract. Keep it byte-for-byte equivalent while goal.id is unchanged.',
        properties: {
          id: { type: 'string', required: true, description: 'Stable lower-kebab-case task id.' },
          version: { type: 'integer', required: true, description: '1 initially; increment only when replacing the task with a new goal id.' },
          statement: { type: 'string', required: true, description: 'Concrete task statement.' },
          constraints: { type: 'array', required: true, items: { type: 'string' }, description: 'Task, user, and policy constraints preserved by every plan revision.' },
        },
      },
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
      plan: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'Versioned directed acyclic graph of semantic operations that preserves global execution intent.',
        properties: {
          revision: { type: 'integer', required: true, description: '1 initially; increment exactly once whenever the node graph changes.' },
          change_reason: { type: 'string', required: true, description: '"initial-plan" at revision 1; otherwise a new concrete reason for replacing the graph.' },
          nodes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: 'Stable lower-kebab-case node id.' },
                operation: { type: 'string', required: true, description: 'Domain-neutral semantic operation, not a concrete tool name.' },
                description: { type: 'string', required: true, description: 'Contribution this node makes to the goal.' },
                depends_on: { type: 'array', required: true, items: { type: 'string' }, description: 'Plan node ids that must complete first.' },
                input_artifact_ids: { type: 'array', required: true, items: { type: 'string' }, description: 'Stable artifact ids consumed in this exact order.' },
                output_artifact_id: { type: 'string', required: true, description: 'Stable artifact id materialized by this node.' },
                required_capabilities: { type: 'array', required: true, items: { type: 'string' }, description: 'Semantic capabilities needed for a reliable implementation.' },
                required: { type: 'boolean', required: true, description: 'Whether completion requires a current output artifact from this node.' },
              },
            },
          },
        },
      },
      active_node_id: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        required: true,
        description: 'Plan node selected for next_action, or null when no node is active.',
      },
      artifacts: {
        type: 'array',
        required: true,
        description: 'Append-only immutable intermediate results. Keep payloads external and retain only semantic metadata and lineage.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Stable lower-kebab-case artifact id.' },
            version: { type: 'integer', required: true, description: 'Positive contiguous version within this artifact id.' },
            kind: { type: 'string', required: true, description: 'Domain-neutral semantic content kind.' },
            summary: { type: 'string', required: true, description: 'Concise meaning, not the complete payload.' },
            locator: { type: 'string', required: true, description: 'Opaque location used to recover the complete payload on demand.' },
            content_digest: { type: 'string', required: true, description: 'Stable content identity supplied by the materializer.' },
            producer_node_id: {
              oneOf: [{ type: 'string' }, { type: 'null' }],
              required: true,
              description: 'Producing plan node, or null for an external source artifact.',
            },
            plan_revision: { type: 'integer', required: true, description: 'Producer plan revision, or 0 for an external source artifact.' },
            inputs: {
              type: 'array',
              required: true,
              description: 'Exact immutable artifact versions consumed by the producer.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  version: { type: 'integer', required: true },
                },
              },
            },
            evidence_call_ids: {
              type: 'array',
              required: true,
              description: 'Successful environment-tool calls that materialized or observed this artifact.',
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
        text: `Semantic checkpoint r${value.revision}: ${value.status}; ${value.openGaps} open gaps; ${value.unmetCriteria} unmet criteria; ${value.evidenceToolResults} cited and ${value.observedToolResults} observed environment-tool results; ${value.progressSignals} material progress signals; stagnation streak ${value.stagnantRevisions}.`,
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
        goal: args.goal,
        criteria: args.criteria.map(criterion => ({
          id: criterion.id,
          description: criterion.description,
          status: criterion.status,
          evidence: criterion.evidence,
          evidenceCallIds: criterion.evidence_call_ids,
        })),
        plan: {
          revision: args.plan.revision,
          changeReason: args.plan.change_reason,
          nodes: args.plan.nodes.map(node => ({
            id: node.id,
            operation: node.operation,
            description: node.description,
            dependsOn: node.depends_on,
            inputArtifactIds: node.input_artifact_ids,
            outputArtifactId: node.output_artifact_id,
            requiredCapabilities: node.required_capabilities,
            required: node.required,
          })),
        },
        activeNodeId: args.active_node_id,
        artifacts: args.artifacts.map(artifact => ({
          id: artifact.id,
          version: artifact.version,
          kind: artifact.kind,
          summary: artifact.summary,
          locator: artifact.locator,
          contentDigest: artifact.content_digest,
          producerNodeId: artifact.producer_node_id,
          planRevision: artifact.plan_revision,
          inputs: artifact.inputs,
          evidenceCallIds: artifact.evidence_call_ids,
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
      assertSemanticTransition(current?.checkpoint, checkpoint)
      assertSemanticArtifactTransition(current?.checkpoint, checkpoint)
      const evidenceCallIds = semanticEvidenceCallIds(checkpoint)
      if (resolved.requireToolEvidence && checkpoint.status === 'ready'
        && !evidenceCallIds.some(callId => observedCallIds.includes(callId))) {
        throw new Error('ready semantic checkpoint requires a current-turn environment-tool result linked to a criterion, fact, or artifact')
      }
      const state = { revision: expected + 1, checkpoint }
      const history = foldSemanticStateHistory(agent.session.events, agent.id)
      const progress = semanticProgressTimeline([...history, state]).at(-1)
      if (progress === undefined) throw new Error('semantic progress projection did not include the candidate checkpoint')
      if (progress.stagnantRevisions > resolved.maxStagnantRevisions) {
        throw new Error(`semantic checkpoint exceeds maxStagnantRevisions: ${progress.stagnantRevisions} > ${resolved.maxStagnantRevisions}; revise the plan, append or correct an artifact, meet a criterion, close a gap, link new evidence, or request a missing capability`)
      }
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
          version: 6,
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
        materialProgress: progress.materialChanges.length > 0,
        progressSignals: progress.materialChanges.length,
        stagnantRevisions: progress.stagnantRevisions,
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
      const progress = semanticProgressOf(agent)
      const progressText = progress === undefined
        ? 'unavailable'
        : `${progress.materialChanges.length === 0 ? 'none' : progress.materialChanges.join(', ')}; stagnation streak ${progress.stagnantRevisions}`
      return Promise.resolve({
        revision: state.revision,
        status: state.checkpoint.status,
        snapshot: `${renderSemanticCheckpoint(state)}\n\nMaterial progress at r${state.revision}: ${progressText}`,
      })
    },
    presentCall: args => present('Read semantic state', args),
  }))

  ctx.tools.register(defineTool({
    name: CAPABILITIES_TOOL,
    description: 'Inspect trusted semantic capabilities available to this Agent and compare them with the current global plan. Missing capability ids are execution gaps, not permission to substitute an ad-hoc implementation.',
    parameters: {},
    output: {
      schema: CAPABILITIES_RESULT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `Semantic capabilities from ${value.providers} providers. Available: ${value.available.length === 0 ? '(none declared)' : value.available.join(', ')}. Required by current plan: ${value.required.length === 0 ? '(none)' : value.required.join(', ')}. Missing: ${value.missing.length === 0 ? '(none)' : value.missing.join(', ')}.`,
      }],
    },
    async execute(_args, exec) {
      const agent = callingAgent(exec.agent, CAPABILITIES_TOOL)
      const inventory = await resolveSemanticCapabilities(ctx, agent, resolved.capabilities)
      const checkpoint = semanticStateOf(agent)?.checkpoint
      const required = checkpoint === undefined ? [] : requiredSemanticCapabilities(checkpoint)
      const missing = checkpoint === undefined ? [] : missingSemanticCapabilities(checkpoint, inventory)
      return {
        providers: inventory.reports.length,
        available: inventory.available.map(capability => capability.id),
        required,
        missing,
      }
    },
    presentCall: args => present('Inspect semantic capabilities', args),
  }))

  ctx.tools.register(defineTool({
    name: VERIFY_TOOL,
    description: 'Run independent runtime and registered verifier obligations against the exact latest ready checkpoint. The verifier, not the agent, authors the durable receipt.',
    parameters: {
      expected_revision: { type: 'integer', required: true, description: 'Exact latest ready checkpoint revision.' },
    },
    output: {
      schema: VERIFY_RESULT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `Semantic verification ${value.verdict} for r${value.revision}: ${value.provedRequiredChecks}/${value.requiredChecks} required checks proved across ${value.verifierReports} reports (checkpoint ${value.checkpointHash}).`,
      }],
    },
    async execute(args, exec) {
      const agent = callingAgent(exec.agent, VERIFY_TOOL)
      const position = semanticStatePositionOf(agent)
      const current = position?.state
      if (position === undefined || current === undefined) throw new Error('semantic verification requires an initialized checkpoint')
      const turnStartSeq = latestTurnStartSeq(agent.session.events)
      if (turnStartSeq !== undefined && position.checkpointCallSeq <= turnStartSeq) {
        throw new Error('semantic verification requires a checkpoint created in the current turn')
      }
      const environmentResultSeq = latestEnvironmentResultSeq(agent.session.events)
      if (environmentResultSeq !== undefined && position.checkpointCallSeq <= environmentResultSeq) {
        throw new Error('semantic verification requires a checkpoint created after the latest environment-tool result')
      }
      if (args.expected_revision !== current.revision) {
        throw new Error(`semantic verification stale revision: expected ${current.revision}, got ${args.expected_revision}`)
      }
      if (current.checkpoint.status !== 'ready') {
        throw new Error(`semantic verification requires ready state; revision ${current.revision} is exploring`)
      }
      const receipt = await verifySemanticCheckpoint(
        ctx,
        agent,
        current.revision,
        current.checkpoint,
        semanticEvidenceOf(agent),
        await resolveSemanticCapabilities(ctx, agent, resolved.capabilities),
      )
      exec.deferContext(createUserMessage({
        source: {
          kind: 'semantic-verification',
          version: 1,
          sessionId: agent.id,
          verificationCallId: exec.callId,
          receipt,
        },
        content: [{ type: 'text', text: renderSemanticVerificationReceipt(receipt) }],
      }))
      const requiredChecks = receipt.reports.flatMap(report => report.checks).filter(check => check.required)
      return {
        revision: receipt.revision,
        checkpointHash: receipt.checkpointHash,
        verdict: receipt.verdict,
        verifierReports: receipt.reports.length,
        requiredChecks: requiredChecks.length,
        provedRequiredChecks: requiredChecks.filter(check => check.status === 'proved').length,
      }
    },
    presentCall: args => present('Verify semantic state', args),
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
      const verification = semanticVerificationPositionOf(agent)
      const checkpointHash = semanticCheckpointHash(current.checkpoint)
      if (verification === undefined
        || verification.receipt.revision !== current.revision
        || verification.receipt.checkpointHash !== checkpointHash
        || verification.verificationCallSeq <= position.checkpointCallSeq) {
        throw new Error(`semantic completion requires a current verification receipt for revision ${current.revision}`)
      }
      if (verification.receipt.verdict !== 'passed') {
        throw new Error(`semantic completion requires passed verification; current verdict is ${verification.receipt.verdict}`)
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
      text = repairText(state, semanticVerificationOf(agent))
    } else if (completion.reason === 'unverified') {
      text = `semantic_finish had no current passing verification receipt. Re-establish a ready checkpoint if needed, call ${VERIFY_TOOL} with the exact revision, then call ${FINISH_TOOL} again only after verification passes.`
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

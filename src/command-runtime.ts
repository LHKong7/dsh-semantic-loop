/** Command-v2 tools, adaptive action policy, and proof-carrying completion. */

import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type CallId, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type {
  PostToolDecision,
  PreToolDecision,
  ToolExecutionResult,
  ToolExecutionToken,
} from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { assertSemanticArtifacts, assertSemanticArtifactTransition } from './artifacts.ts'
import {
  decideSemanticAuthorization,
  mergePreToolDecisions,
  nextActionLedgerDigest,
  semanticActionLedgerOf,
  semanticAuthorizationReceiptDigest,
  semanticSettlementReceiptDigest,
  renderSemanticAuthorizationReceipt,
  renderSemanticSettlementReceipt,
  type SemanticActionLedgerEntry,
  type SemanticActionLedgerProjection,
  type SemanticActionSettlementReceipt,
  type SemanticActionSettlementSourceV1,
  type SemanticAuthorizationReceipt,
  type SemanticAuthorizationReport,
  type SemanticAuthorizationSourceV1,
  type SemanticLedgerQueryHandle,
} from './authorization.ts'
import { describeSemanticAction, type SemanticAction } from './action.ts'
import {
  assertSemanticCandidate,
  renderSemanticCandidateReceipt,
  semanticCandidateDigest,
  semanticCandidateOf,
  type SemanticCandidate,
  type SemanticCandidateSourceV1,
} from './candidate.ts'
import { isSha256Digest, semanticDigest } from './canonical.ts'
import {
  assertUnverifiedCompletionAllowed,
  renderSemanticDegradationReceipt,
  semanticCompletionContentDigest,
  type SemanticDegradationSourceV1,
  type SemanticProtocolHealth,
} from './degradation.ts'
import { assertSemanticPlan } from './plan.ts'
import {
  BEGIN_TOOL,
  CANDIDATE_TOOL,
  CAPABILITIES_TOOL,
  FINISH_TOOL,
  PLUGIN,
  PROGRESS_TOOL,
  READY_TOOL,
  REPLAN_TOOL,
  STATE_TOOL,
  VERIFY_TOOL,
  isSemanticToolName,
  successfulEnvironmentCallIds,
} from './protocol.ts'
import { semanticEvidenceOf } from './projection.ts'
import { semanticStateOf } from './state.ts'
import {
  renderSemanticBaselineReceipt,
  renderSemanticRunReceipt,
  semanticBaselineDigest,
  semanticBaselineOf,
  semanticRunOf,
  semanticRunStateDigest,
  type SemanticRunDeltaSourceV1,
  type SemanticRunPosition,
  type SemanticRunSnapshot,
  type SemanticRunState,
  type SemanticTurnBaseline,
  type SemanticTurnBaselineSourceV1,
} from './run-state.ts'
import { SemanticRuntimeCache } from './runtime-cache.ts'
import {
  assertSemanticRequirement,
  assertSemanticSpecification,
  assertSemanticSpecificationTransition,
  semanticSpecDigest,
  type SemanticRequirement,
  type SemanticRequirementProposal,
  type SemanticSourceCoverage,
  type SemanticSpecification,
  type SemanticSpecificationReport,
  type SemanticSpecificationSourceV1,
} from './specification.ts'
import { renderSemanticSpecificationReceipt, semanticSpecificationOf } from './spec-projection.ts'
import type {
  SemanticArtifact,
  SemanticCapability,
  SemanticCriterion,
  SemanticFact,
  SemanticGap,
  SemanticPlan,
  SemanticPlanNode,
} from './types.ts'
import {
  missingSemanticCapabilities,
  requiredSemanticCapabilities,
  resolveSemanticCapabilities,
} from './capabilities.ts'
import {
  renderSemanticVerificationReceiptV2,
  semanticVerificationV2Of,
  verifySemanticCandidate,
  type SemanticVerificationRequestV2,
  type SemanticVerificationSourceV2,
} from './verification-v2.ts'

/** Fully validated v2 runtime configuration supplied by the package entrypoint. */
export interface CommandRuntimeConfig {
  readonly protocolMode: 'hybrid' | 'command-v2'
  readonly preActionGate: 'off' | 'observe' | 'adaptive' | 'enforce'
  readonly unknownActionPolicy: 'observe' | 'ask' | 'deny'
  readonly requireCurrentTurnBegin: boolean
  readonly formalPreflightMinRisk: 'medium' | 'high' | 'critical'
  readonly preflightFastPathBudgetMs: number
  readonly allowUnverifiedCompletion: boolean
  readonly maxAdaptiveCompletionRepairs: number
  readonly maxProtocolFailures: number
  readonly maxCommandBytes: number
  readonly progressUpdatePolicy: 'manual' | 'material-only' | 'every-action'
  readonly requireToolEvidence: boolean
  readonly capabilities: readonly SemanticCapability[]
}

interface ProtocolFailureState {
  readonly turn: number
  readonly count: number
  readonly lastError: string
}

interface RepairState {
  readonly turn: number
  readonly count: number
}

interface LiveLedger {
  entries: SemanticActionLedgerEntry[]
  digest: string
  health: SemanticActionLedgerProjection['health']
  pending: Set<string>
}

interface PendingPreflight {
  readonly agent: Agent
  readonly action: SemanticAction
  readonly baseline: SemanticTurnBaseline
  readonly localDecision: PreToolDecision
  readonly finalDecision: PreToolDecision
  readonly reports: readonly SemanticAuthorizationReport[]
  readonly receipt: SemanticAuthorizationReceipt
}

const RUN_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    revision: { type: 'integer', required: true },
    phase: { type: 'string', required: true, enum: ['exploring', 'ready', 'candidate'] },
    specDigest: { type: 'string', required: true },
    runStateDigest: { type: 'string', required: true },
  },
} as const

const STATE_RESULT_SCHEMA_V2 = {
  type: 'object', additionalProperties: false,
  properties: {
    revision: { type: 'integer', required: true },
    phase: { type: 'string', required: true },
    specDigest: { type: 'string', required: true },
    runStateDigest: { type: 'string', required: true },
    snapshot: { type: 'string', required: true },
  },
} as const

const CAPABILITIES_RESULT_SCHEMA_V2 = {
  type: 'object', additionalProperties: false,
  properties: {
    providers: { type: 'integer', required: true },
    available: { type: 'array', required: true, items: { type: 'string' } },
    required: { type: 'array', required: true, items: { type: 'string' } },
    missing: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const CANDIDATE_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    revision: { type: 'integer', required: true },
    candidateDigest: { type: 'string', required: true },
    runStateDigest: { type: 'string', required: true },
  },
} as const

const VERIFY_RESULT_SCHEMA_V2 = {
  type: 'object', additionalProperties: false,
  properties: {
    revision: { type: 'integer', required: true },
    candidateDigest: { type: 'string', required: true },
    verdict: { type: 'string', required: true, enum: ['passed', 'failed', 'unknown'] },
    requiredTotal: { type: 'integer', required: true },
    formallyProved: { type: 'integer', required: true },
    runtimeChecked: { type: 'integer', required: true },
    evidenceBacked: { type: 'integer', required: true },
    violated: { type: 'integer', required: true },
    unknown: { type: 'integer', required: true },
  },
} as const

const FINISH_RESULT_SCHEMA_V2 = {
  type: 'object', additionalProperties: false,
  properties: {
    revision: { type: 'integer', required: true },
    candidateDigest: { type: 'string', required: true },
    answer: { type: 'string', required: true },
  },
} as const

const REQUIREMENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    statement: { type: 'string', required: true },
    kind: { type: 'string', required: true, enum: ['hard-formal', 'grounded', 'soft-preference'] },
    phase: { type: 'string', required: true, enum: ['pre-action', 'post-action', 'final-candidate', 'always'] },
    required: { type: 'boolean', required: true },
    source_id: { type: 'string' },
    quote: { type: 'string' },
  },
} as const

const PLAN_NODE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    operation: { type: 'string', required: true },
    description: { type: 'string', required: true },
    depends_on: { type: 'array', required: true, items: { type: 'string' } },
    input_artifact_ids: { type: 'array', required: true, items: { type: 'string' } },
    output_artifact_id: { type: 'string', required: true },
    required_capabilities: { type: 'array', required: true, items: { type: 'string' } },
    required: { type: 'boolean', required: true },
  },
} as const

const ARTIFACT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    locator: { type: 'string', required: true },
    content_digest: { type: 'string', required: true },
    producer_node_id: { type: 'string' },
    input_versions: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          version: { type: 'integer', required: true },
        },
      },
    },
    evidence_call_ids: { type: 'array', items: { type: 'string' } },
  },
} as const

const FACT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    statement: { type: 'string', required: true },
    evidence: { type: 'string', required: true },
    evidence_call_ids: { type: 'array', items: { type: 'string' } },
  },
} as const

const GAP_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    description: { type: 'string', required: true },
  },
} as const

const POLICY = `This session uses the proof-carrying semantic loop. Treat semantic state as externally checkable commitments, not hidden reasoning.

Call semantic_begin early to bind the task, authority inputs, and plan. Ordinary typed reads and observations may run first in adaptive mode; strict mode requires begin before every environment tool. Use semantic_progress only for material facts, artifacts, criteria, or gaps, and semantic_replan only when the plan graph changes. Environment calls and their results are recorded by the runtime, so do not copy every call id into progress.

When the run is structurally complete, call semantic_ready without a nullable active node. Submit the exact answer or immutable artifact through semantic_candidate, then call semantic_verify. A failed or unknown obligation changes the candidate or gathers evidence; it never silently weakens the specification. Call semantic_finish only with the verified candidate digest. The final assistant message must reproduce the accepted candidate exactly. Protocol failures are bounded; adaptive mode may disclose an explicitly unverified result only when no required proof or unresolved safety state forbids it.`

const COMMAND_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

function commandText(value: string, label: string): void {
  if (value.length === 0 || value.trim() !== value) throw new Error(`${label} must be non-empty and already trimmed`)
}

function commandId(value: string, label: string): void {
  if (!COMMAND_ID.test(value)) throw new Error(`${label} must be lower-kebab-case`)
}

function present(title: string, rawInput: unknown): GenericCallView {
  return { card: 'generic', title, kind: 'other', rawInput }
}

function currentTurn(agent: Agent): number {
  const turn = agent.session.events.findLast(event => event.type === 'turn/start')?.data.turn
  if (turn === undefined) throw new Error('semantic protocol requires an open Session turn')
  return turn
}

function messageText(message: Message): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function sessionMessages(events: readonly SessionEvent[]): ReadonlyMap<string, UserMessage> {
  const messages = new Map<string, UserMessage>()
  for (const event of events) {
    if (event.type === 'user/message') messages.set(event.data.id, event.data)
    else if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data.inserted) messages.set(message.id, message)
    }
  }
  return messages
}

function commandBytes(args: unknown, config: CommandRuntimeConfig): void {
  const bytes = Buffer.byteLength(JSON.stringify(args), 'utf8')
  if (bytes > config.maxCommandBytes) {
    throw new Error(`semantic command exceeds maxCommandBytes: ${bytes} > ${config.maxCommandBytes}`)
  }
}

function planNodes(inputs: readonly {
  readonly id: string
  readonly operation: string
  readonly description: string
  readonly depends_on: readonly string[]
  readonly input_artifact_ids: readonly string[]
  readonly output_artifact_id: string
  readonly required_capabilities: readonly string[]
  readonly required: boolean
}[]): SemanticPlanNode[] {
  return inputs.map(node => ({
    id: node.id, operation: node.operation, description: node.description,
    dependsOn: [...node.depends_on], inputArtifactIds: [...node.input_artifact_ids],
    outputArtifactId: node.output_artifact_id,
    requiredCapabilities: [...node.required_capabilities], required: node.required,
  }))
}

function latestArtifactRefs(artifacts: readonly SemanticArtifact[]): readonly { readonly id: string; readonly version: number }[] {
  const latest = new Map<string, number>()
  for (const artifact of artifacts) latest.set(artifact.id, artifact.version)
  return [...latest].map(([id, version]) => ({ id, version }))
}

function checkpointFor(snapshot: Omit<SemanticRunSnapshot, 'state'>, phase: SemanticRunState['phase']) {
  const met = new Set(snapshot.criteria.map(criterion => criterion.id))
  return {
    goal: { id: 'command-run', version: 1, statement: 'Command-v2 run', constraints: [] },
    criteria: snapshot.criteria.map((criterion): SemanticCriterion => ({
      ...criterion, status: met.has(criterion.id) && snapshot.gaps.length === 0 ? 'met' : 'unmet',
      evidence: met.has(criterion.id) && snapshot.gaps.length === 0 ? 'recorded by semantic_progress' : '', evidenceCallIds: [],
    })),
    plan: snapshot.plan,
    activeNodeId: phase === 'ready' || phase === 'candidate' ? null : snapshot.plan.nodes[0]?.id ?? null,
    artifacts: snapshot.artifacts, facts: snapshot.facts, observedCallIds: [], gaps: snapshot.gaps,
    nextAction: snapshot.nextAction, status: phase === 'ready' || phase === 'candidate' ? 'ready' as const : 'exploring' as const,
  }
}

function makeRunSnapshot(input: {
  readonly agent: Agent
  readonly turn: number
  readonly revision: number
  readonly specDigest: string
  readonly phase: SemanticRunState['phase']
  readonly plan: SemanticPlan
  readonly criteria: SemanticRunSnapshot['criteria']
  readonly metCriterionIds: readonly string[]
  readonly artifacts: readonly SemanticArtifact[]
  readonly facts: readonly SemanticFact[]
  readonly gaps: readonly SemanticGap[]
  readonly nextAction: string
  readonly observationLedgerWatermark: string
  readonly activeNodeId?: string
}): SemanticRunSnapshot {
  commandText(input.nextAction, 'semantic run nextAction')
  const material = {
    specDigest: input.specDigest, phase: input.phase, plan: input.plan, criteria: input.criteria,
    metCriterionIds: input.metCriterionIds, artifacts: input.artifacts, facts: input.facts,
    gaps: input.gaps, nextAction: input.nextAction,
    ...(input.activeNodeId === undefined ? {} : { activeNodeId: input.activeNodeId }),
  }
  const state: SemanticRunState = {
    sessionId: input.agent.id, turn: input.turn, revision: input.revision,
    specDigest: input.specDigest, phase: input.phase, planRevision: input.plan.revision,
    ...(input.activeNodeId === undefined ? {} : { activeNodeId: input.activeNodeId }),
    metCriterionIds: [...input.metCriterionIds], openGapIds: input.gaps.map(gap => gap.id),
    currentArtifactRefs: latestArtifactRefs(input.artifacts),
    observationLedgerWatermark: input.observationLedgerWatermark,
    materialStateDigest: semanticDigest('material-state', 1, material),
  }
  return {
    state, plan: input.plan, criteria: [...input.criteria], artifacts: [...input.artifacts],
    facts: [...input.facts], gaps: [...input.gaps], nextAction: input.nextAction,
  }
}

function runContext(
  agent: Agent,
  callId: CallId,
  command: SemanticRunDeltaSourceV1['command'],
  snapshot: SemanticRunSnapshot,
): UserMessage {
  const source: SemanticRunDeltaSourceV1 = {
    kind: 'semantic-run-delta', version: 1, sessionId: agent.id,
    runCallId: callId, command, authoringCause: { kind: 'tool-call', callId },
    runStateDigest: semanticRunStateDigest(snapshot.state), snapshot,
  }
  return createUserMessage({ source, content: [{ type: 'text', text: renderSemanticRunReceipt(source) }] })
}

function baselineValue(
  agent: Agent,
  turn: number,
  inputMessageIds: readonly string[],
  config: CommandRuntimeConfig,
): SemanticTurnBaseline {
  const inheritedSpecDigest = semanticSpecificationOf(agent)?.specDigest
  const core: Omit<SemanticTurnBaseline, 'baselineDigest'> = {
    sessionId: agent.id, turn, inputMessageIds: [...inputMessageIds],
    ...(inheritedSpecDigest === undefined ? {} : { inheritedSpecDigest }),
    policySnapshotDigest: semanticDigest('policy-snapshot', 1, {
      preActionGate: config.preActionGate, unknownActionPolicy: config.unknownActionPolicy,
      requireCurrentTurnBegin: config.requireCurrentTurnBegin,
      allowUnverifiedCompletion: config.allowUnverifiedCompletion,
    }),
    enforcementProfile: config.preActionGate === 'enforce' ? 'strict' : 'adaptive',
    status: 'provisional',
  }
  return { ...core, baselineDigest: semanticBaselineDigest(core) }
}

function baselineContext(baseline: SemanticTurnBaseline): UserMessage {
  const source: SemanticTurnBaselineSourceV1 = {
    kind: 'semantic-baseline', version: 1, sessionId: baseline.sessionId, turn: baseline.turn,
    authoringCause: { kind: 'turn-start', inputMessageIds: [...baseline.inputMessageIds] }, baseline,
  }
  return createUserMessage({ source, content: [{ type: 'text', text: renderSemanticBaselineReceipt(source) }] })
}

function ensureBaseline(
  agent: Agent,
  turn: number,
  config: CommandRuntimeConfig,
): { readonly baseline: SemanticTurnBaseline; readonly context?: UserMessage } {
  const existing = semanticBaselineOf(agent, turn)
  if (existing !== undefined) return { baseline: existing }
  const startSeq = agent.session.events.findLast(event => event.type === 'turn/start' && event.data.turn === turn)?.seq ?? -1
  const inputIds = [...sessionMessages(agent.session.events.filter(event => event.seq > startSeq)).values()]
    .filter(message => message.source.kind === 'user').map(message => message.id)
  const baseline = baselineValue(agent, turn, inputIds, config)
  return { baseline, context: baselineContext(baseline) }
}

function proposalRequirement(
  proposal: SemanticRequirementProposal,
  baseline: SemanticTurnBaseline,
  messages: ReadonlyMap<string, UserMessage>,
): SemanticRequirement {
  let sources: SemanticRequirement['sources'] = []
  if (proposal.sourceId !== undefined || proposal.quote !== undefined) {
    if (proposal.sourceId === undefined || proposal.quote === undefined) {
      throw new Error(`semantic requirement proposal "${proposal.id}" must supply source_id and quote together`)
    }
    if (!baseline.inputMessageIds.includes(proposal.sourceId)) {
      throw new Error(`semantic requirement proposal "${proposal.id}" source is not an authority input in this turn`)
    }
    const message = messages.get(proposal.sourceId)
    if (message?.source.kind !== 'user') throw new Error(`semantic requirement proposal "${proposal.id}" source is not a direct user message`)
    const text = messageText(message)
    const start = text.indexOf(proposal.quote)
    if (start < 0) throw new Error(`semantic requirement proposal "${proposal.id}" quote does not match its user message`)
    sources = [{ authority: 'user', sourceId: proposal.sourceId, quote: proposal.quote, start, end: start + proposal.quote.length }]
  } else if (proposal.required) {
    throw new Error(`agent-authored semantic requirement "${proposal.id}" cannot be required`)
  } else {
    sources = [{ authority: 'agent', sourceId: `agent:${proposal.id}`, quote: proposal.statement }]
  }
  const requirement: SemanticRequirement = {
    id: proposal.id, statement: proposal.statement, kind: proposal.kind, phase: proposal.phase,
    required: proposal.required, sources, dependsOn: [],
    ...(proposal.kind === 'grounded' ? {
      grounding: { sourcePolicy: 'trusted-provider-required', freshnessPolicy: 'provider-defined', requiredFields: [] },
    } : {}),
    ...(proposal.kind === 'soft-preference' ? {
      softEvaluation: { rubricId: `rubric-${proposal.id}`, evaluatorIds: [] },
    } : {}),
  }
  assertSemanticRequirement(requirement)
  return requirement
}

function mergeUniqueRequirements(
  prior: readonly SemanticRequirement[],
  additions: readonly SemanticRequirement[],
): SemanticRequirement[] {
  const result = [...prior]
  const byId = new Map(prior.map(requirement => [requirement.id, requirement]))
  for (const requirement of additions) {
    const existing = byId.get(requirement.id)
    if (existing !== undefined && !isDeepStrictEqual(existing, requirement)) {
      throw new Error(`semantic requirement "${requirement.id}" cannot change in place`)
    }
    if (existing === undefined) {
      result.push(requirement)
      byId.set(requirement.id, requirement)
    }
  }
  return result
}

async function resolveSpecification(
  ctx: Context,
  agent: Agent,
  baseline: SemanticTurnBaseline,
  goalId: string,
  goalStatement: string,
  baseSpecDigest: string | undefined,
  proposals: readonly SemanticRequirementProposal[],
  signal: AbortSignal,
  bridgeLegacy: boolean,
): Promise<{ readonly specification: SemanticSpecification; readonly isNew: boolean }> {
  const previous = semanticSpecificationOf(agent)
  if (previous !== undefined && baseSpecDigest === undefined) {
    throw new Error(`semantic_begin must reuse base_spec_digest ${previous.specDigest}; an existing required specification cannot be reset`)
  }
  if (baseSpecDigest !== undefined && previous?.specDigest !== baseSpecDigest) {
    throw new Error(`semantic_begin base_spec_digest does not match the current specification ${previous?.specDigest ?? '(none)'}`)
  }
  const messages = sessionMessages(agent.session.events)
  const agentRequirements = proposals.map(proposal => proposalRequirement(proposal, baseline, messages))
  const legacy = bridgeLegacy && previous === undefined ? semanticStateOf(agent)?.checkpoint : undefined
  const legacyRequirements: SemanticRequirement[] = legacy === undefined ? [] : [
    ...legacy.goal.constraints.map((statement, index): SemanticRequirement => ({
      id: `legacy-constraint-${index + 1}`, statement, kind: 'hard-formal', phase: 'always',
      required: false, sources: [{ authority: 'agent', sourceId: `legacy:${legacy.goal.id}`, quote: statement }],
      dependsOn: [],
    })),
    ...legacy.criteria.map((criterion): SemanticRequirement => ({
      id: `legacy-criterion-${criterion.id}`, statement: criterion.description,
      kind: 'hard-formal', phase: 'final-candidate', required: false,
      sources: [{ authority: 'agent', sourceId: `legacy:${legacy.goal.id}`, quote: criterion.description }],
      dependsOn: [],
    })),
  ]
  for (const requirement of legacyRequirements) assertSemanticRequirement(requirement)
  const reports = await ctx.waterfall(
    scopeTarget(agent, agent),
    'semantic/specification',
    {
      sessionId: agent.id, turn: baseline.turn, inputMessageIds: baseline.inputMessageIds,
      proposals, ...(baseSpecDigest === undefined ? {} : { baseSpecDigest }), signal,
    },
    () => Promise.resolve<readonly SemanticSpecificationReport[]>([]),
  )
  const providerIds = new Set<string>()
  for (const report of reports) {
    commandText(report.providerId, 'semantic specification provider id')
    if (providerIds.has(report.providerId)) throw new Error(`semantic specification repeats provider "${report.providerId}"`)
    providerIds.add(report.providerId)
    for (const requirement of [...report.requirements, ...report.forbiddenStates]) {
      assertSemanticRequirement(requirement)
      if (requirement.required && requirement.sources.some(source => source.authority !== report.authority)) {
        throw new Error(`semantic specification provider "${report.providerId}" cannot claim another authority`)
      }
    }
    const knownInputs = new Set([...(previous?.specification.inputs ?? []), ...baseline.inputMessageIds])
    for (const coverage of report.sourceCoverage) {
      if (!knownInputs.has(coverage.sourceId)) {
        throw new Error(`semantic specification provider "${report.providerId}" covers an input outside the active lineage`)
      }
      if (coverage.reviewerAuthority !== report.authority
        && coverage.reviewerAuthority !== 'user-confirmed') {
        throw new Error(`semantic specification provider "${report.providerId}" cannot claim reviewer authority ${coverage.reviewerAuthority}`)
      }
    }
  }
  const priorSpecification = previous?.specification
  const requirements = mergeUniqueRequirements(
    priorSpecification?.requirements ?? [],
    [...legacyRequirements, ...agentRequirements, ...reports.flatMap(report => report.requirements)],
  )
  const forbiddenStates = mergeUniqueRequirements(
    priorSpecification?.forbiddenStates ?? [],
    reports.flatMap(report => report.forbiddenStates),
  )
  const proposalCoverage = baseline.inputMessageIds.map((sourceId): SemanticSourceCoverage => {
    const linked = agentRequirements.filter(requirement => requirement.sources.some(source => source.sourceId === sourceId)).map(requirement => requirement.id)
    const message = messages.get(sourceId)
    return {
      sourceId,
      inputDigest: semanticDigest('authority-input', 1, message === undefined
        ? { missing: true }
        : { source: message.source, content: message.content }),
      disposition: linked.length === 0 ? 'open-question' : 'requirement',
      ...(linked.length === 0 ? { openQuestionIds: [`unmapped-${sourceId.slice(0, 12).toLowerCase().replace(/[^a-z0-9]+/gu, '-') || 'input'}`] } : { requirementIds: linked }),
      reviewerId: 'conversation-agent', reviewerAuthority: 'agent', status: 'unknown',
    }
  })
  const trustedCoverage = new Map(reports.flatMap(report => report.sourceCoverage).map(coverage => [coverage.sourceId, coverage]))
  const coverage = new Map((priorSpecification?.sourceCoverage ?? []).map(item => [item.sourceId, item]))
  for (const item of proposalCoverage) coverage.set(item.sourceId, trustedCoverage.get(item.sourceId) ?? item)
  for (const item of trustedCoverage.values()) coverage.set(item.sourceId, item)
  const openQuestions = [
    ...priorSpecification?.openQuestions ?? [],
    ...reports.flatMap(report => report.openQuestions),
  ]
  for (const item of proposalCoverage.filter(item => item.disposition === 'open-question')) {
    const id = item.openQuestionIds?.[0]
    if (id !== undefined && !openQuestions.some(question => question.id === id)) {
      openQuestions.push({
        id, statement: 'A direct authority input has not been mapped by a trusted reviewer.',
        required: false, sources: [], blocksRequirementIds: [], blockedPhases: ['final-candidate'], status: 'open',
      })
    }
  }
  const changed = priorSpecification === undefined || legacyRequirements.length > 0
    || agentRequirements.length > 0 || reports.length > 0
    || baseline.inputMessageIds.some(id => !priorSpecification.sourceCoverage.some(item => item.sourceId === id))
  if (!changed && priorSpecification !== undefined) return { specification: priorSpecification, isNew: false }
  const version = (priorSpecification?.version ?? 0) + 1
  const sourceCoverage = [...coverage.values()]
  const specification: SemanticSpecification = {
    id: priorSpecification?.id ?? legacy?.goal.id ?? goalId, version,
    parentDigest: previous?.specDigest ?? null,
    goal: priorSpecification?.goal ?? legacy?.goal.statement ?? goalStatement,
    inputs: [...new Set([...(priorSpecification?.inputs ?? []), ...baseline.inputMessageIds])],
    outputs: priorSpecification?.outputs ?? ['final-candidate'],
    assumptions: [...priorSpecification?.assumptions ?? []], requirements, forbiddenStates,
    openQuestions, sourceCoverage,
    changeReason: version === 1 ? 'initial-authority-mapping' : 'additive-authority-inputs',
    authorization: {
      kind: 'trusted-sources',
      authoritySourceIds: [...new Set([
        ...requirements.flatMap(requirement => requirement.sources)
          .filter(source => source.authority !== 'agent').map(source => source.sourceId),
        ...forbiddenStates.flatMap(requirement => requirement.sources).map(source => source.sourceId),
      ])],
      coverageDigest: semanticDigest('source-coverage', 1, sourceCoverage),
    },
  }
  assertSemanticSpecification(specification)
  if (priorSpecification !== undefined) assertSemanticSpecificationTransition(priorSpecification, specification)
  return { specification, isNew: true }
}

function specificationContext(
  agent: Agent,
  callId: CallId,
  specification: SemanticSpecification,
): UserMessage {
  const source: SemanticSpecificationSourceV1 = {
    kind: 'semantic-specification', version: 1, sessionId: agent.id,
    specificationCallId: callId, authoringCause: { kind: 'tool-call', callId },
    specDigest: semanticSpecDigest(specification), specification,
  }
  return createUserMessage({ source, content: [{ type: 'text', text: renderSemanticSpecificationReceipt(source) }] })
}

function ledgerProjection(live: LiveLedger): SemanticActionLedgerProjection {
  return {
    entries: [...live.entries], ledgerDigest: live.digest, health: live.health,
    pendingAuthorizationDigests: [...live.pending],
  }
}

function assistantTextInTurn(events: readonly SessionEvent[], turn: number): string | undefined {
  const message = events.findLast(event => event.type === 'assistant/message' && event.data.turn === turn)
  if (message?.type !== 'assistant/message') return undefined
  const text = message.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  return text.trim().length === 0 ? undefined : text.trim()
}

function deliveryForCandidate(candidate: SemanticCandidate, run: SemanticRunPosition): string {
  if (candidate.content !== undefined) return candidate.content
  const reference = candidate.artifact
  const artifact = reference === undefined ? undefined : run.snapshot.artifacts
    .find(item => item.id === reference.id && item.version === reference.version)
  if (artifact === undefined) throw new Error('semantic code-artifact candidate no longer resolves to its immutable run artifact')
  return `Verified code artifact ${artifact.id}@${artifact.version}: ${artifact.summary} (${artifact.locator}; digest ${artifact.contentDigest})`
}

function resultErrorText(result: Readonly<ToolExecutionResult>): string {
  return result.isError ? result.error.message : ''
}

function dispatchDidNotStart(pending: PendingPreflight, result: Readonly<ToolExecutionResult>): boolean {
  if (pending.finalDecision.kind === 'deny') return true
  if (!result.isError || pending.finalDecision.kind !== 'ask') return false
  return /rejected tool|requires approval|approval .*cancelled|no approval channel|approval channel is available/iu.test(result.error.message)
}

async function withinPreflightBudget<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    }),
  ])
}

function finishApprovalInTurn(agent: Agent, turn: number): { readonly answer: string; readonly revision: number } | undefined {
  const candidatePosition = semanticCandidateOf(agent)
  const run = semanticRunOf(agent)
  const verification = semanticVerificationV2Of(agent)
  if (candidatePosition === undefined || run === undefined || verification?.receipt.verdict !== 'passed'
    || verification.receipt.candidateDigest !== candidatePosition.candidate.candidateDigest) return undefined
  const calls = new Map<string, { readonly seq: number; readonly candidateDigest: string; readonly expectedRevision: number }>()
  const successful = new Map<string, number>()
  for (const event of agent.session.events) {
    if (event.type === 'tool/call' && event.data.turn === turn && event.data.name === FINISH_TOOL) {
      try {
        const args = JSON.parse(event.data.arguments) as Record<string, unknown>
        if (typeof args['candidate_digest'] === 'string' && typeof args['expected_revision'] === 'number') {
          calls.set(event.data.callId, {
            seq: event.seq, candidateDigest: args['candidate_digest'], expectedRevision: args['expected_revision'],
          })
        }
      } catch (_invalidFinishArguments) {
        continue
      }
    }
    if (event.type === 'tool/result' && event.data.turn === turn && event.data.message.content[0].isError !== true) {
      successful.set(event.data.message.content[0].toolCallId, event.seq)
    }
  }
  const approval = [...calls].findLast(([callId, call]) => successful.has(callId)
    && call.candidateDigest === candidatePosition.candidate.candidateDigest)
  if (approval === undefined) return undefined
  const [, call] = approval
  const resultSeq = successful.get(approval[0])!
  if (agent.session.events.some(event => event.seq > resultSeq && event.type === 'tool/call')) return undefined
  const answer = deliveryForCandidate(candidatePosition.candidate, run)
  if (assistantTextInTurn(agent.session.events, turn) !== answer) return undefined
  return { answer, revision: call.expectedRevision }
}

/** Register command-v2 tools and runtime policy hooks. */
export function applyCommandRuntime(ctx: Context, config: CommandRuntimeConfig): void {
  const cache = new SemanticRuntimeCache()
  const failures = new Map<Agent, ProtocolFailureState>()
  const repairs = new Map<Agent, RepairState>()
  const liveLedgers = new WeakMap<Agent, LiveLedger>()
  const pending = new Map<ToolExecutionToken, PendingPreflight>()

  const liveLedger = (agent: Agent): LiveLedger => {
    const existing = liveLedgers.get(agent)
    if (existing !== undefined) return existing
    const durable = semanticActionLedgerOf(agent)
    const created: LiveLedger = {
      entries: [...durable.entries], digest: durable.ledgerDigest,
      health: durable.health, pending: new Set(durable.pendingAuthorizationDigests),
    }
    liveLedgers.set(agent, created)
    return created
  }

  ctx.systemPrompt.section({ name: 'tool:semantic-loop', order: 115, text: POLICY })

  ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || semanticBaselineOf(payload.agent, payload.turn) !== undefined
      || decision.messages.some(message => message.source.kind === 'semantic-baseline')) return decision
    const inputIds = decision.messages.filter(message => message.source.kind === 'user').map(message => message.id)
    const baseline = baselineValue(payload.agent, payload.turn, inputIds, config)
    return { kind: 'enter', messages: [...decision.messages, baselineContext(baseline)] }
  })

  ctx.tools.register(defineTool({
    name: BEGIN_TOOL,
    description: 'Bind this turn to authority inputs, an immutable semantic specification, and an initial plan. Use base_spec_digest to continue an existing lineage.',
    parameters: {
      goal_id: { type: 'string', required: true },
      goal_statement: { type: 'string', required: true },
      base_spec_digest: { type: 'string' },
      requirement_proposals: { type: 'array', items: REQUIREMENT_SCHEMA },
      plan_nodes: { type: 'array', required: true, items: PLAN_NODE_SCHEMA },
      next_action: { type: 'string', required: true },
    },
    output: {
      schema: RUN_RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `Semantic run r${value.revision} began under spec ${value.specDigest} (run ${value.runStateDigest}).` }],
    },
    async execute(args, exec) {
      commandBytes(args, config)
      if (exec.agent === undefined) throw new Error(`${BEGIN_TOOL} requires an owning agent session`)
      const agent = exec.agent
      const turn = currentTurn(agent)
      const ensured = ensureBaseline(agent, turn, config)
      const proposals: SemanticRequirementProposal[] = (args.requirement_proposals ?? []).map(proposal => ({
        id: proposal.id, statement: proposal.statement, kind: proposal.kind, phase: proposal.phase,
        required: proposal.required,
        ...(proposal.source_id === undefined ? {} : { sourceId: proposal.source_id }),
        ...(proposal.quote === undefined ? {} : { quote: proposal.quote }),
      }))
      const resolved = await resolveSpecification(
        ctx, agent, ensured.baseline, args.goal_id, args.goal_statement,
        args.base_spec_digest, proposals, exec.signal, config.protocolMode === 'hybrid',
      )
      if (config.preActionGate === 'off' && [
        ...resolved.specification.requirements,
        ...resolved.specification.forbiddenStates,
      ].some(requirement => requirement.required
        && (requirement.phase === 'pre-action' || requirement.phase === 'always'))) {
        throw new Error('preActionGate off cannot activate a required pre-action obligation')
      }
      const specDigest = semanticSpecDigest(resolved.specification)
      const plan: SemanticPlan = { revision: 1, changeReason: 'initial-plan', nodes: planNodes(args.plan_nodes) }
      assertSemanticPlan(plan)
      const previousRun = semanticRunOf(agent)
      const criteria = resolved.specification.requirements
        .filter(requirement => requirement.phase === 'final-candidate' || requirement.phase === 'always')
        .map(requirement => ({ id: requirement.id, description: requirement.statement }))
      if (criteria.length === 0) criteria.push({ id: 'goal-completion', description: args.goal_statement })
      const snapshot = makeRunSnapshot({
        agent, turn, revision: (previousRun?.snapshot.state.revision ?? 0) + 1,
        specDigest, phase: 'exploring', plan, criteria, metCriterionIds: [], artifacts: [], facts: [], gaps: [],
        nextAction: args.next_action, observationLedgerWatermark: liveLedger(agent).digest,
        ...(plan.nodes[0] === undefined ? {} : { activeNodeId: plan.nodes[0].id }),
      })
      const contexts = [
        ...(ensured.context === undefined ? [] : [ensured.context]),
        ...(resolved.isNew ? [specificationContext(agent, exec.callId, resolved.specification)] : []),
        runContext(agent, exec.callId, 'begin', snapshot),
      ]
      for (const context of contexts) exec.deferContext(context)
      const runStateDigest = semanticRunStateDigest(snapshot.state)
      return { revision: snapshot.state.revision, phase: 'exploring' as const, specDigest, runStateDigest }
    },
    presentCall: args => present('Begin semantic run', args),
  }))

  ctx.tools.register(defineTool({
    name: PROGRESS_TOOL,
    description: 'Append a bounded material progress delta. Omitted fields preserve current state; runtime assigns artifact versions and the next run revision.',
    parameters: {
      expected_revision: { type: 'integer', required: true },
      active_node_id: { type: 'string' },
      met_criterion_ids: { type: 'array', items: { type: 'string' } },
      reopened_criterion_ids: { type: 'array', items: { type: 'string' } },
      new_facts: { type: 'array', items: FACT_SCHEMA },
      new_artifacts: { type: 'array', items: ARTIFACT_SCHEMA },
      opened_gaps: { type: 'array', items: GAP_SCHEMA },
      closed_gap_ids: { type: 'array', items: { type: 'string' } },
      next_action: { type: 'string', required: true },
    },
    output: {
      schema: RUN_RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `Semantic progress committed at r${value.revision} (run ${value.runStateDigest}).` }],
    },
    async execute(args, exec) {
      commandBytes(args, config)
      if (exec.agent === undefined) throw new Error(`${PROGRESS_TOOL} requires an owning agent session`)
      const agent = exec.agent
      const current = semanticRunOf(agent)
      if (current === undefined) throw new Error(`${PROGRESS_TOOL} requires ${BEGIN_TOOL}`)
      if (args.expected_revision !== current.snapshot.state.revision) {
        throw new Error(`semantic progress stale revision: expected ${current.snapshot.state.revision}, got ${args.expected_revision}`)
      }
      const criterionIds = new Set(current.snapshot.criteria.map(criterion => criterion.id))
      const met = new Set(current.snapshot.state.metCriterionIds)
      for (const id of args.met_criterion_ids ?? []) {
        if (!criterionIds.has(id)) throw new Error(`semantic progress names unknown criterion "${id}"`)
        met.add(id)
      }
      for (const id of args.reopened_criterion_ids ?? []) {
        if (!criterionIds.has(id)) throw new Error(`semantic progress names unknown criterion "${id}"`)
        met.delete(id)
      }
      const availableCalls = successfulEnvironmentCallIds(agent.session.events)
      const facts = [...current.snapshot.facts]
      for (const fact of args.new_facts ?? []) {
        commandId(fact.id, 'semantic fact id')
        commandText(fact.statement, `semantic fact "${fact.id}" statement`)
        commandText(fact.evidence, `semantic fact "${fact.id}" evidence`)
        const evidenceCallIds = fact.evidence_call_ids ?? []
        for (const id of evidenceCallIds) if (!availableCalls.has(id as CallId)) throw new Error(`semantic fact "${fact.id}" cites unknown successful call "${id}"`)
        const value: SemanticFact = { id: fact.id, statement: fact.statement, evidence: fact.evidence, evidenceCallIds: [...evidenceCallIds] as CallId[] }
        const index = facts.findIndex(item => item.id === value.id)
        if (index < 0) facts.push(value)
        else facts[index] = value
      }
      const artifacts = [...current.snapshot.artifacts]
      for (const artifact of args.new_artifacts ?? []) {
        commandId(artifact.id, 'semantic artifact id')
        commandText(artifact.kind, `semantic artifact "${artifact.id}" kind`)
        commandText(artifact.summary, `semantic artifact "${artifact.id}" summary`)
        commandText(artifact.locator, `semantic artifact "${artifact.id}" locator`)
        const evidenceCallIds = artifact.evidence_call_ids ?? []
        if (!isSha256Digest(artifact.content_digest)) {
          throw new Error(`semantic artifact "${artifact.id}" content_digest must be SHA-256`)
        }
        for (const id of evidenceCallIds) if (!availableCalls.has(id as CallId)) throw new Error(`semantic artifact "${artifact.id}" cites unknown successful call "${id}"`)
        const version = (artifacts.findLast(item => item.id === artifact.id)?.version ?? 0) + 1
        artifacts.push({
          id: artifact.id, version, kind: artifact.kind, summary: artifact.summary,
          locator: artifact.locator, contentDigest: artifact.content_digest,
          producerNodeId: artifact.producer_node_id ?? null,
          planRevision: artifact.producer_node_id === undefined ? 0 : current.snapshot.plan.revision,
          inputs: artifact.input_versions, evidenceCallIds: [...evidenceCallIds] as CallId[],
        })
      }
      const closed = new Set(args.closed_gap_ids ?? [])
      const gaps = current.snapshot.gaps.filter(gap => !closed.has(gap.id))
      for (const gap of args.opened_gaps ?? []) {
        commandId(gap.id, 'semantic gap id')
        commandText(gap.description, `semantic gap "${gap.id}" description`)
        if (gaps.some(item => item.id === gap.id)) throw new Error(`semantic progress repeats open gap "${gap.id}"`)
        gaps.push(gap)
      }
      const activeNodeId = args.active_node_id ?? current.snapshot.state.activeNodeId
      if (activeNodeId !== undefined && !current.snapshot.plan.nodes.some(node => node.id === activeNodeId)) {
        throw new Error(`semantic progress names unknown active node "${activeNodeId}"`)
      }
      const nextBase = {
        plan: current.snapshot.plan, criteria: current.snapshot.criteria,
        artifacts, facts, gaps, nextAction: args.next_action,
      }
      const previousCheckpoint = checkpointFor({
        plan: current.snapshot.plan, criteria: current.snapshot.criteria,
        artifacts: current.snapshot.artifacts, facts: current.snapshot.facts,
        gaps: current.snapshot.gaps, nextAction: current.snapshot.nextAction,
      }, current.snapshot.state.phase)
      const nextCheckpoint = checkpointFor(nextBase, 'exploring')
      assertSemanticArtifacts(nextCheckpoint)
      assertSemanticArtifactTransition(previousCheckpoint, nextCheckpoint)
      const materialChanged = !isDeepStrictEqual(current.snapshot.state.metCriterionIds, [...met])
        || !isDeepStrictEqual(current.snapshot.artifacts, artifacts)
        || !isDeepStrictEqual(current.snapshot.facts, facts)
        || !isDeepStrictEqual(current.snapshot.gaps, gaps)
      if (config.progressUpdatePolicy === 'material-only' && !materialChanged) {
        throw new Error('semantic progress requires a material criterion, artifact, fact, or gap change')
      }
      const snapshot = makeRunSnapshot({
        agent, turn: currentTurn(agent), revision: current.snapshot.state.revision + 1,
        specDigest: current.snapshot.state.specDigest, phase: 'exploring',
        ...nextBase, metCriterionIds: [...met], observationLedgerWatermark: liveLedger(agent).digest,
        ...(activeNodeId === undefined ? {} : { activeNodeId }),
      })
      exec.deferContext(runContext(agent, exec.callId, 'progress', snapshot))
      return {
        revision: snapshot.state.revision, phase: 'exploring' as const,
        specDigest: snapshot.state.specDigest, runStateDigest: semanticRunStateDigest(snapshot.state),
      }
    },
    presentCall: args => present('Record semantic progress', args),
  }))

  ctx.tools.register(defineTool({
    name: REPLAN_TOOL,
    description: 'Atomically replace only the plan graph. Existing artifact versions remain and become stale when their producer plan revision changes.',
    parameters: {
      expected_revision: { type: 'integer', required: true },
      expected_plan_revision: { type: 'integer', required: true },
      change_reason: { type: 'string', required: true },
      nodes: { type: 'array', required: true, items: PLAN_NODE_SCHEMA },
      active_node_id: { type: 'string' },
      next_action: { type: 'string', required: true },
    },
    output: {
      schema: RUN_RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `Semantic plan replaced at r${value.revision} (run ${value.runStateDigest}).` }],
    },
    async execute(args, exec) {
      commandBytes(args, config)
      if (exec.agent === undefined) throw new Error(`${REPLAN_TOOL} requires an owning agent session`)
      const agent = exec.agent
      const current = semanticRunOf(agent)
      if (current === undefined) throw new Error(`${REPLAN_TOOL} requires ${BEGIN_TOOL}`)
      if (args.expected_revision !== current.snapshot.state.revision
        || args.expected_plan_revision !== current.snapshot.plan.revision) {
        throw new Error(`semantic replan stale revision: run ${current.snapshot.state.revision}, plan ${current.snapshot.plan.revision}`)
      }
      const plan: SemanticPlan = {
        revision: current.snapshot.plan.revision + 1,
        changeReason: args.change_reason,
        nodes: planNodes(args.nodes),
      }
      assertSemanticPlan(plan)
      if (isDeepStrictEqual(plan.nodes, current.snapshot.plan.nodes)) throw new Error('semantic replan requires a changed plan graph')
      if (args.active_node_id !== undefined && !plan.nodes.some(node => node.id === args.active_node_id)) {
        throw new Error(`semantic replan names unknown active node "${args.active_node_id}"`)
      }
      const snapshot = makeRunSnapshot({
        agent, turn: currentTurn(agent), revision: current.snapshot.state.revision + 1,
        specDigest: current.snapshot.state.specDigest, phase: 'exploring', plan,
        criteria: current.snapshot.criteria, metCriterionIds: current.snapshot.state.metCriterionIds,
        artifacts: current.snapshot.artifacts, facts: current.snapshot.facts, gaps: current.snapshot.gaps,
        nextAction: args.next_action, observationLedgerWatermark: liveLedger(agent).digest,
        ...(args.active_node_id === undefined ? {} : { activeNodeId: args.active_node_id }),
      })
      exec.deferContext(runContext(agent, exec.callId, 'replan', snapshot))
      return {
        revision: snapshot.state.revision, phase: 'exploring' as const,
        specDigest: snapshot.state.specDigest, runStateDigest: semanticRunStateDigest(snapshot.state),
      }
    },
    presentCall: args => present('Replace semantic plan', args),
  }))

  ctx.tools.register(defineTool({
    name: READY_TOOL,
    description: 'Seal the current structurally complete run state. Readiness does not claim verifier coverage.',
    parameters: {
      expected_revision: { type: 'integer', required: true },
      next_action: { type: 'string', required: true, enum: ['submit-candidate'] },
    },
    output: {
      schema: RUN_RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `Semantic run r${value.revision} is ready (run ${value.runStateDigest}).` }],
    },
    async execute(args, exec) {
      commandBytes(args, config)
      if (exec.agent === undefined) throw new Error(`${READY_TOOL} requires an owning agent session`)
      const agent = exec.agent
      const current = semanticRunOf(agent)
      if (current === undefined) throw new Error(`${READY_TOOL} requires ${BEGIN_TOOL}`)
      if (args.expected_revision !== current.snapshot.state.revision) throw new Error(`semantic ready stale revision: expected ${current.snapshot.state.revision}, got ${args.expected_revision}`)
      if (current.snapshot.criteria.length === 0) throw new Error('semantic ready requires at least one completion criterion')
      const unmet = current.snapshot.criteria.filter(criterion => !current.snapshot.state.metCriterionIds.includes(criterion.id))
      if (unmet.length > 0) throw new Error(`semantic ready has unmet criteria: ${unmet.map(item => item.id).join(', ')}`)
      if (current.snapshot.gaps.length > 0) throw new Error(`semantic ready has open gaps: ${current.snapshot.gaps.map(gap => gap.id).join(', ')}`)
      const ledger = liveLedger(agent)
      if (ledger.health !== 'safe' || ledger.pending.size > 0) throw new Error(`semantic ready requires a settled safe action ledger; current health is ${ledger.health}`)
      const base = {
        plan: current.snapshot.plan, criteria: current.snapshot.criteria,
        artifacts: current.snapshot.artifacts, facts: current.snapshot.facts,
        gaps: current.snapshot.gaps, nextAction: args.next_action,
      }
      assertSemanticArtifacts(checkpointFor(base, 'ready'))
      if (config.requireToolEvidence && successfulEnvironmentCallIds(agent.session.events).size === 0) {
        throw new Error('semantic ready requires at least one successful environment-tool result')
      }
      const snapshot = makeRunSnapshot({
        agent, turn: currentTurn(agent), revision: current.snapshot.state.revision + 1,
        specDigest: current.snapshot.state.specDigest, phase: 'ready', ...base,
        metCriterionIds: current.snapshot.state.metCriterionIds,
        observationLedgerWatermark: ledger.digest,
      })
      exec.deferContext(runContext(agent, exec.callId, 'ready', snapshot))
      return {
        revision: snapshot.state.revision, phase: 'ready' as const,
        specDigest: snapshot.state.specDigest, runStateDigest: semanticRunStateDigest(snapshot.state),
      }
    },
    presentCall: args => present('Seal semantic run', args),
  }))

  ctx.tools.register(defineTool({
    name: CANDIDATE_TOOL,
    description: 'Submit the exact final answer, structured output, or immutable code artifact that semantic_verify must inspect.',
    parameters: {
      expected_revision: { type: 'integer', required: true },
      kind: { type: 'string', required: true, enum: ['final-answer', 'code-artifact', 'structured-output'] },
      answer: { type: 'string' },
      artifact_id: { type: 'string' },
      artifact_version: { type: 'integer' },
    },
    output: {
      schema: CANDIDATE_RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `Semantic candidate ${value.candidateDigest} committed at r${value.revision}.` }],
    },
    async execute(args, exec) {
      commandBytes(args, config)
      if (exec.agent === undefined) throw new Error(`${CANDIDATE_TOOL} requires an owning agent session`)
      const agent = exec.agent
      const current = semanticRunOf(agent)
      if (current === undefined || current.snapshot.state.phase !== 'ready') throw new Error(`${CANDIDATE_TOOL} requires a ready semantic run`)
      if (args.expected_revision !== current.snapshot.state.revision) throw new Error(`semantic candidate stale revision: expected ${current.snapshot.state.revision}, got ${args.expected_revision}`)
      const isArtifact = args.kind === 'code-artifact'
      if (isArtifact ? args.answer !== undefined || args.artifact_id === undefined || args.artifact_version === undefined
        : args.answer === undefined || args.artifact_id !== undefined || args.artifact_version !== undefined) {
        throw new Error(`semantic candidate kind "${args.kind}" has invalid conditional fields`)
      }
      if (args.answer !== undefined) commandText(args.answer, 'semantic candidate answer')
      const artifact = isArtifact
        ? current.snapshot.artifacts.find(item => item.id === args.artifact_id && item.version === args.artifact_version)
        : undefined
      if (isArtifact && artifact === undefined) throw new Error('semantic candidate names an unknown immutable artifact version')
      const ledger = liveLedger(agent)
      const runSnapshot = makeRunSnapshot({
        agent, turn: currentTurn(agent), revision: current.snapshot.state.revision + 1,
        specDigest: current.snapshot.state.specDigest, phase: 'candidate',
        plan: current.snapshot.plan, criteria: current.snapshot.criteria,
        metCriterionIds: current.snapshot.state.metCriterionIds, artifacts: current.snapshot.artifacts,
        facts: current.snapshot.facts, gaps: current.snapshot.gaps, nextAction: 'verify candidate',
        observationLedgerWatermark: ledger.digest,
      })
      const runStateDigest = semanticRunStateDigest(runSnapshot.state)
      const core: Omit<SemanticCandidate, 'candidateDigest'> = {
        id: `candidate-r${runSnapshot.state.revision}`,
        specDigest: runSnapshot.state.specDigest, runStateDigest, kind: args.kind,
        ...(args.answer === undefined ? {} : { content: args.answer }),
        ...(artifact === undefined ? {} : { artifact: { id: artifact.id, version: artifact.version } }),
        dependencyLedgerWatermark: ledger.digest,
        dependencyResourceDigests: artifact === undefined ? [] : [artifact.contentDigest],
      }
      const candidate: SemanticCandidate = { ...core, candidateDigest: semanticCandidateDigest(core) }
      assertSemanticCandidate(candidate)
      const source: SemanticCandidateSourceV1 = {
        kind: 'semantic-candidate', version: 1, sessionId: agent.id,
        candidateCallId: exec.callId, authoringCause: { kind: 'tool-call', callId: exec.callId }, candidate,
      }
      exec.deferContext(runContext(agent, exec.callId, 'candidate', runSnapshot))
      exec.deferContext(createUserMessage({ source, content: [{ type: 'text', text: renderSemanticCandidateReceipt(source) }] }))
      return { revision: runSnapshot.state.revision, candidateDigest: candidate.candidateDigest, runStateDigest }
    },
    presentCall: args => present('Submit semantic candidate', args.answer ?? args),
  }))

  ctx.tools.register(defineTool({
    name: STATE_TOOL,
    description: 'Recover the latest specification and incremental run snapshot after resume or compaction.',
    parameters: {},
    output: { schema: STATE_RESULT_SCHEMA_V2, render: (_args, value) => [{ type: 'text', text: value.snapshot }] },
    execute(_args, exec) {
      if (exec.agent === undefined) throw new Error(`${STATE_TOOL} requires an owning agent session`)
      const run = semanticRunOf(exec.agent)
      const spec = semanticSpecificationOf(exec.agent)
      if (run === undefined || spec === undefined) throw new Error('semantic command state is not initialized')
      return Promise.resolve({
        revision: run.snapshot.state.revision, phase: run.snapshot.state.phase,
        specDigest: spec.specDigest, runStateDigest: run.runStateDigest,
        snapshot: JSON.stringify({ specification: spec.specification, run: run.snapshot }, null, 2),
      })
    },
    presentCall: args => present('Read semantic state', args),
  }))

  ctx.tools.register(defineTool({
    name: CAPABILITIES_TOOL,
    description: 'Inspect trusted verifier and task capabilities for the current plan.',
    parameters: {},
    output: {
      schema: CAPABILITIES_RESULT_SCHEMA_V2,
      render: (_args, value) => [{ type: 'text', text: `Semantic capabilities: ${value.available.join(', ') || '(none)'}; missing: ${value.missing.join(', ') || '(none)'}.` }],
    },
    async execute(_args, exec) {
      if (exec.agent === undefined) throw new Error(`${CAPABILITIES_TOOL} requires an owning agent session`)
      const inventory = await resolveSemanticCapabilities(ctx, exec.agent, config.capabilities)
      const run = semanticRunOf(exec.agent)
      const checkpoint = run === undefined ? undefined : checkpointFor({
        plan: run.snapshot.plan, criteria: run.snapshot.criteria,
        artifacts: run.snapshot.artifacts, facts: run.snapshot.facts,
        gaps: run.snapshot.gaps, nextAction: run.snapshot.nextAction,
      }, run.snapshot.state.phase)
      const required = checkpoint === undefined ? [] : requiredSemanticCapabilities(checkpoint)
      const missing = checkpoint === undefined ? [] : missingSemanticCapabilities(checkpoint, inventory)
      return {
        providers: inventory.reports.length,
        available: inventory.available.map(capability => capability.id), required: [...required], missing: [...missing],
      }
    },
    presentCall: args => present('Inspect semantic capabilities', args),
  }))

  ctx.tools.register(defineTool({
    name: VERIFY_TOOL,
    description: 'Verify the exact current specification, candidate-phase run, action ledger, and candidate digest through independent providers.',
    parameters: {
      expected_revision: { type: 'integer', required: true },
      candidate_digest: { type: 'string', required: true },
    },
    output: {
      schema: VERIFY_RESULT_SCHEMA_V2,
      render: (_args, value) => [{ type: 'text', text: `Semantic verification ${value.verdict}: formal ${value.formallyProved}, runtime ${value.runtimeChecked}, evidence ${value.evidenceBacked}, violated ${value.violated}, unknown ${value.unknown}.` }],
    },
    async execute(args, exec) {
      commandBytes(args, config)
      if (exec.agent === undefined) throw new Error(`${VERIFY_TOOL} requires an owning agent session`)
      const agent = exec.agent
      const spec = semanticSpecificationOf(agent)
      const run = semanticRunOf(agent)
      const candidate = semanticCandidateOf(agent)
      if (spec === undefined || run === undefined || candidate === undefined || run.snapshot.state.phase !== 'candidate') {
        throw new Error('semantic verification requires a specification and exact candidate-phase run')
      }
      if (args.expected_revision !== run.snapshot.state.revision || args.candidate_digest !== candidate.candidate.candidateDigest) {
        throw new Error('semantic verification revision or candidate digest is stale')
      }
      const live = liveLedger(agent)
      const projection = ledgerProjection(live)
      if (candidate.candidate.dependencyLedgerWatermark !== projection.ledgerDigest) {
        throw new Error('semantic candidate is stale after later environment action')
      }
      const entriesByDigest = new Map(live.entries.map(entry => [entry.receiptDigest, entry]))
      const handle: SemanticLedgerQueryHandle = {
        sessionId: agent.id, turn: currentTurn(agent), ledgerDigest: projection.ledgerDigest,
        query: receiptIds => Promise.resolve(receiptIds.flatMap(id => entriesByDigest.get(id) ?? [])),
      }
      const inventory = await resolveSemanticCapabilities(ctx, agent, config.capabilities)
      const request: SemanticVerificationRequestV2 = {
        sessionId: agent.id, revision: run.snapshot.state.revision,
        spec: spec.specification, specDigest: spec.specDigest,
        runState: run.snapshot.state, runStateDigest: run.runStateDigest,
        candidate: candidate.candidate, candidateDigest: candidate.candidate.candidateDigest,
        actionLedgerDigest: projection.ledgerDigest,
        actionCoverage: config.preActionGate === 'off' ? 'disabled'
          : config.preActionGate === 'observe' ? 'observed'
            : config.preActionGate === 'enforce' ? 'enforced' : 'adaptive',
        relevantActionReceiptIds: live.entries.slice(-64).map(entry => entry.receiptDigest),
        environmentCallIds: agent.session.events.flatMap(event => event.type === 'tool/call'
          && !isSemanticToolName(event.data.name) ? [event.data.callId] : []),
        ledgerQueryHandle: handle,
        evidence: semanticEvidenceOf(agent), capabilities: inventory,
      }
      const receipt = await verifySemanticCandidate(ctx, agent, request, projection)
      const source: SemanticVerificationSourceV2 = {
        kind: 'semantic-verification', version: 2, sessionId: agent.id,
        verificationCallId: exec.callId, receipt,
      }
      exec.deferContext(createUserMessage({ source, content: [{ type: 'text', text: renderSemanticVerificationReceiptV2(receipt) }] }))
      return {
        revision: receipt.revision, candidateDigest: receipt.candidateDigest, verdict: receipt.verdict,
        requiredTotal: receipt.coverage.requiredTotal, formallyProved: receipt.coverage.formallyProved,
        runtimeChecked: receipt.coverage.runtimeChecked, evidenceBacked: receipt.coverage.evidenceBacked,
        violated: receipt.coverage.violated, unknown: receipt.coverage.unknown,
      }
    },
    presentCall: args => present('Verify semantic candidate', args),
  }))

  ctx.tools.register(defineTool({
    name: FINISH_TOOL,
    description: 'Return the exact candidate already covered by a current passing v2 receipt. No new answer text is accepted here.',
    parameters: {
      expected_revision: { type: 'integer', required: true },
      candidate_digest: { type: 'string', required: true },
    },
    output: {
      schema: FINISH_RESULT_SCHEMA_V2,
      render: (_args, value) => [{ type: 'text', text: `Semantic completion accepted at r${value.revision} for candidate ${value.candidateDigest}. Return this exact candidate verbatim:\n\n${value.answer}` }],
    },
    execute(args, exec) {
      commandBytes(args, config)
      if (exec.agent === undefined) throw new Error(`${FINISH_TOOL} requires an owning agent session`)
      const agent = exec.agent
      const run = semanticRunOf(agent)
      const candidate = semanticCandidateOf(agent)
      const verification = semanticVerificationV2Of(agent)
      if (run === undefined || candidate === undefined || verification === undefined) throw new Error('semantic finish requires a verified candidate')
      if (args.expected_revision !== run.snapshot.state.revision
        || args.candidate_digest !== candidate.candidate.candidateDigest
        || verification.receipt.verdict !== 'passed'
        || verification.receipt.specDigest !== candidate.candidate.specDigest
        || verification.receipt.runStateDigest !== candidate.candidate.runStateDigest
        || verification.receipt.candidateDigest !== candidate.candidate.candidateDigest) {
        throw new Error('semantic finish requires a current passing receipt for the exact candidate')
      }
      if (candidate.candidate.dependencyLedgerWatermark !== liveLedger(agent).digest) {
        throw new Error('semantic finish candidate is stale after later environment action')
      }
      const answer = deliveryForCandidate(candidate.candidate, run)
      return Promise.resolve({ revision: run.snapshot.state.revision, candidateDigest: candidate.candidate.candidateDigest, answer })
    },
    presentCall: args => present('Finish verified candidate', args),
  }))

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.agent === undefined || isSemanticToolName(exec.name)) return next()
    if (config.preActionGate === 'off') return next()
    const agent = exec.agent
    const turn = currentTurn(agent)
    const cached = cache.read(agent)
    const ensured = cached.baseline?.turn === turn
      ? { baseline: cached.baseline }
      : ensureBaseline(agent, turn, config)
    if (ensured.context !== undefined) agent.inject(ensured.context)
    let action: SemanticAction
    let reports: readonly SemanticAuthorizationReport[] = []
    let healthy = true
    try {
      action = await describeSemanticAction(ctx, agent, exec, turn)
      const ledger = liveLedger(agent)
      const entriesByDigest = new Map(ledger.entries.map(entry => [entry.receiptDigest, entry]))
      const queryHandle: SemanticLedgerQueryHandle = {
        sessionId: agent.id, turn, ledgerDigest: ledger.digest,
        query: ids => Promise.resolve(ids.flatMap(id => entriesByDigest.get(id) ?? [])),
      }
      const runtime = ensured.context === undefined ? cached : cache.read(agent)
      const spec = runtime.specification
      const run = runtime.run
      const preflightSignal = AbortSignal.any([
        exec.signal,
        AbortSignal.timeout(config.preflightFastPathBudgetMs),
      ])
      reports = await withinPreflightBudget(ctx.waterfall(
        scopeTarget(agent, agent), 'semantic/authorize', {
          sessionId: agent.id, turn, baselineDigest: ensured.baseline.baselineDigest,
          ...(spec === undefined ? {} : { specDigest: spec.specDigest }),
          ...(run === undefined ? {} : { runRevision: run.snapshot.state.revision }),
          action, ledgerDigest: ledger.digest,
          relevantReceiptIds: ledger.entries.slice(-32).map(entry => entry.receiptDigest),
          ledgerQueryHandle: queryHandle,
          formalPreflightMinRisk: config.formalPreflightMinRisk,
          fastPathBudgetMs: config.preflightFastPathBudgetMs,
          signal: preflightSignal,
        },
        () => Promise.resolve([]),
      ), preflightSignal)
    } catch (_preflightIntegrityFailure) {
      healthy = false
      liveLedger(agent).health = 'unsafe'
      cache.setHealth(agent, { kind: 'blocked', reason: 'preflight-integrity' })
      const downstream = await next()
      return mergePreToolDecisions(
        { kind: 'deny', reason: 'semantic preflight integrity failure; the tool body was not started' },
        downstream,
      )
    }
    const runtime = cache.read(agent)
    const spec = runtime.specification
    const run = runtime.run
    const local = decideSemanticAuthorization(action, spec?.specification, reports, {
      gate: config.preActionGate, unknownActionPolicy: config.unknownActionPolicy,
      baselinePresent: true,
      currentTurnBegin: run?.snapshot.state.turn === turn,
      safetyPlaneHealthy: healthy && runtime.health.kind !== 'blocked',
    })
    const downstream = await next()
    const finalDecision = mergePreToolDecisions(local.decision, downstream)
    const ledger = liveLedger(agent)
    const reportDigests = reports.map(report => semanticDigest('authorization-report', 1, report))
    const receiptCore: Omit<SemanticAuthorizationReceipt, 'receiptDigest'> = {
      sessionId: agent.id, turn, callId: exec.callId,
      baselineDigest: ensured.baseline.baselineDigest,
      ...(spec === undefined ? {} : { specDigest: spec.specDigest }),
      ...(run === undefined ? {} : { runRevision: run.snapshot.state.revision }),
      actionDigest: action.actionDigest, parentLedgerDigest: ledger.digest,
      decision: finalDecision.kind === 'allow' ? 'allowed' : finalDecision.kind === 'ask' ? 'asked' : 'denied',
      assurance: local.assurance, reportDigests,
    }
    const receipt: SemanticAuthorizationReceipt = { ...receiptCore, receiptDigest: semanticAuthorizationReceiptDigest(receiptCore) }
    ledger.entries.push(receipt)
    ledger.digest = nextActionLedgerDigest(ledger.digest, receipt.receiptDigest)
    ledger.pending.add(receipt.receiptDigest)
    pending.set(exec.token, { agent, action, localDecision: local.decision, finalDecision, reports, baseline: ensured.baseline, receipt })
    return finalDecision
  })

  ctx.tools.guard((exec) => {
    if (exec.agent === undefined || isSemanticToolName(exec.name)) return undefined
    if (config.preActionGate === 'off') return undefined
    const record = pending.get(exec.token)
    if (record === undefined) return 'semantic preflight record is missing; safety guard denied the tool'
    const argumentsDigest = semanticDigest('tool-arguments', 1, exec.arguments)
    if (record.action.callId !== exec.callId || record.action.toolName !== exec.name
      || record.action.argumentsDigest !== argumentsDigest) {
      return 'semantic preflight action binding changed before dispatch'
    }
    return undefined
  })

  const settle = (
    record: PendingPreflight,
    result: Readonly<ToolExecutionResult>,
    blocked: boolean,
  ): { readonly contexts: UserMessage[]; readonly settlement: SemanticActionSettlementReceipt } => {
    const ledger = liveLedger(record.agent)
    const noStart = dispatchDidNotStart(record, result)
    const failed = result.isError || blocked
    const riskHasEffects = record.action.risk !== 'none' && record.action.risk !== 'low'
      || record.action.writes.length > 0
    const dispatchState = noStart ? 'not-started' as const : failed && riskHasEffects ? 'started' as const : 'settled' as const
    const outcome = noStart ? 'not-started' as const
      : failed && riskHasEffects ? 'unknown-effect' as const
        : failed ? 'failed' as const : 'succeeded' as const
    const settlementCore: Omit<SemanticActionSettlementReceipt, 'receiptDigest'> = {
      sessionId: record.agent.id, turn: record.receipt.turn, callId: record.action.callId,
      authorizationReceiptDigest: record.receipt.receiptDigest,
      actionDigest: record.action.actionDigest, dispatchState, outcome,
      resultDigest: semanticDigest('tool-result', 1, {
        isError: result.isError, content: result.content,
        ...(result.isError ? { error: result.error.message } : {}),
      }),
      postCheckReportDigests: [],
    }
    const settlement: SemanticActionSettlementReceipt = {
      ...settlementCore, receiptDigest: semanticSettlementReceiptDigest(settlementCore),
    }
    ledger.entries.push(settlement)
    ledger.digest = nextActionLedgerDigest(ledger.digest, settlement.receiptDigest)
    ledger.pending.delete(record.receipt.receiptDigest)
    if (outcome === 'unknown-effect') ledger.health = 'needs-reconciliation'
    const authSource: SemanticAuthorizationSourceV1 = {
      kind: 'semantic-authorization', version: 1, sessionId: record.agent.id,
      authoringCause: { kind: 'runtime', eventId: record.action.callId, reasonCode: 'preflight' },
      receipt: record.receipt,
    }
    const settlementSource: SemanticActionSettlementSourceV1 = {
      kind: 'semantic-action-settlement', version: 1, sessionId: record.agent.id,
      authoringCause: { kind: 'runtime', eventId: record.action.callId, reasonCode: 'post-action' },
      receipt: settlement,
    }
    const contexts = [
      createUserMessage({ source: authSource, content: [{ type: 'text', text: renderSemanticAuthorizationReceipt(authSource) }] }),
      createUserMessage({ source: settlementSource, content: [{ type: 'text', text: renderSemanticSettlementReceipt(settlementSource) }] }),
    ]
    return { contexts, settlement }
  }

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const record = pending.get(exec.token)
    if (record === undefined) return next()
    try {
      const downstream = await next()
      const { contexts } = settle(record, result, downstream.kind === 'block')
      const additionalContexts = [...downstream.additionalContexts ?? [], ...contexts]
      return { ...downstream, additionalContexts }
    } finally {
      pending.delete(exec.token)
    }
  })

  ctx.on('tools/result', (exec, result) => {
    const record = pending.get(exec.token)
    if (record !== undefined) {
      pending.delete(exec.token)
      const { contexts } = settle(record, result, false)
      for (const context of contexts) record.agent.inject(context)
    }
    const agent = exec.agent
    if (agent === undefined || exec.rootCallId !== exec.callId || !isSemanticToolName(exec.name) || !result.isError) return
    const callEvent = agent.session.events.findLast(event => event.type === 'tool/call' && event.data.callId === exec.callId)
    if (callEvent?.type !== 'tool/call') return
    const turn = callEvent.data.turn
    const prior = failures.get(agent)
    const count = prior !== undefined && prior.turn === turn ? prior.count + 1 : 1
    const lastError = resultErrorText(result)
    failures.set(agent, { turn, count, lastError })
    if (count >= config.maxProtocolFailures) {
      const health: SemanticProtocolHealth = config.preActionGate === 'enforce'
        ? { kind: 'blocked', reason: lastError }
        : { kind: 'degraded', reason: lastError }
      cache.setHealth(agent, health)
      if (health.kind === 'blocked') {
        agent.cancel({
          kind: 'hook',
          reason: `semantic strict protocol failed ${count} times in turn ${turn}; limit ${config.maxProtocolFailures}`,
        })
      }
    }
  })

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (finishApprovalInTurn(agent, turn) !== undefined) {
      repairs.delete(agent)
      return
    }
    const prior = repairs.get(agent)
    const count = prior !== undefined && prior.turn === turn ? prior.count + 1 : 1
    repairs.set(agent, { turn, count })
    const failure = failures.get(agent)
    const environmentCalls = agent.session.events.filter(event => event.type === 'tool/call'
      && event.data.turn === turn && !isSemanticToolName(event.data.name)).length
    if (!config.allowUnverifiedCompletion && count > config.maxAdaptiveCompletionRepairs) {
      throw new Error(`semantic completion remains unverified after ${config.maxAdaptiveCompletionRepairs} repair steps in turn ${turn}`)
    }
    if (config.preActionGate === 'off' && environmentCalls > 0
      && count > config.maxAdaptiveCompletionRepairs) {
      throw new Error('semantic completion cannot claim a safe unverified result after untracked environment actions')
    }
    const canDegrade = config.preActionGate !== 'enforce' && config.allowUnverifiedCompletion
      && (config.preActionGate !== 'off' || environmentCalls === 0)
      && (failure?.turn === turn && failure.count >= config.maxProtocolFailures
        || count > config.maxAdaptiveCompletionRepairs)
    const content = assistantTextInTurn(agent.session.events, turn)
    if (canDegrade && content !== undefined) {
      const baseline = semanticBaselineOf(agent, turn)
      const specification = semanticSpecificationOf(agent)?.specification
      const ledger = ledgerProjection(liveLedger(agent))
      if (baseline !== undefined) {
        assertUnverifiedCompletionAllowed(specification, ledger)
        const candidate = semanticCandidateOf(agent)?.candidate
        if (candidate !== undefined && candidate.content !== undefined && candidate.content !== content) {
          throw new Error('unverified completion content does not match the submitted candidate')
        }
        const reasonCode = failure?.turn === turn && failure.count >= config.maxProtocolFailures
          ? 'protocol-circuit-open'
          : 'completion-repair-exhausted'
        const source: SemanticDegradationSourceV1 = {
          kind: 'semantic-degradation', version: 1, sessionId: agent.id, turn,
          authoringCause: { kind: 'runtime', eventId: `turn-${turn}-stop`, reasonCode },
          receipt: {
            sessionId: agent.id, turn, reasonCode, contentDigest: semanticCompletionContentDigest(content),
            ...(candidate === undefined ? {} : { candidateDigest: candidate.candidateDigest }),
            baselineDigest: baseline.baselineDigest,
            policySnapshotDigest: baseline.policySnapshotDigest,
            actionLedgerDigest: ledger.ledgerDigest,
          },
        }
        agent.session.append('user/message', createUserMessage({
          source, content: [{ type: 'text', text: renderSemanticDegradationReceipt(source) }],
        }), { surfaceOp: 'append' })
        repairs.delete(agent)
        return
      }
    }
    const run = semanticRunOf(agent)
    const candidate = semanticCandidateOf(agent)
    const verification = semanticVerificationV2Of(agent)
    let text: string
    if (failure?.turn === turn && failure.count >= config.maxProtocolFailures) {
      text = `Semantic protocol stopped after ${failure.count} failed calls. Last error: ${failure.lastError}. ${config.preActionGate === 'enforce' ? 'Strict mode cannot return an unverified result.' : 'Return a safe ordinary result only if the next stopping boundary approves an unverified completion.'}`
    } else if (run === undefined) {
      text = `Call ${BEGIN_TOOL} once with a small plan and authority-backed requirement proposals.`
    } else if (run.snapshot.state.phase === 'exploring') {
      text = `Semantic run r${run.snapshot.state.revision} is exploring. Record only material progress, then call ${READY_TOOL}.`
    } else if (run.snapshot.state.phase === 'ready') {
      text = `Semantic run r${run.snapshot.state.revision} is ready. Submit the exact result through ${CANDIDATE_TOOL}.`
    } else if (candidate === undefined) {
      text = `Semantic candidate state is incomplete. Reopen progress and submit ${CANDIDATE_TOOL} again.`
    } else if (verification?.receipt.candidateDigest !== candidate.candidate.candidateDigest
      || verification.receipt.verdict !== 'passed') {
      text = `Call ${VERIFY_TOOL} for candidate ${candidate.candidate.candidateDigest}; revise the candidate when a required check is failed or unknown.`
    } else {
      text = `Call ${FINISH_TOOL} with expected_revision ${run.snapshot.state.revision} and candidate_digest ${candidate.candidate.candidateDigest}, then return its exact answer.`
    }
    agent.steer(createUserMessage({
      source: { kind: 'plugin', plugin: PLUGIN, form: 'notice', summary: 'Semantic completion requires another bounded step.' },
      content: [{ type: 'text', text }],
    }))
  })

  ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: AgentStatus }) => {
    if (status === 'idle') repairs.delete(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    cache.delete(agent)
    failures.delete(agent)
    repairs.delete(agent)
    liveLedgers.delete(agent)
  })
}

/** Incremental semantic run state, turn baselines, and durable command projection. */

import { isDeepStrictEqual } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { assertSemanticArtifacts, assertSemanticArtifactTransition } from './artifacts.ts'
import { isSha256Digest, semanticDigest } from './canonical.ts'
import { assertSemanticPlan } from './plan.ts'
import {
  decodeSemanticSpecificationSource,
  semanticSpecificationMessages,
} from './spec-projection.ts'
import type { SemanticArtifact, SemanticFact, SemanticGap, SemanticPlan } from './types.ts'
import {
  BEGIN_TOOL,
  CANDIDATE_TOOL,
  PROGRESS_TOOL,
  READY_TOOL,
  REPLAN_TOOL,
  isSemanticToolName,
} from './protocol.ts'

/** Runtime-authored identity and policy snapshot for one turn. */
export interface SemanticTurnBaseline {
  readonly sessionId: SessionId
  readonly turn: number
  readonly inputMessageIds: readonly string[]
  readonly inheritedSpecDigest?: string
  readonly policySnapshotDigest: string
  readonly baselineDigest: string
  readonly enforcementProfile: 'adaptive' | 'strict'
  readonly status: 'provisional'
}

/** Durable turn baseline inserted before the first model request. */
export interface SemanticTurnBaselineSourceV1 {
  readonly kind: 'semantic-baseline'
  readonly version: 1
  readonly sessionId: SessionId
  readonly turn: number
  readonly authoringCause: { readonly kind: 'turn-start'; readonly inputMessageIds: readonly string[] }
  readonly baseline: SemanticTurnBaseline
}

/** Minimal run identity consumed by action and final verification. */
export interface SemanticRunState {
  readonly sessionId: SessionId
  readonly turn: number
  readonly revision: number
  readonly specDigest: string
  readonly phase: 'exploring' | 'ready' | 'candidate' | 'verified' | 'degraded'
  readonly planRevision: number
  readonly activeNodeId?: string
  readonly metCriterionIds: readonly string[]
  readonly openGapIds: readonly string[]
  readonly currentArtifactRefs: readonly { readonly id: string; readonly version: number }[]
  readonly observationLedgerWatermark: string
  readonly materialStateDigest: string
}

/** Complete runtime projection reconstructed from small model commands. */
export interface SemanticRunSnapshot {
  readonly state: SemanticRunState
  readonly plan: SemanticPlan
  readonly criteria: readonly { readonly id: string; readonly description: string }[]
  readonly artifacts: readonly SemanticArtifact[]
  readonly facts: readonly SemanticFact[]
  readonly gaps: readonly SemanticGap[]
  readonly nextAction: string
}

/** Durable result of one accepted begin/progress/replan/ready command. */
export interface SemanticRunDeltaSourceV1 {
  readonly kind: 'semantic-run-delta'
  readonly version: 1
  readonly sessionId: SessionId
  readonly runCallId: CallId
  readonly command: 'begin' | 'progress' | 'replan' | 'ready' | 'candidate'
  readonly authoringCause: { readonly kind: 'tool-call'; readonly callId: CallId }
  readonly runStateDigest: string
  readonly snapshot: SemanticRunSnapshot
}

/** Latest run snapshot plus its durable source position. */
export interface SemanticRunPosition {
  readonly snapshot: SemanticRunSnapshot
  readonly runStateDigest: string
  readonly sourceSeq: number
}

/** Compute the domain-separated digest of a minimal run state. */
export function semanticRunStateDigest(state: SemanticRunState): string {
  return semanticDigest('run', 1, state)
}

/** Compute one turn baseline digest without its self-identifying field. */
export function semanticBaselineDigest(
  baseline: Omit<SemanticTurnBaseline, 'baselineDigest'>,
): string {
  return semanticDigest('baseline', 1, baseline)
}

function checkpointForRun(snapshot: SemanticRunSnapshot) {
  const met = new Set(snapshot.state.metCriterionIds)
  return {
    goal: { id: 'command-run', version: 1, statement: 'Command-v2 run', constraints: [] },
    criteria: snapshot.criteria.map(criterion => ({
      ...criterion,
      status: met.has(criterion.id) ? 'met' as const : 'unmet' as const,
      evidence: met.has(criterion.id) ? 'committed by semantic progress' : '',
      evidenceCallIds: [],
    })),
    plan: snapshot.plan,
    activeNodeId: snapshot.state.activeNodeId ?? null,
    artifacts: snapshot.artifacts,
    facts: snapshot.facts,
    observedCallIds: [],
    gaps: snapshot.gaps,
    nextAction: snapshot.nextAction,
    status: snapshot.state.phase === 'ready' || snapshot.state.phase === 'candidate'
      ? 'ready' as const
      : 'exploring' as const,
  }
}

function assertSemanticRunSnapshot(
  snapshot: SemanticRunSnapshot,
  command: SemanticRunDeltaSourceV1['command'],
): void {
  const state = snapshot.state
  assertSemanticPlan(snapshot.plan)
  if (!isSha256Digest(state.specDigest) || !isSha256Digest(state.observationLedgerWatermark)) {
    throw new Error('semantic run state carries an invalid digest')
  }
  const expectedPhase = command === 'ready' ? 'ready' : command === 'candidate' ? 'candidate' : 'exploring'
  if (state.phase !== expectedPhase || ((state.phase === 'ready' || state.phase === 'candidate')
    && state.activeNodeId !== undefined)) {
    throw new Error(`semantic run command ${command} has invalid phase or active node`)
  }
  if (state.activeNodeId !== undefined && !snapshot.plan.nodes.some(node => node.id === state.activeNodeId)) {
    throw new Error(`semantic run names unknown active node "${state.activeNodeId}"`)
  }
  const criterionIds = snapshot.criteria.map(criterion => criterion.id)
  if (new Set(criterionIds).size !== criterionIds.length
    || state.metCriterionIds.some(id => !criterionIds.includes(id))) {
    throw new Error('semantic run criteria or met criterion ids are invalid')
  }
  if (!isDeepStrictEqual(state.openGapIds, snapshot.gaps.map(gap => gap.id))) {
    throw new Error('semantic run open gap ids do not match its snapshot')
  }
  const latest = new Map<string, number>()
  for (const artifact of snapshot.artifacts) latest.set(artifact.id, artifact.version)
  const refs = [...latest].map(([id, version]) => ({ id, version }))
  if (!isDeepStrictEqual(state.currentArtifactRefs, refs)) {
    throw new Error('semantic run current artifact refs do not match its snapshot')
  }
  const material = {
    specDigest: state.specDigest, phase: state.phase, plan: snapshot.plan,
    criteria: snapshot.criteria, metCriterionIds: state.metCriterionIds,
    artifacts: snapshot.artifacts, facts: snapshot.facts, gaps: snapshot.gaps,
    nextAction: snapshot.nextAction,
    ...(state.activeNodeId === undefined ? {} : { activeNodeId: state.activeNodeId }),
  }
  if (state.materialStateDigest !== semanticDigest('material-state', 1, material)) {
    throw new Error('semantic run material state digest does not match its snapshot')
  }
  assertSemanticArtifacts(checkpointForRun(snapshot))
}

/** Compact model context for a runtime-authored baseline. */
export function renderSemanticBaselineReceipt(source: SemanticTurnBaselineSourceV1): string {
  return `Semantic ${source.baseline.enforcementProfile} baseline established for turn ${source.turn} (policy ${source.baseline.policySnapshotDigest}; baseline ${source.baseline.baselineDigest}). Ordinary low-risk observation does not wait for semantic_begin.`
}

/** Compact model context for one committed run delta. */
export function renderSemanticRunReceipt(source: SemanticRunDeltaSourceV1): string {
  const state = source.snapshot.state
  return `Semantic run r${state.revision} committed by ${source.command} (${state.phase}; plan p${state.planRevision}; ${state.openGapIds.length} open gaps; digest ${source.runStateDigest}).`
}

/** Test whether a message carries a turn baseline. */
export function isSemanticBaselineMessage(message: UserMessage): boolean {
  return message.source.kind === 'semantic-baseline'
}

/** Test whether a message carries a v1 run delta. */
export function isSemanticRunDeltaMessage(message: UserMessage): boolean {
  return message.source.kind === 'semantic-run-delta'
}

/** Visit direct and inbox occurrences of baseline or run messages. */
export function semanticRunMessages(event: SessionEvent): readonly UserMessage[] {
  const matching = (message: UserMessage): boolean => isSemanticBaselineMessage(message) || isSemanticRunDeltaMessage(message)
  if (event.type === 'user/message') return matching(event.data) ? [event.data] : []
  if (event.type !== 'agent/inbox/spliced') return []
  return event.data.inserted.filter(matching)
}

/** Validate a baseline source recovered from durable JSON. */
export function decodeSemanticBaselineSource(source: unknown): SemanticTurnBaselineSourceV1 {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) throw new Error('semantic baseline source must be an object')
  const candidate = source as Partial<SemanticTurnBaselineSourceV1>
  const baseline = candidate.baseline
  if (candidate.kind !== 'semantic-baseline' || candidate.version !== 1
    || typeof candidate.sessionId !== 'string' || typeof candidate.turn !== 'number'
    || baseline === undefined || candidate.authoringCause?.kind !== 'turn-start') {
    throw new Error('semantic baseline source fields are invalid')
  }
  if (!Number.isSafeInteger(candidate.turn) || candidate.turn < 1 || baseline.turn !== candidate.turn
    || baseline.sessionId !== candidate.sessionId || baseline.status !== 'provisional') {
    throw new Error('semantic baseline source ownership or turn is invalid')
  }
  const { baselineDigest: _digest, ...core } = baseline
  if (baseline.baselineDigest !== semanticBaselineDigest(core)) throw new Error('semantic baseline digest does not match its value')
  if (!isDeepStrictEqual(candidate.authoringCause.inputMessageIds, baseline.inputMessageIds)) {
    throw new Error('semantic baseline authoring inputs do not match its baseline')
  }
  return {
    kind: 'semantic-baseline', version: 1, sessionId: SessionId(candidate.sessionId), turn: candidate.turn,
    authoringCause: { kind: 'turn-start', inputMessageIds: [...baseline.inputMessageIds] },
    baseline,
  }
}

/** Validate a run-delta source recovered from durable JSON. */
export function decodeSemanticRunDeltaSource(source: unknown): SemanticRunDeltaSourceV1 {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) throw new Error('semantic run source must be an object')
  const candidate = source as Partial<SemanticRunDeltaSourceV1>
  if (candidate.kind !== 'semantic-run-delta' || candidate.version !== 1
    || typeof candidate.sessionId !== 'string' || typeof candidate.runCallId !== 'string'
    || typeof candidate.runStateDigest !== 'string' || candidate.snapshot === undefined
    || candidate.authoringCause?.kind !== 'tool-call' || candidate.authoringCause.callId !== candidate.runCallId
    || (candidate.command !== 'begin' && candidate.command !== 'progress'
      && candidate.command !== 'replan' && candidate.command !== 'ready' && candidate.command !== 'candidate')) {
    throw new Error('semantic run source fields are invalid')
  }
  const state = candidate.snapshot.state
  if (state.sessionId !== candidate.sessionId || candidate.runStateDigest !== semanticRunStateDigest(state)) {
    throw new Error('semantic run source ownership or digest is invalid')
  }
  if (state.revision < 1 || !Number.isSafeInteger(state.revision)
    || state.planRevision !== candidate.snapshot.plan.revision) {
    throw new Error('semantic run source revision is invalid')
  }
  assertSemanticRunSnapshot(candidate.snapshot, candidate.command)
  return {
    kind: 'semantic-run-delta', version: 1, sessionId: SessionId(candidate.sessionId),
    runCallId: CallId(candidate.runCallId), command: candidate.command,
    authoringCause: { kind: 'tool-call', callId: CallId(candidate.runCallId) },
    runStateDigest: candidate.runStateDigest, snapshot: candidate.snapshot,
  }
}

/** Fold baselines by owner and turn, rejecting conflicting duplicate records. */
export function foldSemanticBaselines(
  events: readonly SessionEvent[],
): ReadonlyMap<SessionId, ReadonlyMap<number, SemanticTurnBaseline>> {
  const result = new Map<SessionId, Map<number, SemanticTurnBaseline>>()
  const messages = new Map<MessageId, UserMessage>()
  const authorityInputs = new Set<string>()
  const turnStarts = new Map<number, number>()
  for (const event of events) {
    if (event.type === 'turn/start') turnStarts.set(event.data.turn, event.seq)
    const userMessages = event.type === 'user/message' ? [event.data]
      : event.type === 'agent/inbox/spliced' ? event.data.inserted : []
    for (const input of userMessages) if (input.source.kind === 'user') authorityInputs.add(input.id)
    for (const message of semanticRunMessages(event)) {
      if (!isSemanticBaselineMessage(message)) continue
      const priorMessage = messages.get(message.id)
      if (priorMessage !== undefined) {
        if (!isDeepStrictEqual(priorMessage, message)) throw new Error(`semantic baseline message "${message.id}" changed`)
        continue
      }
      const source = decodeSemanticBaselineSource(message.source)
      if (turnStarts.get(source.turn) === undefined || (turnStarts.get(source.turn) ?? event.seq) >= event.seq) {
        throw new Error(`semantic baseline turn ${source.turn} has no earlier turn/start`)
      }
      if (source.baseline.inputMessageIds.some(id => !authorityInputs.has(id))) {
        throw new Error(`semantic baseline turn ${source.turn} cites a missing non-user authority input`)
      }
      if (!isDeepStrictEqual(message.content, [{ type: 'text', text: renderSemanticBaselineReceipt(source) }])) {
        throw new Error(`semantic baseline message "${message.id}" content does not match its source`)
      }
      let turns = result.get(source.sessionId)
      if (turns === undefined) {
        turns = new Map()
        result.set(source.sessionId, turns)
      }
      const prior = turns.get(source.turn)
      if (prior !== undefined && !isDeepStrictEqual(prior, source.baseline)) {
        throw new Error(`semantic baseline turn ${source.turn} is reused with different content`)
      }
      turns.set(source.turn, source.baseline)
      messages.set(message.id, message)
    }
  }
  return result
}

/** Strictly fold the latest incremental run for every Session owner. */
export function foldSemanticRuns(events: readonly SessionEvent[]): ReadonlyMap<SessionId, SemanticRunPosition> {
  const calls = new Map<CallId, { readonly name: string; readonly turn: number; readonly seq: number }>()
  const successful = new Set<CallId>()
  const messages = new Map<MessageId, UserMessage>()
  const activeSpecifications = new Map<SessionId, string>()
  const latest = new Map<SessionId, SemanticRunPosition>()
  const toolForCommand = {
    begin: BEGIN_TOOL,
    progress: PROGRESS_TOOL,
    replan: REPLAN_TOOL,
    ready: READY_TOOL,
    candidate: CANDIDATE_TOOL,
  } as const
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, { name: event.data.name, turn: event.data.turn, seq: event.seq })
    if (event.type === 'tool/result' && event.data.message.content[0].isError !== true) successful.add(event.data.message.content[0].toolCallId)
    for (const message of semanticSpecificationMessages(event)) {
      const source = decodeSemanticSpecificationSource(message.source)
      activeSpecifications.set(source.sessionId, source.specDigest)
    }
    for (const message of semanticRunMessages(event)) {
      if (!isSemanticRunDeltaMessage(message)) continue
      const priorMessage = messages.get(message.id)
      if (priorMessage !== undefined) {
        if (!isDeepStrictEqual(priorMessage, message)) throw new Error(`semantic run message "${message.id}" changed`)
        continue
      }
      const source = decodeSemanticRunDeltaSource(message.source)
      if (!isDeepStrictEqual(message.content, [{ type: 'text', text: renderSemanticRunReceipt(source) }])) {
        throw new Error(`semantic run message "${message.id}" content does not match its source`)
      }
      const call = calls.get(source.runCallId)
      if (call?.name !== toolForCommand[source.command] || !successful.has(source.runCallId)
        || call.seq >= event.seq || call.turn !== source.snapshot.state.turn) {
        throw new Error(`semantic run delta is not linked to an earlier successful ${toolForCommand[source.command]} call/result`)
      }
      if (activeSpecifications.get(source.sessionId) !== source.snapshot.state.specDigest) {
        throw new Error('semantic run delta does not reference the active specification')
      }
      const prior = latest.get(source.sessionId)
      const expectedRevision = (prior?.snapshot.state.revision ?? 0) + 1
      if (source.snapshot.state.revision !== expectedRevision) {
        throw new Error(`semantic run revision must be ${expectedRevision}, got ${source.snapshot.state.revision}`)
      }
      if (prior !== undefined && source.command !== 'begin'
        && source.snapshot.state.specDigest !== prior.snapshot.state.specDigest) {
        throw new Error('semantic run delta cannot change the active specification')
      }
      if (prior !== undefined && source.command !== 'begin') {
        const priorCheckpoint = checkpointForRun(prior.snapshot)
        const nextCheckpoint = checkpointForRun(source.snapshot)
        assertSemanticArtifactTransition(priorCheckpoint, nextCheckpoint)
        if (source.command === 'replan') {
          if (source.snapshot.plan.revision !== prior.snapshot.plan.revision + 1
            || isDeepStrictEqual(source.snapshot.plan.nodes, prior.snapshot.plan.nodes)) {
            throw new Error('semantic replan must increment and replace the plan graph')
          }
        } else if (!isDeepStrictEqual(source.snapshot.plan, prior.snapshot.plan)) {
          throw new Error(`semantic ${source.command} cannot replace the plan`)
        }
      }
      const evidenceIds = [
        ...source.snapshot.facts.flatMap(fact => fact.evidenceCallIds),
        ...source.snapshot.artifacts.flatMap(artifact => artifact.evidenceCallIds),
      ]
      if (evidenceIds.some(callId => !successful.has(callId)
        || isSemanticToolName(calls.get(callId)?.name ?? ''))) {
        throw new Error('semantic run snapshot cites a call that is not a successful environment call')
      }
      messages.set(message.id, message)
      latest.set(source.sessionId, { snapshot: source.snapshot, runStateDigest: source.runStateDigest, sourceSeq: event.seq })
    }
  }
  return latest
}

/** Read the current turn baseline for one Agent. */
export function semanticBaselineOf(agent: Agent, turn?: number): SemanticTurnBaseline | undefined {
  const baselines = foldSemanticBaselines(agent.session.events).get(agent.id)
  if (turn !== undefined) return baselines?.get(turn)
  const currentTurn = agent.session.events.findLast(event => event.type === 'turn/start')?.data.turn
  return currentTurn === undefined ? undefined : baselines?.get(currentTurn)
}

/** Read the latest durable v2 run for one Agent. */
export function semanticRunOf(agent: Agent): SemanticRunPosition | undefined {
  return foldSemanticRuns(agent.session.events).get(agent.id)
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Runtime-authored turn identity and policy snapshot. */
    'semantic-baseline': SemanticTurnBaselineSourceV1
    /** Accepted incremental run-state command. */
    'semantic-run-delta': SemanticRunDeltaSourceV1
  }
}

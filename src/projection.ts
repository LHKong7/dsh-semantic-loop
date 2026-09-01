/** Completion, evidence, and benchmark projections over the durable Session log. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldSemanticActionLedger } from './authorization.ts'
import { foldSemanticCandidates, type SemanticCandidate } from './candidate.ts'
import { semanticDegradationOf } from './degradation.ts'
import { CAPABILITIES_TOOL, FINISH_TOOL, PLUGIN, STATE_TOOL, VERIFY_TOOL, isSemanticToolName, latestEnvironmentResultSeq } from './protocol.ts'
import { semanticProgressTimeline } from './progress.ts'
import { foldSemanticRuns, semanticRunOf, type SemanticRunPosition } from './run-state.ts'
import { semanticSpecificationOf } from './spec-projection.ts'
import { foldSemanticStateHistory, foldSemanticStatePosition, semanticEvidenceCallIds, semanticStateOf } from './state.ts'
import { foldSemanticVerificationPosition, semanticCheckpointHash } from './verification.ts'
import { foldSemanticVerificationV2Position } from './verification-v2.ts'
import type {
  SemanticCompletion,
  SemanticEvidence,
  SemanticTelemetry,
} from './types.ts'

/** Successful finish result paired with its validated model arguments. */
interface FinishApproval {
  readonly turn: number
  readonly revision: number
  readonly answer: string
  readonly callSeq: number
  readonly resultSeq: number
}

/** Why one turn has not reached a terminal semantic completion. */
export type SemanticCompletionStatus =
  | { readonly kind: 'complete'; readonly completion: SemanticCompletion }
  | { readonly kind: 'unapproved' }
  | {
    readonly kind: 'invalidated'
    readonly approval: FinishApproval
    readonly reason: 'state-changed' | 'stale-checkpoint' | 'unverified' | 'later-tool-call' | 'missing-final-answer' | 'mismatched-final-answer'
  }

/** Parse one potential semantic-finish call without trusting model JSON. */
function finishCall(event: SessionEvent<'tool/call'>): Omit<FinishApproval, 'turn' | 'resultSeq'> | undefined {
  if (event.data.name !== FINISH_TOOL) return undefined
  try {
    const args = JSON.parse(event.data.arguments) as Record<string, unknown>
    const revision = args['expected_revision']
    const answer = args['answer']
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return undefined
    if (typeof answer !== 'string' || answer.trim().length === 0) return undefined
    return { revision, answer: answer.trim(), callSeq: event.seq }
  } catch (_invalidModelArguments) {
    // ToolRuntime records the failed call; it cannot approve an answer.
    return undefined
  }
}

/** Read every successful finish approval in durable result order. */
function finishApprovals(events: readonly SessionEvent[], turn?: number): readonly FinishApproval[] {
  const calls = new Map<CallId, Omit<FinishApproval, 'turn' | 'resultSeq'>>()
  const approvals: FinishApproval[] = []
  for (const event of events) {
    if (event.type === 'tool/call' && (turn === undefined || event.data.turn === turn)) {
      const parsed = finishCall(event)
      if (parsed !== undefined) calls.set(event.data.callId, parsed)
      continue
    }
    if (event.type !== 'tool/result' || (turn !== undefined && event.data.turn !== turn)) continue
    const block = event.data.message.content[0]
    const call = calls.get(block.toolCallId)
    if (block.isError !== true && call !== undefined) {
      approvals.push({ turn: event.data.turn, ...call, resultSeq: event.seq })
    }
  }
  return approvals
}

/** Sequence through which one turn may influence its completion projection. */
function turnBoundarySeq(events: readonly SessionEvent[], turn: number): number {
  const end = events.find(event => event.type === 'turn/end' && event.data.turn === turn)
  if (end !== undefined) return end.seq
  const next = events.find(event => event.type === 'turn/start' && event.data.turn > turn)
  return next?.seq ?? Number.POSITIVE_INFINITY
}

/** Read assistant text and its event sequence from the latest message in one turn. */
function latestAssistantText(
  events: readonly SessionEvent[],
  turn: number,
): { readonly text?: string; readonly seq: number } | undefined {
  const event = events.findLast(candidate => candidate.type === 'assistant/message' && candidate.data.turn === turn)
  if (event?.type !== 'assistant/message') return undefined
  const text = event.data.message.content
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('')
    .trim()
  return { ...text.length === 0 ? {} : { text }, seq: event.seq }
}

function v2Delivery(candidate: SemanticCandidate, run: SemanticRunPosition): string {
  if (candidate.content !== undefined) return candidate.content
  const reference = candidate.artifact
  const artifact = reference === undefined ? undefined : run.snapshot.artifacts
    .find(item => item.id === reference.id && item.version === reference.version)
  if (artifact === undefined) throw new Error('semantic v2 completion references a missing code artifact')
  return `Verified code artifact ${artifact.id}@${artifact.version}: ${artifact.summary} (${artifact.locator}; digest ${artifact.contentDigest})`
}

function semanticCompletionV2StatusInTurn(
  agent: Agent,
  turn: number,
  events: readonly SessionEvent[],
): SemanticCompletionStatus | undefined {
  if (foldSemanticRuns(events).get(agent.id) === undefined) return undefined
  const calls = new Map<string, {
    readonly callSeq: number
    readonly revision: number
    readonly candidateDigest: string
  }>()
  const approvals: {
    readonly callSeq: number
    readonly resultSeq: number
    readonly revision: number
    readonly candidateDigest: string
  }[] = []
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.turn === turn && event.data.name === FINISH_TOOL) {
      try {
        const args = JSON.parse(event.data.arguments) as Record<string, unknown>
        if (typeof args['expected_revision'] === 'number' && Number.isSafeInteger(args['expected_revision'])
          && typeof args['candidate_digest'] === 'string') {
          calls.set(event.data.callId, {
            callSeq: event.seq,
            revision: args['expected_revision'],
            candidateDigest: args['candidate_digest'],
          })
        }
      } catch (_invalidV2FinishArguments) {
        continue
      }
    }
    if (event.type === 'tool/result' && event.data.turn === turn
      && event.data.message.content[0].isError !== true) {
      const call = calls.get(event.data.message.content[0].toolCallId)
      if (call !== undefined) approvals.push({ ...call, resultSeq: event.seq })
    }
  }
  const approval = approvals.at(-1)
  if (approval === undefined) return { kind: 'unapproved' }
  const beforeCall = events.filter(event => event.seq < approval.callSeq)
  const run = foldSemanticRuns(beforeCall).get(agent.id)
  const candidate = foldSemanticCandidates(beforeCall).get(agent.id)
  if (run === undefined || candidate === undefined
    || run.snapshot.state.revision !== approval.revision
    || candidate.candidate.candidateDigest !== approval.candidateDigest) {
    return {
      kind: 'invalidated',
      approval: { turn, revision: approval.revision, answer: '', callSeq: approval.callSeq, resultSeq: approval.resultSeq },
      reason: 'state-changed',
    }
  }
  const answer = v2Delivery(candidate.candidate, run)
  const projectedApproval: FinishApproval = {
    turn,
    revision: approval.revision,
    answer,
    callSeq: approval.callSeq,
    resultSeq: approval.resultSeq,
  }
  const verification = foldSemanticVerificationV2Position(beforeCall, agent.id)
  if (verification?.receipt.verdict !== 'passed'
    || verification.receipt.candidateDigest !== candidate.candidate.candidateDigest
    || verification.receipt.runStateDigest !== run.runStateDigest) {
    return { kind: 'invalidated', approval: projectedApproval, reason: 'unverified' }
  }
  if (events.some(event => event.type === 'tool/call' && event.data.turn === turn
    && event.seq > approval.resultSeq)) {
    return { kind: 'invalidated', approval: projectedApproval, reason: 'later-tool-call' }
  }
  const assistant = latestAssistantText(events, turn)
  if (assistant === undefined || assistant.seq <= approval.resultSeq || assistant.text === undefined) {
    return { kind: 'invalidated', approval: projectedApproval, reason: 'missing-final-answer' }
  }
  if (assistant.text !== answer) {
    return { kind: 'invalidated', approval: projectedApproval, reason: 'mismatched-final-answer' }
  }
  return { kind: 'complete', completion: { turn, revision: approval.revision, answer } }
}

/**
 * Reconstruct the semantic completion status for one turn.
 *
 * @param agent Agent whose Session log is projected.
 * @param turn Turn being evaluated at its stopping boundary or after completion.
 * @returns Terminal completion or the reason the latest approval is not terminal.
 */
export function semanticCompletionStatusInTurn(agent: Agent, turn: number): SemanticCompletionStatus {
  const events = agent.session.events
  const boundary = turnBoundarySeq(events, turn)
  const turnEvents = events.filter(event => event.seq < boundary)
  const v2 = semanticCompletionV2StatusInTurn(agent, turn, turnEvents)
  if (v2 !== undefined) return v2
  const approval = finishApprovals(turnEvents, turn).at(-1)
  if (approval === undefined) return { kind: 'unapproved' }

  const position = foldSemanticStatePosition(turnEvents, agent.id)
  if (position === undefined || position.state.revision !== approval.revision) {
    return { kind: 'invalidated', approval, reason: 'state-changed' }
  }
  const environmentResultSeq = latestEnvironmentResultSeq(turnEvents)
  if (environmentResultSeq !== undefined && position.checkpointCallSeq <= environmentResultSeq) {
    return { kind: 'invalidated', approval, reason: 'stale-checkpoint' }
  }
  const verification = foldSemanticVerificationPosition(
    turnEvents.filter(event => event.seq < approval.callSeq),
    agent.id,
  )
  if (verification === undefined || verification.receipt.verdict !== 'passed'
    || verification.receipt.revision !== approval.revision
    || verification.receipt.checkpointHash !== semanticCheckpointHash(position.state.checkpoint)) {
    return { kind: 'invalidated', approval, reason: 'unverified' }
  }
  if (turnEvents.some(event => event.type === 'tool/call' && event.data.turn === turn
    && event.seq > approval.resultSeq)) {
    return { kind: 'invalidated', approval, reason: 'later-tool-call' }
  }
  const assistant = latestAssistantText(turnEvents, turn)
  if (assistant === undefined || assistant.seq <= approval.resultSeq || assistant.text === undefined) {
    return { kind: 'invalidated', approval, reason: 'missing-final-answer' }
  }
  if (assistant.text !== approval.answer) {
    return { kind: 'invalidated', approval, reason: 'mismatched-final-answer' }
  }
  return {
    kind: 'complete',
    completion: { turn, revision: approval.revision, answer: approval.answer },
  }
}

/**
 * Reconstruct one terminal semantic completion for benchmark extraction.
 *
 * @param agent Agent whose Session log is projected.
 * @param turn Completed turn to inspect.
 * @returns Terminal completion, or `undefined` when the protocol did not complete.
 */
export function semanticCompletionInTurn(agent: Agent, turn: number): SemanticCompletion | undefined {
  const status = semanticCompletionStatusInTurn(agent, turn)
  return status.kind === 'complete' ? status.completion : undefined
}

/**
 * Resolve successful environment-tool observations cited by the latest checkpoint.
 *
 * @param agent Agent whose owner-scoped semantic state is projected.
 * @returns Cited call/result pairs in checkpoint order.
 */
export function semanticEvidenceOf(agent: Agent): readonly SemanticEvidence[] {
  const state = semanticStateOf(agent)
  const run = state === undefined ? semanticRunOf(agent) : undefined
  const callIds = state !== undefined
    ? semanticEvidenceCallIds(state.checkpoint)
    : [...new Set([
        ...run?.snapshot.facts.flatMap(fact => fact.evidenceCallIds) ?? [],
        ...run?.snapshot.artifacts.flatMap(artifact => artifact.evidenceCallIds) ?? [],
      ])]
  if (callIds.length === 0) return []
  const wanted = new Set(callIds)
  const calls = new Map<CallId, SessionEvent<'tool/call'>>()
  const evidence = new Map<CallId, SemanticEvidence>()
  for (const event of agent.session.events) {
    if (event.type === 'tool/call') {
      if (wanted.has(event.data.callId)) calls.set(event.data.callId, event)
      continue
    }
    if (event.type !== 'tool/result') continue
    const block = event.data.message.content[0]
    if (block.isError === true || !wanted.has(block.toolCallId)) continue
    // The semantic state fold proves every wanted id names an earlier successful environment call.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- replay relation above
    const call = calls.get(block.toolCallId)!
    evidence.set(block.toolCallId, {
      callId: block.toolCallId,
      name: call.data.name,
      arguments: call.data.arguments,
      content: block.content,
      turn: event.data.turn,
      step: event.data.step,
    })
  }
  return callIds.map((callId) => {
    // The semantic state fold proves the successful result and evidence projection are paired.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- replay relation above
    return evidence.get(callId)!
  })
}

/**
 * Derive semantic-control and environment-tool counters for paired evaluation.
 *
 * @param agent Agent whose Session log is measured.
 * @returns Log-derived counters; model tokens and wall time remain runner-owned.
 */
export function semanticTelemetryOf(agent: Agent): SemanticTelemetry {
  const state = semanticStateOf(agent)
  const specification = semanticSpecificationOf(agent)
  const run = semanticRunOf(agent)
  const events = agent.session.events
  const calls = events.filter((event): event is SessionEvent<'tool/call'> => event.type === 'tool/call')
  const callNames = new Map(calls.map(event => [event.data.callId, event.data.name]))
  const callEvents = new Map(calls.map(event => [event.data.callId, event]))
  let successfulEnvironmentToolCalls = 0
  let successfulEnvironmentToolCallsInRun = 0
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const block = event.data.message.content[0]
    const toolName = callNames.get(block.toolCallId)
    if (block.isError !== true && toolName !== undefined && !isSemanticToolName(toolName)) {
      successfulEnvironmentToolCalls++
      if (callEvents.get(block.toolCallId)?.data.turn === run?.snapshot.state.turn) {
        successfulEnvironmentToolCallsInRun++
      }
    }
  }
  const verificationMessages = new Map<string, UserMessage>()
  const candidateMessages = new Map<string, UserMessage>()
  const v2MaterialMessages = new Map<string, UserMessage>()
  for (const event of events) {
    const messages = event.type === 'user/message'
      ? [event.data]
      : event.type === 'agent/inbox/spliced' ? event.data.inserted : []
    for (const message of messages) {
      if (message.source.kind === 'semantic-verification') verificationMessages.set(message.id, message)
      if (message.source.kind === 'semantic-candidate') candidateMessages.set(message.id, message)
      if (message.source.kind === 'semantic-run-delta'
        && (message.source.command === 'begin' || message.source.command === 'progress'
          || message.source.command === 'replan')) v2MaterialMessages.set(message.id, message)
    }
  }
  const progress = semanticProgressTimeline(foldSemanticStateHistory(events, agent.id))
  const actionLedger = foldSemanticActionLedger(events, agent.id)
  const evidenceCallIds = state !== undefined
    ? semanticEvidenceCallIds(state.checkpoint)
    : [...new Set([
        ...run?.snapshot.facts.flatMap(fact => fact.evidenceCallIds) ?? [],
        ...run?.snapshot.artifacts.flatMap(artifact => artifact.evidenceCallIds) ?? [],
      ])]
  return {
    checkpointRevisions: state?.revision ?? run?.snapshot.state.revision ?? 0,
    specificationVersion: specification?.specification.version ?? 0,
    runRevision: run?.snapshot.state.revision ?? 0,
    candidateSubmissions: candidateMessages.size,
    actionAuthorizations: actionLedger.entries.filter(entry => 'decision' in entry).length,
    actionSettlements: actionLedger.entries.filter(entry => 'outcome' in entry).length,
    unverifiedCompletions: semanticDegradationOf(agent) === undefined ? 0 : 1,
    semanticToolCalls: calls.filter(event => isSemanticToolName(event.data.name)).length,
    semanticToolFailures: events.filter(event => {
      if (event.type !== 'tool/result') return false
      const block = event.data.message.content[0]
      const toolName = callNames.get(block.toolCallId)
      return block.isError === true && toolName !== undefined && isSemanticToolName(toolName)
    }).length,
    stateReads: calls.filter(event => event.data.name === STATE_TOOL).length,
    capabilityReads: calls.filter(event => event.data.name === CAPABILITIES_TOOL).length,
    environmentToolCalls: calls.filter(event => !isSemanticToolName(event.data.name)).length,
    successfulEnvironmentToolCalls,
    finishAttempts: calls.filter(event => event.data.name === FINISH_TOOL).length,
    verificationAttempts: calls.filter(event => event.data.name === VERIFY_TOOL).length,
    verificationReceipts: verificationMessages.size,
    passedVerifications: [...verificationMessages.values()].filter(message =>
      message.source.kind === 'semantic-verification' && message.source.receipt.verdict === 'passed').length,
    materialProgressRevisions: state === undefined
      ? v2MaterialMessages.size
      : progress.filter(item => item.materialChanges.length > 0).length,
    stagnantCheckpointRevisions: progress.filter(item => item.materialChanges.length === 0).length,
    currentStagnationStreak: progress.at(-1)?.stagnantRevisions ?? 0,
    acceptedFinishResults: events.filter(event => event.type === 'tool/result'
      && event.data.message.content[0].isError !== true
      && callNames.get(event.data.message.content[0].toolCallId) === FINISH_TOOL).length,
    repairSteps: events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin' && event.data.source.plugin === PLUGIN).length,
    evidenceToolResults: evidenceCallIds.length,
    observedToolResults: state?.checkpoint.observedCallIds.length ?? successfulEnvironmentToolCallsInRun,
  }
}

/** Completion, evidence, and benchmark projections over the durable Session log. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CAPABILITIES_TOOL, FINISH_TOOL, PLUGIN, STATE_TOOL, VERIFY_TOOL, isSemanticToolName, latestEnvironmentResultSeq } from './protocol.ts'
import { semanticProgressTimeline } from './progress.ts'
import { foldSemanticStateHistory, foldSemanticStatePosition, semanticEvidenceCallIds, semanticStateOf } from './state.ts'
import { foldSemanticVerificationPosition, semanticCheckpointHash } from './verification.ts'
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
  if (state === undefined) return []
  const callIds = semanticEvidenceCallIds(state.checkpoint)
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
    // The checkpoint fold already proves every wanted id names an earlier successful environment call.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- owned replay relation above
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
    // The checkpoint fold proves the successful result and evidence projection are paired.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- owned replay relation above
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
  const events = agent.session.events
  const calls = events.filter((event): event is SessionEvent<'tool/call'> => event.type === 'tool/call')
  const callNames = new Map(calls.map(event => [event.data.callId, event.data.name]))
  let successfulEnvironmentToolCalls = 0
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const block = event.data.message.content[0]
    const toolName = callNames.get(block.toolCallId)
    if (block.isError !== true && toolName !== undefined && !isSemanticToolName(toolName)) {
      successfulEnvironmentToolCalls++
    }
  }
  const verificationMessages = new Map<string, UserMessage>()
  for (const event of events) {
    const messages = event.type === 'user/message'
      ? [event.data]
      : event.type === 'agent/inbox/spliced' ? event.data.inserted : []
    for (const message of messages) {
      if (message.source.kind === 'semantic-verification') verificationMessages.set(message.id, message)
    }
  }
  const progress = semanticProgressTimeline(foldSemanticStateHistory(events, agent.id))
  return {
    checkpointRevisions: state?.revision ?? 0,
    semanticToolCalls: calls.filter(event => isSemanticToolName(event.data.name)).length,
    stateReads: calls.filter(event => event.data.name === STATE_TOOL).length,
    capabilityReads: calls.filter(event => event.data.name === CAPABILITIES_TOOL).length,
    environmentToolCalls: calls.filter(event => !isSemanticToolName(event.data.name)).length,
    successfulEnvironmentToolCalls,
    finishAttempts: calls.filter(event => event.data.name === FINISH_TOOL).length,
    verificationAttempts: calls.filter(event => event.data.name === VERIFY_TOOL).length,
    verificationReceipts: verificationMessages.size,
    passedVerifications: [...verificationMessages.values()].filter(message =>
      message.source.kind === 'semantic-verification' && message.source.receipt.verdict === 'passed').length,
    materialProgressRevisions: progress.filter(item => item.materialChanges.length > 0).length,
    stagnantCheckpointRevisions: progress.filter(item => item.materialChanges.length === 0).length,
    currentStagnationStreak: progress.at(-1)?.stagnantRevisions ?? 0,
    acceptedFinishResults: finishApprovals(events).length,
    repairSteps: events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin' && event.data.source.plugin === PLUGIN).length,
    evidenceToolResults: state === undefined ? 0 : semanticEvidenceCallIds(state.checkpoint).length,
    observedToolResults: state?.checkpoint.observedCallIds.length ?? 0,
  }
}

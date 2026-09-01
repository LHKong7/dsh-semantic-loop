/** Exact final candidates and their durable digest binding. */

import { isDeepStrictEqual } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { foldSemanticActionLedger } from './authorization.ts'
import { isSha256Digest, semanticDigest } from './canonical.ts'
import { CANDIDATE_TOOL } from './protocol.ts'
import { foldSemanticRuns } from './run-state.ts'
import { foldSemanticSpecifications } from './spec-projection.ts'
import type { SemanticArtifactRef } from './types.ts'

/** Immutable candidate subject passed to final verification. */
export interface SemanticCandidate {
  readonly id: string
  readonly specDigest: string
  readonly runStateDigest: string
  readonly kind: 'final-answer' | 'code-artifact' | 'structured-output'
  readonly content?: string
  readonly artifact?: SemanticArtifactRef
  readonly dependencyLedgerWatermark: string
  readonly dependencyResourceDigests: readonly string[]
  readonly candidateDigest: string
}

/** Durable source committed by one successful candidate tool call. */
export interface SemanticCandidateSourceV1 {
  readonly kind: 'semantic-candidate'
  readonly version: 1
  readonly sessionId: SessionId
  readonly candidateCallId: CallId
  readonly authoringCause: { readonly kind: 'tool-call'; readonly callId: CallId }
  readonly candidate: SemanticCandidate
}

/** Latest candidate plus the source position that committed it. */
export interface SemanticCandidatePosition {
  readonly candidate: SemanticCandidate
  readonly sourceSeq: number
}

/** Compute a candidate digest without its self-identifying field. */
export function semanticCandidateDigest(candidate: Omit<SemanticCandidate, 'candidateDigest'>): string {
  return semanticDigest('candidate', 1, candidate)
}

/** Validate one complete candidate and its conditional content fields. */
export function assertSemanticCandidate(candidate: SemanticCandidate): void {
  if (candidate.id.length === 0 || candidate.id.trim() !== candidate.id) throw new Error('semantic candidate id must be non-empty')
  const hasContent = candidate.content !== undefined
  const hasArtifact = candidate.artifact !== undefined
  if (candidate.kind === 'code-artifact' ? hasContent || !hasArtifact : !hasContent || hasArtifact) {
    throw new Error(`semantic candidate kind "${candidate.kind}" has invalid content fields`)
  }
  if (candidate.content !== undefined && (candidate.content.length === 0 || candidate.content.trim() !== candidate.content)) {
    throw new Error('semantic candidate content must be non-empty and already trimmed')
  }
  if (!isSha256Digest(candidate.specDigest) || !isSha256Digest(candidate.runStateDigest)
    || !isSha256Digest(candidate.dependencyLedgerWatermark)
    || candidate.dependencyResourceDigests.some(digest => !isSha256Digest(digest))) {
    throw new Error('semantic candidate dependencies must use SHA-256 digests')
  }
  const { candidateDigest: _digest, ...core } = candidate
  if (candidate.candidateDigest !== semanticCandidateDigest(core)) {
    throw new Error('semantic candidate digest does not match its content')
  }
}

/** Compact model-visible receipt for one exact candidate. */
export function renderSemanticCandidateReceipt(source: SemanticCandidateSourceV1): string {
  return `Semantic candidate ${source.candidate.id} committed (${source.candidate.kind}; digest ${source.candidate.candidateDigest}). Verify this exact digest before semantic_finish.`
}

/** Test whether a message carries candidate provenance. */
export function isSemanticCandidateMessage(message: UserMessage): boolean {
  return message.source.kind === 'semantic-candidate'
}

/** Visit direct and inbox occurrences of candidate messages. */
export function semanticCandidateMessages(event: SessionEvent): readonly UserMessage[] {
  if (event.type === 'user/message') return isSemanticCandidateMessage(event.data) ? [event.data] : []
  if (event.type !== 'agent/inbox/spliced') return []
  return event.data.inserted.filter(isSemanticCandidateMessage)
}

/** Decode and validate candidate provenance recovered from durable JSON. */
export function decodeSemanticCandidateSource(source: unknown): SemanticCandidateSourceV1 {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) throw new Error('semantic candidate source must be an object')
  const candidate = source as Partial<SemanticCandidateSourceV1>
  if (candidate.kind !== 'semantic-candidate' || candidate.version !== 1
    || typeof candidate.sessionId !== 'string' || typeof candidate.candidateCallId !== 'string'
    || candidate.candidate === undefined || candidate.authoringCause?.kind !== 'tool-call'
    || candidate.authoringCause.callId !== candidate.candidateCallId) {
    throw new Error('semantic candidate source fields are invalid')
  }
  assertSemanticCandidate(candidate.candidate)
  return {
    kind: 'semantic-candidate', version: 1, sessionId: SessionId(candidate.sessionId),
    candidateCallId: CallId(candidate.candidateCallId),
    authoringCause: { kind: 'tool-call', callId: CallId(candidate.candidateCallId) },
    candidate: candidate.candidate,
  }
}

/** Strictly fold the latest candidate for every owning Session. */
export function foldSemanticCandidates(events: readonly SessionEvent[]): ReadonlyMap<SessionId, SemanticCandidatePosition> {
  const calls = new Map<CallId, number>()
  const successful = new Set<CallId>()
  const messages = new Map<MessageId, UserMessage>()
  const latest = new Map<SessionId, SemanticCandidatePosition>()
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.name === CANDIDATE_TOOL) calls.set(event.data.callId, event.seq)
    if (event.type === 'tool/result' && event.data.message.content[0].isError !== true) successful.add(event.data.message.content[0].toolCallId)
    for (const message of semanticCandidateMessages(event)) {
      const prior = messages.get(message.id)
      if (prior !== undefined) {
        if (!isDeepStrictEqual(prior, message)) throw new Error(`semantic candidate message "${message.id}" changed`)
        continue
      }
      const source = decodeSemanticCandidateSource(message.source)
      if (!isDeepStrictEqual(message.content, [{ type: 'text', text: renderSemanticCandidateReceipt(source) }])) {
        throw new Error(`semantic candidate message "${message.id}" content does not match its source`)
      }
      const callSeq = calls.get(source.candidateCallId)
      if (callSeq === undefined || callSeq >= event.seq || !successful.has(source.candidateCallId)) {
        throw new Error(`semantic candidate is not linked to an earlier successful ${CANDIDATE_TOOL} call/result`)
      }
      const before = events.filter(candidate => candidate.seq < event.seq)
      const specification = foldSemanticSpecifications(before).get(source.sessionId)
      const run = foldSemanticRuns(before).get(source.sessionId)
      const ledger = foldSemanticActionLedger(before, source.sessionId)
      if (specification?.specDigest !== source.candidate.specDigest
        || run?.runStateDigest !== source.candidate.runStateDigest
        || run.snapshot.state.phase !== 'candidate'
        || ledger.ledgerDigest !== source.candidate.dependencyLedgerWatermark) {
        throw new Error('semantic candidate does not match its specification, candidate-phase run, or action ledger')
      }
      messages.set(message.id, message)
      latest.set(source.sessionId, { candidate: source.candidate, sourceSeq: event.seq })
    }
  }
  return latest
}

/** Read the latest exact candidate owned by one Agent. */
export function semanticCandidateOf(agent: Agent): SemanticCandidatePosition | undefined {
  return foldSemanticCandidates(agent.session.events).get(agent.id)
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Exact final candidate submitted before verification. */
    'semantic-candidate': SemanticCandidateSourceV1
  }
}

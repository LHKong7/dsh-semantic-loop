/** Bounded semantic protocol degradation and exact unverified completion receipts. */

import { isDeepStrictEqual } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SemanticActionLedgerProjection } from './authorization.ts'
import { foldSemanticActionLedger } from './authorization.ts'
import { foldSemanticCandidates } from './candidate.ts'
import { foldSemanticBaselines } from './run-state.ts'
import type { SemanticSpecification } from './specification.ts'
import { foldSemanticSpecifications } from './spec-projection.ts'
import { isSha256Digest, semanticDigest } from './canonical.ts'

/** Health of the model-facing semantic command protocol. */
export type SemanticProtocolHealth =
  | { readonly kind: 'healthy' }
  | { readonly kind: 'degraded'; readonly reason: string }
  | { readonly kind: 'blocked'; readonly reason: string }

/** Exact content and safety state approved for an unverified turn ending. */
export interface SemanticDegradationReceipt {
  readonly sessionId: SessionId
  readonly turn: number
  readonly reasonCode: string
  readonly contentDigest: string
  readonly candidateDigest?: string
  readonly baselineDigest: string
  readonly policySnapshotDigest: string
  readonly actionLedgerDigest: string
}

/** Runtime-authored durable unverified-completion source. */
export interface SemanticDegradationSourceV1 {
  readonly kind: 'semantic-degradation'
  readonly version: 1
  readonly sessionId: SessionId
  readonly turn: number
  readonly authoringCause: { readonly kind: 'runtime'; readonly eventId: string; readonly reasonCode: string }
  readonly receipt: SemanticDegradationReceipt
}

/** Compute the digest of exact assistant content at the stopping boundary. */
export function semanticCompletionContentDigest(content: string): string {
  return semanticDigest('completion-content', 1, content)
}

/** Validate the safety prerequisites for an unverified completion. */
export function assertUnverifiedCompletionAllowed(
  specification: SemanticSpecification | undefined,
  ledger: SemanticActionLedgerProjection,
): void {
  const requiredFinal = specification === undefined ? [] : [
    ...specification.requirements,
    ...specification.forbiddenStates,
  ].filter(requirement => requirement.required
    && (requirement.phase === 'final-candidate' || requirement.phase === 'always'))
  const requiredQuestions = specification?.openQuestions.filter(question => question.required
    && question.status === 'open'
    && (question.blockedPhases.includes('final-candidate') || question.blockedPhases.includes('always'))) ?? []
  if (requiredFinal.length > 0 || requiredQuestions.length > 0) {
    throw new Error('unverified completion is disabled by required final-output obligations or open questions')
  }
  if (ledger.health !== 'safe' || ledger.pendingAuthorizationDigests.length > 0) {
    throw new Error(`unverified completion requires a complete safe action ledger; current health is ${ledger.health}`)
  }
}

/** Render the low-cardinality status record shown in Session history. */
export function renderSemanticDegradationReceipt(source: SemanticDegradationSourceV1): string {
  return `Semantic status: unverified\nReason: ${source.receipt.reasonCode}\nSafety ledger: complete; no unresolved hard-safety violation\nContent: ${source.receipt.contentDigest}`
}

/** Test whether a message carries an unverified-completion receipt. */
export function isSemanticDegradationMessage(message: UserMessage): boolean {
  return message.source.kind === 'semantic-degradation'
}

/** Visit direct and inbox occurrences of degradation messages. */
export function semanticDegradationMessages(event: SessionEvent): readonly UserMessage[] {
  if (event.type === 'user/message') return isSemanticDegradationMessage(event.data) ? [event.data] : []
  if (event.type !== 'agent/inbox/spliced') return []
  return event.data.inserted.filter(isSemanticDegradationMessage)
}

/** Strictly fold the latest exact unverified completion for one owner. */
export function foldSemanticDegradation(
  events: readonly SessionEvent[],
  sessionId: SessionId,
): SemanticDegradationReceipt | undefined {
  const messages = new Map<MessageId, UserMessage>()
  let latest: SemanticDegradationReceipt | undefined
  for (const event of events) {
    if (latest !== undefined && (event.type === 'tool/call' || event.type === 'assistant/message')
      && event.data.turn === latest.turn) latest = undefined
    for (const message of semanticDegradationMessages(event)) {
      const prior = messages.get(message.id)
      if (prior !== undefined) {
        if (!isDeepStrictEqual(prior, message)) throw new Error(`semantic degradation message "${message.id}" changed`)
        continue
      }
      if (message.source.kind !== 'semantic-degradation') continue
      const source = message.source
      if (source.version !== 1 || source.sessionId !== sessionId || source.turn !== source.receipt.turn
        || source.authoringCause.reasonCode !== source.receipt.reasonCode
        || !isSha256Digest(source.receipt.contentDigest)
        || !isSha256Digest(source.receipt.baselineDigest)
        || !isSha256Digest(source.receipt.policySnapshotDigest)
        || !isSha256Digest(source.receipt.actionLedgerDigest)) {
        throw new Error('semantic degradation source fields are invalid')
      }
      if (!isDeepStrictEqual(message.content, [{ type: 'text', text: renderSemanticDegradationReceipt(source) }])) {
        throw new Error('semantic degradation message content mismatch')
      }
      const before = events.filter(candidate => candidate.seq < event.seq)
      const assistant = before.findLast(candidate => candidate.type === 'assistant/message'
        && candidate.data.turn === source.turn)
      const content = assistant?.type === 'assistant/message'
        ? assistant.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim()
        : undefined
      const baseline = foldSemanticBaselines(before).get(sessionId)?.get(source.turn)
      const ledger = foldSemanticActionLedger(before, sessionId)
      const specification = foldSemanticSpecifications(before).get(sessionId)?.specification
      const candidate = foldSemanticCandidates(before).get(sessionId)?.candidate
      if (content === undefined || source.receipt.contentDigest !== semanticCompletionContentDigest(content)
        || baseline?.baselineDigest !== source.receipt.baselineDigest
        || baseline.policySnapshotDigest !== source.receipt.policySnapshotDigest
        || ledger.ledgerDigest !== source.receipt.actionLedgerDigest
        || source.receipt.candidateDigest !== undefined
          && source.receipt.candidateDigest !== candidate?.candidateDigest
        || candidate?.content !== undefined && candidate.content !== content) {
        throw new Error('semantic degradation receipt does not match its exact content, baseline, candidate, or action ledger')
      }
      assertUnverifiedCompletionAllowed(specification, ledger)
      messages.set(message.id, message)
      latest = source.receipt
    }
  }
  return latest
}

/** Read one Agent's latest unverified-completion receipt. */
export function semanticDegradationOf(agent: Agent): SemanticDegradationReceipt | undefined {
  return foldSemanticDegradation(agent.session.events, agent.id)
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Exact unverified completion approved by the runtime. */
    'semantic-degradation': SemanticDegradationSourceV1
  }
}

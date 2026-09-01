/** Replayable proof, checker, and counterexample references. */

import { isDeepStrictEqual } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { isSha256Digest, semanticDigest } from './canonical.ts'

/** Immutable verifier-produced proof artifact. */
export interface SemanticProofRef {
  readonly id: string
  readonly format: 'smt-proof' | 'lean-object' | 'coq-term' | 'dafny-report'
    | 'schema-report' | 'model-check-trace' | 'deterministic-report'
  readonly locator: string
  readonly contentDigest: string
  readonly subjectDigest: string
  readonly specificationDigest: string
  readonly verifierId: string
  readonly verifierVersion: string
  readonly verifierExecutableDigest?: string
  readonly checkerId?: string
  readonly checkerVersion?: string
  readonly checkerReceiptDigest?: string
  readonly checkerCallId?: string
}

/** Runtime-minted result of checking one proof artifact. */
export interface SemanticProofCheckReceipt {
  readonly sessionId: SessionId
  readonly checkerCallId: string
  readonly checkerId: string
  readonly checkerVersion: string
  readonly specificationDigest: string
  readonly subjectDigest: string
  readonly proofContentDigest: string
  readonly verdict: 'accepted' | 'rejected' | 'unknown'
  readonly receiptDigest: string
}

/** Durable provenance for one checker result. */
export interface SemanticProofCheckSourceV1 {
  readonly kind: 'semantic-proof-check'
  readonly version: 1
  readonly sessionId: SessionId
  readonly authoringCause: { readonly kind: 'runtime'; readonly eventId: string; readonly reasonCode: 'checker-result' }
  readonly receipt: SemanticProofCheckReceipt
}

/** Immutable verifier-produced counterexample artifact. */
export interface SemanticCounterexampleRef {
  readonly id: string
  readonly obligationId: string
  readonly format: 'json' | 'smt-model' | 'trace' | 'text'
  readonly summary: string
  readonly locator: string
  readonly contentDigest: string
  readonly minimized: boolean
  readonly replay?: {
    readonly runnerId: string
    readonly runnerVersion: string
    readonly inputDigest: string
  }
}

const SAFE_LOCATOR = /^(?:semantic|artifact):\/\/[A-Za-z0-9._~:/-]+$/u

function requiredText(value: string, label: string): void {
  if (value.length === 0 || value.trim() !== value) throw new Error(`${label} must be non-empty and already trimmed`)
}

/**
 * Validate a proof reference before it can influence assurance.
 *
 * @param proof Proof reference to validate.
 */
export function assertSemanticProofRef(proof: SemanticProofRef): void {
  requiredText(proof.id, 'semantic proof id')
  requiredText(proof.verifierId, 'semantic proof verifierId')
  requiredText(proof.verifierVersion, 'semantic proof verifierVersion')
  if (!SAFE_LOCATOR.test(proof.locator)) throw new Error(`semantic proof "${proof.id}" locator must be an opaque semantic or artifact URI`)
  for (const [label, digest] of [
    ['contentDigest', proof.contentDigest],
    ['subjectDigest', proof.subjectDigest],
    ['specificationDigest', proof.specificationDigest],
  ] as const) {
    if (!isSha256Digest(digest)) throw new Error(`semantic proof "${proof.id}" ${label} must be a SHA-256 digest`)
  }
  const checkerFields = [proof.checkerId, proof.checkerVersion, proof.checkerReceiptDigest, proof.checkerCallId]
  const checkerCount = checkerFields.filter(value => value !== undefined).length
  if (checkerCount !== 0 && checkerCount !== checkerFields.length) {
    throw new Error(`semantic proof "${proof.id}" checker fields must be supplied together`)
  }
  if (proof.checkerReceiptDigest !== undefined && !isSha256Digest(proof.checkerReceiptDigest)) {
    throw new Error(`semantic proof "${proof.id}" checkerReceiptDigest must be a SHA-256 digest`)
  }
}

/**
 * Validate a counterexample reference before publication.
 *
 * @param counterexample Counterexample reference to validate.
 */
export function assertSemanticCounterexampleRef(counterexample: SemanticCounterexampleRef): void {
  requiredText(counterexample.id, 'semantic counterexample id')
  requiredText(counterexample.obligationId, 'semantic counterexample obligationId')
  requiredText(counterexample.summary, 'semantic counterexample summary')
  if (!SAFE_LOCATOR.test(counterexample.locator)) {
    throw new Error(`semantic counterexample "${counterexample.id}" locator must be an opaque semantic or artifact URI`)
  }
  if (!isSha256Digest(counterexample.contentDigest)) {
    throw new Error(`semantic counterexample "${counterexample.id}" contentDigest must be a SHA-256 digest`)
  }
  if (counterexample.replay !== undefined && !isSha256Digest(counterexample.replay.inputDigest)) {
    throw new Error(`semantic counterexample "${counterexample.id}" replay inputDigest must be a SHA-256 digest`)
  }
}

/** Compute the canonical digest of a proof-check receipt without its digest field. */
export function semanticProofCheckReceiptDigest(
  receipt: Omit<SemanticProofCheckReceipt, 'receiptDigest'>,
): string {
  return semanticDigest('proof-check', 1, receipt)
}

/** Render one independently checked proof receipt. */
export function renderSemanticProofCheckReceipt(source: SemanticProofCheckSourceV1): string {
  return `Semantic proof check ${source.receipt.verdict} by ${source.receipt.checkerId}@${source.receipt.checkerVersion} (receipt ${source.receipt.receiptDigest}).`
}

/** Test whether a message carries a proof-check receipt. */
export function isSemanticProofCheckMessage(message: UserMessage): boolean {
  return message.source.kind === 'semantic-proof-check'
}

/** Visit direct and inbox occurrences of proof-check receipts. */
export function semanticProofCheckMessages(event: SessionEvent): readonly UserMessage[] {
  if (event.type === 'user/message') return isSemanticProofCheckMessage(event.data) ? [event.data] : []
  if (event.type !== 'agent/inbox/spliced') return []
  return event.data.inserted.filter(isSemanticProofCheckMessage)
}

/** Replay independently minted proof-check receipts by their self-binding digest. */
export function foldSemanticProofChecks(
  events: readonly SessionEvent[],
  sessionId: SessionId,
): ReadonlyMap<string, SemanticProofCheckReceipt> {
  const calls = new Map<string, { readonly name: string; readonly seq: number }>()
  const successful = new Map<string, number>()
  const messages = new Map<MessageId, UserMessage>()
  const receipts = new Map<string, SemanticProofCheckReceipt>()
  for (const event of events) {
    if (event.type === 'tool/call') {
      calls.set(event.data.callId, { name: event.data.name, seq: event.seq })
    }
    if (event.type === 'tool/result' && event.data.message.content[0].isError !== true) {
      successful.set(event.data.message.content[0].toolCallId, event.seq)
    }
    for (const message of semanticProofCheckMessages(event)) {
      const priorMessage = messages.get(message.id)
      if (priorMessage !== undefined) {
        if (!isDeepStrictEqual(priorMessage, message)) throw new Error(`semantic proof-check message "${message.id}" changed`)
        continue
      }
      if (message.source.kind !== 'semantic-proof-check') continue
      const source = message.source
      const receipt = source.receipt
      const call = calls.get(receipt.checkerCallId)
      const resultSeq = successful.get(receipt.checkerCallId)
      const { receiptDigest: _digest, ...core } = receipt
      if (source.version !== 1 || source.sessionId !== sessionId || receipt.sessionId !== sessionId
        || source.authoringCause.kind !== 'runtime' || source.authoringCause.reasonCode !== 'checker-result'
        || source.authoringCause.eventId !== receipt.checkerCallId
        || !isSha256Digest(receipt.specificationDigest) || !isSha256Digest(receipt.subjectDigest)
        || !isSha256Digest(receipt.proofContentDigest)
        || receipt.receiptDigest !== semanticProofCheckReceiptDigest(core)
        || call === undefined || call.name !== receipt.checkerId
        || resultSeq === undefined || call.seq >= resultSeq || resultSeq >= event.seq) {
        throw new Error('semantic proof-check source is invalid or lacks its exact earlier successful checker call/result')
      }
      requiredText(receipt.checkerId, 'semantic proof-check checkerId')
      requiredText(receipt.checkerVersion, 'semantic proof-check checkerVersion')
      if (!isDeepStrictEqual(message.content, [{ type: 'text', text: renderSemanticProofCheckReceipt(source) }])) {
        throw new Error('semantic proof-check message content mismatch')
      }
      const priorReceipt = receipts.get(receipt.receiptDigest)
      if (priorReceipt !== undefined && !isDeepStrictEqual(priorReceipt, receipt)) {
        throw new Error(`semantic proof-check receipt "${receipt.receiptDigest}" changed`)
      }
      receipts.set(receipt.receiptDigest, receipt)
      messages.set(message.id, message)
    }
  }
  return receipts
}

/** Read all valid proof-check receipts owned by one Agent. */
export function semanticProofChecksOf(agent: Agent): ReadonlyMap<string, SemanticProofCheckReceipt> {
  return foldSemanticProofChecks(agent.session.events, agent.id)
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Runtime-minted proof checker result. */
    'semantic-proof-check': SemanticProofCheckSourceV1
  }
}

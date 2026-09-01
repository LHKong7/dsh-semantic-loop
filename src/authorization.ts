/** Pre-action authorization, append-only settlements, and ledger replay. */

import { isDeepStrictEqual } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import { type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SemanticAction } from './action.ts'
import type { SemanticCounterexampleRef, SemanticProofRef } from './proof.ts'
import type { SemanticSpecification } from './specification.ts'
import { isSha256Digest, semanticDigest } from './canonical.ts'

/** Runtime-only bounded ledger query capability passed to a provider. */
export interface SemanticLedgerQueryHandle {
  readonly sessionId: SessionId
  readonly turn: number
  readonly ledgerDigest: string
  query(receiptIds: readonly string[]): Promise<readonly SemanticActionLedgerEntry[]>
}

/** Exact action plus current specification and ledger identity. */
export interface SemanticAuthorizationRequest {
  readonly sessionId: SessionId
  readonly turn: number
  readonly baselineDigest: string
  readonly specDigest?: string
  readonly runRevision?: number
  readonly action: SemanticAction
  readonly ledgerDigest: string
  readonly relevantReceiptIds: readonly string[]
  readonly ledgerQueryHandle: SemanticLedgerQueryHandle
  readonly formalPreflightMinRisk: 'medium' | 'high' | 'critical'
  readonly fastPathBudgetMs: number
  readonly signal: AbortSignal
}

/** Provider result for one runtime-selected obligation. */
export interface SemanticAuthorizationCheckResult {
  readonly obligationId?: string
  readonly policyRuleId?: string
  readonly status: 'proved' | 'violated' | 'unknown'
  readonly detail: string
  readonly proof?: SemanticProofRef
  readonly counterexample?: SemanticCounterexampleRef
}

/** Versioned output of one trusted authorization provider. */
export interface SemanticAuthorizationReport {
  readonly providerId: string
  readonly specVersion?: string
  readonly results: readonly SemanticAuthorizationCheckResult[]
  readonly certificateProposals?: readonly SemanticProofRef[]
  readonly claimedAssurance?: 'evidence-backed' | 'runtime-checked' | 'formally-proved'
}

/** Immutable preflight receipt published before its settlement record. */
export interface SemanticAuthorizationReceipt {
  readonly sessionId: SessionId
  readonly turn: number
  readonly callId: string
  readonly baselineDigest: string
  readonly specDigest?: string
  readonly runRevision?: number
  readonly actionDigest: string
  readonly parentLedgerDigest: string
  readonly decision: 'allowed' | 'denied' | 'asked'
  readonly approvalOutcome?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  readonly assurance: 'none' | 'evidence-backed' | 'runtime-checked' | 'formally-proved'
  readonly reportDigests: readonly string[]
  readonly approvalRequestId?: string
  readonly receiptDigest: string
}

/** Immutable settlement that records whether an authorized call had effects. */
export interface SemanticActionSettlementReceipt {
  readonly sessionId: SessionId
  readonly turn: number
  readonly callId: string
  readonly authorizationReceiptDigest: string
  readonly actionDigest: string
  readonly dispatchState: 'not-started' | 'started' | 'settled'
  readonly outcome: 'not-started' | 'succeeded' | 'failed' | 'cancelled'
    | 'postcondition-violated' | 'unknown-effect'
  readonly resultDigest?: string
  readonly postCheckReportDigests: readonly string[]
  readonly receiptDigest: string
}

/** One append-only ledger entry. */
export type SemanticActionLedgerEntry = SemanticAuthorizationReceipt | SemanticActionSettlementReceipt

/** Durable preflight receipt source. */
export interface SemanticAuthorizationSourceV1 {
  readonly kind: 'semantic-authorization'
  readonly version: 1
  readonly sessionId: SessionId
  readonly authoringCause: { readonly kind: 'runtime'; readonly eventId: string; readonly reasonCode: 'preflight' }
  readonly receipt: SemanticAuthorizationReceipt
}

/** Durable post-action settlement source. */
export interface SemanticActionSettlementSourceV1 {
  readonly kind: 'semantic-action-settlement'
  readonly version: 1
  readonly sessionId: SessionId
  readonly authoringCause: { readonly kind: 'runtime'; readonly eventId: string; readonly reasonCode: 'post-action' }
  readonly receipt: SemanticActionSettlementReceipt
}

/** Replayed action ledger and safety state. */
export interface SemanticActionLedgerProjection {
  readonly entries: readonly SemanticActionLedgerEntry[]
  readonly ledgerDigest: string
  readonly health: 'safe' | 'unsafe' | 'needs-reconciliation'
  readonly pendingAuthorizationDigests: readonly string[]
}

/** Runtime policy inputs used to derive one monotonic preflight decision. */
export interface SemanticAuthorizationPolicy {
  readonly gate: 'off' | 'observe' | 'adaptive' | 'enforce'
  readonly unknownActionPolicy: 'observe' | 'ask' | 'deny'
  readonly baselinePresent: boolean
  readonly currentTurnBegin: boolean
  readonly safetyPlaneHealthy: boolean
}

/** Local decision plus provider coverage used to mint a receipt. */
export interface SemanticAuthorizationDecision {
  readonly decision: PreToolDecision
  readonly reports: readonly SemanticAuthorizationReport[]
  readonly assurance: SemanticAuthorizationReceipt['assurance']
  readonly reasonCode: string
}

/** Initial digest of an empty action ledger. */
export const EMPTY_ACTION_LEDGER_DIGEST = semanticDigest('action-ledger', 1, [])

/** Extend an action-ledger digest with one immutable receipt digest. */
export function nextActionLedgerDigest(parentDigest: string, receiptDigest: string): string {
  if (!isSha256Digest(parentDigest) || !isSha256Digest(receiptDigest)) throw new Error('semantic action ledger requires SHA-256 receipt digests')
  return semanticDigest('action-ledger-link', 1, { parentDigest, receiptDigest })
}

/** Compute the self-binding digest of a preflight receipt. */
export function semanticAuthorizationReceiptDigest(
  receipt: Omit<SemanticAuthorizationReceipt, 'receiptDigest'>,
): string {
  return semanticDigest('authorization', 1, receipt)
}

/** Compute the self-binding digest of a settlement receipt. */
export function semanticSettlementReceiptDigest(
  receipt: Omit<SemanticActionSettlementReceipt, 'receiptDigest'>,
): string {
  return semanticDigest('action-settlement', 1, receipt)
}

function requiredText(value: string, label: string): void {
  if (value.length === 0 || value.trim() !== value) throw new Error(`${label} must be non-empty and already trimmed`)
}

/** Validate one provider report before it influences authorization. */
export function assertSemanticAuthorizationReport(report: SemanticAuthorizationReport): void {
  requiredText(report.providerId, 'semantic authorization providerId')
  if (report.specVersion !== undefined) requiredText(report.specVersion, 'semantic authorization specVersion')
  for (const result of report.results) {
    if (result.obligationId === undefined && result.policyRuleId === undefined) {
      throw new Error(`semantic authorization provider "${report.providerId}" returned an unscoped result`)
    }
    requiredText(result.detail, `semantic authorization provider "${report.providerId}" detail`)
  }
}

function providerStatus(
  obligationId: string,
  reports: readonly SemanticAuthorizationReport[],
): 'proved' | 'violated' | 'unknown' {
  const results = reports.flatMap(report => report.results).filter(result => result.obligationId === obligationId)
  if (results.some(result => result.status === 'violated')) return 'violated'
  if (results.length === 0 || results.some(result => result.status === 'unknown')) return 'unknown'
  return 'proved'
}

/**
 * Apply hard obligations before deployment risk policy.
 *
 * @param action Runtime-minted action.
 * @param specification Active immutable specification, when begun.
 * @param reports Trusted provider reports.
 * @param policy Deployment enforcement policy.
 * @returns Monotonic local decision.
 */
export function decideSemanticAuthorization(
  action: SemanticAction,
  specification: SemanticSpecification | undefined,
  reports: readonly SemanticAuthorizationReport[],
  policy: SemanticAuthorizationPolicy,
): SemanticAuthorizationDecision {
  for (const report of reports) assertSemanticAuthorizationReport(report)
  if (!policy.safetyPlaneHealthy) {
    return {
      decision: action.risk === 'none'
        ? { kind: 'allow' }
        : { kind: 'deny', reason: 'semantic safety-plane integrity is unavailable' },
      reports, assurance: 'none', reasonCode: 'safety-plane-integrity',
    }
  }
  const obligations = specification === undefined ? [] : [
    ...specification.requirements,
    ...specification.forbiddenStates,
  ].filter(requirement => requirement.required
    && (requirement.phase === 'pre-action' || requirement.phase === 'always'))
  for (const obligation of obligations) {
    const status = providerStatus(obligation.id, reports)
    if (status === 'violated') {
      return {
        decision: { kind: 'deny', reason: `semantic obligation ${obligation.id} is violated` },
        reports, assurance: 'runtime-checked', reasonCode: 'required-violated',
      }
    }
    if (status === 'unknown') {
      return {
        decision: { kind: 'deny', reason: `semantic obligation ${obligation.id} is unknown; clarify or amend the specification` },
        reports, assurance: 'none', reasonCode: 'required-unknown',
      }
    }
  }
  if (action.effects.includes('financial') || action.effects.includes('permission-change')
    || action.risk === 'critical' && action.confidence === 'unknown') {
    return {
      decision: { kind: 'deny', reason: `semantic policy denies unclassified critical action ${action.callId}` },
      reports, assurance: 'none', reasonCode: 'critical-deny',
    }
  }
  if (policy.gate === 'enforce' && (!policy.baselinePresent || !policy.currentTurnBegin)) {
    return {
      decision: { kind: 'deny', reason: 'semantic strict mode requires semantic_begin in the current turn' },
      reports, assurance: 'none', reasonCode: 'strict-begin-required',
    }
  }
  if (policy.gate === 'off' || policy.gate === 'observe') {
    return { decision: { kind: 'allow' }, reports, assurance: 'none', reasonCode: policy.gate }
  }
  if (action.risk === 'none' || (action.risk === 'low' && action.confidence === 'exact'
    && action.egress === 'none' && action.writes.length === 0)) {
    return {
      decision: { kind: 'allow' }, reports,
      assurance: obligations.length === 0 ? 'runtime-checked' : 'evidence-backed',
      reasonCode: action.risk === 'none' ? 'r0-allow' : 'r1-allow',
    }
  }
  if (policy.gate === 'enforce') {
    return {
      decision: { kind: 'deny', reason: `semantic strict mode cannot prove action ${action.callId} safe` },
      reports, assurance: 'none', reasonCode: 'strict-action-unknown',
    }
  }
  if (policy.unknownActionPolicy === 'ask' && action.risk !== 'critical') {
    return {
      decision: { kind: 'ask', reason: `semantic policy requires approval for ${action.operation}` },
      reports, assurance: 'none', reasonCode: 'risk-ask',
    }
  }
  if (policy.unknownActionPolicy === 'observe' && action.risk === 'low') {
    return { decision: { kind: 'allow' }, reports, assurance: 'none', reasonCode: 'risk-observe' }
  }
  return {
    decision: { kind: 'deny', reason: `semantic policy cannot authorize ${action.operation}` },
    reports, assurance: 'none', reasonCode: 'risk-deny',
  }
}

/** Merge independent pre-execute decisions without allowing a weaker result to win. */
export function mergePreToolDecisions(left: PreToolDecision, right: PreToolDecision): PreToolDecision {
  if (left.kind === 'deny') return left
  if (right.kind === 'deny') return right
  if (left.kind === 'ask') return left
  if (right.kind === 'ask') return right
  return { kind: 'allow' }
}

/** Compact context for a preflight receipt. */
export function renderSemanticAuthorizationReceipt(source: SemanticAuthorizationSourceV1): string {
  return `Semantic preflight ${source.receipt.decision} call ${source.receipt.callId} (assurance ${source.receipt.assurance}; receipt ${source.receipt.receiptDigest}).`
}

/** Compact context for a post-action settlement. */
export function renderSemanticSettlementReceipt(source: SemanticActionSettlementSourceV1): string {
  return `Semantic action ${source.receipt.callId} settled as ${source.receipt.outcome} (${source.receipt.dispatchState}; receipt ${source.receipt.receiptDigest}).`
}

/** User message whose source is one action-ledger record. */
export type SemanticAuthorizationMessage = UserMessage & {
  readonly source: SemanticAuthorizationSourceV1 | SemanticActionSettlementSourceV1
}

/** Test whether a message carries authorization provenance. */
export function isSemanticAuthorizationMessage(message: UserMessage): message is SemanticAuthorizationMessage {
  return message.source.kind === 'semantic-authorization' || message.source.kind === 'semantic-action-settlement'
}

/** Visit direct and inbox occurrences of action-ledger messages. */
export function semanticAuthorizationMessages(event: SessionEvent): readonly SemanticAuthorizationMessage[] {
  if (event.type === 'user/message') return isSemanticAuthorizationMessage(event.data) ? [event.data] : []
  if (event.type !== 'agent/inbox/spliced') return []
  return event.data.inserted.filter(isSemanticAuthorizationMessage)
}

function assertAuthorizationReceipt(receipt: SemanticAuthorizationReceipt): void {
  const { receiptDigest, ...core } = receipt
  if (receiptDigest !== semanticAuthorizationReceiptDigest(core)) throw new Error('semantic authorization receipt digest mismatch')
  if (!isSha256Digest(receipt.parentLedgerDigest) || !isSha256Digest(receipt.actionDigest)
    || !isSha256Digest(receipt.baselineDigest)
    || receipt.specDigest !== undefined && !isSha256Digest(receipt.specDigest)
    || receipt.reportDigests.some(digest => !isSha256Digest(digest))) {
    throw new Error('semantic authorization receipt carries an invalid digest')
  }
  if (!Number.isSafeInteger(receipt.turn) || receipt.turn < 1
    || receipt.runRevision !== undefined && (!Number.isSafeInteger(receipt.runRevision) || receipt.runRevision < 1)
    || receipt.callId.length === 0) {
    throw new Error('semantic authorization receipt carries invalid identity fields')
  }
}

function assertSettlementReceipt(receipt: SemanticActionSettlementReceipt): void {
  const { receiptDigest, ...core } = receipt
  if (receiptDigest !== semanticSettlementReceiptDigest(core)) throw new Error('semantic action settlement receipt digest mismatch')
  if (!isSha256Digest(receipt.authorizationReceiptDigest) || !isSha256Digest(receipt.actionDigest)) {
    throw new Error('semantic action settlement carries an invalid digest')
  }
  if (receipt.resultDigest !== undefined && !isSha256Digest(receipt.resultDigest)
    || receipt.postCheckReportDigests.some(digest => !isSha256Digest(digest))) {
    throw new Error('semantic action settlement carries invalid result digests')
  }
}

/** Strictly fold the append-only action ledger for one Session owner. */
export function foldSemanticActionLedger(
  events: readonly SessionEvent[],
  sessionId: SessionId,
): SemanticActionLedgerProjection {
  const messages = new Map<MessageId, UserMessage>()
  const calls = new Map<string, { readonly turn: number; readonly seq: number }>()
  const results = new Map<string, { readonly isError: boolean; readonly seq: number }>()
  const authorizations = new Map<string, SemanticAuthorizationReceipt>()
  const settled = new Set<string>()
  const entries: SemanticActionLedgerEntry[] = []
  let ledgerDigest = EMPTY_ACTION_LEDGER_DIGEST
  let health: SemanticActionLedgerProjection['health'] = 'safe'
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, { turn: event.data.turn, seq: event.seq })
    if (event.type === 'tool/result') {
      const block = event.data.message.content[0]
      results.set(block.toolCallId, { isError: block.isError === true, seq: event.seq })
    }
    for (const message of semanticAuthorizationMessages(event)) {
      const prior = messages.get(message.id)
      if (prior !== undefined) {
        if (!isDeepStrictEqual(prior, message)) throw new Error(`semantic authorization message "${message.id}" changed`)
        continue
      }
      if (message.source.kind === 'semantic-authorization') {
        const source = message.source
        if (source.version !== 1 || source.sessionId !== sessionId
          || source.receipt.sessionId !== sessionId
          || source.authoringCause.reasonCode !== 'preflight'
          || source.authoringCause.eventId !== source.receipt.callId) {
          throw new Error('semantic authorization source ownership is invalid')
        }
        assertAuthorizationReceipt(source.receipt)
        const call = calls.get(source.receipt.callId)
        if (call === undefined || call.turn !== source.receipt.turn || call.seq >= event.seq) {
          throw new Error(`semantic authorization call ${source.receipt.callId} is missing or belongs to another turn`)
        }
        if (source.receipt.parentLedgerDigest !== ledgerDigest) throw new Error('semantic authorization parent ledger digest mismatch')
        if (!isDeepStrictEqual(message.content, [{ type: 'text', text: renderSemanticAuthorizationReceipt(source) }])) {
          throw new Error('semantic authorization message content mismatch')
        }
        authorizations.set(source.receipt.receiptDigest, source.receipt)
        entries.push(source.receipt)
        ledgerDigest = nextActionLedgerDigest(ledgerDigest, source.receipt.receiptDigest)
      } else {
        const source = message.source
        if (source.version !== 1 || source.sessionId !== sessionId
          || source.receipt.sessionId !== sessionId
          || source.authoringCause.reasonCode !== 'post-action'
          || source.authoringCause.eventId !== source.receipt.callId) {
          throw new Error('semantic action settlement source ownership is invalid')
        }
        assertSettlementReceipt(source.receipt)
        const authorization = authorizations.get(source.receipt.authorizationReceiptDigest)
        const result = results.get(source.receipt.callId)
        if (authorization === undefined || authorization.actionDigest !== source.receipt.actionDigest
          || authorization.callId !== source.receipt.callId
          || result === undefined || result.seq >= event.seq) {
          throw new Error(`semantic action settlement ${source.receipt.callId} lacks its authorization or result`)
        }
        if (!result.isError && (source.receipt.outcome !== 'succeeded' || source.receipt.dispatchState !== 'settled')) {
          throw new Error(`semantic action settlement ${source.receipt.callId} contradicts its successful result`)
        }
        if (result.isError && source.receipt.outcome === 'succeeded') {
          throw new Error(`semantic action settlement ${source.receipt.callId} contradicts its failed result`)
        }
        if ((source.receipt.outcome === 'not-started') !== (source.receipt.dispatchState === 'not-started')) {
          throw new Error(`semantic action settlement ${source.receipt.callId} has inconsistent dispatch state`)
        }
        if (!isDeepStrictEqual(message.content, [{ type: 'text', text: renderSemanticSettlementReceipt(source) }])) {
          throw new Error('semantic action settlement message content mismatch')
        }
        settled.add(source.receipt.authorizationReceiptDigest)
        entries.push(source.receipt)
        ledgerDigest = nextActionLedgerDigest(ledgerDigest, source.receipt.receiptDigest)
        if (source.receipt.outcome === 'postcondition-violated') health = 'unsafe'
        else if (source.receipt.outcome === 'unknown-effect' && health !== 'unsafe') health = 'needs-reconciliation'
      }
      messages.set(message.id, message)
    }
  }
  const pending = [...authorizations.keys()].filter(digest => !settled.has(digest))
  if (pending.length > 0 && health === 'safe') health = 'needs-reconciliation'
  return { entries, ledgerDigest, health, pendingAuthorizationDigests: pending }
}

/** Read one live Agent's complete action ledger. */
export function semanticActionLedgerOf(agent: Agent): SemanticActionLedgerProjection {
  return foldSemanticActionLedger(agent.session.events, agent.id)
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Evaluate runtime-selected obligations for one exact action.
     * @param request Specification, action, and bounded ledger access.
     * @mode waterfall
     */
    'semantic/authorize'(
      request: SemanticAuthorizationRequest,
      next: () => Promise<readonly SemanticAuthorizationReport[]>,
    ): Promise<readonly SemanticAuthorizationReport[]>
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Runtime-minted pre-action authorization. */
    'semantic-authorization': SemanticAuthorizationSourceV1
    /** Runtime-minted post-action settlement. */
    'semantic-action-settlement': SemanticActionSettlementSourceV1
  }
}

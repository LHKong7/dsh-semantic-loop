/** Candidate-bound v2 verification, coverage aggregation, and durable replay. */

import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SemanticCapabilityInventory, SemanticEvidence } from './types.ts'
import type { SemanticCandidate } from './candidate.ts'
import { assertSemanticCandidate, foldSemanticCandidates } from './candidate.ts'
import type { SemanticRunState } from './run-state.ts'
import { foldSemanticRuns } from './run-state.ts'
import type { SemanticSpecification } from './specification.ts'
import { foldSemanticSpecifications } from './spec-projection.ts'
import type { SemanticActionLedgerProjection, SemanticLedgerQueryHandle } from './authorization.ts'
import { EMPTY_ACTION_LEDGER_DIGEST, foldSemanticActionLedger } from './authorization.ts'
import type { SemanticCounterexampleRef, SemanticProofRef } from './proof.ts'
import type { SemanticProofCheckReceipt } from './proof.ts'
import {
  assertSemanticCounterexampleRef,
  assertSemanticProofRef,
  foldSemanticProofChecks,
  semanticProofChecksOf,
} from './proof.ts'
import { semanticDigest } from './canonical.ts'
import { VERIFY_TOOL } from './protocol.ts'

/** Immutable candidate verification input. */
export interface SemanticVerificationRequestV2 {
  readonly sessionId: SessionId
  readonly revision: number
  readonly spec: SemanticSpecification
  readonly specDigest: string
  readonly runState: SemanticRunState
  readonly runStateDigest: string
  readonly candidate: SemanticCandidate
  readonly candidateDigest: string
  readonly actionLedgerDigest: string
  readonly actionCoverage: 'disabled' | 'observed' | 'adaptive' | 'enforced'
  readonly relevantActionReceiptIds: readonly string[]
  readonly environmentCallIds: readonly string[]
  readonly ledgerQueryHandle: SemanticLedgerQueryHandle
  readonly evidence: readonly SemanticEvidence[]
  readonly capabilities: SemanticCapabilityInventory
}

/** Raw provider check before runtime joins specification authority. */
export interface SemanticVerificationProviderCheckV2 {
  readonly obligationId: string
  readonly subjectDigest: string
  readonly status: 'proved' | 'violated' | 'unknown'
  readonly claimedAssurance?: 'evidence-backed' | 'runtime-checked' | 'formally-proved'
  readonly detail: string
  readonly proofIds: readonly string[]
  readonly counterexampleIds: readonly string[]
  readonly checkerReceiptDigests: readonly string[]
}

/** Raw output of one v2 verifier provider. */
export interface SemanticVerificationProviderReportV2 {
  readonly providerId: string
  readonly providerVersion: string
  readonly checks: readonly SemanticVerificationProviderCheckV2[]
  readonly proofRefs: readonly SemanticProofRef[]
  readonly counterexampleRefs: readonly SemanticCounterexampleRef[]
}

/** Runtime-normalized check whose authority and assurance are no longer provider-controlled. */
export interface SemanticVerificationCheckV2 {
  readonly obligationId: string
  readonly subjectDigest: string
  readonly status: 'proved' | 'violated' | 'unknown'
  readonly assurance: 'none' | 'evidence-backed' | 'runtime-checked' | 'formally-proved'
  readonly detail: string
  readonly proofIds: readonly string[]
  readonly counterexampleIds: readonly string[]
  readonly checkerReceiptDigests: readonly string[]
}

/** Runtime-normalized provider report bound to one exact subject. */
export interface SemanticVerificationReportV2 {
  readonly providerId: string
  readonly providerVersion: string
  readonly specDigest: string
  readonly subjectDigest: string
  readonly checks: readonly SemanticVerificationCheckV2[]
  readonly proofRefs: readonly SemanticProofRef[]
  readonly counterexampleRefs: readonly SemanticCounterexampleRef[]
  readonly reportDigest: string
}

/** Exclusive required-obligation coverage buckets. */
export interface SemanticCoverageSummary {
  readonly requiredTotal: number
  readonly formallyProved: number
  readonly runtimeChecked: number
  readonly evidenceBacked: number
  readonly violated: number
  readonly unknown: number
  readonly advisoryEvaluated: number
  readonly residualRiskIds: readonly string[]
}

/** Candidate-bound aggregate receipt. */
export interface SemanticVerificationReceiptV2 {
  readonly sessionId: SessionId
  readonly revision: number
  readonly specDigest: string
  readonly runStateDigest: string
  readonly candidateDigest: string
  readonly actionLedgerDigest: string
  readonly verdict: 'passed' | 'failed' | 'unknown'
  readonly coverage: SemanticCoverageSummary
  readonly reports: readonly SemanticVerificationReportV2[]
}

/** Durable v2 verification receipt source. */
export interface SemanticVerificationSourceV2 {
  readonly kind: 'semantic-verification'
  readonly version: 2
  readonly sessionId: SessionId
  readonly verificationCallId: CallId
  readonly receipt: SemanticVerificationReceiptV2
}

/** Receipt plus durable verification call position. */
export interface SemanticVerificationPositionV2 {
  readonly receipt: SemanticVerificationReceiptV2
  readonly verificationCallSeq: number
}

interface Obligation {
  readonly id: string
  readonly required: boolean
  readonly description: string
}

const ASSURANCE_ORDER = ['none', 'evidence-backed', 'runtime-checked', 'formally-proved'] as const

function runtimeObligations(specification: SemanticSpecification): readonly Obligation[] {
  const requirements = [...specification.requirements, ...specification.forbiddenStates]
    .filter(requirement => requirement.phase === 'final-candidate' || requirement.phase === 'always')
    .map((requirement): Obligation => ({ id: requirement.id, required: requirement.required, description: requirement.statement }))
  const questions = specification.openQuestions
    .filter(question => question.required && question.status === 'open'
      && (question.blockedPhases.includes('final-candidate') || question.blockedPhases.includes('always')))
    .map((question): Obligation => ({
      id: `semantic-open-question-${question.id}`,
      required: true,
      description: question.statement,
    }))
  return [
    { id: 'runtime-run-ready', required: true, description: 'The candidate uses the current ready run state.' },
    { id: 'runtime-action-ledger-integrity', required: true, description: 'Every environment action has a replayable authorization and settlement.' },
    { id: 'runtime-action-safety-coverage', required: true, description: 'Pre-action safety policy covered every dispatched environment action.' },
    { id: 'semantic-mapping-coverage', required: true, description: 'Every authority input has a trusted coverage disposition.' },
    ...questions,
    ...requirements,
  ]
}

function reportDigest(report: Omit<SemanticVerificationReportV2, 'reportDigest'>): string {
  return semanticDigest('verification-report', 2, report)
}

function hasAcceptedProofCheck(
  proof: SemanticProofRef,
  subjectDigest: string,
  checkerReceiptDigests: readonly string[],
  proofChecks: ReadonlyMap<string, SemanticProofCheckReceipt>,
): boolean {
  if (proof.subjectDigest !== subjectDigest || proof.checkerReceiptDigest === undefined
    || !checkerReceiptDigests.includes(proof.checkerReceiptDigest)) return false
  const receipt = proofChecks.get(proof.checkerReceiptDigest)
  return receipt?.verdict === 'accepted'
    && receipt.checkerCallId === proof.checkerCallId
    && receipt.checkerId === proof.checkerId
    && receipt.checkerVersion === proof.checkerVersion
    && receipt.specificationDigest === proof.specificationDigest
    && receipt.subjectDigest === proof.subjectDigest
    && receipt.proofContentDigest === proof.contentDigest
}

function builtinReport(
  request: SemanticVerificationRequestV2,
  ledger: SemanticActionLedgerProjection,
): SemanticVerificationReportV2 {
  const mappingCovered = request.spec.sourceCoverage.every(coverage => coverage.status === 'covered'
    && coverage.reviewerAuthority !== 'agent')
  const authorizationCalls = new Set(ledger.entries.filter(entry => 'decision' in entry).map(entry => entry.callId))
  const settlementCalls = new Set(ledger.entries.filter(entry => 'outcome' in entry).map(entry => entry.callId))
  const ledgerComplete = request.actionCoverage !== 'disabled'
    && request.environmentCallIds.every(callId => authorizationCalls.has(callId) && settlementCalls.has(callId))
  const core: Omit<SemanticVerificationReportV2, 'reportDigest'> = {
    providerId: 'semantic-runtime', providerVersion: '2', specDigest: request.specDigest,
    subjectDigest: request.candidateDigest,
    checks: [
      {
        obligationId: 'runtime-run-ready', subjectDigest: request.candidateDigest,
        status: request.runState.phase === 'candidate' ? 'proved' : 'violated',
        assurance: 'runtime-checked', detail: request.runState.phase === 'candidate'
          ? 'candidate is bound to the current sealed run state'
          : `run phase is ${request.runState.phase}`,
        proofIds: [], counterexampleIds: [], checkerReceiptDigests: [],
      },
      {
        obligationId: 'runtime-action-ledger-integrity', subjectDigest: request.actionLedgerDigest,
        status: ledgerComplete && ledger.health === 'safe'
          && ledger.pendingAuthorizationDigests.length === 0 ? 'proved' : 'unknown',
        assurance: ledgerComplete && ledger.health === 'safe'
          && ledger.pendingAuthorizationDigests.length === 0 ? 'runtime-checked' : 'none',
        detail: ledgerComplete && ledger.health === 'safe'
          ? 'every environment call has authorization and settlement with no pending receipt'
          : `action ledger is incomplete or has health ${ledger.health}`,
        proofIds: [], counterexampleIds: [], checkerReceiptDigests: [],
      },
      {
        obligationId: 'runtime-action-safety-coverage', subjectDigest: request.actionLedgerDigest,
        status: request.actionCoverage === 'adaptive' || request.actionCoverage === 'enforced'
          ? ledger.health === 'safe' && ledger.pendingAuthorizationDigests.length === 0 ? 'proved' : 'unknown'
          : 'unknown',
        assurance: (request.actionCoverage === 'adaptive' || request.actionCoverage === 'enforced')
          && ledger.health === 'safe' && ledger.pendingAuthorizationDigests.length === 0
          ? 'runtime-checked' : 'none',
        detail: request.actionCoverage === 'disabled'
          ? 'semantic pre-action tracking is disabled'
          : request.actionCoverage === 'observed'
            ? 'observe mode does not claim complete pre-action safety coverage'
            : 'semantic pre-action policy covered the settled ledger',
        proofIds: [], counterexampleIds: [], checkerReceiptDigests: [],
      },
      {
        obligationId: 'semantic-mapping-coverage', subjectDigest: request.specDigest,
        status: mappingCovered ? 'proved' : 'unknown', assurance: mappingCovered ? 'runtime-checked' : 'none',
        detail: mappingCovered ? 'all authority inputs have trusted coverage dispositions' : 'one or more authority inputs lack trusted mapping coverage',
        proofIds: [], counterexampleIds: [], checkerReceiptDigests: [],
      },
      ...request.spec.openQuestions.filter(question => question.required && question.status === 'open'
        && (question.blockedPhases.includes('final-candidate') || question.blockedPhases.includes('always')))
        .map((question): SemanticVerificationCheckV2 => ({
          obligationId: `semantic-open-question-${question.id}`,
          subjectDigest: request.specDigest,
          status: 'unknown', assurance: 'none',
          detail: `required semantic question ${question.id} remains open`,
          proofIds: [], counterexampleIds: [], checkerReceiptDigests: [],
        })),
    ],
    proofRefs: [], counterexampleRefs: [],
  }
  return { ...core, reportDigest: reportDigest(core) }
}

function normalizeProviderReport(
  request: SemanticVerificationRequestV2,
  report: SemanticVerificationProviderReportV2,
  proofChecks: ReadonlyMap<string, SemanticProofCheckReceipt>,
): SemanticVerificationReportV2 {
  if (report.providerId.length === 0 || report.providerId.trim() !== report.providerId
    || report.providerVersion.length === 0 || report.providerVersion.trim() !== report.providerVersion) {
    throw new Error('semantic v2 verifier id and version must be non-empty and already trimmed')
  }
  const proofs = new Map(report.proofRefs.map(proof => {
    assertSemanticProofRef(proof)
    if (proof.specificationDigest !== request.specDigest
      || (proof.subjectDigest !== request.candidateDigest && proof.subjectDigest !== request.specDigest
        && proof.subjectDigest !== request.runStateDigest && proof.subjectDigest !== request.actionLedgerDigest)) {
      throw new Error(`semantic verifier "${report.providerId}" proof "${proof.id}" is not bound to this verification subject`)
    }
    return [proof.id, proof] as const
  }))
  if (proofs.size !== report.proofRefs.length) throw new Error(`semantic verifier "${report.providerId}" repeats a proof id`)
  const counterexamples = new Map(report.counterexampleRefs.map(counterexample => {
    assertSemanticCounterexampleRef(counterexample)
    return [counterexample.id, counterexample] as const
  }))
  if (counterexamples.size !== report.counterexampleRefs.length) {
    throw new Error(`semantic verifier "${report.providerId}" repeats a counterexample id`)
  }
  const checks = report.checks.map((check): SemanticVerificationCheckV2 => {
    if (check.subjectDigest !== request.candidateDigest && check.subjectDigest !== request.specDigest
      && check.subjectDigest !== request.runStateDigest && check.subjectDigest !== request.actionLedgerDigest) {
      throw new Error(`semantic verifier "${report.providerId}" check "${check.obligationId}" uses an unrelated subject digest`)
    }
    for (const proofId of check.proofIds) if (!proofs.has(proofId)) throw new Error(`semantic verifier check names missing proof "${proofId}"`)
    for (const id of check.counterexampleIds) if (!counterexamples.has(id)) throw new Error(`semantic verifier check names missing counterexample "${id}"`)
    for (const id of check.counterexampleIds) {
      if (counterexamples.get(id)!.obligationId !== check.obligationId) {
        throw new Error(`semantic verifier counterexample "${id}" belongs to another obligation`)
      }
    }
    let assurance: SemanticVerificationCheckV2['assurance'] = check.status === 'proved'
      ? check.claimedAssurance ?? 'evidence-backed'
      : 'none'
    if (assurance === 'formally-proved') {
      const accepted = check.proofIds.map(id => proofs.get(id)!).some(proof =>
        hasAcceptedProofCheck(proof, check.subjectDigest, check.checkerReceiptDigests, proofChecks))
      if (!accepted) assurance = 'runtime-checked'
    }
    return {
      obligationId: check.obligationId, subjectDigest: check.subjectDigest,
      status: check.status, assurance, detail: check.detail,
      proofIds: [...check.proofIds], counterexampleIds: [...check.counterexampleIds],
      checkerReceiptDigests: [...check.checkerReceiptDigests],
    }
  })
  const core: Omit<SemanticVerificationReportV2, 'reportDigest'> = {
    providerId: report.providerId, providerVersion: report.providerVersion,
    specDigest: request.specDigest, subjectDigest: request.candidateDigest,
    checks, proofRefs: [...report.proofRefs], counterexampleRefs: [...report.counterexampleRefs],
  }
  return { ...core, reportDigest: reportDigest(core) }
}

function strongestCheck(
  obligation: Obligation,
  reports: readonly SemanticVerificationReportV2[],
): SemanticVerificationCheckV2 {
  const checks = reports.flatMap(report => report.checks).filter(check => check.obligationId === obligation.id)
  const violated = checks.find(check => check.status === 'violated')
  if (violated !== undefined) return violated
  const proved = checks.filter(check => check.status === 'proved')
  if (proved.length === 0) {
    return {
      obligationId: obligation.id, subjectDigest: reports[0]?.subjectDigest ?? semanticDigest('missing-subject', 1, obligation.id),
      status: 'unknown', assurance: 'none', detail: `no trusted verifier proved required obligation ${obligation.id}`,
      proofIds: [], counterexampleIds: [], checkerReceiptDigests: [],
    }
  }
  return proved.reduce((strongest, check) => ASSURANCE_ORDER.indexOf(check.assurance) > ASSURANCE_ORDER.indexOf(strongest.assurance) ? check : strongest)
}

function coverageOf(
  obligations: readonly Obligation[],
  reports: readonly SemanticVerificationReportV2[],
): SemanticCoverageSummary {
  const required = obligations.filter(obligation => obligation.required).map(obligation => strongestCheck(obligation, reports))
  const advisoryIds = new Set(obligations.filter(obligation => !obligation.required).map(obligation => obligation.id))
  const advisoryEvaluated = new Set(reports.flatMap(report => report.checks)
    .filter(check => advisoryIds.has(check.obligationId)).map(check => check.obligationId)).size
  const residualRiskIds = required.filter(check => check.status === 'unknown').map(check => check.obligationId)
  return {
    requiredTotal: required.length,
    formallyProved: required.filter(check => check.status === 'proved' && check.assurance === 'formally-proved').length,
    runtimeChecked: required.filter(check => check.status === 'proved' && check.assurance === 'runtime-checked').length,
    evidenceBacked: required.filter(check => check.status === 'proved' && check.assurance === 'evidence-backed').length,
    violated: required.filter(check => check.status === 'violated').length,
    unknown: required.filter(check => check.status === 'unknown' || check.status === 'proved' && check.assurance === 'none').length,
    advisoryEvaluated, residualRiskIds,
  }
}

function assertReceiptStructure(
  receipt: SemanticVerificationReceiptV2,
  specification: SemanticSpecification,
  proofChecks: ReadonlyMap<string, SemanticProofCheckReceipt>,
): void {
  const providerIds = new Set<string>()
  const allowedSubjects = new Set([
    receipt.specDigest,
    receipt.runStateDigest,
    receipt.candidateDigest,
    receipt.actionLedgerDigest,
  ])
  for (const report of receipt.reports) {
    if (providerIds.has(report.providerId)) throw new Error(`semantic verification repeats provider "${report.providerId}"`)
    providerIds.add(report.providerId)
    if (report.specDigest !== receipt.specDigest || report.subjectDigest !== receipt.candidateDigest) {
      throw new Error(`semantic verification report "${report.providerId}" is not bound to the receipt subject`)
    }
    const { reportDigest: _digest, ...core } = report
    if (report.reportDigest !== reportDigest(core)) throw new Error(`semantic verification report "${report.providerId}" digest mismatch`)
    const proofs = new Map(report.proofRefs.map(proof => {
      assertSemanticProofRef(proof)
      if (proof.specificationDigest !== receipt.specDigest || !allowedSubjects.has(proof.subjectDigest)) {
        throw new Error(`semantic verification proof "${proof.id}" is not bound to the receipt subject`)
      }
      return [proof.id, proof] as const
    }))
    if (proofs.size !== report.proofRefs.length) throw new Error(`semantic verification report "${report.providerId}" repeats a proof id`)
    const counterexamples = new Map(report.counterexampleRefs.map(counterexample => {
      assertSemanticCounterexampleRef(counterexample)
      return [counterexample.id, counterexample] as const
    }))
    if (counterexamples.size !== report.counterexampleRefs.length) {
      throw new Error(`semantic verification report "${report.providerId}" repeats a counterexample id`)
    }
    for (const check of report.checks) {
      if (!allowedSubjects.has(check.subjectDigest)) throw new Error(`semantic verification check "${check.obligationId}" has an unrelated subject`)
      for (const id of check.proofIds) if (!proofs.has(id)) throw new Error(`semantic verification check names missing proof "${id}"`)
      for (const id of check.counterexampleIds) {
        if (counterexamples.get(id)?.obligationId !== check.obligationId) {
          throw new Error(`semantic verification counterexample "${id}" belongs to another obligation`)
        }
      }
      if (check.status !== 'proved' && check.assurance !== 'none') {
        throw new Error(`semantic verification check "${check.obligationId}" claims assurance without proof`)
      }
      if (check.assurance === 'formally-proved' && !check.proofIds.map(id => proofs.get(id)!).some(proof =>
        hasAcceptedProofCheck(proof, check.subjectDigest, check.checkerReceiptDigests, proofChecks))) {
        throw new Error(`semantic verification check "${check.obligationId}" lacks an accepted proof-check receipt`)
      }
    }
  }
  if (!providerIds.has('semantic-runtime')) throw new Error('semantic verification receipt lacks the built-in runtime report')
  const coverage = coverageOf(runtimeObligations(specification), receipt.reports)
  if (!isDeepStrictEqual(receipt.coverage, coverage)) throw new Error('semantic verification coverage does not match its reports')
  const verdict = coverage.violated > 0 ? 'failed' : coverage.unknown > 0 ? 'unknown' : 'passed'
  if (receipt.verdict !== verdict) throw new Error('semantic verification verdict does not match its coverage')
}

/** Run scoped v2 providers and aggregate complete required coverage. */
export async function verifySemanticCandidate(
  ctx: Context,
  agent: Agent,
  request: SemanticVerificationRequestV2,
  ledger: SemanticActionLedgerProjection,
): Promise<SemanticVerificationReceiptV2> {
  assertSemanticCandidate(request.candidate)
  const rawReports = await ctx.waterfall(
    scopeTarget(agent, agent), 'semantic/verify-v2', request, () => Promise.resolve([]),
  )
  const providerIds = new Set(rawReports.map(report => report.providerId))
  if (providerIds.size !== rawReports.length || providerIds.has('semantic-runtime')) {
    throw new Error('semantic v2 verifier provider ids must be unique and cannot replace semantic-runtime')
  }
  const proofChecks = semanticProofChecksOf(agent)
  const reports = [
    builtinReport(request, ledger),
    ...rawReports.map(report => normalizeProviderReport(request, report, proofChecks)),
  ]
  const obligations = runtimeObligations(request.spec)
  const coverage = coverageOf(obligations, reports)
  if (coverage.formallyProved + coverage.runtimeChecked + coverage.evidenceBacked
    + coverage.violated + coverage.unknown !== coverage.requiredTotal) {
    throw new Error('semantic verification coverage buckets do not equal requiredTotal')
  }
  const verdict = coverage.violated > 0 ? 'failed' : coverage.unknown > 0 ? 'unknown' : 'passed'
  const receipt: SemanticVerificationReceiptV2 = {
    sessionId: request.sessionId, revision: request.revision,
    specDigest: request.specDigest, runStateDigest: request.runStateDigest,
    candidateDigest: request.candidateDigest, actionLedgerDigest: request.actionLedgerDigest,
    verdict, coverage, reports,
  }
  assertReceiptStructure(receipt, request.spec, proofChecks)
  return receipt
}

/** Compact verifier-authored candidate receipt. */
export function renderSemanticVerificationReceiptV2(receipt: SemanticVerificationReceiptV2): string {
  const coverage = receipt.coverage
  return `Semantic candidate verification ${receipt.verdict} (candidate ${receipt.candidateDigest}; required ${coverage.requiredTotal}; formal ${coverage.formallyProved}; runtime ${coverage.runtimeChecked}; evidence ${coverage.evidenceBacked}; violated ${coverage.violated}; unknown ${coverage.unknown}).`
}

/** Test whether a message carries a v2 verification receipt. */
export function isSemanticVerificationV2Message(message: UserMessage): boolean {
  return message.source.kind === 'semantic-verification' && message.source.version === 2
}

/** Visit direct and inbox occurrences of v2 verification messages. */
export function semanticVerificationV2Messages(event: SessionEvent): readonly UserMessage[] {
  if (event.type === 'user/message') return isSemanticVerificationV2Message(event.data) ? [event.data] : []
  if (event.type !== 'agent/inbox/spliced') return []
  return event.data.inserted.filter(isSemanticVerificationV2Message)
}

/** Strictly fold the latest v2 verification receipt for one Session owner. */
export function foldSemanticVerificationV2Position(
  events: readonly SessionEvent[],
  sessionId: SessionId,
): SemanticVerificationPositionV2 | undefined {
  const calls = new Map<CallId, number>()
  const successful = new Set<CallId>()
  const messages = new Map<MessageId, UserMessage>()
  let latest: SemanticVerificationPositionV2 | undefined
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.name === VERIFY_TOOL) calls.set(event.data.callId, event.seq)
    if (event.type === 'tool/result' && event.data.message.content[0].isError !== true) successful.add(event.data.message.content[0].toolCallId)
    for (const message of semanticVerificationV2Messages(event)) {
      const prior = messages.get(message.id)
      if (prior !== undefined) {
        if (!isDeepStrictEqual(prior, message)) throw new Error(`semantic verification v2 message "${message.id}" changed`)
        continue
      }
      if (message.source.kind !== 'semantic-verification' || message.source.version !== 2) continue
      const source = message.source
      const callSeq = calls.get(source.verificationCallId)
      if (source.sessionId !== sessionId || callSeq === undefined || callSeq >= event.seq
        || !successful.has(source.verificationCallId)) {
        throw new Error('semantic verification v2 is not linked to an earlier successful verification call')
      }
      if (!isDeepStrictEqual(message.content, [{ type: 'text', text: renderSemanticVerificationReceiptV2(source.receipt) }])) {
        throw new Error('semantic verification v2 message content mismatch')
      }
      const beforeCall = events.filter(candidate => candidate.seq < callSeq)
      const spec = foldSemanticSpecifications(beforeCall).get(sessionId)
      const run = foldSemanticRuns(beforeCall).get(sessionId)
      const candidate = foldSemanticCandidates(beforeCall).get(sessionId)
      const ledger = foldSemanticActionLedger(beforeCall, sessionId)
      if (spec?.specDigest !== source.receipt.specDigest || run?.runStateDigest !== source.receipt.runStateDigest
        || candidate?.candidate.candidateDigest !== source.receipt.candidateDigest
        || ledger.ledgerDigest !== source.receipt.actionLedgerDigest) {
        throw new Error('semantic verification v2 receipt does not match the specification, run, candidate, and action ledger at call time')
      }
      if (spec === undefined || run === undefined || source.receipt.sessionId !== sessionId
        || source.receipt.revision !== run.snapshot.state.revision) {
        throw new Error('semantic verification v2 receipt ownership or revision is invalid')
      }
      assertReceiptStructure(source.receipt, spec.specification, foldSemanticProofChecks(beforeCall, sessionId))
      messages.set(message.id, message)
      latest = { receipt: source.receipt, verificationCallSeq: callSeq }
    }
  }
  return latest
}

/** Read the latest v2 candidate verification for one Agent. */
export function semanticVerificationV2Of(agent: Agent): SemanticVerificationPositionV2 | undefined {
  return foldSemanticVerificationV2Position(agent.session.events, agent.id)
}

/** Create an empty bounded ledger handle for deployments that disable action tracking. */
export function emptyLedgerQueryHandle(sessionId: SessionId, turn: number): SemanticLedgerQueryHandle {
  return { sessionId, turn, ledgerDigest: EMPTY_ACTION_LEDGER_DIGEST, query: () => Promise.resolve([]) }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Extend exact candidate verification without choosing obligation authority.
     * @param request Exact specification, run, candidate, ledger, and evidence.
     * @mode waterfall
     */
    'semantic/verify-v2'(
      request: SemanticVerificationRequestV2,
      next: () => Promise<readonly SemanticVerificationProviderReportV2[]>,
    ): Promise<readonly SemanticVerificationProviderReportV2[]>
  }
}

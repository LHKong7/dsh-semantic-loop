/** Independent semantic-verifier seam, durable receipts, and replay validation. */

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { VERIFY_TOOL, latestEnvironmentResultSeq } from './protocol.ts'
import { requiredSemanticCapabilities } from './capabilities.ts'
import { foldSemanticStatePosition } from './state.ts'
import type {
  SemanticCapabilityInventory,
  SemanticCheckpoint,
  SemanticVerificationCheck,
  SemanticEvidence,
  SemanticVerificationReceipt,
  SemanticVerificationReport,
  SemanticVerificationRequest,
  SemanticVerificationSource,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Extend independent semantic verification. Providers call `next()` and
     * append their report. The built-in runtime report is added outside this
     * chain and cannot be replaced by a provider.
     * @param request Exact checkpoint and evidence being verified.
     * @param next Delegates to the next scoped provider.
     * @mode waterfall
     */
    'semantic/verify'(
      request: SemanticVerificationRequest,
      next: () => Promise<readonly SemanticVerificationReport[]>,
    ): Promise<readonly SemanticVerificationReport[]>
  }
}

/** Receipt plus the durable call position that generated it. */
export interface SemanticVerificationPosition {
  /** Strictly replayed verifier receipt. */
  readonly receipt: SemanticVerificationReceipt
  /** Session-event sequence of the successful `semantic_verify` call. */
  readonly verificationCallSeq: number
}

/**
 * Hash one canonical checkpoint for exact receipt binding.
 * @param checkpoint Canonical checkpoint to identify.
 * @returns Lowercase SHA-256 hexadecimal digest.
 */
export function semanticCheckpointHash(checkpoint: SemanticCheckpoint): string {
  return createHash('sha256').update(JSON.stringify(checkpoint)).digest('hex')
}

/**
 * Build checks for relations already enforced by the durable state fold.
 * @param request Exact checkpoint verification input.
 * @returns Runtime verifier report that cannot be replaced by providers.
 */
export function builtinSemanticVerification(
  request: SemanticVerificationRequest,
): SemanticVerificationReport {
  const proved = (id: string, kind: string, description: string): SemanticVerificationCheck => ({
    id,
    kind,
    description,
    issuer: 'system',
    required: true,
    status: 'proved',
    detail: `proved for semantic checkpoint r${request.revision}`,
  })
  const available = new Map(request.capabilities.available.map(capability => [capability.id, capability]))
  const capabilityChecks: SemanticVerificationCheck[] = requiredSemanticCapabilities(request.checkpoint).map((id) => {
    const capability = available.get(id)
    return {
      id: `capability-${id}`,
      kind: 'runtime.capability-availability',
      description: `The plan's required "${id}" capability has a trusted runtime provider.`,
      issuer: 'system',
      required: true,
      status: capability === undefined ? 'unknown' : 'proved',
      detail: capability === undefined
        ? `no provider declared semantic capability "${id}"`
        : `provided by ${capability.providerIds.join(', ')}`,
    }
  })
  return {
    verifierId: 'semantic-runtime',
    specVersion: '1',
    assurance: 'runtime-checked',
    checks: [
      proved('goal-transition', 'runtime.goal-transition', 'The goal contract and completion definitions do not drift silently.'),
      proved('plan-graph', 'runtime.plan-graph', 'The versioned global plan is acyclic and its data dependencies are complete.'),
      proved('artifact-lineage', 'runtime.artifact-lineage', 'Required outputs are current and every artifact lineage reference is valid.'),
      proved('evidence-correlation', 'runtime.evidence-correlation', 'Every cited tool result exists earlier in the durable Session log.'),
      ...capabilityChecks,
    ],
    proofDigest: null,
  }
}

/**
 * Derive the aggregate verdict from required checks only.
 * @param reports Independently produced verifier reports.
 * @returns `failed` before `unknown`, or `passed` when every required check is proved.
 */
export function semanticVerificationVerdict(
  reports: readonly SemanticVerificationReport[],
): SemanticVerificationReceipt['verdict'] {
  const required = reports.flatMap(report => report.checks).filter(check => check.required)
  if (required.some(check => check.status === 'violated')) return 'failed'
  if (required.some(check => check.status === 'unknown')) return 'unknown'
  return 'passed'
}

/**
 * Run the agent-scoped provider chain and append the built-in runtime report.
 * @param ctx Context that dispatches registered verifier providers.
 * @param agent Agent whose checkpoint is being verified.
 * @param revision Exact checkpoint revision.
 * @param checkpoint Canonical checkpoint value.
 * @param evidence Cited successful environment-tool results.
 * @param capabilities Agent-scoped capability inventory resolved for this attempt.
 * @returns Verifier-authored receipt bound to the Session and checkpoint digest.
 */
export async function verifySemanticCheckpoint(
  ctx: Context,
  agent: Agent,
  revision: number,
  checkpoint: SemanticCheckpoint,
  evidence: readonly SemanticEvidence[],
  capabilities: SemanticCapabilityInventory,
): Promise<SemanticVerificationReceipt> {
  const request: SemanticVerificationRequest = {
    sessionId: agent.id,
    revision,
    checkpointHash: semanticCheckpointHash(checkpoint),
    checkpoint,
    evidence,
    capabilities,
  }
  const providerReports = await ctx.waterfall(
    scopeTarget(agent, agent),
    'semantic/verify',
    request,
    () => Promise.resolve([]),
  )
  const reports = [builtinSemanticVerification(request), ...providerReports]
  assertVerificationReports(reports)
  return {
    sessionId: agent.id,
    revision,
    checkpointHash: request.checkpointHash,
    verdict: semanticVerificationVerdict(reports),
    reports: [...reports],
  }
}

/** Validate provider output before it becomes durable or controls completion. */
function assertVerificationReports(reports: readonly SemanticVerificationReport[]): void {
  if (reports.length === 0) throw new Error('semantic verification requires at least one verifier report')
  const verifierIds = new Set<string>()
  for (const report of reports) {
    if (report.verifierId.trim().length === 0 || report.verifierId.trim() !== report.verifierId
      || report.specVersion.trim().length === 0 || report.specVersion.trim() !== report.specVersion) {
      throw new Error('semantic verifier id and specVersion must be non-empty')
    }
    if (verifierIds.has(report.verifierId)) throw new Error(`semantic verification repeats verifier "${report.verifierId}"`)
    verifierIds.add(report.verifierId)
    const checkIds = new Set<string>()
    for (const check of report.checks) {
      if (check.id.trim().length === 0 || check.id.trim() !== check.id
        || check.kind.trim().length === 0 || check.kind.trim() !== check.kind
        || check.description.trim().length === 0 || check.description.trim() !== check.description
        || check.detail.trim().length === 0 || check.detail.trim() !== check.detail) {
        throw new Error(`semantic verifier "${report.verifierId}" returned an empty check field`)
      }
      if (checkIds.has(check.id)) {
        throw new Error(`semantic verifier "${report.verifierId}" repeats check "${check.id}"`)
      }
      checkIds.add(check.id)
      if (check.issuer === 'agent' && check.required) {
        throw new Error(`agent-issued semantic verification check "${check.id}" cannot be required`)
      }
    }
    if (report.proofDigest !== null
      && (report.proofDigest.trim().length === 0 || report.proofDigest.trim() !== report.proofDigest)) {
      throw new Error(`semantic verifier "${report.verifierId}" returned an invalid proofDigest`)
    }
  }
}

/**
 * Render one compact verifier-generated receipt for model context and replay.
 * @param receipt Receipt to render.
 * @returns Canonical compact receipt text.
 */
export function renderSemanticVerificationReceipt(receipt: SemanticVerificationReceipt): string {
  const checks = receipt.reports.flatMap(report => report.checks)
  const required = checks.filter(check => check.required)
  const proved = required.filter(check => check.status === 'proved').length
  const blockers = required.filter(check => check.status !== 'proved').map(check => `${check.id}:${check.status}`)
  return `Semantic verification for r${receipt.revision} ${receipt.verdict} (${proved}/${required.length} required checks proved; checkpoint ${receipt.checkpointHash}${blockers.length === 0 ? '' : `; blockers: ${blockers.join(', ')}`}).`
}

/** Require one exact plain record. */
function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(record, key))) {
    throw new Error(`${label} fields must be exactly ${keys.join(', ')}`)
  }
  return record
}

/** Decode canonical non-empty text from durable verification data. */
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be non-empty and already trimmed`)
  }
  return value
}

/** Decode one durable verification check. */
function decodeCheck(value: unknown, index: number): SemanticVerificationCheck {
  const label = `semantic verification check ${index}`
  const record = exactRecord(value, ['id', 'kind', 'description', 'issuer', 'required', 'status', 'detail'], label)
  const issuer = record['issuer']
  if (issuer !== 'system' && issuer !== 'task' && issuer !== 'policy' && issuer !== 'agent') {
    throw new Error(`${label} issuer is invalid`)
  }
  const status = record['status']
  if (status !== 'proved' && status !== 'violated' && status !== 'unknown') throw new Error(`${label} status is invalid`)
  if (typeof record['required'] !== 'boolean') throw new Error(`${label} required must be a boolean`)
  const check: SemanticVerificationCheck = {
    id: text(record['id'], `${label} id`),
    kind: text(record['kind'], `${label} kind`),
    description: text(record['description'], `${label} description`),
    issuer,
    required: record['required'],
    status,
    detail: text(record['detail'], `${label} detail`),
  }
  if (check.issuer === 'agent' && check.required) throw new Error(`agent-issued semantic verification check "${check.id}" cannot be required`)
  return check
}

/** Decode one durable verifier report. */
function decodeReport(value: unknown, index: number): SemanticVerificationReport {
  const label = `semantic verification report ${index}`
  const record = exactRecord(value, ['verifierId', 'specVersion', 'assurance', 'checks', 'proofDigest'], label)
  const assurance = record['assurance']
  if (assurance !== 'evidence-backed' && assurance !== 'runtime-checked' && assurance !== 'formally-proved') {
    throw new Error(`${label} assurance is invalid`)
  }
  const proofDigest = record['proofDigest']
  if (proofDigest !== null && typeof proofDigest !== 'string') throw new Error(`${label} proofDigest must be a string or null`)
  if (!Array.isArray(record['checks'])) throw new Error(`${label} checks must be an array`)
  return {
    verifierId: text(record['verifierId'], `${label} verifierId`),
    specVersion: text(record['specVersion'], `${label} specVersion`),
    assurance,
    checks: record['checks'].map(decodeCheck),
    proofDigest: proofDigest === null ? null : text(proofDigest, `${label} proofDigest`),
  }
}

/** Decode one untrusted durable receipt. */
function decodeReceipt(value: unknown): SemanticVerificationReceipt {
  const record = exactRecord(value, ['sessionId', 'revision', 'checkpointHash', 'verdict', 'reports'], 'semantic verification receipt')
  const revision = record['revision']
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('semantic verification receipt revision must be a positive safe integer')
  }
  const verdict = record['verdict']
  if (verdict !== 'passed' && verdict !== 'failed' && verdict !== 'unknown') {
    throw new Error('semantic verification receipt verdict is invalid')
  }
  const checkpointHash = text(record['checkpointHash'], 'semantic verification receipt checkpointHash')
  if (!/^[a-f0-9]{64}$/u.test(checkpointHash)) throw new Error('semantic verification receipt checkpointHash must be sha256 hex')
  if (!Array.isArray(record['reports'])) throw new Error('semantic verification receipt reports must be an array')
  const reports = record['reports'].map(decodeReport)
  assertVerificationReports(reports)
  if (semanticVerificationVerdict(reports) !== verdict) throw new Error('semantic verification receipt verdict does not match required checks')
  return {
    sessionId: SessionId(text(record['sessionId'], 'semantic verification receipt sessionId')),
    revision,
    checkpointHash,
    verdict,
    reports,
  }
}

/**
 * Decode verifier-generated message provenance from durable JSON.
 * @param source Untrusted durable source data.
 * @returns Validated semantic-verification source.
 */
export function decodeSemanticVerificationSource(source: unknown): SemanticVerificationSource {
  const record = exactRecord(
    source,
    ['kind', 'version', 'sessionId', 'verificationCallId', 'receipt'],
    'semantic verification source',
  )
  if (record['kind'] !== 'semantic-verification' || record['version'] !== 1) {
    throw new Error('semantic verification source kind or version is invalid')
  }
  const sessionId = SessionId(text(record['sessionId'], 'semantic verification source sessionId'))
  const receipt = decodeReceipt(record['receipt'])
  if (receipt.sessionId !== sessionId) throw new Error('semantic verification source and receipt sessionId differ')
  return {
    kind: 'semantic-verification',
    version: 1,
    sessionId,
    verificationCallId: CallId(text(record['verificationCallId'], 'semantic verification source verificationCallId')),
    receipt,
  }
}

/**
 * Test whether a user message carries semantic-verification provenance.
 * @param message User message to classify.
 * @returns Whether the source discriminant identifies a verification receipt.
 */
export function isSemanticVerificationMessage(message: UserMessage): boolean {
  return message.source.kind === 'semantic-verification'
}

/**
 * Visit verification messages carried by one durable event.
 * @param event Session event to inspect.
 * @returns Direct or inbox-spliced verification messages.
 */
export function semanticVerificationMessages(event: SessionEvent): readonly UserMessage[] {
  if (event.type === 'user/message') return isSemanticVerificationMessage(event.data) ? [event.data] : []
  if (event.type !== 'agent/inbox/spliced') return []
  return event.data.inserted.filter(isSemanticVerificationMessage)
}

/**
 * Strictly replay verifier-generated receipts and return the latest owner receipt.
 * @param events Session events in sequence order.
 * @param sessionId Owning Session identity; fork-inherited receipts remain parent-owned.
 * @returns Latest validated receipt and its call position, or `undefined`.
 */
export function foldSemanticVerificationPosition(
  events: readonly SessionEvent[],
  sessionId: SessionId,
): SemanticVerificationPosition | undefined {
  const calls = new Map<CallId, { readonly expectedRevision: number; readonly seq: number }>()
  const successful = new Set<CallId>()
  const usedCalls = new Set<CallId>()
  const messages = new Map<MessageId, UserMessage>()
  let latest: SemanticVerificationPosition | undefined
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.name === VERIFY_TOOL) {
      let expectedRevision: unknown
      try {
        const args = JSON.parse(event.data.arguments) as Record<string, unknown>
        expectedRevision = args['expected_revision']
      } catch (_invalidModelArguments) {
        continue
      }
      if (typeof expectedRevision === 'number' && Number.isSafeInteger(expectedRevision) && expectedRevision >= 1) {
        calls.set(event.data.callId, { expectedRevision, seq: event.seq })
      }
    } else if (event.type === 'tool/result' && event.data.message.content[0].isError !== true) {
      successful.add(event.data.message.content[0].toolCallId)
    }

    for (const message of semanticVerificationMessages(event)) {
      const prior = messages.get(message.id)
      if (prior !== undefined) {
        if (!isDeepStrictEqual(prior, message)) throw new Error(`semantic verification message "${message.id}" changed after its first occurrence`)
        continue
      }
      const source = decodeSemanticVerificationSource(message.source)
      const expectedContent = [{ type: 'text' as const, text: renderSemanticVerificationReceipt(source.receipt) }]
      if (!isDeepStrictEqual(message.content, expectedContent)) {
        throw new Error(`semantic verification message "${message.id}" content does not match its receipt`)
      }
      const call = calls.get(source.verificationCallId)
      if (call === undefined || !successful.has(source.verificationCallId)) {
        throw new Error(`semantic verification is not linked to an earlier successful ${VERIFY_TOOL} call/result`)
      }
      if (usedCalls.has(source.verificationCallId)) throw new Error(`semantic verification call "${source.verificationCallId}" is reused`)
      if (call.expectedRevision !== source.receipt.revision) {
        throw new Error('semantic verification receipt revision does not match its tool call')
      }
      const beforeCall = events.filter(candidate => candidate.seq < call.seq)
      const checkpoint = foldSemanticStatePosition(beforeCall, source.sessionId)
      if (checkpoint === undefined || checkpoint.state.revision !== source.receipt.revision
        || semanticCheckpointHash(checkpoint.state.checkpoint) !== source.receipt.checkpointHash) {
        throw new Error('semantic verification receipt does not match the checkpoint at verification time')
      }
      if (checkpoint.state.checkpoint.status !== 'ready') {
        throw new Error('semantic verification receipt requires a ready checkpoint')
      }
      const environmentResultSeq = latestEnvironmentResultSeq(beforeCall)
      if (environmentResultSeq !== undefined && checkpoint.checkpointCallSeq <= environmentResultSeq) {
        throw new Error('semantic verification receipt used a checkpoint older than the latest environment result')
      }
      messages.set(message.id, message)
      usedCalls.add(source.verificationCallId)
      if (source.sessionId === sessionId) latest = { receipt: source.receipt, verificationCallSeq: call.seq }
    }
  }
  return latest
}

/**
 * Read the latest strictly replayed verification position for one agent.
 * @param agent Agent whose Session log is projected.
 * @returns Latest validated receipt and call position, or `undefined`.
 */
export function semanticVerificationPositionOf(agent: Agent): SemanticVerificationPosition | undefined {
  return foldSemanticVerificationPosition(agent.session.events, agent.id)
}

/**
 * Read the latest strictly replayed verification receipt for one agent.
 * @param agent Agent whose Session log is projected.
 * @returns Latest validated receipt, or `undefined`.
 */
export function semanticVerificationOf(agent: Agent): SemanticVerificationReceipt | undefined {
  return semanticVerificationPositionOf(agent)?.receipt
}

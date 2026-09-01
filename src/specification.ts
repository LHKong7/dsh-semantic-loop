/** Authoritative semantic requirements and immutable specification lineages. */

import type { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { isSha256Digest, semanticDigest } from './canonical.ts'

/** Requirement semantics determine the accepted verifier class. */
export type SemanticRequirementKind = 'hard-formal' | 'grounded' | 'soft-preference'

/** Lifecycle phases in which a requirement applies. */
export type SemanticRequirementPhase = 'pre-action' | 'post-action' | 'final-candidate' | 'always'

/** Sources allowed to propose or authorize semantic requirements. */
export type SemanticAuthority = 'user' | 'task' | 'policy' | 'system' | 'agent'

/** Exact source text from which a requirement was derived. */
export interface SemanticSourceRef {
  readonly authority: SemanticAuthority
  readonly sourceId: string
  readonly quote: string
  readonly start?: number
  readonly end?: number
}

/** Content-addressed formalization consumed by an independent verifier. */
export interface SemanticFormalizationRef {
  readonly language: 'json-schema' | 'smtlib2' | 'lean4' | 'coq' | 'dafny'
    | 'policy-automaton' | 'deterministic-checker'
  readonly locator: string
  readonly contentDigest: string
  readonly verifierIds: readonly string[]
  readonly assumptionIds: readonly string[]
}

/** Trusted data-source and freshness requirements for grounded checks. */
export interface SemanticGroundingRef {
  readonly sourcePolicy: string
  readonly freshnessPolicy: string
  readonly requiredFields: readonly string[]
}

/** Advisory evaluation configuration for a soft preference. */
export interface SemanticSoftEvaluationRef {
  readonly rubricId: string
  readonly evaluatorIds: readonly string[]
  readonly minimumScore?: number
}

/** One stable semantic obligation. */
export interface SemanticRequirement {
  readonly id: string
  readonly statement: string
  readonly kind: SemanticRequirementKind
  readonly phase: SemanticRequirementPhase
  readonly required: boolean
  readonly sources: readonly SemanticSourceRef[]
  readonly dependsOn: readonly string[]
  readonly formalization?: SemanticFormalizationRef
  readonly grounding?: SemanticGroundingRef
  readonly softEvaluation?: SemanticSoftEvaluationRef
}

/** Authority record that permits one immutable specification version. */
export type SemanticSpecAuthorization =
  | {
      readonly kind: 'trusted-sources'
      readonly authoritySourceIds: readonly string[]
      readonly coverageDigest: string
    }
  | {
      readonly kind: 'confirmed-amendment'
      readonly authority: Exclude<SemanticAuthority, 'agent'>
      readonly approvalRequestId: string
      readonly approvalOutcome: 'allowed-once'
      readonly changeDigest: string
      readonly previousSpecDigest: string
    }

/** Ambiguity that blocks only its declared requirements and phases. */
export interface SemanticOpenQuestion {
  readonly id: string
  readonly statement: string
  readonly required: boolean
  readonly sources: readonly SemanticSourceRef[]
  readonly blocksRequirementIds: readonly string[]
  readonly blockedPhases: readonly SemanticRequirementPhase[]
  readonly status: 'open' | 'resolved' | 'superseded'
}

/** Coverage disposition for one complete authority input. */
export interface SemanticSourceCoverage {
  readonly sourceId: string
  readonly inputDigest: string
  readonly disposition: 'requirement' | 'open-question' | 'non-requirement'
  readonly requirementIds?: readonly string[]
  readonly openQuestionIds?: readonly string[]
  readonly reviewerId: string
  readonly reviewerAuthority: 'task' | 'policy' | 'system' | 'user-confirmed' | 'agent'
  readonly status: 'covered' | 'unknown'
}

/** Immutable specification version bound to its authority inputs. */
export interface SemanticSpecification {
  readonly id: string
  readonly version: number
  readonly parentDigest: string | null
  readonly goal: string
  readonly inputs: readonly string[]
  readonly outputs: readonly string[]
  readonly assumptions: readonly SemanticRequirement[]
  readonly requirements: readonly SemanticRequirement[]
  readonly forbiddenStates: readonly SemanticRequirement[]
  readonly openQuestions: readonly SemanticOpenQuestion[]
  readonly sourceCoverage: readonly SemanticSourceCoverage[]
  readonly changeReason: string
  readonly authorization: SemanticSpecAuthorization
}

/** Flat model proposal resolved against runtime-owned authority inputs. */
export interface SemanticRequirementProposal {
  readonly id: string
  readonly statement: string
  readonly kind: SemanticRequirementKind
  readonly phase: SemanticRequirementPhase
  readonly required: boolean
  readonly sourceId?: string
  readonly quote?: string
}

/** Trusted provider contribution merged during `semantic_begin`. */
export interface SemanticSpecificationReport {
  readonly providerId: string
  readonly authority: 'task' | 'policy' | 'system'
  readonly requirements: readonly SemanticRequirement[]
  readonly forbiddenStates: readonly SemanticRequirement[]
  readonly openQuestions: readonly SemanticOpenQuestion[]
  readonly sourceCoverage: readonly SemanticSourceCoverage[]
}

/** Input to trusted specification providers. */
export interface SemanticSpecificationRequest {
  readonly sessionId: SessionId
  readonly turn: number
  readonly inputMessageIds: readonly string[]
  readonly proposals: readonly SemanticRequirementProposal[]
  readonly baseSpecDigest?: string
  readonly signal: AbortSignal
}

/** Durable specification source authored by a successful begin call. */
export interface SemanticSpecificationSourceV1 {
  readonly kind: 'semantic-specification'
  readonly version: 1
  readonly sessionId: SessionId
  readonly specificationCallId: CallId
  readonly authoringCause: { readonly kind: 'tool-call'; readonly callId: CallId }
  readonly specDigest: string
  readonly specification: SemanticSpecification
}

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const OPAQUE_LOCATOR = /^(?:semantic|artifact):\/\/[A-Za-z0-9._~:/-]+$/u

function text(value: string, label: string): void {
  if (value.length === 0 || value.trim() !== value) throw new Error(`${label} must be non-empty and already trimmed`)
}

function identifier(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) throw new Error(`${label} must be lower-kebab-case`)
}

function unique(values: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    text(value, label)
    if (seen.has(value)) throw new Error(`${label} repeats "${value}"`)
    seen.add(value)
  }
}

/** Validate one requirement independently of a particular specification. */
export function assertSemanticRequirement(requirement: SemanticRequirement): void {
  identifier(requirement.id, 'semantic requirement id')
  text(requirement.statement, `semantic requirement "${requirement.id}" statement`)
  if (requirement.sources.length === 0 && requirement.required) {
    throw new Error(`required semantic requirement "${requirement.id}" must cite an authority source`)
  }
  for (const source of requirement.sources) {
    text(source.sourceId, `semantic requirement "${requirement.id}" sourceId`)
    text(source.quote, `semantic requirement "${requirement.id}" quote`)
    if ((source.start === undefined) !== (source.end === undefined)) {
      throw new Error(`semantic requirement "${requirement.id}" source span must supply start and end together`)
    }
    if (source.start !== undefined && source.end !== undefined
      && (!Number.isSafeInteger(source.start) || !Number.isSafeInteger(source.end)
        || source.start < 0 || source.end <= source.start)) {
      throw new Error(`semantic requirement "${requirement.id}" source span is invalid`)
    }
    if (source.authority === 'agent' && requirement.required) {
      throw new Error(`agent-authored semantic requirement "${requirement.id}" cannot be required`)
    }
  }
  unique(requirement.dependsOn, `semantic requirement "${requirement.id}" dependency`)
  if (requirement.formalization !== undefined) {
    if (!OPAQUE_LOCATOR.test(requirement.formalization.locator)) {
      throw new Error(`semantic requirement "${requirement.id}" formalization locator must be opaque`)
    }
    if (!isSha256Digest(requirement.formalization.contentDigest)) {
      throw new Error(`semantic requirement "${requirement.id}" formalization digest must be SHA-256`)
    }
    unique(requirement.formalization.verifierIds, `semantic requirement "${requirement.id}" verifier id`)
    unique(requirement.formalization.assumptionIds, `semantic requirement "${requirement.id}" assumption id`)
  }
  if (requirement.kind === 'hard-formal' && requirement.softEvaluation !== undefined) {
    throw new Error(`hard-formal semantic requirement "${requirement.id}" cannot use softEvaluation`)
  }
  if (requirement.kind === 'grounded' && requirement.grounding === undefined) {
    throw new Error(`grounded semantic requirement "${requirement.id}" requires grounding`)
  }
  if (requirement.kind === 'soft-preference' && requirement.softEvaluation === undefined) {
    throw new Error(`soft-preference semantic requirement "${requirement.id}" requires softEvaluation`)
  }
}

/** Validate one complete specification and its internal references. */
export function assertSemanticSpecification(specification: SemanticSpecification): void {
  identifier(specification.id, 'semantic specification id')
  if (!Number.isSafeInteger(specification.version) || specification.version < 1) {
    throw new Error('semantic specification version must be a positive safe integer')
  }
  if (specification.version === 1 ? specification.parentDigest !== null : !isSha256Digest(specification.parentDigest)) {
    throw new Error('semantic specification parentDigest must be null only for version 1 and SHA-256 otherwise')
  }
  text(specification.goal, 'semantic specification goal')
  text(specification.changeReason, 'semantic specification changeReason')
  unique(specification.inputs, 'semantic specification input')
  unique(specification.outputs, 'semantic specification output')
  const all = [...specification.assumptions, ...specification.requirements, ...specification.forbiddenStates]
  const ids = new Set<string>()
  for (const requirement of all) {
    assertSemanticRequirement(requirement)
    if (ids.has(requirement.id)) throw new Error(`semantic specification repeats requirement "${requirement.id}"`)
    ids.add(requirement.id)
  }
  for (const requirement of all) {
    for (const dependency of requirement.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`semantic requirement "${requirement.id}" depends on unknown "${dependency}"`)
    }
  }
  const questionIds = new Set<string>()
  for (const question of specification.openQuestions) {
    identifier(question.id, 'semantic open question id')
    text(question.statement, `semantic open question "${question.id}" statement`)
    if (questionIds.has(question.id)) throw new Error(`semantic specification repeats open question "${question.id}"`)
    questionIds.add(question.id)
    for (const blocked of question.blocksRequirementIds) {
      if (!ids.has(blocked)) throw new Error(`semantic open question "${question.id}" blocks unknown requirement "${blocked}"`)
    }
  }
  const coverageIds = new Set<string>()
  for (const coverage of specification.sourceCoverage) {
    text(coverage.sourceId, 'semantic source coverage sourceId')
    if (!isSha256Digest(coverage.inputDigest)) throw new Error(`semantic source coverage "${coverage.sourceId}" inputDigest must be SHA-256`)
    if (coverageIds.has(coverage.sourceId)) throw new Error(`semantic source coverage repeats "${coverage.sourceId}"`)
    coverageIds.add(coverage.sourceId)
    for (const id of coverage.requirementIds ?? []) {
      if (!ids.has(id)) throw new Error(`semantic source coverage "${coverage.sourceId}" names unknown requirement "${id}"`)
    }
    for (const id of coverage.openQuestionIds ?? []) {
      if (!questionIds.has(id)) throw new Error(`semantic source coverage "${coverage.sourceId}" names unknown question "${id}"`)
    }
    const requirementIds = coverage.requirementIds ?? []
    const openQuestionIds = coverage.openQuestionIds ?? []
    if (coverage.disposition === 'requirement'
      ? requirementIds.length === 0 || openQuestionIds.length > 0
      : coverage.disposition === 'open-question'
        ? openQuestionIds.length === 0 || requirementIds.length > 0
        : requirementIds.length > 0 || openQuestionIds.length > 0) {
      throw new Error(`semantic source coverage "${coverage.sourceId}" has fields inconsistent with ${coverage.disposition}`)
    }
    if (coverage.reviewerAuthority === 'agent' && coverage.status === 'covered') {
      throw new Error(`agent review cannot mark semantic source "${coverage.sourceId}" fully covered`)
    }
  }
  if (coverageIds.size !== specification.inputs.length
    || specification.inputs.some(sourceId => !coverageIds.has(sourceId))) {
    throw new Error('semantic specification must assign one coverage disposition to every authority input')
  }
  if (specification.authorization.kind === 'trusted-sources') {
    if (specification.authorization.coverageDigest !== semanticDigest('source-coverage', 1, specification.sourceCoverage)) {
      throw new Error('semantic specification authorization coverageDigest does not match sourceCoverage')
    }
    unique(specification.authorization.authoritySourceIds, 'semantic specification authority source')
  } else if (!isSha256Digest(specification.authorization.changeDigest)
    || !isSha256Digest(specification.authorization.previousSpecDigest)
    || specification.authorization.approvalRequestId.length === 0) {
    throw new Error('semantic specification confirmed amendment fields are invalid')
  }
}

/** Compute the authority-independent material digest of one specification amendment. */
export function semanticSpecificationChangeDigest(
  previousSpecDigest: string,
  next: SemanticSpecification,
): string {
  const { authorization: _authorization, ...material } = next
  return semanticDigest('spec-change', 1, { previousSpecDigest, next: material })
}

/** Compute the canonical digest of one specification. */
export function semanticSpecDigest(specification: SemanticSpecification): string {
  assertSemanticSpecification(specification)
  return semanticDigest('spec', 1, specification)
}

/**
 * Reject deletion or weakening of established required obligations.
 *
 * Additive versions remain valid without a semantic-equivalence engine. Any
 * changed required definition needs a separately confirmed amendment.
 *
 * @param previous Prior specification in the lineage.
 * @param next Candidate successor.
 */
export function assertSemanticSpecificationTransition(
  previous: SemanticSpecification,
  next: SemanticSpecification,
): void {
  assertSemanticSpecification(previous)
  assertSemanticSpecification(next)
  const previousDigest = semanticSpecDigest(previous)
  if (next.version !== previous.version + 1 || next.parentDigest !== previousDigest) {
    throw new Error(`semantic specification successor must be version ${previous.version + 1} with parent ${previousDigest}`)
  }
  const nextById = new Map(
    [...next.assumptions, ...next.requirements, ...next.forbiddenStates].map(requirement => [requirement.id, requirement]),
  )
  for (const requirement of [...previous.assumptions, ...previous.requirements, ...previous.forbiddenStates]) {
    if (!requirement.required) continue
    const replacement = nextById.get(requirement.id)
    const unchanged = replacement !== undefined
      && semanticDigest('requirement', 1, replacement) === semanticDigest('requirement', 1, requirement)
    if (!unchanged && (next.authorization.kind !== 'confirmed-amendment'
      || next.authorization.previousSpecDigest !== previousDigest
      || next.authorization.changeDigest !== semanticSpecificationChangeDigest(previousDigest, next))) {
      throw new Error(`semantic specification cannot remove or change required requirement "${requirement.id}" without a confirmed amendment`)
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Contribute trusted task, policy, or system requirements during begin.
     * @param request Current authority inputs and model proposals.
     * @mode waterfall
     */
    'semantic/specification'(
      request: SemanticSpecificationRequest,
      next: () => Promise<readonly SemanticSpecificationReport[]>,
    ): Promise<readonly SemanticSpecificationReport[]>
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Immutable semantic specification committed by `semantic_begin`. */
    'semantic-specification': SemanticSpecificationSourceV1
  }
}

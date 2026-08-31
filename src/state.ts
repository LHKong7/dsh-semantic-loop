/** Validation, rendering, and replay for semantic checkpoint messages. */

import { isDeepStrictEqual } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { assertSemanticArtifacts, assertSemanticArtifactTransition } from './artifacts.ts'
import { assertSemanticGoal, assertSemanticPlan, assertSemanticTransition } from './plan.ts'
import { CHECKPOINT_TOOL, isSemanticToolName } from './protocol.ts'
import type {
  SemanticCheckpoint,
  SemanticCheckpointSource,
  SemanticArtifact,
  SemanticArtifactRef,
  SemanticCriterion,
  SemanticFact,
  SemanticGap,
  SemanticGoal,
  SemanticPlan,
  SemanticPlanNode,
  SemanticState,
} from './types.ts'

const semanticIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

/** Require one plain record with exactly the declared keys. */
function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const record = value as Record<string, unknown>
  const actual = Object.keys(record)
  const unknown = actual.filter(key => !keys.includes(key))
  const missing = keys.filter(key => !Object.hasOwn(record, key))
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(`${label} fields must be exactly ${keys.join(', ')}`)
  }
  return record
}

/** Require canonical non-empty text. */
function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be non-empty and already trimmed`)
  }
  return value
}

/** Require canonical text that may be empty. */
function optionalEvidence(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value) {
    throw new Error(`${label} must be a trimmed string`)
  }
  return value
}

/** Require a stable semantic collection id. */
function checkpointId(value: unknown, label: string): string {
  const id = requiredText(value, label)
  if (!semanticIdPattern.test(id)) throw new Error(`${label} must be lower-kebab-case`)
  return id
}

/** Require an array and decode every item. */
function decodeArray<T>(value: unknown, label: string, decode: (item: unknown, index: number) => T): T[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map(decode)
}

/** Decode one persisted opaque tool-call identity. */
function decodeCallId(value: unknown, index: number): CallId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`semantic evidence call id ${index} must be non-empty`)
  }
  return CallId(value)
}

/** Decode one persisted criterion. */
function decodeCriterion(value: unknown, index: number): SemanticCriterion {
  const label = `semantic criterion ${index}`
  const record = exactRecord(value, ['id', 'description', 'status', 'evidence', 'evidenceCallIds'], label)
  const status = record['status']
  if (status !== 'unmet' && status !== 'met') throw new Error(`${label} status must be unmet or met`)
  return {
    id: checkpointId(record['id'], `${label} id`),
    description: requiredText(record['description'], `${label} description`),
    status,
    evidence: optionalEvidence(record['evidence'], `${label} evidence`),
    evidenceCallIds: decodeArray(
      record['evidenceCallIds'],
      `${label} evidence call ids`,
      (item, callIndex) => decodeCallId(item, callIndex),
    ),
  }
}

/** Decode one persisted fact. */
function decodeFact(value: unknown, index: number): SemanticFact {
  const label = `semantic fact ${index}`
  const record = exactRecord(value, ['id', 'statement', 'evidence', 'evidenceCallIds'], label)
  return {
    id: checkpointId(record['id'], `${label} id`),
    statement: requiredText(record['statement'], `${label} statement`),
    evidence: requiredText(record['evidence'], `${label} evidence`),
    evidenceCallIds: decodeArray(
      record['evidenceCallIds'],
      `${label} evidence call ids`,
      (item, callIndex) => decodeCallId(item, callIndex),
    ),
  }
}

/** Decode one persisted gap. */
function decodeGap(value: unknown, index: number): SemanticGap {
  const label = `semantic gap ${index}`
  const record = exactRecord(value, ['id', 'description'], label)
  return {
    id: checkpointId(record['id'], `${label} id`),
    description: requiredText(record['description'], `${label} description`),
  }
}

/** Decode one persisted artifact reference. */
function decodeArtifactRef(value: unknown, index: number): SemanticArtifactRef {
  const label = `semantic artifact reference ${index}`
  const record = exactRecord(value, ['id', 'version'], label)
  const version = record['version']
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new Error(`${label} version must be a positive safe integer`)
  }
  return { id: checkpointId(record['id'], `${label} id`), version }
}

/** Decode one persisted semantic artifact. */
function decodeArtifact(value: unknown, index: number): SemanticArtifact {
  const label = `semantic artifact ${index}`
  const record = exactRecord(
    value,
    [
      'id', 'version', 'kind', 'summary', 'locator', 'contentDigest', 'producerNodeId', 'planRevision',
      'inputs', 'evidenceCallIds',
    ],
    label,
  )
  const version = record['version']
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new Error(`${label} version must be a positive safe integer`)
  }
  const producerNodeId = record['producerNodeId']
  if (producerNodeId !== null && typeof producerNodeId !== 'string') {
    throw new Error(`${label} producerNodeId must be a string or null`)
  }
  const planRevision = record['planRevision']
  if (typeof planRevision !== 'number' || !Number.isSafeInteger(planRevision) || planRevision < 0) {
    throw new Error(`${label} planRevision must be a non-negative safe integer`)
  }
  return {
    id: checkpointId(record['id'], `${label} id`),
    version,
    kind: requiredText(record['kind'], `${label} kind`),
    summary: requiredText(record['summary'], `${label} summary`),
    locator: requiredText(record['locator'], `${label} locator`),
    contentDigest: requiredText(record['contentDigest'], `${label} contentDigest`),
    producerNodeId: producerNodeId === null ? null : checkpointId(producerNodeId, `${label} producerNodeId`),
    planRevision,
    inputs: decodeArray(record['inputs'], `${label} inputs`, decodeArtifactRef),
    evidenceCallIds: decodeArray(
      record['evidenceCallIds'],
      `${label} evidence call ids`,
      (item, callIndex) => decodeCallId(item, callIndex),
    ),
  }
}

/** Decode one persisted stable goal contract. */
function decodeGoal(value: unknown): SemanticGoal {
  const record = exactRecord(value, ['id', 'version', 'statement', 'constraints'], 'semantic goal')
  const version = record['version']
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new Error('semantic goal version must be a positive safe integer')
  }
  const goal: SemanticGoal = {
    id: checkpointId(record['id'], 'semantic goal id'),
    version,
    statement: requiredText(record['statement'], 'semantic goal statement'),
    constraints: decodeArray(
      record['constraints'],
      'semantic goal constraints',
      (item, index) => requiredText(item, `semantic goal constraint ${index}`),
    ),
  }
  assertSemanticGoal(goal)
  return goal
}

/** Decode one persisted plan node. */
function decodePlanNode(value: unknown, index: number): SemanticPlanNode {
  const label = `semantic plan node ${index}`
  const record = exactRecord(
    value,
    [
      'id', 'operation', 'description', 'dependsOn', 'inputArtifactIds', 'outputArtifactId',
      'requiredCapabilities', 'required',
    ],
    label,
  )
  return {
    id: checkpointId(record['id'], `${label} id`),
    operation: requiredText(record['operation'], `${label} operation`),
    description: requiredText(record['description'], `${label} description`),
    dependsOn: decodeArray(
      record['dependsOn'],
      `${label} dependencies`,
      (item, dependencyIndex) => checkpointId(item, `${label} dependency ${dependencyIndex}`),
    ),
    inputArtifactIds: decodeArray(
      record['inputArtifactIds'],
      `${label} input artifact ids`,
      (item, inputIndex) => checkpointId(item, `${label} input artifact id ${inputIndex}`),
    ),
    outputArtifactId: checkpointId(record['outputArtifactId'], `${label} output artifact id`),
    requiredCapabilities: decodeArray(
      record['requiredCapabilities'],
      `${label} required capabilities`,
      (item, capabilityIndex) => requiredText(item, `${label} required capability ${capabilityIndex}`),
    ),
    required: (() => {
      if (typeof record['required'] !== 'boolean') throw new Error(`${label} required must be a boolean`)
      return record['required']
    })(),
  }
}

/** Decode one persisted versioned plan graph. */
function decodePlan(value: unknown): SemanticPlan {
  const record = exactRecord(value, ['revision', 'changeReason', 'nodes'], 'semantic plan')
  const revision = record['revision']
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('semantic plan revision must be a positive safe integer')
  }
  const plan: SemanticPlan = {
    revision,
    changeReason: requiredText(record['changeReason'], 'semantic plan changeReason'),
    nodes: decodeArray(record['nodes'], 'semantic plan nodes', decodePlanNode),
  }
  assertSemanticPlan(plan)
  return plan
}

/** Decode one canonical checkpoint value. */
function decodeCheckpoint(value: unknown): SemanticCheckpoint {
  const record = exactRecord(
    value,
    ['goal', 'criteria', 'plan', 'activeNodeId', 'artifacts', 'facts', 'observedCallIds', 'gaps', 'nextAction', 'status'],
    'semantic checkpoint',
  )
  const status = record['status']
  if (status !== 'exploring' && status !== 'ready') {
    throw new Error('semantic checkpoint status must be exploring or ready')
  }
  const activeNodeId = record['activeNodeId']
  if (activeNodeId !== null && typeof activeNodeId !== 'string') {
    throw new Error('semantic checkpoint activeNodeId must be a string or null')
  }
  const checkpoint: SemanticCheckpoint = {
    goal: decodeGoal(record['goal']),
    criteria: decodeArray(record['criteria'], 'semantic criteria', decodeCriterion),
    plan: decodePlan(record['plan']),
    activeNodeId: activeNodeId === null ? null : checkpointId(activeNodeId, 'semantic checkpoint activeNodeId'),
    artifacts: decodeArray(record['artifacts'], 'semantic artifacts', decodeArtifact),
    facts: decodeArray(record['facts'], 'semantic facts', decodeFact),
    observedCallIds: decodeArray(record['observedCallIds'], 'semantic observed call ids', decodeCallId),
    gaps: decodeArray(record['gaps'], 'semantic gaps', decodeGap),
    nextAction: requiredText(record['nextAction'], 'semantic checkpoint nextAction'),
    status,
  }
  assertCheckpointRelations(checkpoint)
  assertSemanticArtifacts(checkpoint)
  return checkpoint
}

/** Mutable arguments accepted from the model before canonicalization. */
export interface SemanticCheckpointInput {
  /** Stable task contract currently being solved. */
  readonly goal: SemanticGoal
  /** Explicit conditions used by the completion gate. */
  readonly criteria: readonly (Omit<SemanticCriterion, 'evidenceCallIds'> & {
    readonly evidenceCallIds: readonly string[]
  })[]
  /** Stable global operation graph for the current goal. */
  readonly plan: SemanticPlan
  /** Plan node selected for the next action, or `null` when none is active. */
  readonly activeNodeId: string | null
  /** Append-only semantic intermediate results. */
  readonly artifacts: readonly (Omit<SemanticArtifact, 'evidenceCallIds'> & {
    readonly evidenceCallIds: readonly string[]
  })[]
  /** Evidence-backed facts retained for later decisions. */
  readonly facts: readonly (Omit<SemanticFact, 'evidenceCallIds'> & {
    readonly evidenceCallIds: readonly string[]
  })[]
  /** Unresolved questions that block completion. */
  readonly gaps: readonly SemanticGap[]
  /** Next concrete action selected from the current state. */
  readonly nextAction: string
  /** Whether more observation is required or completion may be attempted. */
  readonly status: SemanticCheckpoint['status']
}

/** Canonical checkpoint-tool arguments reconstructed from durable model JSON. */
interface SemanticCheckpointCallArguments {
  readonly expectedRevision: number
  readonly input: SemanticCheckpointInput
}

/** Preserve model string input until ordinary checkpoint canonicalization runs. */
function modelString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value
}

/** Decode one criterion from durable checkpoint-tool arguments. */
function decodeCallCriterion(value: unknown, index: number): SemanticCheckpointInput['criteria'][number] {
  const label = `semantic checkpoint call criterion ${index}`
  const record = exactRecord(value, ['id', 'description', 'status', 'evidence', 'evidence_call_ids'], label)
  const status = record['status']
  if (status !== 'unmet' && status !== 'met') throw new Error(`${label} status must be unmet or met`)
  return {
    id: modelString(record['id'], `${label} id`),
    description: modelString(record['description'], `${label} description`),
    status,
    evidence: modelString(record['evidence'], `${label} evidence`),
    evidenceCallIds: decodeArray(
      record['evidence_call_ids'],
      `${label} evidence call ids`,
      (item, callIndex) => modelString(item, `${label} evidence call id ${callIndex}`),
    ),
  }
}

/** Decode one fact from durable checkpoint-tool arguments. */
function decodeCallFact(value: unknown, index: number): SemanticCheckpointInput['facts'][number] {
  const label = `semantic checkpoint call fact ${index}`
  const record = exactRecord(value, ['id', 'statement', 'evidence', 'evidence_call_ids'], label)
  return {
    id: modelString(record['id'], `${label} id`),
    statement: modelString(record['statement'], `${label} statement`),
    evidence: modelString(record['evidence'], `${label} evidence`),
    evidenceCallIds: decodeArray(
      record['evidence_call_ids'],
      `${label} evidence call ids`,
      (item, callIndex) => modelString(item, `${label} evidence call id ${callIndex}`),
    ),
  }
}

/** Decode one gap from durable checkpoint-tool arguments. */
function decodeCallGap(value: unknown, index: number): SemanticGap {
  const label = `semantic checkpoint call gap ${index}`
  const record = exactRecord(value, ['id', 'description'], label)
  return {
    id: modelString(record['id'], `${label} id`),
    description: modelString(record['description'], `${label} description`),
  }
}

/** Decode one artifact reference from durable model tool arguments. */
function decodeCallArtifactRef(value: unknown, index: number): SemanticArtifactRef {
  const label = `semantic checkpoint call artifact reference ${index}`
  const record = exactRecord(value, ['id', 'version'], label)
  const version = record['version']
  if (typeof version !== 'number') throw new Error(`${label} version must be a number`)
  return { id: modelString(record['id'], `${label} id`), version }
}

/** Decode one artifact from durable model tool arguments. */
function decodeCallArtifact(value: unknown, index: number): SemanticCheckpointInput['artifacts'][number] {
  const label = `semantic checkpoint call artifact ${index}`
  const record = exactRecord(
    value,
    [
      'id', 'version', 'kind', 'summary', 'locator', 'content_digest', 'producer_node_id', 'plan_revision',
      'inputs', 'evidence_call_ids',
    ],
    label,
  )
  const version = record['version']
  if (typeof version !== 'number') throw new Error(`${label} version must be a number`)
  const producerNodeId = record['producer_node_id']
  if (producerNodeId !== null && typeof producerNodeId !== 'string') {
    throw new Error(`${label} producer_node_id must be a string or null`)
  }
  const planRevision = record['plan_revision']
  if (typeof planRevision !== 'number') throw new Error(`${label} plan_revision must be a number`)
  return {
    id: modelString(record['id'], `${label} id`),
    version,
    kind: modelString(record['kind'], `${label} kind`),
    summary: modelString(record['summary'], `${label} summary`),
    locator: modelString(record['locator'], `${label} locator`),
    contentDigest: modelString(record['content_digest'], `${label} content digest`),
    producerNodeId,
    planRevision,
    inputs: decodeArray(record['inputs'], `${label} inputs`, decodeCallArtifactRef),
    evidenceCallIds: decodeArray(
      record['evidence_call_ids'],
      `${label} evidence call ids`,
      (item, callIndex) => modelString(item, `${label} evidence call id ${callIndex}`),
    ),
  }
}

/** Decode one goal contract from durable model tool arguments. */
function decodeCallGoal(value: unknown): SemanticGoal {
  const record = exactRecord(value, ['id', 'version', 'statement', 'constraints'], 'semantic checkpoint call goal')
  const version = record['version']
  if (typeof version !== 'number') throw new Error('semantic checkpoint call goal version must be a number')
  return {
    id: modelString(record['id'], 'semantic checkpoint call goal id'),
    version,
    statement: modelString(record['statement'], 'semantic checkpoint call goal statement'),
    constraints: decodeArray(
      record['constraints'],
      'semantic checkpoint call goal constraints',
      (item, index) => modelString(item, `semantic checkpoint call goal constraint ${index}`),
    ),
  }
}

/** Decode one plan node from durable model tool arguments. */
function decodeCallPlanNode(value: unknown, index: number): SemanticPlanNode {
  const label = `semantic checkpoint call plan node ${index}`
  const record = exactRecord(
    value,
    [
      'id', 'operation', 'description', 'depends_on', 'input_artifact_ids', 'output_artifact_id',
      'required_capabilities', 'required',
    ],
    label,
  )
  return {
    id: modelString(record['id'], `${label} id`),
    operation: modelString(record['operation'], `${label} operation`),
    description: modelString(record['description'], `${label} description`),
    dependsOn: decodeArray(
      record['depends_on'],
      `${label} dependencies`,
      (item, dependencyIndex) => modelString(item, `${label} dependency ${dependencyIndex}`),
    ),
    inputArtifactIds: decodeArray(
      record['input_artifact_ids'],
      `${label} input artifact ids`,
      (item, inputIndex) => modelString(item, `${label} input artifact id ${inputIndex}`),
    ),
    outputArtifactId: modelString(record['output_artifact_id'], `${label} output artifact id`),
    requiredCapabilities: decodeArray(
      record['required_capabilities'],
      `${label} required capabilities`,
      (item, capabilityIndex) => modelString(item, `${label} required capability ${capabilityIndex}`),
    ),
    required: (() => {
      if (typeof record['required'] !== 'boolean') throw new Error(`${label} required must be a boolean`)
      return record['required']
    })(),
  }
}

/** Decode one plan graph from durable model tool arguments. */
function decodeCallPlan(value: unknown): SemanticPlan {
  const record = exactRecord(value, ['revision', 'change_reason', 'nodes'], 'semantic checkpoint call plan')
  const revision = record['revision']
  if (typeof revision !== 'number') throw new Error('semantic checkpoint call plan revision must be a number')
  return {
    revision,
    changeReason: modelString(record['change_reason'], 'semantic checkpoint call plan change reason'),
    nodes: decodeArray(record['nodes'], 'semantic checkpoint call plan nodes', decodeCallPlanNode),
  }
}

/** Decode the model JSON whose successful result commits one checkpoint. */
function decodeCheckpointCallArguments(raw: string): SemanticCheckpointCallArguments {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (_invalidModelArguments) {
    throw new Error('successful semantic checkpoint call arguments must be valid JSON')
  }
  const record = exactRecord(
    value,
    [
      'expected_revision', 'goal', 'criteria', 'plan', 'active_node_id', 'artifacts', 'facts', 'gaps',
      'next_action', 'status',
    ],
    'semantic checkpoint call arguments',
  )
  const expectedRevision = record['expected_revision']
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('semantic checkpoint call expected_revision must be a non-negative safe integer')
  }
  const status = record['status']
  if (status !== 'exploring' && status !== 'ready') {
    throw new Error('semantic checkpoint call status must be exploring or ready')
  }
  const activeNodeId = record['active_node_id']
  if (activeNodeId !== null && typeof activeNodeId !== 'string') {
    throw new Error('semantic checkpoint call active_node_id must be a string or null')
  }
  return {
    expectedRevision,
    input: {
      goal: decodeCallGoal(record['goal']),
      criteria: decodeArray(record['criteria'], 'semantic checkpoint call criteria', decodeCallCriterion),
      plan: decodeCallPlan(record['plan']),
      activeNodeId,
      artifacts: decodeArray(record['artifacts'], 'semantic checkpoint call artifacts', decodeCallArtifact),
      facts: decodeArray(record['facts'], 'semantic checkpoint call facts', decodeCallFact),
      gaps: decodeArray(record['gaps'], 'semantic checkpoint call gaps', decodeCallGap),
      nextAction: modelString(record['next_action'], 'semantic checkpoint call next_action'),
      status,
    },
  }
}

/** Reject duplicate identities inside one semantic collection. */
function assertUniqueIds(kind: string, values: readonly { readonly id: string }[]): void {
  const ids = new Set<string>()
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`semantic checkpoint repeats ${kind} id "${value.id}"`)
    ids.add(value.id)
  }
}

/** Reject duplicate tool-result references inside one claim or observation list. */
function assertUniqueCallIds(kind: string, values: readonly CallId[]): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`semantic checkpoint repeats ${kind} call id`)
  }
}

/** Enforce relations that JSON schemas cannot express. */
function assertCheckpointRelations(checkpoint: SemanticCheckpoint): void {
  assertUniqueIds('criterion', checkpoint.criteria)
  assertUniqueIds('fact', checkpoint.facts)
  assertUniqueIds('gap', checkpoint.gaps)
  assertUniqueCallIds('observed', checkpoint.observedCallIds)
  const planNodeIds = new Set(checkpoint.plan.nodes.map(node => node.id))
  if (checkpoint.activeNodeId !== null && !planNodeIds.has(checkpoint.activeNodeId)) {
    throw new Error(`semantic checkpoint active node "${checkpoint.activeNodeId}" is not in the plan`)
  }
  for (const criterion of checkpoint.criteria) {
    assertUniqueCallIds(`criterion "${criterion.id}" evidence`, criterion.evidenceCallIds)
    if (criterion.status === 'met' && criterion.evidence.length === 0) {
      throw new Error(`met semantic criterion "${criterion.id}" requires evidence`)
    }
    if (criterion.status === 'unmet' && criterion.evidence.length > 0) {
      throw new Error(`unmet semantic criterion "${criterion.id}" must not carry evidence`)
    }
  }
  for (const fact of checkpoint.facts) {
    assertUniqueCallIds(`fact "${fact.id}" evidence`, fact.evidenceCallIds)
  }
  for (const artifact of checkpoint.artifacts) {
    assertUniqueCallIds(`artifact "${artifact.id}@${artifact.version}" evidence`, artifact.evidenceCallIds)
  }
  if (checkpoint.status === 'ready') {
    if (checkpoint.criteria.length === 0) {
      throw new Error('ready semantic checkpoint requires at least one completion criterion')
    }
    const unmet = checkpoint.criteria.filter(criterion => criterion.status === 'unmet')
    if (unmet.length > 0) {
      throw new Error(`ready semantic checkpoint has unmet criteria: ${unmet.map(item => item.id).join(', ')}`)
    }
    if (checkpoint.gaps.length > 0) {
      throw new Error(`ready semantic checkpoint has open gaps: ${checkpoint.gaps.map(item => item.id).join(', ')}`)
    }
    if (checkpoint.activeNodeId !== null) {
      throw new Error('ready semantic checkpoint must not have an active plan node')
    }
  }
}

/** Require every claim reference to name an earlier successful environment result. */
function assertEvidenceReferences(
  checkpoint: SemanticCheckpoint,
  availableCallIds: ReadonlySet<CallId>,
): void {
  for (const item of [...checkpoint.criteria, ...checkpoint.facts, ...checkpoint.artifacts]) {
    for (const callId of item.evidenceCallIds) {
      if (!availableCallIds.has(callId)) {
        throw new Error(`semantic checkpoint ${item.id} evidence call id "${callId}" is not an earlier successful environment-tool result`)
      }
    }
  }
}

/**
 * Trim and validate one complete model-authored checkpoint.
 *
 * @param input Mutable model input to canonicalize.
 * @param observedCallIds Log-derived successful environment results from the current turn.
 * @param availableCallIds Every earlier successful environment result that claims may reference.
 * @returns Canonical whole-state replacement.
 */
export function resolveSemanticCheckpoint(
  input: SemanticCheckpointInput,
  observedCallIds: readonly CallId[] = [],
  availableCallIds: ReadonlySet<CallId> = new Set(observedCallIds),
): SemanticCheckpoint {
  const checkpoint: SemanticCheckpoint = {
    goal: {
      id: input.goal.id.trim(),
      version: input.goal.version,
      statement: input.goal.statement.trim(),
      constraints: input.goal.constraints.map(value => value.trim()),
    },
    criteria: input.criteria.map(criterion => ({
      id: criterion.id.trim(),
      description: criterion.description.trim(),
      status: criterion.status,
      evidence: criterion.evidence.trim(),
      evidenceCallIds: criterion.evidenceCallIds.map(value => CallId(value)),
    })),
    plan: {
      revision: input.plan.revision,
      changeReason: input.plan.changeReason.trim(),
      nodes: input.plan.nodes.map(node => ({
        id: node.id.trim(),
        operation: node.operation.trim(),
        description: node.description.trim(),
        dependsOn: node.dependsOn.map(value => value.trim()),
        inputArtifactIds: node.inputArtifactIds.map(value => value.trim()),
        outputArtifactId: node.outputArtifactId.trim(),
        requiredCapabilities: node.requiredCapabilities.map(value => value.trim()),
        required: node.required,
      })),
    },
    activeNodeId: input.activeNodeId === null ? null : input.activeNodeId.trim(),
    artifacts: input.artifacts.map(artifact => ({
      id: artifact.id.trim(),
      version: artifact.version,
      kind: artifact.kind.trim(),
      summary: artifact.summary.trim(),
      locator: artifact.locator.trim(),
      contentDigest: artifact.contentDigest.trim(),
      producerNodeId: artifact.producerNodeId === null ? null : artifact.producerNodeId.trim(),
      planRevision: artifact.planRevision,
      inputs: artifact.inputs.map(input => ({ id: input.id.trim(), version: input.version })),
      evidenceCallIds: artifact.evidenceCallIds.map(value => CallId(value)),
    })),
    facts: input.facts.map(fact => ({
      id: fact.id.trim(),
      statement: fact.statement.trim(),
      evidence: fact.evidence.trim(),
      evidenceCallIds: fact.evidenceCallIds.map(value => CallId(value)),
    })),
    observedCallIds: [...observedCallIds],
    gaps: input.gaps.map(gap => ({
      id: gap.id.trim(),
      description: gap.description.trim(),
    })),
    nextAction: input.nextAction.trim(),
    status: input.status,
  }
  const resolved = decodeCheckpoint(checkpoint)
  assertEvidenceReferences(resolved, availableCallIds)
  return resolved
}

/**
 * Collect successful environment-tool results cited by checkpoint claims.
 *
 * @param checkpoint Canonical checkpoint whose criteria and facts may cite results.
 * @returns Unique call ids in criterion-then-fact declaration order.
 */
export function semanticEvidenceCallIds(checkpoint: SemanticCheckpoint): readonly CallId[] {
  return [...new Set([
    ...checkpoint.criteria.flatMap(criterion => criterion.evidenceCallIds),
    ...checkpoint.facts.flatMap(fact => fact.evidenceCallIds),
    ...checkpoint.artifacts.flatMap(artifact => artifact.evidenceCallIds),
  ])]
}

/**
 * Decode and validate one persisted semantic message source.
 *
 * @param source Untrusted durable message provenance.
 * @returns Validated semantic checkpoint provenance.
 */
export function decodeSemanticCheckpointSource(source: unknown): SemanticCheckpointSource {
  const record = exactRecord(
    source,
    ['kind', 'version', 'sessionId', 'checkpointCallId', 'revision', 'checkpoint'],
    'semantic checkpoint source',
  )
  if (record['kind'] !== 'semantic-checkpoint') throw new Error('semantic checkpoint source has an invalid kind')
  if (record['version'] !== 6) throw new Error('semantic checkpoint source has an unsupported version')
  const sessionId = record['sessionId']
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('semantic checkpoint source sessionId must be non-empty')
  }
  const checkpointCallId = record['checkpointCallId']
  if (typeof checkpointCallId !== 'string' || checkpointCallId.length === 0) {
    throw new Error('semantic checkpoint source checkpointCallId must be non-empty')
  }
  const revision = record['revision']
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('semantic checkpoint source revision must be a positive safe integer')
  }
  return {
    kind: 'semantic-checkpoint',
    version: 6,
    sessionId: SessionId(sessionId),
    checkpointCallId: CallId(checkpointCallId),
    revision,
    checkpoint: decodeCheckpoint(record['checkpoint']),
  }
}

/**
 * Test whether a user message declares semantic-checkpoint provenance.
 *
 * @param message User message to inspect.
 * @returns Whether the source tag identifies a semantic checkpoint.
 */
export function isSemanticCheckpointMessage(message: UserMessage): boolean {
  return message.source.kind === 'semantic-checkpoint'
}

/**
 * Render the complete model-facing snapshot for one revision.
 *
 * @param state Canonical revision and checkpoint.
 * @returns Deterministic user-role context text.
 */
export function renderSemanticCheckpoint(state: SemanticState): string {
  const { revision, checkpoint } = state
  const criteria = checkpoint.criteria.length === 0
    ? '- (none yet)'
    : checkpoint.criteria.map((item) => {
      const calls = item.evidenceCallIds.length === 0 ? '' : ` — tool results: ${item.evidenceCallIds.join(', ')}`
      return `- [${item.status === 'met' ? 'x' : ' '}] ${item.id}: ${item.description}${item.evidence.length > 0 ? ` — evidence: ${item.evidence}` : ''}${calls}`
    }).join('\n')
  const facts = checkpoint.facts.length === 0
    ? '- (none yet)'
    : checkpoint.facts.map((item) => {
      const calls = item.evidenceCallIds.length === 0 ? '' : ` — tool results: ${item.evidenceCallIds.join(', ')}`
      return `- ${item.id}: ${item.statement} — evidence: ${item.evidence}${calls}`
    }).join('\n')
  const gaps = checkpoint.gaps.length === 0
    ? '- (none)'
    : checkpoint.gaps.map(item => `- ${item.id}: ${item.description}`).join('\n')
  const observedTools = checkpoint.observedCallIds.length === 0
    ? '- (none in this turn)'
    : checkpoint.observedCallIds.map(callId => `- ${callId}`).join('\n')
  const plan = checkpoint.plan.nodes.length === 0
    ? '- (no operations yet)'
    : checkpoint.plan.nodes.map((node) => {
      const dependencies = node.dependsOn.length === 0 ? 'root' : `after ${node.dependsOn.join(', ')}`
      const capabilities = node.requiredCapabilities.length === 0
        ? ''
        : `; capabilities: ${node.requiredCapabilities.join(', ')}`
      const active = checkpoint.activeNodeId === node.id ? ' [active]' : ''
      const inputs = node.inputArtifactIds.length === 0 ? 'no inputs' : `inputs: ${node.inputArtifactIds.join(', ')}`
      return `- ${node.id}${active}: ${node.operation} (${dependencies}; ${inputs}; output: ${node.outputArtifactId}${capabilities}) — ${node.description}`
    }).join('\n')
  const artifacts = checkpoint.artifacts.length === 0
    ? '- (none yet)'
    : checkpoint.artifacts.map((artifact) => {
      const producer = artifact.producerNodeId === null ? 'external' : `${artifact.producerNodeId}@p${artifact.planRevision}`
      const inputs = artifact.inputs.length === 0 ? '' : `; inputs: ${artifact.inputs.map(input => `${input.id}@${input.version}`).join(', ')}`
      return `- ${artifact.id}@${artifact.version}: ${artifact.kind} — ${artifact.summary} (${producer}; ${artifact.locator}; digest: ${artifact.contentDigest}${inputs})`
    }).join('\n')
  return `Semantic state r${revision}. This whole snapshot supersedes every earlier semantic-state snapshot.

Goal ${checkpoint.goal.id}@${checkpoint.goal.version}: ${checkpoint.goal.statement}
Goal constraints: ${checkpoint.goal.constraints.length === 0 ? '(none)' : checkpoint.goal.constraints.join('; ')}
Status: ${checkpoint.status}

Plan p${checkpoint.plan.revision} (${checkpoint.plan.changeReason}):
${plan}

Semantic artifacts:
${artifacts}

Completion criteria:
${criteria}

Evidence-backed facts:
${facts}

Successful environment-tool results observed in this turn:
${observedTools}

Open gaps:
${gaps}

Next action: ${checkpoint.nextAction}`
}

/**
 * Render the compact model-visible commit receipt for one durable checkpoint.
 *
 * The assistant tool call already contains the authored state. Keeping the
 * complete canonical value only in message provenance avoids a second full
 * copy in model history; `semantic_state` restores it on demand.
 *
 * @param state Canonical revision and checkpoint.
 * @returns Compact receipt inserted into the next model step.
 */
export function renderSemanticCheckpointReceipt(state: SemanticState): string {
  const { revision, checkpoint } = state
  const unmet = checkpoint.criteria.filter(criterion => criterion.status === 'unmet').length
  return `Semantic state r${revision} committed (goal ${checkpoint.goal.id}@${checkpoint.goal.version}; plan p${checkpoint.plan.revision}; ${checkpoint.artifacts.length} artifacts; ${checkpoint.status}; ${checkpoint.gaps.length} open gaps; ${unmet} unmet criteria). The complete state is stored in the Session log. Call semantic_state only to recover it after resume or compaction.`
}

/** Replay state used to enforce message identity and revision relations. */
interface SemanticFoldState {
  readonly messages: Map<MessageId, UserMessage>
  readonly revisions: Map<SessionId, Map<number, MessageId>>
  readonly histories: Map<SessionId, SemanticState[]>
  readonly latest: Map<SessionId, SemanticState>
  readonly latestPositions: Map<SessionId, SemanticStatePosition>
  readonly calls: Map<CallId, { readonly name: string; readonly turn: number }>
  readonly checkpointCalls: Map<CallId, {
    readonly arguments: string
    readonly callSeq: number
    readonly observedCallIds: readonly CallId[]
    readonly availableCallIds: ReadonlySet<CallId>
  }>
  readonly successfulCheckpointCallIds: Set<CallId>
  readonly checkpointCallOwners: Map<CallId, { readonly sessionId: SessionId; readonly messageId: MessageId }>
  readonly successfulCallIds: Set<CallId>
  observedCallIds: CallId[]
}

/** Latest owner checkpoint plus the durable call that authored it. */
export interface SemanticStatePosition {
  readonly state: SemanticState
  /** Durable `semantic_checkpoint` call sequence that authored this state. */
  readonly checkpointCallSeq: number
}

/**
 * Visit semantic messages carried by one durable event.
 *
 * @param event Candidate Session event.
 * @returns Semantic checkpoint messages carried by the event.
 */
export function semanticMessages(event: SessionEvent): readonly UserMessage[] {
  if (event.type === 'user/message') return isSemanticCheckpointMessage(event.data) ? [event.data] : []
  if (event.type !== 'agent/inbox/spliced') return []
  return event.data.inserted.filter(isSemanticCheckpointMessage)
}

/** Apply one semantic message occurrence to a replay fold. */
function applySemanticMessage(state: SemanticFoldState, message: UserMessage): void {
  const source = decodeSemanticCheckpointSource(message.source)
  const semanticState = { revision: source.revision, checkpoint: source.checkpoint }
  const expectedContent = [{ type: 'text' as const, text: renderSemanticCheckpointReceipt(semanticState) }]
  if (!isDeepStrictEqual(message.content, expectedContent)) {
    throw new Error(`semantic checkpoint message "${message.id}" content does not match its source state`)
  }
  const prior = state.messages.get(message.id)
  if (prior !== undefined) {
    if (!isDeepStrictEqual(prior, message)) {
      throw new Error(`semantic checkpoint message "${message.id}" changed after its first occurrence`)
    }
    return
  }
  const checkpointCall = state.checkpointCalls.get(source.checkpointCallId)
  if (checkpointCall === undefined || !state.successfulCheckpointCallIds.has(source.checkpointCallId)) {
    throw new Error(`semantic checkpoint revision ${source.revision} is not linked to an earlier successful ${CHECKPOINT_TOOL} call/result`)
  }
  const callOwner = state.checkpointCallOwners.get(source.checkpointCallId)
  if (callOwner !== undefined) {
    throw new Error(`semantic checkpoint call "${source.checkpointCallId}" is already owned by message "${callOwner.messageId}" in session "${callOwner.sessionId}"`)
  }
  const callArguments = decodeCheckpointCallArguments(checkpointCall.arguments)
  const expectedRevision = (state.latest.get(source.sessionId)?.revision ?? 0) + 1
  if (callArguments.expectedRevision !== expectedRevision - 1 || source.revision !== expectedRevision) {
    throw new Error(`semantic checkpoint revision must be ${expectedRevision}, got ${source.revision}`)
  }
  const expectedCheckpoint = resolveSemanticCheckpoint(
    callArguments.input,
    checkpointCall.observedCallIds,
    checkpointCall.availableCallIds,
  )
  if (!isDeepStrictEqual(source.checkpoint, expectedCheckpoint)) {
    throw new Error(`semantic checkpoint revision ${source.revision} does not match call "${source.checkpointCallId}" arguments`)
  }
  if (!isDeepStrictEqual(source.checkpoint.observedCallIds, state.observedCallIds)) {
    throw new Error(`semantic checkpoint revision ${source.revision} observed call ids do not match successful environment-tool results in this turn`)
  }
  assertEvidenceReferences(source.checkpoint, state.successfulCallIds)
  assertSemanticTransition(state.latest.get(source.sessionId)?.checkpoint, source.checkpoint)
  assertSemanticArtifactTransition(state.latest.get(source.sessionId)?.checkpoint, source.checkpoint)
  let revisions = state.revisions.get(source.sessionId)
  if (revisions === undefined) {
    revisions = new Map()
    state.revisions.set(source.sessionId, revisions)
  }
  const revisionOwner = revisions.get(source.revision)
  if (revisionOwner !== undefined) {
    throw new Error(`semantic checkpoint revision ${source.revision} is reused by message "${message.id}"`)
  }
  state.messages.set(message.id, message)
  state.checkpointCallOwners.set(source.checkpointCallId, { sessionId: source.sessionId, messageId: message.id })
  revisions.set(source.revision, message.id)
  let history = state.histories.get(source.sessionId)
  if (history === undefined) {
    history = []
    state.histories.set(source.sessionId, history)
  }
  history.push(semanticState)
  state.latest.set(source.sessionId, semanticState)
  state.latestPositions.set(source.sessionId, { state: semanticState, checkpointCallSeq: checkpointCall.callSeq })
}

/** Update evidence correlation before semantic messages at the same event sequence. */
function applyProtocolEvent(state: SemanticFoldState, event: SessionEvent): void {
  if (event.type === 'turn/start') {
    state.observedCallIds = []
    return
  }
  if (event.type === 'tool/call') {
    state.calls.set(event.data.callId, { name: event.data.name, turn: event.data.turn })
    if (event.data.name === CHECKPOINT_TOOL) {
      state.checkpointCalls.set(event.data.callId, {
        arguments: event.data.arguments,
        callSeq: event.seq,
        observedCallIds: [...state.observedCallIds],
        availableCallIds: new Set(state.successfulCallIds),
      })
    }
    return
  }
  if (event.type !== 'tool/result') return
  const block = event.data.message.content[0]
  const call = state.calls.get(block.toolCallId)
  if (block.isError !== true && call?.name === CHECKPOINT_TOOL && call.turn === event.data.turn) {
    state.successfulCheckpointCallIds.add(block.toolCallId)
  }
  if (block.isError !== true && call?.turn === event.data.turn && !isSemanticToolName(call.name)) {
    if (!state.observedCallIds.includes(block.toolCallId)) state.observedCallIds.push(block.toolCallId)
    state.successfulCallIds.add(block.toolCallId)
  }
}

/** Strictly replay every semantic checkpoint stream and correlation relation. */
function replaySemanticStates(events: readonly SessionEvent[]): SemanticFoldState {
  const state: SemanticFoldState = {
    messages: new Map(),
    revisions: new Map(),
    histories: new Map(),
    latest: new Map(),
    latestPositions: new Map(),
    calls: new Map(),
    checkpointCalls: new Map(),
    successfulCheckpointCallIds: new Set(),
    checkpointCallOwners: new Map(),
    successfulCallIds: new Set(),
    observedCallIds: [],
  }
  for (const event of events) {
    applyProtocolEvent(state, event)
    for (const message of semanticMessages(event)) applySemanticMessage(state, message)
  }
  return state
}

/**
 * Strictly replay one owner stream and retain its latest checkpoint-call position.
 *
 * @param events Durable Session events in sequence order.
 * @param sessionId Identity whose latest checkpoint is requested.
 * @returns Latest state position, or `undefined` before initialization.
 */
export function foldSemanticStatePosition(
  events: readonly SessionEvent[],
  sessionId: SessionId,
): SemanticStatePosition | undefined {
  return replaySemanticStates(events).latestPositions.get(sessionId)
}

/**
 * Strictly replay every owner-scoped semantic checkpoint stream in a Session log.
 *
 * @param events Durable Session events in sequence order.
 * @returns Latest checkpoint for each owning Session identity.
 */
export function foldSemanticStates(events: readonly SessionEvent[]): ReadonlyMap<SessionId, SemanticState> {
  return new Map(replaySemanticStates(events).latest)
}

/**
 * Strictly replay one owner stream and retain every canonical checkpoint.
 * @param events Durable Session events in sequence order.
 * @param sessionId Identity whose checkpoint history is requested.
 * @returns Contiguous owner-scoped states in revision order.
 */
export function foldSemanticStateHistory(
  events: readonly SessionEvent[],
  sessionId: SessionId,
): readonly SemanticState[] {
  return [...(replaySemanticStates(events).histories.get(sessionId) ?? [])]
}

/**
 * Strictly replay the semantic checkpoint stream owned by one Session identity.
 *
 * @param events Durable Session events in sequence order.
 * @param sessionId Identity whose latest checkpoint is requested.
 * @returns Latest owned checkpoint, or `undefined` before initialization.
 */
export function foldSemanticState(events: readonly SessionEvent[], sessionId: SessionId): SemanticState | undefined {
  return foldSemanticStates(events).get(sessionId)
}

/**
 * Read the latest durable semantic state for one live agent.
 *
 * @param agent Agent whose Session log owns the state.
 * @returns Latest owned checkpoint, or `undefined` before initialization.
 */
export function semanticStateOf(agent: Agent): SemanticState | undefined {
  return foldSemanticState(agent.session.events, agent.id)
}

/**
 * Read the latest durable semantic state and checkpoint-call sequence for one agent.
 *
 * @param agent Agent whose Session log owns the state.
 * @returns Latest state position, or `undefined` before initialization.
 */
export function semanticStatePositionOf(agent: Agent): SemanticStatePosition | undefined {
  return foldSemanticStatePosition(agent.session.events, agent.id)
}

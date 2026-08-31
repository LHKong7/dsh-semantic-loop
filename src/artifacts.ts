/** Semantic-artifact lineage, currency, and append-only transition rules. */

import { isDeepStrictEqual } from 'node:util'
import type {
  SemanticArtifact,
  SemanticArtifactRef,
  SemanticArtifactStatus,
  SemanticCheckpoint,
} from './types.ts'

/** Stable map key for one artifact version. */
export function semanticArtifactKey(reference: SemanticArtifactRef): string {
  return `${reference.id}@${reference.version}`
}

/** Latest declared version for every artifact identity. */
function latestVersions(checkpoint: SemanticCheckpoint): ReadonlyMap<string, number> {
  const latest = new Map<string, number>()
  for (const artifact of checkpoint.artifacts) latest.set(artifact.id, artifact.version)
  return latest
}

/**
 * Derive whether one artifact remains valid under the current plan and latest inputs.
 *
 * @param checkpoint Canonical whole semantic state.
 * @param reference Artifact version to inspect.
 * @returns `current` only when the version, plan, and complete input ancestry are current.
 */
export function semanticArtifactStatus(
  checkpoint: SemanticCheckpoint,
  reference: SemanticArtifactRef,
): SemanticArtifactStatus {
  const artifacts = new Map(checkpoint.artifacts.map(artifact => [semanticArtifactKey(artifact), artifact]))
  const latest = latestVersions(checkpoint)
  const visiting = new Set<string>()
  const statusOf = (candidate: SemanticArtifactRef): SemanticArtifactStatus => {
    const key = semanticArtifactKey(candidate)
    const artifact = artifacts.get(key)
    if (artifact === undefined || latest.get(candidate.id) !== candidate.version) return 'stale'
    if (artifact.producerNodeId !== null && artifact.planRevision !== checkpoint.plan.revision) return 'stale'
    if (visiting.has(key)) return 'stale'
    visiting.add(key)
    const staleInput = artifact.inputs.some(input => statusOf(input) === 'stale')
    visiting.delete(key)
    return staleInput ? 'stale' : 'current'
  }
  return statusOf(reference)
}

/** Return the latest current artifact for one stable identity. */
export function semanticCurrentArtifact(
  checkpoint: SemanticCheckpoint,
  id: string,
): SemanticArtifact | undefined {
  const artifact = checkpoint.artifacts.findLast(candidate => candidate.id === id)
  return artifact !== undefined && semanticArtifactStatus(checkpoint, artifact) === 'current' ? artifact : undefined
}

/** Enforce artifact version, producer, and input-lineage relations inside one checkpoint. */
export function assertSemanticArtifacts(checkpoint: SemanticCheckpoint): void {
  const nodes = new Map(checkpoint.plan.nodes.map(node => [node.id, node]))
  const artifacts = new Map<string, SemanticArtifact>()
  const latestVersion = new Map<string, number>()
  for (const artifact of checkpoint.artifacts) {
    const expectedVersion = (latestVersion.get(artifact.id) ?? 0) + 1
    if (artifact.version !== expectedVersion) {
      throw new Error(`semantic artifact "${artifact.id}" version must be ${expectedVersion}, got ${artifact.version}`)
    }
    const key = semanticArtifactKey(artifact)
    if (artifacts.has(key)) throw new Error(`semantic checkpoint repeats artifact "${key}"`)
    const inputKeys = artifact.inputs.map(semanticArtifactKey)
    if (new Set(inputKeys).size !== inputKeys.length) {
      throw new Error(`semantic artifact "${key}" repeats an input version`)
    }
    for (const input of artifact.inputs) {
      if (!artifacts.has(semanticArtifactKey(input))) {
        throw new Error(`semantic artifact "${key}" references missing or later input "${semanticArtifactKey(input)}"`)
      }
    }
    if (artifact.producerNodeId === null) {
      if (artifact.planRevision !== 0) {
        throw new Error(`external semantic artifact "${key}" must use planRevision 0`)
      }
      if (artifact.inputs.length > 0) {
        throw new Error(`external semantic artifact "${key}" must not declare derived inputs`)
      }
    } else {
      const node = nodes.get(artifact.producerNodeId)
      if (node === undefined) {
        throw new Error(`semantic artifact "${key}" names missing producer node "${artifact.producerNodeId}"`)
      }
      if (node.outputArtifactId !== artifact.id) {
        throw new Error(`semantic artifact "${key}" does not match producer node output "${node.outputArtifactId}"`)
      }
      if (artifact.planRevision > checkpoint.plan.revision) {
        throw new Error(`semantic artifact "${key}" uses future plan revision ${artifact.planRevision}`)
      }
      const inputIds = artifact.inputs.map(input => input.id)
      if (!isDeepStrictEqual(inputIds, node.inputArtifactIds)) {
        throw new Error(`semantic artifact "${key}" inputs do not match producer node "${node.id}"`)
      }
    }
    artifacts.set(key, artifact)
    latestVersion.set(artifact.id, artifact.version)
  }

  if (checkpoint.status !== 'ready') return
  const missing = checkpoint.plan.nodes
    .filter(node => node.required && semanticCurrentArtifact(checkpoint, node.outputArtifactId) === undefined)
    .map(node => node.id)
  if (missing.length > 0) {
    throw new Error(`ready semantic checkpoint lacks current artifacts for required plan nodes: ${missing.join(', ')}`)
  }
}

/**
 * Preserve immutable semantic results across revisions and clear them for a replacement goal.
 *
 * @param previous Latest committed checkpoint, if any.
 * @param next Candidate checkpoint.
 */
export function assertSemanticArtifactTransition(
  previous: SemanticCheckpoint | undefined,
  next: SemanticCheckpoint,
): void {
  if (previous === undefined) return
  if (next.goal.id !== previous.goal.id) {
    if (next.artifacts.length > 0) {
      throw new Error('a replacement semantic goal must start without inherited artifacts')
    }
    return
  }
  if (next.artifacts.length < previous.artifacts.length
    || !isDeepStrictEqual(next.artifacts.slice(0, previous.artifacts.length), previous.artifacts)) {
    throw new Error('semantic artifact history is append-only within one goal')
  }
}

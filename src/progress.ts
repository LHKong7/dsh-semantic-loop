/** Material-progress classification over durable semantic checkpoint history. */

import { isDeepStrictEqual } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { foldSemanticStateHistory } from './state.ts'
import type { SemanticCheckpoint, SemanticProgress, SemanticState } from './types.ts'

/** Stable key for one immutable artifact version. */
function artifactKey(artifact: { readonly id: string; readonly version: number }): string {
  return `${artifact.id}@${artifact.version}`
}

/** Tool-result ids cited by semantic claims and artifacts. */
function citedCallIds(checkpoint: SemanticCheckpoint): readonly string[] {
  return [...new Set([
    ...checkpoint.criteria.flatMap(criterion => criterion.evidenceCallIds),
    ...checkpoint.facts.flatMap(fact => fact.evidenceCallIds),
    ...checkpoint.artifacts.flatMap(artifact => artifact.evidenceCallIds),
  ])]
}

/**
 * Classify changes that advance or deliberately revise semantic work.
 * Tool calls, observations, `nextAction`, and active-node movement do not
 * qualify without a corresponding plan, artifact, criterion, gap, fact, or
 * cited-evidence change.
 * @param previous Preceding checkpoint, or `undefined` for initialization.
 * @param next Candidate checkpoint.
 * @returns Stable change labels suitable for telemetry and diagnostics.
 */
export function semanticMaterialChanges(
  previous: SemanticCheckpoint | undefined,
  next: SemanticCheckpoint,
): readonly string[] {
  if (previous === undefined) return [`goal-initialized:${next.goal.id}@${next.goal.version}`]
  if (previous.goal.id !== next.goal.id) return [`goal-replaced:${next.goal.id}@${next.goal.version}`]

  const changes: string[] = []
  if (previous.plan.revision !== next.plan.revision) {
    changes.push(`plan-revised:${next.plan.revision}`)
  }
  const previousCriteria = new Map(previous.criteria.map(criterion => [criterion.id, criterion]))
  for (const criterion of next.criteria) {
    if (previousCriteria.get(criterion.id)?.status === 'unmet' && criterion.status === 'met') {
      changes.push(`criterion-met:${criterion.id}`)
    }
  }
  const nextGaps = new Set(next.gaps.map(gap => gap.id))
  for (const gap of previous.gaps) {
    if (!nextGaps.has(gap.id)) changes.push(`gap-closed:${gap.id}`)
  }
  const previousArtifacts = new Set(previous.artifacts.map(artifactKey))
  for (const artifact of next.artifacts) {
    const key = artifactKey(artifact)
    if (!previousArtifacts.has(key)) changes.push(`artifact-appended:${key}`)
  }
  const previousFacts = new Map(previous.facts.map(fact => [fact.id, fact]))
  for (const fact of next.facts) {
    const prior = previousFacts.get(fact.id)
    if (prior === undefined) changes.push(`fact-added:${fact.id}`)
    else if (!isDeepStrictEqual(prior, fact)) changes.push(`fact-updated:${fact.id}`)
  }
  const previousEvidence = new Set(citedCallIds(previous))
  for (const callId of citedCallIds(next)) {
    if (!previousEvidence.has(callId)) changes.push(`evidence-linked:${callId}`)
  }
  return changes
}

/**
 * Classify every checkpoint and derive consecutive stagnation.
 * @param states Contiguous owner-scoped checkpoint history.
 * @returns One progress record per checkpoint revision.
 */
export function semanticProgressTimeline(states: readonly SemanticState[]): readonly SemanticProgress[] {
  const timeline: SemanticProgress[] = []
  let previous: SemanticCheckpoint | undefined
  let stagnantRevisions = 0
  for (const state of states) {
    const materialChanges = semanticMaterialChanges(previous, state.checkpoint)
    stagnantRevisions = materialChanges.length === 0 ? stagnantRevisions + 1 : 0
    timeline.push({ revision: state.revision, materialChanges, stagnantRevisions })
    previous = state.checkpoint
  }
  return timeline
}

/**
 * Read material progress at the latest durable checkpoint.
 * @param agent Agent whose Session history is projected.
 * @returns Latest progress record, or `undefined` before initialization.
 */
export function semanticProgressOf(agent: Agent): SemanticProgress | undefined {
  return semanticProgressTimeline(foldSemanticStateHistory(agent.session.events, agent.id)).at(-1)
}

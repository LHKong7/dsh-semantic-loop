/** Goal-contract, plan-graph, and cross-revision transition validation. */

import { isDeepStrictEqual } from 'node:util'
import type { SemanticCheckpoint, SemanticGoal, SemanticPlan, SemanticPlanNode } from './types.ts'

const semanticIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

/** Validate one stable semantic identity. */
function assertSemanticId(value: string, label: string): void {
  if (!semanticIdPattern.test(value)) throw new Error(`${label} must be lower-kebab-case`)
}

/** Reject repeated strings whose order has semantic meaning. */
function assertUniqueStrings(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`)
}

/** Validate a canonical goal contract independently of its predecessor. */
export function assertSemanticGoal(goal: SemanticGoal): void {
  assertSemanticId(goal.id, 'semantic goal id')
  if (!Number.isSafeInteger(goal.version) || goal.version < 1) {
    throw new Error('semantic goal version must be a positive safe integer')
  }
  assertUniqueStrings(goal.constraints, 'semantic goal constraints')
}

/** Validate one canonical plan graph and reject missing dependencies or cycles. */
export function assertSemanticPlan(plan: SemanticPlan): void {
  if (!Number.isSafeInteger(plan.revision) || plan.revision < 1) {
    throw new Error('semantic plan revision must be a positive safe integer')
  }
  const nodes = new Map<string, SemanticPlanNode>()
  const outputs = new Set<string>()
  for (const node of plan.nodes) {
    assertSemanticId(node.id, 'semantic plan node id')
    if (nodes.has(node.id)) throw new Error(`semantic plan repeats node id "${node.id}"`)
    assertUniqueStrings(node.dependsOn, `semantic plan node "${node.id}" dependencies`)
    assertUniqueStrings(node.inputArtifactIds, `semantic plan node "${node.id}" input artifacts`)
    assertUniqueStrings(node.requiredCapabilities, `semantic plan node "${node.id}" required capabilities`)
    assertSemanticId(node.outputArtifactId, `semantic plan node "${node.id}" output artifact id`)
    for (const inputId of node.inputArtifactIds) {
      assertSemanticId(inputId, `semantic plan node "${node.id}" input artifact id`)
    }
    if (outputs.has(node.outputArtifactId)) {
      throw new Error(`semantic plan repeats output artifact id "${node.outputArtifactId}"`)
    }
    nodes.set(node.id, node)
    outputs.add(node.outputArtifactId)
  }
  for (const node of plan.nodes) {
    for (const dependency of node.dependsOn) {
      if (!nodes.has(dependency)) {
        throw new Error(`semantic plan node "${node.id}" depends on missing node "${dependency}"`)
      }
      if (dependency === node.id) throw new Error(`semantic plan node "${node.id}" depends on itself`)
      const dependencyOutput = nodes.get(dependency)?.outputArtifactId
      if (dependencyOutput !== undefined && !node.inputArtifactIds.includes(dependencyOutput)) {
        throw new Error(`semantic plan node "${node.id}" does not consume dependency "${dependency}" output "${dependencyOutput}"`)
      }
    }
    for (const inputId of node.inputArtifactIds) {
      const producer = plan.nodes.find(candidate => candidate.outputArtifactId === inputId)
      if (producer !== undefined && !node.dependsOn.includes(producer.id)) {
        throw new Error(`semantic plan node "${node.id}" consumes "${inputId}" without depending on producer "${producer.id}"`)
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) return
    if (visiting.has(nodeId)) throw new Error(`semantic plan contains a dependency cycle at node "${nodeId}"`)
    visiting.add(nodeId)
    for (const dependency of nodes.get(nodeId)?.dependsOn ?? []) visit(dependency)
    visiting.delete(nodeId)
    visited.add(nodeId)
  }
  for (const node of plan.nodes) visit(node.id)
}

/**
 * Enforce stable goal and plan generations across whole-state replacements.
 *
 * @param previous Latest committed checkpoint, if this is not the first revision.
 * @param next Candidate checkpoint to commit.
 */
export function assertSemanticTransition(
  previous: SemanticCheckpoint | undefined,
  next: SemanticCheckpoint,
): void {
  if (previous === undefined) {
    if (next.goal.version !== 1) throw new Error('first semantic goal version must be 1')
    if (next.plan.revision !== 1) throw new Error('first semantic plan revision must be 1')
    if (next.plan.changeReason !== 'initial-plan') {
      throw new Error('first semantic plan changeReason must be "initial-plan"')
    }
    return
  }

  if (next.goal.id !== previous.goal.id) {
    if (next.goal.version !== previous.goal.version + 1) {
      throw new Error(`replacement semantic goal version must be ${previous.goal.version + 1}`)
    }
    if (next.plan.revision !== 1 || next.plan.changeReason !== 'initial-plan') {
      throw new Error('a replacement semantic goal must start with plan revision 1 and changeReason "initial-plan"')
    }
    return
  }

  if (!isDeepStrictEqual(next.goal, previous.goal)) {
    throw new Error(`semantic goal "${next.goal.id}" changed without a new goal id and version`)
  }

  const previousDefinitions = previous.criteria.map(({ id, description }) => ({ id, description }))
  const nextDefinitions = next.criteria.map(({ id, description }) => ({ id, description }))
  if (!isDeepStrictEqual(nextDefinitions, previousDefinitions)) {
    throw new Error(`semantic goal "${next.goal.id}" changed its completion criteria`)
  }

  const graphChanged = !isDeepStrictEqual(next.plan.nodes, previous.plan.nodes)
  if (graphChanged) {
    if (next.plan.revision !== previous.plan.revision + 1) {
      throw new Error(`changed semantic plan revision must be ${previous.plan.revision + 1}`)
    }
    if (next.plan.changeReason === previous.plan.changeReason || next.plan.changeReason === 'initial-plan') {
      throw new Error('changed semantic plan requires a new concrete changeReason')
    }
  } else if (!isDeepStrictEqual(next.plan, previous.plan)) {
    throw new Error('unchanged semantic plan graph must preserve its revision and changeReason')
  }
}

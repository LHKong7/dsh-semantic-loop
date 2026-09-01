/** Agent-scoped incremental cache over the authoritative durable projections. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SemanticActionLedgerProjection } from './authorization.ts'
import { semanticActionLedgerOf, semanticAuthorizationMessages } from './authorization.ts'
import type { SemanticCandidatePosition } from './candidate.ts'
import { semanticCandidateMessages, semanticCandidateOf } from './candidate.ts'
import type { SemanticProtocolHealth } from './degradation.ts'
import { semanticDegradationMessages } from './degradation.ts'
import type { SemanticRunPosition, SemanticTurnBaseline } from './run-state.ts'
import { semanticBaselineOf, semanticRunMessages, semanticRunOf } from './run-state.ts'
import type { SemanticSpecificationPosition } from './spec-projection.ts'
import { semanticSpecificationMessages, semanticSpecificationOf } from './spec-projection.ts'
import type { SemanticVerificationPositionV2 } from './verification-v2.ts'
import { semanticVerificationV2Messages, semanticVerificationV2Of } from './verification-v2.ts'

/** Immutable high-frequency runtime snapshot. */
export interface SemanticRuntimeSnapshot {
  readonly observedSeq: number
  readonly baseline?: SemanticTurnBaseline
  readonly specification?: SemanticSpecificationPosition
  readonly run?: SemanticRunPosition
  readonly actionLedger: SemanticActionLedgerProjection
  readonly candidate?: SemanticCandidatePosition
  readonly verification?: SemanticVerificationPositionV2
  readonly health: SemanticProtocolHealth
}

function carriesSemanticState(event: Agent['session']['events'][number]): boolean {
  return semanticRunMessages(event).length > 0
    || semanticSpecificationMessages(event).length > 0
    || semanticAuthorizationMessages(event).length > 0
    || semanticCandidateMessages(event).length > 0
    || semanticVerificationV2Messages(event).length > 0
    || semanticDegradationMessages(event).length > 0
}

/** Incremental cache that rebuilds only when new durable semantic sources arrive. */
export class SemanticRuntimeCache {
  private readonly snapshots = new WeakMap<Agent, SemanticRuntimeSnapshot>()
  private readonly health = new WeakMap<Agent, SemanticProtocolHealth>()

  /** Read the current snapshot, advancing over unrelated events in O(delta). */
  read(agent: Agent): SemanticRuntimeSnapshot {
    const prior = this.snapshots.get(agent)
    const events = agent.session.events
    if (prior !== undefined && prior.observedSeq <= events.length) {
      const delta = events.slice(prior.observedSeq)
      if (!delta.some(carriesSemanticState)) {
        const advanced = { ...prior, observedSeq: events.length, health: this.health.get(agent) ?? prior.health }
        this.snapshots.set(agent, advanced)
        return advanced
      }
    }
    const baseline = semanticBaselineOf(agent)
    const specification = semanticSpecificationOf(agent)
    const run = semanticRunOf(agent)
    const candidate = semanticCandidateOf(agent)
    const verification = semanticVerificationV2Of(agent)
    const rebuilt: SemanticRuntimeSnapshot = {
      observedSeq: events.length,
      ...(baseline === undefined ? {} : { baseline }),
      ...(specification === undefined ? {} : { specification }),
      ...(run === undefined ? {} : { run }),
      actionLedger: semanticActionLedgerOf(agent),
      ...(candidate === undefined ? {} : { candidate }),
      ...(verification === undefined ? {} : { verification }),
      health: this.health.get(agent) ?? { kind: 'healthy' },
    }
    this.snapshots.set(agent, rebuilt)
    return rebuilt
  }

  /** Replace the in-memory snapshot after a runtime-owned state transition. */
  set(agent: Agent, snapshot: SemanticRuntimeSnapshot): void {
    this.snapshots.set(agent, snapshot)
    this.health.set(agent, snapshot.health)
  }

  /** Mark protocol health without weakening the current safety projection. */
  setHealth(agent: Agent, health: SemanticProtocolHealth): void {
    this.health.set(agent, health)
    const snapshot = this.snapshots.get(agent)
    if (snapshot !== undefined) this.snapshots.set(agent, { ...snapshot, health })
  }

  /** Release all runtime-owned memory for a disposed Agent. */
  delete(agent: Agent): void {
    this.snapshots.delete(agent)
    this.health.delete(agent)
  }
}

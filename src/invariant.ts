/** Package-owned validation for semantic checkpoint messages. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { foldSemanticActionLedger, semanticAuthorizationMessages } from './authorization.ts'
import { foldSemanticCandidates, semanticCandidateMessages } from './candidate.ts'
import { foldSemanticDegradation, semanticDegradationMessages } from './degradation.ts'
import { foldSemanticProofChecks, semanticProofCheckMessages } from './proof.ts'
import { foldSemanticBaselines, foldSemanticRuns, semanticRunMessages } from './run-state.ts'
import { foldSemanticSpecifications, semanticSpecificationMessages } from './spec-projection.ts'
import { foldSemanticStates, semanticMessages } from './state.ts'
import { foldSemanticVerificationPosition, semanticVerificationMessages } from './verification.ts'
import { foldSemanticVerificationV2Position, semanticVerificationV2Messages } from './verification-v2.ts'

const PACKAGE_NAME = 'dsh-semantic-loop'

/** Cordis companion plugin name. */
export const name = 'semantic-loop-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

function foldSemanticControl(events: readonly SessionEvent[], session: Session): void {
  foldSemanticStates(events)
  foldSemanticVerificationPosition(events, session.id)
  foldSemanticSpecifications(events)
  foldSemanticBaselines(events)
  foldSemanticRuns(events)
  foldSemanticCandidates(events)
  foldSemanticActionLedger(events, session.id)
  foldSemanticVerificationV2Position(events, session.id)
  foldSemanticDegradation(events, session.id)
  foldSemanticProofChecks(events, session.id)
}

function hasSemanticControl(event: SessionEvent): boolean {
  return semanticMessages(event).length > 0
    || semanticVerificationMessages(event).length > 0
    || semanticSpecificationMessages(event).length > 0
    || semanticRunMessages(event).length > 0
    || semanticCandidateMessages(event).length > 0
    || semanticAuthorizationMessages(event).length > 0
    || semanticVerificationV2Messages(event).length > 0
    || semanticDegradationMessages(event).length > 0
    || semanticProofCheckMessages(event).length > 0
}

/** Validate every semantic message in a loaded or candidate Session prefix. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    try {
      foldSemanticControl(session.events, session)
    } catch (error: unknown) {
      fail(`session "${session.id}" violates the semantic checkpoint stream: ${(error as Error).message}`)
    }
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (!hasSemanticControl(event)) return
    try {
      const candidate = [...session.events, event]
      foldSemanticControl(candidate, session)
    } catch (error: unknown) {
      fail(`session event ${event.seq} violates the semantic checkpoint stream: ${(error as Error).message}`)
    }
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the semantic-loop invariant companion.
 *
 * @param ctx Cordis context that owns the invariant registry.
 * @returns Disposer for the registered invariant.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

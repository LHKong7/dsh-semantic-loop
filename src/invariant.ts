/** Package-owned validation for semantic checkpoint messages. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { foldSemanticStates, semanticMessages } from './state.ts'
import { foldSemanticVerificationPosition, semanticVerificationMessages } from './verification.ts'

const PACKAGE_NAME = 'dsh-semantic-loop'

/** Cordis companion plugin name. */
export const name = 'semantic-loop-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/** Validate every semantic message in a loaded or candidate Session prefix. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    try {
      foldSemanticStates(session.events)
      foldSemanticVerificationPosition(session.events, session.id)
    } catch (error: unknown) {
      fail(`session "${session.id}" violates the semantic checkpoint stream: ${(error as Error).message}`)
    }
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (semanticMessages(event).length === 0 && semanticVerificationMessages(event).length === 0) return
    try {
      const candidate = [...session.events, event]
      foldSemanticStates(candidate)
      foldSemanticVerificationPosition(candidate, session.id)
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

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { CallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as SemanticInvariant from '../src/invariant.ts'
import { renderSemanticCheckpointReceipt } from '../src/state.ts'
import type { SemanticCheckpoint } from '../src/types.ts'

const checkpoint: SemanticCheckpoint = {
  objective: 'Verify one answer',
  criteria: [{
    id: 'verified', description: 'The answer is verified', status: 'unmet', evidence: '', evidenceCallIds: [],
  }],
  facts: [],
  observedCallIds: [],
  gaps: [{ id: 'missing-proof', description: 'Collect proof' }],
  nextAction: 'Collect proof',
  status: 'exploring',
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(SemanticInvariant)
  return ctx
}

function callId(revision: number): CallId {
  return CallId(`semantic-checkpoint-${revision}`)
}

function argumentsFor(revision: number): string {
  return JSON.stringify({
    expected_revision: revision - 1,
    objective: checkpoint.objective,
    criteria: checkpoint.criteria.map(criterion => ({
      id: criterion.id,
      description: criterion.description,
      status: criterion.status,
      evidence: criterion.evidence,
      evidence_call_ids: criterion.evidenceCallIds,
    })),
    facts: [],
    gaps: checkpoint.gaps,
    next_action: checkpoint.nextAction,
    status: checkpoint.status,
  })
}

function appendCheckpointCall(session: Session, revision: number, isError = false): void {
  const id = callId(revision)
  session.append('tool/call', {
    turn: 1,
    step: revision,
    callId: id,
    name: 'semantic_checkpoint',
    arguments: argumentsFor(revision),
  })
  session.append('tool/result', {
    turn: 1,
    step: revision,
    message: createToolResultMessage({ callId: id, content: [], isError }),
  }, { surfaceOp: 'append' })
}

function message(revision: number, content = renderSemanticCheckpointReceipt({ revision, checkpoint })) {
  return createUserMessage({
    source: {
      kind: 'semantic-checkpoint',
      version: 4,
      sessionId: SessionId('semantic-source'),
      checkpointCallId: callId(revision),
      revision,
      checkpoint,
    },
    content: [{ type: 'text', text: content }],
  })
}

describe('semantic-loop invariant', () => {
  it('does not replay semantic state for unrelated candidate events', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('semantic-invariant-unrelated'))
    expect(() => { session.append('turn/start', { turn: 1 }) }).not.toThrow()
  })

  it('accepts one insertion and its later identical user-message occurrence', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('semantic-invariant'))
    const semantic = message(1)
    expect(() => {
      appendCheckpointCall(session, 1)
      session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [semantic] })
      session.append('user/message', semantic, { surfaceOp: 'append' })
    }).not.toThrow()
  })

  it('rejects a revision gap before publication', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('semantic-invariant-gap'))
    appendCheckpointCall(session, 2)
    expect(() => {
      session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message(2)] })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: 'dsh-semantic-loop',
    }))
    expect(session.events.map(event => event.type)).toEqual(['tool/call', 'tool/result'])
  })

  it('rejects a source/content mismatch before publication', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('semantic-invariant-content'))
    appendCheckpointCall(session, 1)
    expect(() => {
      session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message(1, 'wrong')] })
    }).toThrow(/content does not match/)
    expect(session.events.map(event => event.type)).toEqual(['tool/call', 'tool/result'])
  })

  it('rejects a checkpoint whose referenced call failed', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('semantic-invariant-failed-call'))
    appendCheckpointCall(session, 1, true)
    expect(() => {
      session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message(1)] })
    }).toThrow(/not linked to an earlier successful semantic_checkpoint call\/result/)
    expect(session.events.map(event => event.type)).toEqual(['tool/call', 'tool/result'])
  })

  it('rejects malformed existing logs when the invariant registers', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('semantic-existing-gap'))
    appendCheckpointCall(session, 2)
    session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message(2)] })
    await ctx.plugin(InvariantService, { enabled: true })

    await expect(ctx.plugin(SemanticInvariant)).rejects.toThrow(/session "semantic-existing-gap" violates.*revision must be 1/)
  })

})

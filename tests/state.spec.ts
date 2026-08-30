import { describe, expect, it } from 'vitest'
import { CallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SemanticCheckpoint } from '../src/types.ts'
import {
  decodeSemanticCheckpointSource,
  foldSemanticState,
  foldSemanticStatePosition,
  foldSemanticStates,
  isSemanticCheckpointMessage,
  renderSemanticCheckpoint,
  renderSemanticCheckpointReceipt,
  resolveSemanticCheckpoint,
} from '../src/state.ts'

const ready: SemanticCheckpoint = {
  objective: 'Answer the database question',
  criteria: [{
    id: 'answer-supported',
    description: 'The answer follows from query output',
    status: 'met',
    evidence: 'query q1 returned 42',
    evidenceCallIds: [],
  }],
  facts: [{ id: 'query-result', statement: 'The result is 42', evidence: 'query q1 row 1', evidenceCallIds: [] }],
  observedCallIds: [],
  gaps: [],
  nextAction: 'Call semantic_finish with the supported answer',
  status: 'ready',
}

const OWNER = SessionId('semantic-owner')

function checkpointSource(checkpoint: unknown = ready, overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: 'semantic-checkpoint',
    version: 4,
    sessionId: OWNER,
    checkpointCallId: CallId('semantic-checkpoint-1'),
    revision: 1,
    checkpoint,
    ...overrides,
  }
}

function checkpointArguments(revision: number, checkpoint: SemanticCheckpoint): Record<string, unknown> {
  return {
    expected_revision: revision - 1,
    objective: checkpoint.objective,
    criteria: checkpoint.criteria.map(criterion => ({
      id: criterion.id,
      description: criterion.description,
      status: criterion.status,
      evidence: criterion.evidence,
      evidence_call_ids: criterion.evidenceCallIds,
    })),
    facts: checkpoint.facts.map(fact => ({
      id: fact.id,
      statement: fact.statement,
      evidence: fact.evidence,
      evidence_call_ids: fact.evidenceCallIds,
    })),
    gaps: checkpoint.gaps,
    next_action: checkpoint.nextAction,
    status: checkpoint.status,
  }
}

function checkpointEvent(
  revision: number,
  checkpoint: SemanticCheckpoint,
  seq = 2,
  callId = CallId(`semantic-checkpoint-${revision}`),
): SessionEvent {
  const state = { revision, checkpoint }
  const message = createUserMessage({
    source: { kind: 'semantic-checkpoint', version: 4, sessionId: OWNER, checkpointCallId: callId, revision, checkpoint },
    content: [{ type: 'text', text: renderSemanticCheckpointReceipt(state) }],
  })
  return {
    type: 'agent/inbox/spliced',
    seq,
    time: seq,
    data: { target: 'next-step', start: 0, inserted: [message] },
  }
}

function checkpointTransaction(
  revision: number,
  checkpoint: SemanticCheckpoint,
  seq = 0,
  callId = CallId(`semantic-checkpoint-${revision}`),
): SessionEvent[] {
  return [
    {
      type: 'tool/call',
      seq,
      time: seq,
      data: {
        turn: 1,
        step: revision,
        callId,
        name: 'semantic_checkpoint',
        arguments: JSON.stringify(checkpointArguments(revision, checkpoint)),
      },
    },
    {
      type: 'tool/result',
      seq: seq + 1,
      time: seq + 1,
      data: {
        turn: 1,
        step: revision,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'committed' }], isError: false }),
      },
      surfaceOp: 'append',
    },
    checkpointEvent(revision, checkpoint, seq + 2, callId),
  ]
}

describe('semantic checkpoint state', () => {
  it('canonicalizes model input and renders a whole superseding snapshot', () => {
    const checkpoint = resolveSemanticCheckpoint({
      objective: '  Answer the database question  ',
      criteria: [{ ...ready.criteria[0]!, description: '  The answer follows from query output  ' }],
      facts: [{ ...ready.facts[0]!, evidence: '  query q1 row 1  ' }],
      gaps: [],
      nextAction: '  Call semantic_finish with the supported answer  ',
      status: 'ready',
    })

    expect(checkpoint).toEqual(ready)
    expect(renderSemanticCheckpoint({ revision: 1, checkpoint })).toContain('whole snapshot supersedes every earlier')
    expect(renderSemanticCheckpoint({ revision: 1, checkpoint })).toContain('[x] answer-supported')
  })

  it('renders empty and open exploring collections explicitly', () => {
    const empty: SemanticCheckpoint = {
      objective: 'Explore the question',
      criteria: [],
      facts: [],
      observedCallIds: [],
      gaps: [],
      nextAction: 'Define completion criteria',
      status: 'exploring',
    }
    expect(renderSemanticCheckpoint({ revision: 1, checkpoint: empty })).toContain('Completion criteria:\n- (none yet)')
    expect(renderSemanticCheckpoint({ revision: 1, checkpoint: empty })).toContain('Evidence-backed facts:\n- (none yet)')
    expect(renderSemanticCheckpoint({ revision: 1, checkpoint: empty })).toContain('Open gaps:\n- (none)')

    const open: SemanticCheckpoint = {
      ...empty,
      criteria: [{
        id: 'collect-proof', description: 'Proof is collected', status: 'unmet', evidence: '', evidenceCallIds: [],
      }],
      gaps: [{ id: 'missing-proof', description: 'Collect proof' }],
    }
    expect(renderSemanticCheckpoint({ revision: 2, checkpoint: open })).toContain('[ ] collect-proof')
    expect(renderSemanticCheckpoint({ revision: 2, checkpoint: open })).toContain('- missing-proof: Collect proof')
  })

  it.each([
    [{ ...ready, criteria: [] }, /requires at least one completion criterion/],
    [{ ...ready, criteria: [{ ...ready.criteria[0]!, status: 'unmet', evidence: '' }] }, /has unmet criteria/],
    [{ ...ready, gaps: [{ id: 'missing-proof', description: 'Need another query' }] }, /has open gaps/],
    [{ ...ready, criteria: [{ ...ready.criteria[0]!, evidence: '' }] }, /requires evidence/],
    [{ ...ready, facts: [{ ...ready.facts[0]!, id: 'Bad_Id' }] }, /lower-kebab-case/],
    [{ ...ready, facts: [ready.facts[0]!, ready.facts[0]!] }, /repeats fact id/],
  ])('rejects an incoherent ready checkpoint', (checkpoint, error) => {
    expect(() => resolveSemanticCheckpoint(checkpoint as SemanticCheckpoint)).toThrow(error)
  })

  it.each([
    [null, /must be an object/],
    [[], /must be an object/],
    [{ ...checkpointSource() as object, extra: true }, /fields must be exactly/],
    [{ kind: 'semantic-checkpoint', version: 4, sessionId: OWNER, revision: 1 }, /fields must be exactly/],
    [checkpointSource(ready, { kind: 'other' }), /invalid kind/],
    [checkpointSource(ready, { version: 3 }), /unsupported version/],
    [checkpointSource(ready, { sessionId: '' }), /sessionId must be non-empty/],
    [checkpointSource(ready, { sessionId: 1 }), /sessionId must be non-empty/],
    [checkpointSource(ready, { checkpointCallId: '' }), /checkpointCallId must be non-empty/],
    [checkpointSource(ready, { checkpointCallId: 1 }), /checkpointCallId must be non-empty/],
    [checkpointSource(ready, { revision: 0 }), /revision must be a positive safe integer/],
    [checkpointSource(ready, { revision: '1' }), /revision must be a positive safe integer/],
    [checkpointSource({ ...ready, status: 'done' }), /status must be exploring or ready/],
    [checkpointSource({ ...ready, objective: '' }), /objective must be non-empty/],
    [checkpointSource({ ...ready, objective: ' padded ' }), /objective must be non-empty/],
    [checkpointSource({ ...ready, criteria: 'invalid' }), /semantic criteria must be an array/],
    [checkpointSource({ ...ready, criteria: [null] }), /semantic criterion 0 must be an object/],
    [checkpointSource({ ...ready, criteria: [{ ...ready.criteria[0]!, extra: true }] }), /fields must be exactly/],
    [checkpointSource({ ...ready, criteria: [{ ...ready.criteria[0]!, status: 'done' }] }), /status must be unmet or met/],
    [checkpointSource({ ...ready, criteria: [{ ...ready.criteria[0]!, description: 1 }] }), /description must be non-empty/],
    [checkpointSource({ ...ready, criteria: [{ ...ready.criteria[0]!, evidence: 1 }] }), /evidence must be a trimmed string/],
    [checkpointSource({ ...ready, criteria: [{ ...ready.criteria[0]!, evidence: ' padded ' }] }), /evidence must be a trimmed string/],
    [checkpointSource({ ...ready, criteria: [{ ...ready.criteria[0]!, status: 'unmet', evidence: 'proof' }] }), /must not carry evidence/],
    [checkpointSource({ ...ready, criteria: [ready.criteria[0]!, ready.criteria[0]!] }), /repeats criterion id/],
    [checkpointSource({ ...ready, facts: [{ id: 'fact', statement: '', evidence: 'proof', evidenceCallIds: [] }] }), /statement must be non-empty/],
    [checkpointSource({ ...ready, facts: [{ id: 'fact', statement: 'Fact', evidence: '', evidenceCallIds: [] }] }), /evidence must be non-empty/],
    [checkpointSource({ ...ready, observedCallIds: 'call-1' }), /semantic observed call ids must be an array/],
    [checkpointSource({ ...ready, observedCallIds: [''] }), /evidence call id 0 must be non-empty/],
    [checkpointSource({ ...ready, observedCallIds: ['call-1', 'call-1'] }), /repeats observed call id/],
    [checkpointSource({
      ...ready,
      criteria: [{ ...ready.criteria[0]!, evidenceCallIds: ['call-1', 'call-1'] }],
    }), /repeats criterion.*evidence call id/],
    [checkpointSource({ ...ready, gaps: [{ id: 'gap', description: '' }], status: 'exploring' }), /description must be non-empty/],
    [checkpointSource({ ...ready, gaps: [{ id: 'gap', description: 'One' }, { id: 'gap', description: 'Two' }], status: 'exploring' }), /repeats gap id/],
    [checkpointSource({ ...ready, nextAction: '' }), /nextAction must be non-empty/],
  ] satisfies ReadonlyArray<readonly [unknown, RegExp]>)('rejects invalid persisted source data', (source, error) => {
    expect(() => decodeSemanticCheckpointSource(source)).toThrow(error)
  })

  it('folds the same durable message from inbox insertion and later user history once', () => {
    const events = checkpointTransaction(1, ready)
    const insertion = events.at(-1)!
    if (insertion.type !== 'agent/inbox/spliced') throw new Error('expected inbox event')
    const message = insertion.data.inserted[0]!
    const entered: SessionEvent = { type: 'user/message', seq: 3, time: 3, data: message, surfaceOp: 'append' }

    expect(foldSemanticState([...events, entered], OWNER)).toEqual({ revision: 1, checkpoint: ready })
    expect(foldSemanticStatePosition([...events, entered], OWNER)).toEqual({
      state: { revision: 1, checkpoint: ready },
      checkpointCallSeq: 0,
    })
  })

  it('requires contiguous revisions with one message identity per revision', () => {
    expect(() => foldSemanticState(checkpointTransaction(2, ready), OWNER)).toThrow(/revision must be 1, got 2/)

    const first = checkpointTransaction(1, ready, 0)
    const reused = checkpointTransaction(1, ready, 3, CallId('semantic-checkpoint-1-reused'))
    expect(() => foldSemanticState([...first, ...reused], OWNER)).toThrow(/revision must be 2, got 1/)
  })

  it('requires one earlier successful checkpoint call/result and exact call arguments', () => {
    expect(() => foldSemanticState([checkpointEvent(1, ready)], OWNER))
      .toThrow(/not linked to an earlier successful semantic_checkpoint call\/result/)

    const failed = checkpointTransaction(1, ready)
    const result = failed[1]
    if (result?.type !== 'tool/result') throw new Error('expected checkpoint result')
    const failedResult: SessionEvent = {
      ...result,
      data: {
        ...result.data,
        message: createToolResultMessage({
          callId: CallId('semantic-checkpoint-1'),
          content: [],
          isError: true,
        }),
      },
    }
    expect(() => foldSemanticState([failed[0]!, failedResult, failed[2]!], OWNER))
      .toThrow(/not linked to an earlier successful semantic_checkpoint call\/result/)

    const mismatch = checkpointTransaction(1, ready)
    const insertion = mismatch[2]
    if (insertion?.type !== 'agent/inbox/spliced') throw new Error('expected inbox event')
    const changedCheckpoint = { ...ready, objective: 'A forged objective' }
    const changedMessage = createUserMessage({
      source: {
        kind: 'semantic-checkpoint',
        version: 4,
        sessionId: OWNER,
        checkpointCallId: CallId('semantic-checkpoint-1'),
        revision: 1,
        checkpoint: changedCheckpoint,
      },
      content: [{ type: 'text', text: renderSemanticCheckpointReceipt({ revision: 1, checkpoint: changedCheckpoint }) }],
    })
    const changedInsertion: SessionEvent = {
      ...insertion,
      data: { ...insertion.data, inserted: [changedMessage] },
    }
    expect(() => foldSemanticState([...mismatch.slice(0, 2), changedInsertion], OWNER))
      .toThrow(/does not match call/)

    const committed = checkpointTransaction(1, ready)
    expect(() => foldSemanticState([
      ...committed,
      checkpointEvent(1, ready, 3, CallId('semantic-checkpoint-1')),
    ], OWNER)).toThrow(/is already owned/)
  })

  it('matches observed ids to current-turn results and validates explicit claim references', () => {
    const callId = CallId('query-1')
    const observed: SemanticCheckpoint = {
      ...ready,
      criteria: [{ ...ready.criteria[0]!, evidenceCallIds: [callId] }],
      observedCallIds: [callId],
    }
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      {
        type: 'tool/call', seq: 1, time: 1,
        data: { turn: 1, step: 1, callId, name: 'database_query', arguments: '{}' },
      },
      {
        type: 'tool/result', seq: 2, time: 2,
        data: {
          turn: 1,
          step: 1,
          message: createToolResultMessage({ callId, content: [{ type: 'text', text: '42' }], isError: false }),
        },
        surfaceOp: 'append',
      },
    ]
    expect(foldSemanticState([...events, ...checkpointTransaction(1, observed, 3)], OWNER))
      .toEqual({ revision: 1, checkpoint: observed })
    expect(() => foldSemanticState([...events, ...checkpointTransaction(1, ready, 3)], OWNER))
      .toThrow(/does not match call/)
    const unknown: SemanticCheckpoint = {
      ...observed,
      criteria: [{ ...observed.criteria[0]!, evidenceCallIds: [CallId('unknown')] }],
    }
    expect(() => foldSemanticState([...events, ...checkpointTransaction(1, unknown, 3)], OWNER))
      .toThrow(/is not an earlier successful environment-tool result/)
  })

  it('excludes failed and semantic-control results from checkpoint evidence', () => {
    const failed = CallId('failed-query')
    const semantic = CallId('semantic-control')
    const events: SessionEvent[] = [
      { type: 'tool/call', seq: 0, time: 0, data: { turn: 1, step: 1, callId: failed, name: 'database_query', arguments: '{}' } },
      {
        type: 'tool/result', seq: 1, time: 1,
        data: { turn: 1, step: 1, message: createToolResultMessage({ callId: failed, content: [], isError: true }) },
        surfaceOp: 'append',
      },
      { type: 'tool/call', seq: 2, time: 2, data: { turn: 1, step: 1, callId: semantic, name: 'semantic_finish', arguments: '{}' } },
      {
        type: 'tool/result', seq: 3, time: 3,
        data: { turn: 1, step: 1, message: createToolResultMessage({ callId: semantic, content: [], isError: false }) },
        surfaceOp: 'append',
      },
      ...checkpointTransaction(1, ready, 4),
    ]
    expect(foldSemanticState(events, OWNER)).toEqual({ revision: 1, checkpoint: ready })
  })

  it('rejects content that disagrees with the durable source state', () => {
    const events = checkpointTransaction(1, ready)
    const event = events.at(-1)!
    if (event.type !== 'agent/inbox/spliced') throw new Error('expected inbox event')
    const [message] = event.data.inserted
    const changed: SessionEvent = {
      ...event,
      data: {
        ...event.data,
        inserted: [{ ...message!, content: [{ type: 'text', text: 'not the semantic state' }] }],
      },
    }
    expect(() => foldSemanticState([...events.slice(0, -1), changed], OWNER)).toThrow(/content does not match/)
  })

  it('rejects a changed message under a previously observed identity', () => {
    const events = checkpointTransaction(1, ready)
    const insertion = events.at(-1)!
    if (insertion.type !== 'agent/inbox/spliced') throw new Error('expected inbox event')
    const original = insertion.data.inserted[0]!
    const changedCheckpoint = { ...ready, objective: 'A changed objective' }
    const changedMessage = {
      ...original,
      source: { ...original.source, checkpoint: changedCheckpoint },
      content: [{ type: 'text' as const, text: renderSemanticCheckpointReceipt({ revision: 1, checkpoint: changedCheckpoint }) }],
    }
    const entered: SessionEvent = { type: 'user/message', seq: 3, time: 3, data: changedMessage, surfaceOp: 'append' }

    expect(() => foldSemanticState([...events, entered], OWNER)).toThrow(/changed after its first occurrence/)
  })

  it('ignores ordinary messages and non-message events', () => {
    const ordinary = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })
    expect(isSemanticCheckpointMessage(ordinary)).toBe(false)
    expect(foldSemanticStates([
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 1, data: ordinary, surfaceOp: 'append' },
    ])).toEqual(new Map())
  })

  it('isolates a fork owner from inherited parent checkpoints', () => {
    const child = SessionId('semantic-child')
    expect(foldSemanticState(checkpointTransaction(1, ready), child)).toBeUndefined()
  })
})

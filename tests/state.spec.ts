import { describe, expect, it } from 'vitest'
import { CallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SemanticCheckpoint } from '../src/types.ts'
import {
  assertSemanticArtifacts,
  assertSemanticArtifactTransition,
  semanticArtifactStatus,
} from '../src/artifacts.ts'
import { assertSemanticTransition } from '../src/plan.ts'
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
  goal: {
    id: 'answer-database-question',
    version: 1,
    statement: 'Answer the database question',
    constraints: ['Use the query result as evidence'],
  },
  criteria: [{
    id: 'answer-supported',
    description: 'The answer follows from query output',
    status: 'met',
    evidence: 'query q1 returned 42',
    evidenceCallIds: [],
  }],
  plan: {
    revision: 1,
    changeReason: 'initial-plan',
    nodes: [{
      id: 'query-answer',
      operation: 'query-structured-source',
      description: 'Query the source needed to answer the question',
      dependsOn: [],
      inputArtifactIds: [],
      outputArtifactId: 'query-result',
      requiredCapabilities: ['structured-query'],
      required: true,
    }],
  },
  activeNodeId: null,
  artifacts: [{
    id: 'query-result',
    version: 1,
    kind: 'query-result',
    summary: 'The query result is 42',
    locator: 'semantic://query-result/1',
    contentDigest: 'answer-42',
    producerNodeId: 'query-answer',
    planRevision: 1,
    inputs: [],
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
    version: 6,
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
    goal: checkpoint.goal,
    criteria: checkpoint.criteria.map(criterion => ({
      id: criterion.id,
      description: criterion.description,
      status: criterion.status,
      evidence: criterion.evidence,
      evidence_call_ids: criterion.evidenceCallIds,
    })),
    plan: {
      revision: checkpoint.plan.revision,
      change_reason: checkpoint.plan.changeReason,
      nodes: checkpoint.plan.nodes.map(node => ({
        id: node.id,
        operation: node.operation,
        description: node.description,
        depends_on: node.dependsOn,
        input_artifact_ids: node.inputArtifactIds,
        output_artifact_id: node.outputArtifactId,
        required_capabilities: node.requiredCapabilities,
        required: node.required,
      })),
    },
    active_node_id: checkpoint.activeNodeId,
    artifacts: checkpoint.artifacts.map(artifact => ({
      id: artifact.id,
      version: artifact.version,
      kind: artifact.kind,
      summary: artifact.summary,
      locator: artifact.locator,
      content_digest: artifact.contentDigest,
      producer_node_id: artifact.producerNodeId,
      plan_revision: artifact.planRevision,
      inputs: artifact.inputs,
      evidence_call_ids: artifact.evidenceCallIds,
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
    source: { kind: 'semantic-checkpoint', version: 6, sessionId: OWNER, checkpointCallId: callId, revision, checkpoint },
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
  it('rejects missing plan dependencies and dependency cycles', () => {
    const missingDependency = {
      ...ready,
      plan: {
        ...ready.plan,
        nodes: [{ ...ready.plan.nodes[0]!, dependsOn: ['missing-node'] }],
      },
    }
    expect(() => resolveSemanticCheckpoint(missingDependency)).toThrow(/depends on missing node/)

    const cycle = {
      ...ready,
      plan: {
        ...ready.plan,
        nodes: [
          { ...ready.plan.nodes[0]!, dependsOn: ['format-answer'], inputArtifactIds: ['formatted-answer'] },
          {
            id: 'format-answer',
            operation: 'format-answer',
            description: 'Format the answer',
            dependsOn: ['query-answer'],
            inputArtifactIds: ['query-result'],
            outputArtifactId: 'formatted-answer',
            requiredCapabilities: [],
            required: true,
          },
        ],
      },
    }
    expect(() => resolveSemanticCheckpoint(cycle)).toThrow(/dependency cycle/)
  })

  it('keeps one goal contract stable and versions deliberate plan replacement', () => {
    assertSemanticTransition(undefined, ready)
    const changedPlan: SemanticCheckpoint = {
      ...ready,
      plan: {
        revision: 2,
        changeReason: 'validate the query before formatting',
        nodes: [
          ...ready.plan.nodes,
          {
            id: 'validate-answer',
            operation: 'validate-result',
            description: 'Validate the query result',
            dependsOn: ['query-answer'],
            inputArtifactIds: ['query-result'],
            outputArtifactId: 'validated-answer',
            requiredCapabilities: ['result-validation'],
            required: true,
          },
        ],
      },
    }
    expect(() => assertSemanticTransition(ready, changedPlan)).not.toThrow()
    expect(() => assertSemanticTransition(ready, {
      ...changedPlan,
      plan: { ...changedPlan.plan, revision: 1 },
    })).toThrow(/plan revision must be 2/)
    expect(() => assertSemanticTransition(ready, {
      ...ready,
      goal: { ...ready.goal, statement: 'Silently changed task' },
    })).toThrow(/changed without a new goal id and version/)
    expect(() => assertSemanticTransition(ready, {
      ...ready,
      criteria: [{ ...ready.criteria[0]!, description: 'Silently changed success condition' }],
    })).toThrow(/changed its completion criteria/)
  })

  it('invalidates downstream artifacts after an upstream replacement or plan revision', () => {
    const aggregateNode = {
      id: 'aggregate-answer',
      operation: 'aggregate-values',
      description: 'Aggregate the query result',
      dependsOn: ['query-answer'],
      inputArtifactIds: ['query-result'],
      outputArtifactId: 'final-answer',
      requiredCapabilities: ['aggregation'],
      required: true,
    }
    const aggregateArtifact = {
      id: 'final-answer',
      version: 1,
      kind: 'answer-value',
      summary: 'The aggregate is 42',
      locator: 'semantic://final-answer/1',
      contentDigest: 'aggregate-42',
      producerNodeId: 'aggregate-answer',
      planRevision: 1,
      inputs: [{ id: 'query-result', version: 1 }],
      evidenceCallIds: [],
    }
    const pipeline: SemanticCheckpoint = {
      ...ready,
      plan: { ...ready.plan, nodes: [...ready.plan.nodes, aggregateNode] },
      artifacts: [...ready.artifacts, aggregateArtifact],
    }
    expect(() => assertSemanticArtifacts(pipeline)).not.toThrow()
    expect(semanticArtifactStatus(pipeline, aggregateArtifact)).toBe('current')

    const upstreamReplacement = {
      ...ready.artifacts[0]!,
      version: 2,
      summary: 'The corrected query result is 43',
      locator: 'semantic://query-result/2',
      contentDigest: 'answer-43',
    }
    const stalePipeline: SemanticCheckpoint = {
      ...pipeline,
      status: 'exploring',
      activeNodeId: 'aggregate-answer',
      artifacts: [...pipeline.artifacts, upstreamReplacement],
    }
    expect(semanticArtifactStatus(stalePipeline, aggregateArtifact)).toBe('stale')
    expect(() => assertSemanticArtifacts({
      ...stalePipeline,
      status: 'ready',
      activeNodeId: null,
    })).toThrow(/lacks current artifacts.*aggregate-answer/)
    expect(() => assertSemanticArtifactTransition(pipeline, stalePipeline)).not.toThrow()
    expect(() => assertSemanticArtifactTransition(pipeline, {
      ...pipeline,
      artifacts: pipeline.artifacts.slice(1),
    })).toThrow(/history is append-only/)

    const revisedPlan: SemanticCheckpoint = {
      ...pipeline,
      status: 'exploring',
      activeNodeId: 'query-answer',
      plan: { ...pipeline.plan, revision: 2, changeReason: 'correct the query semantics' },
    }
    expect(semanticArtifactStatus(revisedPlan, ready.artifacts[0]!)).toBe('stale')
    expect(semanticArtifactStatus(revisedPlan, aggregateArtifact)).toBe('stale')
  })

  it('canonicalizes model input and renders a whole superseding snapshot', () => {
    const checkpoint = resolveSemanticCheckpoint({
      goal: { ...ready.goal, statement: '  Answer the database question  ' },
      criteria: [{ ...ready.criteria[0]!, description: '  The answer follows from query output  ' }],
      plan: ready.plan,
      activeNodeId: ready.activeNodeId,
      artifacts: ready.artifacts,
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
      goal: { id: 'explore-question', version: 1, statement: 'Explore the question', constraints: [] },
      criteria: [],
      plan: { revision: 1, changeReason: 'initial-plan', nodes: [] },
      activeNodeId: null,
      artifacts: [],
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
    [{ kind: 'semantic-checkpoint', version: 6, sessionId: OWNER, revision: 1 }, /fields must be exactly/],
    [checkpointSource(ready, { kind: 'other' }), /invalid kind/],
    [checkpointSource(ready, { version: 3 }), /unsupported version/],
    [checkpointSource(ready, { sessionId: '' }), /sessionId must be non-empty/],
    [checkpointSource(ready, { sessionId: 1 }), /sessionId must be non-empty/],
    [checkpointSource(ready, { checkpointCallId: '' }), /checkpointCallId must be non-empty/],
    [checkpointSource(ready, { checkpointCallId: 1 }), /checkpointCallId must be non-empty/],
    [checkpointSource(ready, { revision: 0 }), /revision must be a positive safe integer/],
    [checkpointSource(ready, { revision: '1' }), /revision must be a positive safe integer/],
    [checkpointSource({ ...ready, status: 'done' }), /status must be exploring or ready/],
    [checkpointSource({ ...ready, goal: { ...ready.goal, statement: '' } }), /goal statement must be non-empty/],
    [checkpointSource({ ...ready, goal: { ...ready.goal, statement: ' padded ' } }), /goal statement must be non-empty/],
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
    const changedCheckpoint = { ...ready, goal: { ...ready.goal, statement: 'A forged objective' } }
    const changedMessage = createUserMessage({
      source: {
        kind: 'semantic-checkpoint',
        version: 6,
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
    const changedCheckpoint = { ...ready, goal: { ...ready.goal, statement: 'A changed objective' } }
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

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  CallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'
import * as SemanticLoop from '../src/index.ts'

const SIGNAL = new AbortController().signal
let callNumber = 0

const exploring = {
  expected_revision: 0,
  goal: {
    id: 'answer-database-question',
    version: 1,
    statement: 'Answer the database question',
    constraints: ['Use the query result as evidence'],
  },
  criteria: [{
    id: 'answer-supported',
    description: 'The answer follows from query output',
    status: 'unmet',
    evidence: '',
    evidence_call_ids: [],
  }],
  plan: {
    revision: 1,
    change_reason: 'initial-plan',
    nodes: [{
      id: 'query-answer',
      operation: 'query-structured-source',
      description: 'Query the source needed to answer the question',
      depends_on: [],
      input_artifact_ids: [],
      output_artifact_id: 'query-result',
      required_capabilities: ['structured-query'],
      required: true,
    }],
  },
  active_node_id: 'query-answer',
  artifacts: [],
  facts: [],
  gaps: [{ id: 'missing-query', description: 'Run the required query' }],
  next_action: 'Run the required query',
  status: 'exploring',
} as const

const ready = {
  ...exploring,
  criteria: [{
    id: 'answer-supported',
    description: 'The answer follows from query output',
    status: 'met',
    evidence: 'query q1 returned 42',
    evidence_call_ids: [],
  }],
  facts: [{
    id: 'query-result', statement: 'The result is 42', evidence: 'query q1 row 1', evidence_call_ids: [],
  }],
  gaps: [],
  active_node_id: null,
  artifacts: [{
    id: 'query-result',
    version: 1,
    kind: 'query-result',
    summary: 'The query result is 42',
    locator: 'semantic://query-result/1',
    content_digest: 'answer-42',
    producer_node_id: 'query-answer',
    plan_revision: 1,
    inputs: [],
    evidence_call_ids: [],
  }],
  next_action: 'Call semantic_finish with 42',
  status: 'ready',
} as const

async function setup(
  script: ConstructorParameters<typeof MockAdapter>[0] = [],
  maxRepairSteps = 3,
  requireToolEvidence = false,
  maxCheckpointBytes = 65_536,
  maxStagnantRevisions = 3,
  maxProtocolFailures = 5,
) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const fiber = await ctx.plugin(SemanticLoop, {
    maxRepairSteps,
    requireToolEvidence,
    maxCheckpointBytes,
    maxStagnantRevisions,
    maxProtocolFailures,
    capabilities: [{ id: 'structured-query', description: 'Query structured data sources.' }],
  })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId(`semantic-${++callNumber}`), { provider: 'mock', model: 'mock' })
  return { ctx, agent, adapter, fiber }
}

async function execute(ctx: Context, agent: Agent | undefined, name: string, args: unknown) {
  const callId = CallId(`semantic-call-${++callNumber}`)
  const turn = agent?.session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 1
  const step = 1
  const callSeq = agent?.session.append('tool/call', {
    turn,
    step,
    callId,
    name,
    arguments: JSON.stringify(args),
  }).seq
  const result = await ctx.tools.execute({
    callId,
    name,
    arguments: args,
    signal: SIGNAL,
    ...agent === undefined ? {} : { agent },
  })
  if (agent !== undefined) {
    agent.session.append('tool/result', {
      turn,
      step,
      message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
    }, { surfaceOp: 'append', sourceEventSeqs: callSeq === undefined ? [] : [callSeq] })
    for (const context of result.additionalContexts ?? []) agent.inject(context)
  }
  return result
}

function resultText(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function captureSteering(agent: Agent): UserMessage[] {
  const messages: UserMessage[] = []
  agent.steer = (message: UserMessage) => {
    messages.push(message)
    return { outcome: Promise.resolve({ status: 'rejected' as const }) }
  }
  return messages
}

function userText(message: UserMessage): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

async function stop(ctx: Context, agent: Agent, turn = 1): Promise<void> {
  await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn, signal: SIGNAL })
}

describe('semantic loop', () => {
  it('persists whole checkpoints through the durable inbox and enforces compare-and-set revisions', async () => {
    const { ctx, agent } = await setup()
    const first = await execute(ctx, agent, 'semantic_checkpoint', exploring)
    expect(first.isError).toBe(false)
    expect(SemanticLoop.semanticStateOf(agent)).toMatchObject({
      revision: 1,
      checkpoint: { status: 'exploring', gaps: [{ id: 'missing-query' }] },
    })
    expect(agent.session.events.some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source.kind === 'semantic-checkpoint'))).toBe(true)
    const insertion = agent.session.events.find(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source.kind === 'semantic-checkpoint'))
    if (insertion?.type !== 'agent/inbox/spliced') throw new Error('missing semantic receipt')
    const receipt = insertion.data.inserted.find(message => message.source.kind === 'semantic-checkpoint')
    if (receipt?.source.kind !== 'semantic-checkpoint') throw new Error('missing semantic receipt source')
    expect(userText(receipt)).toContain('Semantic state r1 committed')
    expect(userText(receipt)).not.toContain('Answer the database question')
    expect(receipt.source.checkpoint.goal.statement).toBe('Answer the database question')

    const recovered = await execute(ctx, agent, 'semantic_state', {})
    expect(recovered.isError).toBe(false)
    expect(recovered.value).toMatchObject({ revision: 1, status: 'exploring' })
    expect(resultText(recovered)).toContain('Goal answer-database-question@1: Answer the database question')
    expect(SemanticLoop.semanticTelemetryOf(agent)).toMatchObject({
      semanticToolCalls: 2,
      stateReads: 1,
      environmentToolCalls: 0,
      observedToolResults: 0,
    })

    const stale = await execute(ctx, agent, 'semantic_checkpoint', exploring)
    expect(stale.isError).toBe(true)
    expect(resultText(stale)).toContain('expected 1, got 0')

    const second = await execute(ctx, agent, 'semantic_checkpoint', { ...ready, expected_revision: 1 })
    expect(second.isError).toBe(false)
    expect(SemanticLoop.semanticStateOf(agent)?.revision).toBe(2)
  })

  it('rejects completion while exploring and approves only a ready exact revision', async () => {
    const { ctx, agent } = await setup()
    const missingState = await execute(ctx, agent, 'semantic_state', {})
    expect(missingState.isError).toBe(true)
    expect(resultText(missingState)).toContain('semantic state is not initialized')
    const uninitialized = await execute(ctx, agent, 'semantic_finish', { expected_revision: 0, answer: '42' })
    expect(uninitialized.isError).toBe(true)
    expect(resultText(uninitialized)).toContain('requires an initialized checkpoint')
    await execute(ctx, agent, 'semantic_checkpoint', exploring)

    const blocked = await execute(ctx, agent, 'semantic_finish', { expected_revision: 1, answer: '42' })
    expect(blocked.isError).toBe(true)
    expect(blocked.concludesTurn).toBeUndefined()
    expect(resultText(blocked)).toContain('requires ready state')

    await execute(ctx, agent, 'semantic_checkpoint', { ...ready, expected_revision: 1 })
    const stale = await execute(ctx, agent, 'semantic_finish', { expected_revision: 1, answer: '42' })
    expect(stale.isError).toBe(true)
    const unverified = await execute(ctx, agent, 'semantic_finish', { expected_revision: 2, answer: '42' })
    expect(resultText(unverified)).toContain('requires a current verification receipt')
    const verification = await execute(ctx, agent, 'semantic_verify', { expected_revision: 2 })
    expect(verification.value).toMatchObject({ verdict: 'passed', requiredChecks: 5, provedRequiredChecks: 5 })
    const complete = await execute(ctx, agent, 'semantic_finish', { expected_revision: 2, answer: '  42  ' })
    expect(complete.isError).toBe(false)
    expect(complete.concludesTurn).toBeUndefined()
    expect(complete.value).toEqual({ revision: 2, answer: '42' })
    expect(resultText(complete)).toContain('Return this approved answer verbatim')
    expect(resultText(complete)).toContain('42')
    const blank = await execute(ctx, agent, 'semantic_finish', { expected_revision: 2, answer: '   ' })
    expect(blank.isError).toBe(true)
    expect(resultText(blank)).toContain('answer must be non-empty')
  })

  it('lets independent providers block completion and rejects agent-authored required checks', async () => {
    const blocked = await setup()
    blocked.agent.ctx.on('semantic/verify', async (_request, next) => [
      ...await next(),
      {
        verifierId: 'task-policy',
        specVersion: 'task-v1',
        assurance: 'formally-proved' as const,
        checks: [{
          id: 'answer-bound',
          kind: 'smt.answer-bound',
          description: 'The final value satisfies the trusted task bound.',
          issuer: 'task' as const,
          required: true,
          status: 'violated' as const,
          detail: 'counterexample: 42 is greater than the allowed maximum 40',
        }],
        proofDigest: 'sha256:counterexample-42',
      },
    ])
    await execute(blocked.ctx, blocked.agent, 'semantic_checkpoint', ready)
    const failed = await execute(blocked.ctx, blocked.agent, 'semantic_verify', { expected_revision: 1 })
    expect(failed.value).toMatchObject({ verdict: 'failed', requiredChecks: 6, provedRequiredChecks: 5 })
    expect(SemanticLoop.semanticVerificationOf(blocked.agent)).toMatchObject({ verdict: 'failed', revision: 1 })
    const finish = await execute(blocked.ctx, blocked.agent, 'semantic_finish', { expected_revision: 1, answer: '42' })
    expect(resultText(finish)).toContain('current verdict is failed')

    const untrusted = await setup()
    untrusted.agent.ctx.on('semantic/verify', async (_request, next) => [
      ...await next(),
      {
        verifierId: 'agent-proposal',
        specVersion: '1',
        assurance: 'evidence-backed' as const,
        checks: [{
          id: 'self-selected',
          kind: 'agent.claim',
          description: 'The agent selected this requirement.',
          issuer: 'agent' as const,
          required: true,
          status: 'proved' as const,
          detail: 'self-reported',
        }],
        proofDigest: null,
      },
    ])
    await execute(untrusted.ctx, untrusted.agent, 'semantic_checkpoint', ready)
    const rejected = await execute(untrusted.ctx, untrusted.agent, 'semantic_verify', { expected_revision: 1 })
    expect(rejected.isError).toBe(true)
    expect(resultText(rejected)).toContain('agent-issued semantic verification check')
    expect(SemanticLoop.semanticVerificationOf(untrusted.agent)).toBeUndefined()
  })

  it('reports missing plan capabilities and lets a scoped provider satisfy them', async () => {
    const { ctx, agent } = await setup()
    const capabilityReady = {
      ...ready,
      plan: {
        ...ready.plan,
        nodes: [{
          ...ready.plan.nodes[0],
          required_capabilities: ['structured-query', 'semantic-entity-extraction'],
        }],
      },
    }
    await execute(ctx, agent, 'semantic_checkpoint', capabilityReady)
    const inspection = await execute(ctx, agent, 'semantic_capabilities', {})
    expect(inspection.value).toEqual({
      providers: 1,
      available: ['structured-query'],
      required: ['structured-query', 'semantic-entity-extraction'],
      missing: ['semantic-entity-extraction'],
    })
    const unknown = await execute(ctx, agent, 'semantic_verify', { expected_revision: 1 })
    expect(unknown.value).toMatchObject({ verdict: 'unknown', requiredChecks: 6, provedRequiredChecks: 5 })
    expect(resultText(await execute(ctx, agent, 'semantic_finish', {
      expected_revision: 1,
      answer: '42',
    }))).toContain('current verdict is unknown')

    agent.ctx.on('semantic/capabilities', async (_request, next) => [
      ...await next(),
      {
        providerId: 'entity-runtime',
        specVersion: '1',
        capabilities: [{
          id: 'semantic-entity-extraction',
          description: 'Extract typed entities from unstructured text.',
        }],
      },
    ])
    const available = await execute(ctx, agent, 'semantic_verify', { expected_revision: 1 })
    expect(available.value).toMatchObject({ verdict: 'passed', requiredChecks: 6, provedRequiredChecks: 6 })
    expect(() => SemanticLoop.resolveConfiguredCapabilities([{
      id: 'Semantic-NER',
      description: 'Invalid capability id.',
    }])).toThrow(/must be lower-kebab-case/)
  })

  it('bounds no-progress checkpoint revisions and accepts a material replan', async () => {
    const { ctx, agent } = await setup([], 3, false, 65_536, 1)
    const first = await execute(ctx, agent, 'semantic_checkpoint', exploring)
    expect(first.value).toMatchObject({ materialProgress: true, stagnantRevisions: 0 })
    const stagnant = await execute(ctx, agent, 'semantic_checkpoint', { ...exploring, expected_revision: 1 })
    expect(stagnant.value).toMatchObject({ materialProgress: false, progressSignals: 0, stagnantRevisions: 1 })
    const rejected = await execute(ctx, agent, 'semantic_checkpoint', { ...exploring, expected_revision: 2 })
    expect(rejected.isError).toBe(true)
    expect(resultText(rejected)).toContain('exceeds maxStagnantRevisions: 2 > 1')
    expect(SemanticLoop.semanticStateOf(agent)?.revision).toBe(2)

    const revised = await execute(ctx, agent, 'semantic_checkpoint', {
      ...exploring,
      expected_revision: 2,
      plan: {
        revision: 2,
        change_reason: 'use a bounded structured query before any fallback',
        nodes: [{ ...exploring.plan.nodes[0], description: 'Run one bounded structured query' }],
      },
    })
    expect(revised.value).toMatchObject({ materialProgress: true, stagnantRevisions: 0 })
    expect(SemanticLoop.semanticProgressOf(agent)).toMatchObject({
      revision: 3,
      materialChanges: ['plan-revised:2'],
      stagnantRevisions: 0,
    })
    expect(SemanticLoop.semanticTelemetryOf(agent)).toMatchObject({
      checkpointRevisions: 3,
      materialProgressRevisions: 2,
      stagnantCheckpointRevisions: 1,
      currentStagnationStreak: 0,
    })
  })

  it.each([false, true])('requires a checkpoint after a later environment result (error=%s)', async (isError) => {
    const { ctx, agent } = await setup()
    await execute(ctx, agent, 'semantic_checkpoint', ready)
    const callId = CallId(`environment-after-checkpoint-${isError}`)
    agent.session.append('tool/call', {
      turn: 1,
      step: 2,
      callId,
      name: 'database_query',
      arguments: '{}',
    })
    agent.session.append('tool/result', {
      turn: 1,
      step: 2,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: isError ? 'query failed' : '42' }],
        isError,
      }),
    }, { surfaceOp: 'append' })

    const stale = await execute(ctx, agent, 'semantic_finish', { expected_revision: 1, answer: '42' })
    expect(stale.isError).toBe(true)
    expect(resultText(stale)).toContain('checkpoint created after the latest environment-tool result')

    const refreshed = await execute(ctx, agent, 'semantic_checkpoint', { ...ready, expected_revision: 1 })
    expect(refreshed.isError).toBe(false)
    expect((await execute(ctx, agent, 'semantic_verify', { expected_revision: 2 })).isError).toBe(false)
    const accepted = await execute(ctx, agent, 'semantic_finish', { expected_revision: 2, answer: '42' })
    expect(accepted.isError).toBe(false)
  })

  it('projects a failed environment result interleaved before checkpoint commit as stale', async () => {
    const { ctx, agent } = await setup()
    const steered = captureSteering(agent)
    const checkpointCallId = CallId('interleaved-checkpoint')
    const environmentCallId = CallId('interleaved-failure')
    const finishCallId = CallId('interleaved-finish')
    const checkpoint = SemanticLoop.resolveSemanticCheckpoint({
      goal: ready.goal,
      criteria: ready.criteria.map(criterion => ({
        id: criterion.id,
        description: criterion.description,
        status: criterion.status,
        evidence: criterion.evidence,
        evidenceCallIds: criterion.evidence_call_ids,
      })),
      plan: {
        revision: ready.plan.revision,
        changeReason: ready.plan.change_reason,
        nodes: ready.plan.nodes.map(node => ({
          id: node.id,
          operation: node.operation,
          description: node.description,
          dependsOn: node.depends_on,
          inputArtifactIds: node.input_artifact_ids,
          outputArtifactId: node.output_artifact_id,
          requiredCapabilities: node.required_capabilities,
          required: node.required,
        })),
      },
      activeNodeId: ready.active_node_id,
      artifacts: ready.artifacts.map(artifact => ({
        id: artifact.id,
        version: artifact.version,
        kind: artifact.kind,
        summary: artifact.summary,
        locator: artifact.locator,
        contentDigest: artifact.content_digest,
        producerNodeId: artifact.producer_node_id,
        planRevision: artifact.plan_revision,
        inputs: artifact.inputs,
        evidenceCallIds: artifact.evidence_call_ids,
      })),
      facts: ready.facts.map(fact => ({
        id: fact.id,
        statement: fact.statement,
        evidence: fact.evidence,
        evidenceCallIds: fact.evidence_call_ids,
      })),
      gaps: ready.gaps,
      nextAction: ready.next_action,
      status: ready.status,
    })
    agent.session.append('tool/call', {
      turn: 1, step: 1, callId: checkpointCallId, name: 'semantic_checkpoint', arguments: JSON.stringify(ready),
    })
    agent.session.append('tool/call', {
      turn: 1, step: 1, callId: environmentCallId, name: 'database_query', arguments: '{}',
    })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: environmentCallId, content: [], isError: true }),
    }, { surfaceOp: 'append' })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: checkpointCallId, content: [], isError: false }),
    }, { surfaceOp: 'append' })
    const state = { revision: 1, checkpoint }
    agent.session.append('agent/inbox/spliced', {
      target: 'next-step',
      start: 0,
      inserted: [createUserMessage({
        source: {
          kind: 'semantic-checkpoint',
          version: 6,
          sessionId: agent.id,
          checkpointCallId,
          revision: 1,
          checkpoint,
        },
        content: [{ type: 'text', text: SemanticLoop.renderSemanticCheckpointReceipt(state) }],
      })],
    })
    agent.session.append('tool/call', {
      turn: 1,
      step: 2,
      callId: finishCallId,
      name: 'semantic_finish',
      arguments: '{"expected_revision":1,"answer":"42"}',
    })
    agent.session.append('tool/result', {
      turn: 1,
      step: 2,
      message: createToolResultMessage({ callId: finishCallId, content: [], isError: false }),
    }, { surfaceOp: 'append' })
    agent.session.append('assistant/message', {
      turn: 1,
      step: 3,
      message: createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [{ type: 'text', text: '42' }],
      }),
    }, { surfaceOp: 'append' })

    expect(SemanticLoop.semanticCompletionInTurn(agent, 1)).toBeUndefined()
    await stop(ctx, agent)
    expect(userText(steered.at(-1)!)).toContain('invalidated its approval')
  })

  it('requires a fresh checkpoint after a new turn starts', async () => {
    const { ctx, agent } = await setup()
    await execute(ctx, agent, 'semantic_checkpoint', ready)
    agent.session.append('turn/start', { turn: 1 })

    const staleTurn = await execute(ctx, agent, 'semantic_finish', { expected_revision: 1, answer: '42' })
    expect(staleTurn.isError).toBe(true)
    expect(resultText(staleTurn)).toContain('checkpoint created in the current turn')
    expect(SemanticLoop.semanticCompletionInTurn(agent, 0)).toBeUndefined()
  })

  it('links successful current-turn environment results and can require them for ready state', async () => {
    const { ctx, agent } = await setup([], 3, true)
    expect(SemanticLoop.semanticEvidenceOf(agent)).toEqual([])
    expect(SemanticLoop.semanticTelemetryOf(agent)).toEqual({
      checkpointRevisions: 0,
      semanticToolCalls: 0,
      semanticToolFailures: 0,
      stateReads: 0,
      capabilityReads: 0,
      environmentToolCalls: 0,
      successfulEnvironmentToolCalls: 0,
      finishAttempts: 0,
      verificationAttempts: 0,
      verificationReceipts: 0,
      passedVerifications: 0,
      materialProgressRevisions: 0,
      stagnantCheckpointRevisions: 0,
      currentStagnationStreak: 0,
      acceptedFinishResults: 0,
      repairSteps: 0,
      evidenceToolResults: 0,
      observedToolResults: 0,
    })
    const unsupported = await execute(ctx, agent, 'semantic_checkpoint', ready)
    expect(unsupported.isError).toBe(true)
    expect(resultText(unsupported)).toContain('requires a current-turn environment-tool result linked')

    const callId = CallId('query-result-1')
    agent.session.append('tool/call', { turn: 1, step: 1, callId, name: 'database_query', arguments: '{"sql":"select 42"}' })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: '42' }], isError: false }),
    }, { surfaceOp: 'append' })
    const failedId = CallId('query-result-failed')
    agent.session.append('tool/call', { turn: 1, step: 1, callId: failedId, name: 'database_query', arguments: '{}' })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: failedId, content: [], isError: true }),
    }, { surfaceOp: 'append' })

    const unrelated = await execute(ctx, agent, 'semantic_checkpoint', ready)
    expect(unrelated.isError).toBe(true)
    const supported = await execute(ctx, agent, 'semantic_checkpoint', {
      ...ready,
      criteria: [{ ...ready.criteria[0], evidence_call_ids: [callId] }],
      facts: [{ ...ready.facts[0], evidence_call_ids: [callId] }],
    })
    expect(supported.isError).toBe(false)
    expect(supported.value).toMatchObject({ evidenceToolResults: 1, observedToolResults: 1 })
    expect(SemanticLoop.semanticStateOf(agent)?.checkpoint.observedCallIds).toEqual([callId])
    expect(SemanticLoop.semanticEvidenceOf(agent)).toEqual([{
      callId,
      name: 'database_query',
      arguments: '{"sql":"select 42"}',
      content: [{ type: 'text', text: '42' }],
      turn: 1,
      step: 1,
    }])
    const afterId = CallId('query-after-checkpoint')
    agent.session.append('tool/call', { turn: 1, step: 2, callId: afterId, name: 'database_query', arguments: '{}' })
    agent.session.append('tool/result', {
      turn: 1,
      step: 2,
      message: createToolResultMessage({ callId: afterId, content: [{ type: 'text', text: 'ignored until next checkpoint' }], isError: false }),
    }, { surfaceOp: 'append' })
    expect(SemanticLoop.semanticEvidenceOf(agent)).toHaveLength(1)
    expect(SemanticLoop.semanticTelemetryOf(agent)).toMatchObject({
      checkpointRevisions: 1,
      environmentToolCalls: 3,
      successfulEnvironmentToolCalls: 2,
      evidenceToolResults: 1,
    })
  })

  it('rejects unknown and failed environment-tool result references', async () => {
    const { ctx, agent } = await setup()
    const failedId = CallId('failed-evidence')
    agent.session.append('tool/call', {
      turn: 1, step: 1, callId: failedId, name: 'database_query', arguments: '{}',
    })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: failedId, content: [], isError: true }),
    }, { surfaceOp: 'append' })

    for (const callId of [failedId, CallId('unknown-evidence')]) {
      const result = await execute(ctx, agent, 'semantic_checkpoint', {
        ...ready,
        criteria: [{ ...ready.criteria[0], evidence_call_ids: [callId] }],
      })
      expect(result.isError).toBe(true)
      expect(resultText(result)).toContain('is not an earlier successful environment-tool result')
    }
    expect(SemanticLoop.semanticStateOf(agent)).toBeUndefined()
  })

  it('bounds canonical and rendered checkpoint UTF-8 bytes', async () => {
    const args = { ...ready, goal: { ...ready.goal, statement: '回答数据库问题：四十二' } }
    const checkpoint = SemanticLoop.resolveSemanticCheckpoint({
      goal: args.goal,
      criteria: args.criteria.map(criterion => ({
        id: criterion.id,
        description: criterion.description,
        status: criterion.status,
        evidence: criterion.evidence,
        evidenceCallIds: criterion.evidence_call_ids,
      })),
      plan: {
        revision: args.plan.revision,
        changeReason: args.plan.change_reason,
        nodes: args.plan.nodes.map(node => ({
          id: node.id,
          operation: node.operation,
          description: node.description,
          dependsOn: node.depends_on,
          inputArtifactIds: node.input_artifact_ids,
          outputArtifactId: node.output_artifact_id,
          requiredCapabilities: node.required_capabilities,
          required: node.required,
        })),
      },
      activeNodeId: args.active_node_id,
      artifacts: args.artifacts.map(artifact => ({
        id: artifact.id,
        version: artifact.version,
        kind: artifact.kind,
        summary: artifact.summary,
        locator: artifact.locator,
        contentDigest: artifact.content_digest,
        producerNodeId: artifact.producer_node_id,
        planRevision: artifact.plan_revision,
        inputs: artifact.inputs,
        evidenceCallIds: artifact.evidence_call_ids,
      })),
      facts: args.facts.map(fact => ({
        id: fact.id,
        statement: fact.statement,
        evidence: fact.evidence,
        evidenceCallIds: fact.evidence_call_ids,
      })),
      gaps: args.gaps,
      nextAction: args.next_action,
      status: args.status,
    })
    const bytes = Math.max(
      Buffer.byteLength(JSON.stringify(checkpoint), 'utf8'),
      Buffer.byteLength(SemanticLoop.renderSemanticCheckpoint({ revision: 1, checkpoint }), 'utf8'),
    )
    const exact = await setup([], 3, false, bytes)
    expect((await execute(exact.ctx, exact.agent, 'semantic_checkpoint', args)).isError).toBe(false)

    const over = await setup([], 3, false, bytes - 1)
    const rejected = await execute(over.ctx, over.agent, 'semantic_checkpoint', args)
    expect(rejected.isError).toBe(true)
    expect(resultText(rejected)).toContain(`maxCheckpointBytes: ${bytes} > ${bytes - 1}`)
    expect(SemanticLoop.semanticStateOf(over.agent)).toBeUndefined()
  })

  it('fails loud on an invalid checkpoint byte limit', async () => {
    await expect(setup([], 3, false, 0)).rejects.toThrow(/maxCheckpointBytes expected number >= 1/)
  })

  it('fails loud on an invalid stagnation limit', async () => {
    await expect(setup([], 3, false, 65_536, -1)).rejects.toThrow(/maxStagnantRevisions expected number >= 0/)
  })

  it('fails loud on an invalid protocol failure limit', async () => {
    await expect(setup([], 3, false, 65_536, 3, 0)).rejects.toThrow(/maxProtocolFailures expected number >= 1/)
  })

  it('presents every semantic control as a pure generic card', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('semantic_checkpoint')?.presentCall?.(exploring)).toEqual({
      card: 'generic', title: 'Update semantic state', kind: 'other', rawInput: exploring,
    })
    expect(ctx.tools.get('semantic_finish')?.presentCall?.({ expected_revision: 1, answer: '42' })).toEqual({
      card: 'generic', title: 'Submit semantic answer', kind: 'other', rawInput: '42',
    })
    expect(ctx.tools.get('semantic_state')?.presentCall?.({})).toEqual({
      card: 'generic', title: 'Read semantic state', kind: 'other', rawInput: {},
    })
    expect(ctx.tools.get('semantic_verify')?.presentCall?.({ expected_revision: 1 })).toEqual({
      card: 'generic', title: 'Verify semantic state', kind: 'other', rawInput: { expected_revision: 1 },
    })
    expect(ctx.tools.get('semantic_capabilities')?.presentCall?.({})).toEqual({
      card: 'generic', title: 'Inspect semantic capabilities', kind: 'other', rawInput: {},
    })
  })

  it('repairs every semantic state and clears repair tracking on lifecycle events', async () => {
    const { ctx, agent } = await setup()
    const steered = captureSteering(agent)

    await stop(ctx, agent)
    expect(userText(steered.at(-1)!)).toContain('not initialized')

    await execute(ctx, agent, 'semantic_checkpoint', exploring)
    await stop(ctx, agent)
    expect(userText(steered.at(-1)!)).toContain('unmet criteria: answer-supported')
    expect(userText(steered.at(-1)!)).toContain('open gaps: missing-query')

    await execute(ctx, agent, 'semantic_checkpoint', {
      ...exploring,
      expected_revision: 1,
      criteria: [{
        ...ready.criteria[0],
        evidence: 'The criterion is semantically settled without a new tool observation',
      }],
      gaps: [],
      active_node_id: null,
      next_action: 'Define completion criteria',
    })
    await stop(ctx, agent)
    expect(userText(steered.at(-1)!)).toContain('is still exploring. Continue')

    await execute(ctx, agent, 'semantic_checkpoint', { ...ready, expected_revision: 2 })
    await stop(ctx, agent)
    expect(userText(steered.at(-1)!)).toContain('lacks a current passing verification receipt')
    await execute(ctx, agent, 'semantic_verify', { expected_revision: 3 })
    await stop(ctx, agent)
    expect(userText(steered.at(-1)!)).toContain('is ready. Submit the final answer')

    agentEvents(ctx, agent).emit('agent/status', { status: 'running' })
    agentEvents(ctx, agent).emit('agent/status', { status: 'idle' })
    agentEvents(ctx, agent).emit('agent/disposed', {})
  })

  it('bounds repair attempts without progress at one revision', async () => {
    const { ctx, agent } = await setup([], 1)
    captureSteering(agent)

    await stop(ctx, agent)
    await expect(stop(ctx, agent)).rejects.toThrow(/did not progress after 1 repair steps at revision 0/)
  })

  it('recognizes only successful non-empty finish approvals and exact assistant text', async () => {
    const { ctx, agent } = await setup()
    const steered = captureSteering(agent)
    await execute(ctx, agent, 'semantic_checkpoint', ready)
    await execute(ctx, agent, 'semantic_verify', { expected_revision: 1 })
    const malformed = CallId('finish-malformed')
    const blank = CallId('finish-blank')
    const accepted = CallId('finish-accepted')
    const invalidRevision = CallId('finish-invalid-revision')
    const fractionalRevision = CallId('finish-fractional-revision')
    const zeroRevision = CallId('finish-zero-revision')
    const nonTextAnswer = CallId('finish-non-text-answer')
    agent.session.append('tool/call', { turn: 1, step: 1, callId: malformed, name: 'semantic_finish', arguments: '{' })
    agent.session.append('tool/call', { turn: 1, step: 1, callId: invalidRevision, name: 'semantic_finish', arguments: '{"expected_revision":"1","answer":"42"}' })
    agent.session.append('tool/call', { turn: 1, step: 1, callId: fractionalRevision, name: 'semantic_finish', arguments: '{"expected_revision":1.5,"answer":"42"}' })
    agent.session.append('tool/call', { turn: 1, step: 1, callId: zeroRevision, name: 'semantic_finish', arguments: '{"expected_revision":0,"answer":"42"}' })
    agent.session.append('tool/call', { turn: 1, step: 1, callId: nonTextAnswer, name: 'semantic_finish', arguments: '{"expected_revision":1,"answer":42}' })
    agent.session.append('tool/call', { turn: 1, step: 1, callId: blank, name: 'semantic_finish', arguments: '{"expected_revision":1,"answer":""}' })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: blank, content: [], isError: true }),
    }, { surfaceOp: 'append' })
    agent.session.append('tool/call', { turn: 1, step: 1, callId: accepted, name: 'semantic_finish', arguments: '{"expected_revision":1,"answer":" 42 "}' })
    agent.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [{ type: 'text', text: '42' }],
      }),
    }, { surfaceOp: 'append' })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: accepted, content: [], isError: false }),
    }, { surfaceOp: 'append' })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: CallId('finish-unmatched'), content: [], isError: false }),
    }, { surfaceOp: 'append' })
    agent.session.append('tool/result', {
      turn: 2,
      step: 1,
      message: createToolResultMessage({ callId: accepted, content: [], isError: false }),
    }, { surfaceOp: 'append' })

    await stop(ctx, agent)
    expect(userText(steered.at(-1)!)).toContain('following answer verbatim')

    agent.session.append('assistant/message', {
      turn: 1,
      step: 2,
      message: createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [{ type: 'tool-call', id: CallId('non-text'), name: 'other', arguments: '{}' }],
      }),
    }, { surfaceOp: 'append' })
    await stop(ctx, agent)
    expect(steered).toHaveLength(2)

    agent.session.append('assistant/message', {
      turn: 1,
      step: 3,
      message: createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [
          { type: 'tool-call', id: CallId('ignored-tool'), name: 'other', arguments: '{}' },
          { type: 'text', text: ' 4' },
          { type: 'text', text: '2 ' },
        ],
      }),
    }, { surfaceOp: 'append' })
    await stop(ctx, agent)
    expect(steered).toHaveLength(2)
  })

  it('does not treat a successful finish result without semantic state as completion', async () => {
    const { agent } = await setup()
    const callId = CallId('finish-without-state')
    agent.session.append('tool/call', {
      turn: 1, step: 1, callId, name: 'semantic_finish',
      arguments: '{"expected_revision":1,"answer":"42"}',
    })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [], isError: false }),
    }, { surfaceOp: 'append' })
    agent.session.append('assistant/message', {
      turn: 1,
      step: 2,
      message: createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [{ type: 'text', text: '42' }],
      }),
    }, { surfaceOp: 'append' })
    expect(SemanticLoop.semanticCompletionInTurn(agent, 1)).toBeUndefined()
  })

  it('invalidates an approval after later tool or checkpoint activity', async () => {
    const { ctx, agent } = await setup()
    const steered = captureSteering(agent)
    await execute(ctx, agent, 'semantic_checkpoint', ready)
    await execute(ctx, agent, 'semantic_verify', { expected_revision: 1 })
    const approved = CallId('finish-before-more-work')
    agent.session.append('tool/call', {
      turn: 1, step: 1, callId: approved, name: 'semantic_finish',
      arguments: '{"expected_revision":1,"answer":"42"}',
    })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: approved, content: [], isError: false }),
    }, { surfaceOp: 'append' })
    expect(SemanticLoop.semanticCompletionInTurn(agent, 1)).toBeUndefined()
    const later = CallId('later-query')
    agent.session.append('tool/call', { turn: 1, step: 2, callId: later, name: 'database_query', arguments: '{}' })
    agent.session.append('tool/result', {
      turn: 1,
      step: 2,
      message: createToolResultMessage({ callId: later, content: [{ type: 'text', text: '43' }], isError: false }),
    }, { surfaceOp: 'append' })
    agent.session.append('assistant/message', {
      turn: 1,
      step: 3,
      message: createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [{ type: 'text', text: '42' }],
      }),
    }, { surfaceOp: 'append' })

    await stop(ctx, agent)
    expect(userText(steered.at(-1)!)).toContain('invalidated its approval')
    expect(SemanticLoop.semanticCompletionInTurn(agent, 1)).toBeUndefined()

    await execute(ctx, agent, 'semantic_checkpoint', { ...ready, expected_revision: 1 })
    await stop(ctx, agent)
    expect(userText(steered.at(-1)!)).toContain('invalidated its approval')
    expect(SemanticLoop.semanticTelemetryOf(agent)).toMatchObject({
      checkpointRevisions: 2,
      semanticToolCalls: 4,
      stateReads: 0,
      environmentToolCalls: 1,
      finishAttempts: 1,
      acceptedFinishResults: 1,
    })
  })

  it('repairs premature text, projects the checkpoint, and finishes through the real agent loop', async () => {
    const script = [
      textResponse('Premature answer.'),
      toolCallResponse('checkpoint-1', 'semantic_checkpoint', ready),
      toolCallResponse('verify-1', 'semantic_verify', { expected_revision: 1 }),
      toolCallResponse('finish-1', 'semantic_finish', { expected_revision: 1, answer: '42' }),
      textResponse('forty two'),
      textResponse('42'),
    ]
    const { agent, adapter } = await setup(script)
    agent.followup(createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'What is the result?' }],
    }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(6)
    expect(adapter.requests[0]?.system).toContain('semantic agent loop')
    expect(adapter.requests[0]?.system).toContain('emit tool calls without accompanying ordinary assistant narration')
    expect(adapter.requests[0]?.system).toContain('A new user turn does not reset the revision')
    expect(adapter.requests[0]?.system).toContain('they are the control protocol, not task capabilities')
    expect(adapter.requests[0]?.system).toContain('active_node_id: null explicitly')
    expect(adapter.requests[1]?.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('Semantic completion is not initialized')))).toBe(true)
    expect(adapter.requests[2]?.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('Semantic state r1')))).toBe(true)
    expect(adapter.requests[5]?.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('did not match it')))).toBe(true)
    const finalResult = agent.session.events.findLast(event => event.type === 'tool/result')
    expect(finalResult?.type).toBe('tool/result')
    if (finalResult?.type !== 'tool/result') throw new Error('missing semantic_finish result')
    const toolResultBlock = finalResult.data.message.content.find(block => block.type === 'tool-result')
    if (toolResultBlock === undefined) throw new Error('missing semantic_finish result block')
    const completionBlock = toolResultBlock.content.find(block => block.type === 'text')
    if (completionBlock === undefined) throw new Error('missing semantic_finish result text')
    expect(completionBlock.text).toContain('Return this approved answer verbatim')
    const finalAssistant = agent.session.events.findLast(event => event.type === 'assistant/message')
    expect(finalAssistant?.type === 'assistant/message' ? finalAssistant.data.message.content : []).toEqual([{ type: 'text', text: '42' }])
    expect(SemanticLoop.semanticCompletionInTurn(agent, 1)).toEqual({ turn: 1, revision: 1, answer: '42' })
    expect(SemanticLoop.semanticTelemetryOf(agent)).toMatchObject({
      checkpointRevisions: 1,
      semanticToolCalls: 3,
      environmentToolCalls: 0,
      finishAttempts: 1,
      acceptedFinishResults: 1,
      repairSteps: 2,
    })
    expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'completed' })
  })

  it('cancels a turn after its semantic protocol failure budget is exhausted', async () => {
    const missingActiveNode = { ...ready, active_node_id: undefined }
    const script = [
      toolCallResponse('invalid-checkpoint-1', 'semantic_checkpoint', missingActiveNode),
      toolCallResponse('invalid-checkpoint-2', 'semantic_checkpoint', missingActiveNode),
      toolCallResponse('invalid-checkpoint-3', 'semantic_checkpoint', missingActiveNode),
    ]
    const { agent, adapter } = await setup(script, 3, false, 65_536, 3, 2)
    agent.followup(createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Return 42.' }],
    }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(SemanticLoop.semanticTelemetryOf(agent)).toMatchObject({
      semanticToolCalls: 2,
      semanticToolFailures: 2,
      checkpointRevisions: 0,
    })
    expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason).toEqual({
      kind: 'aborted',
      reason: {
        kind: 'hook',
        reason: 'semantic protocol failed 2 times in turn 1; limit 2',
      },
    })
  })

  it('fails load-time config and unwinds tools with the plugin fiber', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(SemanticLoop, { maxRepairSteps: 0 }).then(() => undefined)).rejects.toThrow(/expected number >= 1/)

    const fiber = await ctx.plugin(SemanticLoop, { maxRepairSteps: 1 })
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(expect.arrayContaining(['semantic_checkpoint', 'semantic_state', 'semantic_finish']))
    await fiber.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toEqual(expect.arrayContaining(['semantic_checkpoint', 'semantic_state', 'semantic_finish']))

    expect(() => { SemanticLoop.apply(new Context(), { maxRepairSteps: 0 }) }).toThrow(/positive safe integer/)
    expect(() => { SemanticLoop.apply(new Context(), { maxRepairSteps: 1.5 }) }).toThrow(/positive safe integer/)
    expect(() => { SemanticLoop.apply(new Context(), { maxProtocolFailures: 0 }) }).toThrow(/positive safe integer/)
    expect(() => { SemanticLoop.apply(new Context(), { maxRepairSteps: 1, requireToolEvidence: 'yes' as never }) }).toThrow(/must be a boolean/)

    const rawCtx = new Context()
    await mountAgentLoopTestDependencies(rawCtx)
    SemanticLoop.apply(rawCtx, {})
    expect(rawCtx.tools.schemas().map(schema => schema.name)).toEqual(expect.arrayContaining(['semantic_checkpoint', 'semantic_state', 'semantic_finish']))
  })

  it('rejects a non-agent caller', async () => {
    const { ctx } = await setup()
    const checkpoint = await execute(ctx, undefined, 'semantic_checkpoint', exploring)
    expect(checkpoint.isError).toBe(true)
    expect(resultText(checkpoint)).toContain('owning agent session')
    const state = await execute(ctx, undefined, 'semantic_state', {})
    expect(state.isError).toBe(true)
    expect(resultText(state)).toContain('owning agent session')
    const finish = await execute(ctx, undefined, 'semantic_finish', { expected_revision: 1, answer: '42' })
    expect(finish.isError).toBe(true)
    expect(resultText(finish)).toContain('owning agent session')
  })
})

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, createMessage, createToolResultMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as SemanticLoop from '../src/index.ts'

const SIGNAL = new AbortController().signal
let sequence = 0

async function setup(config: SemanticLoop.Config = {}): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SemanticLoop, config)
  const agent = ctx.agentLoop.create(SessionId(`command-v2-${++sequence}`), { provider: 'unused', model: 'unused' })
  agent.session.append('turn/start', { turn: 1 })
  return { ctx, agent }
}

async function execute(ctx: Context, agent: Agent, name: string, args: unknown) {
  const callId = CallId(`command-${++sequence}`)
  const call = agent.session.append('tool/call', {
    turn: 1, step: sequence, callId, name, arguments: JSON.stringify(args),
  })
  const result = await ctx.tools.execute({ callId, name, arguments: args, signal: SIGNAL, agent })
  agent.session.append('tool/result', {
    turn: 1,
    step: sequence,
    message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  for (const context of result.additionalContexts ?? []) agent.inject(context)
  return result
}

function assertSuccess(result: Awaited<ReturnType<typeof execute>>): Awaited<ReturnType<typeof execute>> {
  expect(result.isError).toBe(false)
  return result
}

function resultText(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function schemaHasUnsupportedUnion(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(schemaHasUnsupportedUnion)
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return Object.hasOwn(record, 'oneOf') || Object.values(record).some(schemaHasUnsupportedUnion)
}

function rewriteMessages(
  events: readonly SessionEvent[],
  rewrite: (message: UserMessage) => UserMessage | undefined,
): SessionEvent[] {
  return events.flatMap((event): SessionEvent[] => {
    if (event.type === 'user/message') {
      const message = rewrite(event.data)
      return message === undefined ? [] : [{ ...event, data: message }]
    }
    if (event.type !== 'agent/inbox/spliced') return [event]
    return [{
      ...event,
      data: {
        ...event.data,
        inserted: event.data.inserted.flatMap(message => {
          const changed = rewrite(message)
          return changed === undefined ? [] : [changed]
        }),
      },
    }]
  })
}

async function beginSimpleRun(ctx: Context, agent: Agent): Promise<void> {
  assertSuccess(await execute(ctx, agent, 'semantic_begin', {
    goal_id: 'replay-task', goal_statement: 'Return one replay-safe answer',
    plan_nodes: [{
      id: 'produce-answer', operation: 'produce-answer', description: 'Produce the answer',
      depends_on: [], input_artifact_ids: [], output_artifact_id: 'answer',
      required_capabilities: [], required: true,
    }],
    next_action: 'Produce the answer',
  }))
}

async function reachFinalCandidate(ctx: Context, agent: Agent): Promise<void> {
  await beginSimpleRun(ctx, agent)
  const begin = SemanticLoop.semanticRunOf(agent)!
  assertSuccess(await execute(ctx, agent, 'semantic_progress', {
    expected_revision: begin.snapshot.state.revision,
    met_criterion_ids: ['goal-completion'],
    new_artifacts: [{
      id: 'answer', kind: 'final-answer', summary: 'The answer is 42',
      locator: 'semantic://answer/replay', content_digest: 'a'.repeat(64),
      producer_node_id: 'produce-answer', input_versions: [],
    }],
    next_action: 'Seal the run',
  }))
  const progress = SemanticLoop.semanticRunOf(agent)!
  assertSuccess(await execute(ctx, agent, 'semantic_ready', {
    expected_revision: progress.snapshot.state.revision, next_action: 'submit-candidate',
  }))
  const ready = SemanticLoop.semanticRunOf(agent)!
  assertSuccess(await execute(ctx, agent, 'semantic_candidate', {
    expected_revision: ready.snapshot.state.revision, kind: 'final-answer', answer: '42',
  }))
}

describe('command-v2 semantic loop', () => {
  it('registers incremental commands by default with flat optional fields', async () => {
    const { ctx } = await setup()
    const schemas = ctx.tools.schemas()
    const names = schemas.map(schema => schema.name)
    expect(names).toEqual(expect.arrayContaining([
      'semantic_begin', 'semantic_progress', 'semantic_replan', 'semantic_ready',
      'semantic_candidate', 'semantic_verify', 'semantic_finish',
    ]))
    expect(names).not.toContain('semantic_checkpoint')
    for (const schema of schemas.filter(item => item.name.startsWith('semantic_'))) {
      expect(schemaHasUnsupportedUnion(schema.parameters)).toBe(false)
    }
    const ready = schemas.find(schema => schema.name === 'semantic_ready')
    expect(ready?.parameters).not.toHaveProperty('active_node_id')
  })

  it('binds verification and finish to one exact submitted candidate', async () => {
    const { ctx, agent } = await setup()
    assertSuccess(await execute(ctx, agent, 'semantic_begin', {
      goal_id: 'answer-task',
      goal_statement: 'Return the exact checked answer',
      plan_nodes: [{
        id: 'materialize-answer', operation: 'materialize-answer', description: 'Create the final answer',
        depends_on: [], input_artifact_ids: [], output_artifact_id: 'answer',
        required_capabilities: [], required: true,
      }],
      next_action: 'Materialize the answer',
    }))
    const begin = SemanticLoop.semanticRunOf(agent)!
    expect(begin.snapshot.state.phase).toBe('exploring')

    assertSuccess(await execute(ctx, agent, 'semantic_progress', {
      expected_revision: begin.snapshot.state.revision,
      met_criterion_ids: ['goal-completion'],
      new_artifacts: [{
        id: 'answer', kind: 'final-answer', summary: 'The exact answer is 42',
        locator: 'semantic://answer/1', content_digest: 'd'.repeat(64),
        producer_node_id: 'materialize-answer', input_versions: [],
      }],
      next_action: 'Seal the run',
    }))
    const progress = SemanticLoop.semanticRunOf(agent)!
    assertSuccess(await execute(ctx, agent, 'semantic_ready', {
      expected_revision: progress.snapshot.state.revision, next_action: 'submit-candidate',
    }))
    const ready = SemanticLoop.semanticRunOf(agent)!
    assertSuccess(await execute(ctx, agent, 'semantic_candidate', {
      expected_revision: ready.snapshot.state.revision, kind: 'final-answer', answer: '42',
    }))
    const candidate = SemanticLoop.semanticCandidateOf(agent)!.candidate
    const candidateRun = SemanticLoop.semanticRunOf(agent)!
    ctx.on('semantic/verify-v2', async (request, next) => [
      ...await next(),
      {
        providerId: 'self-claimed-formal', providerVersion: '1',
        checks: [{
          obligationId: 'runtime-run-ready', subjectDigest: request.candidateDigest,
          status: 'proved' as const, claimedAssurance: 'formally-proved' as const,
          detail: 'provider claim without a durable independent checker receipt',
          proofIds: ['proof-1'], counterexampleIds: [], checkerReceiptDigests: ['a'.repeat(64)],
        }],
        proofRefs: [{
          id: 'proof-1', format: 'deterministic-report' as const,
          locator: 'artifact://proof/1', contentDigest: 'b'.repeat(64),
          subjectDigest: request.candidateDigest, specificationDigest: request.specDigest,
          verifierId: 'self-claimed-formal', verifierVersion: '1',
          checkerId: 'missing-checker', checkerVersion: '1',
          checkerReceiptDigest: 'a'.repeat(64), checkerCallId: 'missing-checker-call',
        }],
        counterexampleRefs: [],
      },
    ])
    assertSuccess(await execute(ctx, agent, 'semantic_verify', {
      expected_revision: candidateRun.snapshot.state.revision, candidate_digest: candidate.candidateDigest,
    }))
    expect(SemanticLoop.semanticVerificationV2Of(agent)?.receipt).toMatchObject({
      verdict: 'passed', candidateDigest: candidate.candidateDigest,
      coverage: { formallyProved: 0 },
    })

    const stale = await execute(ctx, agent, 'semantic_finish', {
      expected_revision: candidateRun.snapshot.state.revision, candidate_digest: '0'.repeat(64),
    })
    expect(stale.isError).toBe(true)
    const finish = assertSuccess(await execute(ctx, agent, 'semantic_finish', {
      expected_revision: candidateRun.snapshot.state.revision, candidate_digest: candidate.candidateDigest,
    }))
    expect(resultText(finish)).toContain('Return this exact candidate verbatim:\n\n42')
    agent.session.append('assistant/message', {
      turn: 1, step: sequence,
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' },
        content: [{ type: 'text', text: '42' }],
      }),
    }, { surfaceOp: 'append' })
    expect(SemanticLoop.semanticCompletionInTurn(agent, 1)).toEqual({
      turn: 1, revision: candidateRun.snapshot.state.revision, answer: '42',
    })
    expect(SemanticLoop.semanticTelemetryOf(agent)).toMatchObject({
      specificationVersion: 1,
      runRevision: candidateRun.snapshot.state.revision,
      candidateSubmissions: 1,
      passedVerifications: 1,
      acceptedFinishResults: 1,
      unverifiedCompletions: 0,
    })
  })

  it('keeps an unmapped authority input unknown instead of treating Agent omission as coverage', async () => {
    const { ctx, agent } = await setup()
    agent.session.append('user/message', createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Preserve every requirement in this input.' }],
    }), { surfaceOp: 'append' })
    assertSuccess(await execute(ctx, agent, 'semantic_begin', {
      goal_id: 'map-authority', goal_statement: 'Map the user input',
      plan_nodes: [{
        id: 'produce-answer', operation: 'produce-answer', description: 'Produce the answer',
        depends_on: [], input_artifact_ids: [], output_artifact_id: 'answer',
        required_capabilities: [], required: true,
      }],
      next_action: 'Review the open mapping question',
    }))
    expect(SemanticLoop.semanticSpecificationOf(agent)?.specification).toMatchObject({
      sourceCoverage: [{ disposition: 'open-question', reviewerAuthority: 'agent', status: 'unknown' }],
      openQuestions: [{ status: 'open' }],
    })
    const begin = SemanticLoop.semanticRunOf(agent)!
    assertSuccess(await execute(ctx, agent, 'semantic_progress', {
      expected_revision: begin.snapshot.state.revision,
      met_criterion_ids: ['goal-completion'],
      new_artifacts: [{
        id: 'answer', kind: 'final-answer', summary: 'A provisional answer',
        locator: 'semantic://answer/unmapped', content_digest: 'e'.repeat(64),
        producer_node_id: 'produce-answer', input_versions: [],
      }],
      next_action: 'Seal the provisional run',
    }))
    const progress = SemanticLoop.semanticRunOf(agent)!
    assertSuccess(await execute(ctx, agent, 'semantic_ready', {
      expected_revision: progress.snapshot.state.revision, next_action: 'submit-candidate',
    }))
    const ready = SemanticLoop.semanticRunOf(agent)!
    assertSuccess(await execute(ctx, agent, 'semantic_candidate', {
      expected_revision: ready.snapshot.state.revision,
      kind: 'final-answer', answer: 'Provisional',
    }))
    const candidate = SemanticLoop.semanticCandidateOf(agent)!.candidate
    const candidateRun = SemanticLoop.semanticRunOf(agent)!
    assertSuccess(await execute(ctx, agent, 'semantic_verify', {
      expected_revision: candidateRun.snapshot.state.revision,
      candidate_digest: candidate.candidateDigest,
    }))
    expect(SemanticLoop.semanticVerificationV2Of(agent)?.receipt).toMatchObject({
      verdict: 'unknown', coverage: { residualRiskIds: ['semantic-mapping-coverage'] },
    })
  })

  it('rejects a run whose committed specification source was removed', async () => {
    const { ctx, agent } = await setup()
    await beginSimpleRun(ctx, agent)
    const withoutSpecification = rewriteMessages(agent.session.events, message =>
      message.source.kind === 'semantic-specification' ? undefined : message)

    expect(() => SemanticLoop.foldSemanticRuns(withoutSpecification)).toThrow(/active specification/)
  })

  it('rejects semantic control calls cited as environment evidence', async () => {
    const { ctx, agent } = await setup()
    await beginSimpleRun(ctx, agent)
    const begin = SemanticLoop.semanticRunOf(agent)!
    assertSuccess(await execute(ctx, agent, 'semantic_progress', {
      expected_revision: begin.snapshot.state.revision,
      met_criterion_ids: ['goal-completion'],
      next_action: 'Continue',
    }))
    const beginCallId = agent.session.events.find(event =>
      event.type === 'tool/call' && event.data.name === 'semantic_begin')?.data.callId
    if (beginCallId === undefined) throw new Error('missing begin call')
    const forged = rewriteMessages(agent.session.events, message => {
      if (message.source.kind !== 'semantic-run-delta' || message.source.command !== 'progress') return message
      const snapshot = message.source.snapshot
      const facts = [{
        id: 'forged-evidence', statement: 'A semantic control call proved the task result',
        evidence: 'The begin call succeeded', evidenceCallIds: [beginCallId],
      }]
      const material = {
        specDigest: snapshot.state.specDigest,
        phase: snapshot.state.phase,
        plan: snapshot.plan,
        criteria: snapshot.criteria,
        metCriterionIds: snapshot.state.metCriterionIds,
        artifacts: snapshot.artifacts,
        facts,
        gaps: snapshot.gaps,
        nextAction: snapshot.nextAction,
        ...(snapshot.state.activeNodeId === undefined ? {} : { activeNodeId: snapshot.state.activeNodeId }),
      }
      const state = {
        ...snapshot.state,
        materialStateDigest: SemanticLoop.semanticDigest('material-state', 1, material),
      }
      const changedSnapshot = { ...snapshot, state, facts }
      const source: SemanticLoop.SemanticRunDeltaSourceV1 = {
        ...message.source,
        runStateDigest: SemanticLoop.semanticRunStateDigest(state),
        snapshot: changedSnapshot,
      }
      return createUserMessage({
        source,
        content: [{ type: 'text', text: SemanticLoop.renderSemanticRunReceipt(source) }],
      })
    })

    expect(() => SemanticLoop.foldSemanticRuns(forged)).toThrow(/successful environment call/)
  })

  it('rejects a user requirement whose quote does not match its authority input', async () => {
    const { ctx, agent } = await setup()
    const input = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Return exactly 42.' }],
    })
    agent.session.append('user/message', input, { surfaceOp: 'append' })
    assertSuccess(await execute(ctx, agent, 'semantic_begin', {
      goal_id: 'quote-task', goal_statement: 'Return exactly 42',
      requirement_proposals: [{
        id: 'exact-answer', statement: 'Return exactly 42', kind: 'hard-formal',
        phase: 'final-candidate', required: true, source_id: input.id, quote: 'Return exactly 42',
      }],
      plan_nodes: [{
        id: 'produce-answer', operation: 'produce-answer', description: 'Produce the answer',
        depends_on: [], input_artifact_ids: [], output_artifact_id: 'answer',
        required_capabilities: [], required: true,
      }],
      next_action: 'Produce the answer',
    }))
    const forged = rewriteMessages(agent.session.events, message => {
      if (message.source.kind !== 'semantic-specification') return message
      const specification = {
        ...message.source.specification,
        requirements: message.source.specification.requirements.map(requirement => requirement.id === 'exact-answer'
          ? { ...requirement, sources: [{ ...requirement.sources[0]!, quote: 'forged', start: 0, end: 6 }] }
          : requirement),
      }
      const source: SemanticLoop.SemanticSpecificationSourceV1 = {
        ...message.source,
        specDigest: SemanticLoop.semanticSpecDigest(specification),
        specification,
      }
      return createUserMessage({
        source,
        content: [{ type: 'text', text: SemanticLoop.renderSemanticSpecificationReceipt(source) }],
      })
    })

    expect(() => SemanticLoop.foldSemanticSpecifications(forged)).toThrow(/quote.*authority input/)
  })

  it('rejects candidate resource dependencies that do not match its candidate kind', async () => {
    const { ctx, agent } = await setup()
    await reachFinalCandidate(ctx, agent)
    const forged = rewriteMessages(agent.session.events, message => {
      if (message.source.kind !== 'semantic-candidate') return message
      const { candidateDigest: _digest, ...core } = message.source.candidate
      const changedCore = { ...core, dependencyResourceDigests: ['f'.repeat(64)] }
      const candidate = {
        ...changedCore,
        candidateDigest: SemanticLoop.semanticCandidateDigest(changedCore),
      }
      const source: SemanticLoop.SemanticCandidateSourceV1 = { ...message.source, candidate }
      return createUserMessage({
        source,
        content: [{ type: 'text', text: SemanticLoop.renderSemanticCandidateReceipt(source) }],
      })
    })

    expect(() => SemanticLoop.foldSemanticCandidates(forged)).toThrow(/resource dependencies/)
  })

  it('rejects incompatible strict deployment options before registration', () => {
    expect(() => SemanticLoop.apply(new Context(), {
      preActionGate: 'enforce', requireCurrentTurnBegin: false, allowUnverifiedCompletion: false,
    })).toThrow(/requires requireCurrentTurnBegin true/)
    expect(() => SemanticLoop.apply(new Context(), {
      preActionGate: 'enforce', requireCurrentTurnBegin: true, allowUnverifiedCompletion: true,
    })).toThrow(/incompatible with allowUnverifiedCompletion true/)
  })

  it('classifies bounded reads separately from effectful or unknown shell calls', () => {
    const request = (command: string, toolName = 'bash'): SemanticLoop.SemanticActionDescriptionRequest => ({
      sessionId: 'classifier-test', turn: 1, callId: 'call-1', rootCallId: 'call-1',
      toolName, frozenArguments: { command }, argumentsDigest: '0'.repeat(64), signal: SIGNAL,
    })
    expect(SemanticLoop.builtinSemanticActionDescription(request('git status --short'))).toMatchObject({
      completeness: 'complete', proposal: { estimatedRisk: 'low', confidence: 'exact' },
    })
    expect(SemanticLoop.builtinSemanticActionDescription(request("sqlite3 db '.import rows.csv t'"))).toMatchObject({
      proposal: { estimatedRisk: 'high', confidence: 'conservative' },
    })
    expect(SemanticLoop.builtinSemanticActionDescription(request('node script.js'))).toMatchObject({
      completeness: 'unknown', proposal: { estimatedRisk: 'unknown', confidence: 'unknown' },
    })
    expect(SemanticLoop.builtinSemanticActionDescription(request('Get-ChildItem -Force', 'pwsh'))).toMatchObject({
      completeness: 'complete', proposal: { estimatedRisk: 'low', confidence: 'exact' },
    })
  })

  it('allows adaptive low-risk observation before begin and settles its ledger', async () => {
    const { ctx, agent } = await setup()
    ctx.tools.register(defineTool({
      name: 'read', description: 'Read one test path',
      parameters: { path: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: () => Promise.resolve({ text: 'observed' }),
    }))
    const result = await execute(ctx, agent, 'read', { path: 'README.md' })
    expect(result.isError).toBe(false)
    expect(SemanticLoop.semanticRunOf(agent)).toBeUndefined()
    expect(SemanticLoop.semanticActionLedgerOf(agent)).toMatchObject({
      health: 'safe', pendingAuthorizationDigests: [], entries: [
        { decision: 'allowed', assurance: 'runtime-checked' },
        { outcome: 'succeeded', dispatchState: 'settled' },
      ],
    })
  })

  it('rejects a settlement whose result digest does not match the durable tool result', async () => {
    const { ctx, agent } = await setup()
    ctx.tools.register(defineTool({
      name: 'read', description: 'Read one test path',
      parameters: { path: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: () => Promise.resolve({ text: 'observed' }),
    }))
    assertSuccess(await execute(ctx, agent, 'read', { path: 'README.md' }))
    const forged = rewriteMessages(agent.session.events, message => {
      if (message.source.kind !== 'semantic-action-settlement') return message
      const { receiptDigest: _digest, ...core } = message.source.receipt
      const changedCore = { ...core, resultDigest: 'f'.repeat(64) }
      const receipt = {
        ...changedCore,
        receiptDigest: SemanticLoop.semanticSettlementReceiptDigest(changedCore),
      }
      const source: SemanticLoop.SemanticActionSettlementSourceV1 = { ...message.source, receipt }
      return createUserMessage({
        source,
        content: [{ type: 'text', text: SemanticLoop.renderSemanticSettlementReceipt(source) }],
      })
    })

    expect(() => SemanticLoop.foldSemanticActionLedger(forged, agent.id)).toThrow(/result digest/)
  })

  it('rejects an authorization whose baseline digest is not owned by its turn', async () => {
    const { ctx, agent } = await setup()
    ctx.tools.register(defineTool({
      name: 'read', description: 'Read one test path',
      parameters: { path: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: () => Promise.resolve({ text: 'observed' }),
    }))
    assertSuccess(await execute(ctx, agent, 'read', { path: 'README.md' }))
    let changedAuthorizationDigest: string | undefined
    const forged = rewriteMessages(agent.session.events, message => {
      if (message.source.kind === 'semantic-authorization') {
        const { receiptDigest: _digest, ...core } = message.source.receipt
        const changedCore = { ...core, baselineDigest: 'f'.repeat(64) }
        const receipt = {
          ...changedCore,
          receiptDigest: SemanticLoop.semanticAuthorizationReceiptDigest(changedCore),
        }
        changedAuthorizationDigest = receipt.receiptDigest
        const source: SemanticLoop.SemanticAuthorizationSourceV1 = { ...message.source, receipt }
        return createUserMessage({
          source,
          content: [{ type: 'text', text: SemanticLoop.renderSemanticAuthorizationReceipt(source) }],
        })
      }
      if (message.source.kind !== 'semantic-action-settlement') return message
      if (changedAuthorizationDigest === undefined) throw new Error('missing changed authorization')
      const { receiptDigest: _digest, ...core } = message.source.receipt
      const changedCore = { ...core, authorizationReceiptDigest: changedAuthorizationDigest }
      const receipt = {
        ...changedCore,
        receiptDigest: SemanticLoop.semanticSettlementReceiptDigest(changedCore),
      }
      const source: SemanticLoop.SemanticActionSettlementSourceV1 = { ...message.source, receipt }
      return createUserMessage({
        source,
        content: [{ type: 'text', text: SemanticLoop.renderSemanticSettlementReceipt(source) }],
      })
    })

    expect(() => SemanticLoop.foldSemanticActionLedger(forged, agent.id)).toThrow(/baseline/)
  })

  it('rejects repeated settlement of one authorization receipt', async () => {
    const { ctx, agent } = await setup()
    ctx.tools.register(defineTool({
      name: 'read', description: 'Read one test path',
      parameters: { path: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: () => Promise.resolve({ text: 'observed' }),
    }))
    assertSuccess(await execute(ctx, agent, 'read', { path: 'README.md' }))
    const settlement = agent.session.events.flatMap(event => event.type === 'user/message'
      ? [event.data]
      : event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
      .find(message => message.source.kind === 'semantic-action-settlement')
    expect(settlement?.source.kind).toBe('semantic-action-settlement')
    if (settlement?.source.kind !== 'semantic-action-settlement') throw new Error('missing settlement context')
    const duplicate = createUserMessage({
      source: settlement.source,
      content: [{ type: 'text', text: SemanticLoop.renderSemanticSettlementReceipt(settlement.source) }],
    })
    const seq = (agent.session.events.at(-1)?.seq ?? 0) + 1
    const forged: SessionEvent[] = [...agent.session.events, {
      type: 'user/message', seq, time: seq, data: duplicate, surfaceOp: 'append',
    }]

    expect(() => SemanticLoop.foldSemanticActionLedger(forged, agent.id)).toThrow(/already settled/)
  })

  it('denies environment dispatch before begin in strict mode', async () => {
    const { ctx, agent } = await setup({
      preActionGate: 'enforce', unknownActionPolicy: 'deny',
      requireCurrentTurnBegin: true, allowUnverifiedCompletion: false,
    })
    let runs = 0
    ctx.tools.register(defineTool({
      name: 'read', description: 'Read one test path',
      parameters: { path: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: () => {
        runs += 1
        return Promise.resolve({ text: 'must not run' })
      },
    }))
    const result = await execute(ctx, agent, 'read', { path: 'README.md' })
    expect(result.isError).toBe(true)
    expect(runs).toBe(0)
    expect(SemanticLoop.semanticActionLedgerOf(agent).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: 'denied' }),
      expect.objectContaining({ outcome: 'not-started', dispatchState: 'not-started' }),
    ]))
  })

  it('bounds adaptive completion repair and binds degradation to exact terminal text', async () => {
    const { ctx, agent } = await setup()
    assertSuccess(await execute(ctx, agent, 'semantic_begin', {
      goal_id: 'degraded-task', goal_statement: 'Return a provisional result',
      plan_nodes: [{
        id: 'draft-answer', operation: 'draft-answer', description: 'Draft a result',
        depends_on: [], input_artifact_ids: [], output_artifact_id: 'answer',
        required_capabilities: [], required: false,
      }],
      next_action: 'Attempt ordinary completion',
    }))
    const steering: UserMessage[] = []
    agent.steer = (message: UserMessage) => {
      steering.push(message)
      return { outcome: Promise.resolve({ status: 'rejected' as const }) }
    }
    agent.session.append('assistant/message', {
      turn: 1, step: sequence,
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' },
        content: [{ type: 'text', text: 'Provisional result' }],
      }),
    }, { surfaceOp: 'append' })
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
    expect(steering).toHaveLength(1)
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
    expect(SemanticLoop.semanticDegradationOf(agent)).toMatchObject({
      turn: 1, reasonCode: 'completion-repair-exhausted',
      contentDigest: SemanticLoop.semanticCompletionContentDigest('Provisional result'),
    })
    agent.session.append('tool/call', {
      turn: 1, step: sequence + 1, callId: CallId(`late-${++sequence}`),
      name: 'semantic_state', arguments: '{}',
    })
    expect(SemanticLoop.semanticDegradationOf(agent)).toBeUndefined()
  })
})

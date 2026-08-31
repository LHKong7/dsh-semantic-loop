import { describe, expect, it } from 'vitest'
import { CallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { renderSemanticCheckpointReceipt } from '../src/state.ts'
import type { SemanticCheckpoint, SemanticVerificationReceipt } from '../src/types.ts'
import {
  builtinSemanticVerification,
  foldSemanticVerificationPosition,
  renderSemanticVerificationReceipt,
  semanticCheckpointHash,
  semanticVerificationVerdict,
} from '../src/verification.ts'

const OWNER = SessionId('verification-owner')
const checkpointCallId = CallId('checkpoint-1')
const verificationCallId = CallId('verification-1')
const capabilities = {
  reports: [{
    providerId: 'test-runtime',
    specVersion: '1',
    capabilities: [{ id: 'structured-query', description: 'Query structured data sources.' }],
  }],
  available: [{
    id: 'structured-query',
    description: 'Query structured data sources.',
    providerIds: ['test-runtime'],
  }],
} as const

const checkpoint: SemanticCheckpoint = {
  goal: { id: 'verify-answer', version: 1, statement: 'Verify the answer', constraints: [] },
  criteria: [{
    id: 'answer-ready',
    description: 'The answer is ready',
    status: 'met',
    evidence: 'The answer artifact was materialized',
    evidenceCallIds: [],
  }],
  plan: {
    revision: 1,
    changeReason: 'initial-plan',
    nodes: [{
      id: 'materialize-answer',
      operation: 'materialize-answer',
      description: 'Materialize the answer',
      dependsOn: [],
      inputArtifactIds: [],
      outputArtifactId: 'answer',
      requiredCapabilities: [],
      required: true,
    }],
  },
  activeNodeId: null,
  artifacts: [{
    id: 'answer',
    version: 1,
    kind: 'answer',
    summary: 'The answer is 42',
    locator: 'semantic://answer/1',
    contentDigest: 'answer-42',
    producerNodeId: 'materialize-answer',
    planRevision: 1,
    inputs: [],
    evidenceCallIds: [],
  }],
  facts: [],
  observedCallIds: [],
  gaps: [],
  nextAction: 'Verify and finish',
  status: 'ready',
}

function checkpointArguments(): string {
  return JSON.stringify({
    expected_revision: 0,
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
    active_node_id: null,
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
    facts: [],
    gaps: [],
    next_action: checkpoint.nextAction,
    status: 'ready',
  })
}

function receipt(): SemanticVerificationReceipt {
  const request = {
    sessionId: OWNER,
    revision: 1,
    checkpointHash: semanticCheckpointHash(checkpoint),
    checkpoint,
    evidence: [],
    capabilities,
  }
  const reports = [builtinSemanticVerification(request)]
  return {
    sessionId: OWNER,
    revision: 1,
    checkpointHash: request.checkpointHash,
    verdict: semanticVerificationVerdict(reports),
    reports,
  }
}

function events(verificationReceipt = receipt()): SessionEvent[] {
  const checkpointMessage = createUserMessage({
    source: {
      kind: 'semantic-checkpoint',
      version: 6,
      sessionId: OWNER,
      checkpointCallId,
      revision: 1,
      checkpoint,
    },
    content: [{ type: 'text', text: renderSemanticCheckpointReceipt({ revision: 1, checkpoint }) }],
  })
  const verificationMessage = createUserMessage({
    source: {
      kind: 'semantic-verification',
      version: 1,
      sessionId: OWNER,
      verificationCallId,
      receipt: verificationReceipt,
    },
    content: [{ type: 'text', text: renderSemanticVerificationReceipt(verificationReceipt) }],
  })
  return [
    { type: 'tool/call', seq: 0, time: 0, data: { turn: 1, step: 1, callId: checkpointCallId, name: 'semantic_checkpoint', arguments: checkpointArguments() } },
    { type: 'tool/result', seq: 1, time: 1, data: { turn: 1, step: 1, message: createToolResultMessage({ callId: checkpointCallId, content: [], isError: false }) }, surfaceOp: 'append' },
    { type: 'agent/inbox/spliced', seq: 2, time: 2, data: { target: 'next-step', start: 0, inserted: [checkpointMessage] } },
    { type: 'tool/call', seq: 3, time: 3, data: { turn: 1, step: 2, callId: verificationCallId, name: 'semantic_verify', arguments: '{"expected_revision":1}' } },
    { type: 'tool/result', seq: 4, time: 4, data: { turn: 1, step: 2, message: createToolResultMessage({ callId: verificationCallId, content: [], isError: false }) }, surfaceOp: 'append' },
    { type: 'agent/inbox/spliced', seq: 5, time: 5, data: { target: 'next-step', start: 0, inserted: [verificationMessage] } },
  ]
}

describe('semantic verification receipts', () => {
  it('replays a verifier-generated receipt bound to the exact checkpoint', () => {
    expect(foldSemanticVerificationPosition(events(), OWNER)).toMatchObject({
      verificationCallSeq: 3,
      receipt: { revision: 1, verdict: 'passed' },
    })
  })

  it('rejects a receipt forged for a different checkpoint digest', () => {
    expect(() => foldSemanticVerificationPosition(events({
      ...receipt(),
      checkpointHash: '0'.repeat(64),
    }), OWNER)).toThrow(/does not match the checkpoint at verification time/)
  })

  it('derives failed before unknown and ignores advisory checks', () => {
    const report = builtinSemanticVerification({
      sessionId: OWNER,
      revision: 1,
      checkpointHash: semanticCheckpointHash(checkpoint),
      checkpoint,
      evidence: [],
      capabilities,
    })
    expect(semanticVerificationVerdict([{ ...report, checks: [
      { ...report.checks[0]!, required: false, status: 'violated' },
      { ...report.checks[1]!, status: 'unknown' },
    ] }])).toBe('unknown')
    expect(semanticVerificationVerdict([{ ...report, checks: [
      { ...report.checks[0]!, status: 'unknown' },
      { ...report.checks[1]!, status: 'violated' },
    ] }])).toBe('failed')
  })
})

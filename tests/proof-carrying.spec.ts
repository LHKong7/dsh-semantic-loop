import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  EMPTY_ACTION_LEDGER_DIGEST,
  assertSemanticRequirement,
  assertSemanticSpecificationTransition,
  assertUnverifiedCompletionAllowed,
  canonicalJson,
  semanticDigest,
  semanticSpecDigest,
  type SemanticActionLedgerProjection,
  type SemanticRequirement,
  type SemanticSpecification,
} from '../src/index.ts'

const required: SemanticRequirement = {
  id: 'preserve-answer',
  statement: 'Preserve the exact answer',
  kind: 'hard-formal',
  phase: 'final-candidate',
  required: true,
  sources: [{ authority: 'user', sourceId: 'user-1', quote: 'Preserve the exact answer' }],
  dependsOn: [],
}

function specification(overrides: Partial<SemanticSpecification> = {}): SemanticSpecification {
  const sourceCoverage = [{
    sourceId: 'user-1', inputDigest: semanticDigest('authority-input', 1, 'Preserve the exact answer'),
    disposition: 'requirement' as const, requirementIds: ['preserve-answer'],
    reviewerId: 'test-policy', reviewerAuthority: 'policy' as const, status: 'covered' as const,
  }]
  return {
    id: 'proof-task', version: 1, parentDigest: null, goal: 'Prove the answer',
    inputs: ['user-1'], outputs: ['final-candidate'], assumptions: [],
    requirements: [required], forbiddenStates: [], openQuestions: [], sourceCoverage,
    changeReason: 'initial-authority-mapping',
    authorization: {
      kind: 'trusted-sources', authoritySourceIds: ['user-1'],
      coverageDigest: semanticDigest('source-coverage', 1, sourceCoverage),
    },
    ...overrides,
  }
}

describe('proof-carrying semantic primitives', () => {
  it('canonicalizes object keys and separates digest domains', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}')
    expect(semanticDigest('candidate', 1, { answer: 42 })).toBe(semanticDigest('candidate', 1, { answer: 42 }))
    expect(semanticDigest('candidate', 1, { answer: 42 })).not.toBe(semanticDigest('spec', 1, { answer: 42 }))
  })

  it('rejects an Agent-authored required obligation', () => {
    expect(() => assertSemanticRequirement({
      ...required,
      sources: [{ authority: 'agent', sourceId: 'agent-1', quote: required.statement }],
    })).toThrow(/agent-authored.*cannot be required/)
  })

  it('rejects required-obligation weakening without a confirmed amendment', () => {
    const previous = specification()
    const next = specification({
      version: 2,
      parentDigest: semanticSpecDigest(previous),
      requirements: [],
      inputs: [],
      sourceCoverage: [],
      changeReason: 'remove-required-obligation',
      authorization: {
        kind: 'trusted-sources', authoritySourceIds: [],
        coverageDigest: semanticDigest('source-coverage', 1, []),
      },
    })
    expect(() => assertSemanticSpecificationTransition(previous, next)).toThrow(/cannot remove or change required requirement/)
  })

  it('blocks unverified completion when final authority or ledger safety forbids it', () => {
    const safe: SemanticActionLedgerProjection = {
      entries: [], ledgerDigest: EMPTY_ACTION_LEDGER_DIGEST,
      health: 'safe', pendingAuthorizationDigests: [],
    }
    expect(() => assertUnverifiedCompletionAllowed(specification(), safe)).toThrow(/required final-output obligations/)
    expect(() => assertUnverifiedCompletionAllowed(undefined, {
      ...safe, health: 'needs-reconciliation',
    })).toThrow(/complete safe action ledger/)
    expect(() => assertUnverifiedCompletionAllowed(undefined, safe)).not.toThrow()
  })

  it('uses branded Session ids without changing canonical ownership', () => {
    const owner = SessionId('proof-owner')
    expect(semanticDigest('owner', 1, owner)).toBe(semanticDigest('owner', 1, 'proof-owner'))
  })
})

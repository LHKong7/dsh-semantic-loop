/** Durable projection for immutable semantic specification lineages. */

import { isDeepStrictEqual } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { BEGIN_TOOL } from './protocol.ts'
import { semanticDigest } from './canonical.ts'
import {
  assertSemanticSpecification,
  assertSemanticSpecificationTransition,
  semanticSpecDigest,
  type SemanticSpecification,
  type SemanticSpecificationSourceV1,
} from './specification.ts'

/** Latest specification plus the durable source position that committed it. */
export interface SemanticSpecificationPosition {
  readonly specification: SemanticSpecification
  readonly specDigest: string
  readonly sourceSeq: number
}

/** Compact model-visible receipt for one committed specification. */
export function renderSemanticSpecificationReceipt(source: SemanticSpecificationSourceV1): string {
  const required = [...source.specification.requirements, ...source.specification.forbiddenStates]
    .filter(requirement => requirement.required).length
  const unknownCoverage = source.specification.sourceCoverage
    .filter(coverage => coverage.status === 'unknown').length
  return `Semantic specification ${source.specification.id}@${source.specification.version} committed (${required} required obligations; ${unknownCoverage} authority inputs have unknown mapping coverage; digest ${source.specDigest}).`
}

/** Test whether a message carries v1 specification provenance. */
export function isSemanticSpecificationMessage(message: UserMessage): boolean {
  return message.source.kind === 'semantic-specification'
}

/** Visit direct and inbox occurrences of specification messages. */
export function semanticSpecificationMessages(event: SessionEvent): readonly UserMessage[] {
  if (event.type === 'user/message') return isSemanticSpecificationMessage(event.data) ? [event.data] : []
  if (event.type !== 'agent/inbox/spliced') return []
  return event.data.inserted.filter(isSemanticSpecificationMessage)
}

/** Decode and validate one untrusted durable specification source. */
export function decodeSemanticSpecificationSource(source: unknown): SemanticSpecificationSourceV1 {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new Error('semantic specification source must be an object')
  }
  const candidate = source as Partial<SemanticSpecificationSourceV1>
  if (candidate.kind !== 'semantic-specification' || candidate.version !== 1
    || typeof candidate.sessionId !== 'string' || typeof candidate.specificationCallId !== 'string'
    || typeof candidate.specDigest !== 'string' || candidate.specification === undefined
    || candidate.authoringCause?.kind !== 'tool-call'
    || candidate.authoringCause.callId !== candidate.specificationCallId) {
    throw new Error('semantic specification source fields are invalid')
  }
  assertSemanticSpecification(candidate.specification)
  const digest = semanticSpecDigest(candidate.specification)
  if (candidate.specDigest !== digest) throw new Error('semantic specification source digest does not match its specification')
  return {
    kind: 'semantic-specification',
    version: 1,
    sessionId: SessionId(candidate.sessionId),
    specificationCallId: CallId(candidate.specificationCallId),
    authoringCause: { kind: 'tool-call', callId: CallId(candidate.specificationCallId) },
    specDigest: digest,
    specification: candidate.specification,
  }
}

/** Strictly fold every owner-scoped specification lineage. */
export function foldSemanticSpecifications(
  events: readonly SessionEvent[],
): ReadonlyMap<SessionId, SemanticSpecificationPosition> {
  const calls = new Map<CallId, { readonly name: string; readonly seq: number }>()
  const successful = new Set<CallId>()
  const messages = new Map<MessageId, UserMessage>()
  const latest = new Map<SessionId, SemanticSpecificationPosition>()
  const versions = new Map<SessionId, Map<number, string>>()
  const authorityInputs = new Map<string, UserMessage>()
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, { name: event.data.name, seq: event.seq })
    if (event.type === 'tool/result' && event.data.message.content[0].isError !== true) {
      successful.add(event.data.message.content[0].toolCallId)
    }
    const userMessages = event.type === 'user/message' ? [event.data]
      : event.type === 'agent/inbox/spliced' ? event.data.inserted : []
    for (const input of userMessages) if (input.source.kind === 'user') authorityInputs.set(input.id, input)
    for (const message of semanticSpecificationMessages(event)) {
      const priorMessage = messages.get(message.id)
      if (priorMessage !== undefined) {
        if (!isDeepStrictEqual(priorMessage, message)) {
          throw new Error(`semantic specification message "${message.id}" changed after its first occurrence`)
        }
        continue
      }
      const source = decodeSemanticSpecificationSource(message.source)
      if (!isDeepStrictEqual(message.content, [{ type: 'text', text: renderSemanticSpecificationReceipt(source) }])) {
        throw new Error(`semantic specification message "${message.id}" content does not match its source`)
      }
      const call = calls.get(source.specificationCallId)
      if (call?.name !== BEGIN_TOOL || !successful.has(source.specificationCallId) || call.seq >= event.seq) {
        throw new Error(`semantic specification is not linked to an earlier successful ${BEGIN_TOOL} call/result`)
      }
      for (const coverage of source.specification.sourceCoverage) {
        const input = authorityInputs.get(coverage.sourceId)
        const expected = input === undefined ? undefined : semanticDigest('authority-input', 1, {
          source: input.source,
          content: input.content,
        })
        if (expected === undefined || coverage.inputDigest !== expected) {
          throw new Error(`semantic specification coverage for "${coverage.sourceId}" does not match its authority input`)
        }
      }
      let ownerVersions = versions.get(source.sessionId)
      if (ownerVersions === undefined) {
        ownerVersions = new Map()
        versions.set(source.sessionId, ownerVersions)
      }
      const priorDigest = ownerVersions.get(source.specification.version)
      if (priorDigest !== undefined && priorDigest !== source.specDigest) {
        throw new Error(`semantic specification version ${source.specification.version} is reused with different content`)
      }
      const prior = latest.get(source.sessionId)
      if (prior !== undefined) assertSemanticSpecificationTransition(prior.specification, source.specification)
      else if (source.specification.version !== 1) throw new Error('semantic specification lineage must start at version 1')
      messages.set(message.id, message)
      ownerVersions.set(source.specification.version, source.specDigest)
      latest.set(source.sessionId, {
        specification: source.specification,
        specDigest: source.specDigest,
        sourceSeq: event.seq,
      })
    }
  }
  return latest
}

/** Read the latest durable specification owned by one live Agent. */
export function semanticSpecificationOf(agent: Agent): SemanticSpecificationPosition | undefined {
  return foldSemanticSpecifications(agent.session.events).get(agent.id)
}

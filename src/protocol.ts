/** Shared semantic-protocol identities and Session-log projections. */

import type { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Package identity used by durable repair messages. */
export const PLUGIN = 'dsh-semantic-loop'
/** Whole-state replacement tool name. */
export const CHECKPOINT_TOOL = 'semantic_checkpoint'
/** On-demand read tool for the latest complete semantic state. */
export const STATE_TOOL = 'semantic_state'
/** Completion approval tool name. */
export const FINISH_TOOL = 'semantic_finish'

/**
 * Test whether one tool name belongs to the semantic control protocol.
 *
 * @param name Registered tool name.
 * @returns Whether the call is semantic protocol traffic.
 */
export function isSemanticToolName(name: string): boolean {
  return name === CHECKPOINT_TOOL || name === STATE_TOOL || name === FINISH_TOOL
}

/**
 * Collect successful environment-tool result ids since the latest turn start.
 *
 * @param events Durable Session events available before checkpoint execution.
 * @returns Result ids in durable completion order, excluding semantic controls.
 */
export function currentTurnObservedCallIds(events: readonly SessionEvent[]): readonly CallId[] {
  const calls = new Map<CallId, { readonly name: string; readonly turn: number }>()
  let callIds = new Set<CallId>()
  for (const event of events) {
    if (event.type === 'turn/start') {
      callIds = new Set()
      continue
    }
    if (event.type === 'tool/call') {
      calls.set(event.data.callId, { name: event.data.name, turn: event.data.turn })
      continue
    }
    if (event.type !== 'tool/result') continue
    const block = event.data.message.content[0]
    const call = calls.get(block.toolCallId)
    if (block.isError !== true && call?.turn === event.data.turn && !isSemanticToolName(call.name)) {
      callIds.add(block.toolCallId)
    }
  }
  return [...callIds]
}

/**
 * Collect every successful environment-tool result id available before a checkpoint.
 *
 * @param events Durable Session events available before checkpoint execution.
 * @returns Successful result ids in durable completion order, excluding semantic controls.
 */
export function successfulEnvironmentCallIds(events: readonly SessionEvent[]): ReadonlySet<CallId> {
  const calls = new Map<CallId, { readonly name: string; readonly turn: number }>()
  const callIds = new Set<CallId>()
  for (const event of events) {
    if (event.type === 'tool/call') {
      calls.set(event.data.callId, { name: event.data.name, turn: event.data.turn })
      continue
    }
    if (event.type !== 'tool/result') continue
    const block = event.data.message.content[0]
    const call = calls.get(block.toolCallId)
    if (block.isError !== true && call?.turn === event.data.turn && !isSemanticToolName(call.name)) {
      callIds.add(block.toolCallId)
    }
  }
  return callIds
}

/**
 * Locate the latest turn-start event available to a running tool.
 *
 * @param events Durable Session events.
 * @returns Latest turn-start sequence, or `undefined` outside a logged turn.
 */
export function latestTurnStartSeq(events: readonly SessionEvent[]): number | undefined {
  return events.findLast(event => event.type === 'turn/start')?.seq
}

/**
 * Locate the latest environment-tool result in a Session log.
 *
 * Failed results count because they are observations that may change gaps or
 * the next action. Semantic-control results are protocol traffic rather than
 * environment observations.
 *
 * @param events Durable Session events.
 * @returns Latest matching result sequence, or `undefined` before any result.
 */
export function latestEnvironmentResultSeq(events: readonly SessionEvent[]): number | undefined {
  const calls = new Map<CallId, string>()
  let latest: number | undefined
  for (const event of events) {
    if (event.type === 'tool/call') {
      calls.set(event.data.callId, event.data.name)
      continue
    }
    if (event.type !== 'tool/result') continue
    const callId = event.data.message.content[0].toolCallId
    const toolName = calls.get(callId)
    if (toolName !== undefined && !isSemanticToolName(toolName)) latest = event.seq
  }
  return latest
}

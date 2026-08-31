/** Public semantic-checkpoint values, projections, and durable message provenance. */

import type { CallId, ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Whether one explicit completion criterion remains open. */
export type SemanticCriterionStatus = 'unmet' | 'met'

/** Stable task identity and constraints that a plan must preserve. */
export interface SemanticGoal {
  /** Stable lower-kebab-case identity for this task inside the Session. */
  readonly id: string
  /** Monotonic goal generation; a different goal starts the next generation. */
  readonly version: number
  /** Concrete task statement. */
  readonly statement: string
  /** User, policy, or task constraints that every plan revision must preserve. */
  readonly constraints: readonly string[]
}

/** One domain-neutral operation in the stable global plan. */
export interface SemanticPlanNode {
  /** Stable lower-kebab-case identity within the plan. */
  readonly id: string
  /** Semantic operation name, independent of any concrete tool provider. */
  readonly operation: string
  /** Concrete contribution this operation makes to the goal. */
  readonly description: string
  /** Plan nodes that must complete before this operation is actionable. */
  readonly dependsOn: readonly string[]
  /** Semantic capabilities required to execute this operation reliably. */
  readonly requiredCapabilities: readonly string[]
}

/** Versioned directed acyclic graph that keeps global execution intent stable. */
export interface SemanticPlan {
  /** Monotonic revision within one goal generation. */
  readonly revision: number
  /** Why this graph replaced the preceding revision; `initial-plan` for revision 1. */
  readonly changeReason: string
  /** Operations in stable declaration order. */
  readonly nodes: readonly SemanticPlanNode[]
}

/** One objective-specific condition used by the completion gate. */
export interface SemanticCriterion {
  /** Stable lower-kebab-case identity within the checkpoint. */
  readonly id: string
  /** Concrete condition that the final answer must satisfy. */
  readonly description: string
  /** Current condition state. */
  readonly status: SemanticCriterionStatus
  /** Concise observation supporting `met`; empty while `unmet`. */
  readonly evidence: string
  /** Successful environment-tool results that support this criterion. */
  readonly evidenceCallIds: readonly CallId[]
}

/** One compact, externally checkable fact retained across steps. */
export interface SemanticFact {
  /** Stable lower-kebab-case identity within the checkpoint. */
  readonly id: string
  /** Fact the agent will rely on. */
  readonly statement: string
  /** Tool output, file location, query result, or other observation supporting the fact. */
  readonly evidence: string
  /** Successful environment-tool results that support this fact. */
  readonly evidenceCallIds: readonly CallId[]
}

/** One unresolved question that prevents completion. */
export interface SemanticGap {
  /** Stable lower-kebab-case identity within the checkpoint. */
  readonly id: string
  /** Missing information or verification. */
  readonly description: string
}

/** Whole semantic state; every update replaces the previous value. */
export interface SemanticCheckpoint {
  /** Stable task contract currently being solved. */
  readonly goal: SemanticGoal
  /** Explicit conditions used by the completion gate. */
  readonly criteria: readonly SemanticCriterion[]
  /** Stable global operation graph for the current goal. */
  readonly plan: SemanticPlan
  /** Plan node selected for the next action, or `null` when no node is active. */
  readonly activeNodeId: string | null
  /** Evidence-backed facts retained for later decisions. */
  readonly facts: readonly SemanticFact[]
  /** Every successful environment-tool result observed in this turn before this checkpoint. */
  readonly observedCallIds: readonly CallId[]
  /** Unresolved questions that block completion. */
  readonly gaps: readonly SemanticGap[]
  /** Next concrete action selected from the current state. */
  readonly nextAction: string
  /** Whether more observation is required or the completion gate may be attempted. */
  readonly status: 'exploring' | 'ready'
}

/** Current checkpoint plus its compare-and-set revision. */
export interface SemanticState {
  readonly revision: number
  readonly checkpoint: SemanticCheckpoint
}

/** One successful environment-tool observation cited by the latest checkpoint. */
export interface SemanticEvidence {
  /** Durable correlation identity of the environment-tool call and result. */
  readonly callId: CallId
  /** Registered environment-tool name. */
  readonly name: string
  /** Raw model-authored tool arguments. */
  readonly arguments: string
  /** Model-facing successful result content. */
  readonly content: readonly ContentBlock[]
  /** Turn that produced the observation. */
  readonly turn: number
  /** Step that produced the observation. */
  readonly step: number
}

/** One terminal semantic completion reconstructed from a Session turn. */
export interface SemanticCompletion {
  /** Turn containing the approval and matching final assistant message. */
  readonly turn: number
  /** Ready checkpoint revision approved by the terminal finish call. */
  readonly revision: number
  /** Complete approved and returned answer. */
  readonly answer: string
}

/** Log-derived counters for paired ReAct and semantic-loop evaluation. */
export interface SemanticTelemetry {
  /** Owner-scoped checkpoint revisions committed so far. */
  readonly checkpointRevisions: number
  /** Top-level calls to semantic protocol tools. */
  readonly semanticToolCalls: number
  /** Calls that materialize the complete checkpoint for resume or compaction recovery. */
  readonly stateReads: number
  /** Top-level calls to tools outside the semantic protocol. */
  readonly environmentToolCalls: number
  /** Successful top-level calls outside the semantic protocol. */
  readonly successfulEnvironmentToolCalls: number
  /** Calls to `semantic_finish`, including failed attempts. */
  readonly finishAttempts: number
  /** Successful `semantic_finish` results, including approvals later invalidated. */
  readonly acceptedFinishResults: number
  /** Stopping-boundary corrective messages committed to the model transcript. */
  readonly repairSteps: number
  /** Successful environment-tool results cited by the latest checkpoint. */
  readonly evidenceToolResults: number
  /** Successful environment-tool results observed before the latest checkpoint in its turn. */
  readonly observedToolResults: number
}

/** Durable provenance carried by the semantic-state context message. */
export interface SemanticCheckpointSource {
  readonly kind: 'semantic-checkpoint'
  readonly version: 5
  /** Session identity that owns this state stream; inherited fork records remain parent-owned. */
  readonly sessionId: SessionId
  /** Successful semantic-checkpoint call that committed this exact state. */
  readonly checkpointCallId: CallId
  readonly revision: number
  readonly checkpoint: SemanticCheckpoint
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Whole semantic-state replacement emitted by the experimental semantic loop. */
    'semantic-checkpoint': SemanticCheckpointSource
  }
}

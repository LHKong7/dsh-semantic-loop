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
  /** Stable artifact identities consumed by this operation. */
  readonly inputArtifactIds: readonly string[]
  /** Stable artifact identity materialized by this operation. */
  readonly outputArtifactId: string
  /** Semantic capabilities required to execute this operation reliably. */
  readonly requiredCapabilities: readonly string[]
  /** Whether completion requires a current output from this node. */
  readonly required: boolean
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

/** Identity of one immutable semantic-artifact version. */
export interface SemanticArtifactRef {
  /** Stable lower-kebab-case artifact identity. */
  readonly id: string
  /** Positive monotonic version within that identity. */
  readonly version: number
}

/** Compact reference to a materialized intermediate result stored outside prompt prose. */
export interface SemanticArtifact extends SemanticArtifactRef {
  /** Domain-neutral artifact kind such as `entity-records`, `source-text`, or `code-build`. */
  readonly kind: string
  /** Concise model-facing meaning, never the complete large payload. */
  readonly summary: string
  /** Opaque file, Session, tool-result, table, or provider locator for on-demand recovery. */
  readonly locator: string
  /** Stable content identity supplied by the materializer. */
  readonly contentDigest: string
  /** Plan node that produced this value, or `null` for an external source artifact. */
  readonly producerNodeId: string | null
  /** Plan revision used by the producer, or `0` for an external source artifact. */
  readonly planRevision: number
  /** Exact immutable artifact versions consumed to produce this value. */
  readonly inputs: readonly SemanticArtifactRef[]
  /** Successful environment-tool results that materialized or observed this value. */
  readonly evidenceCallIds: readonly CallId[]
}

/** Whether an artifact is still usable under the latest plan and input versions. */
export type SemanticArtifactStatus = 'current' | 'stale'

/** Domain-neutral capability that an execution provider makes available. */
export interface SemanticCapability {
  /** Stable lower-kebab-case identity referenced by plan nodes. */
  readonly id: string
  /** Concrete operation or reliability property supplied by the provider. */
  readonly description: string
}

/** Capabilities contributed by one trusted runtime provider. */
export interface SemanticCapabilityReport {
  /** Stable provider identity. */
  readonly providerId: string
  /** Version of the provider's capability declarations. */
  readonly specVersion: string
  /** Capabilities currently available to the owning Agent. */
  readonly capabilities: readonly SemanticCapability[]
}

/** One capability aggregated across providers with an identical declaration. */
export interface SemanticCapabilityAvailability extends SemanticCapability {
  /** Providers that can currently supply the capability. */
  readonly providerIds: readonly string[]
}

/** Agent-scoped capability inventory resolved at inspection or verification time. */
export interface SemanticCapabilityInventory {
  /** Validated provider reports in dispatch order. */
  readonly reports: readonly SemanticCapabilityReport[]
  /** Available capabilities in first-provider declaration order. */
  readonly available: readonly SemanticCapabilityAvailability[]
}

/** Immutable input passed to a scoped capability provider. */
export interface SemanticCapabilityRequest {
  /** Session whose execution capabilities are being resolved. */
  readonly sessionId: SessionId
}

/** Trust origin of one verifier-defined obligation. */
export type SemanticObligationIssuer = 'system' | 'task' | 'policy' | 'agent'

/** Machine-checkable requirement evaluated independently from model-authored criteria. */
export interface SemanticVerificationCheck {
  /** Stable verifier-owned check identity. */
  readonly id: string
  /** Extensible strategy name such as `runtime.lineage` or `smt.numeric-bound`. */
  readonly kind: string
  /** Human-readable requirement being checked. */
  readonly description: string
  /** Trusted source of the requirement. */
  readonly issuer: SemanticObligationIssuer
  /** Whether an unproved result prevents semantic completion. */
  readonly required: boolean
  /** Check result under the verifier's declared specification version. */
  readonly status: 'proved' | 'violated' | 'unknown'
  /** Concise result, violation, or counterexample description. */
  readonly detail: string
}

/** Output of one independently registered verification strategy. */
export interface SemanticVerificationReport {
  /** Stable provider identity. */
  readonly verifierId: string
  /** Version of the rules or formal specification used by this provider. */
  readonly specVersion: string
  /** Strength of the provider's result; never inferred from a passing verdict. */
  readonly assurance: 'evidence-backed' | 'runtime-checked' | 'formally-proved'
  /** Requirements evaluated by this provider. */
  readonly checks: readonly SemanticVerificationCheck[]
  /** Digest of a checkable proof or certificate, or `null` when none exists. */
  readonly proofDigest: string | null
}

/** Immutable input passed to every semantic verifier provider. */
export interface SemanticVerificationRequest {
  /** Session that owns the checkpoint. */
  readonly sessionId: SessionId
  /** Exact semantic-state revision. */
  readonly revision: number
  /** SHA-256 digest of the canonical checkpoint. */
  readonly checkpointHash: string
  /** Complete checkpoint being verified. */
  readonly checkpoint: SemanticCheckpoint
  /** Successful environment-tool results cited by checkpoint claims. */
  readonly evidence: readonly SemanticEvidence[]
  /** Agent-scoped execution capabilities available at verification time. */
  readonly capabilities: SemanticCapabilityInventory
}

/** Durable aggregate bound to one exact semantic checkpoint. */
export interface SemanticVerificationReceipt {
  /** Session that owns the verified checkpoint. */
  readonly sessionId: SessionId
  /** Verified semantic-state revision. */
  readonly revision: number
  /** SHA-256 digest of the verified canonical checkpoint. */
  readonly checkpointHash: string
  /** Aggregate result over every required check. */
  readonly verdict: 'passed' | 'failed' | 'unknown'
  /** Versioned provider results retained for replay and diagnosis. */
  readonly reports: readonly SemanticVerificationReport[]
}

/** Durable provenance carried by a verifier-generated receipt message. */
export interface SemanticVerificationSource {
  /** Message-source discriminant. */
  readonly kind: 'semantic-verification'
  /** Semantic-verification source format version. */
  readonly version: 1
  /** Session that owns this receipt. */
  readonly sessionId: SessionId
  /** Successful `semantic_verify` call that generated the receipt. */
  readonly verificationCallId: CallId
  /** Complete verifier-authored receipt. */
  readonly receipt: SemanticVerificationReceipt
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
  /** Append-only, versioned semantic intermediate results and their lineage. */
  readonly artifacts: readonly SemanticArtifact[]
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

/** Material task progress derived from one checkpoint transition. */
export interface SemanticProgress {
  /** Checkpoint revision being classified. */
  readonly revision: number
  /** Stable machine-readable changes that advance or revise semantic work. */
  readonly materialChanges: readonly string[]
  /** Consecutive accepted revisions with no material change, ending here. */
  readonly stagnantRevisions: number
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
  /** Failed top-level semantic-protocol results. */
  readonly semanticToolFailures: number
  /** Calls that materialize the complete checkpoint for resume or compaction recovery. */
  readonly stateReads: number
  /** Calls that inspect agent-scoped semantic capabilities. */
  readonly capabilityReads: number
  /** Top-level calls to tools outside the semantic protocol. */
  readonly environmentToolCalls: number
  /** Successful top-level calls outside the semantic protocol. */
  readonly successfulEnvironmentToolCalls: number
  /** Calls to `semantic_finish`, including failed attempts. */
  readonly finishAttempts: number
  /** Calls to `semantic_verify`, including failed provider executions. */
  readonly verificationAttempts: number
  /** Durable verifier-generated receipts, including failed and unknown verdicts. */
  readonly verificationReceipts: number
  /** Durable verification receipts whose required obligations all passed. */
  readonly passedVerifications: number
  /** Accepted checkpoint revisions that contain at least one material change. */
  readonly materialProgressRevisions: number
  /** Accepted checkpoint revisions that contain no material change. */
  readonly stagnantCheckpointRevisions: number
  /** Consecutive no-progress revisions at the latest checkpoint. */
  readonly currentStagnationStreak: number
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
  readonly version: 6
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
    /** Verifier-authored receipt bound to one exact semantic checkpoint revision and digest. */
    'semantic-verification': SemanticVerificationSource
  }
}

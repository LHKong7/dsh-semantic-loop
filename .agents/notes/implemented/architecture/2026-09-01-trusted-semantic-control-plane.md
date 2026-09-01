# Agent Note: Trusted semantic control plane

Status: implemented

English | [中文](2026-09-01-trusted-semantic-control-plane.zh.md)

## Problem

A model-authored whole checkpoint can preserve plan structure, but it cannot independently establish which user or policy statements are binding, whether an action is safe before it runs, or whether the delivered answer is exactly the value that a verifier inspected. Repeating the complete state after each observation also grows prompt traffic and turns schema compatibility failures into completion-repair loops.

## Decision

The plugin remains an extension over `@deepseek-ai/dsh-agent-loop`. Command-v2 separates an immutable Semantic Specification from a small runtime-owned run identity. `semantic_begin`, `semantic_progress`, `semantic_replan`, and `semantic_ready` apply bounded deltas; durable sources retain complete replayable projections. A turn baseline is inserted before the first model request so adaptive observation and strict begin requirements share one policy identity.

Requirement authority is explicit. Direct user, task, policy, and system sources may establish required obligations; Agent sources remain advisory. Replay checks every user quote and span against its direct authority input. Every authority input receives a coverage disposition, and an Agent cannot mark its own review complete. Specification versions form immutable digest-linked lineages. Changing or deleting an established required obligation needs a confirmed non-Agent amendment.

Every command-v2 environment call is classified from immutable tool execution identity before dispatch. Trusted action-description and authorization waterfalls may add policy information, but the runtime owns call, arguments, risk ceiling, and the monotonic merge with existing Harness permission decisions. A guard checks the exact binding immediately before dispatch. Authorization and settlement receipts form an append-only ledger. Each authorization resolves to the owning turn baseline, each settlement binds the durable tool result, and one authorization can settle only once; uncertain effectful failures require reconciliation.

Completion verifies an immutable candidate rather than accepting new answer text at the gate. Run replay requires the active specification and permits only successful environment calls as evidence. Candidate resource digests derive from the exact referenced artifact. V2 receipts bind specification, run state, candidate, and action-ledger digests and partition every required obligation into exclusive assurance or failure buckets. Providers may propose proofs and counterexamples, but formal assurance requires a checker receipt linked to its exact successful checker call. `semantic_finish` accepts only a current passing candidate digest and returns the already inspected answer.

Adaptive mode bounds protocol failures and stopping repairs. It may record an exact-content unverified completion only when no required final obligation forbids it and the action ledger is safe and settled. Strict mode requires a begin in every turn, denies unknown action safety, and has no unverified exit.

V6 checkpoint replay remains available. Hybrid mode converts the latest v6 goal constraints and criteria into advisory requirements on the first command-v2 begin. New command-v2 sessions write only the new durable sources.

## Alternatives considered

**Keep whole checkpoints as the default.** This keeps one tool simple but repeatedly sends stable state, retains required-nullable schema fields, and cannot place a reliable pre-action decision between classification and tool dispatch.

**Let the model define required obligations and proof strength.** This permits the same model to select the rules that approve its result. The model may propose mappings and certificates, while trusted providers and deterministic runtime checks own authority and final assurance.

**Treat approval or tool success as proof of safety.** Approval records user consent for a presented action and a successful result records execution outcome. Neither proves every applicable obligation or excludes side effects, so both remain separate evidence in the action ledger.

**Bundle a solver.** A generic solver without domain formalization cannot prove arbitrary coding or research tasks. The package defines provider and proof-receipt interfaces and leaves solver selection, resource limits, and independent checking to the deployment.

## Consequences

The Session log can reconstruct authority mapping, specification lineage, run deltas, action decisions and settlements, exact candidates, verification coverage, proof references, counterexamples, and verified or explicitly unverified completion. The default Semantic preset preserves low-risk exploration through adaptive policy, while Semantic Strict provides a fail-closed profile. Full source mapping, domain entailment, resource freshness, and formal proof still require trusted deployment providers.

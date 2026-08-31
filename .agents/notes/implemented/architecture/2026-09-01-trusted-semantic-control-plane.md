# Agent Note: Trusted semantic control plane

Status: implemented

English | [中文](2026-09-01-trusted-semantic-control-plane.zh.md)

## Problem

Step-local ReAct decisions do not preserve a stable dataflow, aggregation definition, or join strategy across a long task. Incorrect intermediate extraction can remain hidden while later transformations execute correctly, and additional tool calls extend an incorrect plan without repairing it. A tool catalog also encourages whatever implementation is easiest with the tools present, even when the task requires a semantic extractor, date normalizer, structured query engine, or another missing capability. Completion criteria and invariants authored by the same model cannot independently approve that model's work.

## Decision

The plugin remains an extension over `@deepseek-ai/dsh-agent-loop`; it does not replace the loop. Its model-visible tools maintain a Session-owned semantic control plane consisting of a stable goal contract, versioned Plan Graph, immutable artifact versions with lineage, evidence correlation, explicit gaps, capability requirements, material-progress classification, and verifier receipts. Checkpoints are whole-state compare-and-set replacements, while artifacts are append-only within one goal. Replay reconstructs checkpoint values from successful durable tool calls and rejects revision, provenance, lineage, and evidence inconsistencies.

The conversation model may propose claims, criteria, plan operations, artifacts, and capability requirements, but those values are untrusted assertions. Runtime, task, and policy providers own required verification checks. An agent-issued check may be advisory but cannot be required. `semantic_finish` accepts only a passing receipt bound to the owning Session, exact checkpoint revision, and SHA-256 checkpoint digest. The built-in provider reports runtime checks; only an external strategy that produces a checkable proof or certificate reports `formally-proved`.

Capability providers declare an Agent-scoped inventory through config or the `semantic/capabilities` waterfall. The built-in verifier blocks a declared plan requirement when no provider exists. This inventory does not infer requirements omitted by the model; a trusted task or policy verifier owns completeness rules for a domain. The default Semantic preset declares only capabilities supplied by its mounted tools, so DAB-specific operations remain absent until the deployment mounts and declares real providers.

Material progress is derived from goal replacement, plan revision, appended artifacts, newly met criteria, closed gaps, fact changes, and newly linked evidence. Tool-call count, raw observations, next-action edits, and active-node movement do not count. A configurable consecutive-stagnation limit stops repeated checkpoint churn that has no semantic effect. Independent verifiers still decide whether a nominal plan or fact change is useful, because a structural heuristic cannot establish semantic value.

## Alternatives considered

**Replace `agent-loop`.** A replacement would duplicate lifecycle, cancellation, tool dispatch, Session logging, and stopping behavior while preventing composition with other loop extensions. Scoped tools, prompt sections, Session events, and stopping listeners provide the required behavior without taking ownership of the driver.

**Let the model choose every invariant.** Self-selected required checks allow an incorrect plan to define an approval rule it already satisfies. Model-authored checks remain advisory; trusted runtime, task, and policy code owns blocking obligations.

**Encode a DAB-specific state schema.** Database tables, joins, extraction fields, and scoring belong to a DAB adapter and benchmark runner. The plugin retains domain-neutral goals, operations, artifacts, capabilities, evidence, and verification reports so the same protocol applies to coding, research, workflow, and data tasks.

**Treat more loop iterations as recovery.** Iteration count measures effort rather than corrected understanding. The runtime instead bounds consecutive revisions with no material semantic change and reports protocol overhead separately from environment-tool work.

## Consequences

The Session log can reconstruct the plan, artifact lineage, evidence, receipts, and terminal approval used for evaluation. Missing declared capabilities and non-passing verifier results block completion without claiming universal formal safety. The protocol adds five stable tool schemas and retains whole checkpoint call arguments until ordinary context compaction removes their token cost. Model-authored metadata, omitted capability requirements, unsupported entailment, and manufactured plan or fact churn remain explicit limitations that require independent compilers or domain verifiers.

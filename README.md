# dsh-semantic-loop

English | [中文](README.zh.md)

Community-maintained by LHKong7. This personal DeepSeek Harness Bundle is not an official DeepSeek AI package.

`dsh-semantic-loop` adds a proof-carrying semantic control plane without replacing `@deepseek-ai/dsh-agent-loop`. Version 0.3 records authority-backed specifications, incremental run state, exact action authorization and settlement, immutable candidates, verifier reports, proof references, counterexamples, and verified or explicitly unverified completion in the owning Session log.

The Bundle ships two complete agent presets:

- `semantic` uses command-v2, adaptive pre-action policy, approval for eligible unknown actions, and one bounded completion repair before an explicitly marked unverified result may be considered.
- `semantic-strict` requires `semantic_begin` in every turn before environment dispatch, closes unknown actions with denial, and never permits unverified completion.

## Installation

Install the Bundle into a profile and restart that profile:

```sh
dsh plugin --profile web add dsh-semantic-loop
dsh --profile web
```

The manifest exposes `cordis.patch.yml` through `dsh.bundle.patch` and `agent-presets/` through `dsh.bundle.agentPresets`. The host patch mounts the invariant registry and semantic invariant companion once. Semantic behavior is mounted only when a semantic preset is selected.

## Command-v2 protocol

The default protocol replaces repeated whole-state snapshots with bounded commands:

1. `semantic_begin` binds the current authority inputs to a versioned Semantic Specification and creates the initial Plan Graph.
2. `semantic_progress` appends material facts and artifact versions, updates criteria and gaps, and advances the run revision.
3. `semantic_replan` replaces only the Plan Graph and preserves immutable artifact history.
4. `semantic_ready` seals a structurally complete run. Ready has no nullable `active_node_id` field.
5. `semantic_candidate` submits the exact answer, structured output, or immutable artifact version that will be verified.
6. `semantic_verify` aggregates built-in checks and scoped verifier providers into a candidate-bound v2 receipt.
7. `semantic_finish` accepts only the digest of that exact current passing candidate and returns its already verified answer.

`semantic_state` recovers the latest specification and run snapshot after resume or compaction. `semantic_capabilities` reports the trusted Agent-scoped capability inventory and missing plan requirements. The v2 model-facing schemas do not use `oneOf` or required-nullable fields and default to an 8 KiB argument limit.

## Specification authority

Direct user, task, policy, and system sources may establish required obligations. Agent-authored requirements are advisory. Every direct authority input receives a coverage disposition; an Agent cannot mark its own review as fully covered. Missing trusted mapping coverage remains `unknown`, so strict completion fails and adaptive mode can only disclose an unverified result with the residual risk.

Specification revisions are immutable lineages. Required obligation removal or alteration needs a separately confirmed non-Agent amendment. A failed verification changes the candidate, evidence, or plan; it does not silently weaken the specification.

`protocolMode: hybrid` writes command-v2 sources and can bridge a v6 checkpoint into advisory specification requirements on the first begin. `legacy-v1` retains the 0.2 whole-checkpoint tools and readers. Public v6 replay functions remain exported so stored legacy Sessions can be inspected without writing old and new formats in the same command-v2 run.

## Pre-action policy and ledger

Every non-semantic tool call in command-v2 is classified from immutable execution identity before dispatch. The built-in classifier distinguishes typed reads, typed writes, bounded observation-only shell commands, recognized shell mutations, network operations, and unknown arbitrary execution. Critical unknown calls and fixed hard guards cannot be relaxed by a lower-priority config value.

The `semantic/describe-action` and `semantic/authorize` scoped waterfalls allow trusted providers to refine classification and evaluate active obligations. The runtime merges their decision with existing Harness permission and approval policy monotonically, binds it to the exact tool arguments with a guard, and writes an authorization plus a settlement receipt. A body that may have started but has no trustworthy result becomes `needs-reconciliation` and blocks completion.

The four gate modes are:

| Mode | Behavior |
| --- | --- |
| `off` | Records no complete semantic safety assurance; required pre-action obligations cannot be activated. |
| `observe` | Allows ordinary environment risk while retaining built-in critical and authority-backed hard guards. |
| `adaptive` | Allows exact low-risk reads, asks or denies higher uncertainty according to policy, and records actual coverage. |
| `enforce` | Requires a current-turn begin and denies unknown required or action safety. |

## Verification and completion

The v2 verifier binds `specDigest`, `runStateDigest`, `candidateDigest`, and `actionLedgerDigest`. Its exclusive required-coverage buckets satisfy:

```text
formallyProved + runtimeChecked + evidenceBacked + violated + unknown = requiredTotal
```

A provider may propose formal assurance, but the runtime downgrades `formally-proved` unless the referenced proof has a matching independent checker receipt. Counterexamples and proof references are content-addressed and bound to the exact verification subject.

Adaptive degradation is not a passing verification. After the configured protocol-failure threshold or completion-repair limit, the stopping boundary may mint an exact-content `semantic-degradation` receipt only when config allows it, no required final obligation forbids it, and the action ledger is safe and fully settled. Strict mode always reports verification failure instead.

## Configuration

```yaml
- id: semantic-loop
  name: dsh-semantic-loop
  config:
    protocolMode: command-v2
    preActionGate: adaptive
    unknownActionPolicy: ask
    requireCurrentTurnBegin: false
    formalPreflightMinRisk: high
    preflightFastPathBudgetMs: 250
    allowUnverifiedCompletion: true
    maxAdaptiveCompletionRepairs: 1
    progressUpdatePolicy: material-only
    maxProtocolFailures: 3
    maxCommandBytes: 8192
    requireToolEvidence: false
    capabilities: []
```

`maxRepairSteps`, `maxCheckpointBytes`, and `maxStagnantRevisions` remain available for `legacy-v1`. `formalPreflightMinRisk` and `preflightFastPathBudgetMs` are passed to authorization providers with an abort signal. `progressUpdatePolicy: material-only` is the production default; `every-action` is intended for diagnostics.

Load-time validation rejects strict mode without current-turn begin, strict mode with unverified completion, and strict mode with `unknownActionPolicy: observe`. Specification activation also rejects required pre-action obligations when the gate is `off`.

## Extension points

Trusted plugins can contribute through Agent-scoped Cordis waterfalls:

- `semantic/specification` supplies task, policy, or system requirements and trusted source coverage.
- `semantic/capabilities` supplies the current capability inventory.
- `semantic/describe-action` refines a tool action description without changing runtime-minted call identity.
- `semantic/authorize` evaluates pre-action obligations and policy rules.
- `semantic/verify-v2` supplies candidate-bound checks, proof references, and counterexamples.

The package root exports canonical digest helpers and strict projections for specifications, baselines, run deltas, candidates, action ledgers, v1 and v2 verification receipts, degradation receipts, and legacy v6 checkpoints. The invariant companion replays all of these source types before a candidate Session event is published.

## Limits

- No theorem prover, SMT solver, or domain compiler is bundled. Formal assurance requires a trusted provider and an independent checker receipt.
- Mapping an entire authority input remains unknown without a trusted extractor or reviewer; validating a submitted quote is not complete requirement extraction.
- The current Harness tool lifecycle exposes exact call identity and pre/post hooks but not every approval-channel identifier or backend dispatch milestone. Receipts therefore record only the lifecycle state the host can establish, and uncertain effectful failures require reconciliation.
- Resource freshness and TOCTOU safety depend on provider-supplied immutable digests or snapshots. Unknown freshness remains residual risk.
- The plugin does not add benchmark databases, answer scoring, or DAB environment adapters.

## Development

```sh
npm ci
npm run check
```

`npm run check` runs type checking, focused Vitest coverage, both ESM builds, and `publint`.

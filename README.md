# dsh-semantic-loop

English | [中文](README.zh.md)

Community-maintained by LHKong7. This is a personal DeepSeek Harness plugin and is not an official DeepSeek AI package.

Installable semantic agent loop for DeepSeek Harness. The package exports a profile Bundle, a full `Semantic mode` agent preset, the loop plugin, and its invariant companion. Installing the Bundle makes the preset discoverable without copying files into the `dsh` CLI package. The plugin keeps a bounded whole-state checkpoint in the owning Session log, preserves versioned intermediate artifacts, exposes trusted capability gaps, limits structurally stagnant revisions and failed protocol calls, runs independent verifier providers, repairs premature stopping, and accepts a final answer only after a current passing verification receipt. It composes over the existing Agent, Tool, System Prompt, Session, and Cordis event extension points; it does not modify `@deepseek-ai/dsh-agent-loop`.

This package is an experimental semantic-workflow MVP. The conversation model authors each checkpoint through a typed tool, while the plugin preserves a stable goal contract and versioned global plan across local observations. The domain-neutral plan vocabulary allows an independent observation compiler or verifier to replace model-authored claims without changing the checkpoint protocol.

## Config

The shipped Web and Headless profile templates already include this Bundle. To add it to another profile, install the package and restart that profile:

```sh
dsh plugin --profile web add -w dsh-semantic-loop
dsh --profile web
```

The package manifest exports `cordis.patch.yml` through `dsh.bundle.patch` and `agent-presets/` through `dsh.bundle.agentPresets`. The Host patch mounts the optional DSH invariant registry and this package's invariant companion once; selecting Semantic mode mounts the loop itself for that agent. Installing the Bundle therefore does not force semantic behavior onto Standard, Minimal, Code, or Cordis sessions.

```yaml
- id: semantic-loop
  name: 'dsh-semantic-loop'
  config:
    maxRepairSteps: 3
    maxCheckpointBytes: 65536
    maxStagnantRevisions: 3
    maxProtocolFailures: 5
    requireToolEvidence: false
    capabilities:
      - id: structured-query
        description: Query structured data through the deployment's database tool.

- id: semantic-loop-invariants
  name: '@deepseek-ai/dsh-invariants'

- id: semantic-loop-invariant
  name: 'dsh-semantic-loop/invariant'
```

`maxRepairSteps` is a positive safe integer. It limits consecutive stopping-boundary repairs at one unchanged checkpoint revision. A new revision resets the count. Exceeding the limit fails the turn instead of continuing an unproductive repair cycle.

`maxCheckpointBytes` defaults to 65,536. It bounds both the canonical checkpoint JSON and its UTF-8 model-visible rendering. An oversized replacement fails before it enters the durable inbox, so one model call cannot create an unbounded retained snapshot.

`maxStagnantRevisions` defaults to `3`. Initialization, goal replacement, plan revision, appended artifact versions, newly met criteria, closed gaps, added or updated facts, and newly linked evidence count as material progress. Tool calls, raw observations, `next_action` edits, and active-node movement alone do not. The plugin accepts at most the configured number of consecutive no-progress checkpoints, then requires a material update.

`maxProtocolFailures` defaults to `5`. It counts failed top-level `semantic_*` tool results in one turn, including invalid arguments and rejected checkpoint, verification, or finish attempts. Reaching the limit cancels that turn with an explicit hook reason. A successful semantic call does not erase earlier failures in the same turn; the count resets when the agent becomes idle.

`requireToolEvidence` defaults to `false`. When enabled, a ready checkpoint must explicitly cite at least one successful environment-tool result observed in the current turn. Enable it for DAB tasks that require database or other tool observations; leave it disabled for tasks such as arithmetic that need no environment call. The Bundle mounts the invariant companion beside `@deepseek-ai/dsh-invariants` to reject malformed, non-contiguous, source/content-divergent, or incorrectly correlated checkpoint streams before publication.

`capabilities` declares semantic operations that this deployment can actually supply. The shipped Semantic preset declares its shell, filesystem, code-search, background-job, and skill-discovery capabilities. A DAB composition should add `structured-query`, `semantic-entity-extraction`, or `date-normalization` only when a real provider exists. Trusted plugins can contribute dynamic declarations through the owning Agent's scoped `semantic/capabilities` waterfall instead of static config.

## Capability protocol

`semantic_capabilities` returns the trusted Agent-scoped inventory, the unique capability ids required by the latest Plan Graph, and any missing ids. Missing capabilities remain explicit execution gaps: the agent can acquire a provider, choose a supported semantic operation through a versioned replan, or request help. The built-in verifier emits one required `runtime.capability-availability` check per declared plan requirement, so a missing provider produces an `unknown` verdict and blocks completion.

Capability availability does not prove implementation quality, permission, or fitness for one task. Plan requirements are still model-authored; an omitted requirement is invisible unless a task or policy verifier independently requires it. This separation prevents the Agent from self-approving a missing provider without claiming that generic runtime discovery can infer every capability a correct plan needs.

## Semantic state

`semantic_checkpoint` replaces the complete semantic state and uses `expected_revision` for compare-and-set updates. Revision `0` creates revision `1`; every later call names the exact latest revision. The state contains a stable goal contract, explicit completion criteria, a versioned global plan graph, one active plan node, evidence-backed facts, open gaps, one next action, and an `exploring` or `ready` status. Collection ids use lower-kebab-case and remain unique within their collection.

The first goal and plan use version `1`; the first plan's `change_reason` is `initial-plan`. While a goal id is unchanged, its statement, constraints, and completion-criterion definitions remain stable. Changing the plan graph increments `plan.revision` exactly once and supplies a new concrete reason. Replacing the task requires a new goal id, the next goal version, and a fresh plan revision `1`. Plan nodes name semantic operations, dependencies, and required capabilities rather than concrete tool names. The plugin rejects missing dependencies, duplicate edges, cycles, silent goal drift, and unversioned plan replacement. A ready checkpoint has no active plan node.

Plan nodes also declare stable input and output artifact ids. `artifacts` is append-only within one goal: each immutable version retains a compact kind and summary, an opaque locator for the complete payload, a content digest, its producer plan node and revision, exact input versions, and supporting tool-result ids. An upstream replacement makes downstream artifacts stale; a plan revision conservatively makes every plan-produced artifact from an earlier revision stale. A ready checkpoint requires a current output artifact for every required plan node. A replacement goal starts without inherited artifacts.

A `met` criterion requires non-empty evidence, while an `unmet` criterion carries empty evidence. `ready` requires at least one criterion, every criterion `met`, and no gaps. Every fact also requires evidence. Each criterion and fact has `evidence_call_ids`: the model selects the successful environment-tool results that support that claim, while the plugin verifies each id against the earlier Session log. The checkpoint separately records `observedCallIds`, the complete set of successful environment results seen in the current turn. This separation prevents an unrelated successful call from becoming evidence merely because it happened before the checkpoint.

`semanticProgressOf(agent)` and `semanticProgressTimeline(states)` derive material-change labels and the current stagnation streak from canonical checkpoint history. The classification ignores loop count and raw tool traffic. `semantic_state` includes the latest progress classification for resume diagnostics, while benchmark telemetry separates material and stagnant checkpoint revisions.

The tool returns a semantic-checkpoint user message as result context. Agent Loop first commits the tool result, then inserts that message into the durable next-step inbox. Its version `6` source stores the complete canonical checkpoint, owning `SessionId`, and the `checkpointCallId` that authored it; its text is a compact commit receipt. Replay requires that id to identify an earlier successful `semantic_checkpoint` call/result, reconstructs the checkpoint from the exact durable call arguments and call-time observations, and rejects any divergence. It also de-duplicates the later `user/message` occurrence by message id, requires contiguous revisions, verifies every claim reference, and ignores inherited parent-owned state when a fork starts under a new Session id. Resume under the same id continues the revision stream. `semantic_state` renders the latest complete snapshot only when resume or compaction has hidden the original checkpoint call; routine updates should not call it.

## Verification protocol

`semantic_verify(expected_revision)` runs only against an exact latest ready checkpoint created after the latest environment result. The built-in runtime verifier records required checks for goal transitions, the plan graph, artifact lineage, evidence correlation, and every declared plan capability. Trusted plugins extend the owning agent's scoped `semantic/verify` waterfall with task, policy, executable, SMT, theorem-prover, or human-approval reports. A verifier mounted in one agent preset therefore does not affect another agent. The built-in report is added outside the provider chain and cannot be replaced.

The verifier, not the conversation model, creates a durable receipt bound to `SessionId`, checkpoint revision, and SHA-256 checkpoint digest. Every report declares its verifier id, specification version, assurance level, checks, and optional proof digest. Required `violated` checks produce `failed`; required `unknown` checks produce `unknown`; completion requires `passed`. An agent-issued check cannot be required, so the model cannot define the rule that approves itself. A new checkpoint revision or changed digest makes the receipt unusable.

## Completion protocol

`semantic_finish(expected_revision, answer)` requires a checkpoint created in the current turn and after the latest environment-tool result, including a failed result, plus the exact latest revision, `ready` status, a current passing verification receipt, and a non-empty answer. A successful execution persists provisional approval and instructs the next model step to return that answer verbatim. The stopping boundary closes the turn only when the same freshness relation still holds, no later tool call or checkpoint occurs, and the next ordinary assistant text exactly matches the approved answer. Any later activity invalidates the earlier approval, even when the answer text remains unchanged.

If the model tries to stop with ordinary assistant text before approval, `agent/turn-stopping` steers one corrective message into the same turn. An uninitialized state requests the first checkpoint; an exploring state names unmet criterion and gap ids; a ready state requests verification when its current receipt is absent or non-passing, then requests `semantic_finish` after verification passes. Later tool activity requests a fresh ready checkpoint and finish call. A missing or mismatching post-approval assistant answer receives the exact approved text as corrective context. Interim assistant text already committed before the stopping boundary remains in the transcript.

Use `semanticCompletionInTurn(agent, turn)` for benchmark answer extraction. It returns `{ turn, revision, answer }` only for a terminal approval with its exact final assistant echo; a merely successful but later invalidated `semantic_finish` result returns no completion.

## DAB comparison

A DAB comparison runs the same task, model, and environment-tool budget twice: once with Standard mode for the ReAct baseline and once with Semantic mode for the intervention arm. Set `requireToolEvidence: true` when a valid DAB answer must follow from a database/tool observation. `semanticEvidenceOf(agent)` returns only successful call/result pairs explicitly cited by the latest checkpoint's criteria, facts, or artifacts; correlation proves that the observation exists, while the verifier still decides whether it supports the claimed fact and answer.

`semanticTelemetryOf(agent)` separates protocol overhead from task work:

| Counter | Evaluation meaning |
| --- | --- |
| `semanticToolCalls`, `semanticToolFailures` | All protocol calls and the failed subset; report them separately as intervention and retry overhead. |
| `verificationAttempts`, `verificationReceipts`, `passedVerifications` | Verifier execution cost and the number of durable/pass receipts. |
| `stateReads`, `capabilityReads` | On-demand state recovery and capability inspection overhead. |
| `environmentToolCalls` | Top-level non-semantic calls; use this for equal environment-tool budgets across arms. |
| `successfulEnvironmentToolCalls` | Environment calls that produced successful results. |
| `checkpointRevisions`, `finishAttempts`, `acceptedFinishResults`, `repairSteps` | Semantic-loop protocol behavior and failure/retry cost. |
| `materialProgressRevisions`, `stagnantCheckpointRevisions`, `currentStagnationStreak` | Whether additional revisions changed semantic work instead of only extending execution. |
| `evidenceToolResults` | Successful environment results cited by the latest checkpoint. |
| `observedToolResults` | Successful environment results observed before the latest checkpoint in its turn, including results not cited by a claim. |

The paired runner still owns model-request count, input/output/cache tokens, latency, database containers, answer normalization, and ground-truth scoring. The DAB environment adapter and paired runner remain separate because those concerns are not part of the loop protocol.

## Model Experience

### Semantic policy, state, and completion

#### What the model sees

One stable system section defines the `semantic_checkpoint`, `semantic_state`, `semantic_capabilities`, `semantic_verify`, and `semantic_finish` protocol. Each accepted revision already carries the complete model-authored state once in the assistant checkpoint-call arguments and stores its canonical value in durable message provenance. The following user-role context is only a compact commit receipt. `semantic_state` returns the complete latest rendering after resume or compaction when the original call is unavailable. Capability inspection, verification, and checkpoint results add compact text; finish adds an approved-answer instruction. Corrective stopping messages appear only when the model attempts to finish outside the protocol, performs work after approval, or changes the approved answer.

##### Semantic agent loop policy

```markdown
This session uses the semantic agent loop. Maintain a concise semantic state of externally checkable commitments, not hidden chain-of-thought.

Before acting in each user turn, call semantic_checkpoint to refresh the stable goal contract, global plan graph, append-only versioned semantic artifacts, explicit completion criteria, evidence-backed facts, open gaps, active plan node, and next action. The fields goal, criteria, plan, active_node_id, artifacts, facts, gaps, next_action, and status are top-level siblings; plan contains only revision, change_reason, and nodes. Plan nodes describe only task dataflow. Never add semantic_checkpoint, semantic_state, semantic_capabilities, semantic_verify, semantic_finish, their calls, or their receipts as plan nodes, artifacts, or required capabilities: they are the control protocol, not task capabilities. Use an empty required_capabilities array when a task node needs no declared runtime capability. Goal ids and definitions remain immutable within one goal version. Completion-criterion ids and descriptions also remain stable. A changed plan graph increments plan.revision and states a new concrete change_reason; a new goal id increments goal.version and starts plan revision 1 without inherited artifacts. Keep semantic operations independent of concrete tools and declare their required capabilities, input artifact ids, and output artifact id. Call semantic_capabilities before relying on a declared capability and after runtime composition may have changed. A missing capability is a plan gap: acquire a provider, choose a supported operation, or ask for help instead of substituting an unverified regex or ad-hoc pipeline. Preserve every committed artifact version unchanged and append replacements with the next version. Derived artifacts cite exact input versions; a changed plan or newer upstream version makes dependent artifacts stale. Use locators and content digests instead of copying large payloads into summaries. Use expected_revision 0 only before the first checkpoint in the session. A new user turn does not reset the revision; otherwise use the exact current revision shown in the latest semantic receipt. After every material observation, replace the whole checkpoint. A met criterion and every retained fact require concise evidence. For each criterion, fact, or artifact supported by tools, cite the relevant successful environment-tool call ids in evidence_call_ids. The checkpoint separately records every successful environment-tool result observed in the current turn. Tool-call count, a changed next_action, or active-node movement alone is not material progress. Repeated no-progress revisions are bounded; revise the plan, append or correct an artifact, meet a criterion, close a gap, or request a missing capability. A ready checkpoint must include active_node_id: null explicitly, have at least one criterion, every criterion met, no open gaps, and a current artifact for every required task node. For a small task that needs no environment observation, the initial checkpoint may already be ready with one task node, its current answer artifact, an empty required_capabilities array, a met criterion, no gaps, and active_node_id: null. The checkpoint call already contains the complete state, so its following context is only a compact receipt. Call semantic_state only when resume or compaction has hidden the latest complete checkpoint; do not read it after every update.

Before semantic_finish succeeds, emit tool calls without accompanying ordinary assistant narration. Do not give the final answer before the completion gate. When the current-turn checkpoint is ready, call semantic_verify with its exact revision. Verification obligations come from the runtime and registered providers, not from agent-authored criteria. If any required check is violated or unknown, use its detail or counterexample to revise the plan, artifacts, or checkpoint and verify again. When and only when the exact latest ready revision has a passing receipt, call semantic_finish with that revision and the complete final answer. After that tool accepts the answer, do not call another tool; return the approved answer verbatim as the next and final ordinary assistant text.
```

#### Token effect

The fixed policy and five tool schemas appear on every request. Each revision appends the complete state once in checkpoint-call arguments plus compact result and context receipts. Capability inspection adds one compact result; a verification attempt adds a compact result and verifier-generated receipt. `maxCheckpointBytes` bounds each checkpoint, but cumulative token use still grows with checkpoint count because earlier call arguments remain in provider history. Calling `semantic_state` adds one complete tool result and should be reserved for recovery.

#### KV Cache effect

The system prefix and tool schemas remain stable while plugin generation and config remain unchanged. Checkpoint, tool-result, and repair messages append after the reusable prefix. A later checkpoint does not rewrite earlier request bytes.

## Development

The repository's `.npmrc` enables legacy peer installation because the DeepSeek Harness release-candidate packages expose their runtime composition through peer dependencies and npm 10 can fail while resolving the complete optional peer graph. The lockfile and explicit development peers make the standalone checks reproducible:

```sh
npm ci
npm run check
```

`npm run check` runs standalone typecheck, package tests, both ESM builds, and `publint`. The package's own Vitest config keeps test discovery inside this repository even when the checkout is nested under DeepSeek Harness.

## Known Limitations and Deferred Work

- **Model-authored checkpoints** — the conversation model currently performs observation-to-state compilation; there is no independent compiler model or deterministic domain compiler.
- **Model-authored artifact metadata** — artifact locators and content digests are structurally validated but are not yet minted by an independent materializer.
- **Model-authored capability requirements** — inventory checks find missing providers only for capabilities named in the plan; task and policy verifiers must catch omitted requirements or an unsuitable fallback strategy.
- **Structural progress heuristic** — the stagnation limit ignores tool-call volume, but a model can still manufacture plan or fact churn; independent verification must judge whether a reported change is useful and supported.
- **Correlation is not entailment** — the gate validates criteria, evidence presence, gap closure, and the existence of cited successful environment results, but a domain verifier must still check support and ground truth.
- **Runtime checks are not universal proofs** — the built-in receipt reports `runtime-checked`; only a provider with a checkable formal strategy should report `formally-proved`.
- **Append-only checkpoint calls** — compact receipts avoid a second complete copy, but earlier checkpoint-call arguments remain until ordinary compaction removes their token cost.
- **Exact terminal echo** — ordinary assistant text can be recorded as interim output before repair; a valid product completion must be the first ordinary assistant message after the latest finish approval and exactly repeat that answer.
- **No DAB environment adapter** — database lifecycle, SQL/Python tools, dataset loading, answer extraction, and comparative reporting remain outside this package.

# dsh-semantic-loop

English | [中文](README.zh.md)

Community-maintained by LHKong7. This is a personal DeepSeek Harness plugin and is not an official DeepSeek AI package.

Installable semantic agent loop for DeepSeek Harness. The package exports a profile Bundle, a full `Semantic mode` agent preset, the loop plugin, and its invariant companion. Installing the Bundle makes the preset discoverable without copying files into the `dsh` CLI package. The plugin keeps a bounded whole-state checkpoint in the owning Session log, inserts a compact model-visible commit receipt, exposes full state through an on-demand recovery tool, repairs premature stopping, and accepts a final answer only through a ready-state completion tool. It composes over the existing Agent, Tool, System Prompt, and Session extension points; it does not modify `@deepseek-ai/dsh-agent-loop`.

This package is an experimental semantic-scratchpad MVP. The conversation model authors each checkpoint through a typed tool. An independent observation compiler and benchmark-specific verifier can replace that authoring role later without changing the durable checkpoint vocabulary.

## Config

The shipped Web and Headless profile templates already include this Bundle. To add it to another profile, install the package and restart that profile:

```sh
dsh plugin --profile web add dsh-semantic-loop
dsh --profile web
```

The package manifest exports `cordis.patch.yml` through `dsh.bundle.patch` and `agent-presets/` through `dsh.bundle.agentPresets`. The Host patch mounts the invariant once; selecting Semantic mode mounts the loop itself for that agent. Installing the Bundle therefore does not force semantic behavior onto Standard, Minimal, Code, or Cordis sessions.

```yaml
- id: semantic-loop
  name: 'dsh-semantic-loop'
  config:
    maxRepairSteps: 3
    maxCheckpointBytes: 65536
    requireToolEvidence: false

- id: semantic-loop-invariant
  name: 'dsh-semantic-loop/invariant'
```

`maxRepairSteps` is a positive safe integer. It limits consecutive stopping-boundary repairs at one unchanged checkpoint revision. A new revision resets the count. Exceeding the limit fails the turn instead of continuing an unproductive repair cycle.

`maxCheckpointBytes` defaults to 65,536. It bounds both the canonical checkpoint JSON and its UTF-8 model-visible rendering. An oversized replacement fails before it enters the durable inbox, so one model call cannot create an unbounded retained snapshot.

`requireToolEvidence` defaults to `false`. When enabled, a ready checkpoint must explicitly cite at least one successful environment-tool result observed in the current turn. Enable it for DAB tasks that require database or other tool observations; leave it disabled for tasks such as arithmetic that need no environment call. The Bundle mounts the invariant companion beside `@deepseek-ai/dsh-invariants` to reject malformed, non-contiguous, source/content-divergent, or incorrectly correlated checkpoint streams before publication.

## Semantic state

`semantic_checkpoint` replaces the complete semantic state and uses `expected_revision` for compare-and-set updates. Revision `0` creates revision `1`; every later call names the exact latest revision. The state contains one objective, explicit completion criteria, evidence-backed facts, open gaps, one next action, and an `exploring` or `ready` status. Collection ids use lower-kebab-case and remain unique within their collection.

A `met` criterion requires non-empty evidence, while an `unmet` criterion carries empty evidence. `ready` requires at least one criterion, every criterion `met`, and no gaps. Every fact also requires evidence. Each criterion and fact has `evidence_call_ids`: the model selects the successful environment-tool results that support that claim, while the plugin verifies each id against the earlier Session log. The checkpoint separately records `observedCallIds`, the complete set of successful environment results seen in the current turn. This separation prevents an unrelated successful call from becoming evidence merely because it happened before the checkpoint.

The tool returns a semantic-checkpoint user message as result context. Agent Loop first commits the tool result, then inserts that message into the durable next-step inbox. Its version `4` source stores the complete canonical checkpoint, owning `SessionId`, and the `checkpointCallId` that authored it; its text is a compact commit receipt. Replay requires that id to identify an earlier successful `semantic_checkpoint` call/result, reconstructs the checkpoint from the exact durable call arguments and call-time observations, and rejects any divergence. It also de-duplicates the later `user/message` occurrence by message id, requires contiguous revisions, verifies every claim reference, and ignores inherited parent-owned state when a fork starts under a new Session id. Resume under the same id continues the revision stream. `semantic_state` renders the latest complete snapshot only when resume or compaction has hidden the original checkpoint call; routine updates should not call it.

## Completion protocol

`semantic_finish(expected_revision, answer)` requires a checkpoint created in the current turn and after the latest environment-tool result, including a failed result, plus the exact latest revision, `ready` status, and a non-empty answer. A successful execution persists provisional approval and instructs the next model step to return that answer verbatim. The stopping boundary closes the turn only when the same freshness relation still holds, no later tool call or checkpoint occurs, and the next ordinary assistant text exactly matches the approved answer. Any later activity invalidates the earlier approval, even when the answer text remains unchanged.

If the model tries to stop with ordinary assistant text before approval, `agent/turn-stopping` steers one corrective message into the same turn. An uninitialized state requests the first checkpoint; an exploring state names unmet criterion and gap ids; a ready state requests `semantic_finish`. Later tool activity requests a fresh ready checkpoint and finish call. A missing or mismatching post-approval assistant answer receives the exact approved text as corrective context. Interim assistant text already committed before the stopping boundary remains in the transcript.

Use `semanticCompletionInTurn(agent, turn)` for benchmark answer extraction. It returns `{ turn, revision, answer }` only for a terminal approval with its exact final assistant echo; a merely successful but later invalidated `semantic_finish` result returns no completion.

## DAB comparison

A DAB comparison runs the same task, model, and environment-tool budget twice: once with Standard mode for the ReAct baseline and once with Semantic mode for the intervention arm. Set `requireToolEvidence: true` when a valid DAB answer must follow from a database/tool observation. `semanticEvidenceOf(agent)` returns only successful call/result pairs explicitly cited by the latest checkpoint's criteria or facts; correlation proves that the observation exists, while the verifier still decides whether it supports the claimed fact and answer.

`semanticTelemetryOf(agent)` separates protocol overhead from task work:

| Counter | Evaluation meaning |
| --- | --- |
| `semanticToolCalls` | All `semantic_checkpoint`, `semantic_state`, and `semantic_finish` calls; report separately as intervention overhead. |
| `stateReads` | On-demand full-state reads; repeated reads indicate avoidable recovery overhead. |
| `environmentToolCalls` | Top-level non-semantic calls; use this for equal environment-tool budgets across arms. |
| `successfulEnvironmentToolCalls` | Environment calls that produced successful results. |
| `checkpointRevisions`, `finishAttempts`, `acceptedFinishResults`, `repairSteps` | Semantic-loop protocol behavior and failure/retry cost. |
| `evidenceToolResults` | Successful environment results cited by the latest checkpoint. |
| `observedToolResults` | Successful environment results observed before the latest checkpoint in its turn, including results not cited by a claim. |

The paired runner still owns model-request count, input/output/cache tokens, latency, database containers, answer normalization, and ground-truth scoring. The DAB environment adapter and paired runner remain separate because those concerns are not part of the loop protocol.

## Model Experience

### Semantic policy, state, and completion

#### What the model sees

One stable system section defines the `semantic_checkpoint`, `semantic_state`, and `semantic_finish` protocol. Each accepted revision already carries the complete model-authored state once in the assistant checkpoint-call arguments and stores its canonical value in durable message provenance. The following user-role context is only a compact commit receipt. `semantic_state` returns the complete latest rendering after resume or compaction when the original call is unavailable. Tool results add compact checkpoint receipts or an approved-answer instruction. Corrective stopping messages appear only when the model attempts to finish outside the protocol, performs work after approval, or changes the approved answer.

##### Semantic agent loop policy

```markdown
This session uses the semantic agent loop. Maintain a concise semantic state of externally checkable commitments, not hidden chain-of-thought.

Before acting in each user turn, call semantic_checkpoint to refresh the objective, explicit completion criteria, evidence-backed facts, open gaps, and next action. Use expected_revision 0 only before the first checkpoint in the session. A new user turn does not reset the revision; otherwise use the exact current revision shown in the latest semantic receipt. After every material observation, replace the whole checkpoint. A met criterion and every retained fact require concise evidence. For each criterion or fact supported by tools, cite the relevant successful environment-tool call ids in evidence_call_ids. The checkpoint separately records every successful environment-tool result observed in the current turn. A ready checkpoint must have at least one criterion, every criterion met, and no open gaps. The checkpoint call already contains the complete state, so its following context is only a compact receipt. Call semantic_state only when resume or compaction has hidden the latest complete checkpoint; do not read it after every update.

Before semantic_finish succeeds, emit tool calls without accompanying ordinary assistant narration. Do not give the final answer before the completion gate. When and only when the current-turn checkpoint is ready, call semantic_finish with its exact revision and the complete final answer. After that tool accepts the answer, do not call another tool; return the approved answer verbatim as the next and final ordinary assistant text.
```

#### Token effect

The fixed policy and three tool schemas appear on every request. Each revision appends the complete state once in checkpoint-call arguments plus compact result and context receipts; the previous implementation duplicated the complete state in user context. `maxCheckpointBytes` bounds each checkpoint, but cumulative token use still grows with checkpoint count because earlier call arguments remain in provider history. Calling `semantic_state` adds one complete tool result and should be reserved for recovery.

#### KV Cache effect

The system prefix and tool schemas remain stable while plugin generation and config remain unchanged. Checkpoint, tool-result, and repair messages append after the reusable prefix. A later checkpoint does not rewrite earlier request bytes.

## Known Limitations and Deferred Work

- **Model-authored checkpoints** — the conversation model currently performs observation-to-state compilation; there is no independent compiler model or deterministic domain compiler.
- **Correlation is not entailment** — the gate validates criteria, evidence presence, gap closure, and the existence of cited successful environment results, but a domain verifier must still check support and ground truth.
- **Append-only checkpoint calls** — compact receipts avoid a second complete copy, but earlier checkpoint-call arguments remain until ordinary compaction removes their token cost.
- **Exact terminal echo** — ordinary assistant text can be recorded as interim output before repair; a valid product completion must be the first ordinary assistant message after the latest finish approval and exactly repeat that answer.
- **No DAB environment adapter** — database lifecycle, SQL/Python tools, dataset loading, answer extraction, and comparative reporting remain outside this package.

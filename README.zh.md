# dsh-semantic-loop

[English](README.md) | 中文

本插件由 LHKong7 以个人项目形式维护，是 DeepSeek Harness 的社区插件，并非 DeepSeek AI 官方软件包。

DeepSeek Harness 的可安装 semantic agent loop。本包导出 profile Bundle、完整的「语义模式」agent preset、loop 插件及其 invariant companion。安装 Bundle 后即可发现该 preset，无需把文件复制到 `dsh` CLI 包中。插件在所属 Session log 中保存有界的全量状态检查点，保留带版本的中间 artifact，暴露可信 capability gap，限制结构性停滞 revision 与失败的协议调用，运行独立 verifier provider，修复过早停止，并且只在存在当前 passing verification receipt 时提交最终答案。它组合现有 Agent、Tool、System Prompt、Session 与 Cordis event 扩展点；不会修改 `@deepseek-ai/dsh-agent-loop`。

本包是实验性的 semantic-workflow MVP。conversation model 通过类型化工具编写每个检查点，插件则在局部 observation 之间保持稳定的 goal contract 与带版本的全局 plan。领域无关的 plan 词汇允许独立 observation compiler 或 verifier 替代模型编写 claim，而无需改变 checkpoint 协议。

## 配置

随附的 Web 与 Headless profile 模板已经包含此 Bundle。如需把它添加到其他 profile，请安装本包并重启该 profile：

```sh
dsh plugin --profile web add -w dsh-semantic-loop
dsh --profile web
```

包清单通过 `dsh.bundle.patch` 导出 `cordis.patch.yml`，并通过 `dsh.bundle.agentPresets` 导出 `agent-presets/`。Host patch 只挂载一次可选的 DSH invariant registry 与本包的 invariant companion；选择语义模式时才为该 agent 挂载 loop 本身。因此安装 Bundle 不会强制标准、极简、代码或 Cordis 会话使用 semantic 行为。

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

`maxRepairSteps` 是正安全整数，用于限制同一未变化检查点 revision 上连续执行的停止边界修复次数。新 revision 会重置计数。超过限制时，turn 会失败，而不会继续无进展的修复循环。

`maxCheckpointBytes` 默认为 65,536。它同时限制 canonical checkpoint JSON 与其 UTF-8 模型可见渲染。过大的替换会在进入持久 inbox 前失败，因此单次模型调用无法创建无界的保留快照。

`maxStagnantRevisions` 默认为 `3`。初始化、替换 goal、修改 plan revision、追加 artifact version、新满足 criterion、关闭 gap、增加或更新 fact，以及新关联 evidence 都算 material progress。Tool call、raw observation、修改 `next_action` 与移动 active node 本身都不算。插件最多接受配置数量的连续 no-progress checkpoint，之后必须进行 material update。

`maxProtocolFailures` 默认为 `5`。它统计一个 turn 内失败的顶层 `semantic_*` tool result，包括参数无效，以及 checkpoint、verification 或 finish 被拒绝。达到上限时，插件会用明确的 hook 原因取消当前 turn。同一 turn 内成功的 semantic call 不会清除之前的失败；Agent 回到 idle 后计数重置。

`requireToolEvidence` 默认为 `false`。启用后，ready checkpoint 必须显式引用至少一个在当前 turn 观察到的成功 environment-tool result。需要数据库或其他工具 observation 的 DAB task 应启用它；无需 environment call 的算术等任务应保持禁用。Bundle 会把 invariant companion 与 `@deepseek-ai/dsh-invariants` 一起挂载，以便在发布前拒绝格式错误、revision 不连续、source/content 不一致或 result correlation 错误的检查点流。

`capabilities` 声明当前 deployment 确实能够提供的语义操作。随附的语义模式 preset 会声明 shell、filesystem、code-search、background-job 与 skill-discovery capability。DAB composition 只应在真实 provider 存在时增加 `structured-query`、`semantic-entity-extraction` 或 `date-normalization`。可信插件也可以通过所属 Agent 的 scoped `semantic/capabilities` waterfall 动态贡献 declaration，无需使用静态 config。

## Capability 协议

`semantic_capabilities` 返回可信的 Agent-scoped inventory、最新 Plan Graph 要求的唯一 capability id，以及所有 missing id。缺失 capability 会保持为显式 execution gap：Agent 可以取得 provider、通过带版本的 replan 选择受支持的语义操作，或请求帮助。内置 verifier 会为每个已声明的 plan requirement 产生一个 required `runtime.capability-availability` check，因此 provider 缺失会得到 `unknown` verdict 并阻止 completion。

Capability availability 不会证明实现质量、权限或对特定任务的适用性。Plan requirement 仍由模型编写；除非 task 或 policy verifier 独立要求，否则被模型漏掉的 requirement 不可见。这种分离会阻止 Agent 在 provider 缺失时自我批准，但不会声称通用 runtime discovery 能推断正确 plan 所需的全部 capability。

## 语义状态

`semantic_checkpoint` 替换完整语义状态，并通过 `expected_revision` 执行 compare-and-set 更新。revision `0` 创建 revision `1`；之后每次调用都要给出最新的确切 revision。状态包含稳定的 goal contract、显式 completion criteria、带版本的全局 plan graph、一个 active plan node、有证据支持的 facts、open gaps、一个 next action，以及 `exploring` 或 `ready` status。集合 id 使用 lower-kebab-case，并且在各自集合内保持唯一。

首个 goal 与 plan 的 version 均为 `1`，首个 plan 的 `change_reason` 为 `initial-plan`。goal id 不变时，其 statement、constraints 与 completion-criterion definition 必须保持稳定。修改 plan graph 时，`plan.revision` 必须恰好递增一次，并给出新的具体原因。替换任务时，必须使用新的 goal id、下一个 goal version，并从 plan revision `1` 重新开始。Plan node 描述语义 operation、dependency 与 required capability，而不是具体 tool 名。插件会拒绝缺失 dependency、重复 edge、cycle、静默 goal drift 及未做版本变更的 plan 替换。Ready checkpoint 不得保留 active plan node。

Plan node 还会声明稳定的 input/output artifact id。一个 goal 内的 `artifacts` 只能追加：每个不可变 version 会保留精简的 kind 与 summary、用于恢复完整 payload 的不透明 locator、content digest、producer plan node 及 revision、确切 input version 和支持它的 tool-result id。上游 replacement 会让下游 artifact 变为 stale；plan revision 会保守地让较早 revision 生成的全部 plan artifact 变为 stale。Ready checkpoint 要求每个 required plan node 都有 current output artifact。替换 goal 时不继承 artifact。

`met` criterion 要求非空 evidence，`unmet` criterion 则携带空 evidence。`ready` 要求至少一个 criterion、所有 criterion 均为 `met`，且不存在 gap。每个 fact 也必须有 evidence。每个 criterion 与 fact 都有 `evidence_call_ids`：模型选择支持该 claim 的成功 environment-tool result，插件则对照更早的 Session log 验证每个 id。checkpoint 另行记录 `observedCallIds`，即当前 turn 中已经看到的全部成功 environment result。这样，无关的成功调用不会仅因发生在 checkpoint 之前就自动成为证据。

`semanticProgressOf(agent)` 与 `semanticProgressTimeline(states)` 会从 canonical checkpoint history 推导 material-change label 与当前 stagnation streak。该分类忽略 loop count 与 raw tool traffic。`semantic_state` 会包含最新 progress classification 以支持 resume 诊断，benchmark telemetry 则分别统计 material 与 stagnant checkpoint revision。

该工具把 semantic-checkpoint user message 作为 result context 返回。Agent Loop 先提交 tool result，再把该 message 插入持久的 next-step inbox。其 version `6` source 保存完整规范检查点、所属 `SessionId`，以及编写该值的 `checkpointCallId`；其文本是精简的提交回执。回放要求该 id 指向更早成功的 `semantic_checkpoint` call/result，并根据持久 call argument 与调用时 observation 重新构造 checkpoint，拒绝任何差异。回放还会按 message id 去重之后出现的 `user/message`，要求 revision 连续，验证每条 claim reference，并在 fork 以新 Session id 启动时忽略继承而来的父级状态。同一 id 的 resume 会延续 revision 流。只有当 resume 或 compaction 隐藏了原始 checkpoint call 时，才使用 `semantic_state` 渲染最新完整快照；常规更新不应调用它。

## 验证协议

`semantic_verify(expected_revision)` 只针对最新 environment result 之后创建的确切 ready checkpoint 运行。内置 runtime verifier 会记录 goal transition、plan graph、artifact lineage、evidence correlation 与每个已声明 plan capability 的 required check。可信插件可以通过 owning agent 的 scoped `semantic/verify` waterfall 添加 task、policy、executable、SMT、theorem-prover 或 human-approval report；挂载到一个 agent preset 的 verifier 不会影响另一个 agent。内置 report 在 provider chain 外加入，provider 无法替换它。

Receipt 由 verifier 而非 conversation model 创建，并持久绑定 `SessionId`、checkpoint revision 与 SHA-256 checkpoint digest。每个 report 都声明 verifier id、specification version、assurance level、check 与可选 proof digest。Required `violated` check 产生 `failed`；required `unknown` check 产生 `unknown`；completion 要求 `passed`。Agent-issued check 不能是 required，因此模型不能自行定义批准自己的规则。新的 checkpoint revision 或 digest 变化会让旧 receipt 失效。

## 完成协议

`semantic_finish(expected_revision, answer)` 要求 checkpoint 在当前 turn 内、且在最新 environment-tool result（包括失败 result）之后创建，并要求确切的最新 revision、`ready` status、当前 passing verification receipt 与非空 answer。成功执行会持久记录临时批准，并指示下一模型 step 原样返回该 answer。只有当同一新鲜度关系仍然成立、其后没有 tool call 或 checkpoint，且下一条普通 assistant text 与获批 answer 完全一致时，停止边界才会关闭 turn。任何后续活动都会使较早的批准失效，即使 answer text 没有变化。

如果模型在批准前尝试用普通 assistant text 停止，`agent/turn-stopping` 会把一条纠正消息 steer 到同一 turn。未初始化状态会请求首个检查点；exploring 状态会列出未满足 criterion 与 gap id；ready 状态在当前 receipt 缺失或未通过时会先请求 verification，verification 通过后再请求 `semantic_finish`。后续 tool 活动会要求新的 ready checkpoint 与 finish call。缺失或不匹配的批准后 assistant answer 会收到包含获批确切文本的纠正 context。停止边界之前已经提交的临时 assistant text 会保留在 transcript 中。

Benchmark answer extraction 应使用 `semanticCompletionInTurn(agent, turn)`。只有终态批准及其精确最终 assistant echo 存在时，它才返回 `{ turn, revision, answer }`；仅执行成功但后来失效的 `semantic_finish` result 不会返回 completion。

## DAB 对比

DAB 对比让同一 task、model 与 environment-tool budget 运行两次：一次使用标准模式作为 ReAct baseline；一次使用语义模式作为干预组。当有效 DAB answer 必须来自 database/tool observation 时，请设置 `requireToolEvidence: true`。`semanticEvidenceOf(agent)` 只返回最新 checkpoint 的 criterion、fact 或 artifact 显式引用的成功 call/result pair；correlation 证明 observation 存在，而 verifier 仍须判断它是否支持所声称的 fact 与 answer。

`semanticTelemetryOf(agent)` 会把协议开销与任务工作分开：

| Counter | 评测含义 |
| --- | --- |
| `semanticToolCalls`、`semanticToolFailures` | 全部协议 call 及其中失败的子集；分别报告干预开销与重试开销。 |
| `verificationAttempts`、`verificationReceipts`、`passedVerifications` | Verifier 执行成本以及 durable/pass receipt 数量。 |
| `stateReads`、`capabilityReads` | 按需 state recovery 与 capability inspection 开销。 |
| `environmentToolCalls` | 顶层非 semantic call；用于让两组保持相同 environment-tool budget。 |
| `successfulEnvironmentToolCalls` | 产生成功 result 的 environment call。 |
| `checkpointRevisions`、`finishAttempts`、`acceptedFinishResults`、`repairSteps` | Semantic-loop 协议行为与失败/重试成本。 |
| `materialProgressRevisions`、`stagnantCheckpointRevisions`、`currentStagnationStreak` | 新 revision 是否改变了语义工作，而不只是延长执行。 |
| `evidenceToolResults` | 最新 checkpoint 引用的成功 environment result。 |
| `observedToolResults` | 最新 checkpoint 在其 turn 中更早观察到的成功 environment result，包括未被 claim 引用的结果。 |

配对 runner 仍负责 model-request 数量、input/output/cache token、latency、database container、answer normalization 与 ground-truth scoring。DAB environment adapter 与配对 runner 保持独立，因为这些不属于 loop protocol。

## 模型体验

### 语义策略、状态与完成

#### 模型看到什么

一个稳定的 system section 定义 `semantic_checkpoint`、`semantic_state`、`semantic_capabilities`、`semantic_verify` 与 `semantic_finish` 协议。每个被接受的 revision 已经在 assistant checkpoint-call argument 中携带一次完整的模型编写状态，并在持久 message provenance 中保存其规范值。随后的 user-role context 只是一条精简提交回执。Resume 或 compaction 使原始 call 不可见时，`semantic_state` 才返回最新的完整渲染。Capability inspection、verification 与 checkpoint result 会添加精简文本；finish 会添加获批答案指令。只有当模型尝试在协议外完成、在批准后继续工作或改变获批答案时，才会出现纠正性停止消息。

##### Semantic agent loop policy

```markdown
This session uses the semantic agent loop. Maintain a concise semantic state of externally checkable commitments, not hidden chain-of-thought.

Before acting in each user turn, call semantic_checkpoint to refresh the stable goal contract, global plan graph, append-only versioned semantic artifacts, explicit completion criteria, evidence-backed facts, open gaps, active plan node, and next action. The fields goal, criteria, plan, active_node_id, artifacts, facts, gaps, next_action, and status are top-level siblings; plan contains only revision, change_reason, and nodes. Plan nodes describe only task dataflow. Never add semantic_checkpoint, semantic_state, semantic_capabilities, semantic_verify, semantic_finish, their calls, or their receipts as plan nodes, artifacts, or required capabilities: they are the control protocol, not task capabilities. Use an empty required_capabilities array when a task node needs no declared runtime capability. Goal ids and definitions remain immutable within one goal version. Completion-criterion ids and descriptions also remain stable. A changed plan graph increments plan.revision and states a new concrete change_reason; a new goal id increments goal.version and starts plan revision 1 without inherited artifacts. Keep semantic operations independent of concrete tools and declare their required capabilities, input artifact ids, and output artifact id. Call semantic_capabilities before relying on a declared capability and after runtime composition may have changed. A missing capability is a plan gap: acquire a provider, choose a supported operation, or ask for help instead of substituting an unverified regex or ad-hoc pipeline. Preserve every committed artifact version unchanged and append replacements with the next version. Derived artifacts cite exact input versions; a changed plan or newer upstream version makes dependent artifacts stale. Use locators and content digests instead of copying large payloads into summaries. Use expected_revision 0 only before the first checkpoint in the session. A new user turn does not reset the revision; otherwise use the exact current revision shown in the latest semantic receipt. After every material observation, replace the whole checkpoint. A met criterion and every retained fact require concise evidence. For each criterion, fact, or artifact supported by tools, cite the relevant successful environment-tool call ids in evidence_call_ids. The checkpoint separately records every successful environment-tool result observed in the current turn. Tool-call count, a changed next_action, or active-node movement alone is not material progress. Repeated no-progress revisions are bounded; revise the plan, append or correct an artifact, meet a criterion, close a gap, or request a missing capability. A ready checkpoint must include active_node_id: null explicitly, have at least one criterion, every criterion met, no open gaps, and a current artifact for every required task node. For a small task that needs no environment observation, the initial checkpoint may already be ready with one task node, its current answer artifact, an empty required_capabilities array, a met criterion, no gaps, and active_node_id: null. The checkpoint call already contains the complete state, so its following context is only a compact receipt. Call semantic_state only when resume or compaction has hidden the latest complete checkpoint; do not read it after every update.

Before semantic_finish succeeds, emit tool calls without accompanying ordinary assistant narration. Do not give the final answer before the completion gate. When the current-turn checkpoint is ready, call semantic_verify with its exact revision. Verification obligations come from the runtime and registered providers, not from agent-authored criteria. If any required check is violated or unknown, use its detail or counterexample to revise the plan, artifacts, or checkpoint and verify again. When and only when the exact latest ready revision has a passing receipt, call semantic_finish with that revision and the complete final answer. After that tool accepts the answer, do not call another tool; return the approved answer verbatim as the next and final ordinary assistant text.
```

#### Token 影响

固定 policy 与五个 tool schema 会出现在每次请求中。每个 revision 会在 checkpoint-call argument 中追加一次完整状态，再加上精简的 result 与 context 回执。Capability inspection 会增加一条精简 result；每次 verification 会增加精简 result 与 verifier-generated receipt。`maxCheckpointBytes` 会限制每个 checkpoint，但更早的 call argument 仍留在 provider history 中，因此累计 token 用量仍随 checkpoint 数量增长。调用 `semantic_state` 会再增加一条完整 tool result，所以只应用于恢复。

#### KV Cache 影响

只要插件 generation 与 config 不变，system prefix 与 tool schema 就保持稳定。检查点、tool result 与修复消息追加在可复用 prefix 之后。较新的检查点不会改写较早请求的字节。

## 开发

仓库的 `.npmrc` 会启用 legacy peer installation，因为 DeepSeek Harness release-candidate package 通过 peer dependency 暴露其 runtime composition，而 npm 10 在解析完整 optional peer graph 时可能失败。Lockfile 与显式 development peer 让独立检查可以复现：

```sh
npm ci
npm run check
```

`npm run check` 会运行独立 typecheck、package test、两个 ESM build 与 `publint`。本包自己的 Vitest config 会把 test discovery 限制在当前仓库内，即使 checkout 嵌套在 DeepSeek Harness 下也是如此。

## 已知限制与后续工作

- **模型编写检查点** — 当前由 conversation model 完成 observation-to-state compilation；尚无独立 compiler model 或确定性的领域 compiler。
- **模型编写 artifact metadata** — artifact locator 与 content digest 会接受结构验证，但尚未由独立 materializer 生成。
- **模型编写 capability requirement** — inventory check 只能为 plan 中明确命名的 capability 查找缺失 provider；task 与 policy verifier 必须发现遗漏的 requirement 或不合适的 fallback strategy。
- **结构化 progress heuristic** — stagnation limit 会忽略 tool-call volume，但模型仍可能制造 plan 或 fact churn；独立 verification 必须判断所报告的变化是否有用并得到支持。
- **Correlation 不等于 entailment** — gate 会验证 criterion、evidence 是否存在、gap 是否关闭及引用的成功 environment result 是否存在，但领域 verifier 仍须检查支持关系与 ground truth。
- **Runtime check 不是通用证明** — 内置 receipt 报告 `runtime-checked`；只有采用可检查形式化策略的 provider 才应报告 `formally-proved`。
- **Checkpoint call 仅追加增长** — 精简回执避免了第二份完整副本，但更早的 checkpoint-call argument 仍会保留，直到普通 compaction 移除其 token 成本。
- **精确终态复述** — 修复前可能已经记录普通 assistant text 作为临时输出；有效产品 completion 必须是最新 finish 批准后的第一条普通 assistant message，并且完全复述该 answer。
- **尚无 DAB environment adapter** — database lifecycle、SQL/Python tool、dataset loading、answer extraction 与 comparative reporting 均不在本包内。

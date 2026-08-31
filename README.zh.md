# dsh-semantic-loop

[English](README.md) | 中文

本插件由 LHKong7 以个人项目形式维护，是 DeepSeek Harness 的社区插件，并非 DeepSeek AI 官方软件包。

DeepSeek Harness 的可安装 semantic agent loop。本包导出 profile Bundle、完整的「语义模式」agent preset、loop 插件及其 invariant companion。安装 Bundle 后即可发现该 preset，无需把文件复制到 `dsh` CLI 包中。插件在所属 Session log 中保存有界的全量状态检查点，插入精简的模型可见提交回执，通过按需恢复工具提供完整状态，修复过早停止，并且只允许通过 ready 状态的完成工具提交最终答案。它组合现有 Agent、Tool、System Prompt 与 Session 扩展点；不会修改 `@deepseek-ai/dsh-agent-loop`。

本包是实验性的 semantic-workflow MVP。conversation model 通过类型化工具编写每个检查点，插件则在局部 observation 之间保持稳定的 goal contract 与带版本的全局 plan。后续可由独立 observation compiler 与 verifier 替代模型编写 claim 的角色，而无需改变领域无关的 plan 词汇。

## 配置

随附的 Web 与 Headless profile 模板已经包含此 Bundle。如需把它添加到其他 profile，请安装本包并重启该 profile：

```sh
dsh plugin --profile web add dsh-semantic-loop
dsh --profile web
```

包清单通过 `dsh.bundle.patch` 导出 `cordis.patch.yml`，并通过 `dsh.bundle.agentPresets` 导出 `agent-presets/`。Host patch 只挂载一次 invariant；选择语义模式时才为该 agent 挂载 loop 本身。因此安装 Bundle 不会强制标准、极简、代码或 Cordis 会话使用 semantic 行为。

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

`maxRepairSteps` 是正安全整数，用于限制同一未变化检查点 revision 上连续执行的停止边界修复次数。新 revision 会重置计数。超过限制时，turn 会失败，而不会继续无进展的修复循环。

`maxCheckpointBytes` 默认为 65,536。它同时限制 canonical checkpoint JSON 与其 UTF-8 模型可见渲染。过大的替换会在进入持久 inbox 前失败，因此单次模型调用无法创建无界的保留快照。

`requireToolEvidence` 默认为 `false`。启用后，ready checkpoint 必须显式引用至少一个在当前 turn 观察到的成功 environment-tool result。需要数据库或其他工具 observation 的 DAB task 应启用它；无需 environment call 的算术等任务应保持禁用。Bundle 会把 invariant companion 与 `@deepseek-ai/dsh-invariants` 一起挂载，以便在发布前拒绝格式错误、revision 不连续、source/content 不一致或 result correlation 错误的检查点流。

## 语义状态

`semantic_checkpoint` 替换完整语义状态，并通过 `expected_revision` 执行 compare-and-set 更新。revision `0` 创建 revision `1`；之后每次调用都要给出最新的确切 revision。状态包含稳定的 goal contract、显式 completion criteria、带版本的全局 plan graph、一个 active plan node、有证据支持的 facts、open gaps、一个 next action，以及 `exploring` 或 `ready` status。集合 id 使用 lower-kebab-case，并且在各自集合内保持唯一。

首个 goal 与 plan 的 version 均为 `1`，首个 plan 的 `change_reason` 为 `initial-plan`。goal id 不变时，其 statement、constraints 与 completion-criterion definition 必须保持稳定。修改 plan graph 时，`plan.revision` 必须恰好递增一次，并给出新的具体原因。替换任务时，必须使用新的 goal id、下一个 goal version，并从 plan revision `1` 重新开始。Plan node 描述语义 operation、dependency 与 required capability，而不是具体 tool 名。插件会拒绝缺失 dependency、重复 edge、cycle、静默 goal drift 及未做版本变更的 plan 替换。Ready checkpoint 不得保留 active plan node。

`met` criterion 要求非空 evidence，`unmet` criterion 则携带空 evidence。`ready` 要求至少一个 criterion、所有 criterion 均为 `met`，且不存在 gap。每个 fact 也必须有 evidence。每个 criterion 与 fact 都有 `evidence_call_ids`：模型选择支持该 claim 的成功 environment-tool result，插件则对照更早的 Session log 验证每个 id。checkpoint 另行记录 `observedCallIds`，即当前 turn 中已经看到的全部成功 environment result。这样，无关的成功调用不会仅因发生在 checkpoint 之前就自动成为证据。

该工具把 semantic-checkpoint user message 作为 result context 返回。Agent Loop 先提交 tool result，再把该 message 插入持久的 next-step inbox。其 version `5` source 保存完整规范检查点、所属 `SessionId`，以及编写该值的 `checkpointCallId`；其文本是精简的提交回执。回放要求该 id 指向更早成功的 `semantic_checkpoint` call/result，并根据持久 call argument 与调用时 observation 重新构造 checkpoint，拒绝任何差异。回放还会按 message id 去重之后出现的 `user/message`，要求 revision 连续，验证每条 claim reference，并在 fork 以新 Session id 启动时忽略继承而来的父级状态。同一 id 的 resume 会延续 revision 流。只有当 resume 或 compaction 隐藏了原始 checkpoint call 时，才使用 `semantic_state` 渲染最新完整快照；常规更新不应调用它。

## 完成协议

`semantic_finish(expected_revision, answer)` 要求 checkpoint 在当前 turn 内、且在最新 environment-tool result（包括失败 result）之后创建，并要求确切的最新 revision、`ready` status 与非空 answer。成功执行会持久记录临时批准，并指示下一模型 step 原样返回该 answer。只有当同一新鲜度关系仍然成立、其后没有 tool call 或 checkpoint，且下一条普通 assistant text 与获批 answer 完全一致时，停止边界才会关闭 turn。任何后续活动都会使较早的批准失效，即使 answer text 没有变化。

如果模型在批准前尝试用普通 assistant text 停止，`agent/turn-stopping` 会把一条纠正消息 steer 到同一 turn。未初始化状态会请求首个检查点；exploring 状态会列出未满足 criterion 与 gap id；ready 状态会请求 `semantic_finish`。后续 tool 活动会要求新的 ready checkpoint 与 finish call。缺失或不匹配的批准后 assistant answer 会收到包含获批确切文本的纠正 context。停止边界之前已经提交的临时 assistant text 会保留在 transcript 中。

Benchmark answer extraction 应使用 `semanticCompletionInTurn(agent, turn)`。只有终态批准及其精确最终 assistant echo 存在时，它才返回 `{ turn, revision, answer }`；仅执行成功但后来失效的 `semantic_finish` result 不会返回 completion。

## DAB 对比

DAB 对比让同一 task、model 与 environment-tool budget 运行两次：一次使用标准模式作为 ReAct baseline；一次使用语义模式作为干预组。当有效 DAB answer 必须来自 database/tool observation 时，请设置 `requireToolEvidence: true`。`semanticEvidenceOf(agent)` 只返回最新 checkpoint 的 criterion 或 fact 显式引用的成功 call/result pair；correlation 证明 observation 存在，而 verifier 仍须判断它是否支持所声称的 fact 与 answer。

`semanticTelemetryOf(agent)` 会把协议开销与任务工作分开：

| Counter | 评测含义 |
| --- | --- |
| `semanticToolCalls` | 全部 `semantic_checkpoint`、`semantic_state` 与 `semantic_finish` call；作为干预开销单独报告。 |
| `stateReads` | 按需完整状态读取；重复读取意味着可以避免的恢复开销。 |
| `environmentToolCalls` | 顶层非 semantic call；用于让两组保持相同 environment-tool budget。 |
| `successfulEnvironmentToolCalls` | 产生成功 result 的 environment call。 |
| `checkpointRevisions`、`finishAttempts`、`acceptedFinishResults`、`repairSteps` | Semantic-loop 协议行为与失败/重试成本。 |
| `evidenceToolResults` | 最新 checkpoint 引用的成功 environment result。 |
| `observedToolResults` | 最新 checkpoint 在其 turn 中更早观察到的成功 environment result，包括未被 claim 引用的结果。 |

配对 runner 仍负责 model-request 数量、input/output/cache token、latency、database container、answer normalization 与 ground-truth scoring。DAB environment adapter 与配对 runner 保持独立，因为这些不属于 loop protocol。

## 模型体验

### 语义策略、状态与完成

#### 模型看到什么

一个稳定的 system section 定义 `semantic_checkpoint`、`semantic_state` 与 `semantic_finish` 协议。每个被接受的 revision 已经在 assistant checkpoint-call argument 中携带一次完整的模型编写状态，并在持久 message provenance 中保存其规范值。随后的 user-role context 只是一条精简提交回执。Resume 或 compaction 使原始 call 不可见时，`semantic_state` 才返回最新的完整渲染。Tool result 会添加精简的检查点回执或获批答案指令。只有当模型尝试在协议外完成、在批准后继续工作或改变获批答案时，才会出现纠正性停止消息。

##### Semantic agent loop policy

```markdown
This session uses the semantic agent loop. Maintain a concise semantic state of externally checkable commitments, not hidden chain-of-thought.

Before acting in each user turn, call semantic_checkpoint to refresh the objective, explicit completion criteria, evidence-backed facts, open gaps, and next action. Use expected_revision 0 only before the first checkpoint in the session. A new user turn does not reset the revision; otherwise use the exact current revision shown in the latest semantic receipt. After every material observation, replace the whole checkpoint. A met criterion and every retained fact require concise evidence. For each criterion or fact supported by tools, cite the relevant successful environment-tool call ids in evidence_call_ids. The checkpoint separately records every successful environment-tool result observed in the current turn. A ready checkpoint must have at least one criterion, every criterion met, and no open gaps. The checkpoint call already contains the complete state, so its following context is only a compact receipt. Call semantic_state only when resume or compaction has hidden the latest complete checkpoint; do not read it after every update.

Before semantic_finish succeeds, emit tool calls without accompanying ordinary assistant narration. Do not give the final answer before the completion gate. When and only when the current-turn checkpoint is ready, call semantic_finish with its exact revision and the complete final answer. After that tool accepts the answer, do not call another tool; return the approved answer verbatim as the next and final ordinary assistant text.
```

#### Token 影响

固定 policy 与三个 tool schema 会出现在每次请求中。每个 revision 会在 checkpoint-call argument 中追加一次完整状态，再加上精简的 result 与 context 回执；此前的实现会在 user context 中重复完整状态。`maxCheckpointBytes` 会限制每个 checkpoint，但更早的 call argument 仍留在 provider history 中，因此累计 token 用量仍随 checkpoint 数量增长。调用 `semantic_state` 会再增加一条完整 tool result，所以只应用于恢复。

#### KV Cache 影响

只要插件 generation 与 config 不变，system prefix 与 tool schema 就保持稳定。检查点、tool result 与修复消息追加在可复用 prefix 之后。较新的检查点不会改写较早请求的字节。

## 已知限制与后续工作

- **模型编写检查点** — 当前由 conversation model 完成 observation-to-state compilation；尚无独立 compiler model 或确定性的领域 compiler。
- **Correlation 不等于 entailment** — gate 会验证 criterion、evidence 是否存在、gap 是否关闭及引用的成功 environment result 是否存在，但领域 verifier 仍须检查支持关系与 ground truth。
- **Checkpoint call 仅追加增长** — 精简回执避免了第二份完整副本，但更早的 checkpoint-call argument 仍会保留，直到普通 compaction 移除其 token 成本。
- **精确终态复述** — 修复前可能已经记录普通 assistant text 作为临时输出；有效产品 completion 必须是最新 finish 批准后的第一条普通 assistant message，并且完全复述该 answer。
- **尚无 DAB environment adapter** — database lifecycle、SQL/Python tool、dataset loading、answer extraction 与 comparative reporting 均不在本包内。

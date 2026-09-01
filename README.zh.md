# dsh-semantic-loop

[English](README.md) | 中文

由 LHKong7 社区维护。这是个人 DeepSeek Harness Bundle，不是 DeepSeek AI 官方软件包。

`dsh-semantic-loop` 在不替换 `@deepseek-ai/dsh-agent-loop` 的前提下增加 proof-carrying semantic control plane。0.3 版会在所属 Session log 中记录具有 authority 来源的 specification、增量 run state、精确 action authorization 与 settlement、不可变 candidate、verifier report、proof reference、counterexample，以及 verified 或明确标记为 unverified 的 completion。

Bundle 提供两个完整 Agent preset：

- `semantic` 使用 command-v2、自适应执行前 policy、对符合条件的 unknown action 请求 approval，并在一次有界 completion repair 后允许考虑明确标记的 unverified result。
- `semantic-strict` 要求每轮必须先执行 `semantic_begin` 才能派发 environment tool，对 unknown action 关闭失败，并且绝不允许 unverified completion。

## 安装

把 Bundle 安装到 profile 后重启该 profile：

```sh
dsh plugin --profile web add dsh-semantic-loop
dsh --profile web
```

Manifest 通过 `dsh.bundle.patch` 暴露 `cordis.patch.yml`，通过 `dsh.bundle.agentPresets` 暴露 `agent-presets/`。Host patch 只挂载一次 invariant registry 与 semantic invariant companion。只有选择 semantic preset 时才会挂载 semantic behavior。

## Command-v2 协议

默认协议使用有界 command 取代重复的 whole-state snapshot：

1. `semantic_begin` 把当前 authority input 绑定到带版本的 Semantic Specification，并创建初始 Plan Graph。
2. `semantic_progress` 追加 material fact 与 artifact version，更新 criterion 和 gap，并推进 run revision。
3. `semantic_replan` 只替换 Plan Graph，同时保留不可变 artifact history。
4. `semantic_ready` 封存结构完整的 run。Ready schema 不含 nullable `active_node_id` 字段。
5. `semantic_candidate` 提交将被验证的确切 answer、structured output 或 immutable artifact version。
6. `semantic_verify` 把内置 check 与 scoped verifier provider 聚合成绑定 candidate 的 v2 receipt。
7. `semantic_finish` 只接受当前 passing candidate 的 digest，并返回已经验证过的 answer。

`semantic_state` 在 resume 或 compaction 后恢复最新 specification 与 run snapshot。`semantic_capabilities` 报告可信 Agent-scoped capability inventory 和 plan 缺失项。V2 model-facing schema 不使用 `oneOf` 或 required-nullable 字段，默认参数硬上限为 8 KiB。

## Specification authority

Direct user、task、policy 和 system source 可以建立 required obligation。Agent-authored requirement 只能是 advisory。每个 direct authority input 都有 coverage disposition；Agent 不能把自己的 review 标记为 fully covered。缺失 trusted mapping coverage 时状态保持 `unknown`，因此 strict completion 失败，而 adaptive mode 只能在报告 residual risk 的情况下交付 unverified result。

Specification revision 形成 immutable lineage。删除或修改 required obligation 需要单独确认的非 Agent amendment。Verification 失败时应修改 candidate、evidence 或 plan，不能静默削弱 specification。

`protocolMode: hybrid` 写入 command-v2 source，并在第一次 begin 时把 v6 checkpoint bridge 成 advisory specification requirement。`legacy-v1` 保留 0.2 的 whole-checkpoint tool 与 reader。公共 v6 replay function 继续导出，因此可以检查旧 Session，而不会在同一个 command-v2 run 中混写新旧格式。

## 执行前 policy 与 ledger

Command-v2 会在派发前根据 immutable execution identity 对每个非 semantic tool call 进行分类。内置 classifier 区分 typed read、typed write、有界 observation-only shell command、已识别 shell mutation、network operation 与 unknown arbitrary execution。Critical unknown call 与固定 hard guard 不能被较低优先级 config 放宽。

`semantic/describe-action` 与 `semantic/authorize` scoped waterfall 允许可信 provider 细化分类并评估 active obligation。Runtime 将其 decision 与 Harness 既有 permission/approval policy 单调合并，通过 guard 绑定确切 tool argument，并写入 authorization 和 settlement receipt。可能已经启动但缺少可信 result 的 tool body 会进入 `needs-reconciliation`，并阻止 completion。

四种 gate mode 为：

| Mode | Behavior |
| --- | --- |
| `off` | 不记录完整 semantic safety assurance；不能激活 required pre-action obligation。 |
| `observe` | 放行普通 environment risk，同时保留内置 critical guard 与具有 authority 的 hard guard。 |
| `adaptive` | 放行精确低风险 read，根据 policy 对更高不确定性 ask 或 deny，并记录实际 coverage。 |
| `enforce` | 要求 current-turn begin，并拒绝 unknown required safety 或 action safety。 |

## Verification 与 completion

V2 verifier 同时绑定 `specDigest`、`runStateDigest`、`candidateDigest` 与 `actionLedgerDigest`。互斥的 required coverage bucket 满足：

```text
formallyProved + runtimeChecked + evidenceBacked + violated + unknown = requiredTotal
```

Provider 可以提出 formal assurance，但如果对应 proof 没有匹配的 independent checker receipt，runtime 会降低 `formally-proved`。Counterexample 与 proof reference 都采用 content address，并绑定到确切 verification subject。

Adaptive degradation 不是 passing verification。达到 protocol failure threshold 或 completion repair limit 后，只有在 config 允许、不存在禁止降级的 required final obligation、且 action ledger 安全并完全结算时，stopping boundary 才能生成绑定 exact content 的 `semantic-degradation` receipt。Strict mode 始终明确报告 verification failure。

## 配置

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

`maxRepairSteps`、`maxCheckpointBytes` 和 `maxStagnantRevisions` 继续供 `legacy-v1` 使用。Runtime 会把 `formalPreflightMinRisk`、`preflightFastPathBudgetMs` 与 abort signal 传给 authorization provider。生产默认值是 `progressUpdatePolicy: material-only`；`every-action` 只用于诊断。

Load-time validation 会拒绝未要求 current-turn begin 的 strict mode、允许 unverified completion 的 strict mode，以及使用 `unknownActionPolicy: observe` 的 strict mode。当 gate 为 `off` 时，specification activation 也会拒绝 required pre-action obligation。

## Extension point

可信插件可以通过 Agent-scoped Cordis waterfall 贡献能力：

- `semantic/specification` 提供 task、policy 或 system requirement 与 trusted source coverage。
- `semantic/capabilities` 提供当前 capability inventory。
- `semantic/describe-action` 在不改变 runtime-minted call identity 的前提下细化 tool action description。
- `semantic/authorize` 评估 pre-action obligation 与 policy rule。
- `semantic/verify-v2` 提供绑定 candidate 的 check、proof reference 与 counterexample。

Package root 导出 canonical digest helper，以及 specification、baseline、run delta、candidate、action ledger、v1/v2 verification receipt、degradation receipt 与 legacy v6 checkpoint 的严格 projection。Invariant companion 会在 candidate Session event 发布前回放所有这些 source type。

## 限制

- 本包不内置 theorem prover、SMT solver 或 domain compiler。Formal assurance 需要可信 provider 与 independent checker receipt。
- 如果没有 trusted extractor 或 reviewer，整个 authority input 的 mapping 保持 unknown；验证已提交 quote 不等于完整 requirement extraction。
- 当前 Harness tool lifecycle 会暴露 exact call identity 与 pre/post hook，但不会暴露每个 approval-channel identifier 或 backend dispatch milestone。Receipt 只记录 host 能够确定的 lifecycle state，而不确定的 effectful failure 必须 reconciliation。
- Resource freshness 与 TOCTOU safety 依赖 provider 提供的 immutable digest 或 snapshot。未知 freshness 会保留为 residual risk。
- 插件不提供 benchmark database、answer scoring 或 DAB environment adapter。

## 开发

```sh
npm ci
npm run check
```

`npm run check` 会执行 typecheck、focused Vitest coverage、两个 ESM build 与 `publint`。

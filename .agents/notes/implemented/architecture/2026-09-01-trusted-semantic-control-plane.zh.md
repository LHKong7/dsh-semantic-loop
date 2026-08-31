# Agent Note: 可信 semantic control plane

Status: implemented

[English](2026-09-01-trusted-semantic-control-plane.md) | 中文

## 问题

Step-local ReAct decision 无法在长任务中保持稳定的 dataflow、aggregation definition 或 join strategy。错误的中间 extraction 可能在后续 transformation 正确执行时仍被隐藏，而更多 tool call 只会延长错误 plan，并不会修复它。Tool catalog 还会诱导 Agent 选择现有工具最容易实现的方案，即使任务实际需要 semantic extractor、date normalizer、structured query engine 或其他缺失 capability。由同一模型编写的 completion criterion 与 invariant 不能独立批准该模型自己的工作。

## 决策

插件继续作为 `@deepseek-ai/dsh-agent-loop` 之上的 extension，不替换 loop。其 model-visible tool 会维护一个属于 Session 的 semantic control plane，其中包含稳定 goal contract、带版本的 Plan Graph、具有 lineage 的不可变 artifact version、evidence correlation、显式 gap、capability requirement、material-progress classification 与 verifier receipt。Checkpoint 是 whole-state compare-and-set replacement，而一个 goal 内的 artifact 只能追加。Replay 会根据成功的持久 tool call 重建 checkpoint value，并拒绝 revision、provenance、lineage 与 evidence 不一致。

Conversation model 可以提出 claim、criterion、plan operation、artifact 与 capability requirement，但这些值都是不可信 assertion。Runtime、task 与 policy provider 拥有 required verification check。Agent-issued check 可以是 advisory，但不能是 required。`semantic_finish` 只接受与所属 Session、确切 checkpoint revision 及 SHA-256 checkpoint digest 绑定的 passing receipt。内置 provider 报告 runtime check；只有能生成可检查 proof 或 certificate 的外部 strategy 才报告 `formally-proved`。

Capability provider 通过 config 或 `semantic/capabilities` waterfall 声明 Agent-scoped inventory。当已声明的 plan requirement 没有 provider 时，内置 verifier 会阻止 completion。该 inventory 不会推断模型漏写的 requirement；特定领域的 completeness rule 由可信 task 或 policy verifier 负责。默认语义模式 preset 只声明其挂载工具实际提供的 capability，因此 deployment 在挂载并声明真实 provider 前不会出现 DAB-specific operation。

Material progress 根据 goal replacement、plan revision、追加 artifact、新满足 criterion、关闭 gap、fact change 与新关联 evidence 推导。Tool-call count、raw observation、next-action edit 与 active-node movement 都不计入。可配置的连续 stagnation limit 会阻止没有语义效果的重复 checkpoint churn。独立 verifier 仍须判断名义上的 plan 或 fact change 是否有用，因为结构 heuristic 无法证明 semantic value。

## 考虑过的替代方案

**替换 `agent-loop`。** Replacement 会重复 lifecycle、cancellation、tool dispatch、Session logging 与 stopping behavior，并且无法与其他 loop extension 组合。Scoped tool、prompt section、Session event 与 stopping listener 可以实现所需 behavior，而无需取得 driver ownership。

**让模型选择全部 invariant。** Self-selected required check 允许错误 plan 定义一条自己已经满足的 approval rule。Model-authored check 保持 advisory；blocking obligation 由可信 runtime、task 与 policy code 负责。

**编码 DAB-specific state schema。** Database table、join、extraction field 与 scoring 属于 DAB adapter 和 benchmark runner。插件保留领域无关的 goal、operation、artifact、capability、evidence 与 verification report，因此同一协议可以用于 coding、research、workflow 与 data task。

**把更多 loop iteration 视为 recovery。** Iteration count 衡量 effort，而不是 understanding 是否得到纠正。Runtime 会限制没有 material semantic change 的连续 revision，并把 protocol overhead 与 environment-tool work 分开报告。

## 后果

Session log 可以重建评测所使用的 plan、artifact lineage、evidence、receipt 与 terminal approval。缺失的已声明 capability 和未通过的 verifier result 会阻止 completion，但不会被宣称为 universal formal safety。协议增加五个稳定 tool schema，并保留完整 checkpoint call argument，直到普通 context compaction 移除其 token cost。模型编写的 metadata、遗漏的 capability requirement、不受支持的 entailment，以及人为制造的 plan 或 fact churn 都仍是显式限制，需要独立 compiler 或 domain verifier 处理。

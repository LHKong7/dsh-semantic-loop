# Agent Note: 可信 semantic control plane

Status: implemented

[English](2026-09-01-trusted-semantic-control-plane.md) | 中文

## 问题

Model-authored whole checkpoint 可以保留 plan structure，但无法独立确定哪些 user 或 policy statement 具有约束力、action 在运行前是否安全，以及最终交付的 answer 是否就是 verifier 检查过的确切值。每次 observation 后重复完整 state 还会增加 prompt traffic，并把 schema compatibility failure 转化为 completion-repair loop。

## 决策

插件继续作为 `@deepseek-ai/dsh-agent-loop` 之上的 extension。Command-v2 将 immutable Semantic Specification 与精简的 runtime-owned run identity 分离。`semantic_begin`、`semantic_progress`、`semantic_replan` 和 `semantic_ready` 应用有界 delta；durable source 保留完整且可回放的 projection。首次 model request 前会插入 turn baseline，使 adaptive observation 与 strict begin requirement 共享同一个 policy identity。

Requirement authority 是显式的。Direct user、task、policy 与 system source 可以建立 required obligation；Agent source 只能是 advisory。每个 authority input 都有 coverage disposition，且 Agent 不能把自己的 review 标记为 complete。Specification version 形成 immutable digest-linked lineage。修改或删除已经建立的 required obligation 需要确认过的非 Agent amendment。

每个 command-v2 environment call 都会在派发前根据 immutable tool execution identity 分类。可信 action-description 与 authorization waterfall 可以增加 policy information，但 call、argument、risk ceiling，以及与 Harness 既有 permission decision 的单调合并都由 runtime 拥有。Guard 会在派发前立即检查 exact binding。Authorization 与 settlement receipt 形成 append-only ledger；不确定的 effectful failure 必须 reconciliation。

Completion 验证 immutable candidate，而不是在 gate 接受新的 answer text。V2 receipt 会绑定 specification、run state、candidate 与 action-ledger digest，并把每个 required obligation 划入互斥的 assurance 或 failure bucket。Provider 可以提出 proof 和 counterexample，但 formal assurance 需要匹配的 checker receipt。`semantic_finish` 只接受当前 passing candidate digest，并返回已经检查过的 answer。

Adaptive mode 会限制 protocol failure 与 stopping repair。只有不存在禁止降级的 required final obligation，且 action ledger 安全并完全结算时，它才可以记录绑定 exact content 的 unverified completion。Strict mode 要求每轮 begin、拒绝 unknown action safety，并且没有 unverified exit。

V6 checkpoint replay 继续可用。Hybrid mode 会在第一次 command-v2 begin 时把最新 v6 goal constraint 与 criterion 转换成 advisory requirement。新的 command-v2 Session 只写入新 durable source。

## 考虑过的替代方案

**继续默认使用 whole checkpoint。** 这种方式保留了单一简单 tool，但会重复发送稳定 state、保留 required-nullable schema field，而且无法在 classification 与 tool dispatch 之间放置可靠的 pre-action decision。

**让模型定义 required obligation 与 proof strength。** 这允许同一个模型选择批准自己结果的规则。模型可以提出 mapping 与 certificate，而 authority 与 final assurance 由可信 provider 和 deterministic runtime check 拥有。

**把 approval 或 tool success 当作 safety proof。** Approval 记录用户对所展示 action 的 consent，successful result 记录 execution outcome。两者都不能证明全部 applicable obligation 或排除 side effect，因此在 action ledger 中保持为不同 evidence。

**内置 solver。** 缺少 domain formalization 的通用 solver 无法证明任意 coding 或 research task。本包定义 provider 与 proof-receipt interface，而 solver 选择、resource limit 与 independent checking 由 deployment 负责。

## 后果

Session log 可以重建 authority mapping、specification lineage、run delta、action decision 与 settlement、exact candidate、verification coverage、proof reference、counterexample，以及 verified 或明确标记为 unverified 的 completion。默认语义模式通过 adaptive policy 保留低风险 exploration，而严格语义模式提供 fail-closed profile。完整 source mapping、domain entailment、resource freshness 与 formal proof 仍需要可信 deployment provider。

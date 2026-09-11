# ADR 0010 — Controlled Change Management & Deterministic Replanning

日期：2026-09-12
状态：已接受（v0.9 施工基线）

## 背景

v0.8 已经建立完整的确定性施工链路：

```
Task Graph
↓
Executor Plan
↓
Review Plan
↓
Frozen Run（Execution Package）
↓
Execution
↓
Verification
↓
Independent Review
↓
Owner Acceptance
↓
Handoff
```

但 v0.8 的 `Retry` 与 `Rework` 都建立在一个未言明的前提上：

> 原计划仍然有效。

当实现写错时，可以 Rework；但当下列任一情况发生时，问题不在实现层，而在计划层：

- Requirement 改变
- Design / Architecture 决策改变
- Execution Manual 改变
- Task 被新增 / 删除
- Task dependency 改变
- Task scope 改变
- Verification contract 改变
- Executor assignment 需要改变
- Review policy 改变

这些都不是 Rework，而是 **Change**。v0.8 无法表达 Change：一旦 Run 产生 frozen Evidence，原地重编译 Task Graph / Executor Plan / Review Plan 就会篡改历史 Evidence，使审计链断裂。

v0.9 的核心问题：

> **已经冻结并开始执行的计划，因为 Owner 决策、现实条件、需求、设计或施工方案发生变化时，SpecCraft 应如何在不篡改历史 Evidence 的前提下，受控地产生新计划并继续施工。**

核心原则：

> Plans may change. History must not.
> 方案可以变，历史不能被改写。

## 决策

v0.9 首次把 Change 建模为独立领域对象 **Change Set**，并规定：计划层的任何变化都必须经过

```
Change Set
→ Deterministic Impact Analysis
→ Owner Approval
→ Successor Run
```

不允许伪装成 Retry / Rework。

### 1. Retry / Rework / Change 三者严格分离

| 概念 | 目标 | Task intent | 计划 | 结果 |
| --- | --- | --- | --- | --- |
| Retry | 不变 | 不变 | 不变 | same Run / same Task / same frozen Plan / new Attempt |
| Rework | 不变 | 不变 | 不变 | same Run / same Task intent / same Executor Assignment / same Review Plan / new Attempt |
| Change | 可能变 | 可能变 | 可能变 | Change Set → Impact → Approval → Successor Run |

### 2. Invariants

1. **A frozen Run is never silently rewritten.**
   一旦 Run 已产生 frozen Evidence（Task Graph / Executor Plan / Review Plan / Execution Package / Dispatch / Verification / Review / Workspace Evidence），禁止原地重编译并覆盖，禁止删除或改写旧 Attempt，禁止用原 run-id 继续。
2. **Change 必须产生 Successor Run**，Successor 拥有自己独立的 Execution Package、Task Graph、Executor Plan、Review Plan 与全部后续 Evidence，不共享 predecessor frozen Evidence。
3. **History 不等于 Validity。** 旧 Evidence 永远是历史事实；Change 只是使其 `superseded for future work`，禁止描述为 invalid / corrupt / wrong。
4. **显式 Resolution。** 处于影响传播路径上的 artifact 必须有 `replace` 或 `retain`；缺失即 `unresolved`，Analysis = `incomplete`，不得进入 approval。
5. **Approval 绑定具体 Analysis snapshot。** Approval 绑定 `analysis_bundle_sha256`、`impact_sha256` 与三个 candidate plan digest；Proposal 在 analysis 后变化 → `proposal_changed_since_analysis`。
6. **Approved Change 不可变。** approved 后禁止 stage / stage-config / retain，不提供 `--force`；Owner 改变主意必须终止该 Change 并创建新 Change Set。
7. **Active Change Freeze。** 同一 base Run 同时最多一个 active Change（draft / analyzed / approved / materialized）；存在时 base Run 的所有 mutation command 被 `run_change_pending` 阻止，保证 baseline snapshot 稳定。
8. **Materialization 确定性。** Analysis Candidate 与 Replan 重新编译结果必须 digest 完全一致，否则 `non_deterministic_recompile` 并失败。
9. **Supersession 只在成功后。** 仅当 Successor Run 完整创建且全部 frozen plan 编译成功且 digest 与 approval 一致，才写 `superseded.yaml`；失败时 base Run 保持可用，Change 保持 approved。
10. **Superseded Run 永久不可 mutation**（`run_superseded`），只允许 read-only inspection。
11. **Canonical Promotion 只在 Successor Owner Acceptance 之后。** Close 前 canonical artifacts 不被覆盖。
12. **Canonical Drift Guard。** 覆盖前每个文件只允许 `current == baseline` 或 `current == approved target`；第三种 → `canonical_drift` 并 STOP，禁止覆盖未知用户修改。
13. **Close 幂等可重入。** baseline → replace；already target → skip；unknown → fail。中断后可重跑完成剩余文件。
14. **Handoff 门控。** Successor 来自 Change 且 Change != closed 时 handoff 必须被阻止；Successor handoff 包新增确定性生成的 `change-history.md`。
15. **Runtime 不做 AI 决策。** 不允许 AI 判断受影响 Task、自动批准、自动 retain、自动选择 Executor、自动 replan 并 execute、自动 close。决策只来自显式文件、确定性 graph 逻辑与 Owner approval。
16. **No Automatic Carry-Forward。** 禁止自动把 predecessor 已完成 Task 标记为 successor completed，禁止自动复制 Verification / Review PASS；Evidence 不能跨 Run 冒充。
17. **Legacy 兼容。** 不存在 `.speccraft/changes/` 的项目完全保持 v0.8 行为，目录按需创建，无需 migration。

### 3. State Machine

```
draft
  ↓
analyzed
  ↓
approved
  ↓
materialized
  ↓
closed
```

旁路：

```
draft / analyzed
  ↓
rejected
```

允许 `analyze` 多次，产生 append-only `analysis/attempt-NNN/`；`approved` 之后 proposal 冻结。`rejected` 后 base Run 恢复可执行，Rejected Change Evidence 永久保留。

### 4. Change ID

本地确定性编号 `change-001`、`change-002`、……，禁止 UUID / random / timestamp-only。沿用 file-first 设计并防止碰撞。

### 5. Evidence Model

```
.speccraft/changes/change-001/
  manifest.yaml
  request.md

  baseline/
    manifest.yaml
    project.yaml
    artifacts/<stage-id>.md

  proposal/
    project.yaml            # 可选
    artifacts/<stage-id>.md
    resolutions.yaml

  analysis/
    attempt-001/
      manifest.yaml
      impact.yaml
      impact.md
      resolved/
        project.yaml
        artifacts/<stage-id>.md
      candidate/
        task-graph.yaml
        executor-plan.yaml
        review-plan.yaml

  approval.yaml
  materialization.yaml
  close.yaml
```

- **Baseline Snapshot** 捕获创建 Change 时的真实内容与 SHA-256，且使用 raw file bytes 哈希：不 trim、不 normalize markdown、不 normalize line endings、不重新 serialize。
- **Bundle Digest** 不使用 YAML stringify 后 hash，而是：逐文件 SHA-256 → 相对路径升序排序 → 构造 `<path>\0<sha256>\n` → 对整体 SHA-256。因此不受 YAML key 顺序影响。
- Analysis Attempt 为 append-only，永不覆盖。

### 6. Deterministic Impact

- Impact Analysis 只依据显式 changed artifact + Workflow dependency graph + Task dependency graph + candidate plan diff，禁止 LLM 语义推断。
- Artifact Closure 从真实 Workflow DAG 计算 downstream，不硬编码；输出 `directly_changed` / `transitively_affected` / `unaffected`。
- Task Diff 比较 `id/title/summary/depends_on/scope/verification/executor`，输出 added / removed / modified / unchanged（不只比较 Task ID）。
- Task Dependency Impact 区分 `old_graph_impacted` 与 `new_graph_impacted`，不混用。
- Candidate Task Graph / Executor Plan / Review Plan 复用同一核心 compiler（`tasks/compiler.ts`、`executors/plan.ts`、`reviews/plan.ts`），禁止复制第二套规则。
- No-Effect Change（resolved bundle == baseline 且 project config / task graph / executor plan / review plan 均未变）必须拒绝进入 approval（`no_effect`）。

### 7. Successor Run semantics

- Replan 只读取 approved Analysis Attempt snapshot，禁止读取 mutable proposal。
- Replan 重新生成 Execution Package、重编译三份 frozen plan，验证 digest 与 approved Candidate 一致，然后创建 Successor Run。
- Successor 写入 `runs/<successor>/lineage.yaml`（predecessor_run / change_id / approved_analysis_attempt / created_at）；Change 的 `materialization.yaml` 反向记录 `successor_run`，两者必须一致。
- Replan 不自动 dispatch / execute；Owner 仍显式施工。
- Successor 与现有 Runtime 完全兼容（sequential / parallel / worktree isolation / executor routing / verification / review gates / rework / owner accept），不建立第二套 execution runtime。
- Successor 实现错误继续走 Rework，而不是新 Change；Owner 再次改需求则以 Successor 为 base 创建 `change-002`，形成 run-001 → change-001 → run-002 → change-002 → run-003 的 lineage 链，且旧 Change 不可修改。

### 8. Canonical Promotion

- Successor 执行阶段使用 approved resolved snapshot 作为 frozen source，canonical artifacts 不被覆盖。
- 仅 Successor Owner Acceptance PASS 后允许 `changes close`。
- Close Preconditions：Change status = materialized；Successor 存在；Successor Owner Acceptance = accepted；lineage 与 Change 一致；canonical baseline 未 unknown-drift。
- Close 成功后 canonical artifacts（及可选 canonical project.yaml）= approved versions，写 `close.yaml`（closed_at / successor_run / promoted_files / before_hashes / after_hashes），Change → closed。

### 9. Hooks

在现有 Hook Runtime 上新增（语义不变）：

```
before_change_replan / after_change_replan
before_change_close / after_change_close
```

`before_*` 失败 → blocking，主操作不执行；`after_*` 失败 → 主操作已成功，warning / evidence，不 rollback。

## 后果

### 兼容性

- 无 `.speccraft/changes/` 的项目完全保持 v0.8 行为：`prepare` / `execute` / `dispatch` / `verify` / `accept` / `handoff` 行为不变。
- 不要求用户 migration，`changes` 目录按需创建。
- 不新增 npm dependency（只用 Node.js stdlib + js-yaml + 现有项目代码）。

### Non-goals

本轮明确不做：

```
SaaS / Web console / database / SQLite / Redis / queue / remote worker farm
AI scheduler / AI voting / Agent debate / automatic model routing / automatic fallback / cost optimizer
semantic LLM impact analysis
concurrent Change Sets / Change merge / Change conflict resolution / cross-project Change propagation
automatic completed-task reuse / automatic evidence reuse
full crash recovery system
```

v0.9 只做：Change → Impact → Approval → Replan → Successor Run → Supersession → Promotion → History。

### 正面

1. **审计不可篡改**：计划可变而历史不可改写，frozen Evidence 永久保留。
2. **确定性**：Impact / Candidate / Replan 全部可复算，digest 绑定 approval。
3. **受控授权**：Change 必须经 Owner Approval，且绑定具体 Analysis snapshot。
4. **安全晋升**：Drift Guard + 幂等 Close 保护 canonical artifacts 不被未知修改覆盖。
5. **完整谱系**：lineage + superseded + change-history 构成跨 Run 的可追溯链。
6. **向后兼容**：legacy 项目行为不变，无 migration。

### 负面

1. **流程成本增加**：计划变化需要 create / stage / analyze / approve / replan / close 多步。
2. **一个 base Run 同时只能有一个 active Change**，不实现 Change merge。
3. **不自动继承**：Successor 需要重新执行全部 Task，即使 predecessor 已有 PASS Evidence。
4. **Close 非事务**：多文件 promotion 依赖幂等重入而非 filesystem transaction。

### 风险

1. 用户可能试图用 Rework 绕过 Change（需在 guard 与文档中持续强调边界）。
2. 人为 tamper Evidence 只能通过 `validate` 的 `checkChangeConsistency()` 发现。
3. Materialization 中断需人工重跑 `changes replan` 完成收敛。

## 相关

- ADR 0002 — SpecCraft v0.1 架构方案
- ADR 0003 — SpecCraft v0.2 Execution & Verification Runtime
- ADR 0004 — SpecCraft v0.3 Acceptance & Handoff Runtime
- ADR 0005 — Agent Adapter & Hook Runtime
- ADR 0006 — Task Graph & Deterministic Task Orchestration
- ADR 0007 — Safe Parallel Execution & Worktree Isolation
- ADR 0008 — Deterministic Executor Assignment
- ADR 0009 — Independent Review Gates
- `SpecCraft v0.9.md`（本轮 frozen source-of-truth）

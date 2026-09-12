# Controlled Change Management & Deterministic Replanning（v0.9）

SpecCraft v0.9 引入 **Change Set**：当计划本身发生变化时，用一条正式、
可审计、确定性的路径，从旧 Run 过渡到新的 Successor Run。

> **Plans may change. History must not.**

## 核心不变量

```
A frozen Run is never silently rewritten.
```

一旦 Run 已产生 frozen Evidence（Task Graph / Executor Plan / Review Plan /
Execution Package / Dispatch / Verification / Review / Workspace），就禁止原地
重编译并覆盖，禁止删除旧 Evidence，禁止把旧 Attempt 改成新的结果。计划变更
必须通过 **Successor Run** 表达。

## Retry / Rework / Change 三分

v0.9 之前只有 Retry 与 Rework。v0.9 明确：以下任何一种变化都**不是**
Rework，必须走 Change：

```
Requirement change / Design change / Architecture change
Execution Manual change / Task intent change / Task dependency change
Task scope change / Verification contract change
Executor reassignment / Review policy change
```

| 概念 | 目标 / 计划 | 做法 |
| --- | --- | --- |
| **Retry** | 目标、Task intent、计划都没变，只是执行/环境失败 | same Run、same Task、same frozen Plan、new Attempt |
| **Rework** | 目标、Task intent、计划都没变，实现不符合 Verification / Review / Owner Acceptance | same Run、same Task intent、same Executor Assignment、same Review Plan、new Attempt |
| **Change** | 计划本身变化 | Change Set → Impact Analysis → Owner Approval → Successor Run |

因此 v0.7 禁止的 *same Run executor reassignment*，现在只能通过
Change → Successor Run 实现，仍然不会在同一 Run 内发生。

## Change Set 状态机

```
draft ──▶ analyzed ──▶ approved ──▶ materialized ──▶ closed
  │           │
  └───────────┴──▶ rejected
```

- 允许多次 Analysis Attempt：`draft → attempt 1 incomplete → 修改 proposal →
  attempt 2 complete → analyzed`。
- `incomplete` 的分析**保持 draft**，等待继续 resolution。
- `approved`、`materialized`、`closed` 为终态保护：一旦批准，proposal 冻结
  （不可再 `stage` / `stage-config` / `retain`）；`closed` 没有出边。
- 一个 base Run 最多只能有一个 active Change。

### Retained ≠ 自动保留

被判定为 affected 的 artifact，必须**显式**给出 Resolution：要么 `stage`
替换，要么 `retain` 保留。Runtime 不做自动 carry-forward。

## Evidence 目录

```
.speccraft/
  changes/
    change-001/
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
        attempt-002/
        ...
      approval.yaml
      materialization.yaml
      close.yaml
```

Analysis Attempt 是 **append-only**，不删除历史。Change ID 使用本地确定性
编号 `change-001`、`change-002`（非 UUID / 随机 / 纯时间戳）。

## 生命周期工作流

```bash
# 1. 提出 Change（reason 与 file 二选一）
speccraft changes create --base-run <run-id> --reason "<text>"
speccraft changes create --base-run <run-id> --file ./change-request.md
#    可选：--source owner|review|verification|site-survey|external（默认 owner）
#    可选：--source-ref <evidence-path-or-id>

# 2. 在隔离的 Proposal Workspace 中修改受影响 artifact（不触碰 canonical）
speccraft changes stage        <change-id> --artifact <stage-id> --file <replacement.md>
speccraft changes stage-config <change-id> --file ./project.yaml
speccraft changes retain       <change-id> --artifact <stage-id>

# 3. 确定性 Impact Analysis（每次新建 Attempt）
speccraft changes analyze <change-id>

# 4. Owner 决策（approve 绑定该 attempt 的 Analysis digest）
speccraft changes approve <change-id> --by <owner>
speccraft changes reject  <change-id> --reason <text>|--file <path>

# 5. 确定性 Replanning：生成 Successor Run（不自动施工）
speccraft changes replan <change-id>

# 6. Successor Run 正常执行 verify / review / accept

# 7. Canonical Artifact Promotion 并关闭 Change
speccraft changes close <change-id>
```

### Impact Analysis（确定性）

Runtime 只依据显式 changed artifact + 实际 Workflow dependency graph +
Task dependency graph + candidate plan diff 计算影响，**不允许** LLM 在
Runtime 中「觉得」哪些 Task 受影响。结果分类包括 `directly_changed` 与
`transitively_affected`，并产出 Task Diff / Executor Diff / Review Diff 与
candidate frozen plans。

### Approval 与 Staleness

Approval 记录绑定**被批准的 Analysis Attempt 的 bundle digest**。若 proposal
在 analysis 之后被修改，`approve` 会以
`proposal_changed_since_analysis` 拒绝（stale analysis guard）。无实际影响的
Change 以 `no_effect` 拒绝。

### Replanning

`replan` 从被批准的 Attempt 重编译 frozen plans；重编译结果必须与 candidate
逐字节一致，否则以 `non_deterministic_recompile` 拒绝。随后：

- 创建 Successor Run 并写入 Run Lineage（正向 + 反向指向同一 Change）；
- 将 predecessor Run 标记为 superseded，写入 supersession evidence；
- **不自动施工**：Successor Run 由用户显式继续执行。

`replan` 在修改 predecessor 之前先断言 predecessor 未被 supersede
（`run_superseded`）。

### Close（Canonical Promotion）

`close` 前置条件：

1. Successor Run 已 Owner Accepted（否则 `successor_not_accepted`）；
2. Change 存在于可 close 的状态，且 lineage 一致（`lineage_inconsistent`）；
3. 存在 complete 的 analysis（`no_complete_analysis`）；
4. canonical drift guard：目标 artifact 的当前 hash 与 baseline 一致，
   否则 `canonical_drift`。

`close` 必须**可重入**：重复执行返回同一 close 记录（幂等复用），中断后可安全
重试；缺失的 close target 以 `close_target_missing` 报错。

### Handoff Gate

只要 Successor Run 来自一个尚未 `closed` 的 Change，`speccraft handoff`
必须被阻止：

```
accepted successor has unclosed change
run `speccraft changes close <id>` first
```

确保正式 Handoff 时 canonical truth 已更新。Successor Handoff 生成确定性的
`change-history.md`（不调用 AI），含 Change ID、Predecessor / Successor Run、
Reason、Source、Changed / Retained Artifacts、Task / Executor / Review Diff、
Approved By、Approved Analysis Attempt、Materialized At、Closed At，
并纳入 `manifest.yaml` 的 hash。

## 查看与一致性

```bash
speccraft changes list             # ID / BASE RUN / STATUS / SOURCE / LATEST ANALYSIS / SUCCESSOR RUN / CREATED
speccraft changes show <change-id> # Request / Baseline / Proposal / Resolutions / Latest Analysis / Approval / Materialization / Close / Lineage（只读）
speccraft status                   # 增加 Active Change / Pending Impact / Approved Change Awaiting Replan /
                                   # Materialized Change / Unclosed Accepted Change / Superseded Run / Successor Run
speccraft next                     # 按 Change lifecycle 引导，不再建议执行 superseded Run
speccraft validate                 # checkChangeConsistency()：digest / lineage / supersession / close hash /
                                   # 一个 base Run 最多一个 active Change / candidate 与 replan 的 frozen plan digest 一致
```

`status` 与 `next` 在没有任何 Change Evidence 时保持 legacy 输出不变。

`validate` 对任何 tampering 直接 FAIL。

## Hooks

接入既有 Hook Runtime（不发明新机制）：

```
before_change_replan / after_change_replan
before_change_close  / after_change_close
```

`before_*` 失败为 blocking（主操作不执行）；`after_*` 失败不 rollback，作为
warning / evidence 记录。

## 稳定错误码

Change Runtime 的所有拒绝都通过 `ChangeError.code` 稳定表达，便于脚本与测试
判定：

```
change_already_active            change_already_approved
change_rejected                  change_resolution_conflict
invalid_change_transition        proposal_changed_since_analysis
no_effect                       no_complete_analysis
change_not_approved              change_not_materialized
run_superseded                   run_change_pending
non_deterministic_recompile      no_materialization
no_close_record                  successor_run_missing
successor_not_accepted           lineage_inconsistent
canonical_drift                  close_target_missing
```

所有 gate 遵循 **fail-before-mutation**：在任何 IO 写入之前完成校验与断言。

## 与既有 Runtime 的关系

- Successor Run 与现有 Execution / Verification / Review / Acceptance /
  Handoff Runtime **完全兼容**，不引入新执行路径。
- Review enabled / disabled、sequential / parallel、executor routing 均保持
  v0.8 语义。
- Legacy 项目（不创建 Change）行为不变。
- Change Runtime **禁止 AI 决策**：不自动判断受影响 Task、不自动批准、
  不自动 retain、不自动选择 Executor、不自动 replan+execute、不自动 close。
  Planner Agent 可以帮助准备 replacement artifacts，但 Runtime 决策必须来自
  显式文件、确定性图逻辑与 Owner approval。

架构决策见 [docs/decisions/0010-controlled-change-management.md](decisions/0010-controlled-change-management.md)。完整边界见
[SpecCraft v0.9.md](../SpecCraft%20v0.9.md)。

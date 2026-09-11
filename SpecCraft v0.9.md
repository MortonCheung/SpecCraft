# SpecCraft v0.9 — Controlled Change Management & Deterministic Replanning

## Agent 全程施工执行手册

你现在负责 SpecCraft v0.9 的完整设计落地与施工。

本轮不是继续给 v0.8 打补丁，也不是做 UI、SaaS、模型自动选择或所谓“更智能的 Agent”。

本轮只解决一个核心问题：

> **已经冻结并开始执行的计划，因为 Owner 决策、现实条件、需求、设计或施工方案发生变化时，SpecCraft 应如何在不篡改历史 Evidence 的前提下，受控地产生新计划并继续施工。**

v0.9 正式名称：

```text
SpecCraft v0.9
Controlled Change Management & Deterministic Replanning
```

核心原则：

```text
Plans may change. History must not.
```

即：

> **方案可以变，历史不能被改写。**

---

# 0. 权威仓库与施工基线

Repository：

```text
https://github.com/MortonCheung/SpecCraft.git
```

正式 release：

```text
v0.8.0
```

release baseline：

```text
989e8df9392ef278e2a60761965d1506d6ec60a4
```

当前规划分支：

```text
chore/v0.9-planning
```

该分支必须仍然指向：

```text
989e8df9392ef278e2a60761965d1506d6ec60a4
```

且没有任何额外提交。

开始施工前：

```bash
git fetch origin --prune

git switch chore/v0.9-planning
git pull --ff-only origin chore/v0.9-planning

git status --short
git rev-parse HEAD
git rev-parse origin/main
git rev-parse origin/chore/v0.9-planning
```

三者基线必须一致。

然后创建真正开发分支：

```bash
git switch -c feat/v0.9-controlled-change-replanning
git push -u origin feat/v0.9-controlled-change-replanning
```

禁止直接在：

```text
main
chore/v0.9-planning
```

上开发。

---

# 1. Baseline Gate

施工前执行：

```bash
npm test -- --test-concurrency=2
npm run typecheck
npm run build
git diff --check
```

预期 baseline：

```text
506/506 PASS
typecheck PASS
build PASS
diff-check PASS
```

如果 baseline 本身失败：

```text
STOP
```

不要在 v0.9 中顺手修未知旧问题。

报告真实 blocker。

---

# 2. 首先冻结本施工手册

在任何生产代码修改前，将本施工手册完整写入：

```text
SpecCraft v0.9.md
```

标题必须：

```text
# SpecCraft v0.9 — Controlled Change Management & Deterministic Replanning
## Agent 全程施工执行手册
```

同时新增：

```text
docs/decisions/0010-controlled-change-management.md
```

ADR 0010 应从本施工手册提炼：

- Problem
- Decision
- Invariants
- State Machine
- Evidence Model
- Successor Run semantics
- Compatibility
- Non-goals

先提交：

```text
docs: freeze v0.9 controlled change specification
```

从此 `SpecCraft v0.9.md` 是本轮 source-of-truth。

未经 Owner 后续明确批准，不得自行改写其核心语义。

---

# 3. v0.9 要解决的问题

v0.8 已经有：

```text
Task Graph
Executor Plan
Review Plan
Verification
Independent Review
Owner Rework
Parallel Runtime
Frozen Evidence
Handoff
```

但是当前：

```text
Retry
Rework
```

都建立在一个前提上：

```text
原计划仍然有效
```

例如：

```text
Task B 的代码写错
```

可以 Rework。

但下面这些不是 Rework：

```text
Owner 改了 Requirement

Design 决策改变

Execution Manual 改变

Task 被新增 / 删除

Task dependency 改变

Task scope 改变

Verification 条件改变

Executor Assignment 需要改变

Review policy 需要改变
```

这些属于：

```text
CHANGE
```

v0.9 必须第一次把 Change 建模为独立领域对象。

---

# 4. 三个概念必须严格分开

建立以下不可违反的不变量。

## Retry

```text
目标没变
Task intent 没变
计划没变
只是执行失败或环境失败
```

继续：

```text
same Run
same Task
same frozen Plan
new Attempt
```

---

## Rework

```text
目标没变
Task intent 没变
计划没变
实现不符合 Verification / Review / Owner Acceptance
```

继续：

```text
same Run
same Task intent
same Executor Assignment
same Review Plan
new Dispatch / Verification / Review Attempt
```

---

## Change

只要发生下面任何一种：

```text
Requirement change
Design change
Architecture change
Execution Manual change
Task intent change
Task dependency change
Task scope change
Verification contract change
Executor reassignment
Review policy change
```

都不能继续伪装成 Rework。

必须：

```text
Change Set
→ Impact Analysis
→ Owner Approval
→ Successor Run
```

---

# 5. v0.9 第一核心不变量

必须在代码、测试和 ADR 中明确：

```text
A frozen Run is never silently rewritten.
```

一旦 Run 已产生 frozen Evidence：

```text
Task Graph
Executor Plan
Review Plan
Execution Package
Dispatch Evidence
Verification Evidence
Review Evidence
Workspace Evidence
```

禁止原地重编译并覆盖。

禁止：

```text
修改旧 task graph 后继续用原 run-id
修改旧 executor plan
修改旧 review plan
删除旧 Evidence
把旧 Attempt 改成新的结果
```

变更必须产生：

```text
Successor Run
```

---

# 6. 新领域对象：Change Set

新增模块：

```text
src/core/changes/
```

建议拆分：

```text
types.ts
store.ts
digest.ts
create.ts
proposal.ts
impact.ts
approval.ts
replan.ts
lineage.ts
close.ts
guards.ts
consistency.ts
```

不要全部堆进一个 2000 行文件。

---

# 7. Change Set 状态机

v0.9 使用：

```text
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

```text
draft/analyzed
   ↓
rejected
```

允许多次 Analysis Attempt：

```text
draft
→ analysis attempt 1 incomplete
→ 修改 proposal
→ analysis attempt 2 complete
→ analyzed
```

但：

```text
approved
```

以后不得继续修改该 Change Set Proposal。

如果 Owner 在批准后又改变主意：

**不要原地修改。**

该 Change Set 应终止，并创建新的 Change Set。

---

# 8. Change ID

使用本地确定性编号：

```text
change-001
change-002
change-003
```

禁止：

```text
UUID
random id
timestamp-only id
```

编号分配必须防止碰撞。

沿用 SpecCraft 文件优先设计。

---

# 9. Evidence 目录

建立：

```text
.speccraft/
  changes/
    change-001/
      manifest.yaml
      request.md

      baseline/
        manifest.yaml
        project.yaml
        artifacts/
          <stage-id>.md

      proposal/
        project.yaml          # 可选
        artifacts/
          <stage-id>.md
        resolutions.yaml

      analysis/
        attempt-001/
          manifest.yaml
          impact.yaml
          impact.md
          resolved/
            project.yaml
            artifacts/
              <stage-id>.md
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

历史 Analysis Attempt：

```text
append-only
```

不得删除旧 attempt。

---

# 10. Change Request

新增 CLI：

```bash
speccraft changes create \
  --base-run <run-id> \
  --reason "<text>"
```

同时支持：

```bash
speccraft changes create \
  --base-run <run-id> \
  --file ./change-request.md
```

两者必须二选一。

可选：

```text
--source owner
--source review
--source verification
--source site-survey
--source external
```

默认：

```text
owner
```

可选：

```text
--source-ref <evidence-path-or-id>
```

创建时必须捕获：

```text
change_id
base_run_id
source
reason
created_at
git_head
workflow identity/digest
project.yaml digest
artifact digests
base Task Graph digest
base Executor Plan digest
base Review Plan digest
```

如果某类 plan 不存在：

```text
null / absent
```

不要伪造。

---

# 11. Baseline Snapshot

`changes create` 必须对当前 canonical artifacts 做真实 snapshot。

不能只记录“文件路径”。

至少：

```text
baseline/artifacts/<stage>.md
```

保存创建 Change 时的内容。

同时保存 SHA-256。

使用：

```text
raw file bytes
```

进行 hash。

不要：

```text
trim
normalize markdown
normalize line endings
重新 serialize 后计算
```

Evidence 要绑定真实字节。

---

# 12. Bundle Digest

不要直接对 YAML stringify 后 hash。

建立稳定算法：

1. 为 bundle 中每个文件计算 SHA-256；
2. 使用相对路径升序排序；
3. 构造：

```text
<path>\0<sha256>\n
```

4. 对整体字符串 SHA-256。

例如：

```text
artifacts/design.md\0abc...\n
artifacts/requirement.md\0def...\n
project.yaml\0ghi...\n
```

Approval 必须绑定：

```text
analysis_bundle_sha256
```

这样不会受 YAML key 顺序影响。

---

# 13. Active Change Freeze

这是关键行为。

只要某 Run 存在一个 active Change：

```text
draft
analyzed
approved
```

该 base Run 就不得继续产生新的施工 Evidence。

以下 mutation command 必须被阻止：

```text
dispatch
execute
task reopen
task verify
implement start
implement finish
verify
accept
reject
```

错误：

```text
run_change_pending
```

并提示：

```text
Run <id> has active Change Set <change-id>.
Resolve or reject the Change Set before continuing this Run.
```

为什么：

> Change 创建后，base snapshot 必须稳定。

否则 Analysis 做到一半，旧 Run 又继续施工，baseline 就漂了。

---

# 14. Reject Change

新增：

```bash
speccraft changes reject <change-id> \
  --reason "<text>"
```

或：

```bash
--file
```

只允许：

```text
draft
analyzed
```

进入：

```text
rejected
```

之后：

```text
base Run 恢复可执行
```

因为计划没有被改变。

Rejected Change Evidence 永久保留。

---

# 15. Proposal Workspace

禁止直接修改 canonical artifact。

Change Proposal 必须在隔离目录工作。

新增：

```bash
speccraft changes stage <change-id> \
  --artifact <stage-id> \
  --file <replacement.md>
```

它把新 artifact 写入：

```text
proposal/artifacts/<stage-id>.md
```

必须验证：

- stage id 存在于 Workflow；
- replacement 是合法 artifact；
- artifact metadata/stage 与目标匹配；
- 路径不得逃逸；
- approved Change 禁止 stage。

---

# 16. Project Config Change

v0.9 允许通过 Successor Run 正式改变：

```text
Executor Assignment
Review Configuration
Execution Configuration
Hooks
```

新增：

```bash
speccraft changes stage-config <change-id> \
  --file ./project.yaml
```

保存：

```text
proposal/project.yaml
```

这意味着：

> v0.7 中禁止在同一 Run 内发生的 Executor Reassign，现在可以通过 v0.9 的正式 Change → Successor Run 实现。

仍然禁止：

```text
same Run executor reassignment
```

---

# 17. Artifact Impact Propagation

Impact Analysis 必须是：

```text
deterministic
```

禁止让 LLM 在 Runtime 中判断：

> “我觉得这个需求可能影响登录模块。”

Runtime 只依据：

```text
显式 changed artifact
+
Workflow dependency graph
+
Task dependency graph
+
candidate plan diff
```

---

# 18. Artifact Closure Algorithm

如果：

```text
requirement
```

被 stage 为新版本，则 Runtime 应从实际 Workflow DAG 中计算所有 downstream artifacts。

不要硬编码：

```text
requirement → design → execution-manual
```

应读取当前 workflow 定义。

输出分类：

```text
directly_changed
transitively_affected
unaffected
```

例如：

```text
directly_changed:
  - requirement

transitively_affected:
  - concept
  - design
  - build-brief
  - site-survey
  - execution-manual
```

具体结果以真实 Workflow DAG 为准。

---

# 19. 受影响 Artifact 必须 Resolution

不能因为一个上游 Artifact 改了，就自动假定所有下游内容都要重写。

所以每个 affected artifact 必须最终有 Resolution：

```text
replace
```

或：

```text
retain
```

新增：

```bash
speccraft changes retain <change-id> \
  --artifact <stage-id>
```

含义：

> 我已经评估该 artifact，虽然它处于影响传播路径上，但其现有内容仍然成立。

这不是自动判断。

这是显式决策，并最终由 Change Approval 一并批准。

---

# 20. 不允许“自动保留”

如果 artifact 被影响，但既没有：

```text
replacement
```

也没有：

```text
retain
```

Analysis 必须报告：

```text
unresolved
```

不能进入：

```text
approved
```

---

# 21. Analysis Attempt

新增：

```bash
speccraft changes analyze <change-id>
```

每执行一次创建：

```text
analysis/attempt-NNN/
```

永远不覆盖旧 Attempt。

结果：

```text
complete
```

或：

```text
incomplete
```

---

# 22. Incomplete Analysis

典型：

```text
requirement 被修改
↓
design 被影响
↓
design 既没有 replacement，也没有 retain
```

结果：

```text
analysis attempt = incomplete
```

CLI 应明确打印：

```text
Unresolved affected artifacts:
- design
- build-brief
...
```

用户处理后再次：

```bash
speccraft changes analyze change-001
```

产生新的 Attempt。

---

# 23. Resolved Artifact Snapshot

一个 complete Analysis Attempt 必须生成完整：

```text
analysis/attempt-NNN/resolved/
```

这代表：

> 如果 Owner 批准 Change，这就是 Successor Run 应看到的世界。

Resolution 规则：

```text
replace
→ proposal version

retain
→ baseline version

unaffected
→ baseline version
```

禁止后续 `replan` 再读取 mutable proposal。

Replan 只允许读取：

```text
approved Analysis Attempt snapshot
```

---

# 24. Task Graph Candidate Compilation

如果 resolved：

```text
execution-manual
```

发生变化：

必须从 resolved snapshot 的 Execution Manual 编译 Candidate Task Graph。

不要创建 Run。

先产生：

```text
analysis/.../candidate/task-graph.yaml
```

必须尽可能复用：

```text
src/core/tasks/compiler.ts
```

但应抽离：

```text
pure parse / compile
```

与：

```text
persist-to-run
```

的职责。

不要复制两套 Task Graph compiler。

---

# 25. Task Diff

比较：

```text
base Task Graph
vs
candidate Task Graph
```

根据 canonical Task Definition 计算：

```text
added
removed
modified
unchanged
```

用于比较的字段至少包含：

```text
id
title
summary
depends_on
scope
verification
executor
```

如果 Task ID 相同但这些字段变化：

```text
modified
```

不要只比较 Task ID。

---

# 26. Task Dependency Impact

对于 modified / removed old Task：

从旧 Task Graph 计算：

```text
transitive dependents
```

对于 added / modified candidate Task：

从 Candidate Graph 计算新的 downstream impact。

Impact Report 应区分：

```text
old_graph_impacted
new_graph_impacted
```

不要把二者混起来。

---

# 27. Candidate Executor Plan

如果：

```text
Task Graph changed
```

或：

```text
project.yaml execution config changed
```

则在 Analysis Attempt 中生成 Candidate Executor Plan。

继续保持 v0.7 原则：

```text
Task → Executor assignment deterministic
```

禁止：

```text
AI ranking
auto model selection
random routing
fallback
```

但 Change 可以显式将：

```text
Task A:
alpha → beta
```

这属于：

```text
Successor Run change
```

合法。

---

# 28. Candidate Review Plan

如果：

```text
Review config changed
```

或需要形成新的 Successor Run frozen plan：

生成 Candidate Review Plan。

必须复用 v0.8 Compiler。

不要发明：

```text
Change Reviewer
AI committee
review voting
```

---

# 29. Impact Report

每个 Analysis Attempt 生成机器 Evidence：

```text
impact.yaml
```

同时生成：

```text
impact.md
```

Markdown 至少展示：

```text
Base Run
Base Git HEAD
Changed Artifacts
Affected Artifacts
Resolution
Task Graph Diff
Affected Old Tasks
Affected New Tasks
Executor Assignment Diff
Review Plan Diff
Frozen Evidence Invalidated
Required Successor Run
Unresolved Items
```

---

# 30. Frozen Evidence Invalidated

Impact Analysis 必须明确告诉 Owner：

哪些旧 Evidence 仍是历史事实，但不能继续作为未来施工依据。

例如：

```text
Task Graph:
historically valid
future execution invalidated

Executor Plan:
historically valid
future execution invalidated

Review Plan:
historically valid
future execution invalidated
```

注意措辞。

禁止把旧 Evidence 写成：

```text
invalid
corrupt
wrong
```

它不是错。

只是：

```text
superseded for future work
```

---

# 31. No-Effect Change

如果 Analysis 后发现：

```text
resolved artifact bundle
=
baseline bundle
```

并且：

```text
project config unchanged
task graph unchanged
executor plan unchanged
review plan unchanged
```

必须拒绝进入 approval：

```text
no_effect
```

不要创建无意义 Successor Run。

---

# 32. Owner Approval

新增：

```bash
speccraft changes approve <change-id> \
  --by <owner>
```

只允许：

```text
latest complete Analysis Attempt
```

Approval 必须绑定：

```text
change_id
analysis_attempt
analysis_bundle_sha256
impact_sha256
candidate task graph digest
candidate executor plan digest
candidate review plan digest
approved_by
approved_at
```

Approval 以后：

```text
Proposal immutable
Resolution immutable
Approved Analysis immutable
```

---

# 33. Approval Staleness

如果 Analysis 后 Proposal 被修改：

旧 Analysis 不能批准。

即使文件名相同也不行。

通过 Digest 判断：

```text
proposal_changed_since_analysis
```

必须重新：

```bash
changes analyze
```

---

# 34. Approved Change 禁止修改

以下命令对 approved Change 必须失败：

```text
stage
stage-config
retain
```

错误：

```text
change_already_approved
```

不要提供：

```text
--force
```

绕过。

---

# 35. Deterministic Replanning

新增：

```bash
speccraft changes replan <change-id>
```

这里只允许：

```text
approved
```

Replan 的职责：

```text
读取 approved Analysis snapshot
↓
重新生成 Execution Package
↓
重新编译 Task Graph
↓
重新编译 Executor Plan
↓
重新编译 Review Plan
↓
验证其 Digest 与 approved Candidate 完全一致
↓
创建 Successor Run
```

---

# 36. Recompile Must Match

Analysis 时生成的 Candidate：

```text
task graph
executor plan
review plan
```

与 Replan 时重新编译出的结果必须 digest 一致。

如果不同：

```text
non_deterministic_recompile
```

立即失败。

禁止：

> “差不多一样就继续。”

这是确定性核心。

---

# 37. Successor Run

成功后创建：

```text
new run-id
```

例如：

```text
run-004
→ change-001
→ run-005
```

Successor Run 必须拥有自己的：

```text
Execution Package
Task Graph
Executor Plan
Review Plan
Dispatch Evidence
Verification Evidence
Review Evidence
Acceptance
Handoff
```

不能共享 predecessor frozen Evidence。

---

# 38. Run Lineage

Successor Run 下新增：

```text
.speccraft/runs/<successor>/lineage.yaml
```

至少：

```yaml
predecessor_run: run-004
change_id: change-001
approved_analysis_attempt: 2
created_at: ...
```

Change Set：

```text
materialization.yaml
```

反向记录：

```text
successor_run
```

两者必须一致。

---

# 39. Superseded Run

只有在：

```text
Successor Run 完整创建
+
所有 frozen plans 编译成功
+
digest 与 approval 一致
```

之后，才允许标记 predecessor：

```text
superseded
```

写：

```text
.speccraft/runs/<predecessor>/superseded.yaml
```

至少：

```text
change_id
successor_run
superseded_at
```

不要改写旧 Run Manifest 中已经存在的 Evidence。

---

# 40. Materialization Failure

如果 Successor Run 创建到一半失败：

必须保证：

```text
base Run 尚未 superseded
```

Change 保持：

```text
approved
```

允许用户修复环境后重新：

```text
changes replan
```

不要留下一个半死的 Successor Run 被系统当成 active。

如果创建了 incomplete Run directory：

明确标记：

```text
aborted
```

或安全清理。

不能静默留下。

---

# 41. Superseded Run Guard

Materialization 成功后，predecessor Run 永久不可 mutation。

任何：

```text
dispatch
execute
verify
accept
reject
task reopen
task verify
implement start/finish
```

必须：

```text
run_superseded
```

并指向：

```text
successor_run
```

Read-only：

```text
status
show
evidence inspection
```

继续允许。

---

# 42. 新 Run 不自动施工

`changes replan` 只：

```text
create successor
compile frozen state
```

不执行：

```text
dispatch
execute
```

Owner / operator 仍然显式运行施工。

不能偷偷自动继续。

---

# 43. Successor Run 与现有 Runtime 完全兼容

新的 Successor Run 必须继续通过：

```text
sequential execution
parallel execution
worktree isolation
executor routing
verification
review gates
rework
owner reject
owner accept
```

v0.9 不得建立第二套 execution runtime。

---

# 44. Successor Rework

如果 Successor Run 的代码实现出错：

使用原有：

```text
Rework
```

而不是新 Change。

例如：

```text
新 Requirement 已被 Change 批准
↓
Successor Task 实现不符合 Requirement
↓
Review changes_required
↓
same Successor Run rework
```

完全正确。

---

# 45. 第二次 Change

如果施工 Successor Run 时 Owner **再次改需求**：

创建：

```text
change-002
```

base：

```text
run-005
```

最终形成：

```text
run-004
  ↓ change-001
run-005
  ↓ change-002
run-006
```

不能修改：

```text
change-001
```

---

# 46. Canonical Artifact Promotion

重要设计：

Change Proposal 在 Successor 执行阶段仍不立即覆盖 canonical artifacts。

Successor Run 使用：

```text
approved resolved snapshot
```

作为自己的 frozen source。

只有 Successor Run：

```text
Owner Acceptance PASS
```

之后，才允许：

```bash
speccraft changes close <change-id>
```

---

# 47. Close Preconditions

必须满足：

```text
Change status = materialized
Successor Run exists
Successor Run Owner Acceptance = accepted
Successor lineage matches Change
Canonical baseline has not unknown-drifted
```

否则失败。

---

# 48. Canonical Drift Guard

在覆盖任何 canonical artifact 前：

检查当前 canonical hash。

对于每个需要 replacement 的文件：

允许：

```text
current hash == baseline hash
```

或者：

```text
current hash == approved target hash
```

第二种用于 crash/retry 幂等。

任何第三种 hash：

```text
canonical_drift
```

STOP。

禁止覆盖未知用户修改。

---

# 49. Close 必须可重入

多个 artifact 无法真正做 filesystem transaction。

因此实现幂等 close：

对每个文件：

```text
baseline
→ replace

already target
→ skip

unknown
→ fail
```

如果上一次进程中途崩溃：

重新：

```bash
changes close
```

应能完成剩余文件。

不要重复破坏已经完成的文件。

---

# 50. Close 完成

成功后：

```text
canonical artifacts = approved versions
canonical project.yaml = approved version（如果 change 包含）
```

写：

```text
close.yaml
```

至少：

```text
closed_at
successor_run
promoted_files
before_hashes
after_hashes
```

Change 状态：

```text
closed
```

---

# 51. Handoff Gate

如果某 Successor Run 来自 Change，且：

```text
Change != closed
```

则：

```text
speccraft handoff
```

必须阻止。

提示：

```text
accepted successor has unclosed change
run `speccraft changes close <id>` first
```

这样确保正式 Handoff 时 canonical truth 已更新。

---

# 52. Handoff 新增 Change History

Successor Handoff 增加：

```text
change-history.md
```

内容必须确定性生成，不调用 AI。

至少：

```text
Change ID
Predecessor Run
Successor Run
Reason
Source
Changed Artifacts
Retained Artifacts
Task Diff
Executor Diff
Review Diff
Approved By
Approved Analysis Attempt
Materialized At
Closed At
```

`manifest.yaml` 纳入文件 hash。

---

# 53. CLI

新增命令组：

```text
speccraft changes list
speccraft changes show <change-id>

speccraft changes create
speccraft changes stage
speccraft changes stage-config
speccraft changes retain

speccraft changes analyze
speccraft changes approve
speccraft changes reject

speccraft changes replan
speccraft changes close
```

---

# 54. `changes list`

至少显示：

```text
ID
BASE RUN
STATUS
SOURCE
LATEST ANALYSIS
SUCCESSOR RUN
CREATED
```

确定性排序：

```text
change number ascending
```

---

# 55. `changes show`

展示：

```text
Request
Baseline
Proposal
Resolutions
Latest Analysis
Approval
Materialization
Close
Lineage
```

不得修改状态。

---

# 56. `status`

全局：

```bash
speccraft status
```

增加：

```text
Active Change
Pending Impact
Approved Change Awaiting Replan
Materialized Change
Unclosed Accepted Change
Superseded Run
Successor Run
```

---

# 57. `next`

必须知道 Change lifecycle。

例如：

```text
draft + unresolved
→ stage / retain + analyze

analyzed
→ approve or reject

approved
→ changes replan

materialized + successor executing
→ continue successor execution

successor accepted + not closed
→ changes close

closed
→ handoff
```

不要继续建议用户执行 superseded Run。

---

# 58. `validate`

扩展现有 validate。

新增：

```text
checkChangeConsistency()
```

至少验证：

- Change ID / path 一致；
- base Run 存在；
- baseline digest 正确；
- Analysis bundle digest 正确；
- approved attempt 存在；
- approval digest 与 Attempt 一致；
- materialized Change 必须有 Successor；
- Successor lineage 必须反向指向同一 Change；
- predecessor superseded evidence 与 materialization 一致；
- rejected Change 不得有 successor；
- closed Change 必须 successor accepted；
- close target hash 正确；
- 一个 base Run 最多一个 active Change；
- superseded Run 不得是 active execution target；
- Candidate / Replan frozen plan digest 一致。

任何 tampering：

```text
validate FAIL
```

---

# 59. Hooks

接入现有 Hook Runtime。

新增：

```text
before_change_replan
after_change_replan

before_change_close
after_change_close
```

语义继续保持现有约定：

```text
before_* failure
→ blocking
→ 主操作不执行

after_* failure
→ 主操作已经成功
→ warning / evidence
→ 不 rollback
```

不要发明新的 Hook 机制。

---

# 60. Change Runtime 禁止 AI 决策

Runtime 不允许：

```text
AI 判断受影响 Task
AI 自动批准
AI 自动选择 retain
AI 自动选择 Executor
AI 自动 replan 并 execute
AI 自动 close
```

Planner Agent 可以帮助用户准备：

```text
replacement artifacts
```

但 Runtime 决策必须来自：

```text
explicit files
deterministic graph logic
Owner approval
```

---

# 61. 一个 Active Change 限制

v0.9 不实现 Change merge。

因此：

> 同一个 base Run 同时最多一个 active Change。

如果存在：

```text
draft
analyzed
approved
materialized
```

则禁止基于同一个 base Run 再 create。

只有：

```text
rejected
closed
```

后可进入下一生命周期。

注意：

materialized Change 的新变化应该基于：

```text
successor Run
```

创建，而不是 predecessor。

---

# 62. Legacy Compatibility

没有：

```text
.speccraft/changes/
```

的旧项目必须完全保持 v0.8 行为。

禁止要求用户 migration。

目录应按需创建。

现有：

```text
prepare
execute
dispatch
verify
accept
handoff
```

在没有 Change 的项目中行为不得改变。

---

# 63. No Automatic Carry-Forward

v0.9 不实现：

```text
自动把 predecessor 已完成 Task 标记成 successor completed
自动复制 Verification PASS
自动复制 Review PASS
```

Evidence 不能跨 Run 冒充新 Run Evidence。

Impact Report 可以说明：

```text
unchanged task
```

但 Successor 是否仍包含该 Task，由新的 Execution Manual 决定。

不要自动跳过。

---

# 64. 明确非目标

本轮禁止扩展为：

```text
SaaS
Web console
database
SQLite
Redis
queue
remote worker farm

AI scheduler
AI voting
Agent debate
automatic model routing
automatic fallback
cost optimizer
token optimizer

semantic LLM impact analysis

concurrent Change Sets
Change merge
Change conflict resolution
cross-project Change propagation

automatic completed-task reuse
automatic evidence reuse

full crash recovery system
```

v0.9 只做：

```text
Change
Impact
Approval
Replan
Successor Run
Supersession
Promotion
History
```

---

# 65. 依赖约束

不要增加新 npm dependency。

继续使用：

```text
Node.js standard library
js-yaml
现有项目代码
```

尤其不要添加：

```text
simple-git
execa
zod
database
uuid
nanoid
LangGraph
LangChain
CrewAI
AutoGen
```

如果只是为方便写几十行代码就想引依赖：

不要。

---

# 66. 推荐生产文件施工范围

新增：

```text
src/core/changes/types.ts
src/core/changes/store.ts
src/core/changes/digest.ts
src/core/changes/create.ts
src/core/changes/proposal.ts
src/core/changes/impact.ts
src/core/changes/approval.ts
src/core/changes/replan.ts
src/core/changes/lineage.ts
src/core/changes/close.ts
src/core/changes/guards.ts
src/core/changes/consistency.ts
```

可能修改：

```text
src/core/tasks/compiler.ts
src/core/execution/prepare.ts
src/core/execution/store.ts
src/core/execution/lifecycle.ts

src/core/executors/*
src/core/reviews/*

src/core/handoff/*
src/core/hooks/*

src/cli/commands.ts
src/cli/index.ts
```

原则：

> 只有确实需要的文件才改。

不要为了“架构统一”顺便重构整个 v0.8。

---

# 67. Task Compiler 改造原则

如果需要支持 Candidate compile：

应把：

```text
parse / normalize / validate / compile
```

抽成可复用纯函数。

然后：

```text
normal task compile
candidate change analysis
successor replan
```

共用。

禁止：

```text
copy compiler.ts → change-task-compiler.ts
```

制造第二套规则。

---

# 68. Executor / Review Compiler 同样原则

Candidate Plan 与 Run Frozen Plan 必须共享同一核心 compiler。

否则无法证明：

```text
Analysis Candidate
=
Materialized Successor Plan
```

---

# 69. 文档

新增：

```text
docs/change-management.md
docs/decisions/0010-controlled-change-management.md
```

更新：

```text
README.md
```

README 版本演进增加：

```text
v0.9 Controlled Change Management & Deterministic Replanning
```

但不要顺手处理与本功能无关的：

```text
package version
license metadata
其他 README 历史问题
```

除非 Owner 单独要求。

---

# 70. Unit Tests

新增针对：

```text
Change ID allocation
baseline snapshot
raw-byte digest
bundle digest stability

state transitions
active change detection
proposal mutation guards

workflow downstream closure
artifact resolution
incomplete analysis
complete analysis

task graph diff
task dependency closure

approval digest binding
stale analysis rejection

candidate recompile equality
lineage

canonical drift
idempotent close
```

---

# 71. 权威 E2E A — Upstream Requirement Change

建立真实项目：

```text
Requirement
→ Design
→ Execution Manual
→ Task Graph
```

流程：

```text
Base Run
↓
changes create
↓
stage requirement
↓
analyze
```

第一次应发现 downstream unresolved。

然后：

```text
retain / replace affected artifacts
↓
analyze again
↓
complete
↓
approve
↓
replan
```

断言：

```text
successor Run exists
base Run superseded
old Evidence remains unchanged
successor frozen plans exist
```

---

# 72. 权威 E2E B — Active Change Freezes Run

创建正在施工的 Run。

执行一个 Task。

然后：

```text
changes create
```

之后以下必须全部被 block：

```text
dispatch
execute
verify
accept
```

错误：

```text
run_change_pending
```

然后：

```text
changes reject
```

旧 Run 再次允许继续。

---

# 73. 权威 E2E C — Executor Reassignment

Base：

```text
Task A → executor alpha
```

Change：

```text
stage-config
```

Candidate：

```text
Task A → executor beta
```

Analysis 必须报告：

```text
Executor Assignment Diff:
A alpha → beta
```

Approve + replan 后：

```text
Successor Executor Plan = beta
```

Base Run 仍永久保留：

```text
alpha
```

证明：

```text
history not rewritten
```

---

# 74. 权威 E2E D — Proposal Changed After Analysis

```text
analyze attempt-001
```

然后修改 proposal。

尝试：

```text
approve
```

必须失败：

```text
proposal_changed_since_analysis
```

重新 analyze：

```text
attempt-002
```

才能 approve。

Attempt 001 不删除。

---

# 75. 权威 E2E E — Approved Proposal Immutable

Approve 后：

```text
stage
retain
stage-config
```

全部失败：

```text
change_already_approved
```

---

# 76. 权威 E2E F — Non-deterministic Recompile Guard

建立 approved Change。

人工 tamper Candidate Evidence 或制造 digest mismatch。

`changes replan` 必须：

```text
FAIL
non_deterministic_recompile
```

不得 supersede base Run。

不得留下 usable Successor。

---

# 77. 权威 E2E G — Successful Successor Lifecycle

完整：

```text
Base Run
↓
Change
↓
Analyze
↓
Approve
↓
Replan
↓
Successor Run
↓
Execute
↓
Verification
↓
Review
↓
Owner Acceptance
↓
Change Close
↓
Handoff
```

最终：

```text
Change = closed
Predecessor = superseded
Successor = accepted
canonical artifacts = approved target
handoff contains change-history.md
```

---

# 78. 权威 E2E H — Close Requires Acceptance

Successor：

```text
Verification PASS
Review PASS
```

但未 Owner Accept。

执行：

```text
changes close
```

必须失败。

证明：

```text
Verification ≠ Owner Acceptance
Review ≠ Owner Acceptance
```

v0.8 边界不能退化。

---

# 79. 权威 E2E I — Canonical Drift

在 Successor Accepted 后、Close 前：

人为修改 canonical artifact。

执行：

```text
changes close
```

必须：

```text
canonical_drift
```

且不得覆盖未知修改。

---

# 80. 权威 E2E J — Idempotent / Interrupted Close

模拟一部分 target artifact 已经等于 approved target，另一部分仍是 baseline。

再次：

```text
changes close
```

应：

```text
success
```

target 文件跳过，baseline 文件完成替换。

最终 hashes 正确。

---

# 81. 权威 E2E K — Successor Review Runtime Regression

Successor Run 开启：

```text
review.enabled=true
```

真实走：

```text
Task
→ Verification
→ Review
→ Commit
```

保证 v0.9 lineage 不破坏 v0.8 Review Gate。

---

# 82. 权威 E2E L — Parallel Successor Regression

Successor Task Graph：

```text
A → (B + C) → D
```

运行：

```text
execute --parallel
```

必须保持：

```text
3 waves
B/C overlap
workspace isolation
review semantics
integration semantics
```

证明 Change Runtime 没破坏 v0.6–v0.8。

---

# 83. 权威 E2E M — Second Change

完成：

```text
run-001
→ change-001
→ run-002
```

在 run-002 再创建：

```text
change-002
```

完成：

```text
run-003
```

验证 lineage：

```text
run-001
→ change-001
→ run-002
→ change-002
→ run-003
```

且不可修改 change-001。

---

# 84. 权威 E2E N — Validate Tampering

对以下任一 Evidence 人工修改：

```text
approval digest
base run
successor lineage
analysis bundle
candidate task plan
close hash
superseded link
```

运行：

```text
speccraft validate
```

必须 FAIL。

---

# 85. Legacy Regression

必须保留现有全部测试。

没有 Change 的项目：

```text
prepare
execute
parallel
executor routing
review
acceptance
handoff
```

行为不能改变。

目标不是：

> v0.9 tests 通过。

而是：

> v0.1–v0.8 全部能力 + v0.9 tests 一起通过。

---

# 86. Stub Audit

施工完成运行：

```bash
rg -n \
'TODO|FIXME|HACK|XXX|placeholder|For now|simplified|assert\.ok\(true|Test stub' \
src tests
```

生产：

```text
src/
```

不允许遗留真正 stub。

测试文本中的英文断言若匹配：

逐条解释。

---

# 87. 推荐施工阶段

## Commit 1

```text
docs: freeze v0.9 controlled change specification
```

只：

```text
SpecCraft v0.9.md
ADR 0010
```

---

## Commit 2

```text
feat: add change set model and evidence store
```

包括：

```text
types
IDs
store
digest
baseline
create/list/show
```

---

## Commit 3

```text
feat: add deterministic change impact analysis
```

包括：

```text
proposal staging
retain
workflow closure
analysis attempts
resolved snapshot
task diff
candidate plans
impact report
```

---

## Commit 4

```text
feat: add change approval and successor replanning
```

包括：

```text
approval
digest binding
replan
lineage
active change freeze
supersession
```

---

## Commit 5

```text
feat: add change close and canonical promotion
```

包括：

```text
acceptance requirement
drift guard
idempotent promotion
handoff integration
validate
status
next
hooks
```

---

## Commit 6

```text
test: complete v0.9 authoritative lifecycle coverage
```

权威 E2E。

---

## Commit 7

如确实需要：

```text
docs: document controlled change workflow
```

README + change-management docs。

不要为了凑提交数量强行拆。

---

# 88. 每个阶段都要跑局部门禁

不要等最后才发现核心设计错了。

每个 commit 前至少：

```bash
npm run typecheck
npm run build
git diff --check
```

相关 tests：

```bash
npm test -- --test-concurrency=2
```

视修改规模执行。

---

# 89. Full Release Candidate Gate

完成所有施工后运行：

```bash
npm test -- --test-concurrency=2
npm test -- --test-concurrency=2

npm run typecheck
npm run build
git diff --check

rg -n \
'TODO|FIXME|HACK|XXX|placeholder|For now|simplified|assert\.ok\(true|Test stub' \
src tests
```

完整测试必须连续两次 PASS。

---

# 90. Spec Integrity

最终：

```bash
git status --short
```

必须 clean。

确认：

```text
SpecCraft v0.8.md
```

没有被修改。

v0.8 frozen source-of-truth 不属于本轮施工对象。

检查：

```bash
git diff \
989e8df9392ef278e2a60761965d1506d6ec60a4 \
-- "SpecCraft v0.8.md"
```

必须：

```text
无输出
```

---

# 91. Git 规则

只 push：

```text
feat/v0.9-controlled-change-replanning
```

禁止：

```text
merge main
tag v0.9
删除分支
force push main
```

Owner Acceptance 前：

```text
main
```

保持 v0.8.0 release baseline。

---

# 92. 不允许偷偷缩减施工范围

以下情况不能用一句：

```text
后续实现
```

带过：

```text
Impact Analysis
Approval Binding
Successor Run
Supersession Guard
Canonical Drift
Close
Validate
Handoff
```

这些都是 v0.9 核心，不是 optional。

---

# 93. 允许发现真实设计问题

如果施工过程中发现本手册某条与真实现有 Runtime 架构发生硬冲突：

不要偷偷改语义。

先：

1. 保留现有代码；
2. 明确指出冲突；
3. 给出：
   - 原设计；
   - 真实代码约束；
   - 为什么无法按原方案安全落地；
   - 最小调整建议；
4. 标记：

```text
OWNER DECISION REQUIRED
```

但是：

普通函数签名、文件拆分、小型内部实现差异，不属于需要 Owner 决策的范围。

Agent自行处理。

---

# 94. 最终验收重点

Owner 最终不会只看：

```text
tests green
```

还会重点查：

### Gate 1

```text
旧 Run Frozen Evidence 是否真的没有被改写
```

### Gate 2

```text
Active Change 是否真的冻结了 base Run
```

### Gate 3

```text
Impact 是否 deterministic
```

### Gate 4

```text
Approval 是否绑定具体 Analysis snapshot
```

### Gate 5

```text
Successor Run 是否重新拥有独立 Task/Executor/Review Plans
```

### Gate 6

```text
Predecessor 是否只在 materialization 成功后 supersede
```

### Gate 7

```text
Close 是否有 drift protection
```

### Gate 8

```text
v0.8 Review / Parallel Runtime 是否仍真实工作
```

不要用 mock-only happy path 代替。

---

# 95. 最终 Agent 汇报格式

## A. Baseline

```text
branch:
start SHA:
final SHA:
remote SHA:
working tree:
```

---

## B. Frozen Specification

```text
SpecCraft v0.9.md:
created

ADR 0010:
created

SpecCraft v0.8.md:
unchanged
```

---

## C. Change Runtime

```text
Change Set model:
PASS

baseline snapshot:
PASS

proposal isolation:
PASS

active run freeze:
PASS

reject/resume:
PASS
```

---

## D. Impact Analysis

```text
workflow closure:
PASS

artifact resolution:
PASS

analysis attempts:
PASS

task diff:
PASS

executor diff:
PASS

review diff:
PASS

deterministic candidate evidence:
PASS
```

---

## E. Approval / Replan

```text
approval digest binding:
PASS

stale analysis guard:
PASS

approved mutation guard:
PASS

successor run:
PASS

lineage:
PASS

non-deterministic recompile guard:
PASS

predecessor supersession:
PASS
```

---

## F. Close / Handoff

```text
Owner Acceptance prerequisite:
PASS

canonical drift guard:
PASS

idempotent close:
PASS

artifact promotion:
PASS

change-history handoff:
PASS
```

---

## G. Compatibility

```text
sequential:
PASS

parallel:
PASS

executor routing:
PASS

review gates:
PASS

owner rework:
PASS

legacy no-change projects:
PASS
```

---

## H. Regression

```text
full suite run 1:
N/N PASS

full suite run 2:
N/N PASS

typecheck:
PASS

build:
PASS

git diff --check:
PASS
```

---

## I. Stub Audit

```text
src:
0 unresolved matches

tests:
<explain matches>
```

---

## J. Git

列出所有本轮 commits：

```text
<sha> <message>
...
```

并确认：

```text
local feature SHA
=
origin feature SHA
```

---

## K. Final Verdict

只能二选一：

```text
READY FOR OWNER ACCEPTANCE — SpecCraft v0.9
```

或：

```text
NOT READY — <明确 blocker>
```

禁止写模糊的：

```text
基本完成
大体可用
应该没问题
```

---

# 96. 最终产品语义

v0.9 完成以后，SpecCraft 生命周期应正式成为：

```text
IDEA
↓
REQUIREMENTS
↓
DESIGN
↓
EXECUTION MANUAL
↓
FROZEN RUN
↓
EXECUTION
↓
VERIFICATION
↓
INDEPENDENT REVIEW
↓
OWNER ACCEPTANCE
↓
HANDOFF
```

当计划仍然正确但实现错误：

```text
REWORK
→ SAME RUN
```

当计划本身发生变化：

```text
CHANGE REQUEST
↓
CHANGE SET
↓
DETERMINISTIC IMPACT ANALYSIS
↓
OWNER APPROVAL
↓
SUCCESSOR RUN
↓
NEW FROZEN PLANS
↓
EXECUTION
↓
VERIFICATION
↓
REVIEW
↓
OWNER ACCEPTANCE
↓
CANONICAL PROMOTION
↓
HANDOFF
```

这就是 v0.9 的完整边界。

不要扩张。

不要缩减。

开始施工。
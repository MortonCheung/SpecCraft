# SpecCraft v0.8 — Independent Review Gates & Evidence-Driven Code Review
## Agent 全程施工执行手册

你现在负责 SpecCraft v0.8 的完整施工。

本轮不是简单增加一个“Reviewer Agent”。

真正目标是：

> 在现有 Task Execution / Verification / Worktree / Multi-Executor Runtime 中加入独立、结构化、可审计的 Review Gate，使 Executor 的施工结果必须经过 Verification 和独立 Review，才能被视为 Task 完成或进入 canonical integration。

Review 不拥有产品设计权。

Review 不重新规划 Task。

Review 不修改代码。

Review 不替代 Verification。

Review 不替代 Owner Acceptance。

正式生命周期：

```text
Task Contract
↓
Executor
↓
Task Verification
↓
Independent Review
↓
PASS
↓
Sequential: Task completed

Parallel:
Runtime Commit
↓
Integration
↓
Task completed
```

最高原则：

> Verification proves that the implementation runs.

> Review evaluates whether the verified implementation satisfies its contract and quality bar.

> Owner Acceptance remains the final human authority.

---

# 0. 开工基线

远端：

```text
https://github.com/MortonCheung/SpecCraft.git
```

预期基线：

```text
branch:
feat/v0.7-multi-executor-routing

HEAD:
5df7a13e5a4be47dad77ac6e0bf2fe3972fe49ed
```

新分支：

```text
feat/v0.8-independent-review-gates
```

必须从：

```text
feat/v0.7-multi-executor-routing
```

创建。

先执行：

```bash
git status
git branch --show-current
git rev-parse HEAD
git remote -v
git fetch origin

npm test
npm run typecheck
npm run build
```

已知上一版本最终基线：

```text
344 tests PASS
typecheck PASS
build PASS
```

实际开工必须重新核验，不得机械假设 344。

如果：

```text
SpecCraft v0.7.md
```

仍作为未跟踪施工手册存在：

不要删除。

不要提交。

不要加入项目源码。

---

# 1. 开工 Site Survey

开始编码以前重新阅读真实仓库。

至少检查：

```text
src/core/project.ts

src/core/tasks/
├── types.ts
├── compiler.ts
├── store.ts
├── dispatch.ts
├── orchestrator.ts
└── verification/

src/core/parallel/
├── orchestrator.ts
├── planner.ts
├── types.ts
└── store.ts

src/core/workspaces/
src/core/executors/
src/core/dispatch/
src/core/execution/adapters/
src/core/hooks/
src/core/handoff/

src/cli/
skills/
tests/

README.md
docs/executor-routing.md
docs/parallel-execution.md
docs/worktree-isolation.md

docs/decisions/0006-*
docs/decisions/0007-*
docs/decisions/0008-*
```

重点确认以下真实事实：

```text
sequential:
dispatch
→ verify
→ completed

parallel:
dispatch
→ scope audit
→ verify completeOnPass=false
→ scope audit
→ git mutation guard
→ runtime commit
→ integration
→ completed
```

确认 v0.7：

```text
Executor Assignment
Provider Session
Workspace Attempt
Dispatch Attempt
```

真实结构与施工手册是否一致。

发现普通 Bug：

在对应 Milestone 直接修。

禁止人为制造：

```text
M8.x Bug Fix
```

产品 Milestone。

---

# 2. v0.8 的 Review 边界

必须始终满足：

```text
Review ≠ Verification

Review ≠ Owner Acceptance

Reviewer ≠ Executor

Reviewer Profile ≠ Executor Profile

Reviewer Profile ≠ Adapter

Review Attempt ≠ Dispatch Attempt

Review Attempt ≠ Verification Attempt

Review Gate ≠ Workflow Stage
```

仍然：

```text
16 Workflow Stages
```

不得增加：

```text
review
code-review
review-approval
```

Workflow Stage。

Review 属于：

```text
Implementation Stage
└── Execution Run
    └── Task
        └── Review Gate
```

---

# 3. Task Status 不扩展

继续只有：

```text
pending
ready
in_progress
completed
failed
blocked
```

禁止新增：

```text
reviewing
review_failed
awaiting_review
approved
changes_required
```

这些不是 Task Status。

Review 有自己的 Evidence / Decision。

---

# 4. Task completed 新统一语义

v0.8 起：

> Task completed = 当前施工结果已经满足该 route 的全部 required completion gates。

如果 Review disabled：

保持 v0.7 行为。

Sequential：

```text
Verification PASS
→ completed
```

Review enabled 时：

```text
Verification PASS
↓
所有 Required Review Gates PASS
↓
completed
```

Parallel：

```text
Verification PASS
↓
所有 Required Review Gates PASS
↓
Runtime Commit
↓
Integration PASS
↓
completed
```

Review PASS 本身绝不能：

```text
parallel Task → completed
```

---

# 5. M8.0 — Architecture Freeze / ADR 0009

创建：

```text
docs/decisions/0009-independent-review-gates.md
```

ADR 必须冻结：

```text
Review placement
Reviewer authority
Review Profile
Review Plan
Review Gate
Review Attempt
structured findings protocol
review workspace isolation
failure semantics
rework semantics
legacy compatibility
```

---

# 6. Reviewer Authority

Reviewer 只允许：

```text
读取 Task Contract
读取 Review Snapshot
读取 Task-specific diff
读取 Verification Evidence
检查代码
输出 Findings
```

Reviewer 禁止：

```text
修改代码
修改测试
修改 Execution Manual
修改 Task Graph
修改 Scope
修改 Design
新增 Task
删除 Task
选择 Executor
选择 Reviewer
修改 Verification 命令
执行 Owner Acceptance
```

Reviewer 发现需求本身可能存在问题时：

只允许记录：

```text
finding
```

不能重新设计产品。

---

# 7. Review Scope

v0.8 先固定两个 Review Gate Kind：

```text
spec_compliance
code_quality
```

不实现：

```text
custom prompt gate
security specialist gate
performance specialist gate
UX reviewer
architecture reviewer
```

后续可以扩展。

---

# 8. spec_compliance

只检查：

```text
Task Contract 是否完成
Task Summary 是否满足
是否漏实现
是否出现未经批准的 Scope 扩张
实现是否违背 Execution Guard
Verification 是否与要求相关
实际 Diff 是否与 Task 目标匹配
```

禁止 Reviewer：

```text
创造新需求
改变产品方向
扩大 Scope
```

---

# 9. code_quality

检查：

```text
明显 correctness risk
错误处理
边界条件
测试充分性
维护性
重复逻辑
不必要抽象
YAGNI
安全性（仅与本 Task 实际代码有关）
```

不要因为：

```text
个人代码风格偏好
命名审美
无意义重构偏好
```

产生 blocking finding。

---

# 10. M8.0 提交

```text
feat: M8.0 — independent review gate semantics
```

然后：

```bash
npm test
npm run typecheck
npm run build
```

必须全部通过。

---

# 11. M8.1 — Reviewer Profiles & Frozen Review Plan

新增：

```text
src/core/reviews/
├── types.ts
├── config.ts
├── plan.ts
└── store.ts
```

升级：

```text
src/core/project.ts
```

---

# 12. project.yaml 新配置

新增顶层：

```yaml
review:
  enabled: true

  default_reviewer: primary-reviewer

  reviewers:
    primary-reviewer:
      adapter: claude
      timeout_seconds: 900

    quality-reviewer:
      adapter: codex
      timeout_seconds: 1200

  gates:
    - id: spec
      kind: spec_compliance
      reviewer: primary-reviewer

    - id: quality
      kind: code_quality
      reviewer: quality-reviewer
```

Review section 完全可选。

缺省：

```text
review disabled
```

因此所有旧项目保持 v0.7 行为。

---

# 13. Reviewer Profile

建议：

```ts
interface ReviewerProfileConfig {
  adapter: string;

  model?: string;
  timeoutSeconds?: number;
  extraArgs?: string[];
  sandbox?: string;
}
```

禁止：

```text
API key
Token
credential
Provider Secret
```

---

# 14. Reviewer Profile ≠ Executor Profile

命名空间分离。

例如：

```yaml
execution:
  executors:
    backend:
      adapter: claude

review:
  reviewers:
    quality:
      adapter: claude
```

允许。

二者虽然都使用：

```text
claude
```

但：

```text
backend Executor
≠
quality Reviewer
```

并且绝不能共享 Provider Session。

---

# 15. Reviewer Config 覆盖优先级

```text
Reviewer Profile override
↓
execution.adapters.<adapter>
↓
Adapter implementation default
```

不要复制第二套 Adapter Registry。

仍复用：

```text
manual
codex
claude
opencode
trae
```

Adapter Runtime。

---

# 16. Review Gate Config

```ts
type ReviewGateKind =
  | 'spec_compliance'
  | 'code_quality';

interface ReviewGateConfig {
  id: string;
  kind: ReviewGateKind;
  reviewer: string;
}
```

所有声明 Gate：

默认都是 Required。

本版不实现：

```text
optional gate
warning-only gate
per-task gate override
```

---

# 17. Review Config Validation

必须验证：

```text
enabled == true → gates 非空

gate id 唯一

gate kind 合法

reviewer id 存在

default_reviewer 若存在必须合法

reviewer.adapter 必须是已知 Adapter ID
```

错误必须指出具体：

```text
gate
reviewer
adapter
```

---

# 18. Frozen Review Plan

Task Graph compile 时：

现有：

```text
Task Graph
+
Executor Plan
```

v0.8 增加：

```text
Review Plan
```

路径：

```text
.speccraft/
└── runs/<run-id>/
    └── reviews/
        └── plan.yaml
```

格式建议：

```yaml
version: 1

run_id: run-...
enabled: true
created_at: ...

gates:
  - id: spec
    kind: spec_compliance
    reviewer: primary-reviewer
    adapter: claude

    resolved:
      timeout_seconds: 900

  - id: quality
    kind: code_quality
    reviewer: quality-reviewer
    adapter: codex

    resolved:
      timeout_seconds: 1200
```

---

# 19. Review Plan 冻结

一旦当前 Run 已产生：

```text
dispatch evidence
verification evidence
review evidence
workspace evidence
```

不得重新 compile Review Plan。

必须复用已有 Recompile Guard 思路。

当前 Run 后续：

```text
project.yaml review config
```

即使被修改：

也不得改变已冻结 Review Plan。

新配置只影响未来 Run。

---

# 20. Review Disabled

如果没有：

```text
review:
```

或：

```yaml
review:
  enabled: false
```

则：

```text
no Review Plan
```

所有 v0.7 lifecycle 原样运行。

不要自动生成：

```text
default reviewer
```

---

# 21. M8.1 测试

至少覆盖：

```text
review section absent → disabled

enabled + valid gates → plan generated

duplicate gate → FAIL

unknown reviewer → FAIL

unknown gate kind → FAIL

reviewer adapter resolution precedence

plan roundtrip

plan gate order == config declaration order

execution evidence exists
→ plan cannot silently rebuild
```

提交：

```text
feat: M8.1 — reviewer profiles and frozen review plan
```

---

# 22. M8.2 — Reviewer Preflight & Diagnostics

新增：

```text
src/core/reviews/
├── preflight.ts
└── diagnostics.ts
```

Review enabled 时：

必须在：

```text
implementStart
workspace creation
Task mutation
```

以前完成 Review Preflight。

---

# 23. Review Preflight

流程：

```text
load frozen Review Plan
↓
collect unique adapters
↓
probe each adapter ONCE
↓
capability validation
↓
PASS
```

不要按：

```text
Task × Gate
```

重复 probe。

---

# 24. Manual Reviewer 禁止自动执行

如果：

```text
reviewer.adapter = manual
```

auto execute：

必须 preflight FAIL。

错误：

```text
manual reviewer cannot run automatic review gates
```

不要假装 review PASS。

---

# 25. Reviewer Adapter unavailable

例如：

```text
quality → codex
```

Codex 未安装：

```text
execute
→ preflight blocked
```

必须发生在任何：

```text
implementStart
Task dispatch
workspace creation
```

以前。

不得自动 fallback 到其它 Reviewer。

---

# 26. Capability Guard

如果 Reviewer Profile 声明：

```text
model
```

但 Adapter：

```text
modelSelection == false
```

必须明确 FAIL。

其它 Adapter config 也遵循 v0.7 相同原则。

---

# 27. Review CLI

新增：

```bash
speccraft reviews list
speccraft reviews plan
speccraft reviews doctor
speccraft reviews show <task-id>
```

不要新增：

```text
reviews auto
reviews optimize
reviews vote
reviews debate
```

---

# 28. reviews list

显示 project config：

```text
Gate
Kind
Reviewer
Adapter
```

---

# 29. reviews plan

显示 frozen Run Plan：

```text
Run
Gate
Kind
Reviewer Profile
Adapter
```

---

# 30. reviews doctor

仅 Probe 当前 Review Plan 真正需要的 Adapter。

同一 Adapter：

Probe 一次。

---

# 31. reviews show

显示某 Task：

```text
Gate
Attempts
Latest Decision
Reviewer
Adapter
Findings
Source Verification
```

---

# 32. M8.2 提交

```text
feat: M8.2 — review preflight and diagnostics
```

---

# 33. M8.3 — Exact Task Change Snapshot

这是 v0.8 最重要的底层模块。

新增：

```text
src/core/reviews/
├── snapshot.ts
├── workspace.ts
└── paths.ts
```

Review 不应该拿：

```text
整个 Agent 会话历史
```

而应该拿：

```text
Task Contract
+
Task exact delta
+
Verification Evidence
+
最终代码 Snapshot
```

---

# 34. 为什么不能简单 git diff HEAD

Sequential route 中：

```text
Task A
```

完成以后可能仍是 uncommitted change。

然后：

```text
Task B
```

继续施工。

如果 B Review 简单执行：

```bash
git diff HEAD
```

会同时看到：

```text
A + B
```

无法准确判断 B。

所以必须建立：

```text
Pre-Task Tree
Post-Task Tree
```

---

# 35. 使用 Alternate Git Index

禁止通过真实：

```text
git add
git commit
stash
```

改变用户 working tree。

实现：

```text
captureWorkingTreeTree()
```

使用临时：

```text
GIT_INDEX_FILE
```

算法：

```text
git read-tree HEAD

GIT_INDEX_FILE=<temp>
git add -A -- working-tree
git write-tree
```

注意：

必须排除：

```text
.speccraft/**
```

Runtime state。

实际命令应根据当前 Git/pathspec 最安全形式实现。

不要修改用户真实 index。

---

# 36. Pre Tree

Task dispatch 前：

```text
preTree = snapshot(current working tree)
```

它包含：

```text
当前 HEAD
+
已有未提交项目修改
```

但不包含：

```text
.speccraft runtime state
```

---

# 37. Post Tree

Task Verification PASS 后：

```text
postTree = snapshot(current working tree)
```

于是：

```text
git diff preTree postTree
```

代表：

> 当前 Task 真正引入的变化。

而不是：

> 当前 repo 所有未提交变化。

---

# 38. Exact Changed Paths

同时计算：

```text
git diff --name-only preTree postTree
```

结果用于：

```text
Review Evidence
Scope validation
Handoff
```

---

# 39. Review-enabled Sequential Scope Guard

Review enabled 时：

必须检查：

```text
Task Delta Changed Paths
⊆
Task Declared Scope
```

这样 v0.8 开始：

Sequential Review route 也获得真实 Task Scope Evidence。

Review disabled legacy sequential：

不得突然改变行为。

---

# 40. no_changes

如果：

```text
preTree == postTree
```

Review-enabled Task：

默认 FAIL：

```text
no task changes to review
```

不要让 Reviewer 对空变化直接 PASS。

---

# 41. Synthetic Review Commits

Review Snapshot 不创建真实 branch/ref。

使用：

```text
preCommit = git commit-tree preTree -p sourceHEAD
postCommit = git commit-tree postTree -p preCommit
```

这些：

```text
Git objects only
```

不修改：

```text
branch
HEAD
ref
working tree
real index
```

必须自行提供 Runtime author identity，避免依赖用户 Git author 配置。

---

# 42. Review Workspace

使用：

```text
postCommit
```

创建 detached worktree：

```text
git worktree add --detach <review-workspace> <postCommit>
```

这样 Reviewer workspace 内：

```text
HEAD     = post Task Snapshot
HEAD^    = pre Task Snapshot

git diff HEAD^ HEAD
```

就是当前 Task exact delta。

Reviewer 可以查看：

```text
完整项目文件
当前 Task 最终状态
精确 Task Diff
```

而不会接触真实施工 workspace。

---

# 43. Review Workspace 路径

真实目录：

```text
<project-parent>/
└── .speccraft-review-worktrees/
    └── <project>/
        └── <run>/
            └── <task>/
                └── <gate>/
                    └── attempt-NNN/
```

Review workspace 永远：

```text
detached HEAD
```

不要建 Reviewer branch。

---

# 44. Reviewer Mutation Isolation

Reviewer 即使执行：

```text
修改文件
删除文件
生成文件
```

也只能污染：

```text
Review Workspace
```

不能污染：

```text
Executor Workspace
canonical workspace
```

Reviewer 完成后检查：

```bash
git status --porcelain
```

必须为空。

如果不为空：

```text
reviewer_mutation
→ Review ERROR
```

然后：

```text
force-remove review worktree
```

因为 Review Workspace 是 Runtime-owned disposable snapshot。

不要把 Reviewer 修改带回源代码。

---

# 45. Review Workspace Cleanup

每次 Review Attempt 后：

成功或失败都：

```text
remove review worktree
```

central evidence 保留。

如果 cleanup 失败：

记录 warning。

不要因此把 PASS 改为 FAIL。

---

# 46. Non-Git Project

Review feature 在 v0.8：

要求 Git repository。

如果：

```text
review.enabled == true
```

但项目非 Git：

```text
preflight FAIL
```

Legacy：

```text
review disabled
```

仍允许非 Git sequential 项目。

---

# 47. M8.3 Tests

必须使用真实临时 Git repo 验证：

```text
preTree 不修改真实 index

postTree 不修改 HEAD

preTree → postTree diff 是 exact task delta

之前 Task 的 uncommitted changes
不会出现在新 Task delta

untracked task file 能进入 snapshot

.speccraft runtime state 不进入 snapshot

review workspace HEAD^ → HEAD
等于 Task delta

review workspace 与 source workspace 不同

Reviewer workspace mutation
不会污染 source workspace
```

提交：

```text
feat: M8.3 — exact task review snapshots
```

---

# 48. M8.4 — Structured Review Protocol & Evidence Runtime

新增：

```text
src/core/reviews/
├── protocol.ts
├── package.ts
├── runner.ts
└── lifecycle.ts
```

新增：

```text
skills/task-spec-review/SKILL.md
skills/task-quality-review/SKILL.md
```

---

# 49. Reviewer Package

Reviewer 获得：

```text
Task ID
Task title
Task summary
Task scope
Task dependencies

Execution Guard relevant rules

Gate kind

source Dispatch Attempt
source Verification Attempt

Verification commands
Verification PASS evidence

preTree
postTree

review snapshot workspace
```

Reviewer 不获得：

```text
整个 Planner 会话
Owner 私人聊天
Executor 隐藏 chain-of-thought
其它不相关 Task 历史
```

---

# 50. Review Prompt

必须明确告诉 Reviewer：

```text
你是独立 Reviewer。

你不是 Planner。
你不是 Executor。
你不能修改代码。
你不能扩大 Task Scope。
你不能创造新需求。

你的目标：
检查当前 Task 的 verified implementation。
```

根据 Gate Kind 注入对应 Skill rubric。

---

# 51. Reviewer 可自行查看

Review Workspace 中：

```bash
git status
git diff HEAD^ HEAD
git show HEAD
```

以及项目源码。

不要要求 Runtime 把整个 Diff 塞进 Prompt。

---

# 52. Structured Output Protocol

Reviewer 最终输出必须包含唯一：

````text
```speccraft-review
version: 1
summary: "..."

findings:
  - severity: major
    category: correctness
    path: src/foo.ts
    line: 42
    message: "..."

  - severity: minor
    category: maintainability
    path: src/bar.ts
    message: "..."
```
````

不要允许自由文本作为机器 Gate 结果。

自由文本可以保存：

```text
raw-output.txt
```

但 Gate 只能读机器 block。

---

# 53. Finding Severity

只允许：

```text
blocker
major
minor
```

---

# 54. Finding Category

只允许：

```text
spec
correctness
tests
maintainability
security
scope
```

不要无限扩 enum。

---

# 55. Runtime 决定 Gate Decision

Reviewer 不拥有最终 Gate algorithm。

Runtime 读取 findings：

```text
存在 blocker / major
→ CHANGES_REQUIRED

只有 minor / 无 findings
→ PASS
```

因此 structured block 不需要 Reviewer 自己输出：

```text
PASS
FAIL
```

避免：

```text
verdict 与 findings 矛盾
```

---

# 56. Malformed Protocol

以下任何情况：

```text
没有 block
多个 block
YAML 解析失败
version != 1
severity 非法
category 非法
message 为空
```

结果：

```text
Review ERROR
```

绝不能默认 PASS。

---

# 57. Review Attempt Evidence

路径：

```text
.speccraft/
└── runs/<run>/
    └── tasks/<task>/
        └── reviews/
            └── <gate-id>/
                └── attempt-001/
                    ├── manifest.yaml
                    ├── task-contract.md
                    ├── diff.patch
                    ├── verification.md
                    ├── reviewer-prompt.md
                    ├── raw-output.txt
                    ├── stdout.log
                    ├── stderr.log
                    └── findings.yaml
```

---

# 58. Review Attempt Manifest

至少：

```yaml
version: 1

attempt: 1

run_id: ...
task_id: ...
gate_id: spec
gate_kind: spec_compliance

reviewer_profile: primary-reviewer
adapter: claude

decision: pass

source_dispatch_attempt: 3
source_verification_attempt: 2

workspace_attempt: 1   # parallel 时存在

pre_tree: ...
post_tree: ...
pre_commit: ...
post_commit: ...

started_at: ...
finished_at: ...

session_id: ...
finding_count: 2
blocking_findings: 0
```

Review ERROR：

```yaml
decision: error
error_code: protocol_invalid
```

---

# 59. Attempt Append-only

同：

```text
Task
+
Gate
```

每次 Review：

```text
attempt-001
attempt-002
...
```

不得覆盖。

使用原子目录 reservation。

不要只：

```text
readdir.length + 1
```

---

# 60. Reviewer Provider Session

每个 Review Attempt：

**永远 fresh session。**

禁止 Reviewer resume。

即使：

```text
same Task
same Gate
same Reviewer
```

第二次 review：

也必须：

```text
new Provider Session
```

原因：

Independent Review 应避免携带上一轮 Reviewer 上下文偏差。

---

# 61. Executor Session ≠ Reviewer Session

即使：

```text
Executor adapter = claude
Reviewer adapter = claude
```

也必须：

```text
Executor Session
≠
Review Session
```

不能 lookup dispatch session。

Review Runtime 有独立调用 Evidence。

---

# 62. Review Runner

不要复用：

```text
Dispatch Attempt
```

作为 Review Attempt。

可以复用底层：

```text
Adapter.buildInvocation
process runner
Adapter.normalize
```

但 Evidence Namespace 独立。

不要让 Review Invocation 增加：

```text
Task dispatchAttempts
```

---

# 63. Reviewer Failure

Provider：

```text
spawn error
timeout
non-zero exit
normalize fail
protocol invalid
reviewer mutation
```

统一：

```text
Review ERROR
```

Task：

```text
failed
```

Review disabled 时不影响旧行为。

---

# 64. M8.4 Tests

覆盖：

```text
valid no finding → PASS

minor only → PASS

major → CHANGES_REQUIRED

blocker → CHANGES_REQUIRED

malformed → ERROR

invalid severity → ERROR

multiple machine blocks → ERROR

Reviewer session fresh every attempt

review attempt append-only

review attempt 不增加 dispatch attempt

reviewer mutation → ERROR
```

提交：

```text
feat: M8.4 — structured independent review runtime
```

---

# 65. M8.5 — Sequential Review Gates

升级：

```text
src/core/tasks/orchestrator.ts
```

不要破坏 legacy route。

---

# 66. Sequential Legacy

Review disabled：

保持：

```text
dispatch
↓
verify completeOnPass=true
↓
completed
```

旧测试尽量不需要改。

---

# 67. Review-enabled Sequential

改成：

```text
capture preTree

↓
dispatch

↓
Task Verification
completeOnPass = false

↓
capture postTree

↓
exact delta scope audit

↓
Review Gate 1

↓ PASS
Review Gate 2

↓ PASS
Task completed
```

---

# 68. Review FAIL

如果任何 Gate：

```text
CHANGES_REQUIRED
或 ERROR
```

则：

```text
Task → failed
```

后续 dependent：

由现有 Dependency Engine：

```text
→ blocked
```

不要创建：

```text
Review Stage
```

---

# 69. Gate 顺序

Gate 严格按：

```text
Review Plan declaration order
```

执行。

如果：

```text
spec → CHANGES_REQUIRED
```

本轮不要再执行：

```text
quality
```

避免无意义 Token 消耗。

下一次 rework：

所有 Gate 从第一项重新运行。

---

# 70. Completion

只有：

```text
Verification PASS
+
all configured gates PASS
```

Sequential Task 才：

```text
completed
```

---

# 71. Review Result 必须绑定当前施工版本

Gate PASS 必须记录：

```text
source_dispatch_attempt
source_verification_attempt
```

旧 Review PASS：

不能用于新 Dispatch / 新 Verification。

---

# 72. Review Plan Satisfaction

实现类似：

```text
isCurrentReviewSatisfied(
  task,
  latestDispatch,
  latestVerification
)
```

必须保证：

每个 required gate 都存在：

```text
decision = pass
source_dispatch_attempt == latest dispatch
source_verification_attempt == latest verification
```

---

# 73. Sequential E2E

```text
A → B
```

A：

```text
verify PASS
spec PASS
quality PASS
→ completed
```

B：

同样。

断言：

Review 发生在：

```text
Verification 之后
Task completed 之前
```

提交：

```text
feat: M8.5 — sequential task review gates
```

---

# 74. M8.6 — Parallel Review Gates

升级：

```text
src/core/parallel/orchestrator.ts
```

当前真实顺序：

```text
dispatch
↓
pre scope audit
↓
verify
↓
post scope audit
↓
git mutation guard
↓
runtime commit
↓
integration
```

改成：

```text
dispatch
↓
pre scope audit
↓
verify
↓
post scope audit
↓
capture postTree
↓
Independent Review Gates
↓
git mutation guard
↓
runtime commit
↓
integration
```

PreTree：

必须在：

```text
dispatch
```

以前 capture。

---

# 75. Parallel Review FAIL

如果：

```text
Review CHANGES_REQUIRED
```

则：

```text
Workspace status = failed
failure_phase = review

Task = failed

NO runtime commit
NO integration
```

worktree retained。

---

# 76. Review ERROR

同样：

```text
Workspace failed
Task failed
NO integration
```

Evidence 保留。

---

# 77. Review PASS

所有 Gate PASS：

才允许：

```text
Git Mutation Guard
stageAndAudit
Runtime Commit
Integration
```

---

# 78. Hard Invariant

必须显式测试：

```text
Task Verification PASS
+
Review not PASS

→ taskCommit MUST NOT exist
```

以及：

```text
integrationCommit MUST NOT exist
```

---

# 79. Parallel Wave

同一个 Wave：

Task A / Task B 的 Review 可以发生在各自 isolated execution 内。

因此：

```text
Review 并发
```

天然受：

```text
current wave size
```

限制。

v0.8 不实现：

```text
Reviewer-specific concurrency limiter
```

后续再考虑。

---

# 80. Same Adapter Different Roles

例如：

```text
Task B Executor:
claude

Task B Reviewer:
claude
```

允许。

但必须：

```text
different session
different evidence namespace
different role
```

---

# 81. Parallel E2E

Graph：

```text
A
↓
B + C
↓
D
```

B/C：

```text
verification PASS
review PASS
```

断言：

```text
B/C Review 都发生在自己的 review snapshot workspace

Task Workspace 不被 Reviewer 修改

Review PASS 后才 Runtime Commit

Integration 后才 completed
```

提交：

```text
feat: M8.6 — parallel independent review gates
```

---

# 82. M8.7 — Review Feedback & Rework Loop

Review 的目标不是：

```text
产生报告以后没人使用
```

必须把 findings 重新带回 Executor。

---

# 83. Latest Blocking Feedback

实现：

```text
compileLatestReviewFeedback(taskId)
```

只读取最近：

```text
CHANGES_REQUIRED
```

Gate 中的：

```text
blocker
major
```

Finding。

minor：

可以展示，但不要作为 rework 核心指令。

---

# 84. Executor Retry Prompt

Task：

```text
review failed
↓
tasks reopen <id>
↓
next dispatch
```

新的 Executor Prompt 增加：

```text
## Previous Review Findings

Gate: spec

- [major] src/foo.ts:42 ...
- [blocker] src/bar.ts ...
```

但同时必须明确：

```text
Review findings are technical evidence,
not permission to change approved Product/Design/Scope.

Verify each finding against the actual codebase
before implementing changes.
```

---

# 85. 禁止 Reviewer 改 Task Contract

如果 finding 要求：

```text
添加未批准功能
改变产品设计
扩大 Scope
```

Executor 不应盲目实施。

它只能：

```text
在现有 Task Contract 内修复
```

否则由 Owner/Planner 重新走上游变更流程。

---

# 86. Review Rework

同一 Task：

```text
Task ID unchanged
Run ID unchanged
Executor Assignment unchanged
```

Parallel pre-integration Review FAIL：

```text
Workspace Attempt 默认复用
```

因为：

```text
failed pre-integration workspace
```

已符合 v0.6 reuse 语义。

---

# 87. New Review Attempt

返工以后：

```text
new Dispatch Attempt
new Verification Attempt
new Review Attempt
```

但：

```text
same Task
same Run
same Workspace Attempt（pre-integration retry）
```

可能成立。

Review Session：

始终 fresh。

---

# 88. Old Review PASS invalidation

新 Dispatch 后：

所有旧：

```text
Review PASS
```

仍保留 Evidence，

但不能满足新施工版本。

因为：

```text
source_dispatch_attempt
source_verification_attempt
```

已经不同。

---

# 89. Owner Rework

Task 已：

```text
review PASS
integrated
completed
```

之后 Owner Reject：

```text
tasks reopen --cascade
```

下一施工：

```text
new Workspace Attempt
new Verification
new Review Attempts
new Reviewer Sessions
```

旧 Review History 保留。

---

# 90. M8.7 Runtime Integration

升级：

```text
status
next
tasks show
validate
handoff
aggregate execution report
hooks
```

---

# 91. status

新增简要：

```text
Review:
  enabled
  gates: spec, quality
  failed tasks: 1
```

不要把所有 Finding 打到 status。

---

# 92. tasks show

增加：

```text
Reviews:

spec:
  attempts: 2
  latest: PASS

quality:
  attempts: 1
  latest: CHANGES_REQUIRED
```

---

# 93. next

如果 Task 因 Review failed：

输出：

```text
Task api requires review rework.

Inspect:
speccraft reviews show api

Then:
speccraft tasks reopen api
```

不要自动 reopen。

---

# 94. validate 新 invariant

至少：

```text
Review Plan run_id == Run ID

Gate IDs unique

Gate reviewer exists

Gate adapter exists

Review attempt Task exists

Review attempt Gate exists

Review attempt reviewer == frozen plan

Review attempt adapter == frozen plan

Review attempt source dispatch exists

Review attempt source verification exists

Review PASS requires source verification PASS

Task completed with review enabled
→ all required gates currently satisfied

Parallel workspace committed/integrated
→ all required gates currently satisfied

Review changes_required
→ cannot itself mark Task completed

Review ERROR
→ cannot count as PASS

Old review PASS
→ cannot satisfy newer dispatch/verify version

Reviewer session
→ must not equal Executor session

Reviewer mutation
→ cannot produce PASS

16 Workflow stages unchanged
```

---

# 95. Handoff

新增：

```text
review-history.md
```

内容：

```text
Task
Gate
Reviewer
Adapter
Review Attempts
Source Dispatch
Source Verification
Decision
Blocking Findings
Minor Findings
Review Session
```

确定性生成。

不调用 AI。

---

# 96. Aggregate Execution Report

Task 汇总增加：

```text
review:
spec PASS
quality PASS
```

只引用 Evidence。

不要让 AI 二次总结。

---

# 97. Hooks

Review 是新的真实生命周期边界。

允许新增且仅新增：

```text
before_review
after_review
```

before：

blocking。

after：

non-rollback。

Hook env：

```text
SPECCRAFT_REVIEW_GATE
SPECCRAFT_REVIEW_ATTEMPT
SPECCRAFT_REVIEWER_PROFILE
SPECCRAFT_ADAPTER
SPECCRAFT_TASK_ID
SPECCRAFT_RUN_ID
```

不要创建：

```text
before_review_snapshot
after_review_snapshot
before_review_parse
...
```

事件爆炸。

提交：

```text
feat: M8.7 — review feedback and runtime integration
```

---

# 98. M8.8 — Failure & Independence Semantics

必须专门验证故障。

---

# 99. Reviewer unavailable

```text
Task Executor available

Reviewer adapter unavailable
```

结果：

```text
Review preflight FAIL
```

必须发生在：

```text
implementStart 前
```

证明：

```text
0 dispatch
0 workspace
0 task mutation
```

---

# 100. Reviewer spawn failure

Executor：

```text
PASS
```

Verification：

```text
PASS
```

Reviewer：

```text
spawn_error
```

结果：

```text
Review ERROR
Task failed
```

Parallel：

```text
no taskCommit
no integration
```

---

# 101. Reviewer malformed output

Reviewer 返回普通文字：

```text
Looks good.
```

没有：

```text
speccraft-review block
```

结果：

```text
Review ERROR
```

绝不能 PASS。

---

# 102. Reviewer mutation

Fake Reviewer：

修改 Review Workspace 文件。

结果：

```text
reviewer_mutation
Review ERROR
```

同时必须证明：

```text
Executor source workspace unchanged

canonical unchanged

Reviewer mutation discarded with review workspace
```

---

# 103. Major Finding

Reviewer：

```yaml
severity: major
```

结果：

```text
CHANGES_REQUIRED
Task failed
```

Dependent：

```text
blocked
```

---

# 104. Minor Finding

Reviewer仅返回：

```yaml
severity: minor
```

Gate：

```text
PASS
```

Finding 保留 Evidence。

---

# 105. Gate short-circuit

配置：

```text
spec
quality
```

如果：

```text
spec CHANGES_REQUIRED
```

必须断言：

```text
quality review attempt count == 0
```

本轮。

---

# 106. Rework

修复后：

```text
new dispatch
new verify
spec PASS
quality PASS
```

旧 Changes Required Evidence 仍在。

---

# 107. No Reviewer Resume

同 Gate 两次 review：

```text
session1 != session2
```

即使：

```text
same Reviewer Profile
same Adapter
same Task
```

---

# 108. Executor / Reviewer same Adapter

使用：

```text
fake-alpha
```

同时作为：

```text
Executor
Reviewer
```

断言：

```text
Review receivedSessionId == undefined

Review Session != Executor Session
```

---

# 109. No Auto Fallback

Reviewer adapter failure：

即使存在其它 Reviewer：

不得：

```text
automatic fallback
```

---

# 110. M8.8 提交

```text
feat: M8.8 — review failure and independence semantics
```

---

# 111. M8.9 — Docs + Final DoD

新增：

```text
docs/review-gates.md
```

更新：

```text
README.md
docs/task-orchestration.md
docs/parallel-execution.md
docs/executor-routing.md
docs/agent-adapters.md
```

README：

```text
v0.1 Workflow
v0.2 Execution + Verification
v0.3 Acceptance + Handoff
v0.4 Agent Adapters + Hooks
v0.5 Task Graph
v0.6 Safe Parallel Execution
v0.7 Multi-Executor Routing
v0.8 Independent Review Gates
```

---

# 112. Review 文档必须明确

```text
Review ≠ Verification
Review ≠ Owner Acceptance
Reviewer ≠ Executor
```

以及：

```text
Review enabled is opt-in.
```

旧项目默认不发生行为变化。

---

# 113. 权威 E2E A — Sequential PASS

```text
Task A
↓
Executor alpha
↓
Verification PASS
↓
spec reviewer PASS
↓
quality reviewer PASS
↓
completed
```

断言真实 Evidence 顺序。

---

# 114. E2E B — Sequential Changes Required → Rework

第一轮：

```text
dispatch PASS
verify PASS
spec major finding
→ CHANGES_REQUIRED
→ task failed
```

然后：

```text
reviews show
tasks reopen
```

第二轮 Executor Prompt：

必须包含旧 Review blocker/major findings。

Executor 修复。

然后：

```text
new verification
new spec review
new quality review
PASS
```

Task completed。

---

# 115. E2E C — Parallel Review Gate

Graph：

```text
A
↓
B + C
↓
D
```

B/C：

```text
executor PASS
verify PASS
review PASS
```

必须断言：

```text
Review 在 Runtime Commit 前完成

Review PASS 才存在 taskCommit

integration 后 completed
```

---

# 116. E2E D — Parallel Review Failure

Task B：

```text
verify PASS
review major
```

断言：

```text
workspace failed
failure_phase = review
task failed
taskCommit absent
integrationCommit absent
canonical 不包含 B change
```

---

# 117. E2E E — Reviewer Mutation Isolation

Fake Reviewer：

```text
修改 Review Workspace
```

断言：

```text
Review ERROR

source Task Workspace unchanged

canonical unchanged

review workspace removed
```

---

# 118. E2E F — Malformed Protocol

Reviewer：

```text
普通文字
```

结果：

```text
ERROR
not PASS
```

---

# 119. E2E G — Same Adapter Independent Session

```text
Executor = fake-alpha
Reviewer = fake-alpha
```

断言：

```text
executorSession != reviewSession

Reviewer never receives executor session id
```

---

# 120. E2E H — Gate Order

```text
spec
quality
```

第一轮：

```text
spec major
```

断言：

```text
quality not executed
```

第二轮：

```text
spec PASS
quality PASS
```

---

# 121. E2E I — Owner Rework

第一轮：

```text
execute
verify
reviews PASS
integrate
Run verify
Owner accept/reject path
```

Owner reject 后：

```text
reopen Task
```

必须：

```text
new Workspace Attempt
new Dispatch
new Verification
new Review Attempts
fresh Review Sessions
```

旧 Review PASS 不得自动满足新版本。

---

# 122. Legacy Regression

建立完全没有：

```text
review:
```

的 v0.7 项目。

必须证明：

```text
sequential
parallel
multi-executor
rework
acceptance
handoff
```

全部旧行为不变。

---

# 123. Hard DoD Assertions

必须显式测试：

```text
16 Workflow Stages unchanged

Task Status remains six states

Review disabled → v0.7 behavior unchanged

Review enabled sequential:
Verification PASS != completed until Review PASS

Review enabled parallel:
Verification PASS != commit
Review PASS required before Runtime Commit
Integration required before completed

Reviewer never writes source workspace

Reviewer uses detached isolated review workspace

Reviewer receives exact Task delta

Review input does not contain whole Agent session history

Reviewer Session never resumes

Executor Session != Reviewer Session

Review PASS is bound to current dispatch + verification

Old Review PASS cannot satisfy new work

Major/Blocker blocks

Minor does not block

Malformed output cannot PASS

Review failure does not fallback

Review Gate is not Workflow Stage

Review does not replace Owner Acceptance
```

---

# 124. Dependency Constraints

继续禁止新增：

```text
database
sqlite
redis
queue service

LangChain
LangGraph
CrewAI
AutoGen

OpenAI SDK
Anthropic SDK

simple-git
isomorphic-git
nodegit
execa

uuid
nanoid
```

优先：

```text
Node standard library
existing js-yaml
existing Adapter Runtime
existing Git spawn helpers
```

---

# 125. Reviewer Workspace 不使用容器

不要引入：

```text
Docker
VM
sandbox service
```

Review Isolation 由：

```text
synthetic Git snapshot
+
detached worktree
```

实现。

---

# 126. Real Provider Smoke

最终执行：

```bash
speccraft adapters doctor
speccraft executors doctor
speccraft reviews doctor
```

如实报告：

```text
PASS
FAIL
SKIPPED
```

真实 Provider 不属于权威 DoD。

权威 E2E：

使用 fake adapters / fake reviewers。

---

# 127. Milestone Commit

建议：

```text
feat: M8.0 — independent review gate semantics

feat: M8.1 — reviewer profiles and frozen review plan

feat: M8.2 — review preflight and diagnostics

feat: M8.3 — exact task review snapshots

feat: M8.4 — structured independent review runtime

feat: M8.5 — sequential task review gates

feat: M8.6 — parallel independent review gates

feat: M8.7 — review feedback and runtime integration

feat: M8.8 — review failure and independence semantics

docs/test: M8.9 — review gate docs and v0.8 DoD
```

普通 Bug：

归当前 Milestone。

---

# 128. 每个 Milestone Gate

每个 M8.x 完成：

```bash
npm test
npm run typecheck
npm run build
git status
```

不绿：

禁止继续。

---

# 129. 最终回归

M8.9 后至少运行：

```bash
npm test
npm run typecheck
npm run build
git status
```

建议连续完整 test：

```text
至少 2 次
```

确保 Review worktree / parallel tests 无 flaky。

---

# 130. Git

最终分支：

```text
feat/v0.8-independent-review-gates
```

推送：

```bash
git push -u origin feat/v0.8-independent-review-gates
```

禁止：

```text
force push
自动 merge main
修改 token
修改 SSH
修改 remote
```

施工手册文件：

```text
SpecCraft v0.8.md
```

如果作为会话输入/未跟踪文件存在：

不要提交。

---

# 131. 最终汇报格式

完成以后返回：

```text
# SpecCraft v0.8 最终汇报
```

必须包含：

## 1. Baseline

```text
branch
HEAD
tests
typecheck
build
```

## 2. Final

同上。

## 3. M8.0–M8.9 commits

SHA + message。

## 4. Reviewer Profile

真实 project.yaml schema。

## 5. Review Plan

真实 frozen plan evidence。

## 6. Snapshot Runtime

说明：

```text
preTree
postTree
preCommit
postCommit
review workspace
```

## 7. Review Protocol

说明：

```text
structured findings
decision derivation
malformed behavior
```

## 8. Sequential Evidence

真实：

```text
Verification → Review → completed
```

## 9. Parallel Evidence

真实：

```text
Verification
→ Review
→ Commit
→ Integration
→ completed
```

## 10. Rework Evidence

Review fail → reopen → findings injected → re-review。

## 11. Session Evidence

证明：

```text
Executor Session != Reviewer Session
Review Session never resumes
```

## 12. Mutation Isolation

证明 Reviewer 写文件不会污染源代码。

## 13. Failure Evidence

```text
reviewer unavailable
spawn error
malformed
major/blocker
no fallback
```

## 14. Legacy Regression

v0.7 review-disabled 项目行为不变。

## 15. Real Provider Smoke

PASS / FAIL / SKIPPED。

## 16. Git

status / branch / push。

## 17. Known Limitations

只写真实限制。

## 18. Explicitly Not Implemented

必须明确：

```text
Owner review override / waiver
Reviewer-specific concurrency limiter
custom review gate
security-specialist Reviewer
architecture Reviewer
AI debate
AI voting
automatic review fallback
remote reviewer farm
SaaS backend
database
Provider SDK
```

---

# 132. v0.8 Definition of Done

只有全部满足才能宣布：

```text
SpecCraft v0.8 complete
```

必须满足：

```text
Review config opt-in
Legacy review-disabled compatible

Frozen Review Plan exists when enabled

Reviewer Profile separate from Executor Profile

Reviewer Profile resolves through existing Adapter Runtime

Review preflight before mutation

Reviewer unavailable blocks before implementation

Exact Task pre/post snapshots exist

Task delta excludes previous Task changes

Review Workspace isolated from source

Reviewer mutation cannot contaminate source

Review Attempt evidence append-only

Review machine protocol strict

Major / blocker → CHANGES_REQUIRED

Minor-only → PASS

Malformed output → ERROR

Review Session always fresh

Executor Session != Reviewer Session

Sequential Verification PASS
does not complete Task before Review

Parallel Verification PASS
does not create taskCommit before Review

Parallel Review PASS
required before Runtime Commit

Integration required before parallel completed

Review fail blocks dependents

Review feedback reaches retry Executor

Old Review PASS invalidated by new dispatch/verify

Owner rework produces new reviews

status / next / tasks show support Review

validate includes Review invariants

handoff includes review-history.md

Aggregate report includes review evidence

before_review / after_review hooks work

16 Workflow stages unchanged

Task status remains six states

No database

No Provider SDK

All legacy tests PASS

New Review E2E PASS

npm test PASS

typecheck PASS

build PASS

Git tracked working tree clean

feature branch successfully pushed
```

任何一项没有满足：

不要宣布 v0.8 完成。

做到这里以后停止。

不要自行开始 v0.9。
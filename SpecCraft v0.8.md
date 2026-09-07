# SpecCraft v0.8 — Final Integrity Hardening
## 最终完整性加固施工指令

你现在接手 SpecCraft v0.8 的最终完整性加固。

本轮不是增加新功能，不进入 v0.9，也不是继续围绕已有测试做局部修补。

你的任务是：

> 以当前 `feat/v0.8-independent-review-gates` 分支为真实基线，对 v0.8 Independent Review Gates 的 Snapshot、Evidence、Parallel Runtime、Preflight、Validation、Handoff、Hooks 和权威 E2E 做最后一次系统性收口，使实现真正满足 `SpecCraft v0.8.md` 已冻结的设计，而不是仅让已有测试通过。

---

# 0. 当前基线

远端：

```text
https://github.com/MortonCheung/SpecCraft.git
```

当前目标分支：

```text
feat/v0.8-independent-review-gates
```

当前已知远端 HEAD：

```text
84c82e6efe63041814599b0bb661eddb12ebbffa
```

这个提交已经完成：

```text
Sequential Review 主链
Reviewer stdin 修复
Review evidence path 修复
Review FAIL → Task failed
Review PASS completion gate
Dispatch / Verification evidence binding
同 Run retry attempt binding
Review disabled legacy regression
```

已有新增真实 E2E：

```text
Test A
Reviewer 在 Review 时观察 Task = in_progress

Test B
Review FAIL：
in_progress → failed

Test C
首轮 Review evidence：
source_dispatch_attempt = 1
source_verification_attempt = 1

Test D
同 Run retry：
dispatch = 2
verification = 2
review attempt = attempt-002

Test E
Review disabled：
Verification PASS → completed
```

上一轮报告：

```text
477/477 tests PASS
typecheck PASS
build PASS
```

但这不能视为 v0.8 DoD 已完成。

当前已经确认仍有系统级缺口。

---

# 1. 本轮最高原则

不要围着现有测试打补丁。

必须：

```text
先修语义
再修实现
再补真实 E2E
最后重新跑 DoD
```

禁止：

```text
为了让测试通过修改测试期望
删除失败测试
降低 invariant
把 ERROR 改成 warning
绕过 Parallel Review
用 mock 替代本应真实执行的 Git 行为
只验证 helper、不验证 orchestrator
```

如果测试暴露产品 Bug：

```text
修产品代码
```

如果发现旧实现已经与冻结规格冲突：

```text
以 SpecCraft v0.8.md 为准
```

但不要扩展 v0.8 范围，不新增未经设计的新能力。

---

# 2. 开工前必须重新 Site Survey

先执行：

```bash
git status
git branch --show-current
git rev-parse HEAD
git remote -v
git fetch origin
git rev-parse origin/feat/v0.8-independent-review-gates
```

确认：

```text
local HEAD
=
origin/feat/v0.8-independent-review-gates
=
84c82e6...
```

如果远端已有更新：

```text
立即以真实远端最新 HEAD 为基线重新审阅
不要机械 reset 到 84c82e6
```

然后先跑：

```bash
npm test -- --test-concurrency=2
npm run typecheck
npm run build
git diff --check
```

确认当前基线。

不要先改代码。

重新阅读至少：

```text
SpecCraft v0.8.md
docs/decisions/0009-independent-review-gates.md

src/core/reviews/
├── snapshot.ts
├── runner.ts
├── sequential.ts
├── lifecycle.ts
├── package.ts
├── feedback.ts
├── attempt.ts
├── preflight.ts
├── plan.ts
├── store.ts
├── paths.ts
├── diagnostics.ts
└── types.ts

src/core/tasks/
├── orchestrator.ts
├── scope.ts
├── rework.ts
├── store.ts
└── verification/

src/core/parallel/
├── orchestrator.ts
└── ...

src/core/workspaces/
├── git.ts
├── store.ts
└── ...

src/core/execution/adapters/
├── types.ts
├── registry.ts
└── runner / adapters

src/core/hooks/
src/core/handoff/
src/core/init.ts
src/cli/commands.ts

tests/
```

特别核对下面每一个问题仍是否存在。

如果真实代码已发生变化：

```text
以现场代码为准
但必须解释差异
```

---

# 3. P0 — 重做 Exact Task Snapshot Foundation

这是本轮第一优先级。

当前 Snapshot 不能继续建立在：

```ts
path.join(workspaceRoot, '.git')
```

这种假设上。

原因：

Parallel workspace 使用：

```bash
git worktree add
```

linked worktree 的：

```text
<workspace>/.git
```

通常是一个 gitfile，而不是目录。

因此这种：

```text
<workspace>/.git/review-pre.index
```

不能作为 alternate index 路径。

---

## 3.1 Alternate Index 必须 Worktree-safe

重新设计：

```ts
captureTreeSnapshot()
```

不要假设：

```text
workspaceRoot/.git
```

是目录。

推荐方案：

Runtime-owned alternate index 放在：

```text
.speccraft runtime-controlled temp area
```

或者通过 Git：

```bash
git rev-parse --git-path ...
```

解析真实 Git metadata。

要求：

```text
canonical repo 可用
linked worktree 可用
detached worktree 可用
```

不要污染：

```text
real index
working tree
HEAD
branch
```

---

## 3.2 Alternate Index 必须先 read-tree HEAD

算法必须恢复为冻结规格：

```bash
GIT_INDEX_FILE=<runtime-temp-index> git read-tree HEAD
GIT_INDEX_FILE=<runtime-temp-index> git add -A ...
GIT_INDEX_FILE=<runtime-temp-index> git write-tree
```

不能继续：

```text
empty alternate index
→ git add -A
```

因为那无法保证：

```text
HEAD tracked state
+
working tree current state
```

完整映射。

新增真实测试：

```text
tracked file
后来进入 .gitignore
working tree 未删除

Snapshot 仍必须包含该 tracked file
```

---

## 3.3 必须强制排除 `.speccraft/**`

不能依赖用户 `.gitignore`。

测试项目必须专门构造：

```text
.gitignore 中没有 .speccraft/
```

然后：

```bash
speccraft init
```

再 capture snapshot。

断言：

```text
.speccraft/state.yaml
.speccraft/runs/**
.speccraft/logs/**
```

全部不进入：

```text
tree
diff
changed paths
review snapshot
```

可以使用 Git pathspec exclude，例如安全的：

```text
:(exclude).speccraft/**
```

但必须验证对：

```text
untracked
tracked
nested runtime files
```

行为符合预期。

---

# 4. P0 — Synthetic Commit Parent Chain

当前：

```text
preCommit
postCommit
```

不能继续是两个无父提交的 root commit。

必须满足：

```text
sourceHEAD
   ↓
preCommit
   ↓
postCommit
```

或者冻结规格中等价的 parent chain：

```text
preCommit  = commit-tree preTree  -p sourceHEAD
postCommit = commit-tree postTree -p preCommit
```

于是 Review Workspace：

```text
HEAD  = postCommit
HEAD^ = preCommit
```

必须成立。

新增真实测试：

```bash
git rev-parse HEAD
git rev-parse HEAD^
git diff HEAD^ HEAD
```

断言：

```text
HEAD == postCommit
HEAD^ == preCommit
diff HEAD^ HEAD == exact task delta
```

---

## 4.1 Runtime Git Identity

`git commit-tree` 不得依赖用户配置：

```text
user.name
user.email
```

Runtime 自己提供：

```text
GIT_AUTHOR_NAME
GIT_AUTHOR_EMAIL
GIT_COMMITTER_NAME
GIT_COMMITTER_EMAIL
```

使用固定 SpecCraft Runtime identity。

例如：

```text
SpecCraft Runtime
speccraft@local
```

具体值保持清晰、固定、无用户身份依赖即可。

测试：

临时 repo：

```text
不配置 git user.name
不配置 git user.email
```

Snapshot synthetic commit 仍必须成功。

---

# 5. P0 — Exact Changed Paths + Sequential Scope Audit

当前 Review-enabled Sequential route 必须补齐：

```text
Task Delta Changed Paths
⊆
Task Declared Scope
```

顺序：

```text
capture preTree
↓
dispatch
↓
verification PASS
↓
capture postTree
↓
compute exact delta
↓
compute changed paths
↓
scope audit
↓
Review Gates
```

复用已有：

```ts
pathMatchesScope()
```

不要新造另一套 Scope Engine。

---

## 5.1 Scope Violation 语义

例如：

Task：

```yaml
scope:
  paths:
    - src/api/**
```

实际改变：

```text
src/api/index.ts
package.json
```

必须：

```text
scope audit FAIL
Task failed
Review attempt count = 0
```

不要把 Scope violation 交给 Reviewer 自己判断。

因为：

```text
Scope Guard
是 Runtime deterministic invariant
不是 LLM judgment
```

---

## 5.2 no_changes

Review enabled 时：

```text
preTree == postTree
```

仍必须 FAIL：

```text
no task changes to review
```

但确保这个判断不被 `.speccraft runtime changes` 干扰。

---

# 6. P0 — Review Attempt Finalization 必须保证 Evidence Integrity

当前重大问题：

```text
runReviewGate()
先写 PASS manifest
↓
外层才 check reviewer mutation
↓
Runtime 返回 ERROR
```

这会产生：

```text
运行时 ERROR
磁盘 manifest PASS
```

禁止继续存在。

---

## 6.1 重构 Review Attempt 生命周期

推荐结构：

```text
reserve attempt
↓
create review workspace
↓
prepare package
↓
before_review hook
↓
run reviewer
↓
normalize provider output
↓
parse review protocol
↓
check reviewer mutation / HEAD drift
↓
derive FINAL decision
↓
write final manifest ONCE
↓
after_review hook
↓
cleanup workspace
```

关键原则：

> `manifest.yaml` 中的 `decision` 必须是整个 Review Attempt 的最终 Runtime decision。

不能在 mutation guard 之前写最终 PASS。

---

## 6.2 Reviewer Mutation 必须写成正式 ERROR Evidence

如果 Reviewer 修改 workspace：

```text
decision: error
error_code: reviewer_mutation
```

并保留：

```text
stdout
stderr
raw-output
findings（如有）
```

这样即使 Reviewer 输出：

```text
PASS
```

最终 Runtime 仍记录：

```text
ERROR
```

---

# 7. P0 — Mutation Guard 不得只检查 dirty state

当前：

```bash
git status --porcelain
```

只可以发现未提交修改。

Reviewer 可以：

```bash
修改文件
git add
git commit
```

随后：

```bash
git status --porcelain
```

为空。

因此 Mutation Guard 必须同时检查：

```text
working tree clean
AND
HEAD == expected postCommit
```

至少：

```bash
git status --porcelain
git rev-parse HEAD
```

如果：

```text
HEAD != expectedReviewHead
```

同样：

```text
reviewer_mutation
Review ERROR
```

新增真实 E2E：

### Dirty mutation

Fake Reviewer：

```text
修改文件
不 commit
```

结果：

```text
ERROR
```

### Commit mutation

Fake Reviewer：

```text
修改文件
git add
git commit
```

结果仍必须：

```text
ERROR
```

同时：

```text
source executor workspace unchanged
canonical workspace unchanged
review workspace removed
manifest decision == error
```

---

# 8. P0 — Review Preflight 必须包含 Git Readiness

Review enabled 的 v0.8 要求：

```text
Git repository
+
resolvable HEAD
```

因此 Review Preflight 不能只接：

```ts
plan
```

它必须获得：

```text
projectRoot
```

并验证：

```bash
git rev-parse --is-inside-work-tree
git rev-parse HEAD
```

必要时验证 Snapshot 所需能力。

---

## 8.1 Fail-before-mutation

Non-Git Review-enabled 项目：

```text
speccraft execute
```

必须在任何以下行为之前失败：

```text
implementStart
Task status mutation
Dispatch Attempt
Workspace creation
Review workspace creation
```

新增权威测试，断言：

```text
0 dispatch attempts
0 workspace attempts
0 review attempts
implementation stage unchanged
task status unchanged
```

Review disabled 的 non-Git sequential legacy：

```text
仍保持旧行为
```

不要破坏向后兼容。

---

# 9. P0 — Reviewer Provider Session 必须进入 Evidence

现在只传：

```ts
freshSession: true
```

不够。

Review Runtime 必须真正调用：

```ts
adapter.normalize(...)
```

复用现有 Adapter common denominator。

不要自己重新解析 Provider session。

从 normalized result 提取：

```text
sessionId
```

写入：

```yaml
session_id:
```

Review Attempt Manifest。

---

## 9.1 Fresh Session Hard Invariant

每个 Review Attempt：

```text
freshSession = true
```

永远：

```text
不传 executor session id
不传 previous reviewer session id
```

并通过 Fake Adapter 实际产生不同 session：

```text
review-session-1
review-session-2
```

测试：

```text
same Task
same Gate
same Reviewer
same Adapter

attempt 1 session != attempt 2 session
```

---

## 9.2 Executor Session != Reviewer Session

使用同一 Fake Adapter：

```text
Executor = fake-alpha
Reviewer = fake-alpha
```

Fake Adapter 应可观察：

```text
buildInvocation input.sessionId
freshSession
```

断言：

```text
Reviewer received input.sessionId == undefined
Reviewer freshSession == true
Reviewer manifest.session_id != Executor dispatch.session_id
```

必须验证真实 Evidence，不接受：

```text
只 assert freshSession === true
```

作为全部结论。

---

# 10. P0 — Parallel Review 权威闭环

本轮必须真正跑通：

```text
Parallel + Review-enabled
```

不能再只测试 Sequential。

权威图：

```text
A
↓
B + C
↓
D
```

---

## 10.1 Parallel PASS

B/C：

```text
isolated execution workspace
↓
dispatch PASS
↓
verification PASS
↓
post snapshot
↓
review PASS
↓
git mutation guard
↓
runtime commit
↓
integration
↓
completed
```

断言：

```text
Review 在 taskCommit 之前发生
Review PASS 后才允许 taskCommit
integration 后才 completed
```

还要断言：

```text
Parallel execution workspace 是 linked worktree
Snapshot 成功
Review worktree HEAD^ → HEAD diff 正确
```

这是专门验证前面的 `.git file` 问题已经修复。

---

## 10.2 Parallel Review FAIL

Task B：

```text
verification PASS
review major finding
```

必须：

```text
workspace status = failed
failure_phase = review
Task = failed
taskCommit absent
integrationCommit absent
canonical 不包含 B 修改
```

---

## 10.3 Parallel Reviewer Mutation

Reviewer 修改 Review workspace：

```text
Review ERROR
Task failed
no taskCommit
no integrationCommit
executor workspace retained/符合既有 retry 语义
canonical unchanged
```

---

# 11. P1 — Review Package 必须补全真实输入

当前：

```ts
verificationCommands: [], // TODO
```

必须删除 TODO 并真正提取 Task Verification commands。

Reviewer Package 要包含：

```text
Task Contract
Gate
source Dispatch Attempt
source Verification Attempt
Verification commands
Verification PASS evidence
Execution Guard relevant rules
preTree
postTree
preCommit
postCommit
review workspace
```

---

## 11.1 verification.md

Review Attempt Evidence 中必须真实生成：

```text
verification.md
```

不要只把 Verification Evidence 塞进 prompt。

内容确定性生成：

```text
source verification attempt
commands
each command status
logs/evidence reference
overall PASS
```

不调用 AI。

---

## 11.2 Execution Guard

当前错误读取：

```text
<projectRoot>/.speccraft/project.md
```

这不是 init 实际创建的文件。

不要继续读取不存在路径。

找到现有真实 Execution Guard 来源。

当前执行路径已有：

```text
skills/execution-guard/SKILL.md
```

或 orchestrator 已加载的：

```text
executionGuard
```

优先复用同一份真实文本。

不要复制另一份 Guard。

Reviewer Prompt 必须真的包含 Execution Guard relevant rules。

---

# 12. P1 — 清理重复的 reviews/lifecycle.ts

现在存在：

```text
src/core/reviews/sequential.ts
```

真实 orchestrator 正在使用。

同时又有：

```text
src/core/reviews/lifecycle.ts
```

里面还留着：

```text
TODO: atomic reservation
attemptNumber = 1
For now we assume...
```

这是重复、过时、容易误导后续开发的实现。

必须进行一次调用关系审计：

```bash
rg "executeReviewLifecycle|runSingleReviewGate" src tests
```

如果已经没有生产调用：

```text
删除 lifecycle.ts
```

同时修掉 imports/tests/docs。

如果仍有调用：

```text
不要维护两套逻辑
重构到唯一 canonical Review execution path
```

最终原则：

> Review Attempt orchestration 只能存在一个权威实现。

---

# 13. P1 — before_review / after_review Hooks 真正接线

Hook enum 已经声明：

```text
before_review
after_review
```

但必须接到真实 Review 生命周期。

---

## 13.1 before_review

发生在：

```text
review package prepared
review invocation 尚未执行
```

之前。

这是 blocking hook。

Hook failure：

```text
Review 不执行
Review Attempt decision = error
error_code = before_review_hook_failed
Task failed
```

不要产生 Reviewer Provider 调用。

---

## 13.2 after_review

发生在：

```text
FINAL Review decision 已确定
Evidence 已落盘
```

之后。

这是 non-rollback hook。

失败：

```text
warning only
```

不能把：

```text
PASS → ERROR
```

也不能改写历史 decision。

---

## 13.3 Hook env

至少：

```text
SPECCRAFT_REVIEW_GATE
SPECCRAFT_REVIEW_ATTEMPT
SPECCRAFT_REVIEWER_PROFILE
SPECCRAFT_ADAPTER
SPECCRAFT_TASK_ID
SPECCRAFT_RUN_ID
```

Parallel 时还应保留既有：

```text
SPECCRAFT_WORKSPACE_ROOT
SPECCRAFT_WORKSPACE_ATTEMPT
SPECCRAFT_WAVE
```

如果适用。

---

# 14. P1 — workspace_attempt / error_code Evidence

Parallel Review Attempt manifest 必须写：

```yaml
workspace_attempt: N
```

Sequential：

```text
可以 absent
```

错误必须使用结构化：

```yaml
decision: error
error_code: ...
error_message: ...
```

至少统一：

```text
spawn_error
timeout
non_zero_exit
normalize_failed
protocol_invalid
reviewer_mutation
before_review_hook_failed
```

不要只把代码埋进字符串：

```text
error_message: "spawn_error: ..."
```

---

# 15. P1 — Review Attempt Store 必须真正校验 Manifest

当前：

```ts
readReviewManifestOrNull()
```

只粗略检查：

```text
version
gate_id
decision
```

然后直接：

```ts
as ReviewAttemptManifest
```

加强基础结构校验。

至少检查：

```text
attempt integer >= 1
run_id string
task_id string
gate_id string
gate_kind valid
reviewer_profile string
adapter string
decision valid
source_dispatch_attempt integer >= 1
source_verification_attempt integer >= 1
pre_tree string
post_tree string
pre_commit string
post_commit string
finding_count integer >= 0
blocking_findings integer >= 0
```

可选：

```text
workspace_attempt
session_id
error_code
error_message
```

也需要类型正确。

不要引入重型 schema library。

用现有 TypeScript + helper 即可。

---

# 16. P1 — `speccraft validate` 加入 Review Invariants

新增：

```ts
checkReviewConsistency(...)
```

并接入：

```ts
validateExecutionConsistency(...)
```

至少实现冻结规格中的这些 invariant：

### Plan

```text
Review Plan run_id == Run ID
gate ids unique
gate kind valid
```

### Attempt references

```text
Review attempt task exists
Review attempt gate exists
reviewer_profile == frozen plan gate.reviewer
adapter == frozen plan gate.adapter
```

### Source Evidence

```text
source_dispatch_attempt exists for same task
source_verification_attempt exists for same task
Review PASS requires source verification PASS
```

### Completion

Review enabled 时：

```text
Task completed
→ every required gate currently satisfied
```

Parallel：

```text
workspace integrated
→ required review gates satisfied
```

### Stale Evidence

```text
old Review PASS
cannot satisfy newer dispatch/verification
```

### Mutation

如果：

```text
error_code == reviewer_mutation
```

则：

```text
decision 不得是 pass
```

### Session independence

如果 Review manifest 有：

```text
session_id
```

且 Dispatch evidence 有 Executor session：

```text
same Task review session != executor session
```

同 Gate 多 attempts：

```text
非空 session_id 不得重复
```

### Workflow

继续断言：

```text
16 Workflow Stages unchanged
Task Status remains six states
```

不要增加 Review Stage。

---

# 17. P1 — Handoff 加入 review-history.md

这是 v0.8 正式交接证据。

新增确定性编译：

```text
review-history.md
```

内容至少：

```text
Task
Gate
Kind
Reviewer Profile
Adapter
Review Attempt
Source Dispatch Attempt
Source Verification Attempt
Workspace Attempt
Decision
Error Code
Blocking Findings
Minor Findings
Review Session
Started At
Finished At
```

按稳定顺序：

```text
Task Graph order
→ Review Plan gate order
→ attempt number ascending
```

不要调用 AI。

---

## 17.1 Handoff manifest

`manifest.yaml`：

```text
files:
```

中加入：

```text
review-history.md
```

sources 如有结构，也加入 review attempts。

`HANDOFF.md` 可增加：

```text
Review history 摘要
```

但不要复制大量 Finding 正文。

---

# 18. P1 — Aggregate Execution Report

继续保留现在已有：

```text
review [spec PASS, quality PASS]
```

但增加 Review Evidence reference：

```text
runs/<runId>/tasks/<taskId>/reviews/
```

不要只引用 verification。

报告只能引用 Evidence，不允许 AI 二次总结。

---

# 19. P1 — status / next / tasks show

检查是否真正满足：

### status

```text
Review:
  enabled
  gates: ...
  failed tasks: N
```

当前如果缺 failed tasks count，补上。

不要打印所有 findings。

### next

如果 Task 因 Review：

```text
changes_required
```

或 review ERROR：

必须明确引导：

```text
speccraft reviews show <task>
speccraft tasks reopen <task>
```

ERROR 没 blocker findings 时也不能退化成普通 unknown failure。

### tasks show

应包含：

```text
Reviews:
  spec:
    attempts:
    latest:
  quality:
    attempts:
    latest:
```

确认不是只实现单独：

```text
reviews show
```

---

# 20. P1 — Review Plan Recompile Guard

重新验证：

一旦 Run 已存在任何：

```text
dispatch evidence
verification evidence
review evidence
workspace evidence
```

Review Plan 不得被重新生成。

必须：

```text
继续使用 frozen Review Plan
```

新增或完善真实测试：

```text
compile plan
↓
产生 dispatch
↓
修改 project.yaml review config
↓
再次 compile
→ 不得 silently rebuild
```

并覆盖：

```text
review evidence already exists
workspace evidence already exists
```

---

# 21. P1 — Owner Reject / Rework

确认 Owner Acceptance 仍然位于 Review 后面。

Review：

```text
≠ Owner Acceptance
```

权威链：

```text
Task verification
↓
Independent Review
↓
Task completed / integration
↓
Run verification
↓
Owner Acceptance
```

Owner reject 后：

```text
tasks reopen --cascade
```

新施工必须：

```text
new Dispatch Attempt
new Verification Attempt
new Review Attempts
fresh Reviewer sessions
```

Parallel 已 integrated Task：

```text
new Workspace Attempt
```

旧 Review History 保留，但不得自动满足新施工。

新增真实 E2E，不要只测试：

```text
isCurrentReviewSatisfied helper
```

---

# 22. 权威 E2E 必须重建

这轮结束前，建立一组真正能证明 v0.8 的权威 Runtime E2E。

不要把所有断言塞进一个超大测试。

至少拆成下列组。

---

## E2E A — Sequential PASS

```text
Task
dispatch
verify PASS
spec PASS
quality PASS
completed
```

断言顺序：

```text
during reviewer:
task == in_progress

after verification before review:
not completed

after all review:
completed
```

---

## E2E B — Sequential Scope Violation

```text
scope = src/**
executor 修改 src/a.ts + package.json
verification PASS
```

必须：

```text
scope FAIL
task failed
review attempts = 0
```

---

## E2E C — Sequential Review Changes Required → Retry

第一轮：

```text
dispatch 1
verify 1
spec major
task failed
```

reopen。

第二轮：

```text
dispatch 2
verify 2
spec PASS
quality PASS
completed
```

断言：

```text
attempt-001 保留
attempt-002 新增
source binding = 2/2
new review sessions
```

---

## E2E D — Reviewer Dirty Mutation

Reviewer：

```text
modify file
```

必须：

```text
Review ERROR
manifest ERROR
error_code reviewer_mutation
source workspace unchanged
review workspace removed
```

---

## E2E E — Reviewer Commit Mutation

Reviewer：

```text
modify
git add
git commit
```

必须仍：

```text
ERROR
```

证明：

```text
HEAD drift guard
```

有效。

---

## E2E F — Linked Worktree Snapshot

真实：

```bash
git worktree add
```

在 linked worktree 里调用：

```ts
captureTreeSnapshot()
```

必须成功。

断言：

```text
.git 是 file
snapshot 仍正常
```

---

## E2E G — `.speccraft` Runtime Exclusion

项目：

```text
不 ignore .speccraft/
```

snapshot：

```text
不得包含 .speccraft
```

---

## E2E H — Synthetic Parent Chain

Review Worktree：

```bash
git rev-parse HEAD^
git diff HEAD^ HEAD
```

必须：

```text
HEAD^ == preCommit
diff == exact delta
```

---

## E2E I — Parallel PASS

Graph：

```text
A
↓
B + C
↓
D
```

review enabled。

断言：

```text
B/C use linked worktrees
review PASS
then taskCommit
then integration
then completed
```

---

## E2E J — Parallel Review FAIL

B：

```text
verification PASS
review major
```

断言：

```text
workspace failed
failure_phase review
taskCommit absent
integrationCommit absent
canonical unchanged
```

---

## E2E K — Same Adapter, Different Session

```text
Executor adapter = fake-alpha
Reviewer adapter = fake-alpha
```

断言：

```text
Reviewer freshSession true
Reviewer input.sessionId undefined
Executor session != Reviewer session
```

---

## E2E L — Same Gate Retry Fresh Session

同 Task 同 Gate：

```text
review attempt 1
review attempt 2
```

断言：

```text
session1 != session2
```

---

## E2E M — Non-Git Preflight

Review enabled，non-Git：

```text
execute
```

必须：

```text
preflight blocked
0 dispatch
0 workspace
0 task mutation
```

---

## E2E N — Review Hooks

`before_review`：

```text
执行
```

失败则：

```text
Reviewer 未调用
Review ERROR
```

`after_review`：

```text
执行
```

失败：

```text
只 warning
PASS 不回滚
```

---

## E2E O — Validate Tampered Evidence

正常 PASS 后手工篡改：

```text
reviewer_profile
adapter
source_verification_attempt
decision
```

分别断言：

```text
speccraft validate FAIL
```

---

## E2E P — Handoff Review History

完整通过：

```text
execute
verify
review
owner accept
handoff
```

断言：

```text
review-history.md exists
manifest lists review-history.md
内容包含真实 review attempts
```

---

## E2E Q — Legacy Regression

无：

```yaml
review:
```

分别验证：

```text
sequential
parallel
multi-executor
rework
acceptance
handoff
```

保持 v0.7 行为。

---

# 23. 测试质量审计

不要再只搜：

```text
assert.ok(true)
Test stub
```

最终执行：

```bash
rg -n \
'TODO|FIXME|HACK|XXX|placeholder|for now|For now|simplified|stub|assert\.ok\(true' \
src tests
```

逐条判断。

允许：

```text
明确属于未来版本的文档 TODO
```

但生产路径不能保留：

```text
attemptNumber = 1 // TODO
verificationCommands = []
For now assume...
```

这种未完成实现。

同时扫描：

```bash
rg -n \
'§113|§114|§115|§116|§117|§118|§119|§120|E2E|DoD|Coverage' \
tests
```

对照：

```text
测试名称
测试文件头注释
真实 test body
```

避免再次出现：

```text
文件头声称覆盖
实际没有测试
```

---

# 24. 不要扩展范围

本轮禁止实现：

```text
optional review gate
warning-only gate
custom gate
AI voting
AI debate
Reviewer fallback
security specialist
remote reviewer service
database
queue
Docker sandbox
Provider SDK
Reviewer-specific concurrency limiter
```

这些仍属于：

```text
Not Implemented
```

不要因为修 Review Runtime 顺手加功能。

---

# 25. Dependency Constraints

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
native git via spawn
existing Scope Engine
existing Hook Runtime
```

---

# 26. 提交策略

不要把所有东西一次塞进一个巨型提交。

建议按真实逻辑拆：

```text
fix: harden exact review snapshots for linked worktrees

fix: finalize review evidence after mutation checks

feat: persist reviewer session and complete review evidence

fix: enforce review git preflight and sequential scope audit

feat: integrate review invariants hooks and handoff evidence

test: add authoritative sequential and parallel review e2e
```

如果现场实现更适合不同拆法，可以调整。

但要求：

```text
每个提交自洽
每个提交测试绿
```

不要人为制造：

```text
M8.10
M8.11
```

这是 v0.8 收尾，不是新 Milestone。

---

# 27. 每阶段质量门禁

每完成一个逻辑块：

```bash
npm test -- --test-concurrency=2
npm run typecheck
npm run build
git diff --check
git status
```

失败：

```text
先修
禁止继续累积
```

---

# 28. 最终完整 DoD

最终必须连续执行：

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

要求：

```text
full regression PASS × 2
0 failed
typecheck PASS
build PASS
diff check clean
无生产路径残余 stub/TODO
```

如果 `rg` 有匹配：

逐条解释。

不能只报告：

```text
0 stub
```

却没有真正检查 TODO。

---

# 29. 最终 Git 操作

完成全部验收后：

```bash
git status
git branch --show-current
git rev-parse HEAD
git log --oneline -10
```

确认：

```text
branch = feat/v0.8-independent-review-gates
working tree clean
```

然后：

```bash
git push origin feat/v0.8-independent-review-gates
```

如遇：

```text
502
网络错误
```

允许重试。

最后必须验证：

```bash
git rev-parse HEAD
git ls-remote origin refs/heads/feat/v0.8-independent-review-gates
```

要求：

```text
local HEAD
=
remote branch SHA
```

未经 Owner 验收：

```text
禁止 merge main
禁止删除 feature branch
```

---

# 30. Git Identity

当前仓库最近提交使用：

```text
张末冬
morton_cheung@zhangmodongdeMacBook-Air.local
```

不要擅自 amend 历史提交。

在本轮开工时检查：

```bash
git config user.name
git config user.email
```

如果为空：

只报告给 Owner。

除非仓库已有明确配置规则，否则：

```text
不要擅自修改全局 Git identity
```

本轮新提交使用当前 Git 已配置 identity。

Synthetic Review Commit 则必须使用：

```text
SpecCraft Runtime 自己的固定 identity
```

二者不要混淆。

---

# 31. 最终汇报格式

完成后不要只说：

```text
全部通过
```

按下面结构汇报。

## A. Baseline

```text
branch
start SHA
final SHA
remote SHA
```

## B. 修复的问题

逐条：

```text
问题
根因
修改位置
最终行为
```

至少覆盖：

```text
linked worktree snapshot
read-tree HEAD
.speccraft exclusion
synthetic parent chain
runtime git identity
sequential scope audit
mutation finalization
HEAD drift detection
non-Git preflight
review session evidence
workspace_attempt
verification.md
Execution Guard
hooks
validate
handoff
```

## C. 权威 E2E

逐条列：

```text
PASS / FAIL
测试文件
验证了什么真实行为
```

特别说明：

```text
Parallel Review
Reviewer mutation
session independence
Non-Git preflight
Handoff review-history
```

## D. Full Regression

```text
run 1:
N/N PASS

run 2:
N/N PASS

typecheck:
PASS

build:
PASS

git diff --check:
PASS
```

## E. Stub / TODO Audit

报告：

```text
匹配数量
剩余匹配位置
为什么允许保留
```

如果生产路径还有 TODO：

```text
不得宣称 DoD 完成
```

## F. Git

```text
commit list
local SHA
remote SHA
working tree
```

## G. Final Verdict

只允许以下三种：

```text
READY FOR OWNER ACCEPTANCE
```

或：

```text
NOT READY — BLOCKERS REMAIN
```

或：

```text
PARTIALLY READY — <明确原因>
```

不要自行 merge main。

---

# 32. 最终判定标准

这轮真正要证明的不是：

```text
Reviewer 被调用过
```

而是：

```text
Reviewer 审查的是当前 Task 的真实、精确、可复现 Snapshot；

Review 在 Sequential 与 Parallel 两条真实执行路径中都处于正确生命周期位置；

Reviewer 无法污染 Executor 或 canonical source；

Review 的最终 Decision 与 Evidence 永远一致；

Review PASS 与当前 Dispatch / Verification / Workspace 版本绑定；

Reviewer Provider Session 可审计且与 Executor 独立；

Review enabled 时所有 completion / integration invariant 都可由 validate 重新验证；

Review 历史能完整进入最终 handoff；

Review disabled 时 v0.7 legacy 行为完全不变。
```

只有这些全部成立，SpecCraft v0.8 才可以进入：

```text
Owner Acceptance
```

在此之前：

```text
不要 merge main
不要开始 v0.9
不要把 477 tests PASS 当作完成证明
```

现在从 Site Survey 开始，按真实代码逐项施工，完成全部修改、测试、提交、推送和远端 SHA 核验后再汇报。
# Independent Review Gates（v0.8）

SpecCraft v0.8 引入独立 Review Gates，在 Verification 之后、Owner Acceptance 之前提供一层独立的质量评估。

## 核心原则

```
Review ≠ Verification
Review ≠ Owner Acceptance
Reviewer ≠ Executor
```

- **Verification** 证明实现能运行（命令通过 / 测试通过）。
- **Review** 评估契约与质量（spec 合规、代码质量）。
- **Owner Acceptance** 是最终决定权。

Review enabled 是 opt-in。旧项目默认不发生行为变化。

## 启用 Review

在 `project.yaml` 中添加 `review` 节：

```yaml
review:
  enabled: true
  default_reviewer: reviewer-1
  reviewers:
    reviewer-1:
      adapter: claude
      timeout_seconds: 900
    reviewer-2:
      adapter: claude
      model: sonnet
  gates:
    - id: spec
      kind: spec_compliance
      reviewer: reviewer-1
    - id: quality
      kind: code_quality
      reviewer: reviewer-2
```

### Reviewer Profile

每个 reviewer 声明一个 adapter（必须是已注册的 CLI Adapter）。

- `adapter`：使用的 adapter id（如 `claude`、`codex`）
- `timeout_seconds`：单次 review attempt 超时（默认 900）
- `model`：可选，指定模型
- `extra_args`：可选，额外 CLI 参数
- `sandbox`：可选，沙箱模式

Reviewer Profile ≠ Executor Profile。同一 adapter 可以同时服务两种角色，但每次 review 使用独立的 fresh session。

### Review Gate

每个 gate 声明：

- `id`：唯一标识（如 `spec`、`quality`）
- `kind`：`spec_compliance` 或 `code_quality`
- `reviewer`：引用 reviewer profile id

Gate 按声明顺序执行（§69）。第一个 `CHANGES_REQUIRED` 会短路后续 gate。

## 工作流程

### Sequential（顺序执行）

```
Task dispatch
↓
Verification PASS
↓
capture preTree snapshot（dispatch 前）
↓
capture postTree snapshot（verify PASS 后）
↓
compute exact delta（preTree → postTree diff）
↓
for each gate (declaration order):
  ├─ create detached review worktree
  ├─ prepare review package (task contract + diff + verification evidence)
  ├─ spawn reviewer (fresh session)
  ├─ parse speccraft-review protocol block
  ├─ check reviewer mutation (git status --porcelain)
  └─ cleanup review worktree
↓
all gates PASS → task completed
any gate CHANGES_REQUIRED → task failed → rework
```

### Parallel（并行执行）

```
Task workspace creation
↓
capture preTree snapshot
↓
dispatch + verify
↓
capture postTree snapshot
↓
review gates (same as sequential)
↓
review PASS → git mutation guard → runtime commit → integration
review FAIL → workspace failed, failure_phase='review'
```

Review 在 Runtime Commit 之前完成。Review PASS 才存在 taskCommit。

## Review Package

Reviewer 获得：

- Task Contract（ID / title / summary / scope / dependencies）
- Gate kind
- source Dispatch Attempt / Verification Attempt
- Verification commands + PASS evidence
- preTree / postTree
- exact Task delta（diff patch）
- review snapshot workspace（detached worktree）

Reviewer **不**获得：

- 整个 Planner 会话
- Owner 私人聊天
- Executor 隐藏 chain-of-thought
- 其它不相关 Task 历史

## Review Protocol

Reviewer 必须在输出中包含 `speccraft-review` YAML block：

````markdown
```speccraft-review
version: 1
summary: Implementation matches spec. No blockers found.
findings: []
```
````

### Findings

每个 finding 包含：

- `severity`：`blocker` / `major` / `minor`
- `category`：`spec` / `correctness` / `tests` / `maintainability` / `security` / `scope`
- `message`：描述
- `path`：可选，文件路径
- `line`：可选，行号

### Decision Derivation

- blocker 或 major → `CHANGES_REQUIRED`
- 仅 minor → `PASS`
- 无 findings → `PASS`
- 输出无效 / spawn 错误 → `ERROR`

## Reviewer Isolation

### Detached Worktree

每个 review attempt 使用独立的 detached git worktree：

```
git worktree add --detach <worktree-path> <postCommit>
```

Reviewer 即使修改文件也只污染 Review Workspace，不会污染 Executor Workspace / canonical workspace。

### Mutation Detection

Review 完成后强制检查 `git status --porcelain` 为空。不为空 → `reviewer_mutation` ERROR。

### Fresh Session

每次 review attempt 必须使用 fresh session（禁止 resume）。Executor Session ≠ Reviewer Session。

## Evidence Structure

```
.speccraft/runs/<run-id>/tasks/<task-id>/reviews/<gate-id>/
  └── attempt-NNN/
      ├── manifest.yaml      # Review Attempt Manifest (JSON)
      ├── findings.yaml      # Findings array (JSON)
      ├── stdout.log         # Reviewer stdout
      ├── stderr.log         # Reviewer stderr
      └── raw-output.txt     # Raw output
```

## CLI Commands

```bash
speccraft reviews list                    # 列出 frozen review plan 的 gates
speccraft reviews plan                    # 显示 plan 详情
speccraft reviews doctor                  # 检查 reviewer adapter 可用性
speccraft reviews show <task-id>          # 显示 task 的 review evidence
```

### Status 集成

`speccraft status` 在 Review enabled 时显示：

```
Review: enabled (2 gates: spec, quality)
```

### Tasks Show 集成

`speccraft tasks show <task-id>` 显示每个 gate 的 review attempts 和最新 decision。

### Tasks Next 集成

`speccraft tasks next` 在 Task 需要 review rework 时显示：

```
Task X requires review rework.
Inspect: speccraft reviews show X
Then: speccraft tasks reopen X
```

## Hook Events

Review 新增两个 hook event：

- `before_review`：review gate 执行前触发
- `after_review`：review gate 执行后触发

环境变量：

- `SPECCRAFT_REVIEW_GATE`：当前 gate id
- `SPECCRAFT_REVIEW_ATTEMPT`：当前 attempt number
- `SPECCRAFT_REVIEWER_PROFILE`：当前 reviewer profile id

## Rework Flow

1. Review CHANGES_REQUIRED → task failed
2. `speccraft reviews show <task-id>` 查看 findings
3. `speccraft tasks reopen <task-id>` 重开 task
4. Executor 重新 dispatch（prompt 包含旧 review blocker/major findings）
5. 新 verification + 新 review → PASS → task completed

Review findings 是技术证据，不是修改 approved Product/Design/Scope 的许可。

## Gate Short-Circuit

如果 spec gate 返回 CHANGES_REQUIRED，quality gate 在该轮不会被执行（attempt count == 0）。

## Review PASS 绑定

Review PASS 绑定到当前 dispatch attempt + verification attempt。旧的 Review PASS 不能自动满足新版本的工作。

```
source_dispatch_attempt == latest dispatch
source_verification_attempt == latest verification
```

## 依赖约束

v0.8 遵循现有依赖约束：

- 不引入数据库 / 消息队列 / AI 框架
- 优先 Node.js 标准库 + 现有 js-yaml + Adapter Runtime + Git spawn helpers
- Reviewer Workspace 不使用容器（Docker / VM）

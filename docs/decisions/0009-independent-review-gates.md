# ADR 0009 — Independent Review Gates

日期：2026-09-01
状态：已接受（v0.8 施工基线）

## 背景

v0.7 建立确定性 Executor Assignment，使不同 Task 可由不同 Executor 完成。
v0.8 要解决下一层问题：**How to ensure verified implementation satisfies its contract and quality bar before integration?**

当前 v0.7 生命周期：

```
Task Contract
↓
Executor
↓
Task Verification
↓
Sequential: Task completed
Parallel: Runtime Commit → Integration → Task completed
```

Verification 证明「实现可以运行」，但不证明「实现满足 Task Contract」。

v0.8 引入 **Independent Review Gate**（结构化、可审计的代码审查关卡），在 Verification PASS 后、Task 完成或集成前执行，确保施工结果符合规约与质量要求。

核心命题：

> Verification proves that the implementation runs.
> Review evaluates whether the verified implementation satisfies its contract and quality bar.
> Owner Acceptance remains the final human authority.

以及：

> Review ≠ Verification
> Review ≠ Owner Acceptance
> Reviewer ≠ Executor

## 决策

### 1. Review Placement

Review 属于 Implementation Stage 的 Execution Run → Task 内部关卡，不是新的 Workflow Stage。

```
Implementation Stage
└── Execution Run
    └── Task
        ├── Dispatch
        ├── Verification
        └── Review Gates (v0.8 new)
```

16 Workflow Stages 不变；Task Status 仍为 6 态。

### 2. Reviewer Authority

Reviewer 只允许：

- 读取 Task Contract
- 读取 exact Task delta（preTree → postTree）
- 读取 Verification Evidence
- 检查代码
- 输出 structured findings

Reviewer 禁止：

- 修改代码
- 修改 Task Graph / Scope / Design
- 新增 / 删除 Task
- 选择 Executor / Reviewer
- 修改 Verification 命令
- 执行 Owner Acceptance

Reviewer 发现需求问题时只能记录 finding，不能重新设计产品。

### 3. Reviewer Profile

Reviewer Profile 与 Executor Profile 完全独立：

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

二者虽然都用 `claude` Adapter，但：

```
backend Executor
≠
quality Reviewer
```

并且绝不共享 Provider Session。

### 4. Review Plan

Task Graph compile 时产生 frozen Review Plan（`.speccraft/runs/<run-id>/reviews/plan.yaml`），包含：

- Gate 配置（id / kind / reviewer / adapter / timeout）
- 解析后的 Adapter config

一旦存在 dispatch / verification / review / workspace evidence，Review Plan 不得重新 compile。

### 5. Review Gate

v0.8 先固定两种 Gate Kind：

- `spec_compliance`：检查 Task Contract 完成度、Scope 符合性、Execution Guard 遵守
- `code_quality`：检查 correctness risk、错误处理、测试充分性、维护性、安全性

所有声明的 Gate 默认 required；本版不实现 optional gate / warning-only gate。

### 6. Review Snapshot

Review 不拿整个 Agent 会话历史，而拿：

- Task Contract（Task ID / title / summary / scope / dependencies）
- Execution Guard 相关规则
- exact Task delta（preTree → postTree diff）
- Verification Evidence

preTree / postTree 通过 alternate Git index + synthetic commit + detached worktree 实现，禁止修改用户 working tree / real index / HEAD。

### 7. Review Workspace Isolation

每个 Review Attempt 创建独立 detached worktree：

```
<project-parent>/.speccraft-review-worktrees/<project>/<run>/<task>/<gate>/attempt-NNN/
```

Reviewer 即使修改文件也只污染 Review Workspace，不会污染 Executor Workspace / canonical workspace。

Review 完成后强制检查 `git status --porcelain` 为空；不为空 → `reviewer_mutation` ERROR。

### 8. Structured Findings Protocol

Reviewer 必须输出唯一机器可读 block：

```yaml
```speccraft-review
version: 1
summary: "..."

findings:
  - severity: blocker | major | minor
    category: spec | correctness | tests | maintainability | security | scope
    path: src/foo.ts
    line: 42
    message: "..."
```
```

Runtime 根据 findings 决定 Gate Decision：

- 存在 blocker / major → `CHANGES_REQUIRED`
- 只有 minor / 无 findings → `PASS`

Malformed output → `ERROR`（绝不默认 PASS）。

### 9. Review Attempt Evidence

路径：`.speccraft/runs/<run>/tasks/<task>/reviews/<gate-id>/attempt-NNN/`

包含：

- `manifest.yaml`：decision / reviewer_profile / adapter / source_dispatch_attempt / source_verification_attempt / workspace_attempt / pre_tree / post_tree / session_id / finding_count
- `task-contract.md`
- `diff.patch`
- `verification.md`
- `reviewer-prompt.md`
- `raw-output.txt`
- `stdout.log` / `stderr.log`
- `findings.yaml`

### 10. Review Session Independence

每个 Review Attempt 永远 fresh session，禁止 Reviewer resume。

```
Executor Session != Reviewer Session
```

即使 same Task / same Gate / same Reviewer，第二次 review 也必须 new Provider Session。

原因：Independent Review 应避免携带上一轮 Reviewer 上下文偏差。

### 11. Review Failure Semantics

Reviewer 故障（spawn error / timeout / non-zero exit / normalize fail / protocol invalid / reviewer mutation）统一为 `Review ERROR` → Task `failed`。

Parallel 时 Review ERROR / CHANGES_REQUIRED → no taskCommit / no integration。

Review disabled 时不影响旧行为。

### 12. Sequential Review Gates

Review disabled（`review: enabled: false` 或无 `review:` section）：

```
dispatch
↓
verify completeOnPass=true
↓
completed
```

Review enabled：

```
capture preTree
↓
dispatch
↓
verify completeOnPass=false
↓
capture postTree
↓
exact delta scope audit
↓
Review Gate 1
↓ PASS
Review Gate 2
↓ PASS
completed
```

只有 Verification PASS + all configured gates PASS，Sequential Task 才 `completed`。

### 13. Parallel Review Gates

Review disabled：

```
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

Review enabled：

```
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

只有 all gates PASS 才允许 Git Mutation Guard → Runtime Commit → Integration。

Review FAIL → workspace `failed` / failure_phase = `review` / task `failed` / no taskCommit / no integrationCommit。

### 14. Review Feedback Loop

Review FAIL 后 `tasks reopen <id>` → 新 Dispatch Attempt → Executor Prompt 注入：

```markdown
## Previous Review Findings

Gate: spec

- [major] src/foo.ts:42 ...
- [blocker] src/bar.ts ...
```

同时明确：

> Review findings are technical evidence, not permission to change approved Product/Design/Scope.
> Verify each finding against the actual codebase before implementing changes.

返工后：new Dispatch / new Verification / new Review Attempts（fresh sessions）。

### 15. Review Result Binding

Gate PASS 必须记录 `source_dispatch_attempt` / `source_verification_attempt`。

旧 Review PASS 不能用于新 Dispatch / 新 Verification，即使 same Task / same Gate。

### 16. Owner Rework Independence

Task 已 review PASS + integrated + completed 后 Owner reject：

```
tasks reopen --cascade
```

下一施工：

```
new Workspace Attempt
new Dispatch
new Verification
new Review Attempts
new Reviewer Sessions
```

旧 Review History 保留为 Evidence。

### 17. Rework Semantics

同一 Task retry（Review FAIL → reopen）：

```
Task ID unchanged
Run ID unchanged
Executor Assignment unchanged
Workspace Attempt 默认复用（pre-integration failure）
```

新施工：

```
new Dispatch Attempt
new Verification Attempt
new Review Attempt（每个 Gate）
fresh Review Sessions
```

### 18. Legacy Compatibility

没有 `review:` section 或 `review: enabled: false` 的旧项目：

- 保持 v0.7 行为（Verification PASS 直接 completed / commit）
- 所有旧测试不需要修改

Review 是 opt-in feature。

### 19. Dependency Constraints

继续禁止：

- database / sqlite / redis / queue service
- LangChain / LangGraph / CrewAI / AutoGen
- OpenAI SDK / Anthropic SDK
- simple-git / isomorphic-git / nodegit / execa
- uuid / nanoid

优先：

- Node standard library
- 既有 js-yaml
- 既有 Adapter Runtime
- 既有 Git spawn helpers

### 20. Explicitly Not Implemented

v0.8 不实现：

- Owner review override / waiver
- Reviewer-specific concurrency limiter
- custom review gate（beyond spec_compliance / code_quality）
- security-specialist Reviewer
- architecture Reviewer
- AI debate / AI voting
- automatic review fallback
- remote reviewer farm
- SaaS backend
- database
- Provider SDK

## 后果

### 正面

1. **结构化质量保证**：Verification + Review 双重门控，确保施工符合规约与质量标准。
2. **可审计**：Review Attempt Evidence append-only，所有 findings / decisions 可追溯。
3. **隔离性**：Review Workspace 与 Executor Workspace 完全隔离，Reviewer 修改不会污染源代码。
4. **确定性**：Review Plan frozen；Review Session fresh；Gate 顺序固定；findings → decision 算法固定。
5. **反馈闭环**：Review findings 注入 Executor retry prompt，形成结构化改进循环。
6. **向后兼容**：Review disabled 项目保持 v0.7 行为。

### 负面

1. **执行成本增加**：每个 Task 增加 Review Gate 执行时间与 Token 消耗。
2. **Git 复杂度**：synthetic commit + detached worktree 增加 Git 操作复杂度。
3. **Reviewer 错误**：Reviewer 可能产生误报（false positive）或漏报（false negative）。
4. **不可 fallback**：Reviewer adapter 不可用 / spawn fail → 整体 blocked，不自动 fallback。

### 风险

1. **Reviewer 过度保守**：Reviewer 可能产生过多 major findings，阻塞正常施工。
2. **Reviewer 过度宽松**：Reviewer 可能漏掉真正的质量问题。
3. **Review Workspace 泄漏**：若 cleanup 失败，可能残留大量 worktree。
4. **Git Index 竞争**：alternate index 与真实 index 并发操作需要严格隔离。

## 相关

- ADR 0006 — Deterministic Task Orchestration
- ADR 0007 — Safe Parallel Execution with Worktree Isolation
- ADR 0008 — Deterministic Executor Assignment

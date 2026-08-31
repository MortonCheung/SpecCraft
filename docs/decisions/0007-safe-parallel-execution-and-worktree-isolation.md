# ADR 0007 — Safe Parallel Execution & Worktree Isolation

日期：2026-08-31
状态：已接受（v0.6 施工基线）

## 背景

v0.5 建立了稳定的单写者顺序 Task 调度（`execute` = 确定性顺序执行）。
v0.6 要在不破坏 v0.1–v0.5 invariant 的前提下，实现真正安全、可审计、可恢复、
确定性的 **Git Worktree 隔离并行执行**。

核心命题：

> Parallelism is earned through isolation, scope proof, verification, and
> deterministic integration — never assumed from task independence alone.

## 决策

### 1. 对象层级与边界

```
Workflow
└── Implementation Stage
    └── Execution Run
        ├── Task Graph（声明式）
        ├── Tasks（Task ID 生命周期固定）
        ├── Workspace Attempt（v0.6 新增）
        │   ├── Branch
        │   ├── Worktree
        │   ├── Dispatch Attempts
        │   ├── Verification Attempts
        │   ├── Scope Audit
        │   ├── Task Commit
        │   └── Integration
        ├── Parallel Wave（v0.6 新增）
        ├── Dispatch Attempts（append-only）
        ├── Task Verification（append-only）
        └── Run Verification（原有）
```

严格保持：

- `Task ≠ Workspace Attempt`
- `Task ≠ Dispatch Attempt`
- `Task ≠ Provider Session`
- `Task ≠ Workflow Stage`（16 Stage 保持原样，绝不新增）

Task Status 仍只有 6 态：`pending / ready / in_progress / completed / failed / blocked`。
**禁止**新增 `verified / integrating / integrated / merging / workspace_ready` 等
Task Status。Workspace 有自己的状态模型（见 §3）。

### 2. Canonical Integration Workspace（§7.1）

用户当前 `projectRoot` 所在 Git branch 即 **canonical integration workspace**。
不创建隐藏永久的 `speccraft/integration` 主分支体系。

Wave 开始时：`canonical HEAD = wave base commit`。
Task worktree 全部基于同一个 `wave base commit` 创建。

### 3. Workspace Status（§8.1 语义）

`WorkspaceStatus` 与 `TaskStatus` 是两个独立状态模型：

```
created
active
verified
committed
integrated
failed
integration_conflict
cleaned
```

### 4. Worktree 不放进项目仓库（§7.2）

真正 worktree 默认放：

```
<project-parent>/.speccraft-worktrees/<project-name>/<run-id>/<task-id>/attempt-NNN/
```

`.speccraft` 只保存 metadata（Workspace Manifest），真正 worktree 在仓库外，
避免污染 canonical working tree 与 Git 状态。

### 5. Workspace Attempt 生命周期（§7.3–§7.4）

```
Run
└── Task
    └── Workspace Attempt
        ├── Branch
        ├── Worktree
        ├── Dispatch Attempts
        ├── Verification Attempts
        ├── Scope Audit
        ├── Task Commit
        └── Integration
```

- 同一施工周期内失败（dispatch FAIL / Task Verification FAIL / scope FAIL），
  且 Task 尚未 integration：`tasks reopen C` 默认**复用原 Workspace Attempt**，
  不创建新 Task、不无意义创建新 worktree。
- 已经 integration 后被 Owner Rework：下一次执行必须创建 **Workspace Attempt 002**，
  base = 当前最新 canonical HEAD。Task ID 仍为 `C`。

### 6. Provider Session 隔离键（§7.5）

v0.5：`run + task + adapter`。
v0.6 parallel route：`run + task + workspaceAttempt + adapter`。

- 同 Workspace Attempt retry：resume allowed。
- 新 Workspace Attempt：fresh Provider Session（不得 resume 旧 attempt 的 session）。

### 7. No Automatic Conflict Resolver（§7.6）

遇到 merge / cherry-pick conflict：`detect → record → abort → stop unsafe integration`。
禁止 AI 自动解决冲突、`ours`/`theirs`、强制覆盖、自动 reset 用户代码。

### 8. 执行模式

- `speccraft execute`：保持 v0.5 sequential route（完全兼容）。
- `speccraft execute --parallel [--max-parallel N]`：v0.6 parallel route，
  **显式 opt-in**，默认不开启并行。默认 `maxParallel = 2`；`N` 为 integer 且 `N >= 1`。
  `--max-parallel 1` 仍走 Workspace Isolation，但一次一个 Task。

不使用 worker_threads / queue service / Redis / Bull 等。Wave 控制并发数量，
进程调用用 Node 原生 `Promise.allSettled` + `child_process` + `fs`。

### 9. 顺行/并行两条 completed 路线（§五 语义冻结）

Sequential：

```
canonical workspace → dispatch → Task Verification PASS → completed
```

Parallel：

```
isolated worktree → dispatch → scope audit → Task Verification PASS
→ 仍 in_progress → task commit → integration PASS → completed
```

**Task Verification PASS 不得在 isolated parallel route 中直接 completed。**

### 10. Deterministic Wave Planner（§十三）

输入 Task Graph + Task statuses + maxParallel，按 graph 声明顺序贪心建 Wave，
scope 无法证明不相交则不同 Wave。禁止 LLM ranking / random / completion-time scheduling。

## 明确不做

新 Workflow Stage、新 Task Status、自动 merge conflict resolver、AI scheduler、
multi-agent debate、SaaS backend、database、cloud sync、Provider SDK/API-key manager、
worker pool / Redis / Bull 等重调度依赖、simple-git / isomorphic-git / nodegit、
execa / nanoid / uuid。

Git 写操作只用 `child_process.spawn` 调原生 git。

## 后果

- 并行只通过「隔离 + scope 证明 + 验证 + 确定性集成」获得，绝不假设 Task
  独立即安全；
- canonical working tree 在 Agent 执行期间不被 Agent 修改；
- failed Task 的改动永不进入 canonical branch；
- 16 Workflow Stage 完全不变，Task Graph 不变成第二套 Workflow。
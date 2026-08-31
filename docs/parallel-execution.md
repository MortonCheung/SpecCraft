# Parallel Execution（v0.6 / v0.7）

**并行性通过隔离、范围证明、验证和确定性集成获得，绝不基于「任务独立性假设」。**

设计决策见 [ADR 0007](decisions/0007-safe-parallel-execution-and-worktree-isolation.md)。
隔离机制（worktree / workspace / attempt）详见 [worktree-isolation.md](worktree-isolation.md)。
异构 Executor 的 Wave 路由（v0.7）详见 [executor-routing.md](executor-routing.md)。

## 启用方式

并行执行是**显式 opt-in**，默认仍是 v0.5 sequential route：

```bash
speccraft execute                       # sequential（v0.5 行为，不变）
speccraft execute --parallel            # parallel（wave 调度）
speccraft execute --parallel --max-parallel 3
```

`--max-parallel` 必须是 >= 1 的整数（默认 2），限制单个 wave 内的 Task 数。

## Parallel Preflight（安全前置）

`execute --parallel` 开始前，canonical 仓库必须满足：

- `projectRoot` 是 Git 仓库且 HEAD 可解析；
- 当前在 branch 上（非 detached HEAD）；
- 无 merge / cherry-pick / revert / rebase 进行中；
- 工作区 clean（`git status --porcelain` 为空）。

任一条件不满足即**明确失败**，绝不自动 stash / checkout / reset / clean。

同一 Run 同时只允许一个 `execute --parallel`（文件锁
`.speccraft/runs/<run>/locks/execute.lock`，原子 `open(..., 'wx')`）。

## Deterministic Wave Planner

wave 由规则**确定性**计算（不随机、不 LLM 排序）。

v0.6 三条规则：

1. 只有 `ready` 状态的 Task 进入候选（依赖全部 completed）；
2. 候选按 Execution Manual **声明顺序**遍历，scope 冲突（见
   [worktree-isolation.md](worktree-isolation.md) 的 Scope Engine）的 Task
   被推迟到后续 wave；
3. wave 内 Task 数不超过 `maxParallel`。

v0.7 增加第四条 —— **Executor Profile concurrency capacity**：

4. 候选 Task 的 Executor Assignment 来自 frozen Executor Plan（不是每次重新读取
   project.yaml）；若该 Task 的 Executor Profile 声明了 `max_concurrency`，
   且当前 wave 已选中同 Profile 的 Task 数达到上限，则该 Task 被推迟到后续 wave。

即 v0.7 Wave Eligibility 完整为：

```text
ready
+ scope compatible
+ global maxParallel
+ Executor Profile concurrency capacity
```

并发上限以 **Executor Profile** 为单位（不同 Profile 即使使用同一 Adapter，容量
也各计，不实现 Adapter-level rate limiter）。Profile 缺省 `max_concurrency` 时不
增加额外限制，只受全局 `--max-parallel` 约束。规则与算法见
[executor-routing.md](executor-routing.md)。

示例（diamond 图）：

```text
A          → wave 1
B + C      → wave 2（scope src/backend/** 与 src/frontend/** 不相交）
D          → wave 3
```

`speccraft next` 会提示：

```text
2 tasks are ready for parallel execution:
- api
- ui

Run:
speccraft execute --parallel
```

## Wave 执行流程

```text
plan wave
→ 记录 wave base commit（= 当前 canonical HEAD）
→ 为 wave 内每个 Task 创建/复用隔离 worktree
→ 并行 dispatch / scope audit / task verification / runtime commit
→ 确定性集成（按声明顺序，不是完成顺序）
→ 保存 wave evidence → refresh 依赖 → plan 下一 wave
```

硬 invariant：

- `implementStart` / `implementFinish` 整个 parallel execute 各**最多一次**；
- Task `completed` 只能由 integration PASS 触发——Task Verification PASS
  在隔离路线下只产生 `verified` workspace，**不是** completed；
- 当前 wave 的 integration 全部结束前禁止 plan 下一 wave；
- 单个 Task 失败不回滚整个 wave（fail-fast 停止后续 wave，但保留现场）；
- 绝不自动执行 Run Verification。

## 失败语义（Fault Semantics）

| 场景 | Task | Workspace | canonical |
| --- | --- | --- | --- |
| dispatch / verify / scope FAIL | failed | failed（retained，attempt 可复用） | 不变 |
| scope violation | failed | failed（violations 记录） | 不变 |
| executor 自己 `git commit` | failed | failed（git mutation guard） | 不变 |
| cherry-pick conflict | failed | `integration_conflict`（evidence 保留） | abort 后 clean |
| canonical drift（wave 中 HEAD 前进） | in_progress（不动） | committed（retained） | 用户的 commit 不丢失 |

## Rework 语义

复用现有 `speccraft tasks reopen <id> [--cascade]`，不发明第二套 rework 系统：

- **pre-integration 失败**（dispatch/verify/scope fail）：reopen 后下一次
  execute 复用同一 Workspace Attempt（worktree 仍存在时）；
- **integration_conflict / 已 integrated**：reopen 后下一次 execute 必然使用
  新 Workspace Attempt（baseline 可能已变化），base = 最新 canonical HEAD，
  Provider Session 为 fresh；
- **Owner rework**（completed 后 reject + reopen --cascade）：同上，Task ID
  与 Run ID 不变，旧 evidence 全部保留。

## 诊断命令

```bash
speccraft workspaces list               # 全部 workspace 概览
speccraft workspaces show <task-id>     # 单 Task 全部 attempt 详情
speccraft workspaces clean              # 清理 integrated/cleaned 的遗留 worktree + branch
```

`clean` 只清理成功终态（integrated / cleaned）的遗留内容；active / failed /
integration_conflict 的 workspace 默认禁止删除。没有（也不会有）
`workspaces create / attach / merge / rebase / resolve` 等内部命令——这些操作
全部由 Runtime 决定性执行。

## Hooks

复用既有 4 个事件（`before/after_dispatch`、`before/after_verify`），不新增
lifecycle event。parallel route 下 hook 的 `cwd = workspaceRoot`，env 新增：

```text
SPECCRAFT_WORKSPACE_ROOT
SPECCRAFT_WORKSPACE_ATTEMPT
SPECCRAFT_WAVE
```

`SPECCRAFT_TASK_ID` / `SPECCRAFT_RUN_ID` 仍然存在。Secret 依旧不由 Runtime
自动注入。

## Status / Validate / Handoff

- `speccraft status`：显示 Execution Mode、当前 wave、max parallel、active
  workspaces、integration pending/conflict；
- `speccraft validate`：新增 workspace invariant（workspace ↔ task 一致性、
  attempt 唯一、parallel route completed 必须有 integrated evidence、
  scope violation 不得 integrated 等，完整清单见 ADR 0007 §20）；
- `speccraft handoff`：parallel route 额外生成 `workspace-history.md`
  （waves / attempts / commits / scope audit / dispatch / verification，
  确定性生成，不调 AI）。

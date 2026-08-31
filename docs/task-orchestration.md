# Task Orchestration

**v0.5 默认 sequential by design；v0.6 已实现可选的 worktree 隔离并行
（`execute --parallel`）；v0.7 增加异构多 Executor 路由。本文档描述
deterministic 调度语义。**

## 确定性顺序 Scheduler

`speccraft execute` 用单写者顺序调度：

```text
load graph
refresh states

while true:
    if failed task → STOP（非零 exit）
    next = first ready task（按 Execution Manual 声明顺序）
    if no next:
        if all completed → break
        else report blocked → STOP
    dispatch(next) → 若 fail → task failed → STOP
    verify(next) → 若 fail → task failed → STOP
    task completed → refresh graph

全部 completed →
    确定性生成 Aggregate Execution Report
    → 调用一次 implementFinish
    → Run awaiting_verification
```

- 不 `Promise.all`，不 worker pool，不 parallel dispatch；
- 同级 ready Task 顺序 = Execution Manual 声明顺序（不随机、不 LLM 排序）；
- 全部 Task completed 前绝不调用 implementFinish；
- 全部 completed 后只调用一次 implementFinish。

## 单写者（single-writer）

v0.5 默认不实现：

- Git worktree
- parallel code execution
- concurrent writers
- task branches
- automatic merge
- merge conflict resolver
- multi-agent debate
- AI scheduler

**worktree 隔离并行已由 v0.6 实现**（workspace isolation + git worktree +
safe integration，见 [parallel-execution.md](parallel-execution.md) 与
[worktree-isolation.md](worktree-isolation.md)）。v0.6 并行 route 严格
保持本文的确定性调度语义（声明顺序、单写者证据、不做 AI 排序）。

## Task-aware Dispatch

- `dispatch --task <id>` 带 `task_id`（legacy dispatch 无）；
- session isolation 按 `run + task + adapter`，不同 Task 不共享 session；
- 同 Task retry 默认 resume，`--fresh-session` 强制新 session；
- Dispatch SUCCESS ≠ Task completed（保持 in_progress，等待 Task Verification）。

## 异构 Executor 路由（v0.7）

Task Graph 的 Task 可声明 `executor`。`speccraft tasks compile` 编译 Task
Graph 时同时生成 **frozen Executor Plan**（`executors/plan.yaml`），每个
Task 恰好一个 Assignment（Task → Executor → Adapter）。

Runtime 通过 `ExecutorResolver` 按 Task 从 frozen plan.yaml 解析
Executor → Adapter（`taskId → ExecutorResolver → CliExecutionAdapter`）：

```text
resolve(taskId)
  → assignment = plan.assignments[taskId]
  → adapter    = registry.get(assignment.adapter)     // 只读 plan，不读 project.yaml
  → return { executorId, adapter, adapterConfig }
```

- 无 plan / 无 executorResolver（legacy）→ 退化为 single-executor fallback
  （`options.adapter`，v0.6 行为不变）；
- Explicit Executor Graph 禁止 `--adapter` 覆盖（`--adapter cannot override
  explicit Task Executor assignments`）；
- `execute` / `dispatch --task` 在施工副作用前执行 **Executor Preflight**
  （adapter 未安装 → `execution preflight blocked`，零副作用）；
- 故障语义：Provider spawn failure 走 Task failure 语义且**禁止 fallback**；
  Retry / Owner Rework 后 executor 仍来自 frozen plan（不变量，见
  [executor-routing.md](executor-routing.md)）。

## Task Verification

- 执行 Task Definition 的 `verification.commands`（Node spawn）；
- evidence `tasks/<id>/verification/attempt-NNN/` append-only；
- PASS → completed + 解锁 dependents；
- FAIL → failed + 传递 blocked + orchestrator STOP。

## 与 Run Verification / Acceptance 的关系

```text
Task Graph complete
    ↓ speccraft execute（聚合 finish）
Run = awaiting_verification
    ↓ speccraft verify（Run Verification，独立）
Run Verification PASS
    ↓ speccraft accept / reject（Owner Acceptance，人类权威）
    ↓ speccraft handoff（含 task-history.md）
```

Task Verification ≠ Run Verification；Run Verification ≠ Owner Acceptance。
Execution 与 Run Verification 是两个独立证据阶段。

## Aggregate Execution Report

全部 Task completed 后确定性生成 `agent-report-00N.md`，内容来自 Task IDs /
statuses / dispatch attempts / verification attempts（引用 evidence），不调 AI。

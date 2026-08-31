# Task Orchestration（v0.5）

**v0.5 is sequential by design.**

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

v0.5 不实现：

- Git worktree
- parallel code execution
- concurrent writers
- task branches
- automatic merge
- merge conflict resolver
- multi-agent debate
- AI scheduler

**真正安全的 worktree 并行属于 v0.6**（workspace isolation + git worktree +
safe integration）。

## Task-aware Dispatch

- `dispatch --task <id>` 带 `task_id`（legacy dispatch 无）；
- session isolation 按 `run + task + adapter`，不同 Task 不共享 session；
- 同 Task retry 默认 resume，`--fresh-session` 强制新 session；
- Dispatch SUCCESS ≠ Task completed（保持 in_progress，等待 Task Verification）。

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

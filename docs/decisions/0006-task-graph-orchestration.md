# ADR 0006 — Task Graph & Deterministic Task Orchestration

日期：2026-08-31
状态：已接受（v0.5 施工基线）

## 背景

v0.4 的执行粒度仍是 `1 Execution Manual → 1 Run → 1 Executor`。
v0.5 要在不破坏 v0.1–v0.4 语义的前提下，在 Execution Run 内引入 Task Graph，
使一份已批准的 Execution Manual 能编译成确定性的施工 Task，并由 Runtime
做依赖管理、Task-aware dispatch、Task-level verification、返工与顺序调度。

核心命题：**一份已批准的施工结构 → 确定性编译 → 顺序执行 → 证据闭环。**

## 决策

### 1. 对象层级

```
Workflow
└── Implementation Stage
    └── Execution Run
        ├── Task Graph（声明式，来源 = Execution Manual）
        ├── Tasks（Task ID 生命周期固定）
        ├── Dispatch Attempts（append-only）
        ├── Task Verification（append-only）
        └── Run Verification（原有）
```

严格区分四件事：

- `Task ≠ Workflow Stage`（16 Stage 保持原样，绝不新增）
- `Task ≠ Run`
- `Task ≠ Dispatch Attempt`
- `Task Verification ≠ Run Verification`
- `Run Verification ≠ Owner Acceptance`

### 2. ID invariant

- Workflow Stage ID：固定既有值；
- Run ID：一次施工闭环固定；
- Task ID：一次 Task Graph 生命周期固定；
- Dispatch Attempt / Task Verification Attempt / Run Verification Attempt：append-only；
- Provider Session ID：Provider 专属，不等于以上任何 ID。

Task retry **不创建新 Task**：Task ID 不变，只增加 Dispatch / Verification attempt。

### 3. v0.4 compatibility

继续支持无 Task Graph 的 legacy Run、原有 `dispatch`、manual adapter、
run-level verification、acceptance、handoff。v0.5 不强制旧项目先迁移。

### 4. sequential + single-writer（本版绝不并行）

不实现 Git worktree / parallel execution / concurrent writers / task branches /
automatic merge / merge conflict resolver / multi-agent debate / AI scheduler。

Scheduler 必须 deterministic + sequential + single-writer。真正安全的 worktree
并行属于 v0.6。

### 5. 声明式 Task Graph（Runtime 不调 LLM）

Execution Manual 包含唯一 `speccraft-task-graph` block（YAML）。Compiler 只做：
extract block → YAML parse → schema validation → graph validation → persist。
Runtime 不得调 LLM 拆 Task、不得猜测、不得「默认生成一个 Task」。

Task 粒度：一个独立工程目标 = 一个 Task（不拆成「每行一个 Task」）。

### 6. Task Dispatch 不触发 Run 完成

v0.4 的 `dispatch success → implementFinish()` 语义只适用于 legacy 单次 dispatch。
Task dispatch success 只让 Task 保持 in_progress、等待 Task Verification，
**绝不调用 implementFinish()**。只有全部 Task completed 才结束 Implementation。

Task session isolation：resume 查 `run + task + adapter`，不同 Task 不共享 session。

### 7. Task Verification 独立

Task Verification 执行 Task Definition 的 `verification.commands`，
evidence 为 `tasks/<task-id>/verification/attempt-NNN/`（append-only）。
PASS → task completed + 解锁 dependents；FAIL → task failed + 传递 blocked + STOP。

### 8. Deterministic Orchestrator（`speccraft execute`）

单写者顺序循环：取第一个 ready Task → dispatch → verify → completed → refresh。
有 failed 即 STOP（非零 exit）。全部 completed 后：确定性生成 Aggregate
Execution Report（引用 Task 证据，不调 AI），调用一次 implementFinish →
Run awaiting_verification，然后停止——不自动 Run Verification。

`Execution ≠ Run Verification`。

### 9. Rework 是显式人类/Planner 行为

`speccraft tasks reopen <id> --cascade`：target 重新 ready/pending、
reopenedCount+1、保留旧 evidence、dependents 回 pending。不从 Owner Reject
的自然语言 reason 自动推断 Task。Human authority 不交给 Runtime 推断。

### 10. Handoff 纳入 Task History

Handoff Package 增加确定性 task-history（Task Graph、最终状态、retry、
dispatch/verification attempts、reopen history），不调 AI 生成。

## 明确不做

新 Workflow Stage、Task=Stage、Task retry 新 ID、Agent 自行新增 Task、
Runtime 调 LLM 拆任务、LLM Scheduler、Agent voting/debate、Git worktree、
parallel writers、automatic merge、Redis/SQLite/DB/queue/SaaS/Web/cloud、
Provider SDK/API-key 管理、execa/nanoid。

## 后果

- Task Graph 是「已批准施工结构」的声明式体现，不变成第二套 Workflow；
- Scheduler 是确定性顺序执行器，不变成 AI Agent；
- Task retry 复用同 Task、同 Run，审计价值最大化；
- v0.6 并行（worktree/安全集成）建立在稳定的单写者契约之上。

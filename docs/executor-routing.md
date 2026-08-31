# Executor Routing（v0.7）

**异构多执行器路由与确定性分配** —— 回答「Which Executor should execute
each Task?」。

> 核心原则：**Task-to-Executor ownership 必须 explicit、deterministic、
> persistent、auditable、stable across retries。SpecCraft routes executors。
> AI does not choose other AI。**

设计决策见 [ADR 0008](decisions/0008-deterministic-executor-assignment.md)。

## 三层概念，不要混淆

| 概念 | 是什么 | 生命周期 |
| --- | --- | --- |
| **Executor Profile** | SpecCraft 定义的施工身份（`frontend` / `backend` / `quality`） | project.yaml 配置 |
| **Adapter** | Provider CLI 连接（`codex` / `claude` / `opencode` / `trae` / `manual`） | registry 注册 |
| **Provider Session** | 某次执行器会话（`session_id`） | dispatch attempt 产生 |

- **Task ≠ Executor**：Task 是施工单元，Executor 是执行它的人。
- **Executor Profile ≠ Adapter**：多个 Profile 可指向同一 Adapter
  （`fast` 与 `quality` 都用 `claude`），但容量、model、隔离语义各自独立。
- 同一 Adapter 的不同 Profile **不共享 Provider Session**。

## 配置：Executor Profile（project.yaml）

```yaml
execution:
  default_adapter: manual
  default_executor: primary          # 未声明 executor 的 Task 落到这里
  adapters:
    codex: { command: codex, timeout_seconds: 3600 }
    claude: { command: claude, timeout_seconds: 3600 }
  executors:
    frontend:
      adapter: claude
      model: claude-sonnet          # 可选；adapter 不支持 model selection 时 preflight 拒绝
      max_concurrency: 2            # 可选；该 Profile 的并行容量
    backend:
      adapter: codex
```

无 `execution.executors` / `default_executor` 配置时进入 **legacy 模式**：
运行时使用逻辑 Profile `legacy-default`（adapter = `default_adapter`），
v0.6 行为完全不变。

## Task 声明 Executor（Execution Manual）

```text
```speccraft-task-graph
version: 1
tasks:
  - id: api
    title: API
    executor: backend
    depends_on: []
    scope: { paths: [src/api/**] }
    verification: { commands: [echo ok] }
  - id: ui
    title: UI
    executor: frontend
    depends_on: [api]
    scope: { paths: [src/ui/**] }
    verification: { commands: [echo ok] }
```
```

`task.executor` 是**显式**所有权声明。未声明 executor 的 Task 落入
`default_executor`（或 legacy-default）。

## Executor Plan（frozen）

`speccraft tasks compile` 把 Execution Manual 编译为 Task Graph **和**
Executor Plan（`.speccraft/runs/<run>/executors/plan.yaml`）：

```yaml
version: 1
run_id: <run-id>
created_at: <iso>
default_executor: primary
assignments:
  - task_id: api
    executor: backend
    source: explicit        # explicit | default | legacy
    adapter: codex
    resolved: { command: codex, timeout_seconds: 3600 }
  - task_id: ui
    executor: frontend
    source: explicit
    adapter: claude
    resolved: { model: claude-sonnet, ... }
```

**Plan 一旦产生即 frozen**：后续 dispatch 只读 `plan.yaml`，绝不重新读取
`project.yaml` 决定 Task Executor。用户修改 project.yaml 只影响 **future
Task Plan / future Run**，当前 Run 不能偷偷切换 Provider。

## ExecutorResolver（taskId → adapter）

Runtime 通过 `ExecutorResolver` 把 Task 路由到 Adapter：

```text
taskId → ExecutorResolver → generic CliExecutionAdapter
```

- ExecutorResolver 只读 frozen plan.yaml；
- 缺省（legacy，无 plan）退化为 single-executor fallback
  （`options.adapter`，v0.6 行为）；
- Core Orchestrator 不接触 Provider-specific 代码。

## Preflight（Execute 前门禁）

`speccraft execute` / `speccraft dispatch --task <id>` 在任何施工副作用之前
对 frozen plan 执行 Preflight：

- probe plan 实际需要的 adapter（**按 adapter 去重**，不按 Task）；
- 任何 assignment blocked（adapter 未注册 / 未安装 / manual executor /
  请求 model 不被 adapter 支持）→ **整体 blocked**；
- blocked 时**零副作用**：no implementStart / no worktree / no task status
  change / no dispatch attempt / canonical unchanged。

```text
execution preflight blocked
reason: executor_unavailable
```

修复引导：`speccraft executors doctor`。

## 故障与返工语义（Failure & Rework）

| 场景 | 语义 |
| --- | --- |
| Executor unavailable before execution | preflight FAIL，零副作用 |
| Provider spawn failure | 走 Task failure 语义（task → failed），**禁止 fallback** |
| Retry（Dispatch FAIL → reopen → dispatch） | executor 不变（frozen plan） |
| Owner rework（integrated → reject → reopen） | 新 Workspace Attempt，executor 不变，新 Provider Session |
| project.yaml 修改 | 当前 Run 仍用 frozen assignment，不偷换 Provider |

**No auto fallback**：assigned adapter fails 后，绝不会出现其它 adapter 的
dispatch attempt。

## Executor Plan Recompile Guard

以下任一 evidence 存在时，`speccraft tasks compile` **不得覆盖** Executor Plan：

- dispatchAttempts > 0
- verificationAttempts > 0
- workspaceAttempts > 0

Execution 尚未真正开始（无上述 evidence）时允许重新 compile。

## CLI

```bash
speccraft executors list        # 列出 project.yaml 的 Executor Profile
speccraft executors plan        # 读取当前 Run 的 frozen plan.yaml
speccraft executors doctor      # probe plan 实际需要的 adapter + preflight 诊断
```

`speccraft status` 显示 Executors / Assignments 摘要（frozen plan 存在时）；
`speccraft tasks show <id>` 显示 Executor / Adapter / Assignment source；
`speccraft next` 在 plan 缺失或 adapter 不可用时给出 Compile / doctor 引导；
`speccraft validate` 校验 Executor Plan 全部一致性不变量；
`speccraft handoff` 生成 `executor-history.md`（Task / Executor / Adapter /
Model / Dispatch Attempts / Workspace Attempts / Provider Sessions，
确定性聚合，不调 AI）。

## 核心 Invariant（v0.7 DoD）

```text
Task ≠ Executor
Executor Profile ≠ Adapter
Task has exactly one frozen Executor Assignment
Different Tasks never share Provider Session
Same Task retry cannot silently change Executor
Owner Rework cannot silently change Executor
Different Executor Profiles using same Adapter do not share session
Parallel Wave respects Scope
Parallel Wave respects global maxParallel
Parallel Wave respects Executor maxConcurrency
Unavailable Executor fails before mutation
Provider failure does not trigger fallback
Explicit Task Executor cannot be overridden by --adapter
Legacy project remains compatible
Run ID remains stable through retry
Task ID remains stable through retry
Workspace semantics from v0.6 remain unchanged
Task Verification remains independent of Run Verification
Run Verification remains independent of Owner Acceptance
16 Workflow Stages remain unchanged
```

## 版本演进

- v0.1 Workflow
- v0.2 Execution + Verification
- v0.3 Acceptance + Handoff
- v0.4 Agent Adapters + Hooks
- v0.5 Task Graph + Deterministic Orchestration
- v0.6 Safe Parallel Execution + Worktree Isolation
- v0.7 Heterogeneous Multi-Executor Routing

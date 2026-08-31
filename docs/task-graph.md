# Task Graph（v0.5）

v0.5 在 Execution Run 内引入 Task Graph，使一份已批准的 Execution Manual
被编译成确定性的施工 Task。

## 对象层级

```
Workflow
└── Implementation Stage
    └── Execution Run
        ├── Task Graph
        ├── Tasks
        ├── Dispatch Attempts
        ├── Task Verification
        └── Run Verification
```

严格区分：

- `Task ≠ Workflow Stage`（16 Stage 保持原样）
- `Task ≠ Run`
- `Task ≠ Dispatch Attempt`
- `Task Verification ≠ Run Verification`
- `Run Verification ≠ Owner Acceptance`

## Task Status（6 态）

| status | 含义 |
| --- | --- |
| pending | 依赖尚未全部 completed |
| ready | 全部依赖 completed |
| in_progress | 正在 dispatch 或等待 Task Verification |
| completed | Task Verification PASS |
| failed | 最近 dispatch 或 Task Verification FAIL |
| blocked | 至少一个 dependency 当前 failed（传递） |

## Execution Manual → Task Graph

Execution Manual 包含唯一 `speccraft-task-graph` block（YAML）：

````markdown
## Execution Task Graph

```speccraft-task-graph
version: 1

tasks:
  - id: api-runtime
    title: Implement API runtime
    summary: >
      Concrete implementation objective.

    depends_on: []

    scope:
      paths:
        - src/api/**

    verification:
      commands:
        - npm test
      timeout_seconds: 120
```
````

Runtime 不调用 LLM 拆 Task，Compiler 只做：extract → YAML parse → schema
validation → graph validation → persist。

校验：唯一 block、version=1、id 非空唯一、无 self dep、依赖存在、无 cycle、
title/summary/scope.paths/verification.commands 非空、timeout>0、scope 无绝对
路径、无 `..` 越界。

## 文件结构

```
.speccraft/runs/<run-id>/tasks/
├── graph.yaml          # Task Graph（source of truth）
├── <task-id>/
│   ├── manifest.yaml   # 可变状态（status/attempts/reopenedCount）
│   ├── context.md      # Task Context（复用 Compiled Context）
│   ├── prompt.md       # Task Prompt（内嵌 Scope 禁止 + Guard）
│   └── verification/
│       └── attempt-NNN/
```

## Task 粒度

一个独立工程目标 = 一个 Task。不要拆成「每改一行代码一个 Task」，
也不要让一个 Task 变成整个产品。

## CLI

```bash
speccraft tasks compile          # 从 execution-manual 编译 Task Graph
speccraft tasks list             # 列出 Task + 状态 + 依赖 + attempts
speccraft tasks next             # 下一个 ready Task
speccraft tasks show <id>        # Task 详情
speccraft tasks verify <id>      # Task Verification
speccraft tasks reopen <id> [--cascade]  # 显式返工（保留 evidence）
speccraft dispatch --task <id>   # 单个 Task dispatch
speccraft execute                # 确定性顺序执行整个 Graph
```

## 返工（显式人类行为）

Task Verification FAIL → task failed → 传递 dependents blocked。
Owner REJECT 不自动推断 Task，由 Owner/Planner 显式：

```bash
speccraft tasks reopen <id> --cascade
```

- Task ID 不变；reopenedCount+1；旧 evidence 保留。

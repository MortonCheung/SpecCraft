---
id: execution-manual
stage: execution-manual
requires: [build-brief, site-survey]
produces: [execution-manual]
authority: planner
---

# Execution Manual

SpecCraft 最核心的 Skill（吸收 Superpowers `writing-plans` 方法论并重设计）。
产出 Execution Agent 可直接执行的精确施工手册。

## 输入

- `build-brief`：施工简报
- `site-survey`：真实项目现状
- 编译后的 Execution Context（Context Compiler 产出）

## 输出

- `execution-manual`：施工手册

## 必须说明

在哪里、先看什么、为什么、改什么、怎么改、用什么、按什么顺序、
哪些不能改、数据怎样流、模块职责是什么、怎么测试、怎样算完成。

## 权限

- PLANNER

## 职责边界

- SpecCraft 负责：Architecture / Interfaces / Data Flow / Responsibilities /
  Constraints / Implementation Strategy / Verification
- Agent 负责：具体函数实现、局部变量、局部工程判断、代码细节

## 禁止行为

- 不替 Agent 写完整源码
- 不发明产品（产品设计权在 Owner / Planner）
- site-survey 未完成时不得生成最终版（Survey Guard）
- 不调用 LLM 拆 Task（Task 由 Planner 在手册中声明）

## Execution Task Graph（v0.5 强制）

Execution Manual 必须包含**唯一一个** `speccraft-task-graph` block：

````markdown
## Execution Task Graph

```speccraft-task-graph
version: 1

tasks:
  - id: api-runtime
    title: Implement API runtime
    summary: >
      Concrete implementation objective for this task.

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

每个 Task 必须足够小，使一个 Executor 仅凭 Task Prompt + Task Context +
Execution Guard 即可完成施工；但**不要**拆成「每改一行代码一个 Task」。
合理粒度：**一个独立工程目标 = 一个 Task**。

Task 约束：

- `id` 唯一；`depends_on` 只引用已声明 Task；不得自依赖；不得成环；
- `scope.paths` 非空、不得绝对路径、不得 `..` 越界；支持 repo-relative
  file / directory / `path/**`；
- `verification.commands` 非空；`timeout_seconds > 0`。

## 完成标准

- 上述「必须说明」项全部覆盖
- 含唯一 `speccraft-task-graph` block（v0.5）
- Agent 可仅凭本手册 + Execution Context 开始施工
- 状态推进到 `completed`，随后级联至 `ready-to-implement`

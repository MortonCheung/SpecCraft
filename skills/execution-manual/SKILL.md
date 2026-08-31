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

## 完成标准

- 上述「必须说明」项全部覆盖
- Agent 可仅凭本手册 + Execution Context 开始施工
- 状态推进到 `completed`，随后级联至 `ready-to-implement`

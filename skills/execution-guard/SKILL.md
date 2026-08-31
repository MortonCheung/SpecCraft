---
id: execution-guard
stage: implementation
requires: [execution-manual]
produces: []
authority: executor
---

# Execution Guard

施工 Agent 开始前自动注入的复杂度 / 复用守卫（吸收 Ponytail 原则，不安装完整 Ponytail）。

## 注入方式（v0.2）

`speccraft prepare` 会读取本 Skill 全文并注入生成的
`.speccraft/runs/<run-id>/agent-prompt.md`（第 6 节 Execution Guard），
随 Execution Package 一起交给施工 Agent。

## 输入

- `execution-manual`：施工手册

## 输出

- 无 artifact，注入施工规则

## 施工前检查顺序

1. 这个东西真的需要新增吗？
2. 项目中已经有了吗？
3. Node / 平台原生能力能解决吗？
4. 当前依赖已经能解决吗？
5. 能否极小实现？
6. 最后才新增抽象 / 依赖 / 模块。

## 保留原则

- YAGNI
- No needless abstraction
- No dependency without justification
- No silent architecture expansion

不得为了「架构漂亮」增加：新框架、新 ORM、新数据库、新状态库、
新事件总线、新 DI 框架、新 CLI 框架。

## 权限

- EXECUTOR

## 禁止行为

- 跳过复用检查直接新增实现
- 无理由引入新依赖或新抽象
- 未经 Planner / Owner 改变产品目标 / Workflow / 权限模型 /
  Execution Runtime 语义 / 整体技术栈

## 完成标准

- 每次新增实现前已按上述顺序完成复用检查

---
id: execution-guard
stage: implementation
requires: [execution-manual]
produces: []
authority: executor
---

# Execution Guard

施工 Agent 开始前自动注入的复杂度 / 复用守卫（吸收 Ponytail 原则，不安装完整 Ponytail）。

## 输入

- `execution-manual`：施工手册

## 输出

- 无 artifact，注入施工规则

## 施工前检查顺序

1. 项目是否已有实现
2. 标准库能否完成
3. 现有依赖能否完成
4. 平台原生能力能否完成
5. 最后才新增实现

## 保留原则

- YAGNI
- No needless abstraction
- No dependency without justification
- No silent architecture expansion

## 权限

- EXECUTOR

## 禁止行为

- 跳过复用检查直接新增实现
- 无理由引入新依赖或新抽象

## 完成标准

- 每次新增实现前已按上述顺序完成复用检查

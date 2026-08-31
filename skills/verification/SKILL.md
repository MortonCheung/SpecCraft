---
id: verification
stage: verification
requires: [implementation]
produces: [verification]
authority: executor
---

# Verification

验证实现是否满足施工手册（吸收 Superpowers Debug / Review 方法论）。

## 输入

- `implementation`：已完成的实现

## 输出

- `verification`：验收结果、通过项、失败项、遗留问题

## 权限

- EXECUTOR

## 禁止行为

- 不跳过验证就宣布完成（Completion Guard）
- 不以「看起来能跑」代替验收标准

## 完成标准

- 施工手册中的验收标准全部通过
- 失败项与遗留问题显式记录

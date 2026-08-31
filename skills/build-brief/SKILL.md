---
id: build-brief
stage: build-brief
requires: [owner-approval]
produces: [build-brief]
authority: planner
---

# Build Brief

把已批准的设计转化为施工简报，界定施工范围、边界与约束。

## 输入

- `owner-approval`（design 已批准）

## 输出

- `build-brief`：施工范围、边界、约束、优先级

## 权限

- PLANNER

## 禁止行为

- design 未获 Owner 批准时不得生成（Design Guard）
- 不得扩大已批准的设计范围

## 完成标准

- 施工范围、边界、约束明确，可据此开展 site-survey

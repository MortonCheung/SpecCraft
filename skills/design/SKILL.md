---
id: design
stage: design
requires: [requirements, research]
produces: [design]
authority: planner
---

# Design

产出产品与技术设计（吸收 BMAD Architecture 方法论）。设计完成后必须经 Owner 批准（硬门禁）。

## 输入

- `requirements`：需求
- `research`：调研结论

## 输出

- `design`：架构、接口、数据流、职责、约束

## 权限

- PLANNER，产出后需 Owner Approval

## 禁止行为

- 未经 Owner 批准不得进入 build-brief
- 不静默扩展架构
- 不在设计里替 Agent 写完整实现

## 完成标准

- 架构 / 接口 / 数据流 / 职责 / 约束清晰
- 状态推进到 `waiting_owner_approval`，等待 `speccraft approve design`

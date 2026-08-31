---
id: site-survey
stage: site-survey
requires: [build-brief]
produces: [site-survey]
authority: executor
---

# Site Survey

勘察真实项目现状，记录代码库入口、依赖、约定（不修改任何设计）。

## 输入

- `build-brief`：施工简报

## 输出

- `site-survey`：真实实现状态、入口、依赖、约定、与简报的差异

## 权限

- EXECUTOR

## 禁止行为

- 不修改 Design Artifact
- 不「脑补」现状，必须基于真实代码勘察
- 不越权做产品设计

## 完成标准

- 真实项目现状已记录，入口 / 依赖 / 约定清晰
- 与 build-brief 的差异已显式列出

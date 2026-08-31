# ADR 0001 — 第三方集成原则

- 状态：已接受
- 日期：2026-08-31
- 里程碑：Milestone 0 — Foundation & Research

## 背景

SpecCraft 在 Milestone 0 对六个目标开源项目进行了结构级工程勘察：

- obra/superpowers
- DietrichGebert/ponytail
- github/spec-kit
- Fission-AI/OpenSpec
- bmad-code-org/BMAD-METHOD
- eyaltoledano/claude-task-master

并据此建立 Component Matrix（见 `docs/research/component-matrix.md`）。

本文记录 SpecCraft 在引入第三方能力时应当遵守的原则。

## 决策

### 原则一：核心 Workflow 保持原创和可控

SpecCraft 核心 Workflow 必须保持原创和可控。

任何第三方能力不得取代 SpecCraft 的核心 Workflow，也不得定义 SpecCraft 的产品边界。

### 原则二：第三方是能力供应商，不是产品定义者

第三方项目是能力供应商，不是 SpecCraft 的产品定义者。

第三方能力服务于 SpecCraft 的 Workflow，而非反过来让 Workflow 迁就第三方。

### 原则三：能力获取的优先顺序

```text
使用成熟能力
>
小规模适配
>
Adapter 集成
>
自行实现成熟轮子
```

但如果第三方能力明显增加以下任一成本，则允许自行实现最小版本：

- 耦合；
- 复杂度；
- License 风险；
- Agent 平台绑定。

### 原则四：可追溯

所有第三方直接代码复用必须可追溯到：

```text
Source Repository
Source Path
License
Modification
SpecCraft Destination
```

## 后果

- Component Matrix 中每一项 `Decision` 都必须能对应到上述原则。
- 凡 `DIRECT_USE` / `ADAPT` 的组件，必须记录来源仓库、来源路径、许可证与改动说明。
- 凡 `REJECT` 的组件，必须说明原因（功能重复 / 设计过度复杂 / Agent 自主权过高 / 平台绑定严重 / License 不适合 / 与 SpecCraft 核心哲学冲突 / 引入成本远高于收益）。

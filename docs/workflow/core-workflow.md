# SpecCraft Core Workflow

> 本文件是 SpecCraft 的核心工作流契约。它是 SpecCraft 的原创设计，是后续所有阶段、Artifact 与 Agent 行为的最高依据之一。
>
> 状态：Milestone 0 — 已固化（Foundation）。

---

## 定位

SpecCraft 是一个 **Human-Directed AI Workflow System**。

它把：

> 模糊想法

逐步加工为：

> 清晰需求 → 调研结果 → 产品方案 → 甲方确认 → Agent 总施工方案 → 真实项目勘察 → 精确施工手册 → Agent 实施 → 验证 → 甲方验收 → 交接

核心原则：

> **Owner decides what. SpecCraft designs how. Execution Agents build it.**

SpecCraft **不**把主要产品思考下放给 Coding Agent。

Coding Agent 应尽可能拿到已经设计完整、约束明确、可以直接执行的施工说明。

---

## Main Workflow

```text
IDEA
↓
FEASIBILITY
↓
DISCOVERY
↓
REQUIREMENT
↓
CONCEPT
↓
RESEARCH
↓
DESIGN
↓
OWNER APPROVAL
↓
BUILD BRIEF
↓
SITE SURVEY
↓
EXECUTION MANUAL
↓
IMPLEMENTATION
↓
VERIFICATION
↓
OWNER ACCEPTANCE
↓
ITERATION / HARDENING
↓
DELIVERY
↓
HANDOFF
```

阶段说明（语义约定，非实现细节）：

| 阶段 | 含义 |
|---|---|
| IDEA | Owner 提出模糊想法。 |
| FEASIBILITY | 判断想法是否可行。 |
| DISCOVERY | 澄清并发现真实需求与上下文。 |
| REQUIREMENT | 把需求沉淀为清晰、可验证的需求。 |
| CONCEPT | 形成产品概念与方向。 |
| RESEARCH | 对技术、竞品、开源方案进行调研。 |
| DESIGN | 产出产品与技术方案设计。 |
| OWNER APPROVAL | Owner 批准方案，方案进入冻结。 |
| BUILD BRIEF | 编制给执行层的 Build Brief。 |
| SITE SURVEY | 勘察真实仓库、真实代码、真实分支。 |
| EXECUTION MANUAL | 基于真实勘察结果编制精确施工手册。 |
| IMPLEMENTATION | Agent 依据施工手册实施。 |
| VERIFICATION | 验证实现是否满足验收标准。 |
| OWNER ACCEPTANCE | Owner 最终验收。 |
| ITERATION / HARDENING | 迭代打磨与加固。 |
| DELIVERY | 交付。 |
| HANDOFF | 交接。 |

---

## 三层角色

### Owner（甲方）

负责：

- 提出想法；
- 提供需求；
- 表达喜好与体验标准；
- 提供预算、代码、API、服务器、素材等资源；
- 修改产品方案；
- 批准方案；
- 最终验收。

Owner 是最高决策者。

### Planner / Product Layer（产品层）

SpecCraft 中的主要设计层。

负责：

- 可行性判断；
- 调研；
- 产品设计；
- 技术路线设计；
- 架构设计；
- 参考案例分析；
- 把 Owner 语言转换成工程语言；
- 编制 Build Brief；
- 基于真实代码编制 Execution Manual；
- 制定验收标准。

主要思考发生在这一层。

### Execution Agent（执行层）

负责：

- 扫描真实项目；
- 修改代码；
- 创建和删除文件；
- 重构；
- 测试；
- Build；
- Debug；
- Git；
- 补充局部工程细节。

Execution Agent 默认无权：

- 重定义产品；
- 擅改核心流程；
- 擅改已经批准的 UX；
- 用自己的产品判断替换 Owner Approval。

---

## 三条最高规则

### Rule 1 — Execution Agents do not own primary product design

> **Execution Agents do not own primary product design.**

Agent 可以做工程判断，但不能接管主要产品设计权。

### Rule 2 — Do not silently skip upstream decision stages

> **Do not silently skip upstream decision stages.**

如果一个阶段依赖尚未完成的上游 Artifact，不得假装信息已经存在。

### Rule 3 — Final execution manuals must be grounded in the real implementation state

> **Final execution manuals must be grounded in the real implementation state.**

最终施工手册必须建立在真实仓库、真实分支、真实文件和真实代码扫描结果之上。

不能根据历史聊天、旧 README 或 Agent 自述猜测当前实现。

---

## 备注

- 本文件描述的是 Workflow 的**契约**，不是 Workflow Engine 的实现。
- Milestone 0 阶段**不实现**状态机、Workflow Engine、Commands、Hooks、Skills、Agent Adapter。
- 上述实现工作属于后续里程碑，未经 Owner 批准不得提前开始。

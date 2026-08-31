---
id: handoff
stage: handoff
requires: [owner-acceptance]
produces: [handoff]
authority: planner
---

# Handoff

编译可交给下一任 Human / AI 的确定性 Handoff Package。

## 运行方式（v0.3）

Owner ACCEPT 后：

```bash
speccraft handoff
```

生成 `.speccraft/handoffs/handoff-NNN/`：

```
HANDOFF.md                 # 人类 / 下一任 AI 首先阅读
context.md                 # 复用 Context Compiler
decisions.md               # 编译 .speccraft/decisions/（保留原文）
execution-history.md       # agent-report 与 Run 生命周期
verification-history.md    # 全部 attempt（含失败）
acceptance-history.md      # 全部 decision（含 reject）
manifest.yaml              # 机器读取入口
```

## 职责边界

- 不重新设计产品；
- 不重新总结为新方案（确定性模板生成，不调用 AI）；
- 不修改已批准 Artifact；
- 不执行 Implementation；
- 不复制 node_modules / 整个 repo。

## 权限

- PLANNER

## 禁止行为

- 不伪造 Git commit（Git 不可用则 manifest 明确 `available: false`）
- 不删除失败 / reject 历史
- 不在无状态变化时重复生成 handoff 包（幂等）

## 完成标准

- Handoff Package 七个文件齐全
- manifest 引用 run / latest verification / latest acceptance / Git 快照 / 源文件
- handoff = completed、run = handed_off

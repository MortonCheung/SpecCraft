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

## 机器可执行验证要求（v0.2）

Site Survey **必须**确认目标项目真实存在的验证命令，作为可验证事实记录：

- 真实测试命令（如 `npm test` / `pytest` / `cargo test` / `go test ./...`）
- 真实 typecheck 命令（如 `npm run typecheck` / `tsc --noEmit`）
- 真实 build 命令（如 `npm run build` / `cargo build --release`）
- 真实 lint / runtime 验证命令（若项目存在）

这些命令最终进入 `.speccraft/project.yaml` 的：

```yaml
verification:
  timeout_seconds: 300
  commands:
    - <真实命令 1>
    - <真实命令 2>
```

规则：

- 命令必须来自真实勘察（package.json scripts / Makefile / CI 配置），
  不得臆造；
- 禁止后续从 execution-manual 的 prose 里临时正则解析 shell 命令；
- 若项目尚无验证命令，site-survey 必须显式记录「缺什么、建议补什么」，
  由 Owner 决定是否补齐后写入 project.yaml。

## 权限

- EXECUTOR

## 禁止行为

- 不修改 Design Artifact
- 不「脑补」现状，必须基于真实代码勘察
- 不越权做产品设计
- 不臆造验证命令

## 完成标准

- 真实项目现状已记录，入口 / 依赖 / 约定清晰
- 与 build-brief 的差异已显式列出
- 真实验证命令已确认并记录（供写入 project.yaml verification.commands）

---
id: verification
stage: verification
requires: [implementation]
produces: [verification]
authority: executor
---

# Verification

用事实（真实命令的 exit code）判断 implementation 是否完成。

## v0.2 运行方式

Verification 不再是手工判断。运行：

```bash
speccraft verify
```

SpecCraft 将：

1. 读取 `.speccraft/project.yaml` 的 `verification.commands`
   （来源：Site Survey 确认的真实验证命令）；
2. 在项目根目录按声明顺序执行全部命令（默认 run all，
   不因首个失败丢弃后续信息）；
3. 每条命令写独立 log：`.speccraft/runs/<run-id>/logs/verify-NNN-MM.log`；
4. 每次执行形成 attempt 记录：`.speccraft/runs/<run-id>/verification/attempt-NNN.yaml`；
5. 全部 exit code = 0 → `verification = completed`、`run.status = verified`，
   生成 `.speccraft/artifacts/verification.md`；
6. 任一失败 → `verification = blocked`，**立即重开**
   `implementation = in_progress`（同一 Run 返工，不建 BUGFIX / FIX /
   PATCH / REPAIR 等新 stage）。

## 返工闭环

```
verify FAIL
  ↓
implementation = in_progress（同一个 Run）
  ↓
Agent 修复（Git 改动本身不改变状态）
  ↓
speccraft implement finish --report <new-report>（报告版本化，不覆盖）
  ↓
speccraft verify（attempt + 1）
  ↓
直到 PASS
```

## 硬规则

- 没有配置 verification.commands 时禁止假装成功（verify 直接拒绝）
- 不从 execution-manual prose 临时解析 shell 命令
- 「看起来能跑」不等于验证通过

## 权限

- EXECUTOR

## 禁止行为

- 不跳过验证就宣布完成（Completion Guard）
- 不以「看起来能跑」代替验收标准
- 不为修 bug 创建新 workflow stage

## 完成标准

- 所有配置的验证命令 exit code = 0
- attempt / log / verification.md 证据链完整且与 state 一致

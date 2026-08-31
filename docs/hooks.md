# Hooks（v0.4）

Hook 是「在生命周期边界执行用户声明的自动规则」的轻量机制，
不是第二套 Workflow Engine。

## 语义

```
before_* hook   → 主体操作   →  after_* hook
   (blocking)                  (non-rollback)
```

- **before hook**：blocking。失败则主体操作不执行、状态不推进。
- **after hook**：non-rollback。失败只记录 warning，主体已完成、不倒滚状态。

## 事件（Runtime 事件，不是 Workflow Stage）

```
before_prepare            after_prepare
before_implementation_start   after_implementation_start
before_implementation_finish  after_implementation_finish
before_dispatch           after_dispatch
before_verify             after_verify
before_accept             after_accept
before_reject             after_reject
before_handoff            after_handoff
```

## 配置（project.yaml）

```yaml
hooks:
  before_dispatch:
    - id: require-clean-worktree
      command: git diff --quiet
      timeout_seconds: 30
  after_verify:
    - id: collect-report
      command: ./scripts/collect-report.sh
      timeout_seconds: 30
```

只支持 `id / command / timeout_seconds`。不引入条件表达式、模板语言、
JS 插件、remote webhook、retry DSL、依赖图。

## Env contract（最小，不含 Secret）

```
SPECCRAFT_EVENT
SPECCRAFT_PROJECT_ROOT
SPECCRAFT_DIR
SPECCRAFT_STAGE
SPECCRAFT_RUN_ID / SPECCRAFT_ACTIVE_RUN（有 Run 时）
SPECCRAFT_DISPATCH_ATTEMPT（有值时）
SPECCRAFT_VERIFICATION_ATTEMPT（有值时）
SPECCRAFT_ACCEPTANCE_ATTEMPT（有值时）
SPECCRAFT_ADAPTER（有值时）
```

## 日志

```
.speccraft/runs/<run-id>/hooks/<event>-NNN.log   # 有 Run
.speccraft/logs/hooks/<event>-NNN.log            # 无 Run（如 before_prepare）
```

## 安全边界

Hook 命令来自本地 project.yaml（Owner 控制），用 `shell: true` 执行；
不传用户 Secret / Provider Token 内容。

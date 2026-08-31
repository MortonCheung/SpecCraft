# Worktree Isolation（v0.6）

并行 Task 的施工现场是**仓库外的独立 Git worktree**，canonical 工作区
（用户当前 projectRoot 所在 branch）在 Agent 执行期间绝不被触碰。

设计决策见 [ADR 0007](decisions/0007-safe-parallel-execution-and-worktree-isolation.md)。
调度与集成流程见 [parallel-execution.md](parallel-execution.md)。

## 目录布局

真正 worktree 在仓库外；`.speccraft` 只保存 metadata（evidence）：

```text
<project-parent>/.speccraft-worktrees/<project-name>/<run-id>/<task-id>/attempt-NNN/   # 真实施工现场
.speccraft/runs/<run-id>/tasks/<task-id>/workspaces/attempt-NNN/manifest.yaml          # Workspace Manifest
.speccraft/runs/<run-id>/waves/wave-NNN/manifest.yaml                                  # Wave Manifest
```

## Workspace Attempt

一个 Workspace Attempt = 一次隔离施工尝试：

- 分支名确定性生成：`speccraft/<run>/<task>/wNNN`（先 `git check-ref-format`
  复核）；
- base commit = 创建该 attempt 时的 canonical HEAD；
- attempt 序号通过文件系统原子操作（`mkdir`）并发安全分配；
- 同一 Run 内并行 Task 的 `workspaceRoot` 与 `branch` 永不重复。

复用规则：

| 上一 attempt 状态 | 下一次 execute |
| --- | --- |
| created / active / verified / committed / failed | 复用同一 attempt（worktree 仍在时） |
| integrated / cleaned / integration_conflict / 无 | 新 attempt（序号 +1） |

## Scope Engine（声明 vs 实际）

Task 声明 `scope.paths`，支持精确路径与目录通配符（`dir/**` / `dir/*`）：

```text
src/a/**   vs src/b/**     → compatible（可同 wave）
src/**     vs src/a/**     → conflict（保守：父目录包含）
src/shared/** vs src/shared/config/** → conflict
file-a.ts  vs file-b.ts    → compatible
```

判定是**保守的**：宁可错杀（推迟到后续 wave），绝不放过（同 wave 互踩）。

## Change Audit（范围证明）

每个 Task 在隔离 worktree 内经历两道审计（diff vs base commit）：

1. **Pre-Verification Audit**：dispatch 后、verify 前；
2. **Post-Verification Audit**：verify 后、commit 前（verification 产物也
   必须在 scope 内）。

规则：

- 实际变更路径 ⊄ 声明 scope → `scope audit FAIL`，Task failed，不集成；
- 无任何变更（`no_changes`）→ 默认 failed；
- 越界路径记录进 Workspace Manifest 的 `scope_audit.violations`（证据保留）。

## Executor Git Mutation Guard

Agent 在 worktree 里自己执行 `git commit` 会破坏 Runtime 的提交契约。
每次 commit 前 Runtime 校验：

```text
workspace HEAD == attempt base commit
workspace branch == 声明的 task branch
```

不满足 → `executor_git_mutation`，Task failed，不集成。

## Runtime Task Commit + Deterministic Integration

只有 Runtime 有权提交与集成：

1. `git add -A` → 复核 staged 文件 ⊆ 声明 scope（越界不 commit）；
2. Runtime 生成规范化 commit message 提交（task commit）；
3. 集成阶段按 Task Graph **声明顺序**（不是完成顺序）逐个
   `cherry-pick` 到 canonical：
   - 集成前复核 canonical HEAD == wave base commit 且 clean
     （不满足 = **canonical drift**：停止集成，不 reset、不覆盖，
     workspaces 保留，用户的 commit 不丢失）；
   - cherry-pick conflict → 读取冲突路径 → `cherry-pick --abort` →
     canonical 恢复 clean → Workspace = `integration_conflict`，
     Task = failed，全部 evidence 保留，**绝不自动修复**；
   - 成功 → Workspace = `integrated`，Task = `completed`（completed
     只能由 integration PASS 触发）；
4. 集成成功后清理该 worktree（`clean` 时移除，失败仅 warning）。

## Evidence（append-only）

所有施工证据只增不改，供审计 / validate / handoff / 人类排查：

- Workspace Manifest：status / branch / base / task commit / integration
  commit / scope audit / dispatch attempts / verification attempts /
  failure phase / conflicting paths；
- Wave Manifest：base commit / maxParallel / tasks / integration order /
  per-task result；
- dispatch / verification attempt 目录照旧位于 canonical
  `.speccraft/runs/<run>/`（中心 evidence，隔离的只是施工现场）。

诊断入口：

```bash
speccraft workspaces list
speccraft workspaces show <task-id>
speccraft workspaces clean
```

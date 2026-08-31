# ADR 0008 — Deterministic Executor Assignment

日期：2026-08-31
状态：已接受（v0.7 施工基线）

## 背景

v0.5 建立确定性顺序 Task 调度，v0.6 建立 Git Worktree 隔离并行执行。
v0.7 要解决下一层问题：**Which Executor should execute each Task?**

v0.6 的 Runtime 把同一个 Adapter 传给所有 Task。v0.7 引入 **Executor Profile**
（一种施工 Executor 身份），使 Task 可以显式声明由哪个 Executor 执行，
同时保持确定性、持久性、可审计性，并在 retry / Owner rework 中保持不变。

核心命题：

> Task-to-Executor ownership must be explicit, deterministic, persistent,
> auditable, and stable across retries.

以及：

> SpecCraft routes executors. AI does not choose other AI.

## 决策

### 1. 对象层级与边界

严格保持：

```
Task
≠
Executor Profile
≠
Adapter
≠
Provider Session
≠
Workspace
≠
Dispatch Attempt
```

### 2. Executor Profile ≠ Provider（Adapter）

Executor Profile 是 SpecCraft 定义的施工 Executor 身份；Adapter 才是
Provider CLI 连接。允许两个 Executor Profile 指向同一个 Adapter，使用不同
model / timeout / concurrency policy：

```yaml
executors:
  fast-codex:
    adapter: codex
    model: fast-model
  quality-codex:
    adapter: codex
    model: quality-model
```

### 3. Assignment 必须 deterministic

Task → Executor 来源只能是（优先级从高到低）：

1. Task explicit declaration（`executor: <profile-id>`）
2. project default executor（`execution.default_executor`）
3. legacy default adapter compatibility（`execution.default_adapter` → 逻辑 `legacy-default`）

禁止：AI 选择、LLM ranking、模型打分动态路由、随机路由、成本竞价、
capabilities 自动匹配、`executor: auto`。

### 4. Assignment 属于 Run Evidence（frozen）

一旦 Execution Run 开始实际施工（存在 dispatch / verification / workspace
attempt），Task → Executor Profile 不得偷偷变化。

- Task retry：same Task / same Run / same Executor Assignment。
- Owner Rework：same Task / same Run / same Executor Assignment。
- 新 Workspace Attempt 不改变 Executor Assignment，但必须 fresh session。

Executor Plan 一旦产生，后续 dispatch 只读 `plan.yaml`（frozen），
不能每次重新读取 project.yaml 重新决定。

v0.7 **不实现 reassign**。

### 5. No automatic fallback

Task → claude 但 claude unavailable：禁止 Runtime 自动改成 codex。
结果应为显式失败 / preflight stop：

```
execution preflight blocked
reason: executor_unavailable
```

自动 fallback 会让 Execution Manual intent ≠ actual executor，破坏审计。

### 6. Executor Profile Schema

```
interface ExecutorProfileConfig {
  adapter: string;
  model?: string;
  timeoutSeconds?: number;
  extraArgs?: string[];
  sandbox?: string;
  maxConcurrency?: number;
}
```

禁止 Secret / API key / token / credential 进入 Executor Profile。

### 7. 配置职责与覆盖优先级

- `execution.adapters.<id>`：Adapter 自身如何调用 Provider CLI。
- `execution.executors.<id>`：某种施工 Executor 身份如何使用该 Adapter。

Resolved Executor Config 覆盖优先级：

```
Executor Profile override
↓
Adapter config
↓
Adapter implementation default
```

### 8. max_concurrency

`executor.max_concurrency` 是该 Executor Profile 的并发上限（缺省不加额外
限制，只受 `--max-parallel` 全局限制；禁止默认 1，否则破坏 v0.6 并行行为）。

### 9. Legacy Compatibility

project.yaml 完全没有 `default_executor` / `executors` 时，Runtime 自动建立
逻辑 `legacy-default`（adapter = `execution.default_adapter`）。
不能要求旧项目迁移配置后才能运行。

### 10. 依赖约束

继续禁止：database / sqlite / redis / queue / Provider SDK / LangChain /
LangGraph / CrewAI / AutoGen / execa / simple-git / uuid / nanoid /
API-key manager。Node 标准库足够。

### 11. 权威验证

v0.7 权威 DoD 使用 fake adapters（fake-alpha / fake-beta / fake-unavailable），
不依赖真实 Claude/Codex 网络。

## 明确的非目标（v0.7 不做）

AI model selection、AI scheduler、Agent debate、Agent voting、
Agent-to-Agent chat、automatic fallback、automatic cost optimizer、
token-budget optimizer、review agents、spec reviewer、code-quality
reviewer、remote executor farm、SaaS queue、Redis、database、
Provider SDK、API-key manager。

v0.7 只解决 **Implementer Executor Assignment**。Reviewer Runtime 留待后续。

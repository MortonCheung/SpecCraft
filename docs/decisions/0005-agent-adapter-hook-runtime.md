# ADR 0005 — Agent Adapter & Hook Runtime

日期：2026-08-31
状态：已接受（v0.4 施工基线）

## 背景

v0.3 闭合了 `IDEA → ... → VERIFICATION → OWNER ACCEPTANCE → HANDOFF`，
但 Execution 环节仍是 `manual adapter`：人类把 `agent-prompt.md` 复制给 Agent，
再手动 `implement finish`。

v0.4 补上最后缺失的连接层：让 Runtime 能可靠地调用用户**本机已安装、已登录、
已配置**的 CLI Agent（Codex / Claude Code / OpenCode / TraeCode），并把执行证据
归一化后回流到既有的 Verification / Acceptance / Handoff 流程；同时实现一个
轻量 Hook Runtime，让生命周期关键节点能执行项目级规则。

SpecCraft 仍然是 Workflow / Artifact / Execution / Verification / Acceptance /
Handoff / Adapter / Hook 的 Runtime，而不是 AI Agent、LLM Router 或 SaaS Backend。

## 决策

### 1. Provider-neutral Core

- Core 绝不 import Codex / Claude / OpenCode / Trae；Provider-specific 内容
  只存在于 Adapter 层。
- 继续 `Node child_process.spawn()` 调用本地 CLI，不引入 execa / zx /
  shelljs / OpenAI SDK / Anthropic SDK。
- v0.4 只连接用户本机 CLI Agent。SpecCraft **不管理** API Key / Token /
  账号 / OAuth / 模型账单——这些全部归 Provider CLI 自己管理。

### 2. Adapter 契约（discriminated union）

不做 optional-method soup，用 Base + Manual + CLI 的 union：

```ts
interface ExecutionAdapterBase { id; kind: 'manual' | 'cli'; prepare(...) }
interface ManualExecutionAdapter extends Base { kind: 'manual' }
interface CliExecutionAdapter extends Base {
  kind: 'cli';
  capabilities: AdapterCapabilities;
  probe(): Promise<AdapterProbeResult>;
  buildInvocation(...): Promise<AdapterInvocation>;
  normalize(...): Promise<NormalizedDispatchResult>;
}
```

- `manual` 完全兼容 v0.2/v0.3（只生成 Execution Package）。
- `AdapterCapabilities`：invoke / resume / structuredOutput /
  finalMessageFile / sessionId / modelSelection。
- `probe()` 只做本机能力探测（binary / --version / 基本 capability），
  绝不发送 AI 请求、不消耗 Token。
- Adapter 不负责 Workflow 状态机：不得直接改 state.yaml / stage /
  verification / acceptance / handoff，这些由 Runtime Orchestrator 完成。

### 3. Run ID ≠ Provider Session ID

SpecCraft Run 是业务审计单位；Provider Session 只是某次执行器会话。
一个 Run 可包含多个 dispatch attempt / provider session / verification
attempt / acceptance attempt，但绝不因此创建新 Workflow Stage。

### 4. Dispatch Attempt

- `Run/dispatch/attempt-NNN/` 是 append-only 的执行证据目录；
- 不是 Workflow Stage，编号单调递增、禁止覆盖；
- 一次 Attempt 保存 manifest + stdout + stderr + raw JSONL（如有）+
  events + final message，禁止记录 API Key / Authorization Header /
  完整环境变量。

### 5. Same Run Rework + Session

沿用 v0.2/v0.3 不变量：Verification FAIL 或 Owner REJECT 都重开
implementation、同 Run 返工。同 adapter 再 dispatch 默认 resume 上一
provider session；`--fresh-session` 开新 session；切换 adapter 开新
session 但仍属同一 Run。历史 attempt 不可覆盖。

### 6. Raw + Normalized Evidence

Provider 原始输出（stdout / stderr / JSONL / exit code / duration /
session id）必须保留，同时生成统一 NormalizedDispatchResult。绝不只保留
Agent 最终一句话，也不丢弃 stderr / 退出码 / session id。

### 7. 不提取隐藏思维链

Adapter 只处理 Provider 正常公开输出（events / tool calls / file edits /
commands / final message / session metadata / exit code）。禁止提取 hidden
CoT、推断 private reasoning、保存隐藏模型思考。

### 8. 不默认开启危险权限

Adapter 默认参数不写 `--dangerously-bypass-*` / `--full-auto` / `--yolo` /
`--dangerously-skip-permissions`。用户自己在 Provider CLI 配置里设置是
用户自己的事，SpecCraft 默认不提升权限。

### 9. Dispatch 失败语义

Provider exit != 0 / timeout / spawn error / malformed terminal state →
Dispatch Attempt = failed；但 Run 不结束、implementation 保持 in_progress、
verification 不开始。用户可重新 dispatch 或切换 Agent。

### 10. Hook Runtime（before blocking / after non-rollback）

- 配置只支持 `id / command / timeout_seconds`（不引入 condition DSL、
  模板语言、JS 插件、remote webhook、retry DSL、dependency graph）；
- `before_*` hook：blocking，失败则主体操作不执行、状态不推进；
- `after_*` hook：non-rollback，失败只记录 warning，不倒滚已完成主体；
- Hook 事件是 Runtime 事件，不是 Workflow Stage；
- Hook 通过最小 env contract（SPECCRAFT_EVENT / PROJECT_ROOT / DIR /
  RUN_ID / STAGE / ACTIVE_RUN / *_ATTEMPT / ADAPTER）传参，不传 Secret；
- Hook 日志落 `.speccraft/runs/<run-id>/hooks/`（无 Run 时
  `.speccraft/logs/hooks/`）。

### 11. 安全边界

- 日志不写 Secret（Key / Token / Authorization / Cookie / 完整 env）；
- command 记录 binary + args + cwd，若某参数可能含 secret 必须 redact；
- Provider stdout 作为执行证据可记录，但不主动扫描用户 HOME 找凭据。

## 明确不做（后续版本）

多 Agent 编排 / Planner 自动拆子任务 / 并行 Agent / Agent review-vote-debate、
SaaS Backend、Web 控制台、云同步、远端队列、数据库、消息总线、模型 Router、
Provider API Key 管理系统。这些等单 Executor Adapter 契约稳定后（v0.5+）再议。

## 后果

- Adapter 成为稳定 seam：新增 Provider 只需实现一个 `cli` adapter，
  不改 Core；
- Dispatch Attempt 让「谁在哪个 session 做了什么」成为可审计证据链；
- Hook Runtime 把项目级规则外置为声明式命令，不硬编码进 Runtime；
- 继续 file-first、declarative、provider-neutral、human-directed、
  auditable、deterministic、无数据库、无隐藏 AI 编排。

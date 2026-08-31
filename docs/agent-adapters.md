# Agent Adapters（v0.4 / v0.7）

SpecCraft Core 不依赖任何特定 AI 厂商；Provider-specific 能力以**可选 CLI Adapter**
存在。v0.4 只连接用户**本机已安装、已登录、已配置**的 CLI Agent。

v0.7 在其上引入 **Executor Profile**：Adapter 描述「某个 CLI 如何被调用」，Executor
Profile 描述「某一种施工 Executor 身份如何使用这个 Adapter」。三层关系：

```text
Task
→ Executor Profile（SpecCraft 定义的施工身份）
→ Adapter（Provider CLI 连接）
→ Provider Session（某次执行器会话）
```

完整路由语义见 [executor-routing.md](executor-routing.md)。

## 两种模式

### manual（v0.2/v0.3，保持完全兼容）

`speccraft prepare` 生成 Execution Package（context.md + agent-prompt.md），
人类把 agent-prompt.md 交给任意 Agent，再手动 `implement finish`。

### automatic CLI（v0.4 新增）

`speccraft prepare --adapter <id>` + `speccraft dispatch`，由 Runtime 调用本地
CLI Agent 自动施工，并把执行证据归一化回流到 Verification / Acceptance / Handoff。

## Adapter 列表

| id | binary | 说明 |
| --- | --- | --- |
| manual | - | 生成 Execution Package（不调 AI） |
| codex | codex | `codex exec --json -`（stdin prompt） |
| claude | claude | `claude -p --output-format stream-json` |
| opencode | opencode | `opencode run --format json --file agent-prompt.md` |
| trae | traecli | `traecli exec --json -` |

## Provider-neutral guarantee

- Core 绝不 import Codex / Claude / OpenCode / Trae；
- 只用 `child_process.spawn()`，不引入任何 Provider SDK；
- 只连接本机 CLI，不管理 API Key / Token / 账号 / OAuth / 账单；
- 不默认注入危险权限 flag（`--dangerously-*` / `--yolo` / `--full-auto`）。

## Dispatch Attempt

每次 `speccraft dispatch` 形成 append-only 的 attempt：

```
.speccraft/runs/<run-id>/dispatch/attempt-001/
├── manifest-001.yaml   # attempt / adapter / status / session / exit / command
├── stdout.log
├── stderr.log
├── raw.jsonl           # 结构化原始输出（若 provider 支持）
├── events.jsonl        # 归一化事件
└── final-message.md    # 最终消息（若 provider 提供）
```

`manifest.yaml` 不记录 API Key / Authorization Header / 完整环境变量。

## Run ID ≠ Provider Session ID

- Run 是 SpecCraft 的业务审计单位；
- Provider Session 只是某次执行器会话；
- 一个 Run 可含多个 dispatch attempt / provider session，但绝不创建新 Stage。

## Same Run Rework + Resume

Verification FAIL 或 Owner REJECT 都重开 implementation、同 Run 返工。

- 同 adapter 再 `dispatch` 默认 resume 上一 provider session；
- `--fresh-session` 开新 session；
- `--adapter <other>` 切换 provider → 新 session，但仍属同一 Run。

v0.7 起 session lookup key 升级为：

```text
run + task + workspaceAttempt + executorProfile + adapter
```

`fast-codex` 与 `quality-codex` 即使 Adapter 都是 `codex`，也不是同一个 Executor
Identity，禁止交叉 resume。同 Task 同 Workspace Attempt 同 Executor Profile 才
允许 resume；新 Workspace Attempt 必须是 fresh Provider Session。注意：若 Task
已显式声明 `executor`，`--adapter` 不得覆盖（见
[executor-routing.md](executor-routing.md) 的 `--adapter` 守卫）。

## CLI

```bash
speccraft adapters list           # 列出全部 adapter
speccraft adapters doctor [id]    # 本机能力诊断（不发 AI 请求、不耗 Token）

speccraft executors list          # v0.7：project.yaml 的 Executor Profile（Executor/Adapter/Model/Max Concurrency）
speccraft executors plan          # v0.7：当前 Run 的 frozen Executor Plan（Task/Executor/Adapter/Source/Concurrency）
speccraft executors doctor        # v0.7：probe 当前 Executor Plan 实际需要的 Adapter（按 adapter 去重）

speccraft prepare --adapter codex
speccraft dispatch                # 用 default_adapter
speccraft dispatch --adapter claude
speccraft dispatch --run <id>
speccraft dispatch --fresh-session
```

## project.yaml 配置

Adapter 配置（v0.4）：

```yaml
execution:
  default_adapter: manual
  adapters:
    codex:
      command: codex
      timeout_seconds: 3600
      extra_args: []
      model: gpt-5
    claude:
      command: claude
      timeout_seconds: 3600
```

Executor Profile 配置（v0.7，可选；缺失时 Runtime 自动建立逻辑
`legacy-default`，adapter = `execution.default_adapter`）：

```yaml
execution:
  default_executor: primary
  executors:
    primary:
      adapter: claude
      max_concurrency: 2
    frontend:
      adapter: codex
      model: some-model
      max_concurrency: 1
    backend:
      adapter: claude
      timeout_seconds: 1200
```

Profile 可以覆盖 Adapter 的 model / timeout / extra_args / sandbox（配置优先级：
`Executor Profile override → Adapter config → Adapter implementation default`），
但**禁止**在 Profile 中放 API key / token / secret / credential。Task 通过
Execution Manual 显式声明 `executor: <profile-id>`，或缺省走 `default_executor`。

不在此处保存 Secret。

## 安全边界

- 日志不写 Secret；command 记录 binary + args + cwd（可疑 secret 参数 redact）；
- Provider stdout 作为执行证据可记录，但不主动扫描 HOME 找凭据。

## 已知限制

- codex / opencode / trae 的接口基于 SpecCraft v0.4 施工手册 + 官方文档方向；
  未在未安装环境做真实 smoke，需在安装环境核验（`adapters doctor` 会清晰诊断）。
- Provider parser 对未知事件/未知字段容错（保留 raw 输出），不 crash。

# ADR 0003 — SpecCraft v0.2 Execution & Verification Runtime

日期：2026-08-31
状态：已接受（v0.2 施工基线）

## 背景

v0.1（ADR 0002）实现了从 idea 到 `ready-to-implement` 的规划系统，
并用两条硬编码规则停在那里：

1. `V01_TERMINAL_STAGE = 'ready-to-implement'`：transition cascade、
   `current_stage`、`next` 命令都在此截止；
2. `produces 为空 → 自动完成`：用 stage 结构模拟无 Artifact 过渡阶段。

v0.2 需要把工作流继续打通到 `IMPLEMENTATION → VERIFICATION`，
同时不允许把「版本截止常量」从 v0.1 换成 v0.2 继续欠债。

## 决策

### 1. 声明式 transition：StageDefinition.autoComplete

去掉版本边界硬编码，改为 Workflow 声明式行为：

```yaml
- id: ready-to-implement
  requires: [execution-manual]
  produces: []
  auto_complete: true    # gate 满足时自动级联完成
```

cascadeTransitions 的新语义：

```
stage.autoComplete === true
AND stage.status === pending
AND gate satisfied
→ completed
```

Runtime 不再依据 stage id、版本号或 produces 是否为空猜测行为。
默认 Workflow 中：

- `owner-approval` / `ready-to-implement` → `auto_complete: true`
- `implementation` / `owner-acceptance` → 缺省 false（显式推进）

### 2. Legacy v0.1 兼容（集中单一模块）

`src/core/workflow/legacy.ts` 是 v0.1 遗留语义的**唯一**兼容点：

- 全部阶段都没声明 `auto_complete` 的旧 Workflow 判定为 legacy；
- 含 `ready-to-implement` 边界的旧 16 阶段 Workflow 自动归一化出
  `owner-approval` / `ready-to-implement` 的旧语义；
- 不含边界的自定义 Workflow 取保守值（一律不自动完成）；
- 新 Workflow（任一阶段显式声明）不做任何处理。

旧 `.speccraft/workflow.yaml`、`state.yaml`、`project.yaml` 均可直接读取，
不要求重新 init。禁止 legacy 判断散落到 CLI / State / Guard。

### 3. Execution Run（显式施工运行）

禁止「代码发生变化 = implementation completed」。每次施工形成显式 Run：

```
.speccraft/runs/<run-id>/
├── manifest.yaml          # 状态 / Git 快照 / 报告清单 / attempt 计数
├── context.md             # Context Compiler 编译的上游上下文
├── agent-prompt.md        # 可直接交给任意 Agent 的施工入口
├── agent-report-NNN.md    # 施工报告（版本化，不覆盖）
├── verification/
│   └── attempt-NNN.yaml   # 每次验证的完整记录
└── logs/
    └── verify-NNN-MM.log  # 每条命令的独立日志
```

- Run ID：`run-<UTC 时间戳>-<uuid 前 8 位>`（`crypto.randomUUID()`，不装 nanoid）；
- Run 状态机：`prepared → in_progress → awaiting_verification →
  verification_failed →(返工)→ awaiting_verification → verified`；
- 纯文件存储，无数据库；
- `State` 增加可选 `active_run`（旧 state.yaml 无此字段可正常加载）；
- Git 快照只读（`execution/git.ts` 禁止 commit / push / checkout /
  reset / clean / stash；非 Git 仓库返回 null，不报致命错误）。

### 4. Execution Adapter seam + manual Adapter

```
src/core/execution/adapters/
├── types.ts    # ExecutionAdapter 接口
└── manual.ts   # v0.2 唯一实现
```

manual Adapter 不调用任何 AI。它只生成 `context.md` 与 `agent-prompt.md`
（十节结构：Worker Role / Real Repository Rule / Execution Goal /
Execution Manual 内嵌 / Compiled Context / Execution Guard / Scope /
Verification Requirements / Git Rules / Execution Report Contract），
用户把 `agent-prompt.md` 交给任意 Agent。SpecCraft Runtime 因此不依赖
Codex / Claude / Trae / OpenCode 中的任何一家；其余 adapter 是未来接入点。

Execution Manual 全文直接嵌入 prompt（不是引用文件名），
使 agent-prompt.md 成为自包含的施工入口。

### 5. 显式 Implementation Completion

只有显式命令能改变 Runtime State：

- `speccraft prepare`：门禁（ready-to-implement + execution-manual 均
  completed）→ 创建 Run、生成 Package、写 `active_run`；
  **不**推进 implementation（准备好施工包 ≠ Agent 已开始施工）；
- `speccraft implement start [--run <id>]`：`implementation = in_progress`、
  `run.status = in_progress`；
- `speccraft implement finish --report <path>`：报告必须存在且非空，
  收录为版本化 `agent-report-NNN.md`，`implementation = completed`、
  `current_stage = verification`、保存 final Git 快照。

硬规则：Git 有改动 / commit 存在 / 报告文件存在，都不代表完成
（延续 v0.1「文件存在不能自动代表阶段完成」原则）。

### 6. Verification Runner

命令来源：`.speccraft/project.yaml`：

```yaml
verification:
  timeout_seconds: 300
  commands:
    - npm test
    - npm run typecheck
```

- 这是**目标项目自己的**命令——SpecCraft 不假设 npm（未来可以是
  pytest / cargo test / go test / godot --headless）；
- Site Survey 负责确认真实验证命令（不从 execution-manual prose
  正则解析）；
- 没有命令时 verify 直接拒绝（禁止「无验证命令 → PASS」）；
- 用 Node 原生 `child_process.spawn()`（`shell: true`、`cwd: projectRoot`），
  不引入 execa——命令来自本地 Owner 控制的配置，信任边界成立；
- 默认 run all：不因第一个失败丢弃后续命令的信息；
- 每条命令独立 timeout（默认 300 秒），超时 SIGTERM→SIGKILL，不无限挂住。

### 7. Same-run Rework（失败返工闭环）

任一命令失败：

```
verification = blocked
run.status = verification_failed
立即重开：implementation = in_progress、current_stage = implementation
```

不创建 BUGFIX / FIX / PATCH / REPAIR 新 stage（修 bug 不是独立任务）。
同一 Run 内允许多轮：Attempt 1 → FAIL → Fix → Attempt 2 → FAIL → Fix →
Attempt 3 → PASS。Run ID 不变，attempt / log / report 全部保留可追溯。

### 8. CLI / validate 集成

- `status` 增加 Active Run / Run Status / Verification Attempts；
- `next` 理解 Execution 生命周期六种情况；
- `validate` 新增 Execution 一致性检查（active_run 存在性、
  run verified ↔ verification completed、PASS attempt 存在、
  report 存在等）——只检查一致性，不替代 verify；
- `artifact implementation` 仍拒绝（implementation 不产出阶段 artifact）。

## 明确不做（后续版本）

Owner Acceptance 完整机制、Handoff 完整机制、Claude / Codex / Trae /
OpenCode adapter、多 Agent 编排、SaaS 后端、数据库、Web 控制台、
云同步、远程任务队列、自动 PR Review、复杂 Hook 系统、通用 DAG
Workflow Engine、插件市场。

## 后果

- 「哪些无 Artifact 阶段自动完成」从代码事实变成 Workflow 声明，
  v0.3+ 打通 owner-acceptance / handoff 时只需改 YAML，无需改 Runtime；
- legacy 兼容集中在一个模块，未来可在一次清理中移除；
- 施工 Agent 的产出以 Report + 命令 exit code 的证据链形式被记录，
  Owner Acceptance（后续版本）可以直接消费这些证据；
- 第三方思想（Superpowers / Ponytail / Spec Kit）继续以
  docs/research + third-party 记录来源与 License，不复制代码。

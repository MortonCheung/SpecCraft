# ADR 0004 — SpecCraft v0.3 Acceptance & Handoff Runtime

日期：2026-08-31
状态：已接受（v0.3 施工基线）

## 背景

v0.2（ADR 0003）把工作流打通到 `IMPLEMENTATION → VERIFICATION`。
机器验证通过（`verification = completed`）之后，流程就停在那里。

v0.3 补齐最后两段：

```
VERIFICATION → OWNER ACCEPTANCE → HANDOFF
```

并让整个 Runtime 闭合为「人类意图 → 规划 → 执行 → 机器验证 →
人类验收 → 可审计交接」。

## 决策

### 1. Verification ≠ Owner Acceptance

机器验证通过只能证明「软件通过验证」，不能证明「Owner 满意」。
因此 `verification = completed` 之后**不得**自动 handoff / done，
必须进入 `owner-acceptance = waiting_owner_approval` 等待人类显式决策。

三个问题的答案被严格区分：

- Verification answers: does it work?（机器，exit code）
- Owner Acceptance answers: is this what I wanted?（人类，ACCEPT/REJECT）
- Handoff answers: can the next human or AI safely continue?（确定性包）

### 2. 状态语义

Verification PASS 后：

```
implementation = completed
verification = completed
owner-acceptance = waiting_owner_approval
handoff = pending
current_stage = owner-acceptance
run.status = awaiting_owner_acceptance
```

对应 Workflow：`owner-acceptance` 阶段的 gate 从 `owner_approval`
（requires verification approved）改为 `all_required_completed`
（requires verification completed）——verification 是被「完成」的对象，
不是被「批准」的对象。

### 3. ACCEPT / REJECT

- `speccraft accept [--note | --file | --by]`（默认 by=owner）：
  硬前置：active run 存在 + 最新 verification PASS + verification completed
  + owner-acceptance waiting_owner_approval；任一不满足则 exit != 0。
  成功后 `owner-acceptance = completed`、`current_stage = handoff`、
  `run.status = accepted`，并产生 Acceptance Record。
- `speccraft reject [--reason | --file]`：必须携带真实反馈（二选一，
  否则拒绝执行）。成功后 `owner-acceptance = blocked`、
  `implementation = in_progress`、`verification = pending`、
  `current_stage = implementation`、`run.status = acceptance_rejected`。

### 4. Reject 语义（硬约束）

Reject ≠ Verification Failure：

- Verification Failure = 机器失败（test/build/typecheck 失败）；
- Acceptance Rejection = 人类拒绝（体验/视觉/产品行为不符批准方案）。

Reject 后：

- **不创建**新 Workflow Stage（无 BUGFIX / FIX / REVISION / REWORK /
  PATCH / ACCEPTANCE_REWORK）；
- **不创建**新 Execution Run（同一 Run 返工）；
- 历史 PASS 的 Verification Attempt **不删除**（是历史事实）；
- 只把 implementation 重新打开，下一版代码需要新的 Verification Attempt。

### 5. Acceptance Attempt（版本化审计）

Run 内新增 `.speccraft/runs/<run-id>/acceptance/acceptance-001.md`、
`acceptance-002.md` …，序号单调递增、禁止覆盖。每条 Record 采用
Markdown + YAML Frontmatter，关联 run_id / acceptance attempt /
verification attempt / verification status / owner / timestamp /
Git snapshot / decision / feedback。

Run Manifest 增加最小 acceptance 摘要：

```yaml
acceptance:
  attempt: 2
  status: accepted
  latest_record: acceptance/acceptance-002.md
```

### 6. Handoff Runtime

- `speccraft handoff`：Handoff Guard（active run 存在 + verification
  completed + 最新 verification PASS + owner-acceptance completed +
  最新 acceptance accepted + run.status accepted）全满足才执行。
- 确定性生成 Handoff Package（不调 AI、不改源 Artifact、不复制
  node_modules / 整个 repo）：

```
.speccraft/handoffs/handoff-001/
├── HANDOFF.md               # 人类 / 下一任 AI 首先阅读
├── context.md               # 复用 Context Compiler
├── decisions.md             # 编译 .speccraft/decisions/
├── execution-history.md     # agent-report 与 Run 生命周期
├── verification-history.md  # 全部 attempt（含失败）
├── acceptance-history.md    # 全部 decision（含 reject）
└── manifest.yaml            # 机器读取入口
```

- 幂等：同一已 accepted 且无状态变化的 Run 重复 handoff 返回现有包、
  exit 0，不产生 handoff-002/003 垃圾。
- 成功后 `handoff = completed`、`current_stage = handoff`、
  `run.status = handed_off`，并记录 handoff id / path / generated_at。
- terminal Run 不阻塞未来 `speccraft prepare`（可被新 Run 取代，
  历史 Run 仍可查询，不删除）。

### 7. Git 语义

复用 v0.2 的只读 Git 快照。Handoff Manifest 记录 branch / HEAD /
working tree / accepted verification 的 Git snapshot；Git 不可用时
明确 `git_available: false`，禁止伪造 commit。

## 明确不做

Claude / Codex / Trae / OpenCode adapter、多 Agent 调度、自动 Agent
编排、SaaS、Web UI、数据库、云端状态同步、远程执行平台、完整 Hook
Runtime、dynamic plugin loader。

## 后果

- 验收成为显式、版本化、可审计的人类决策链，而非机器验证的副作用；
- Reject 复用 v0.2 的同 Run 返工机制，Run ID 不变，审计价值最大化；
- Handoff 是确定性编译器产物，可被任何下一任人类 / AI 接手；
- 依赖仍只有 js-yaml，继续 provider-neutral、file-first、lightweight。

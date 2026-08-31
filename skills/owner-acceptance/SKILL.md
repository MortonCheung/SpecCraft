---
id: owner-acceptance
stage: owner-acceptance
requires: [verification]
produces: []
authority: owner
---

# Owner Acceptance

Owner 对「已验证实现」的最终人类验收决策。

## 核心原则

- Owner 是唯一最终体验验收权威；
- Verification PASS 不代表 Owner Acceptance（机器验证只证明「能跑」，
  不证明「是我要的」）；
- Owner 可以 ACCEPT 或 REJECT；
- REJECT 必须提供理由；
- REJECT 不创建新 Run；
- REJECT 不创建新 Workflow Stage。

## 运行方式（v0.3）

Verification PASS 后进入本阶段：

```bash
speccraft verify          # PASS → owner-acceptance = waiting_owner_approval
speccraft accept          # 验收通过
# 或
speccraft reject --reason "..."   # 拒绝，重开 implementation（同 Run 返工）
```

每次决策版本化保存为 `.speccraft/runs/<run-id>/acceptance/acceptance-NNN.md`
（序号单调递增、禁止覆盖）。

## Reject ≠ Verification Failure

- Verification Failure = 机器失败（test/build/typecheck 失败）；
- Acceptance Rejection = 人类拒绝（体验/视觉/产品行为不符批准方案）。

两个概念禁止混为一个状态。

## 权限

- OWNER

## 禁止行为

- 不把 Verification PASS 当作验收完成
- 不空反馈 reject
- 不为修 bug 创建新 Workflow Stage
- 不为返工创建新 Execution Run

## 完成标准

- 每次 Owner 决策都生成 Acceptance Record（含决策、反馈、关联 verification
  attempt 与 Git 快照）
- ACCEPT 后 owner-acceptance = completed，解锁 handoff

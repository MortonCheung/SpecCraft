/**
 * Executor Preflight（ADR 0008 §23-§27）。
 *
 * 在 implementStart / worktree creation / task status mutation 之前完成：
 *   resolve Executor Plan → probe required adapters（按 adapter 去重，不按 Task）→
 *   validate capabilities → PASS / blocked。
 *
 * 失败语义：execution preflight blocked，绝不让 Task 进入 failed（Task 尚未施工）。
 */

import type { ExecutionAdapter, AdapterProbeResult } from '../execution/adapters/types.js';
import { getAdapter } from '../execution/adapters/registry.js';
import type { ExecutorPlan } from './types.js';

export type PreflightBlockReason =
  | 'executor_unavailable'
  | 'capability_mismatch'
  | 'manual_executor';

export interface PreflightItemResult {
  taskId: string;
  executor: string;
  adapter: string;
  status: 'pass' | 'blocked';
  reason?: PreflightBlockReason;
  message?: string;
}

export interface PreflightResult {
  status: 'pass' | 'blocked';
  /** blocked 时：第一个 blocked item 的 reason */
  reason?: PreflightBlockReason;
  items: PreflightItemResult[];
}

const MANUAL_ERROR = 'manual executor cannot be auto-dispatched';

/**
 * Preflight 一个 Executor Plan。
 *
 * 只 probe Plan 实际需要的 adapter（去重，ADR 0008 §24）；
 * 任何 assignment 被 blocked → 整体 blocked，不执行任何施工副作用。
 *
 * @param plan        frozen Executor Plan
 * @param resolve     adapter 解析器（测试可注入 mock；缺省用 registry）
 */
export async function preflightExecutorPlan(
  plan: ExecutorPlan,
  resolve: (adapterId: string) => ExecutionAdapter | undefined = getAdapter,
): Promise<PreflightResult> {
  // Probe 去重：同一 adapter 只 probe 一次（ADR 0008 §24）
  const probes = new Map<string, AdapterProbeResult | 'unknown'>();
  const items: PreflightItemResult[] = [];

  for (const a of plan.assignments) {
    const adapter = resolve(a.adapter);
    if (!adapter) {
      items.push({
        taskId: a.taskId,
        executor: a.executor,
        adapter: a.adapter,
        status: 'blocked',
        reason: 'executor_unavailable',
        message: `adapter ${a.adapter} 未注册（executor ${a.executor}）`,
      });
      continue;
    }

    if (adapter.kind === 'manual') {
      items.push({
        taskId: a.taskId,
        executor: a.executor,
        adapter: a.adapter,
        status: 'blocked',
        reason: 'manual_executor',
        message: `${MANUAL_ERROR}（task ${a.taskId}）`,
      });
      continue;
    }

    // probe（去重）
    if (!probes.has(a.adapter)) {
      probes.set(a.adapter, await adapter.probe());
    }
    const probe = probes.get(a.adapter)!;
    if (probe === 'unknown' || !probe.installed) {
      items.push({
        taskId: a.taskId,
        executor: a.executor,
        adapter: a.adapter,
        status: 'blocked',
        reason: 'executor_unavailable',
        message:
          probe === 'unknown'
            ? `adapter ${a.adapter} 探测失败（executor ${a.executor}）`
            : `adapter ${a.adapter} 未安装${probe.error ? ` — ${probe.error}` : ''}（executor ${a.executor}）`,
      });
      continue;
    }

    // Capability Guard（ADR 0008 §26）：指定 model 但 Adapter 不支持 → FAIL
    const requestedModel = a.resolved.model;
    if (requestedModel && !adapter.capabilities.modelSelection) {
      items.push({
        taskId: a.taskId,
        executor: a.executor,
        adapter: a.adapter,
        status: 'blocked',
        reason: 'capability_mismatch',
        message: `executor ${a.executor} 请求 model "${requestedModel}"，但 adapter ${a.adapter} 不支持 model selection`,
      });
      continue;
    }

    items.push({
      taskId: a.taskId,
      executor: a.executor,
      adapter: a.adapter,
      status: 'pass',
    });
  }

  const firstBlocked = items.find((i) => i.status === 'blocked');
  if (firstBlocked) {
    return { status: 'blocked', reason: firstBlocked.reason, items };
  }
  return { status: 'pass', items };
}

/** 构造 blocked 结果（供 runtime 直接输出） */
export function formatPreflightBlocked(result: PreflightResult): string {
  const reason = result.reason ?? 'unknown';
  return `execution preflight blocked\nreason: ${reason}`;
}

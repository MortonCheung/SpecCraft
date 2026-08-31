/**
 * Executor Diagnostics（ADR 0008 §22、§24、§26）。
 *
 * 为 executors doctor 提供结构化报告：probe Plan 实际需要的 adapter（去重）、
 * 校验 capability、汇总不可用 executor。只诊断，不产生任何施工副作用。
 */

import type { ExecutionAdapter, AdapterProbeResult } from '../execution/adapters/types.js';
import { getAdapter } from '../execution/adapters/registry.js';
import type { ExecutorAssignment, ExecutorPlan } from './types.js';

export interface AdapterDiagnostic {
  adapter: string;
  /** 是否注册 */
  registered: boolean;
  /** cli adapter 是否安装（manual / 未注册时为 undefined） */
  installed?: boolean;
  binary?: string;
  version?: string;
  error?: string;
  /** 被哪些 executor 使用 */
  usedBy: string[];
  /** 是否有 capability mismatch（指定 model 但不支持） */
  capabilityOk: boolean;
  modelRequested?: string;
}

export interface ExecutorDiagnostics {
  runId: string;
  defaultExecutor: string;
  /** 按 adapter 去重（ADR 0008 §24） */
  adapters: AdapterDiagnostic[];
  assignments: ExecutorAssignment[];
  /** 全部 blocked 的 assignment 摘要 */
  blocked: { taskId: string; executor: string; adapter: string; reason: string }[];
}

/**
 * 收集 Executor Plan 的诊断报告（adapter 去重 probe）。
 *
 * @param plan     frozen Executor Plan
 * @param resolve  adapter 解析器（测试可注入 mock；缺省用 registry）
 */
export async function collectExecutorDiagnostics(
  plan: ExecutorPlan,
  resolve: (adapterId: string) => ExecutionAdapter | undefined = getAdapter,
): Promise<ExecutorDiagnostics> {
  const probes = new Map<string, AdapterProbeResult | 'unknown'>();
  const byAdapter = new Map<string, AdapterDiagnostic>();
  const blocked: ExecutorDiagnostics['blocked'] = [];

  for (const a of plan.assignments) {
    const adapter = resolve(a.adapter);
    let diag = byAdapter.get(a.adapter);

    if (!diag) {
      diag = { adapter: a.adapter, registered: !!adapter, usedBy: [], capabilityOk: true };
      byAdapter.set(a.adapter, diag);
      if (adapter) {
        if (adapter.kind === 'manual') {
          diag.installed = true;
          diag.binary = 'manual';
        } else {
          const probe = await adapter.probe();
          probes.set(a.adapter, probe);
          diag.installed = probe.installed;
          if (probe.binary) diag.binary = probe.binary;
          if (probe.version) diag.version = probe.version;
          if (probe.error) diag.error = probe.error;
        }
      }
    }

    diag.usedBy.push(a.executor);

    // capability guard（ADR 0008 §26）
    if (adapter && adapter.kind === 'cli' && a.resolved.model && !adapter.capabilities.modelSelection) {
      diag.capabilityOk = false;
      diag.modelRequested = a.resolved.model;
    }

    const unavailable =
      !diag.registered ||
      (adapter?.kind === 'cli' && !diag.installed) ||
      !diag.capabilityOk;
    if (unavailable) {
      blocked.push({
        taskId: a.taskId,
        executor: a.executor,
        adapter: a.adapter,
        reason: !diag.registered
          ? 'executor_unavailable'
          : adapter?.kind === 'cli' && !diag.installed
            ? 'executor_unavailable'
            : 'capability_mismatch',
      });
    }
  }

  return {
    runId: plan.runId,
    defaultExecutor: plan.defaultExecutor,
    adapters: [...byAdapter.values()],
    assignments: [...plan.assignments],
    blocked,
  };
}

/** 诊断是否整体可用（无 blocked） */
export function diagnosticsPass(diag: ExecutorDiagnostics): boolean {
  return diag.blocked.length === 0;
}

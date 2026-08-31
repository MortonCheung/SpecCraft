/**
 * Deterministic Task Orchestrator（ADR 0006 §7）。
 *
 * 单写者顺序调度（不并行、不 worker pool、不 worktree、不 parallel dispatch）。
 * 全部 Task completed 后生成 Aggregate Execution Report 并调用一次 implementFinish。
 *
 * Execution ≠ Run Verification：execute 到 awaiting_verification 即停止。
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CliExecutionAdapter } from '../execution/adapters/types.js';
import type { ExecutorResolver } from '../executors/resolver.js';
import type { TaskGraph, TaskManifest } from './types.js';
import { readTaskGraph, readAllTaskManifests, writeTaskManifest } from './store.js';
import { refreshStates, firstReadyTask, hasFailedTask, allCompleted } from './dependency.js';
import { dispatchTask } from './dispatch.js';
import { verifyTask } from './verification/lifecycle.js';
import { implementStart, implementFinish } from '../execution/lifecycle.js';
import { runDir, readRun } from '../execution/store.js';

export interface ExecuteOptions {
  speccraftDir: string;
  projectRoot: string;
  runId: string;
  adapter: CliExecutionAdapter;
  runContext: string;
  executionGuard: string;
  adapterConfig?: { command?: string; timeout_seconds?: number; extra_args?: string[]; model?: string; sandbox?: string };
  freshSession?: boolean;
  /**
   * v0.7 ExecutorResolver（ADR 0008 §38）。提供时按 task 从 frozen plan.yaml 解析
   * Executor → Adapter；缺省退化为 legacy single-executor fallback（options.adapter）。
   */
  executorResolver?: ExecutorResolver;
}

export interface ExecuteResult {
  complete: boolean;
  /** complete=false 时的原因 */
  reason?: 'failed_task' | 'blocked_graph' | 'dispatch_failed' | 'verify_failed';
  /** 本次执行完成的 task 数 */
  completedTasks: number;
  /** 顺序执行的 task id 列表（确定性） */
  executed: string[];
  /** 聚合 report 文件名（complete 时） */
  reportFile?: string;
}

/** 执行完整 Task Graph（单写者顺序） */
export async function executeTaskGraph(options: ExecuteOptions): Promise<ExecuteResult> {
  const { speccraftDir, runId } = options;

  // prepared → 显式开始施工（复用 implementStart，同 legacy dispatch）
  const runBefore = await readRun(speccraftDir, runId);
  if (runBefore.status === 'prepared') {
    await implementStart({ projectRoot: options.projectRoot });
  }

  const graph = await readTaskGraph(speccraftDir, runId);
  let manifests = await readAllTaskManifests(speccraftDir, runId);
  let statuses = refreshStates(graph, manifests);
  await persistRefreshedStates(speccraftDir, runId, graph, statuses, manifests);
  const executed: string[] = [];

  while (true) {
    if (hasFailedTask(statuses)) {
      return { complete: false, reason: 'failed_task', completedTasks: countCompleted(graph, statuses), executed };
    }

    const next = firstReadyTask(graph, statuses);
    if (!next) {
      if (allCompleted(graph, statuses)) break;
      return { complete: false, reason: 'blocked_graph', completedTasks: countCompleted(graph, statuses), executed };
    }

    const task = graph.tasks.find((t) => t.id === next)!;
    executed.push(next);

    // v0.7：per-task Executor 解析（ADR 0008 §38）。resolver 存在 → 按 task 取
    // Executor → Adapter；缺省 → legacy single-executor fallback（options.adapter）。
    let adapter = options.adapter;
    let adapterConfig = options.adapterConfig;
    let executorProfile: string | undefined;
    if (options.executorResolver) {
      const r = options.executorResolver.resolve(next);
      adapter = r.adapter;
      adapterConfig = r.adapterConfig;
      executorProfile = r.executorId;
    }

    // dispatch（task ready → in_progress）
    const d = await dispatchTask({
      speccraftDir,
      projectRoot: options.projectRoot,
      runId,
      taskId: next,
      adapter,
      runContext: options.runContext,
      executionGuard: options.executionGuard,
      freshSession: options.freshSession === true,
      ...(adapterConfig ? { adapterConfig } : {}),
      ...(executorProfile ? { executorProfile } : {}),
    });
    if (!d.success) {
      return { complete: false, reason: 'dispatch_failed', completedTasks: countCompleted(graph, statuses), executed };
    }

    // verify（task in_progress → completed/failed）
    const v = await verifyTask({
      speccraftDir,
      projectRoot: options.projectRoot,
      runId,
      taskId: next,
      verification: task.verification,
    });
    if (!v.passed) {
      return { complete: false, reason: 'verify_failed', completedTasks: countCompleted(graph, statuses), executed };
    }

    // refresh
    manifests = await readAllTaskManifests(speccraftDir, runId);
    statuses = refreshStates(graph, manifests);
    await persistRefreshedStates(speccraftDir, runId, graph, statuses, manifests);
  }

  // 全部 completed：确定性生成 Aggregate Execution Report + implementFinish
  const reportFile = await generateAggregateReport(speccraftDir, runId, graph, manifests);
  await implementFinish({ projectRoot: options.projectRoot, reportPath: reportFile });

  return {
    complete: true,
    completedTasks: graph.tasks.length,
    executed,
    reportFile: path.basename(reportFile),
  };
}

/** 确定性生成 Aggregate Execution Report（引用 Task evidence，不调 AI） */
async function generateAggregateReport(
  speccraftDir: string,
  runId: string,
  graph: TaskGraph,
  manifests: Map<string, TaskManifest>,
): Promise<string> {
  const { listDispatchAttemptsForTask } = await import('../dispatch/store.js');
  const { listTaskVerificationAttempts } = await import('./verification/lifecycle.js');

  const lines: string[] = [
    '# Execution Report（Aggregate）',
    '',
    `Run: ${runId}`,
    `Task Graph 完成：${graph.tasks.length} 个 Task`,
    '',
    '## Task 汇总',
    '',
  ];
  for (const t of graph.tasks) {
    const m = manifests.get(t.id);
    const dA = await listDispatchAttemptsForTask(speccraftDir, runId, t.id);
    const vA = await listTaskVerificationAttempts(speccraftDir, runId, t.id);
    lines.push(`- ${t.id}: ${m?.status ?? '?'}（dispatch [${dA.join(', ')}]，verify [${vA.join(', ')}]）`);
  }
  lines.push('');
  lines.push('## 证据引用');
  lines.push('');
  for (const t of graph.tasks) {
    lines.push(`- ${t.id}: runs/${runId}/tasks/${t.id}/verification/`);
  }
  lines.push('');
  lines.push('## 已知问题');
  lines.push('');
  lines.push('（见各 Task 的 dispatch / verification evidence）');
  lines.push('');

  const run = await readRun(speccraftDir, runId);
  const reportFile = path.join(runDir(speccraftDir, runId), `agent-report-${String(run.reports.length + 1).padStart(3, '0')}.md`);
  await writeFile(reportFile, lines.join('\n'), 'utf8');
  return reportFile;
}

function countCompleted(graph: TaskGraph, statuses: Map<string, TaskManifest['status']>): number {
  return graph.tasks.filter((t) => statuses.get(t.id) === 'completed').length;
}

/** 把 refresh 后的非终态（ready/pending/blocked）写回磁盘，使 dispatch 能识别 ready */
export async function persistRefreshedStates(
  speccraftDir: string,
  runId: string,
  graph: TaskGraph,
  statuses: Map<string, TaskManifest['status']>,
  manifests: Map<string, TaskManifest>,
): Promise<void> {
  for (const t of graph.tasks) {
    const m = manifests.get(t.id);
    if (!m) continue;
    const status = statuses.get(t.id);
    if (status && status !== 'completed' && status !== 'failed' && m.status !== status) {
      m.status = status;
      await writeTaskManifest(speccraftDir, runId, m);
    }
  }
}

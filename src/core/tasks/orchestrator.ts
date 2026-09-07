/**
 * Deterministic Task Orchestrator（ADR 0006 §7）。
 *
 * 单写者顺序调度（不并行、不 worker pool、不 worktree、不 parallel dispatch）。
 * 全部 Task completed 后生成 Aggregate Execution Report 并调用一次 implementFinish。
 *
 * Execution ≠ Run Verification：execute 到 awaiting_verification 即停止。
 *
 * v0.8（ADR 0009）：review-enabled 时，Task Verification PASS 后执行 Independent Review Gates。
 * Review PASS 是 Task completed 的必要条件（与 Verification PASS 共同）。
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
import type { ReviewPlan } from '../reviews/types.js';

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
  /** v0.8：frozen Review Plan（ADR 0009 §18）。enabled=true 时启用 Independent Review Gates。 */
  reviewPlan?: ReviewPlan | null;
}

export interface ExecuteResult {
  complete: boolean;
  /** complete=false 时的原因 */
  reason?: 'failed_task' | 'blocked_graph' | 'dispatch_failed' | 'verify_failed' | 'review_failed' | 'preflight_blocked';
  /** 本次执行完成的 task 数 */
  completedTasks: number;
  /** 顺序执行的 task id 列表（确定性） */
  executed: string[];
  /** 聚合 report 文件名（complete 时） */
  reportFile?: string;
  /** v0.8：review 是否启用 */
  reviewEnabled?: boolean;
  /** v0.8：review 失败的 task id（review_failed 时） */
  reviewFailedTask?: string;
  /** v0.8 §8.1：preflight_blocked 时的错误详情（Git readiness 等） */
  reviewPreflightError?: string;
}

/** 执行完整 Task Graph（单写者顺序） */
export async function executeTaskGraph(options: ExecuteOptions): Promise<ExecuteResult> {
  const { speccraftDir, runId } = options;
  const reviewEnabled = options.reviewPlan?.enabled === true && (options.reviewPlan?.gates.length ?? 0) > 0;

  // §8/§8.1：Review Preflight 必须包含 Git Readiness —— fail-before-mutation。
  // review enabled 的 v0.8 要求 Git repo + resolvable HEAD；non-Git 项目必须在此失败，
  // 早于 implementStart / Task status mutation / Dispatch Attempt / workspace creation。
  if (reviewEnabled) {
    const { checkReviewGitReadiness } = await import('../reviews/preflight.js');
    const git = checkReviewGitReadiness(options.projectRoot);
    if (!git.ok) {
      return {
        complete: false,
        reason: 'preflight_blocked',
        completedTasks: 0,
        executed: [],
        reviewEnabled: true,
        reviewPreflightError: git.error,
      };
    }
  }

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

    // v0.7：per-task Executor 解析（ADR 0008 §38）
    let adapter = options.adapter;
    let adapterConfig = options.adapterConfig;
    let executorProfile: string | undefined;
    if (options.executorResolver) {
      const r = options.executorResolver.resolve(next);
      adapter = r.adapter;
      adapterConfig = r.adapterConfig;
      executorProfile = r.executorId;
    }

    // v0.8（§36）：capture preTree before dispatch（仅 review enabled）
    let preTree: string | undefined;
    let preCommit: string | undefined;
    if (reviewEnabled) {
      const { captureTreeSnapshot } = await import('../reviews/snapshot.js');
      const pre = await captureTreeSnapshot(options.projectRoot, `pre-${next}`, `Review pre-snapshot: ${next}`);
      if (!pre.ok) {
        return { complete: false, reason: 'review_failed', completedTasks: countCompleted(graph, statuses), executed, reviewFailedTask: next };
      }
      preTree = pre.treeId;
      preCommit = pre.commitId;
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
    // §Fix 1：review-enabled 时 verification PASS 不能提前 completed
    const v = await verifyTask({
      speccraftDir,
      projectRoot: options.projectRoot,
      runId,
      taskId: next,
      verification: task.verification,
      ...(reviewEnabled ? { completeOnPass: false } : {}),
    });
    if (!v.passed) {
      return { complete: false, reason: 'verify_failed', completedTasks: countCompleted(graph, statuses), executed };
    }

    // v0.8（§67）：review-enabled sequential — Verification PASS 后执行 Review Gates
    if (reviewEnabled && options.reviewPlan) {
      const { captureTreeSnapshot, computeExactDelta } = await import('../reviews/snapshot.js');
      const { executeSequentialReviewGates } = await import('../reviews/sequential.js');

      // capture postTree（§4：postCommit 必须以 preCommit 为 parent，
      // review worktree 才能满足 HEAD^ == preCommit、git diff HEAD^ HEAD == exact delta）
      const post = await captureTreeSnapshot(options.projectRoot, `post-${next}`, `Review post-snapshot: ${next}`, preCommit!);
      if (!post.ok) {
        return { complete: false, reason: 'review_failed', completedTasks: countCompleted(graph, statuses), executed, reviewFailedTask: next };
      }

      // §5.2/§40：no_changes → ERROR —— preTree == postTree 仍必须 FAIL
      // （executor 未产生任何 task 变更），且不被 .speccraft runtime changes 干扰。
      if (preTree === post.treeId) {
        const noChangeManifest = await import('./store.js').then((m) => m.readTaskManifest(speccraftDir, runId, next));
        if (noChangeManifest) {
          noChangeManifest.status = 'failed';
          noChangeManifest.lastError = 'no task changes to review';
          await writeTaskManifest(speccraftDir, runId, noChangeManifest);
        }
        return { complete: false, reason: 'review_failed', completedTasks: countCompleted(graph, statuses), executed, reviewFailedTask: next };
      }

      // compute exact delta
      const delta = await computeExactDelta(options.projectRoot, preCommit!, post.commitId);
      if (!delta.ok) {
        return { complete: false, reason: 'review_failed', completedTasks: countCompleted(graph, statuses), executed, reviewFailedTask: next };
      }

      // §5/§5.1：Runtime deterministic Scope Audit —— Scope Guard 不是 LLM judgment，
      // 不交给 Reviewer 判断；任何 out-of-scope 变更 → Task failed + review attempts = 0。
      // 复用既有 Scope Engine（pathMatchesScope），不新造另一套。
      const { auditScope } = await import('../workspaces/audit.js');
      const scopeAudit = auditScope(task.scope.paths, delta.changedPaths);
      if (!scopeAudit.passed) {
        const auditManifest = await import('./store.js').then((m) => m.readTaskManifest(speccraftDir, runId, next));
        if (auditManifest) {
          auditManifest.status = 'failed';
          auditManifest.lastError = `scope audit FAIL: out-of-scope changes: ${scopeAudit.violations.join(', ')}`;
          await writeTaskManifest(speccraftDir, runId, auditManifest);
        }
        return { complete: false, reason: 'review_failed', completedTasks: countCompleted(graph, statuses), executed, reviewFailedTask: next };
      }

      // §Fix 2：使用 dispatch/verify 实际返回的 attempt，不再从 stale manifest 推导
      const reviewResult = await executeSequentialReviewGates({
        projectRoot: options.projectRoot,
        speccraftDir,
        runId,
        task,
        gates: options.reviewPlan.gates,
        sourceDispatchAttempt: d.attempt,
        sourceVerificationAttempt: v.attempt,
        preTree: preTree!,
        postTree: post.treeId,
        preCommit: preCommit!,
        postCommit: post.commitId,
        diffPatch: delta.patch,
        executionGuard: options.executionGuard,
      });

      if (reviewResult.decision !== 'pass') {
        // §68：Review FAIL → Task failed
        const taskManifest = await import('./store.js').then((m) => m.readTaskManifest(speccraftDir, runId, next));
        if (taskManifest) {
          taskManifest.status = 'failed';
          taskManifest.lastError = `Review ${reviewResult.decision}: ${reviewResult.error ?? 'review gates failed'}`;
          await writeTaskManifest(speccraftDir, runId, taskManifest);
        }
        return { complete: false, reason: 'review_failed', completedTasks: countCompleted(graph, statuses), executed, reviewFailedTask: next };
      }

      // §Fix 1：Review PASS → 显式完成 Task（重新读取 manifest，确保 source of truth）
      const taskManifestAfterReview = await import('./store.js').then((m) => m.readTaskManifest(speccraftDir, runId, next));
      if (taskManifestAfterReview && taskManifestAfterReview.status === 'in_progress') {
        taskManifestAfterReview.status = 'completed';
        taskManifestAfterReview.lastError = undefined;
        await writeTaskManifest(speccraftDir, runId, taskManifestAfterReview);
      }
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
    reviewEnabled,
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
    let reviewInfo = '';
    try {
      const { readReviewPlanOrNull } = await import('../reviews/store.js');
      const { reviewEvidenceDir } = await import('../reviews/paths.js');
      const reviewPlan = await readReviewPlanOrNull(speccraftDir, runId);
      if (reviewPlan?.enabled && reviewPlan.gates.length > 0) {
        const gateResults: string[] = [];
        for (const gate of reviewPlan.gates) {
          const evidenceDir = reviewEvidenceDir(speccraftDir, runId, t.id, gate.id);
          let latestDecision = 'none';
          try {
            const { readdir } = await import('node:fs/promises');
            const entries = await readdir(evidenceDir);
            const attempts = entries.filter((e) => /^attempt-\d+$/.test(e)).sort();
            if (attempts.length > 0) {
              const { readReviewManifestOrNull } = await import('../reviews/attempt.js');
              const manifest = await readReviewManifestOrNull(`${evidenceDir}/${attempts[attempts.length - 1]}/manifest.yaml`);
              if (manifest) latestDecision = manifest.decision;
            }
          } catch { /* no evidence */ }
          gateResults.push(`${gate.id} ${latestDecision.toUpperCase()}`);
        }
        reviewInfo = `，review [${gateResults.join('，')}]`;
      }
    } catch { /* review not available */ }
    lines.push(`- ${t.id}: ${m?.status ?? '?'}（dispatch [${dA.join(', ')}]，verify [${vA.join(', ')}]${reviewInfo}）`);
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

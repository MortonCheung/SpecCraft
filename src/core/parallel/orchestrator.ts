/**
 * Concurrent Parallel Orchestrator（ADR 0007 §14）。
 *
 * 与 sequential orchestrator（src/core/tasks/orchestrator.ts）并存，不重写它。
 *
 * Wave 执行流程（§14.4）：
 *   refresh task states → plan wave → capture canonical HEAD → create all worktrees
 *   → parallel dispatch/audit/verify/commit（Promise.allSettled）
 *   → deterministic integration（Task Graph 声明顺序）
 *   → refresh dependencies → next wave
 *
 * 硬 invariant：
 *   - implementStart / implementFinish 整个 parallel execute 各最多一次；
 *   - Task completed 只能由 integration PASS 触发（§12.7）；
 *   - 当前 wave integration 全部结束前禁止 plan 下一 wave（§14.7）；
 *   - 一个 Task 失败不 rollback 整个 Wave（§14.6）；
 *   - 绝不自动 Run Verification。
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CliExecutionAdapter } from '../execution/adapters/types.js';
import type { HookConfig } from '../hooks/types.js';
import { runBeforeHooks, runAfterHooks } from '../hooks/lifecycle.js';
import type { TaskGraph, TaskManifest } from '../tasks/types.js';
import { readTaskGraph, readAllTaskManifests, readTaskManifest, writeTaskManifest } from '../tasks/store.js';
import { refreshStates, hasFailedTask, allCompleted } from '../tasks/dependency.js';
import { dispatchTask } from '../tasks/dispatch.js';
import { verifyTask } from '../tasks/verification/lifecycle.js';
import { listTaskVerificationAttempts } from '../tasks/verification/lifecycle.js';
import { readExecutorPlanOrNull } from '../executors/store.js';
import { implementStart, implementFinish } from '../execution/lifecycle.js';
import { runDir, readRun } from '../execution/store.js';

import { assertParallelGitReady, createWorkspaceWorktree, removeWorkspaceWorktree, readWorkspaceGitState } from '../workspaces/git.js';
import { auditChangedPaths } from '../workspaces/audit.js';
import {
  nextWorkspaceAttempt,
  readWorkspace,
  writeWorkspace,
  findReusableWorkspace,
  readLatestWorkspace,
} from '../workspaces/store.js';
import { attemptWorktreePath, taskBranchName } from '../workspaces/paths.js';
import {
  readCanonicalHead,
  isCanonicalClean,
  cherryPick,
  abortCherryPick,
  readConflictPaths,
  stageAndAudit,
  commitTask,
} from '../workspaces/integration.js';
import type { WorkspaceManifest, WaveTaskOutcome } from '../workspaces/types.js';

import { planWave } from './planner.js';
import { saveWaveStart, saveWaveFinish } from './store.js';
import { acquireRunLock } from './lock.js';
import type { WavePlan } from './types.js';
import type { ExecutorResolver } from '../executors/resolver.js';

export interface ExecuteParallelOptions {
  speccraftDir: string;
  projectRoot: string;
  runId: string;
  adapter: CliExecutionAdapter;
  runContext: string;
  executionGuard: string;
  maxParallel: number;
  adapterConfig?: { command?: string; timeout_seconds?: number; extra_args?: string[]; model?: string; sandbox?: string };
  freshSession?: boolean;
  /** v0.7：frozen plan.yaml → taskId → Executor（§38）。缺省 → legacy single-executor fallback（§39） */
  executorResolver?: ExecutorResolver;
  /** 项目级 hooks（§17：parallel route 复用既有 4 个 dispatch/verify 事件） */
  hooks?: HookConfig;
  /** v0.8：frozen Review Plan（ADR 0009 §18）。enabled=true 时启用 Independent Review Gates。 */
  reviewPlan?: import('../reviews/types.js').ReviewPlan | null;
}

export interface ExecuteParallelResult {
  complete: boolean;
  reason?:
    | 'failed_task'
    | 'blocked_graph'
    | 'dispatch_failed'
    | 'verify_failed'
    | 'canonical_drift'
    | 'preflight_failed'
    | 'review_failed';
  /** wave 总数 */
  waves: number;
  /** 参与 parallel 执行的 task 数 */
  parallelTasks: number;
  completed: number;
  failed: number;
  conflicts: number;
  /** workspace attempt 总数（本 run） */
  workspaceAttempts: number;
  /** integration commit SHA 列表 */
  integrationCommits: string[];
  /** 顺序执行的 wave → tasks 概览 */
  waveSummaries: { wave: number; tasks: string[] }[];
  executed: string[];
  reportFile?: string;
}

/** wave 内单个 task 的隔离施工结果（integration 前） */
interface IsolatedTaskOutcome {
  taskId: string;
  /** workspace 处于 committed（可 integration）或 failed */
  committed: boolean;
  workspaceAttempt: number;
  taskCommit?: string;
  error?: string;
}

/** 执行完整 Task Graph（parallel isolated route） */
export async function executeParallelTaskGraph(options: ExecuteParallelOptions): Promise<ExecuteParallelResult> {
  const { speccraftDir, runId, projectRoot } = options;

  const lock = await acquireRunLock({ speccraftDir, runId, mode: 'parallel' });

  try {
    // Parallel Preflight（§9.1）：git 状态必须安全，绝不自动 stash/reset/clean
    let baseBranch: string;
    try {
      const ready = await assertParallelGitReady(projectRoot);
      baseBranch = ready.branch;
      void baseBranch;
    } catch (err) {
      void err;
      return {
        complete: false,
        reason: 'preflight_failed',
        waves: 0,
        parallelTasks: 0,
        completed: 0,
        failed: 0,
        conflicts: 0,
        workspaceAttempts: 0,
        integrationCommits: [],
        waveSummaries: [],
        executed: [],
      };
    }

    // implementStart 最多一次（§14.3）
    const runBefore = await readRun(speccraftDir, runId);
    if (runBefore.status === 'prepared') {
      await implementStart({ projectRoot });
    }

    const graph = await readTaskGraph(speccraftDir, runId);
    let manifests = await readAllTaskManifests(speccraftDir, runId);
    let statuses = refreshStates(graph, manifests);
    await persistStates(speccraftDir, runId, graph, statuses, manifests);

    const executed: string[] = [];
    const integrationCommits: string[] = [];
    const waveSummaries: { wave: number; tasks: string[] }[] = [];
    let totalParallelTasks = 0;
    let waveCount = 0;

    // v0.7：frozen plan.yaml → taskId → Executor Assignment（一次读取，全程复用；ADR 0008 §21）
    const executorAssignments = await loadExecutorAssignments(speccraftDir, runId);

    // v0.8：review enabled flag（§74-§78）
    const reviewEnabled = options.reviewPlan?.enabled === true && (options.reviewPlan?.gates.length ?? 0) > 0;

    while (true) {
      if (hasFailedTask(statuses)) {
        return finalize(options, graph, manifests, {
          complete: false,
          reason: 'failed_task',
          waves: waveCount,
          parallelTasks: totalParallelTasks,
          executed,
          integrationCommits,
          waveSummaries,
        });
      }

      // plan wave（deterministic：声明顺序 + scope 保守冲突 + maxParallel + Executor Profile 容量，§43/§44）
      const plan = planWave({
        graph,
        statuses,
        maxParallel: options.maxParallel,
        executorAssignments: executorAssignments,
      });
      if (plan.tasks.length === 0) {
        if (allCompleted(graph, statuses)) break;
        return finalize(options, graph, manifests, {
          complete: false,
          reason: 'blocked_graph',
          waves: waveCount,
          parallelTasks: totalParallelTasks,
          executed,
          integrationCommits,
          waveSummaries,
        });
      }

      // capture canonical HEAD = wave base commit（§7.1）
      const canonicalHead = await readCanonicalHead(projectRoot);
      if (!canonicalHead) {
        return finalize(options, graph, manifests, {
          complete: false,
          reason: 'preflight_failed',
          waves: waveCount,
          parallelTasks: totalParallelTasks,
          executed,
          integrationCommits,
          waveSummaries,
        });
      }

      // wave evidence（开始前落盘，append-only）
      const waveManifest = await saveWaveStart({ speccraftDir, runId, plan, baseCommit: canonicalHead });
      waveCount += 1;
      totalParallelTasks += plan.tasks.length;
      waveSummaries.push({ wave: waveManifest.wave, tasks: [...plan.tasks] });
      executed.push(...plan.tasks);

      // create all worktrees（wave 开始时逐个创建，串行保证分支唯一性）
      const contexts: TaskWorkspaceContext[] = [];
      for (const taskId of plan.tasks) {
        const ctx = await prepareWorkspace({
          projectRoot,
          speccraftDir,
          runId,
          taskId,
          baseCommit: canonicalHead,
          assignment: executorAssignments.get(taskId),
        });
        contexts.push(ctx);
      }

      // parallel dispatch / audit / verify / review / commit（真并行，Promise.allSettled，§14.5）
      const settled = await Promise.allSettled(
        contexts.map((ctx) => executeIsolatedTask(options, graph, ctx, waveManifest.wave, executorAssignments.get(ctx.taskId), reviewEnabled)),
      );
      const outcomes: IsolatedTaskOutcome[] = settled.map((s, i) => {
        if (s.status === 'fulfilled') return s.value;
        const ctx = contexts[i];
        return {
          taskId: ctx.taskId,
          committed: false,
          workspaceAttempt: ctx.attempt,
          error: String(s.reason),
        };
      });

      // 汇总失败到 task manifest（allSettled 的 reject 路径兜底）
      for (const o of outcomes) {
        if (!o.committed && o.error) {
          const m = await readTaskManifest(speccraftDir, runId, o.taskId);
          if (m && m.status === 'in_progress') {
            m.status = 'failed';
            m.lastError = o.error.slice(0, 500);
            await writeTaskManifest(speccraftDir, runId, m);
          }
        }
      }

      // deterministic integration phase（§12.3：声明顺序，不是完成顺序）
      const integration = await integrateWave({
        options,
        waveTasks: [...plan.tasks],
        outcomes,
        waveBaseCommit: canonicalHead,
      });
      integrationCommits.push(...integration.newCommits);

      // wave evidence 收尾
      await saveWaveFinish({
        speccraftDir,
        runId,
        wave: waveManifest.wave,
        results: integration.results,
      });

      // canonical drift：停止后续 wave（workspaces retained，不 reset 用户代码，§12.4）
      if (integration.drift) {
        return finalize(options, graph, manifests, {
          complete: false,
          reason: 'canonical_drift',
          waves: waveCount,
          parallelTasks: totalParallelTasks,
          executed,
          integrationCommits,
          waveSummaries,
        });
      }

      // refresh dependencies → next wave（§14.7：本 wave integration 全部结束后才重新 plan）
      manifests = await readAllTaskManifests(speccraftDir, runId);
      statuses = refreshStates(graph, manifests);
      await persistStates(speccraftDir, runId, graph, statuses, manifests);
    }

    // 全部 completed：aggregate report + implementFinish ONCE（§14.8）
    const result = await finalize(options, graph, manifests, {
      complete: true,
      waves: waveCount,
      parallelTasks: totalParallelTasks,
      executed,
      integrationCommits,
      waveSummaries,
    });
    return result;
  } finally {
    await lock.release();
  }
}

// ---------------------------------------------------------------------------
// Workspace 准备（§7.4：retry 复用 attempt / rework 新 attempt）
// ---------------------------------------------------------------------------

interface TaskWorkspaceContext {
  taskId: string;
  attempt: number;
  workspaceRoot: string;
  branch: string;
  baseCommit: string;
  /** 是否复用了已存在的 worktree */
  reused: boolean;
}

/** v0.7 Workspace 创建时的 Executor Assignment snapshot（ADR 0008 §21；从 frozen plan.yaml 读取） */
interface ExecutorAssignmentSnapshot {
  executor: string;
  adapter: string;
  maxConcurrency?: number;
}

/**
 * 读取 frozen plan.yaml 构建 taskId → assignment snapshot。
 * plan 不存在（legacy run）→ 空 Map（v0.6 兼容：workspace 无 snapshot、dispatch 无 executor_profile）。
 */
async function loadExecutorAssignments(
  speccraftDir: string,
  runId: string,
): Promise<Map<string, ExecutorAssignmentSnapshot>> {
  const plan = await readExecutorPlanOrNull(speccraftDir, runId);
  const map = new Map<string, ExecutorAssignmentSnapshot>();
  if (plan) {
    for (const a of plan.assignments) {
      map.set(a.taskId, {
        executor: a.executor,
        adapter: a.adapter,
        ...(a.maxConcurrency !== undefined ? { maxConcurrency: a.maxConcurrency } : {}),
      });
    }
  }
  return map;
}

async function prepareWorkspace(input: {
  projectRoot: string;
  speccraftDir: string;
  runId: string;
  taskId: string;
  baseCommit: string;
  /** v0.7 Executor Assignment snapshot（写进 workspace manifest） */
  assignment?: ExecutorAssignmentSnapshot;
}): Promise<TaskWorkspaceContext> {
  const { projectRoot, speccraftDir, runId, taskId, baseCommit, assignment } = input;

  // 复用规则（§7.4）：pre-integration 失败 → 复用 attempt；integrated/conflict → 新 attempt
  const reusable = await findReusableWorkspace(speccraftDir, runId, taskId);
  const attempt = reusable ? reusable.attempt : await nextWorkspaceAttempt(speccraftDir, runId, taskId);
  const workspaceRoot = attemptWorktreePath(projectRoot, runId, taskId, attempt);
  const branch = taskBranchName(runId, taskId, attempt);

  if (reusable) {
    // 复用已存在的 worktree（manifest 记录的路径）
    return {
      taskId,
      attempt,
      workspaceRoot: reusable.workspaceRoot || workspaceRoot,
      branch: reusable.branch || branch,
      baseCommit: reusable.baseCommit,
      reused: true,
    };
  }

  // 新 attempt：创建 worktree + manifest
  await createWorkspaceWorktree(projectRoot, { branch, workspacePath: workspaceRoot, baseCommit });
  const manifest: WorkspaceManifest = {
    version: 1,
    runId,
    taskId,
    attempt,
    status: 'created',
    workspaceRoot,
    branch,
    baseCommit,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    dispatchAttempts: [],
    verificationAttempts: [],
    changedPaths: [],
    scopeAudit: { declared: [], actual: [], passed: false, violations: [] },
    // v0.7 Assignment snapshot（ADR 0008 §21）：workspace 创建时的 Executor 归属证据
    ...(assignment?.executor ? { executorProfile: assignment.executor } : {}),
    ...(assignment?.adapter ? { adapter: assignment.adapter } : {}),
  };
  await writeWorkspace(speccraftDir, runId, taskId, manifest);
  return { taskId, attempt, workspaceRoot, branch, baseCommit, reused: false };
}

// ---------------------------------------------------------------------------
// Isolated Task Execution（dispatch → pre-audit → verify → post-audit → commit）
// ---------------------------------------------------------------------------

async function executeIsolatedTask(
  options: ExecuteParallelOptions,
  graph: TaskGraph,
  ctx: TaskWorkspaceContext,
  wave: number,
  /** v0.7 Executor Assignment snapshot（frozen plan.yaml 读取，ADR 0008 §21） */
  assignment?: ExecutorAssignmentSnapshot,
  /** v0.8：是否执行 Independent Review Gates（§74） */
  reviewEnabled?: boolean,
): Promise<IsolatedTaskOutcome> {
  const { speccraftDir, runId, projectRoot } = options;
  const taskId = ctx.taskId;
  const task = graph.tasks.find((t) => t.id === taskId)!;

  // v0.7：per-task Executor 解析（ADR 0008 §38）。无 resolver → legacy single-executor fallback（§39）。
  let adapter = options.adapter;
  let adapterConfig = options.adapterConfig;
  let executorProfile = assignment?.executor;
  if (options.executorResolver) {
    const r = options.executorResolver.resolve(taskId);
    adapter = r.adapter;
    adapterConfig = r.adapterConfig;
    executorProfile = r.executorId;
  }

  const manifest0 = await readWorkspace(speccraftDir, runId, taskId, ctx.attempt);
  const ws = manifest0 ?? (await readLatestWorkspace(speccraftDir, runId, taskId))!;

  const fail = async (phase: string, error: string): Promise<IsolatedTaskOutcome> => {
    ws.status = 'failed';
    ws.failurePhase = phase;
    ws.lastError = error.slice(0, 500);
    await writeWorkspace(speccraftDir, runId, taskId, ws);
    const m = await readTaskManifest(speccraftDir, runId, taskId);
    if (m && m.status === 'in_progress') {
      m.status = 'failed';
      m.lastError = error.slice(0, 500);
      await writeTaskManifest(speccraftDir, runId, m);
    }
    return { taskId, committed: false, workspaceAttempt: ctx.attempt, error };
  };

  /** §17：hook ctx（cwd = workspaceRoot；env 带 workspace / wave / task） */
  const hookCtx = (event: string, extra?: Record<string, string>) => ({
    projectRoot: options.projectRoot,
    speccraftDir,
    runId,
    workspaceRoot: ctx.workspaceRoot,
    env: {
      SPECCRAFT_EVENT: event,
      SPECCRAFT_PROJECT_ROOT: options.projectRoot,
      SPECCRAFT_DIR: speccraftDir,
      SPECCRAFT_STAGE: 'implementation',
      SPECCRAFT_ADAPTER: adapter.id,
      ...(executorProfile ? { SPECCRAFT_EXECUTOR_PROFILE: executorProfile } : {}),
      SPECCRAFT_TASK_ID: taskId,
      SPECCRAFT_WORKSPACE_ROOT: ctx.workspaceRoot,
      SPECCRAFT_WORKSPACE_ATTEMPT: String(ctx.attempt),
      SPECCRAFT_WAVE: String(wave),
      ...(extra ?? {}),
    } as import('../hooks/types.js').HookEnvironment,
  });

  /** after hook 失败：non-rollback，仅记 warning 到 workspace manifest */
  const warnAfterHook = async (label: string, outcome: Awaited<ReturnType<typeof runAfterHooks>>): Promise<void> => {
    if (outcome?.anyFailed) {
      ws.lastError = `${label} hook warning：见 .speccraft/runs/${runId}/hooks/`;
      await writeWorkspace(speccraftDir, runId, taskId, ws);
    }
  };

  try {
    // v0.8（§74）：capture preTree before dispatch（仅 review enabled）
    let preTreeCommit: string | undefined;
    let preTreeTreeId: string | undefined;
    if (reviewEnabled) {
      const { captureTreeSnapshot } = await import('../reviews/snapshot.js');
      const pre = await captureTreeSnapshot(ctx.workspaceRoot, `pre-${taskId}`, `Review pre-snapshot: ${taskId}`);
      if (!pre.ok) {
        return fail('review', `capture preTree failed: ${pre.error}`);
      }
      preTreeCommit = pre.commitId;
      preTreeTreeId = pre.treeId;
    }

    // workspace → active
    ws.status = 'active';
    await writeWorkspace(speccraftDir, runId, taskId, ws);

    // before_dispatch hook（blocking，§17：cwd = workspaceRoot）
    const beforeDispatch = await runBeforeHooks(hookCtx('before_dispatch'), options.hooks, 'before_dispatch');
    if (beforeDispatch.blocked) {
      return fail('hook', `before_dispatch hook 失败（task ${taskId}）`);
    }

    // dispatch（isolated：projectRoot = workspaceRoot；adapter 来自 per-task Executor 解析）
    const d = await dispatchTask({
      speccraftDir,
      projectRoot: ctx.workspaceRoot,
      runId,
      taskId,
      adapter,
      runContext: options.runContext,
      executionGuard: options.executionGuard,
      freshSession: options.freshSession === true,
      ...(adapterConfig ? { adapterConfig } : {}),
      workspaceRoot: ctx.workspaceRoot,
      workspaceAttempt: ctx.attempt,
      ...(executorProfile ? { executorProfile } : {}),
    });
    if (!d.success) {
      return fail('dispatch', `dispatch FAIL（attempt ${d.attempt}）`);
    }
    // after_dispatch hook（non-rollback，§17）
    await warnAfterHook('after_dispatch', await runAfterHooks(
      hookCtx('after_dispatch', { SPECCRAFT_DISPATCH_ATTEMPT: String(d.attempt) }),
      options.hooks,
      'after_dispatch',
    ));
    ws.dispatchAttempts = (await readTaskManifest(speccraftDir, runId, taskId))?.dispatchAttempts ?? [];
    await writeWorkspace(speccraftDir, runId, taskId, ws);

    // Pre-Verification Scope Audit（§10.5）
    const pre = await auditChangedPaths(ctx.workspaceRoot, ctx.baseCommit, task.scope.paths);
    ws.scopeAudit = pre;
    ws.changedPaths = pre.actual;
    if (pre.actual.length === 0) {
      // no_changes（§10.6）：默认 failed
      return fail('scope', 'scope audit FAIL：no_changes（Agent 未产生任何变更）');
    }
    if (!pre.passed) {
      return fail('scope', `SCOPE VIOLATION：${pre.violations.join(', ')}`);
    }
    await writeWorkspace(speccraftDir, runId, taskId, ws);

    // before_verify hook（blocking，§17：cwd = workspaceRoot）
    const beforeVerify = await runBeforeHooks(hookCtx('before_verify'), options.hooks, 'before_verify');
    if (beforeVerify.blocked) {
      return fail('hook', `before_verify hook 失败（task ${taskId}）`);
    }

    // Task Verification（isolated：PASS 不直接 completed，§11.7）
    const v = await verifyTask({
      speccraftDir,
      projectRoot,
      runId,
      taskId,
      verification: task.verification,
      workspaceRoot: ctx.workspaceRoot,
      completeOnPass: false,
    });
    ws.verificationAttempts = await listTaskVerificationAttempts(speccraftDir, runId, taskId);
    await writeWorkspace(speccraftDir, runId, taskId, ws);
    if (!v.passed) {
      return fail('verify', `Task Verification FAIL（attempt ${v.attempt}）`);
    }

    // after_verify hook（non-rollback，§17）
    await warnAfterHook('after_verify', await runAfterHooks(
      hookCtx('after_verify', { SPECCRAFT_VERIFICATION_ATTEMPT: String(v.attempt) }),
      options.hooks,
      'after_verify',
    ));

    // Post-Verification Scope Audit（§10.5：verification 产物也必须在 scope 内）
    const post = await auditChangedPaths(ctx.workspaceRoot, ctx.baseCommit, task.scope.paths);
    ws.scopeAudit = post;
    ws.changedPaths = post.actual;
    if (!post.passed) {
      return fail('scope', `POST-VERIFICATION SCOPE VIOLATION：${post.violations.join(', ')}`);
    }
    if (post.actual.length === 0) {
      return fail('scope', 'scope audit FAIL：no_changes（verification 后无变更）');
    }
    await writeWorkspace(speccraftDir, runId, taskId, ws);

    // v0.8（§74-§77）：Independent Review Gates（post scope audit → review → git mutation guard）
    if (reviewEnabled && options.reviewPlan && preTreeCommit && preTreeTreeId) {
      const { captureTreeSnapshot, computeExactDelta } = await import('../reviews/snapshot.js');
      const { executeSequentialReviewGates } = await import('../reviews/sequential.js');

      const postSnap = await captureTreeSnapshot(ctx.workspaceRoot, `post-${taskId}`, `Review post-snapshot: ${taskId}`);
      if (!postSnap.ok) {
        return fail('review', `capture postTree failed: ${postSnap.error}`);
      }

      if (preTreeTreeId === postSnap.treeId) {
        return fail('review', 'no task changes to review (preTree == postTree)');
      }

      const delta = await computeExactDelta(ctx.workspaceRoot, preTreeCommit, postSnap.commitId);
      if (!delta.ok) {
        return fail('review', `delta computation failed: ${delta.error}`);
      }

      // §Fix 2：使用 dispatch/verify 实际返回的 attempt，不再从 stale manifest 推导
      const reviewResult = await executeSequentialReviewGates({
        projectRoot: ctx.workspaceRoot,
        speccraftDir,
        runId,
        task,
        gates: options.reviewPlan.gates,
        sourceDispatchAttempt: d.attempt,
        sourceVerificationAttempt: v.attempt,
        preTree: preTreeTreeId,
        postTree: postSnap.treeId,
        preCommit: preTreeCommit,
        postCommit: postSnap.commitId,
        diffPatch: delta.patch,
      });

      if (reviewResult.decision !== 'pass') {
        ws.failurePhase = 'review';
        return fail('review', `Review ${reviewResult.decision}: ${reviewResult.error ?? 'review gates failed'}`);
      }
    }

    // Executor Git Mutation Guard（§9.6：HEAD == baseCommit、branch 正确）
    const gitState = await readWorkspaceGitState(ctx.workspaceRoot);
    if (!gitState || gitState.head !== ctx.baseCommit || gitState.branch !== ctx.branch) {
      return fail(
        'git_mutation',
        `executor_git_mutation：branch=${gitState?.branch ?? '?'}（期望 ${ctx.branch}），HEAD=${gitState?.head ?? '?'}（期望 ${ctx.baseCommit}）`,
      );
    }

    // Runtime Commit（§12.1、§12.2：git add -A → staged scope 校验 → Runtime message commit）
    const staged = await stageAndAudit(ctx.workspaceRoot, task.scope.paths);
    if (!staged.passed) {
      return fail('scope', `staged scope VIOLATION：${staged.violations.join(', ')}`);
    }
    const taskCommit = await commitTask(ctx.workspaceRoot, taskId, task.title);

    // workspace → verified → committed
    ws.status = 'committed';
    ws.taskCommit = taskCommit;
    ws.changedPaths = staged.stagedPaths;
    await writeWorkspace(speccraftDir, runId, taskId, ws);

    return { taskId, committed: true, workspaceAttempt: ctx.attempt, taskCommit };
  } catch (err) {
    return fail('dispatch', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Deterministic Integration（§12.3–§12.8）
// ---------------------------------------------------------------------------

interface IntegrateWaveResult {
  drift: boolean;
  newCommits: string[];
  results: WaveTaskOutcome[];
}

async function integrateWave(input: {
  options: ExecuteParallelOptions;
  waveTasks: string[];
  outcomes: IsolatedTaskOutcome[];
  waveBaseCommit: string;
}): Promise<IntegrateWaveResult> {
  const { options, waveTasks, outcomes, waveBaseCommit } = input;
  const { speccraftDir, runId, projectRoot } = options;

  const results: WaveTaskOutcome[] = [];
  const newCommits: string[] = [];
  const byTask = new Map(outcomes.map((o) => [o.taskId, o]));

  // Integration 前 Canonical Guard（§12.4）
  const head = await readCanonicalHead(projectRoot);
  const clean = await isCanonicalClean(projectRoot);
  if (head !== waveBaseCommit || !clean) {
    // canonical_drift：停止 integration，workspace 保持 committed，task 保持 in_progress
    for (const taskId of waveTasks) {
      const o = byTask.get(taskId);
      results.push({ taskId, result: o?.committed ? 'verified' : 'failed' });
    }
    return { drift: true, newCommits, results };
  }

  // expectedCanonicalHead：每集成一个 task 后更新并复核（§12.5）
  let expectedCanonicalHead = waveBaseCommit;

  for (const taskId of waveTasks) {
    const o = byTask.get(taskId);
    if (!o || !o.committed) {
      results.push({ taskId, result: 'failed' });
      continue;
    }

    // 集成前复核 HEAD（防外部进程中途修改 branch）
    const current = await readCanonicalHead(projectRoot);
    if (current !== expectedCanonicalHead || !(await isCanonicalClean(projectRoot))) {
      // 后续全部停止（drift），已集成的不回滚
      for (const rest of waveTasks.slice(waveTasks.indexOf(taskId))) {
        const ro = byTask.get(rest);
        results.push({ taskId: rest, result: ro?.committed ? 'verified' : 'failed' });
      }
      return { drift: true, newCommits, results };
    }

    const ws = await readWorkspace(speccraftDir, runId, taskId, o.workspaceAttempt);
    if (!ws || !ws.taskCommit) {
      results.push({ taskId, result: 'failed' });
      continue;
    }

    // cherry-pick（conflict → detect / record / abort，§12.6）
    const pick = await cherryPick(projectRoot, ws.taskCommit);
    if (!pick.ok) {
      const conflicting = await readConflictPaths(projectRoot);
      await abortCherryPick(projectRoot);
      // abort 后 canonical 应 clean；不满足则视为 drift（不自动 reset）
      if (!(await isCanonicalClean(projectRoot))) {
        return { drift: true, newCommits, results };
      }
      ws.status = 'integration_conflict';
      ws.failurePhase = 'integration';
      ws.conflictingPaths = conflicting;
      ws.lastError = `cherry-pick conflict：${conflicting.join(', ')}`;
      await writeWorkspace(speccraftDir, runId, taskId, ws);
      // Task → failed（§12.6；worktree / branch / task commit / evidence 全保留）
      const m = await readTaskManifest(speccraftDir, runId, taskId);
      if (m && m.status === 'in_progress') {
        m.status = 'failed';
        m.lastError = ws.lastError;
        await writeTaskManifest(speccraftDir, runId, m);
      }
      results.push({ taskId, result: 'conflict' });
      continue;
    }

    // Integration 成功（§12.7）：Workspace → integrated，Task → completed
    const integrationCommit = (await readCanonicalHead(projectRoot)) ?? '';
    ws.status = 'integrated';
    ws.integrationCommit = integrationCommit;
    await writeWorkspace(speccraftDir, runId, taskId, ws);
    const m = await readTaskManifest(speccraftDir, runId, taskId);
    if (m) {
      m.status = 'completed';
      m.lastError = undefined;
      await writeTaskManifest(speccraftDir, runId, m);
    }
    expectedCanonicalHead = integrationCommit;
    newCommits.push(integrationCommit);
    results.push({ taskId, result: 'integrated' });

    // Successful Workspace Cleanup（§12.8：clean 时移除 worktree；失败仅 warning）
    try {
      await removeWorkspaceWorktree(projectRoot, ws.workspaceRoot);
      ws.status = 'cleaned';
      await writeWorkspace(speccraftDir, runId, taskId, ws);
    } catch {
      // cleanup 失败：Task 仍 completed、Workspace 仍 integrated、记录 warning
      ws.lastError = `workspace cleanup warning：worktree 未移除（${ws.workspaceRoot}）`;
      await writeWorkspace(speccraftDir, runId, taskId, ws);
    }
  }

  return { drift: false, newCommits, results };
}

// ---------------------------------------------------------------------------
// finalize + aggregate report
// ---------------------------------------------------------------------------

async function finalize(
  options: ExecuteParallelOptions,
  graph: TaskGraph,
  manifests: Map<string, TaskManifest>,
  partial: {
    complete: boolean;
    reason?: ExecuteParallelResult['reason'];
    waves: number;
    parallelTasks: number;
    executed: string[];
    integrationCommits: string[];
    waveSummaries: { wave: number; tasks: string[] }[];
  },
): Promise<ExecuteParallelResult> {
  const { speccraftDir, runId, projectRoot } = options;

  let reportFile: string | undefined;
  if (partial.complete) {
    const reportPath = await generateParallelAggregateReport(speccraftDir, runId, graph, manifests, partial);
    await implementFinish({ projectRoot, reportPath: reportPath });
    reportFile = path.basename(reportPath);
  }

  let completed = 0;
  let failed = 0;
  let conflicts = 0;
  for (const t of graph.tasks) {
    const s = manifests.get(t.id)?.status;
    if (s === 'completed') completed += 1;
    if (s === 'failed') failed += 1;
  }
  // conflict 数从 wave evidence 统计
  const { listWaves, readWaveManifest } = await import('../workspaces/store.js');
  for (const wave of await listWaves(speccraftDir, runId)) {
    const wm = await readWaveManifest(speccraftDir, runId, wave);
    conflicts += wm?.results.filter((r) => r.result === 'conflict').length ?? 0;
  }

  const attempts = await countWorkspaceAttempts(speccraftDir, runId, graph);

  return {
    complete: partial.complete,
    ...(partial.reason ? { reason: partial.reason } : {}),
    waves: partial.waves,
    parallelTasks: partial.parallelTasks,
    completed,
    failed,
    conflicts,
    workspaceAttempts: attempts,
    integrationCommits: partial.integrationCommits,
    waveSummaries: partial.waveSummaries,
    executed: partial.executed,
    ...(reportFile ? { reportFile } : {}),
  };
}

/** 确定性生成 Parallel Aggregate Execution Report（含 waves / integration，不调 AI） */
async function generateParallelAggregateReport(
  speccraftDir: string,
  runId: string,
  graph: TaskGraph,
  manifests: Map<string, TaskManifest>,
  partial: { waves: number; waveSummaries: { wave: number; tasks: string[] }[]; integrationCommits: string[] },
): Promise<string> {
  const { listDispatchAttemptsForTask } = await import('../dispatch/store.js');
  const { listTaskVerificationAttempts } = await import('../tasks/verification/lifecycle.js');
  const { listWaves, readWaveManifest } = await import('../workspaces/store.js');

  const lines: string[] = [
    '# Execution Report（Aggregate · Parallel）',
    '',
    `Run: ${runId}`,
    `Execution Mode: parallel`,
    `Waves: ${partial.waves}`,
    `Task Graph 完成：${graph.tasks.length} 个 Task`,
    '',
    '## Waves',
    '',
  ];
  for (const wave of await listWaves(speccraftDir, runId)) {
    const wm = await readWaveManifest(speccraftDir, runId, wave);
    if (!wm) continue;
    lines.push(
      `- wave-${String(wm.wave).padStart(3, '0')}：tasks [${wm.tasks.join(', ')}]，integration order [${wm.integrationOrder.join(', ')}]，base ${wm.baseCommit.slice(0, 10)}`,
    );
    for (const r of wm.results) lines.push(`  - ${r.taskId}: ${r.result}`);
  }
  lines.push('');
  lines.push('## Task 汇总');
  lines.push('');
  for (const t of graph.tasks) {
    const m = manifests.get(t.id);
    const dA = await listDispatchAttemptsForTask(speccraftDir, runId, t.id);
    const vA = await listTaskVerificationAttempts(speccraftDir, runId, t.id);
    lines.push(`- ${t.id}: ${m?.status ?? '?'}（dispatch [${dA.join(', ')}]，verify [${vA.join(', ')}]）`);
  }
  lines.push('');
  lines.push('## Integration Commits');
  lines.push('');
  for (const c of partial.integrationCommits) lines.push(`- ${c}`);
  if (partial.integrationCommits.length === 0) lines.push('- （无）');
  lines.push('');
  lines.push('## 已知问题');
  lines.push('');
  lines.push('（见各 Task 的 dispatch / verification / workspace evidence）');
  lines.push('');

  const run = await readRun(speccraftDir, runId);
  const reportFile = path.join(
    runDir(speccraftDir, runId),
    `agent-report-${String(run.reports.length + 1).padStart(3, '0')}.md`,
  );
  await writeFile(reportFile, lines.join('\n'), 'utf8');
  return reportFile;
}

async function countWorkspaceAttempts(speccraftDir: string, runId: string, graph: TaskGraph): Promise<number> {
  const { listWorkspaceAttempts } = await import('../workspaces/store.js');
  let total = 0;
  for (const t of graph.tasks) {
    total += (await listWorkspaceAttempts(speccraftDir, runId, t.id)).length;
  }
  return total;
}

/** 把 refresh 后的非终态写回磁盘，使 dispatch 能识别 ready（复用 sequential 语义） */
async function persistStates(
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

/** WavePlan 类型重导出（供 CLI / status 使用） */
export type { WavePlan };

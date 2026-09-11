/**
 * Deterministic Replanning（SpecCraft v0.9 §35–§43，ADR 0010）。
 *
 *   speccraft changes replan <change-id>
 *
 * 只允许 `approved` 的 Change。职责：
 *
 *   读取 approved Analysis snapshot（§23 resolved snapshot，禁止再读 mutable proposal）
 *   ↓ 重新生成 Execution Package
 *   ↓ 重新编译 Task Graph / Executor Plan / Review Plan
 *   ↓ 验证 digest 与 approved Candidate 完全一致（§36，不一致 → non_deterministic_recompile）
 *   ↓ 创建 Successor Run（§37）并写 lineage / materialization（§38）
 *   ↓ 最后才 supersede predecessor（§39）并把 Change 置为 materialized
 *
 * 三条硬边界：
 *   §40 Materialization Failure —— 失败时安全清理 Successor，Change 保持 approved，
 *        predecessor 不得被 supersede；
 *   §42 不自动施工 —— replan 只 create successor + compile frozen state，不 dispatch / execute；
 *   §43 不建立第二套 runtime —— 复用 createRun / 既有 adapter / 既有 plan store。
 */

import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { State, Workflow } from '../types.js';
import { readState, writeState } from '../state/store.js';
import { parseArtifact } from '../artifacts/store.js';
import { compileContextFrom, renderContext } from '../context/compiler.js';
import { loadProjectConfig, parseProjectConfig } from '../project.js';
import type { ProjectConfig } from '../project.js';
import { captureGitSnapshot } from '../execution/git.js';
import { createRun, generateRunId, runDir } from '../execution/store.js';
import { getAdapter, listAdapterIds } from '../execution/adapters/registry.js';
import { completedStages, readSkill } from '../execution/prepare.js';
import { compileTaskGraphFromManual, initialTaskStates } from '../tasks/compiler.js';
import { createTaskManifest, readTaskGraphOrNull, writeTaskGraph } from '../tasks/store.js';
import { buildExecutorPlan } from '../executors/plan.js';
import { buildExecutorsContext } from '../executors/resolver.js';
import { writeExecutorPlan } from '../executors/store.js';
import type { ExecutorPlan } from '../executors/types.js';
import { buildFrozenReviewPlan } from '../reviews/plan.js';
import { validateReviewConfig } from '../reviews/config.js';
import { writeReviewPlan } from '../reviews/store.js';
import type { ReviewPlan } from '../reviews/types.js';
import { executorPlanDigest, reviewPlanDigest, taskGraphDigest } from './digest.js';
import {
  RESOLVED_DIR,
  analysisAttemptDir,
  analysisBundleDigest,
  readAnalysisAttemptOrNull,
} from './analyze.js';
import type { AnalysisAttempt } from './analyze.js';
import { readApprovalOrNull } from './approval.js';
import type { Approval } from './approval.js';
import {
  checkLineageConsistency,
  materializationPath,
  readRunSupersessionOrNull,
  writeChangeMaterialization,
  writeRunLineage,
  writeRunSupersession,
} from './lineage.js';
import { changeDir, readChangeManifest, updateChangeStatus } from './store.js';
import type { ChangeSetManifest } from './types.js';
import { ChangeError } from './types.js';

/** Successor Execution Package 使用的 adapter（与 prepare 默认一致） */
const REPLAN_ADAPTER_ID = 'manual';

export interface ReplanChangeOptions {
  speccraftDir: string;
  /** 目标项目根目录（Git 快照） */
  projectRoot: string;
  changeId: string;
  workflow: Workflow;
  now?: Date;
}

export interface ReplanChangeResult {
  changeId: string;
  predecessorRun: string;
  successorRun: string;
  /** 被批准的 Analysis Attempt（§38 lineage） */
  attempt: string;
  taskGraphDigest: string | null;
  executorPlanDigest: string | null;
  reviewPlanDigest: string | null;
}

/**
 * 把 approved Change materialize 成一个 Successor Run（§35–§43）。
 *
 * 任何在 Successor 完整创建之前的失败都不会 supersede predecessor、不会改变 Change 状态。
 */
export async function replanChange(options: ReplanChangeOptions): Promise<ReplanChangeResult> {
  const { speccraftDir, changeId, workflow } = options;
  const now = options.now ?? new Date();
  const createdAt = now.toISOString();

  const manifest = await readChangeManifest(speccraftDir, changeId);
  assertReplanAllowed(manifest);

  const approval = await readApprovalOrNull(speccraftDir, changeId);
  if (!approval) {
    throw new ChangeError(
      'change_not_approved',
      `Change ${changeId} 没有 approval.yaml，请先运行 speccraft changes approve。`,
    );
  }

  const predecessorRun = manifest.baseRunId;
  const existingSupersession = await readRunSupersessionOrNull(speccraftDir, predecessorRun);
  if (existingSupersession) {
    throw new ChangeError(
      'run_superseded',
      `Run ${predecessorRun} has already been superseded by ${existingSupersession.successor_run}.`,
    );
  }

  const attempt = await readApprovedAttempt(speccraftDir, changeId, approval);
  const attemptDir = analysisAttemptDir(speccraftDir, changeId, attempt.attempt);

  // §36：approved Evidence 不得被 tamper（bundle digest 与 approval 绑定）
  await assertApprovedSnapshotIntact(attemptDir, approval);

  // §23 / §35：只读 approved Attempt 的 resolved snapshot
  const resolvedManualBytes = await readFileOrNull(
    path.join(attemptDir, RESOLVED_DIR, 'artifacts', 'execution-manual.md'),
  );
  const baseManualBytes = await readBaselineManualBytes(speccraftDir, changeId, manifest);
  const manualChanged =
    resolvedManualBytes !== null && !buffersEqual(resolvedManualBytes, baseManualBytes);

  const successorRunId = generateRunId(now);

  // §36：重新编译（规则与 Analysis 完全一致）
  const candidateGraph = manualChanged
    ? compileTaskGraphFromManual({
        manualBody: resolvedManualBytes!.toString('utf8'),
        runId: successorRunId,
        source: 'execution-manual',
      })
    : null;
  // Manual 未变化时复用 predecessor 的 Task Graph，但重绑为 Successor 自己的身份。
  // digest 排除 runId / createdAt（§36），不影响与 approved Candidate 的比对。
  const baseGraph = candidateGraph ? null : await readTaskGraphOrNull(speccraftDir, predecessorRun);
  const graph = candidateGraph ?? (baseGraph ? { ...baseGraph, runId: successorRunId, createdAt } : null);

  const projectConfig = await readResolvedProjectConfig(speccraftDir, attemptDir, attempt);
  const adapters = projectConfig.execution?.adapters ?? {};
  const reviewConfig = projectConfig.review ?? null;

  let executorPlan: ExecutorPlan | null = null;
  let reviewPlan: ReviewPlan | null = null;
  if (graph) {
    executorPlan = buildExecutorPlan(buildExecutorsContext(projectConfig), adapters, graph, now);
    if (reviewConfig?.enabled) {
      validateReviewConfig(reviewConfig, new Set(listAdapterIds()));
    }
    reviewPlan = buildFrozenReviewPlan({
      runId: successorRunId,
      reviewConfig,
      projectAdapters: adapters,
      knownAdapters: new Set(listAdapterIds()),
    });
  }

  assertRecompileMatches(changeId, approval, {
    taskGraph: graph ? taskGraphDigest(graph) : null,
    executorPlan: executorPlan ? executorPlanDigest(executorPlan) : null,
    reviewPlan: reviewPlan ? reviewPlanDigest(reviewPlan) : null,
  });

  // -------------------------------------------- §37 创建 Successor Run
  const state: State = await readState(speccraftDir);
  const gitSnapshot = await captureGitSnapshot(options.projectRoot);

  try {
    const runManifest = await createRun(speccraftDir, {
      id: successorRunId,
      ...(gitSnapshot ? { baseGit: gitSnapshot } : {}),
      now,
    });
    const dir = runDir(speccraftDir, successorRunId);

    // Execution Package：基于 resolved snapshot 编译，不读当前 canonical artifacts
    const adapter = getAdapter(REPLAN_ADAPTER_ID);
    if (!adapter) {
      throw new Error(`execution adapter ${REPLAN_ADAPTER_ID} 未注册`);
    }
    const stageByArtifact = new Map<string, string>();
    for (const stage of workflow.stages) {
      const artifact = stage.produces[0];
      if (artifact) stageByArtifact.set(artifact, stage.id);
    }
    const compiledContext = renderContext(
      await compileContextFrom(workflow, 'implementation', (artifactId) => {
        const stageId = stageByArtifact.get(artifactId);
        return stageId
          ? path.join(attemptDir, RESOLVED_DIR, 'artifacts', `${stageId}.md`)
          : '';
      }),
    );
    const prepared = await adapter.prepare({
      speccraftDir,
      runId: successorRunId,
      manifest: runManifest,
      // 与 prepare 一致：嵌入 Execution Manual body；frozen plan 复算则使用 resolved 原始字节
      executionManual: resolvedManualBytes
        ? parseArtifact(resolvedManualBytes.toString('utf8')).body
        : '',
      compiledContext,
      executionGuard: await readSkill('execution-guard'),
      verification: {
        commands: projectConfig.verification?.commands ?? [],
        timeoutSeconds: projectConfig.verification?.timeoutSeconds ?? 300,
      },
      gitSnapshot,
      readyStages: completedStages(workflow, state),
    });
    for (const [name, content] of Object.entries(prepared.files)) {
      await writeFile(path.join(dir, name), content, 'utf8');
    }

    // Successor 自己的 frozen plans（§37：不共享 predecessor frozen Evidence）
    if (executorPlan) await writeExecutorPlan(speccraftDir, successorRunId, executorPlan);
    if (reviewPlan) await writeReviewPlan(speccraftDir, successorRunId, reviewPlan);
    if (graph) {
      await writeTaskGraph(speccraftDir, successorRunId, graph);
      const initial = initialTaskStates(graph);
      for (const task of graph.tasks) {
        await createTaskManifest(speccraftDir, successorRunId, task.id, initial[task.id]!, now);
      }
    }

    // §38：lineage 与 materialization 互相一致
    await writeRunLineage(speccraftDir, successorRunId, {
      predecessor_run: predecessorRun,
      change_id: changeId,
      approved_analysis_attempt: attempt.attempt,
      created_at: createdAt,
    });
    await writeChangeMaterialization(speccraftDir, changeId, {
      change_id: changeId,
      successor_run: successorRunId,
      approved_analysis_attempt: attempt.attempt,
      created_at: createdAt,
    });
    const consistency = await checkLineageConsistency(speccraftDir, changeId, successorRunId);
    if (!consistency.consistent) {
      throw new Error(`Successor lineage 不一致：${consistency.reason ?? '未知原因'}`);
    }
  } catch (err) {
    // §40：不留半死的 Successor Run，也不留下 materialization 证据；Change 保持 approved
    await rm(runDir(speccraftDir, successorRunId), { recursive: true, force: true });
    await rm(materializationPath(speccraftDir, changeId), { force: true });
    throw err;
  }

  // §39：Successor 完整创建 + digest 一致之后，才允许 supersede predecessor
  await writeRunSupersession(speccraftDir, predecessorRun, {
    change_id: changeId,
    successor_run: successorRunId,
    superseded_at: createdAt,
  });
  await updateChangeStatus(speccraftDir, manifest, 'materialized');

  // §42：只切换执行目标，不 dispatch / execute
  state.active_run = successorRunId;
  await writeState(speccraftDir, state);

  return {
    changeId,
    predecessorRun,
    successorRun: successorRunId,
    attempt: attempt.attempt,
    taskGraphDigest: graph ? taskGraphDigest(graph) : null,
    executorPlanDigest: executorPlan ? executorPlanDigest(executorPlan) : null,
    reviewPlanDigest: reviewPlan ? reviewPlanDigest(reviewPlan) : null,
  };
}

// ---------------------------------------------------------------------------
// gates
// ---------------------------------------------------------------------------

/** §35：只有 approved 可以 replan */
function assertReplanAllowed(manifest: ChangeSetManifest): void {
  if (manifest.status === 'approved') return;
  if (manifest.status === 'rejected') {
    throw new ChangeError('change_rejected', `Change ${manifest.id} 已 rejected，不可 replan。`);
  }
  throw new ChangeError(
    'change_not_approved',
    `Change ${manifest.id} 当前状态为 ${manifest.status}，只有 approved 的 Change 可以 replan。`,
  );
}

/** 读取 approval 绑定的 Analysis Attempt；必须是 complete（§32） */
async function readApprovedAttempt(
  speccraftDir: string,
  changeId: string,
  approval: Approval,
): Promise<AnalysisAttempt> {
  const attempt = await readAnalysisAttemptOrNull(speccraftDir, changeId, approval.analysis_attempt);
  if (!attempt || attempt.result !== 'complete') {
    throw new ChangeError(
      'no_complete_analysis',
      `Change ${changeId} 的 approval 绑定的 Analysis Attempt ${approval.analysis_attempt} ` +
        `不存在或不是 complete。`,
    );
  }
  return attempt;
}

/** §36：approved snapshot 内容不得漂移（tamper 或 digest mismatch → non_deterministic_recompile） */
async function assertApprovedSnapshotIntact(
  attemptDir: string,
  approval: Approval,
): Promise<void> {
  if (!approval.analysis_bundle_sha256) return;
  const current = await analysisBundleDigest(attemptDir);
  if (current !== approval.analysis_bundle_sha256) {
    throw new ChangeError(
      'non_deterministic_recompile',
      `Approved Analysis Evidence 已被修改：当前 bundle ${current ?? 'null'} ` +
        `≠ approved ${approval.analysis_bundle_sha256}。`,
    );
  }
}

/** §36 Recompile Must Match：三项 frozen plan digest 必须与 approved Candidate 完全一致 */
function assertRecompileMatches(
  changeId: string,
  approval: Approval,
  recompiled: {
    taskGraph: string | null;
    executorPlan: string | null;
    reviewPlan: string | null;
  },
): void {
  const pairs: Array<[string, string | null, string | null]> = [
    ['task graph', approval.candidate_task_graph_digest, recompiled.taskGraph],
    ['executor plan', approval.candidate_executor_plan_digest, recompiled.executorPlan],
    ['review plan', approval.candidate_review_plan_digest, recompiled.reviewPlan],
  ];
  for (const [name, approved, actual] of pairs) {
    if (approved !== actual) {
      throw new ChangeError(
        'non_deterministic_recompile',
        `Change ${changeId} 的 ${name} 重新编译结果与 approved Candidate 不一致：` +
          `${actual ?? 'null'} ≠ ${approved ?? 'null'}。`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** resolved snapshot 中的 project.yaml（§23）；无快照时回退到 canonical project.yaml */
async function readResolvedProjectConfig(
  speccraftDir: string,
  attemptDir: string,
  attempt: AnalysisAttempt,
): Promise<ProjectConfig> {
  if (!attempt.project) return loadProjectConfig(speccraftDir);
  const bytes = await readFileOrNull(path.join(attemptDir, attempt.project.path));
  return bytes ? parseProjectConfig(bytes.toString('utf8')) : loadProjectConfig(speccraftDir);
}

/** baseline 中的 execution-manual 原始字节（用于判断 Manual 是否真的变化） */
async function readBaselineManualBytes(
  speccraftDir: string,
  changeId: string,
  manifest: ChangeSetManifest,
): Promise<Buffer | null> {
  const entry = manifest.artifacts.find((a) => a.stage === 'execution-manual');
  if (!entry) return null;
  return readFileOrNull(path.join(changeDir(speccraftDir, changeId), entry.path));
}

async function readFileOrNull(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.equals(b);
}

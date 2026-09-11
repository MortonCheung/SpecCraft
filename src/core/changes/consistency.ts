/**
 * Change 一致性校验（SpecCraft v0.9 §58，ADR 0010）。
 *
 * `speccraft validate` 通过 `checkChangeConsistency()` 只读扫描 Change Evidence，
 * 任何 tampering 都必须使 validate FAIL。本模块不修改任何状态。
 *
 * 校验项（§58）：
 *   Change ID / path 一致；base Run 存在；baseline digest 正确；
 *   Analysis bundle digest 正确；approved attempt 存在；
 *   approval digest 与 Attempt 一致；materialized Change 必须有 Successor；
 *   Successor lineage 反向指向同一 Change；predecessor superseded 与 materialization 一致；
 *   rejected Change 不得有 successor；closed Change 必须 successor accepted；
 *   close target hash 正确；一个 base Run 最多一个 active Change；
 *   superseded Run 不得是 active execution target；Candidate / Replan frozen plan digest 一致。
 */

import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { State } from '../types.js';
import { readRun, runDir } from '../execution/store.js';
import { PROJECT_FILE } from '../state/store.js';
import { readTaskGraphOrNull } from '../tasks/store.js';
import { readExecutorPlanOrNull } from '../executors/store.js';
import { readReviewPlanOrNull } from '../reviews/store.js';
import {
  executorPlanDigest,
  reviewPlanDigest,
  sha256Bytes,
  taskGraphDigest,
} from './digest.js';
import {
  analysisAttemptDir,
  analysisBundleDigest,
  readAnalysisAttemptOrNull,
} from './analyze.js';
import { readApprovalOrNull } from './approval.js';
import { readChangeCloseOrNull } from './close.js';
import {
  checkLineageConsistency,
  readChangeMaterializationOrNull,
  readRunLineageOrNull,
  readRunSupersessionOrNull,
} from './lineage.js';
import { changeDir, listChangeIds, readChangeManifestOrNull } from './store.js';
import { isActiveChangeStatus } from './types.js';
import type { ChangeSetManifest } from './types.js';

/**
 * 扫描全部 Change Evidence，返回违规描述列表（空表示一致）。
 *
 * 只读；缺失的 Evidence（无 `.speccraft/changes/`）直接跳过，保持 v0.8 legacy 行为。
 */
export async function checkChangeConsistency(
  speccraftDir: string,
  state: State,
): Promise<string[]> {
  const violations: string[] = [];

  const ids = await listChangeIds(speccraftDir);
  const manifests: ChangeSetManifest[] = [];
  for (const id of ids) {
    const manifest = await readChangeManifestOrNull(speccraftDir, id);
    if (!manifest) {
      violations.push(`Change ${id} 缺少 manifest.yaml（目录与变更集不一致）`);
      continue;
    }
    // Change ID / path 一致
    if (manifest.id !== id) {
      violations.push(`Change ${id} 的 manifest.id=${manifest.id} 与目录名不一致`);
    }
    manifests.push(manifest);
  }

  // 一个 base Run 最多一个 active Change
  const activeByRun = new Map<string, string[]>();
  for (const manifest of manifests) {
    if (!isActiveChangeStatus(manifest.status)) continue;
    const list = activeByRun.get(manifest.baseRunId) ?? [];
    list.push(manifest.id);
    activeByRun.set(manifest.baseRunId, list);
  }
  for (const [runId, list] of activeByRun) {
    if (list.length > 1) {
      violations.push(`base Run ${runId} 同时存在多个 active Change：${list.join(', ')}`);
    }
  }

  // superseded Run 不得是 active execution target
  if (state.active_run) {
    const supersession = await readRunSupersessionOrNull(speccraftDir, state.active_run);
    if (supersession) {
      violations.push(
        `state.active_run=${state.active_run} 已被 Change ${supersession.change_id} supersede，不能是 active execution target`,
      );
    }
  }

  for (const manifest of manifests) {
    violations.push(...(await checkOneChange(speccraftDir, manifest)));
  }

  return violations;
}

async function checkOneChange(
  speccraftDir: string,
  manifest: ChangeSetManifest,
): Promise<string[]> {
  const violations: string[] = [];
  const id = manifest.id;

  // base Run 存在
  const baseRunManifest = await pathExists(
    path.join(runDir(speccraftDir, manifest.baseRunId), 'manifest.yaml'),
  );
  if (!baseRunManifest) {
    violations.push(`Change ${id} 的 base Run 不存在：${manifest.baseRunId}`);
  }

  // baseline digest 正确
  for (const artifact of manifest.artifacts) {
    const file = path.join(changeDir(speccraftDir, id), artifact.path);
    const digest = await sha256FileOrNull(file);
    if (digest === null) {
      violations.push(`Change ${id} 的 baseline artifact 快照缺失：${artifact.path}`);
    } else if (digest !== artifact.sha256) {
      violations.push(
        `Change ${id} 的 baseline artifact digest 不一致：${artifact.stage}（${digest} ≠ ${artifact.sha256}）`,
      );
    }
  }
  if (manifest.projectDigest) {
    const digest = await sha256FileOrNull(
      path.join(changeDir(speccraftDir, id), 'baseline', PROJECT_FILE),
    );
    if (digest !== manifest.projectDigest) {
      violations.push(
        `Change ${id} 的 baseline project digest 不一致（${digest ?? 'missing'} ≠ ${manifest.projectDigest}）`,
      );
    }
  }

  // Analysis Attempts：bundle digest 正确
  const attempts = await listAttemptIds(speccraftDir, id);
  for (const attemptId of attempts) {
    const attempt = await readAnalysisAttemptOrNull(speccraftDir, id, attemptId);
    if (!attempt) {
      violations.push(`Change ${id} 的 ${attemptId} 缺少 analysis.yaml`);
      continue;
    }
    if (attempt.analysis_bundle_sha256) {
      const current = await analysisBundleDigest(analysisAttemptDir(speccraftDir, id, attemptId));
      if (current !== attempt.analysis_bundle_sha256) {
        violations.push(
          `Change ${id} 的 ${attemptId} Analysis bundle digest 不一致（${current ?? 'null'} ≠ ${attempt.analysis_bundle_sha256}）`,
        );
      }
    }
  }

  // approval digest 与 Attempt 一致（approved attempt 必须存在）
  const approval = await readApprovalOrNull(speccraftDir, id);
  if (approval) {
    const attempt = await readAnalysisAttemptOrNull(speccraftDir, id, approval.analysis_attempt);
    if (!attempt) {
      violations.push(`Change ${id} 的 approval 绑定 attempt 不存在：${approval.analysis_attempt}`);
    } else {
      if (attempt.result !== 'complete') {
        violations.push(`Change ${id} 的 approval 绑定 attempt 不是 complete：${approval.analysis_attempt}`);
      }
      if (approval.change_id !== id) {
        violations.push(`Change ${id} 的 approval change_id=${approval.change_id} 不一致`);
      }
      if (approval.analysis_bundle_sha256 !== (attempt.analysis_bundle_sha256 ?? '')) {
        violations.push(`Change ${id} 的 approval analysis_bundle_sha256 与 Attempt 不一致`);
      }
      if (approval.impact_sha256 !== (attempt.impact_sha256 ?? '')) {
        violations.push(`Change ${id} 的 approval impact_sha256 与 Attempt 不一致`);
      }
      if (approval.candidate_task_graph_digest !== attempt.candidate.task_graph_digest) {
        violations.push(`Change ${id} 的 approval candidate task graph digest 与 Attempt 不一致`);
      }
      if (approval.candidate_executor_plan_digest !== attempt.candidate.executor_plan_digest) {
        violations.push(`Change ${id} 的 approval candidate executor plan digest 与 Attempt 不一致`);
      }
      if (approval.candidate_review_plan_digest !== attempt.candidate.review_plan_digest) {
        violations.push(`Change ${id} 的 approval candidate review plan digest 与 Attempt 不一致`);
      }
    }
  }

  const materialization = await readChangeMaterializationOrNull(speccraftDir, id);

  // rejected Change 不得有 successor
  if (manifest.status === 'rejected') {
    if (materialization) {
      violations.push(`Change ${id} 已 rejected，但仍存在 materialization（successor ${materialization.successor_run}）`);
    }
    const baseLineage = await readRunLineageOrNull(speccraftDir, manifest.baseRunId);
    if (baseLineage && baseLineage.change_id === id) {
      violations.push(`Change ${id} 已 rejected，但 base Run 仍被标记为 successor`);
    }
  }

  // materialized / closed：必须有 Successor，且 lineage 反向一致
  if (manifest.status === 'materialized' || manifest.status === 'closed') {
    if (!materialization) {
      violations.push(`Change ${id} 状态为 ${manifest.status}，但缺少 materialization.yaml`);
    } else {
      const successor = materialization.successor_run;
      const successorExists = await pathExists(
        path.join(runDir(speccraftDir, successor), 'manifest.yaml'),
      );
      if (!successorExists) {
        violations.push(`Change ${id} 的 Successor Run 不存在：${successor}`);
      }
      const consistency = await checkLineageConsistency(speccraftDir, id, successor);
      if (!consistency.consistent) {
        violations.push(`Change ${id} 的 Successor lineage 不一致：${consistency.reason ?? '未知原因'}`);
      }

      // predecessor superseded evidence 与 materialization 一致
      const supersession = await readRunSupersessionOrNull(speccraftDir, manifest.baseRunId);
      if (!supersession) {
        violations.push(`Change ${id} 的 predecessor Run ${manifest.baseRunId} 缺少 superseded.yaml`);
      } else if (
        supersession.change_id !== id ||
        supersession.successor_run !== successor
      ) {
        violations.push(
          `Change ${id} 的 superseded evidence 与 materialization 不一致（change_id=${supersession.change_id}，successor_run=${supersession.successor_run}）`,
        );
      }

      // Candidate / Replan frozen plan digest 一致
      violations.push(...(await checkFrozenPlanMatch(speccraftDir, manifest, successor, approval)));

      // closed Change 必须 successor accepted
      if (manifest.status === 'closed') {
        const successorManifest = await readRunStatusOrNull(speccraftDir, successor);
        if (successorManifest !== 'accepted' && successorManifest !== 'handed_off') {
          violations.push(
            `Change ${id} 已 closed，但 Successor Run ${successor} 不是 accepted（${successorManifest ?? 'missing'}）`,
          );
        }
      }
    }
  }

  // close target hash 正确
  const close = await readChangeCloseOrNull(speccraftDir, id);
  if (close) {
    if (close.change_id !== id) {
      violations.push(`Change ${id} 的 close.yaml change_id=${close.change_id} 不一致`);
    }
    for (const rel of close.promoted_files) {
      const expected = close.after_hashes[rel];
      if (!expected) {
        violations.push(`Change ${id} 的 close.yaml 缺少 ${rel} 的 after hash`);
        continue;
      }
      const current = await sha256FileOrNull(path.join(speccraftDir, rel));
      if (current !== expected) {
        violations.push(
          `Change ${id} 的 close target hash 不一致：${rel}（${current ?? 'missing'} ≠ ${expected}）`,
        );
      }
    }
  }

  return violations;
}

/** §36/§58：Successor 的 frozen plan digest 必须等于 approved Candidate digest */
async function checkFrozenPlanMatch(
  speccraftDir: string,
  manifest: ChangeSetManifest,
  successorRun: string,
  approval: Awaited<ReturnType<typeof readApprovalOrNull>>,
): Promise<string[]> {
  if (!approval) return [];
  const violations: string[] = [];
  const id = manifest.id;

  const graph = await readTaskGraphOrNull(speccraftDir, successorRun);
  const graphDigest = graph ? taskGraphDigest(graph) : null;
  if (graphDigest !== approval.candidate_task_graph_digest) {
    violations.push(
      `Change ${id} 的 Successor task graph digest 与 approved Candidate 不一致（${graphDigest ?? 'null'} ≠ ${approval.candidate_task_graph_digest ?? 'null'}）`,
    );
  }

  const executorPlan = await readExecutorPlanOrNull(speccraftDir, successorRun);
  const executorDigest = executorPlan ? executorPlanDigest(executorPlan) : null;
  if (executorDigest !== approval.candidate_executor_plan_digest) {
    violations.push(
      `Change ${id} 的 Successor executor plan digest 与 approved Candidate 不一致（${executorDigest ?? 'null'} ≠ ${approval.candidate_executor_plan_digest ?? 'null'}）`,
    );
  }

  const reviewPlan = await readReviewPlanOrNull(speccraftDir, successorRun);
  const reviewDigest = reviewPlan ? reviewPlanDigest(reviewPlan) : null;
  if (reviewDigest !== approval.candidate_review_plan_digest) {
    violations.push(
      `Change ${id} 的 Successor review plan digest 与 approved Candidate 不一致（${reviewDigest ?? 'null'} ≠ ${approval.candidate_review_plan_digest ?? 'null'}）`,
    );
  }

  return violations;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function listAttemptIds(speccraftDir: string, changeId: string): Promise<string[]> {
  const dir = path.join(changeDir(speccraftDir, changeId), 'analysis');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && /^attempt-\d+$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function readRunStatusOrNull(
  speccraftDir: string,
  runId: string,
): Promise<string | null> {
  try {
    return (await readRun(speccraftDir, runId)).status;
  } catch {
    return null;
  }
}

async function sha256FileOrNull(file: string): Promise<string | null> {
  try {
    return sha256Bytes(await readFile(file));
  } catch {
    return null;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

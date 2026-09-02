/**
 * Sequential Review Gates（ADR 0009 §65-§73）。
 *
 * 在 sequential orchestrator 中：
 *   1. Task Verification PASS 后
 *   2. capture postTree
 *   3. compute exact delta
 *   4. run all gates sequentially（declaration order）
 *   5. if any gate CHANGES_REQUIRED / ERROR → task failed
 *   6. if all gates PASS → task completed
 *
 * Gate 顺序严格执行（§69）：spec → quality。
 * 第一个 FAIL 即停止（避免无意义 Token 消耗）。
 * rework 时所有 Gate 从第一项重新运行。
 */

import { writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { TaskDefinition } from '../tasks/types.js';
import type { FrozenReviewGate, ReviewDecision } from './types.js';
import { reviewEvidenceDir, reviewWorktreePath } from './paths.js';
import { createReviewWorktree, removeReviewWorktree, checkReviewerMutation } from './snapshot.js';
import { prepareReviewPackage, buildReviewerPrompt } from './package.js';
import { runReviewGate } from './runner.js';

export interface ExecuteSequentialReviewGatesOptions {
  projectRoot: string;
  speccraftDir: string;
  runId: string;
  task: TaskDefinition;
  gates: FrozenReviewGate[];
  sourceDispatchAttempt: number;
  sourceVerificationAttempt: number;
  preTree: string;
  postTree: string;
  preCommit: string;
  postCommit: string;
  diffPatch: string;
}

export interface SequentialReviewResult {
  decision: ReviewDecision;
  error?: string;
  gateResults: Array<{
    gateId: string;
    decision: ReviewDecision;
    attemptNumber: number;
  }>;
}

/**
 * Execute Sequential Review Gates（§65-§73）。
 *
 * Gates 按 declaration order 严格顺序执行。
 * 任何 gate CHANGES_REQUIRED / ERROR 立即停止。
 */
export async function executeSequentialReviewGates(
  options: ExecuteSequentialReviewGatesOptions,
): Promise<SequentialReviewResult> {
  const {
    projectRoot,
    speccraftDir,
    runId,
    task,
    gates,
    sourceDispatchAttempt,
    sourceVerificationAttempt,
    preTree,
    postTree,
    preCommit,
    postCommit,
    diffPatch,
  } = options;

  const gateResults: SequentialReviewResult['gateResults'] = [];

  for (const gate of gates) {
    const evidenceDir = reviewEvidenceDir(speccraftDir, runId, task.id, gate.id);
    await mkdir(evidenceDir, { recursive: true });

    // compute attempt number（atomic：readdir max + 1）
    const attemptNumber = await nextAttemptNumber(evidenceDir);
    const wtPath = reviewWorktreePath(projectRoot, runId, task.id, gate.id, attemptNumber);

    // create detached review worktree（§42）
    const wtResult = await createReviewWorktree(projectRoot, wtPath, postCommit);
    if (!wtResult.ok) {
      const error = `create review worktree failed: ${wtResult.error}`;
      gateResults.push({ gateId: gate.id, decision: 'error', attemptNumber });
      return { decision: 'error', error, gateResults };
    }

    try {
      // prepare review package（§49）
      const pkgResult = await prepareReviewPackage({
        task,
        gate,
        sourceDispatchAttempt,
        sourceVerificationAttempt,
        preTree,
        postTree,
        preCommit,
        postCommit,
        diffPatch,
        reviewWorktreePath: wtPath,
        runDir: path.join(speccraftDir, 'runs', runId),
        projectRoot,
      });

      if (!pkgResult.ok || !pkgResult.package) {
        gateResults.push({ gateId: gate.id, decision: 'error', attemptNumber });
        return { decision: 'error', error: pkgResult.error, gateResults };
      }

      // build reviewer prompt（§50-§51）
      const prompt = buildReviewerPrompt(pkgResult.package, gate);

      // save evidence artifacts
      const attemptDir = path.join(evidenceDir, `attempt-${String(attemptNumber).padStart(3, '0')}`);
      await mkdir(attemptDir, { recursive: true });
      await writeFile(path.join(attemptDir, 'task-contract.md'), `# Task Contract

**Task ID**: ${task.id}
**Title**: ${task.title}
**Summary**: ${task.summary || '(no summary)'}
**Scope**: ${(task.scope?.paths ?? []).join(', ') || '(no explicit scope)'}
**Dependencies**: ${(task.dependsOn ?? []).join(', ') || '(none)'}
`, 'utf-8');
      await writeFile(path.join(attemptDir, 'diff.patch'), diffPatch, 'utf-8');
      await writeFile(path.join(attemptDir, 'reviewer-prompt.md'), prompt, 'utf-8');

      // run review gate（§62：fresh session，独立 Evidence Namespace）
      const runResult = await runReviewGate({
        projectRoot,
        runDir: speccraftDir,
        task,
        gate,
        attemptNumber,
        prompt,
        reviewWorktreePath: wtPath,
      });

      // check reviewer mutation（§44）
      const mutationCheck = await checkReviewerMutation(wtPath);
      if (!mutationCheck.clean) {
        const error = `reviewer mutation detected: ${mutationCheck.output}`;
        gateResults.push({ gateId: gate.id, decision: 'error', attemptNumber });
        return { decision: 'error', error, gateResults };
      }

      gateResults.push({ gateId: gate.id, decision: runResult.decision, attemptNumber });

      // §69：任何 gate CHANGES_REQUIRED / ERROR → 立即停止
      if (runResult.decision !== 'pass') {
        return { decision: runResult.decision, error: runResult.error, gateResults };
      }
    } finally {
      // §45：cleanup review worktree（成功或失败都清理）
      const removeResult = await removeReviewWorktree(projectRoot, wtPath);
      if (!removeResult.ok) {
        console.warn(`[review] cleanup worktree warning: ${removeResult.error}`);
      }
    }
  }

  // all gates passed
  return { decision: 'pass', gateResults };
}

/**
 * Atomic attempt number reservation（§59）。
 * readdir + max + 1，不用 readdir.length（避免缺号问题）。
 */
async function nextAttemptNumber(evidenceDir: string): Promise<number> {
  let entries: string[] = [];
  try {
    entries = await readdir(evidenceDir);
  } catch {
    entries = [];
  }
  let max = 0;
  for (const name of entries) {
    const m = name.match(/^attempt-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

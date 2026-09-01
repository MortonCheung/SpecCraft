/**
 * Review Lifecycle（ADR 0009 M8.4）。
 *
 * 编排：
 *   1. Capture preTree（before dispatch）
 *   2. Execute Task（dispatch + verify）
 *   3. Capture postTree（after verify PASS）
 *   4. Compute exact delta
 *   5. Run all review gates（sequential per gate）
 *   6. Derive final review decision
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Task } from '../tasks/types.js';
import type { FrozenReviewGate } from './types.js';
import { captureTreeSnapshot, computeExactDelta, createReviewWorktree, removeReviewWorktree, checkReviewerMutation } from './snapshot.js';
import { prepareReviewPackage, buildReviewerPrompt } from './package.js';
import { runReviewGate } from './runner.js';
import { reviewWorktreePath, reviewEvidenceDir } from './paths.js';

export interface ReviewLifecycleContext {
  projectRoot: string;
  runId: string;
  runDir: string;
  task: Task;
  gates: FrozenReviewGate[];
  sourceDispatchAttempt: number;
  sourceVerificationAttempt: number;
}

export interface ReviewLifecycleResult {
  ok: boolean;
  decision: 'pass' | 'changes_required' | 'error';
  error?: string;
  preTree?: string;
  postTree?: string;
  preCommit?: string;
  postCommit?: string;
  gateResults?: Array<{
    gateId: string;
    decision: 'pass' | 'changes_required' | 'error';
    attemptNumber: number;
  }>;
}

/**
 * Execute Review Lifecycle（§48-§64）。
 */
export async function executeReviewLifecycle(
  ctx: ReviewLifecycleContext,
): Promise<ReviewLifecycleResult> {
  const { projectRoot, runId, runDir, task, gates, sourceDispatchAttempt, sourceVerificationAttempt } = ctx;

  // 1. Capture preTree（§36）
  const preResult = await captureTreeSnapshot(projectRoot, `pre-${task.id}`, `Review pre-snapshot: ${task.id}`);
  if (!preResult.ok) {
    return { ok: false, decision: 'error', error: `preTree capture failed: ${preResult.error}` };
  }

  // Note: In real orchestrator integration, dispatch + verify happens here
  // For now we assume it already happened and we're called after verify PASS

  // 2. Capture postTree（§37）
  const postResult = await captureTreeSnapshot(projectRoot, `post-${task.id}`, `Review post-snapshot: ${task.id}`);
  if (!postResult.ok) {
    return { ok: false, decision: 'error', error: `postTree capture failed: ${postResult.error}` };
  }

  // 3. Check for no changes（§40）
  if (preResult.treeId === postResult.treeId) {
    return {
      ok: false,
      decision: 'error',
      error: 'no task changes to review (preTree == postTree)',
      preTree: preResult.treeId,
      postTree: postResult.treeId,
      preCommit: preResult.commitId,
      postCommit: postResult.commitId,
    };
  }

  // 4. Compute exact delta（§39）
  const deltaResult = await computeExactDelta(projectRoot, preResult.commitId, postResult.commitId);
  if (!deltaResult.ok) {
    return {
      ok: false,
      decision: 'error',
      error: `delta computation failed: ${deltaResult.error}`,
      preTree: preResult.treeId,
      postTree: postResult.treeId,
      preCommit: preResult.commitId,
      postCommit: postResult.commitId,
    };
  }

  // 5. Run all gates sequentially（§65-§67）
  const gateResults: Array<{
    gateId: string;
    decision: 'pass' | 'changes_required' | 'error';
    attemptNumber: number;
  }> = [];

  for (const gate of gates) {
    const gateResult = await runSingleReviewGate({
      projectRoot,
      runId,
      runDir,
      task,
      gate,
      sourceDispatchAttempt,
      sourceVerificationAttempt,
      preTree: preResult.treeId,
      postTree: postResult.treeId,
      preCommit: preResult.commitId,
      postCommit: postResult.commitId,
      diffPatch: deltaResult.patch,
    });

    gateResults.push({
      gateId: gate.id,
      decision: gateResult.decision,
      attemptNumber: gateResult.attemptNumber,
    });

    // If any gate fails/errors, stop sequential execution
    if (gateResult.decision !== 'pass') {
      return {
        ok: false,
        decision: gateResult.decision,
        error: gateResult.error,
        preTree: preResult.treeId,
        postTree: postResult.treeId,
        preCommit: preResult.commitId,
        postCommit: postResult.commitId,
        gateResults,
      };
    }
  }

  // 6. All gates passed
  return {
    ok: true,
    decision: 'pass',
    preTree: preResult.treeId,
    postTree: postResult.treeId,
    preCommit: preResult.commitId,
    postCommit: postResult.commitId,
    gateResults,
  };
}

interface RunSingleReviewGateOptions {
  projectRoot: string;
  runId: string;
  runDir: string;
  task: Task;
  gate: FrozenReviewGate;
  sourceDispatchAttempt: number;
  sourceVerificationAttempt: number;
  preTree: string;
  postTree: string;
  preCommit: string;
  postCommit: string;
  diffPatch: string;
}

interface RunSingleReviewGateResult {
  decision: 'pass' | 'changes_required' | 'error';
  attemptNumber: number;
  error?: string;
}

/**
 * Run single review gate（§57-§64）。
 */
async function runSingleReviewGate(
  options: RunSingleReviewGateOptions,
): Promise<RunSingleReviewGateResult> {
  const {
    projectRoot,
    runId,
    runDir,
    task,
    gate,
    sourceDispatchAttempt,
    sourceVerificationAttempt,
    preTree,
    postTree,
    preCommit,
    postCommit,
    diffPatch,
  } = options;

  // 1. Determine attempt number
  const evidenceDir = reviewEvidenceDir(runDir, task.id, gate.id);
  await mkdir(evidenceDir, { recursive: true });

  // 2. Compute review worktree path
  const attemptNumber = 1; // TODO: atomic reservation
  const worktreePath = reviewWorktreePath(projectRoot, runId, task.id, gate.id, attemptNumber);

  // 3. Create review worktree（§42）
  const worktreeResult = await createReviewWorktree(projectRoot, worktreePath, postCommit);
  if (!worktreeResult.ok) {
    return {
      decision: 'error',
      attemptNumber,
      error: `create review worktree failed: ${worktreeResult.error}`,
    };
  }

  try {
    // 4. Prepare review package
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
      reviewWorktreePath: worktreePath,
      runDir,
      projectRoot,
    });

    if (!pkgResult.ok || !pkgResult.package) {
      return {
        decision: 'error',
        attemptNumber,
        error: `prepare review package failed: ${pkgResult.error}`,
      };
    }

    // 5. Build reviewer prompt
    const prompt = buildReviewerPrompt(pkgResult.package, gate);

    // 6. Save evidence artifacts
    const attemptDir = path.join(evidenceDir, `attempt-${String(attemptNumber).padStart(3, '0')}`);
    await mkdir(attemptDir, { recursive: true });
    
    await writeFile(path.join(attemptDir, 'task-contract.md'), `# Task Contract

**Task ID**: ${task.id}
**Title**: ${task.title}
**Summary**: ${task.summary || '(no summary)'}
**Scope**: ${(task.scope || []).join(', ') || '(no explicit scope)'}
**Dependencies**: ${(task.dependencies || []).join(', ') || '(none)'}
`, 'utf-8');

    await writeFile(path.join(attemptDir, 'diff.patch'), diffPatch, 'utf-8');
    await writeFile(path.join(attemptDir, 'reviewer-prompt.md'), prompt, 'utf-8');

    // 7. Run review gate（calls adapter）
    const runResult = await runReviewGate({
      projectRoot,
      runDir,
      task,
      gate,
      attemptNumber,
      prompt,
      reviewWorktreePath: worktreePath,
    });

    // 8. Check reviewer mutation（§44）
    const mutationCheck = await checkReviewerMutation(worktreePath);
    if (!mutationCheck.clean) {
      return {
        decision: 'error',
        attemptNumber,
        error: `reviewer mutation detected: ${mutationCheck.output}`,
      };
    }

    return {
      decision: runResult.decision,
      attemptNumber,
      error: runResult.error,
    };
  } finally {
    // 9. Cleanup review worktree（§45）
    const removeResult = await removeReviewWorktree(projectRoot, worktreePath);
    if (!removeResult.ok) {
      // warning only, don't fail the gate
      console.warn(`[review] cleanup worktree warning: ${removeResult.error}`);
    }
  }
}

/**
 * Exact Task Change Snapshot（ADR 0009 §33-§47）。
 *
 * Review 不拿整个 Agent 会话历史，而拿：
 *   - Task Contract（Task ID / title / summary / scope / dependencies）
 *   - Execution Guard 相关规则
 *   - exact Task delta（preTree → postTree diff）
 *   - Verification Evidence
 *
 * preTree / postTree 通过 alternate Git index + synthetic commit + detached worktree 实现，
 * 禁止修改用户 working tree / real index / HEAD。
 *
 * 核心流程（§35-§42）：
 *   1. capture preTree（dispatch 前）：`GIT_INDEX_FILE=.git/review-pre.index git add -A && git write-tree`
 *   2. dispatch + verify
 *   3. capture postTree（verify PASS 后）：`GIT_INDEX_FILE=.git/review-post.index git add -A && git write-tree`
 *   4. compute exact delta：`git diff-tree preTree postTree`
 *   5. create Review Worktree（每个 review attempt 独立 detached worktree）
 *   6. feed Reviewer with task-contract.md + diff.patch + verification.md
 */

import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from '../workspaces/git.js';
import type { GitCommandResult } from '../workspaces/git.js';

/** Capture preTree / postTree（§36-§38） */
export interface CaptureTreeResult {
  ok: boolean;
  treeId: string;
  commitId: string;
  error?: string;
}

/**
 * Capture Tree Snapshot（§36）。
 *
 * 使用 alternate index 避免污染 real index。
 * 返回 synthetic commit SHA（detached，不影响任何 ref）。
 */
export async function captureTreeSnapshot(
  workspaceRoot: string,
  indexName: string,
  message: string,
): Promise<CaptureTreeResult> {
  const gitDir = path.join(workspaceRoot, '.git');
  const altIndex = path.join(gitDir, `review-${indexName}.index`);

  // 1. alternate index: git add -A
  const add = await runGitWithEnv(workspaceRoot, ['add', '-A'], { GIT_INDEX_FILE: altIndex });
  if (!add.ok) {
    return { ok: false, treeId: '', commitId: '', error: `capture ${indexName}: git add failed: ${add.stderr}` };
  }

  // 2. write-tree
  const writeTree = await runGitWithEnv(workspaceRoot, ['write-tree'], { GIT_INDEX_FILE: altIndex });
  if (!writeTree.ok) {
    return { ok: false, treeId: '', commitId: '', error: `capture ${indexName}: write-tree failed: ${writeTree.stderr}` };
  }
  const treeId = writeTree.stdout.trim();

  // 3. commit-tree（detached，不移动任何 ref）
  const commitTree = await runGitWithEnv(
    workspaceRoot,
    ['commit-tree', treeId, '-m', message],
    {},
  );
  if (!commitTree.ok) {
    return { ok: false, treeId, commitId: '', error: `capture ${indexName}: commit-tree failed: ${commitTree.stderr}` };
  }
  const commitId = commitTree.stdout.trim();

  // 4. cleanup alternate index
  try {
    await rm(altIndex, { force: true });
  } catch {
    // best-effort cleanup
  }

  return { ok: true, treeId, commitId };
}

/**
 * Compute exact delta（§39）：`git diff-tree -p preCommit postCommit`
 */
export async function computeExactDelta(
  workspaceRoot: string,
  preCommit: string,
  postCommit: string,
): Promise<{ ok: boolean; patch: string; error?: string }> {
  const result = await runGit(workspaceRoot, ['diff-tree', '-p', preCommit, postCommit]);
  if (!result.ok) {
    return { ok: false, patch: '', error: `diff-tree failed: ${result.stderr}` };
  }
  return { ok: true, patch: result.stdout };
}

/**
 * Create Review Worktree（§40-§42）。
 *
 * 每个 review attempt 独立 detached worktree：
 *   git worktree add --detach <worktree-path> <postCommit>
 *
 * Reviewer 即使修改文件也只污染 Review Workspace，不会污染 Executor Workspace / canonical workspace。
 */
export async function createReviewWorktree(
  projectRoot: string,
  worktreePath: string,
  postCommit: string,
): Promise<{ ok: boolean; error?: string }> {
  await mkdir(path.dirname(worktreePath), { recursive: true });
  const result = await runGit(projectRoot, ['worktree', 'add', '--detach', worktreePath, postCommit]);
  if (!result.ok) {
    return { ok: false, error: `worktree add failed: ${result.stderr}` };
  }
  return { ok: true };
}

/**
 * Remove Review Worktree（§42 cleanup）。
 */
export async function removeReviewWorktree(
  projectRoot: string,
  worktreePath: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await runGit(projectRoot, ['worktree', 'remove', '--force', worktreePath]);
  if (!result.ok) {
    return { ok: false, error: `worktree remove failed: ${result.stderr}` };
  }
  return { ok: true };
}

/**
 * Check Reviewer Mutation（§44）：review 完成后强制检查 `git status --porcelain` 为空。
 * 不为空 → `reviewer_mutation` ERROR。
 */
export async function checkReviewerMutation(worktreePath: string): Promise<{ clean: boolean; output: string }> {
  const result = await runGit(worktreePath, ['status', '--porcelain']);
  const output = result.stdout.trim();
  return { clean: output === '', output };
}

/**
 * runGit with custom env（for GIT_INDEX_FILE）
 */
async function runGitWithEnv(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string>,
): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => {
      resolve({ ok: false, exitCode: null, stdout, stderr: err.message });
    });
    proc.on('close', (code) => {
      resolve({ ok: code === 0, exitCode: code, stdout, stderr });
    });
  });
}

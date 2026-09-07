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
 * 禁止修改用户 working tree / real index / HEAD / branch。
 *
 * v0.8 收口后的算法（worktree-safe）：
 *   1. runtime-owned alternate index 放 OS 临时目录（不依赖 `<root>/.git` 是目录；
 *      linked worktree 的 `.git` 是 gitfile，普通 repo 是目录，二者都必须可用）
 *   2. 先 `read-tree HEAD`（或无 HEAD 时 `read-tree --empty`），保证
 *      HEAD tracked state + working tree current state 的完整映射
 *   3. 强制排除 `.speccraft/**`（pathspec exclude + cached 清理），不依赖用户 .gitignore
 *   4. `write-tree` → treeId
 *   5. `commit-tree <tree> -m <msg> [-p <parent>]`，parent chain：
 *        sourceHEAD → preCommit → postCommit
 *      Review Worktree 因此满足 HEAD == postCommit、HEAD^ == preCommit
 *   6. runtime 注入固定 SpecCraft Runtime identity（GIT_AUTHOR 与 GIT_COMMITTER 系列环境变量），
 *      不依赖用户 user.name / user.email
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGit } from '../workspaces/git.js';
import type { GitCommandResult } from '../workspaces/git.js';

/** SpecCraft Runtime 固定 Git identity（synthetic commit 专用，与用户 identity 无关） */
const RUNTIME_GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'SpecCraft Runtime',
  GIT_AUTHOR_EMAIL: 'speccraft@local',
  GIT_COMMITTER_NAME: 'SpecCraft Runtime',
  GIT_COMMITTER_EMAIL: 'speccraft@local',
};

/**
 * Snapshot 必须排除的 runtime 路径（绝对不允许进入 tree / diff / changed paths）。
 * 使用 pathspec exclude，不依赖用户 .gitignore。
 */
const SPECCRAFT_EXCLUDE_PATHSPEC = ':(exclude).speccraft/**';

/** Capture preTree / postTree（§36-§38） */
export interface CaptureTreeResult {
  ok: boolean;
  treeId: string;
  commitId: string;
  error?: string;
}

/**
 * 解析工作区当前 HEAD（仅用于自动推导 synthetic commit parent）。
 * 非 Git 仓库或 unborn HEAD → 返回 null（不致命）。
 */
export async function resolveHeadOrNull(workspaceRoot: string): Promise<string | null> {
  const result = await runGit(workspaceRoot, ['rev-parse', 'HEAD']);
  if (!result.ok) return null;
  const sha = result.stdout.trim();
  return sha.length === 40 ? sha : null;
}

/**
 * Capture Tree Snapshot（§36）。
 *
 * 使用 runtime-owned alternate index（OS 临时目录），避免污染 real index，
 * 兼容 canonical repo / linked worktree / detached worktree。
 *
 * 语义：
 *   - 快照 tree = HEAD tracked state + working tree current state − .speccraft/**
 *   - synthetic commit = `commit-tree <tree> -m <message> [-p <parentCommit>]`
 *   - parentCommit 缺省时自动取 workspaceRoot 当前 HEAD（pre-snapshot 场景）
 *   - 返回的 commit detached，不移动任何 ref / branch / HEAD
 */
export async function captureTreeSnapshot(
  workspaceRoot: string,
  indexName: string,
  message: string,
  parentCommit?: string,
): Promise<CaptureTreeResult> {
  const parent = parentCommit ?? (await resolveHeadOrNull(workspaceRoot));
  const safeName = indexName.replace(/[^A-Za-z0-9_-]/g, '-');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `speccraft-${safeName}-`));
  const altIndex = path.join(tempDir, 'index');

  try {
    // 1. alternate index 必须以 HEAD 为基底（不能是空 index 直接 add -A）
    const readTree = await runGitWithEnv(
      workspaceRoot,
      parent ? ['read-tree', parent] : ['read-tree', '--empty'],
      { GIT_INDEX_FILE: altIndex },
    );
    if (!readTree.ok) {
      return { ok: false, treeId: '', commitId: '', error: `capture ${indexName}: read-tree failed: ${readTree.stderr}` };
    }

    // 2. 强制从 snapshot index 移除曾被 track 的 .speccraft 条目
    //    （runtime 文件绝不进入 snapshot；未 track 时 --ignore-unmatch 无副作用）
    await runGitWithEnv(
      workspaceRoot,
      ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', '.speccraft'],
      { GIT_INDEX_FILE: altIndex },
    );

    // 3. 录入 working tree 当前状态（untracked + 修改 + 删除），强制排除 .speccraft/**
    const add = await runGitWithEnv(
      workspaceRoot,
      ['add', '-A', '--', '.', SPECCRAFT_EXCLUDE_PATHSPEC],
      { GIT_INDEX_FILE: altIndex },
    );
    if (!add.ok) {
      return { ok: false, treeId: '', commitId: '', error: `capture ${indexName}: git add failed: ${add.stderr}` };
    }

    // 4. write-tree
    const writeTree = await runGitWithEnv(workspaceRoot, ['write-tree'], { GIT_INDEX_FILE: altIndex });
    if (!writeTree.ok) {
      return { ok: false, treeId: '', commitId: '', error: `capture ${indexName}: write-tree failed: ${writeTree.stderr}` };
    }
    const treeId = writeTree.stdout.trim();

    // 5. commit-tree（detached，不移动任何 ref）；注入 Runtime identity，不依赖用户配置
    const commitArgs = ['commit-tree', treeId, '-m', message];
    if (parent) {
      commitArgs.push('-p', parent);
    }
    const commitTree = await runGitWithEnv(workspaceRoot, commitArgs, RUNTIME_GIT_IDENTITY);
    if (!commitTree.ok) {
      return { ok: false, treeId, commitId: '', error: `capture ${indexName}: commit-tree failed: ${commitTree.stderr}` };
    }
    const commitId = commitTree.stdout.trim();

    return { ok: true, treeId, commitId };
  } finally {
    // cleanup runtime temp index
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Compute exact delta（§39）：`git diff-tree -p preCommit postCommit`
 *
 * §5：同时返回 changedPaths（`git diff-tree --name-only -r`），供 Runtime
 * 在 Review Gates 之前做 deterministic scope audit（Scope Guard 不是 LLM judgment）。
 */
export async function computeExactDelta(
  workspaceRoot: string,
  preCommit: string,
  postCommit: string,
): Promise<{ ok: boolean; patch: string; changedPaths: string[]; error?: string }> {
  const result = await runGit(workspaceRoot, ['diff-tree', '-p', preCommit, postCommit]);
  if (!result.ok) {
    return { ok: false, patch: '', changedPaths: [], error: `diff-tree failed: ${result.stderr}` };
  }
  const names = await runGit(workspaceRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', preCommit, postCommit]);
  const changedPaths = names.ok
    ? names.stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
    : [];
  return { ok: true, patch: result.stdout, changedPaths };
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
 * Check Reviewer Mutation（§44 + v0.8 §7）：
 * 必须同时满足：
 *   1. working tree clean（`git status --porcelain` 为空）
 *   2. HEAD == expectedHead（防止 reviewer commit 后 status 变干净 → HEAD drift）
 * 任一不满足 → reviewer_mutation ERROR。
 */
export async function checkReviewerMutation(
  worktreePath: string,
  expectedHead?: string,
): Promise<{ clean: boolean; output: string; headDrift?: boolean }> {
  const status = await runGit(worktreePath, ['status', '--porcelain']);
  const dirtyOutput = status.stdout.trim();
  if (dirtyOutput !== '') {
    return { clean: false, output: dirtyOutput };
  }
  if (expectedHead) {
    const head = await runGit(worktreePath, ['rev-parse', 'HEAD']);
    if (!head.ok || head.stdout.trim() !== expectedHead) {
      return {
        clean: false,
        output: `HEAD drift: expected ${expectedHead}, actual ${head.ok ? head.stdout.trim() : '(unresolvable)'}`,
        headDrift: true,
      };
    }
  }
  return { clean: true, output: '' };
}

/**
 * 列出 pre/post snapshot 相对 sourceHEAD 的 changed paths（供 Scope Audit / .speccraft 断言）。
 * `git diff-tree --no-commit-id --name-only -r <fromCommit> <toCommit>`
 */
export async function computeChangedPaths(
  workspaceRoot: string,
  fromCommit: string,
  toCommit: string,
): Promise<{ ok: boolean; paths: string[]; error?: string }> {
  const result = await runGit(workspaceRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', fromCommit, toCommit]);
  if (!result.ok) {
    return { ok: false, paths: [], error: `diff-tree --name-only failed: ${result.stderr}` };
  }
  const paths = result.stdout.split('\n').map((p) => p.trim()).filter((p) => p.length > 0);
  return { ok: true, paths };
}

/**
 * runGit with custom env（for GIT_INDEX_FILE / runtime identity）
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

/**
 * Workspace Git 写操作（ADR 0007 §9）。
 *
 * 与 src/core/execution/git.ts 的只读快照严格分离：
 * 本模块是 v0.6 中唯一允许执行 Git 写操作的模块，负责
 *   - parallel preflight
 *   - 创建 / 移除 Worktree
 *   - branch 名合法性校验
 *   - Executor Git Mutation Guard 所需的 worktree git 状态读取
 *
 * 所有操作必须 spawn 原生 git（child_process.spawn），
 * 不引入 simple-git / isomorphic-git / nodegit。
 */

import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** 单条 git 命令的结果（含 stderr / exitCode，供错误报告） */
export interface GitCommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** spawn 原生 git；cwd = projectRoot；失败不抛错，返回结构化结果 */
export function runGit(projectRoot: string, args: string[]): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      resolve({ ok: false, exitCode: null, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, exitCode: code, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Parallel Preflight（§9.1、§9.2）
// ---------------------------------------------------------------------------

/** parallel preflight 通过后返回的 canonical 状态（供 wave base commit 使用） */
export interface ParallelGitReadiness {
  branch: string;
  headCommit: string;
}

/**
 * 验证 canonical workspace 是否可安全进入 parallel 执行。
 * 任一条件不满足即抛错（明确失败，绝不自作 stash/checkout/reset/clean）。
 */
export async function assertParallelGitReady(projectRoot: string): Promise<ParallelGitReadiness> {
  // 1. projectRoot 是 Git repo 且 HEAD 可解析
  const head = await runGit(projectRoot, ['rev-parse', 'HEAD']);
  if (!head.ok) {
    throw new Error('parallel preflight 失败：projectRoot 不是可解析 HEAD 的 Git 仓库');
  }

  // 2. 当前 branch 可解析（detached HEAD 时 symbolic-ref 失败）
  const branch = await runGit(projectRoot, ['symbolic-ref', '--short', 'HEAD']);
  if (!branch.ok || !branch.stdout.trim()) {
    throw new Error('parallel preflight 失败：当前处于 detached HEAD，无法确定 canonical branch');
  }

  // 3. 无 merge / cherry-pick / revert / rebase in progress
  const inProgress = await detectInProgressState(projectRoot);
  if (inProgress) {
    throw new Error(`parallel preflight 失败：存在进行中的 ${inProgress}，请先完成或中止`);
  }

  // 4. .speccraft 不得被 git tracked（runtime state 不得进入正式代码）
  const lsFiles = await runGit(projectRoot, ['ls-files', '.speccraft']);
  if (lsFiles.ok && lsFiles.stdout.trim().length > 0) {
    throw new Error('parallel preflight 失败：.speccraft 已被 git 跟踪，存在 runtime state，请先 git rm --cached');
  }

  // 5. canonical workspace 无用户代码修改（排除 .speccraft 自身）
  const status = await runGit(projectRoot, ['status', '--porcelain', '--untracked-files=all']);
  if (status.ok) {
    const dirty = status.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((l) => !isSpeccraftStatusLine(l));
    if (dirty.length > 0) {
      throw new Error(
        `parallel preflight 失败：canonical workspace 存在未提交的用户代码修改（${dirty
          .slice(0, 5)
          .join(', ')}${dirty.length > 5 ? '…' : ''}）`,
      );
    }
  }

  return { branch: branch.stdout.trim(), headCommit: head.stdout.trim() };
}

/** 检测进行中的 git 操作，返回类型名；无则返回 null */
async function detectInProgressState(projectRoot: string): Promise<string | null> {
  const markers: Array<[string, string]> = [
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
  ];
  for (const [marker, label] of markers) {
    if (await gitPathExists(projectRoot, marker)) return label;
  }
  return null;
}

/** 判断 git 元数据路径（MERGE_HEAD / rebase-merge 等）是否存在 */
async function gitPathExists(projectRoot: string, name: string): Promise<boolean> {
  const r = await runGit(projectRoot, ['rev-parse', '--git-path', name]);
  if (!r.ok) return false;
  const p = r.stdout.trim();
  if (!p) return false;
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** 判断一条 `git status --porcelain` 行是否属于 .speccraft runtime state */
function isSpeccraftStatusLine(line: string): boolean {
  // --porcelain 格式：XY 后跟空格再接 path（rename 为 "XY old -> new"）
  const pathPortion = line.length > 3 ? line.slice(3).trim() : line.trim();
  return pathPortion === '.speccraft' || pathPortion.startsWith('.speccraft/');
}

// ---------------------------------------------------------------------------
// Branch 校验（§9.3）
// ---------------------------------------------------------------------------

/** 用 `git check-ref-format --branch` 校验 branch 名合法性；非法则抛错 */
export async function assertValidBranchRef(projectRoot: string, branch: string): Promise<void> {
  const r = await runGit(projectRoot, ['check-ref-format', '--branch', branch]);
  if (!r.ok) {
    throw new Error(`非法 git branch 名：${branch}（${r.stderr.trim() || 'check-ref-format 拒绝'}）`);
  }
}

// ---------------------------------------------------------------------------
// Worktree 创建 / 移除（§9.3、§12.8）
// ---------------------------------------------------------------------------

export interface CreateWorktreeOptions {
  branch: string;
  workspacePath: string;
  baseCommit: string;
}

/**
 * 创建隔离 Worktree：`git worktree add -b <branch> <workspacePath> <baseCommit>`。
 * 创建前先校验 branch 名合法性、确保 parent 目录存在。
 */
export async function createWorkspaceWorktree(
  projectRoot: string,
  options: CreateWorktreeOptions,
): Promise<void> {
  await assertValidBranchRef(projectRoot, options.branch);

  await mkdir(path.dirname(options.workspacePath), { recursive: true });

  const r = await runGit(projectRoot, [
    'worktree',
    'add',
    '-b',
    options.branch,
    options.workspacePath,
    options.baseCommit,
  ]);
  if (!r.ok) {
    throw new Error(`创建 Worktree 失败（${options.branch}）：${r.stderr.trim() || r.stdout.trim()}`);
  }
}

/**
 * 移除 Worktree：`git worktree remove <workspacePath>`。
 * 只在 worktree clean 时成功；失败抛错（调用方决定是否视为 warning，§12.8）。
 */
export async function removeWorkspaceWorktree(projectRoot: string, workspacePath: string): Promise<void> {
  const r = await runGit(projectRoot, ['worktree', 'remove', workspacePath]);
  if (!r.ok) {
    throw new Error(`移除 Worktree 失败（${workspacePath}）：${r.stderr.trim() || r.stdout.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// Executor Git Mutation Guard（§9.6）
// ---------------------------------------------------------------------------

export interface WorkspaceGitState {
  branch: string;
  head: string;
}

/** 读取 worktree 内的 git 状态；不是可解析 repo 时返回 null */
export async function readWorkspaceGitState(workspaceRoot: string): Promise<WorkspaceGitState | null> {
  const branch = await runGit(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = await runGit(workspaceRoot, ['rev-parse', 'HEAD']);
  if (!branch.ok || !head.ok) return null;
  return { branch: branch.stdout.trim(), head: head.stdout.trim() };
}
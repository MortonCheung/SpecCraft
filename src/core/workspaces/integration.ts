/**
 * Runtime-owned Task Commit & Deterministic Integration（ADR 0007 §12）。
 *
 * 负责（在 isolated parallel route 中）：
 *   1. Runtime Commit —— `git add -A` 后再次校验 staged files ⊆ declared scope，
 *      由 Runtime 生成标准化 commit message（绝不使用 Agent 提供的 message）；
 *   2. Deterministic Integration —— `git cherry-pick` 将 task commit 按声明顺序
 *      集成进 canonical workspace；冲突时立即 `git cherry-pick --abort`；
 *   3. Canonical Guard —— 集成前/集成间校验 canonical HEAD 与 clean 状态，
 *      防止用户并行期间的修改被覆盖（canonical_drift）；
 *   4. 冲突路径采集（`--diff-filter=U`），供 manifest 记录 conflicting_paths。
 *
 * 本模块不负责 AI 冲突解决；检测 → 记录 → abort，禁止自动 ours/theirs/reset 用户代码。
 */

import { runGit, type GitCommandResult } from './git.js';
import { pathMatchesScope } from '../tasks/scope.js';

// ---------------------------------------------------------------------------
// Runtime Commit（§12.1、§12.2）
// ---------------------------------------------------------------------------

/** 标准化 Runtime commit message（§12.1） */
export function taskCommitMessage(taskId: string, title: string): string {
  return `speccraft(task): ${taskId} — ${title}`;
}

/** `git add -A`（stage 全部变更，含新增/删除）；失败抛错 */
export async function stageAll(workspaceRoot: string): Promise<void> {
  const r = await runGit(workspaceRoot, ['add', '-A']);
  if (!r.ok) {
    throw new Error(`git add -A 失败：${r.stderr.trim() || r.stdout.trim()}`);
  }
}

/** `git diff --cached --name-only`：读取当前已 stage 的变更路径（去重 + 排序） */
export async function readStagedPaths(workspaceRoot: string): Promise<string[]> {
  const r = await runGit(workspaceRoot, ['diff', '--cached', '--name-only', '--no-renames']);
  if (!r.ok) return [];
  const set = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    const p = line.trim();
    if (p) set.add(p);
  }
  return [...set].sort();
}

export interface StageAuditResult {
  /** staged paths 是否全部落在 declared scope 内 */
  passed: boolean;
  /** 已 stage 的变更路径 */
  stagedPaths: string[];
  /** 越界路径（stagedPaths ⊄ declaredPaths） */
  violations: string[];
}

/**
 * `git add -A` 后再次校验 staged files ⊆ declared scope（§12.2）。
 *
 * 越界不 commit（只返回 violations，不 unstage——worktree 是隔离的，
 * Task 将被置为 failed 且不再集成）。
 */
export async function stageAndAudit(workspaceRoot: string, declaredPaths: string[]): Promise<StageAuditResult> {
  await stageAll(workspaceRoot);
  const stagedPaths = await readStagedPaths(workspaceRoot);
  const violations = stagedPaths.filter((p) => !declaredPaths.some((d) => pathMatchesScope(p, d)));
  return { passed: violations.length === 0, stagedPaths, violations };
}

/**
 * 执行 Runtime commit（§12.1）：commit message 由 Runtime 生成。
 * 前置：已 `stageAll` 且 staged 内容通过 scope 校验。
 * 返回 task commit SHA。
 */
export async function commitTask(workspaceRoot: string, taskId: string, title: string): Promise<string> {
  const r = await runGit(workspaceRoot, ['commit', '-m', taskCommitMessage(taskId, title)]);
  if (!r.ok) {
    throw new Error(`task commit 失败（${taskId}）：${r.stderr.trim() || r.stdout.trim()}`);
  }
  const sha = await readHead(workspaceRoot);
  if (!sha) throw new Error(`task commit 后无法解析 HEAD（${taskId}）`);
  return sha;
}

// ---------------------------------------------------------------------------
// Canonical Guard（§12.4、§12.5）
// ---------------------------------------------------------------------------

/** 读取 canonical HEAD；不可解析返回 null */
export async function readCanonicalHead(projectRoot: string): Promise<string | null> {
  const r = await runGit(projectRoot, ['rev-parse', 'HEAD']);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

/** canonical workspace 是否 clean（`git status --porcelain` 为空） */
export async function isCanonicalClean(projectRoot: string): Promise<boolean> {
  const r = await runGit(projectRoot, ['status', '--porcelain', '--untracked-files=all']);
  return r.ok && r.stdout.trim().length === 0;
}

// ---------------------------------------------------------------------------
// Integration（§12.3、§12.5、§12.6）
// ---------------------------------------------------------------------------

/** `git cherry-pick <commit>`：conflict 属正常结果，通过 GitCommandResult 返回 */
export async function cherryPick(projectRoot: string, commit: string): Promise<GitCommandResult> {
  return runGit(projectRoot, ['cherry-pick', commit]);
}

/** `git cherry-pick --abort`：发生冲突后的唯一动作；失败抛错（canonical 可能已非 clean） */
export async function abortCherryPick(projectRoot: string): Promise<void> {
  const r = await runGit(projectRoot, ['cherry-pick', '--abort']);
  if (!r.ok) {
    throw new Error(`cherry-pick --abort 失败：${r.stderr.trim() || r.stdout.trim()}`);
  }
}

/** 采集当前未合并（冲突）路径：`git diff --name-only --diff-filter=U` */
export async function readConflictPaths(projectRoot: string): Promise<string[]> {
  const r = await runGit(projectRoot, ['diff', '--name-only', '--diff-filter=U']);
  if (!r.ok) return [];
  const set = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    const p = line.trim();
    if (p) set.add(p);
  }
  return [...set].sort();
}

/** 读取某仓库（worktree 或 canonical）当前 HEAD；不可解析返回 null */
async function readHead(repoRoot: string): Promise<string | null> {
  const r = await runGit(repoRoot, ['rev-parse', 'HEAD']);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}
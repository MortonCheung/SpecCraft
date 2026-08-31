/**
 * Actual Change Audit（ADR 0007 §10.3、§10.4、§10.6）。
 *
 * 负责：
 *   1. 采集 Task Agent 执行后 worktree 内的实际变更路径
 *      （tracked modifications / staged / deletions / untracked non-ignored）；
 *   2. 将 actualChangedPaths 与 declared Task Scope 比较，
 *      判定是否 `actual ⊆ declared`，否则 SCOPE VIOLATION。
 *
 * 本模块只读 worktree 的 Git 状态，不执行任何写操作。
 */

import { runGit } from './git.js';
import { pathMatchesScope } from '../tasks/scope.js';
import type { ScopeAuditRecord } from './types.js';

/**
 * 采集 worktree 相对 baseCommit 的全部实际变更路径（去重 + 排序）。
 *
 * 组合：
 *   - `git diff --name-only --no-renames <baseCommit> --`
 *       → tracked + staged modifications + deletions；
 *       `--no-renames` 让 rename 保守地展开为 delete(old)+add(new)，
 *       保证 old/new path 都不会被 rename 检测隐藏。
 *   - `git ls-files --others --exclude-standard`
 *       → untracked non-ignored files。
 *
 * 任一命令失败（worktree 不可解析）时该来源返回空，不抛错——仍会得到
 * 另一个来源的产物；两者都失败时返回空数组（由上层判定 no_changes）。
 */
export async function collectChangedPaths(workspaceRoot: string, baseCommit: string): Promise<string[]> {
  const diff = await runGit(workspaceRoot, ['diff', '--name-only', '--no-renames', baseCommit, '--']);
  const untracked = await runGit(workspaceRoot, ['ls-files', '--others', '--exclude-standard']);

  const set = new Set<string>();
  if (diff.ok) {
    for (const line of diff.stdout.split('\n')) {
      const p = line.trim();
      if (p) set.add(p);
    }
  }
  if (untracked.ok) {
    for (const line of untracked.stdout.split('\n')) {
      const p = line.trim();
      if (p) set.add(p);
    }
  }
  return [...set].sort();
}

/**
 * 判定 actualChangedPaths ⊆ declaredScope。
 *
 * 任一 actual 路径无法被 declared 中任一 path 覆盖 → 记录为 violation。
 * declared 为空时，任何 non-empty actual 都是 violation（保守）。
 */
export function auditScope(declaredPaths: string[], actualPaths: string[]): ScopeAuditRecord {
  const violations = actualPaths.filter((p) => !declaredPaths.some((d) => pathMatchesScope(p, d)));
  return {
    declared: [...declaredPaths],
    actual: [...actualPaths],
    passed: violations.length === 0,
    violations,
  };
}

/**
 * 一步完成：采集 worktree 实际变更并执行 scope audit。
 * 供 orchestrator / integration 在 pre-verification 与 post-verification 两次调用。
 */
export async function auditChangedPaths(
  workspaceRoot: string,
  baseCommit: string,
  declaredPaths: string[],
): Promise<ScopeAuditRecord> {
  const actual = await collectChangedPaths(workspaceRoot, baseCommit);
  return auditScope(declaredPaths, actual);
}
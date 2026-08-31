/**
 * Workspace Diagnostics（ADR 0007 §15）。
 *
 * 只读诊断（list / show）+ 成功 terminal Workspace 清理（clean）：
 *   - clean 仅处理 integrated / cleaned 的遗留内容；
 *   - active / failed / integration_conflict 默认禁止删除；
 *   - 删除 task branch 前必须确认对应 workspace 已成功 integration。
 */

import { access, rm } from 'node:fs/promises';
import { runGit, removeWorkspaceWorktree } from './git.js';
import { listWorkspaceAttempts, readWorkspace, writeWorkspace } from './store.js';
import type { WorkspaceManifest, WorkspaceStatus } from './types.js';
import type { TaskGraph } from '../tasks/types.js';

/** workspaces list 的单行摘要 */
export interface WorkspaceSummary {
  taskId: string;
  attempt: number;
  status: WorkspaceStatus;
  branch: string;
  baseCommit: string;
  taskCommit?: string;
  workspaceRoot: string;
}

/** 列出当前 Run 全部 Workspace（graph 声明顺序 × attempt 递增） */
export async function listWorkspaceSummaries(
  speccraftDir: string,
  runId: string,
  graph: TaskGraph,
): Promise<WorkspaceSummary[]> {
  const summaries: WorkspaceSummary[] = [];
  for (const t of graph.tasks) {
    for (const attempt of await listWorkspaceAttempts(speccraftDir, runId, t.id)) {
      const m = await readWorkspace(speccraftDir, runId, t.id, attempt);
      if (!m) continue;
      summaries.push({
        taskId: m.taskId,
        attempt: m.attempt,
        status: m.status,
        branch: m.branch,
        baseCommit: m.baseCommit,
        ...(m.taskCommit ? { taskCommit: m.taskCommit } : {}),
        workspaceRoot: m.workspaceRoot,
      });
    }
  }
  return summaries;
}

/** 读取某 Task 全部 Workspace Attempt 的完整 manifest（show 用） */
export async function readWorkspaceDetail(
  speccraftDir: string,
  runId: string,
  taskId: string,
): Promise<WorkspaceManifest[]> {
  const out: WorkspaceManifest[] = [];
  for (const attempt of await listWorkspaceAttempts(speccraftDir, runId, taskId)) {
    const m = await readWorkspace(speccraftDir, runId, taskId, attempt);
    if (m) out.push(m);
  }
  return out;
}

/** clean 的结果 */
export interface CleanWorkspacesResult {
  /** 已清理的 `${taskId}/attempt-N` 列表 */
  cleaned: string[];
  /** 跳过（非成功 terminal 状态，默认禁止删除） */
  skipped: { taskId: string; attempt: number; status: WorkspaceStatus }[];
  /** 非致命错误（worktree 已不存在 / branch 已删除等） */
  warnings: string[];
}

/** 成功 terminal 状态（允许 clean） */
const CLEANABLE: readonly WorkspaceStatus[] = ['integrated', 'cleaned'];

/**
 * 清理成功 integration 的 Workspace 遗留内容：
 *   1. 移除残留 worktree（目录 + git 元数据）；
 *   2. 删除 task branch（仅当该 attempt 已 integrated/cleaned）；
 *   3. manifest status 置 cleaned。
 * 绝不触碰 active / failed / integration_conflict。
 */
export async function cleanWorkspaces(
  projectRoot: string,
  speccraftDir: string,
  runId: string,
  graph: TaskGraph,
): Promise<CleanWorkspacesResult> {
  const cleaned: string[] = [];
  const skipped: CleanWorkspacesResult['skipped'] = [];
  const warnings: string[] = [];
  const branchesRemoved = new Set<string>();

  for (const t of graph.tasks) {
    for (const attempt of await listWorkspaceAttempts(speccraftDir, runId, t.id)) {
      const m = await readWorkspace(speccraftDir, runId, t.id, attempt);
      if (!m) continue;

      if (!CLEANABLE.includes(m.status)) {
        skipped.push({ taskId: t.id, attempt, status: m.status });
        continue;
      }

      // 1. 残留 worktree 目录（integrated 但 cleanup 曾失败）
      if (m.workspaceRoot && (await pathExists(m.workspaceRoot))) {
        try {
          await removeWorkspaceWorktree(projectRoot, m.workspaceRoot);
        } catch {
          // worktree 元数据可能已失效：prune 后直接删目录
          await runGit(projectRoot, ['worktree', 'prune']);
          await rm(m.workspaceRoot, { recursive: true, force: true });
        }
      } else {
        await runGit(projectRoot, ['worktree', 'prune']);
      }

      // 2. task branch（前提：该 workspace 已成功 integration）
      if (m.branch && !branchesRemoved.has(m.branch)) {
        const r = await runGit(projectRoot, ['branch', '-D', m.branch]);
        if (!r.ok) warnings.push(`branch ${m.branch} 删除失败：${r.stderr.trim() || r.stdout.trim()}`);
        branchesRemoved.add(m.branch);
      }

      // 3. manifest → cleaned
      if (m.status !== 'cleaned') {
        m.status = 'cleaned';
        await writeWorkspace(speccraftDir, runId, t.id, m);
      }
      cleaned.push(`${t.id}/attempt-${String(attempt).padStart(3, '0')}`);
    }
  }

  return { cleaned, skipped, warnings };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

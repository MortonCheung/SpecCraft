/**
 * Workspace 路径规则（ADR 0007 §7.2）。
 *
 * 真正 worktree 在仓库外：
 *   <project-parent>/.speccraft-worktrees/<project-name>/<run-id>/<task-id>/attempt-NNN/
 *
 * `.speccraft` 只保存 metadata（Workspace Manifest / Wave Manifest）：
 *   .speccraft/runs/<run-id>/tasks/<task-id>/workspaces/attempt-NNN/manifest.yaml
 *   .speccraft/runs/<run-id>/waves/wave-NNN/manifest.yaml
 */

import path from 'node:path';
import { tasksDir } from '../tasks/store.js';

/** project 目录名（用于 worktree 根目录分组） */
export function projectName(projectRoot: string): string {
  return path.basename(path.resolve(projectRoot));
}

/** 仓库外 worktree 根：<project-parent>/.speccraft-worktrees/<project-name>/ */
export function worktreesRoot(projectRoot: string): string {
  return path.join(
    path.dirname(path.resolve(projectRoot)),
    '.speccraft-worktrees',
    projectName(projectRoot),
  );
}

/** 某 Task 的全部 worktree 根：.../<run-id>/<task-id>/ */
export function taskWorktreeRoot(projectRoot: string, runId: string, taskId: string): string {
  return path.join(worktreesRoot(projectRoot), runId, taskId);
}

/** 某 attempt 的 worktree 绝对路径 */
export function attemptWorktreePath(
  projectRoot: string,
  runId: string,
  taskId: string,
  attempt: number,
): string {
  return path.join(taskWorktreeRoot(projectRoot, runId, taskId), attemptDir(attempt));
}

/** attempt 目录名 */
export function attemptDir(attempt: number): string {
  return `attempt-${String(attempt).padStart(3, '0')}`;
}

/** Workspace evidence 目录（Task 独占）：.speccraft/runs/<run>/tasks/<task>/workspaces/ */
export function workspaceEvidenceDir(speccraftDir: string, runId: string, taskId: string): string {
  return path.join(tasksDir(speccraftDir, runId), taskId, 'workspaces');
}

/** 某 attempt 的 evidence 目录 */
export function workspaceAttemptEvidenceDir(
  speccraftDir: string,
  runId: string,
  taskId: string,
  attempt: number,
): string {
  return path.join(workspaceEvidenceDir(speccraftDir, runId, taskId), attemptDir(attempt));
}

/** Workspace manifest 绝对路径 */
export function workspaceManifestPath(
  speccraftDir: string,
  runId: string,
  taskId: string,
  attempt: number,
): string {
  return path.join(workspaceAttemptEvidenceDir(speccraftDir, runId, taskId, attempt), 'manifest.yaml');
}

/** wave 目录名 */
export function waveDirName(wave: number): string {
  return `wave-${String(wave).padStart(3, '0')}`;
}

/** waves evidence 根目录：.speccraft/runs/<run>/waves/ */
export function wavesDir(speccraftDir: string, runId: string): string {
  return path.join(speccraftDir, 'runs', runId, 'waves');
}

/** 某 wave 的 evidence 目录 */
export function waveEvidenceDir(speccraftDir: string, runId: string, wave: number): string {
  return path.join(wavesDir(speccraftDir, runId), waveDirName(wave));
}

/** 某 wave 的 manifest 绝对路径 */
export function waveManifestPath(speccraftDir: string, runId: string, wave: number): string {
  return path.join(waveEvidenceDir(speccraftDir, runId, wave), 'manifest.yaml');
}

/** 把任意字符串 sanitize 成 git ref 的合法段（保留 [A-Za-z0-9._-]） */
export function sanitizeRefComponent(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'x';
}

/**
 * 确定性生成 task branch 名：speccraft/<run>/<task>/wNNN。
 * 不在此处校验 ref 合法性——调用方需用 `git check-ref-format --branch` 复核（§9.3）。
 */
export function taskBranchName(runId: string, taskId: string, attempt: number): string {
  return `speccraft/${sanitizeRefComponent(runId)}/${sanitizeRefComponent(taskId)}/w${String(
    attempt,
  ).padStart(3, '0')}`;
}
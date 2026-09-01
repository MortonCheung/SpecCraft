/**
 * Review Paths（§43）。
 */

import path from 'node:path';

export function reviewWorktreesRoot(projectRoot: string): string {
  return path.join(path.dirname(projectRoot), '.speccraft-review-worktrees');
}

export function reviewWorktreePath(
  projectRoot: string,
  runId: string,
  taskId: string,
  gateId: string,
  attemptNumber: number,
): string {
  const projectName = path.basename(projectRoot);
  return path.join(
    reviewWorktreesRoot(projectRoot),
    projectName,
    runId,
    taskId,
    gateId,
    `attempt-${String(attemptNumber).padStart(3, '0')}`,
  );
}

export function reviewEvidenceDir(speccraftDir: string, runId: string, taskId: string, gateId: string): string {
  return path.join(speccraftDir, 'runs', runId, 'tasks', taskId, 'reviews', gateId);
}

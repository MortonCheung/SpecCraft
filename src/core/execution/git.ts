/**
 * 只读 Git 快照（ADR 0003 §4）。
 *
 * 本模块只允许读取 Git 状态，禁止任何写操作：
 * 不 commit、不 push、不 checkout、不 reset、不 clean、不 stash。
 */

import { spawn } from 'node:child_process';
import type { GitSnapshot } from './types.js';

/** 运行一条只读 git 命令；失败返回 null（例如目标目录不是 Git 仓库） */
function runGit(projectRoot: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let failed = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => {
      failed = true;
    });
    child.on('close', (code) => {
      resolve(failed || code !== 0 ? null : stdout);
    });
  });
}

/**
 * 采集 projectRoot 的只读 Git 快照。
 *
 * 目标项目不是 Git 仓库时返回 null（不报致命错误，SpecCraft 仍可运行，
 * baseGit / finalGit 允许为空）。
 */
export async function captureGitSnapshot(projectRoot: string): Promise<GitSnapshot | null> {
  const branchOut = await runGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const commitOut = await runGit(projectRoot, ['rev-parse', 'HEAD']);
  const statusOut = await runGit(projectRoot, ['status', '--porcelain']);
  if (branchOut === null && commitOut === null && statusOut === null) return null;

  const snapshot: GitSnapshot = {
    dirty: (statusOut ?? '').trim().length > 0,
  };
  const branch = branchOut?.trim();
  if (branch) snapshot.branch = branch;
  const commit = commitOut?.trim();
  if (commit) snapshot.commit = commit;
  return snapshot;
}

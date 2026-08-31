import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runGit, createWorkspaceWorktree } from '../src/core/workspaces/git.js';
import { collectChangedPaths, auditScope, auditChangedPaths } from '../src/core/workspaces/audit.js';
import { taskBranchName } from '../src/core/workspaces/paths.js';

/** 创建临时真实 Git repo（init commit 含 README.md + DEL.txt） */
async function makeGitRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-audit-'));
  const worktreesRoot = path.join(os.tmpdir(), `speccraft-audit-wt-${path.basename(root)}`);
  await runGit(root, ['init', '-q']);
  await runGit(root, ['config', 'user.email', 'test@example.com']);
  await runGit(root, ['config', 'user.name', 'Test']);
  await writeFile(path.join(root, 'README.md'), '# hi\n');
  await writeFile(path.join(root, 'DEL.txt'), 'to delete\n');
  await runGit(root, ['add', '.']);
  await runGit(root, ['commit', '-m', 'init']);
  return {
    root,
    worktreesRoot,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(worktreesRoot, { recursive: true, force: true });
    },
  };
}

async function makeWorktree(repo: { root: string; worktreesRoot: string }, taskId: string) {
  const base = (await runGit(repo.root, ['rev-parse', 'HEAD'])).stdout.trim();
  const branch = taskBranchName('run-1', taskId, 1);
  const wsp = path.join(repo.worktreesRoot, 'run-1', taskId, 'attempt-001');
  await createWorkspaceWorktree(repo.root, { branch, workspacePath: wsp, baseCommit: base });
  return { base, branch, wsp };
}

test('M6.3：collectChangedPaths 采集修改 + 删除 + untracked 且去重排序', async () => {
  const repo = await makeGitRepo();
  try {
    const { base, wsp } = await makeWorktree(repo, 'api-runtime');
    // 修改 tracked
    await writeFile(path.join(wsp, 'README.md'), '# changed\n');
    // 删除 tracked
    await rm(path.join(wsp, 'DEL.txt'));
    // 新增 untracked（but first mkdir）
    await mkdir(path.join(wsp, 'src', 'a'), { recursive: true });
    await writeFile(path.join(wsp, 'src', 'a', 'x.ts'), 'x');

    const changed = await collectChangedPaths(wsp, base);
    assert.deepEqual(changed, ['DEL.txt', 'README.md', 'src/a/x.ts']);
  } finally {
    await repo.cleanup();
  }
});

test('M6.3：rename 保守展开为 old+new（不隐藏任一 path）', async () => {
  const repo = await makeGitRepo();
  try {
    const { base, wsp } = await makeWorktree(repo, 'rename');
    await rename(path.join(wsp, 'DEL.txt'), path.join(wsp, 'DEL_new.txt'));

    const changed = await collectChangedPaths(wsp, base);
    assert.deepEqual(changed, ['DEL.txt', 'DEL_new.txt']);
  } finally {
    await repo.cleanup();
  }
});

test('M6.3：auditScope declared src/a/** 覆盖实际 → PASS', () => {
  const result = auditScope(['src/a/**'], ['src/a/x.ts', 'src/a/nested/y.ts']);
  assert.equal(result.passed, true);
  assert.deepEqual(result.violations, []);
});

test('M6.3：auditScope 实际越界 package.json → FAIL 并记录 violation', () => {
  const result = auditScope(['src/api/**'], ['src/api/a.ts', 'package.json']);
  assert.equal(result.passed, false);
  assert.deepEqual(result.violations, ['package.json']);
});

test('M6.3：auditScope declared 为空时任何实际变更都是 violation', () => {
  const result = auditScope([], ['package.json']);
  assert.equal(result.passed, false);
  assert.deepEqual(result.violations, ['package.json']);
  // 但 actual 为空 → PASS（no_changes 由上层判定）
  assert.equal(auditScope([], []).passed, true);
});

test('M6.3：auditChangedPaths 端到端（worktree 越界写 → FAIL）', async () => {
  const repo = await makeGitRepo();
  try {
    const { base, wsp } = await makeWorktree(repo, 'api');
    await mkdir(path.join(wsp, 'src', 'api'), { recursive: true });
    await writeFile(path.join(wsp, 'src', 'api', 'a.ts'), 'x');
    await writeFile(path.join(wsp, 'package.json'), '{}');

    const result = await auditChangedPaths(wsp, base, ['src/api/**']);
    assert.equal(result.passed, false);
    assert.deepEqual(result.violations, ['package.json']);
    assert.deepEqual(result.actual, ['package.json', 'src/api/a.ts']);
    assert.deepEqual(result.declared, ['src/api/**']);
  } finally {
    await repo.cleanup();
  }
});
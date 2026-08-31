import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  runGit,
  assertParallelGitReady,
  createWorkspaceWorktree,
  removeWorkspaceWorktree,
  readWorkspaceGitState,
} from '../src/core/workspaces/git.js';
import { taskBranchName } from '../src/core/workspaces/paths.js';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** 创建临时真实 Git repo（含一次 init commit），并返回 repo 与其 worktrees 根 */
async function makeGitRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-git-'));
  const worktreesRoot = path.join(os.tmpdir(), `speccraft-wt-${path.basename(root)}`);
  await runGit(root, ['init', '-q']);
  await runGit(root, ['config', 'user.email', 'test@example.com']);
  await runGit(root, ['config', 'user.name', 'Test']);
  await writeFile(path.join(root, 'README.md'), '# hi\n');
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

test('M6.2：create worktree + unique branch + base commit + projectRoot unchanged', async () => {
  const repo = await makeGitRepo();
  try {
    const base = (await runGit(repo.root, ['rev-parse', 'HEAD'])).stdout.trim();
    const branch1 = taskBranchName('run-1', 'api-runtime', 1);
    const wsp1 = path.join(repo.worktreesRoot, 'run-1', 'api-runtime', 'attempt-001');
    await createWorkspaceWorktree(repo.root, { branch: branch1, workspacePath: wsp1, baseCommit: base });

    // worktree 内 branch 正确
    const branchOut = await runGit(wsp1, ['rev-parse', '--abbrev-ref', 'HEAD']);
    assert.equal(branchOut.stdout.trim(), branch1);
    // base commit correct
    const headOut = await runGit(wsp1, ['rev-parse', 'HEAD']);
    assert.equal(headOut.stdout.trim(), base);
    // 继承了 tracked 文件
    const readme = await readFile(path.join(wsp1, 'README.md'), 'utf8');
    assert.equal(readme, '# hi\n');

    // projectRoot canonical 未被 worktree 创建影响
    const canonicalHead = await runGit(repo.root, ['rev-parse', 'HEAD']);
    assert.equal(canonicalHead.stdout.trim(), base);

    // unique branch：不同 attempt 分支名不同
    const branch2 = taskBranchName('run-1', 'api-runtime', 2);
    assert.notEqual(branch2, branch1);
  } finally {
    await repo.cleanup();
  }
});

test('M6.2：remove worktree', async () => {
  const repo = await makeGitRepo();
  try {
    const base = (await runGit(repo.root, ['rev-parse', 'HEAD'])).stdout.trim();
    const branch = taskBranchName('run-1', 'api-runtime', 1);
    const wsp = path.join(repo.worktreesRoot, 'run-1', 'api-runtime', 'attempt-001');
    await createWorkspaceWorktree(repo.root, { branch, workspacePath: wsp, baseCommit: base });
    assert.equal(await exists(wsp), true);

    await removeWorkspaceWorktree(repo.root, wsp);
    assert.equal(await exists(wsp), false);
  } finally {
    await repo.cleanup();
  }
});

test('M6.2：branch 名为非法 ref 时 create worktree 抛错', async () => {
  const repo = await makeGitRepo();
  try {
    const base = (await runGit(repo.root, ['rev-parse', 'HEAD'])).stdout.trim();
    const wsp = path.join(repo.worktreesRoot, 'bad');
    await assert.rejects(
      () => createWorkspaceWorktree(repo.root, { branch: 'bad..branch', workspacePath: wsp, baseCommit: base }),
      /非法 git branch 名/,
    );
  } finally {
    await repo.cleanup();
  }
});

test('M6.2：preflight 干净 repo 通过并返回 branch+head', async () => {
  const repo = await makeGitRepo();
  try {
    const ready = await assertParallelGitReady(repo.root);
    assert.equal(ready.headCommit.length > 0, true);
    assert.equal(['master', 'main'].includes(ready.branch), true);
  } finally {
    await repo.cleanup();
  }
});

test('M6.2：preflight 仅 .speccraft untracked 不算 dirty', async () => {
  const repo = await makeGitRepo();
  try {
    await mkdir(path.join(repo.root, '.speccraft', 'runs'), { recursive: true });
    await writeFile(path.join(repo.root, '.speccraft', 'runs', 'x.yaml'), 'x');
    const ready = await assertParallelGitReady(repo.root);
    assert.equal(ready.headCommit.length > 0, true);
  } finally {
    await repo.cleanup();
  }
});

test('M6.2：preflight 检测到用户代码修改时抛错', async () => {
  const repo = await makeGitRepo();
  try {
    await writeFile(path.join(repo.root, 'dirty.txt'), 'x');
    await assert.rejects(() => assertParallelGitReady(repo.root), /canonical workspace 存在未提交/);
  } finally {
    await repo.cleanup();
  }
});

test('M6.2：preflight 检测 .speccraft 被 tracked 时抛错', async () => {
  const repo = await makeGitRepo();
  try {
    await mkdir(path.join(repo.root, '.speccraft'), { recursive: true });
    await writeFile(path.join(repo.root, '.speccraft', 'state.yaml'), 'x');
    await runGit(repo.root, ['add', '.speccraft']);
    await runGit(repo.root, ['commit', '-m', 'bad tracked runtime']);
    await assert.rejects(() => assertParallelGitReady(repo.root), /.speccraft 已被 git 跟踪/);
  } finally {
    await repo.cleanup();
  }
});

test('M6.2：preflight detached HEAD 抛错', async () => {
  const repo = await makeGitRepo();
  try {
    const head = (await runGit(repo.root, ['rev-parse', 'HEAD'])).stdout.trim();
    await runGit(repo.root, ['update-ref', '--no-deref', 'HEAD', head]);
    await assert.rejects(() => assertParallelGitReady(repo.root), /detached HEAD/);
  } finally {
    await repo.cleanup();
  }
});

test('M6.2：readWorkspaceGitState 返回 worktree 分支与 HEAD', async () => {
  const repo = await makeGitRepo();
  try {
    const base = (await runGit(repo.root, ['rev-parse', 'HEAD'])).stdout.trim();
    const branch = taskBranchName('run-1', 'api-runtime', 1);
    const wsp = path.join(repo.worktreesRoot, 'run-1', 'api-runtime', 'attempt-001');
    await createWorkspaceWorktree(repo.root, { branch, workspacePath: wsp, baseCommit: base });

    const state = await readWorkspaceGitState(wsp);
    assert.equal(state?.branch, branch);
    assert.equal(state?.head, base);
  } finally {
    await repo.cleanup();
  }
});
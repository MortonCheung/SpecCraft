import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runGit } from '../src/core/workspaces/git.js';
import { createWorkspaceWorktree } from '../src/core/workspaces/git.js';
import { taskBranchName } from '../src/core/workspaces/paths.js';
import {
  taskCommitMessage,
  stageAll,
  readStagedPaths,
  stageAndAudit,
  commitTask,
  cherryPick,
  abortCherryPick,
  readConflictPaths,
  readCanonicalHead,
  isCanonicalClean,
} from '../src/core/workspaces/integration.js';

async function makeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-integ-'));
  const worktreesRoot = path.join(os.tmpdir(), `speccraft-iwt-${path.basename(root)}`);
  await runGit(root, ['init', '-q']);
  await runGit(root, ['config', 'user.email', 'test@example.com']);
  await runGit(root, ['config', 'user.name', 'Test']);
  await writeFile(path.join(root, 'README.md'), 'A\nB\n');
  await runGit(root, ['add', '.']);
  await runGit(root, ['commit', '-q', '-m', 'init']);
  const base = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
  return {
    root,
    worktreesRoot,
    base,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(worktreesRoot, { recursive: true, force: true });
    },
  };
}

async function makeWorktree(root: string, worktreesRoot: string, base: string, runId = 'run-1', taskId = 'task-a', attempt = 1) {
  const wsp = path.join(worktreesRoot, runId, taskId, `attempt-${String(attempt).padStart(3, '0')}`);
  const branch = taskBranchName(runId, taskId, attempt);
  await createWorkspaceWorktree(root, { branch, workspacePath: wsp, baseCommit: base });
  return { wsp, branch };
}

test('M6.5：taskCommitMessage 格式（Runtime 生成）', () => {
  assert.equal(taskCommitMessage('api-runtime', 'Build API'), 'speccraft(task): api-runtime — Build API');
});

test('M6.5：stageAndAudit — scope 内变更 PASS', async () => {
  const repo = await makeRepo();
  try {
    const { wsp } = await makeWorktree(repo.root, repo.worktreesRoot, repo.base);
    await mkdir(path.join(wsp, 'src', 'api'), { recursive: true });
    await writeFile(path.join(wsp, 'src', 'api', 'a.ts'), 'export const a = 1;\n');

    const result = await stageAndAudit(wsp, ['src/api/**']);
    assert.equal(result.passed, true);
    assert.deepEqual(result.stagedPaths, ['src/api/a.ts']);
    assert.deepEqual(result.violations, []);
  } finally {
    await repo.cleanup();
  }
});

test('M6.5：stageAndAudit — 越界变更 FAIL（含 violations）', async () => {
  const repo = await makeRepo();
  try {
    const { wsp } = await makeWorktree(repo.root, repo.worktreesRoot, repo.base);
    await mkdir(path.join(wsp, 'src', 'api'), { recursive: true });
    await writeFile(path.join(wsp, 'src', 'api', 'a.ts'), 'x\n');
    await writeFile(path.join(wsp, 'package.json'), '{"name":"x"}\n');

    const result = await stageAndAudit(wsp, ['src/api/**']);
    assert.equal(result.passed, false);
    assert.deepEqual(result.violations, ['package.json']);
    assert.equal(result.stagedPaths.includes('package.json'), true);
  } finally {
    await repo.cleanup();
  }
});

test('M6.5：commitTask 生成 task commit，message 正确', async () => {
  const repo = await makeRepo();
  try {
    const { wsp } = await makeWorktree(repo.root, repo.worktreesRoot, repo.base);
    await mkdir(path.join(wsp, 'src'), { recursive: true });
    await writeFile(path.join(wsp, 'src', 'a.ts'), 'x\n');
    await stageAll(wsp);
    const sha = await commitTask(wsp, 'task-a', 'Build A');
    assert.equal(sha.length, 40);

    const subject = (await runGit(wsp, ['log', '-1', '--format=%s'])).stdout.trim();
    assert.equal(subject, 'speccraft(task): task-a — Build A');
    assert.notEqual(sha, repo.base);
  } finally {
    await repo.cleanup();
  }
});

test('M6.5：readStagedPaths 返回 stage 内容（stage 前为空）', async () => {
  const repo = await makeRepo();
  try {
    const { wsp } = await makeWorktree(repo.root, repo.worktreesRoot, repo.base);
    assert.deepEqual(await readStagedPaths(wsp), []);
    await writeFile(path.join(wsp, 'new.txt'), 'x\n');
    await stageAll(wsp);
    assert.deepEqual(await readStagedPaths(wsp), ['new.txt']);
  } finally {
    await repo.cleanup();
  }
});

test('M6.5：cherryPick 成功集成，canonical 前进且文件落地', async () => {
  const repo = await makeRepo();
  try {
    const { wsp } = await makeWorktree(repo.root, repo.worktreesRoot, repo.base);
    await writeFile(path.join(wsp, 'feature.txt'), 'feature\n');
    await stageAll(wsp);
    const taskCommit = await commitTask(wsp, 'task-a', 'Add feature');

    const before = await readCanonicalHead(repo.root);
    assert.equal(before, repo.base);

    const r = await cherryPick(repo.root, taskCommit);
    assert.equal(r.ok, true, r.stderr);

    const after = await readCanonicalHead(repo.root);
    assert.notEqual(after, repo.base);
    assert.equal(await readFile(path.join(repo.root, 'feature.txt'), 'utf8'), 'feature\n');
  } finally {
    await repo.cleanup();
  }
});

test('M6.5：cherryPick 冲突 → abort → canonical clean + readConflictPaths', async () => {
  const repo = await makeRepo();
  try {
    // canonical 先改 README 第一行并 commit（模拟用户/另一 task 的落后变更）
    const readme = await readFile(path.join(repo.root, 'README.md'), 'utf8');
    await writeFile(path.join(repo.root, 'README.md'), readme.replace('A\n', 'AC\n'));
    await runGit(repo.root, ['add', 'README.md']);
    await runGit(repo.root, ['commit', '-q', '-m', 'canonical change']);

    // worktree 基于 base（init）改同一行并 commit
    const { wsp } = await makeWorktree(repo.root, repo.worktreesRoot, repo.base);
    const wtReadme = await readFile(path.join(wsp, 'README.md'), 'utf8');
    await writeFile(path.join(wsp, 'README.md'), wtReadme.replace('A\n', 'AT\n'));
    await stageAll(wsp);
    const taskCommit = await commitTask(wsp, 'task-a', 'Edit first line');

    // cherry-pick → 冲突（第 1 行两边都改了）
    const c = await cherryPick(repo.root, taskCommit);
    assert.equal(c.ok, false);
    assert.deepEqual(await readConflictPaths(repo.root), ['README.md']);

    // abort 后 canonical clean
    await abortCherryPick(repo.root);
    assert.equal(await isCanonicalClean(repo.root), true);
  } finally {
    await repo.cleanup();
  }
});

test('M6.5：isCanonicalClean / readCanonicalHead', async () => {
  const repo = await makeRepo();
  try {
    assert.equal(await isCanonicalClean(repo.root), true);
    assert.equal(await readCanonicalHead(repo.root), repo.base);

    await writeFile(path.join(repo.root, 'dirty.txt'), 'x\n');
    assert.equal(await isCanonicalClean(repo.root), false);
  } finally {
    await repo.cleanup();
  }
});
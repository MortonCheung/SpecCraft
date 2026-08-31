import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { createRun } from '../src/core/execution/store.js';
import { writeTaskGraph, createTaskManifest, writeTaskManifest } from '../src/core/tasks/store.js';
import type { TaskGraph } from '../src/core/tasks/types.js';
import { writeWorkspace } from '../src/core/workspaces/store.js';
import { writeWaveManifest } from '../src/core/workspaces/store.js';
import type { WorkspaceManifest } from '../src/core/workspaces/types.js';
import { runGit, createWorkspaceWorktree } from '../src/core/workspaces/git.js';
import { taskBranchName } from '../src/core/workspaces/paths.js';
import {
  listWorkspaceSummaries,
  readWorkspaceDetail,
  cleanWorkspaces,
} from '../src/core/workspaces/diagnostics.js';
import { cmdValidate } from '../src/cli/commands.js';
import { compileHandoffPackage } from '../src/core/handoff/package.js';
import { loadProject } from '../src/core/project.js';
import { readRun } from '../src/core/execution/store.js';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function oneTaskGraph(runId: string): TaskGraph {
  return {
    version: 1,
    runId,
    source: 'execution-manual',
    createdAt: '2026-08-31T00:00:00Z',
    tasks: [
      {
        id: 'api',
        title: 'Task API',
        summary: 'Do API',
        dependsOn: [],
        scope: { paths: ['src/api/**'] },
        verification: { commands: ['npm test'], timeoutSeconds: 120 },
      },
      {
        id: 'ui',
        title: 'Task UI',
        summary: 'Do UI',
        dependsOn: ['api'],
        scope: { paths: ['src/ui/**'] },
        verification: { commands: ['npm test'], timeoutSeconds: 120 },
      },
    ],
  };
}

function makeWorkspace(runId: string, taskId: string, attempt: number, root: string): WorkspaceManifest {
  return {
    version: 1,
    runId,
    taskId,
    attempt,
    status: 'created',
    workspaceRoot: path.join(root, 'wt', taskId, `attempt-${String(attempt).padStart(3, '0')}`),
    branch: taskBranchName(runId, taskId, attempt),
    baseCommit: '0123456789abcdef0123456789abcdef01234567',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    dispatchAttempts: [],
    verificationAttempts: [],
    changedPaths: [],
    scopeAudit: { declared: [], actual: [], passed: false, violations: [] },
  };
}

test('M6.8：listWorkspaceSummaries 按 graph 声明顺序列出全部 attempt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-diag-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const run = await createRun(speccraftDir, { id: 'run-1' });
    const graph = oneTaskGraph(run.id);
    await writeTaskGraph(speccraftDir, run.id, graph);

    const w1 = makeWorkspace(run.id, 'api', 1, root);
    const w2 = makeWorkspace(run.id, 'api', 2, root);
    w2.status = 'integrated';
    w2.taskCommit = 'fedcba9876543210fedcba9876543210fedcba98';
    const w3 = makeWorkspace(run.id, 'ui', 1, root);
    w3.status = 'failed';
    await writeWorkspace(speccraftDir, run.id, 'api', w1);
    await writeWorkspace(speccraftDir, run.id, 'api', w2);
    await writeWorkspace(speccraftDir, run.id, 'ui', w3);

    const summaries = await listWorkspaceSummaries(speccraftDir, run.id, graph);
    assert.equal(summaries.length, 3);
    assert.deepEqual(
      summaries.map((s) => `${s.taskId}/${s.attempt}`),
      ['api/1', 'api/2', 'ui/1'],
    );
    assert.equal(summaries[1].status, 'integrated');
    assert.equal(summaries[1].taskCommit, 'fedcba9876543210fedcba9876543210fedcba98');
    assert.equal(summaries[2].status, 'failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M6.8：readWorkspaceDetail 返回某 Task 全部 attempt manifest（完整字段）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-diag-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const run = await createRun(speccraftDir, { id: 'run-1' });
    await writeTaskGraph(speccraftDir, run.id, oneTaskGraph(run.id));

    const w = makeWorkspace(run.id, 'api', 1, root);
    w.status = 'integration_conflict';
    w.failurePhase = 'integration';
    w.conflictingPaths = ['src/api/a.ts'];
    w.scopeAudit = { declared: ['src/api/**'], actual: ['src/api/a.ts', 'package.json'], passed: false, violations: ['package.json'] };
    w.dispatchAttempts = [1];
    w.verificationAttempts = [1];
    await writeWorkspace(speccraftDir, run.id, 'api', w);

    const detail = await readWorkspaceDetail(speccraftDir, run.id, 'api');
    assert.equal(detail.length, 1);
    assert.equal(detail[0].status, 'integration_conflict');
    assert.equal(detail[0].failurePhase, 'integration');
    assert.deepEqual(detail[0].conflictingPaths, ['src/api/a.ts']);
    assert.deepEqual(detail[0].scopeAudit.violations, ['package.json']);
    assert.deepEqual(detail[0].dispatchAttempts, [1]);
    assert.deepEqual(detail[0].verificationAttempts, [1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// cleanWorkspaces（真实 Git repo）
// ---------------------------------------------------------------------------

async function makeGitRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-clean-'));
  await runGit(root, ['init', '-q']);
  await runGit(root, ['config', 'user.email', 'test@example.com']);
  await runGit(root, ['config', 'user.name', 'Test']);
  await writeFile(path.join(root, 'README.md'), 'A\n');
  await runGit(root, ['add', '.']);
  await runGit(root, ['commit', '-q', '-m', 'init']);
  const base = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
  return { root, base, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('M6.8：cleanWorkspaces 清理 integrated workspace（worktree + branch + status→cleaned）', async () => {
  const repo = await makeGitRepo();
  try {
    const speccraftDir = path.join(repo.root, '.speccraft');
    const runId = 'run-1';
    const graph = oneTaskGraph(runId);

    // integrated workspace（含残留 worktree）
    const wsp = path.join(repo.root, 'wt', 'api', 'attempt-001');
    const branch = taskBranchName(runId, 'api', 1);
    await createWorkspaceWorktree(repo.root, { branch, workspacePath: wsp, baseCommit: repo.base });
    const w = makeWorkspace(runId, 'api', 1, repo.root);
    w.status = 'integrated';
    w.workspaceRoot = wsp;
    w.taskCommit = repo.base;
    w.integrationCommit = repo.base;
    w.scopeAudit = { declared: ['src/api/**'], actual: ['src/api/a.ts'], passed: true, violations: [] };
    await writeWorkspace(speccraftDir, runId, 'api', w);

    const result = await cleanWorkspaces(repo.root, speccraftDir, runId, graph);
    assert.deepEqual(result.cleaned, ['api/attempt-001']);
    assert.deepEqual(result.skipped, []);
    // worktree 目录已删
    assert.equal(await exists(wsp), false);
    // branch 已删
    const branches = (await runGit(repo.root, ['branch', '--list', branch])).stdout.trim();
    assert.equal(branches, '');
    // manifest → cleaned
    const after = await readWorkspaceDetail(speccraftDir, runId, 'api');
    assert.equal(after[0].status, 'cleaned');
  } finally {
    await repo.cleanup();
  }
});

test('M6.8：cleanWorkspaces 跳过 failed / integration_conflict（禁止删除）', async () => {
  const repo = await makeGitRepo();
  try {
    const speccraftDir = path.join(repo.root, '.speccraft');
    const runId = 'run-1';
    const graph = oneTaskGraph(runId);

    // failed workspace（worktree 保留）
    const wspF = path.join(repo.root, 'wt', 'api', 'attempt-001');
    const branchF = taskBranchName(runId, 'api', 1);
    await createWorkspaceWorktree(repo.root, { branch: branchF, workspacePath: wspF, baseCommit: repo.base });
    const wf = makeWorkspace(runId, 'api', 1, repo.root);
    wf.status = 'failed';
    wf.workspaceRoot = wspF;
    await writeWorkspace(speccraftDir, runId, 'api', wf);

    // integration_conflict workspace（worktree 保留）
    const wspC = path.join(repo.root, 'wt', 'ui', 'attempt-001');
    const branchC = taskBranchName(runId, 'ui', 1);
    await createWorkspaceWorktree(repo.root, { branch: branchC, workspacePath: wspC, baseCommit: repo.base });
    const wc = makeWorkspace(runId, 'ui', 1, repo.root);
    wc.status = 'integration_conflict';
    wc.workspaceRoot = wspC;
    await writeWorkspace(speccraftDir, runId, 'ui', wc);

    const result = await cleanWorkspaces(repo.root, speccraftDir, runId, graph);
    assert.deepEqual(result.cleaned, []);
    assert.equal(result.skipped.length, 2);
    assert.equal(result.skipped[0].status, 'failed');
    assert.equal(result.skipped[1].status, 'integration_conflict');
    // worktree 与 branch 全保留
    assert.equal(await exists(wspF), true);
    assert.equal(await exists(wspC), true);
    assert.notEqual((await runGit(repo.root, ['branch', '--list', branchF])).stdout.trim(), '');
    assert.notEqual((await runGit(repo.root, ['branch', '--list', branchC])).stdout.trim(), '');
  } finally {
    await repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// validate：v0.6 workspace invariant（§20）
// ---------------------------------------------------------------------------

/** 构造最小项目：graph + manifests + workspace + wave，返回 root/speccraftDir/runId */
async function makeParallelProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-inv-'));
  const { speccraftDir } = await initProject({ projectRoot: root });
  const run = await createRun(speccraftDir, { id: 'run-1' });
  // 激活 run（真实流程由 prepareExecution 设置 state.active_run）
  const { workflow, state } = await loadProject(root);
  state.active_run = run.id;
  const { writeState } = await import('../src/core/state/store.js');
  await writeState(speccraftDir, state);
  const graph = oneTaskGraph(run.id);
  await writeTaskGraph(speccraftDir, run.id, graph);
  return { root, speccraftDir, runId: run.id, graph, workflow, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('M6.8：validate — integrated workspace + task completed 无违规', async () => {
  const p = await makeParallelProject();
  try {
    // task api completed（有 verification attempt）
    const ma = await createTaskManifest(p.speccraftDir, p.runId, 'api', 'completed');
    ma.verificationAttempts = [1];
    await writeTaskManifest(p.speccraftDir, p.runId, ma);
    const mb = await createTaskManifest(p.speccraftDir, p.runId, 'ui', 'pending');
    await writeTaskManifest(p.speccraftDir, p.runId, mb);

    // workspace integrated + wave evidence
    const w = makeWorkspace(p.runId, 'api', 1, p.root);
    w.status = 'integrated';
    w.taskCommit = '0123456789abcdef0123456789abcdef01234567';
    w.integrationCommit = 'fedcba9876543210fedcba9876543210fedcba98';
    w.scopeAudit = { declared: ['src/api/**'], actual: ['src/api/a.ts'], passed: true, violations: [] };
    await writeWorkspace(p.speccraftDir, p.runId, 'api', w);
    await writeWaveManifest(p.speccraftDir, p.runId, {
      wave: 1,
      baseCommit: '0123456789abcdef0123456789abcdef01234567',
      maxParallel: 2,
      tasks: ['api'],
      integrationOrder: ['api'],
      results: [{ taskId: 'api', result: 'integrated' }],
    });

    const exitCode = await cmdValidate(p.root);
    assert.equal(exitCode, 0);
  } finally {
    await p.cleanup();
  }
});

test('M6.8：validate — workspace integrated 但 task 未 completed → 违规', async () => {
  const p = await makeParallelProject();
  try {
    const ma = await createTaskManifest(p.speccraftDir, p.runId, 'api', 'in_progress');
    await writeTaskManifest(p.speccraftDir, p.runId, ma);
    const mb = await createTaskManifest(p.speccraftDir, p.runId, 'ui', 'pending');
    await writeTaskManifest(p.speccraftDir, p.runId, mb);

    const w = makeWorkspace(p.runId, 'api', 1, p.root);
    w.status = 'integrated';
    w.taskCommit = '0123456789abcdef0123456789abcdef01234567';
    w.scopeAudit = { declared: ['src/api/**'], actual: ['src/api/a.ts'], passed: true, violations: [] };
    await writeWorkspace(p.speccraftDir, p.runId, 'api', w);

    const exitCode = await cmdValidate(p.root);
    assert.equal(exitCode, 1);
  } finally {
    await p.cleanup();
  }
});

test('M6.8：validate — scope violations 非空却 integrated → 违规', async () => {
  const p = await makeParallelProject();
  try {
    const ma = await createTaskManifest(p.speccraftDir, p.runId, 'api', 'completed');
    ma.verificationAttempts = [1];
    await writeTaskManifest(p.speccraftDir, p.runId, ma);
    const mb = await createTaskManifest(p.speccraftDir, p.runId, 'ui', 'pending');
    await writeTaskManifest(p.speccraftDir, p.runId, mb);

    const w = makeWorkspace(p.runId, 'api', 1, p.root);
    w.status = 'integrated';
    w.taskCommit = '0123456789abcdef0123456789abcdef01234567';
    w.scopeAudit = { declared: ['src/api/**'], actual: ['package.json'], passed: false, violations: ['package.json'] };
    await writeWorkspace(p.speccraftDir, p.runId, 'api', w);

    const exitCode = await cmdValidate(p.root);
    assert.equal(exitCode, 1);
  } finally {
    await p.cleanup();
  }
});

test('M6.8：validate — parallel route task completed 但无 integrated evidence → 违规', async () => {
  const p = await makeParallelProject();
  try {
    const ma = await createTaskManifest(p.speccraftDir, p.runId, 'api', 'completed');
    ma.verificationAttempts = [1];
    await writeTaskManifest(p.speccraftDir, p.runId, ma);
    const mb = await createTaskManifest(p.speccraftDir, p.runId, 'ui', 'pending');
    await writeTaskManifest(p.speccraftDir, p.runId, mb);

    // wave evidence 存在但 workspace 只有 committed（未 integration）
    const w = makeWorkspace(p.runId, 'api', 1, p.root);
    w.status = 'committed';
    w.taskCommit = '0123456789abcdef0123456789abcdef01234567';
    await writeWorkspace(p.speccraftDir, p.runId, 'api', w);
    await writeWaveManifest(p.speccraftDir, p.runId, {
      wave: 1,
      baseCommit: '0123456789abcdef0123456789abcdef01234567',
      maxParallel: 2,
      tasks: ['api'],
      integrationOrder: ['api'],
      results: [],
    });

    const exitCode = await cmdValidate(p.root);
    assert.equal(exitCode, 1);
  } finally {
    await p.cleanup();
  }
});

// ---------------------------------------------------------------------------
// handoff：workspace-history.md（§21）
// ---------------------------------------------------------------------------

test('M6.8：handoff 生成 workspace-history.md（确定性，不调 AI）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-hows-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const run = await createRun(speccraftDir, { id: 'run-1' });
    const graph = oneTaskGraph(run.id);
    await writeTaskGraph(speccraftDir, run.id, graph);

    const w = makeWorkspace(run.id, 'api', 1, root);
    w.status = 'cleaned';
    w.taskCommit = '0123456789abcdef0123456789abcdef01234567';
    w.integrationCommit = 'fedcba9876543210fedcba9876543210fedcba98';
    w.scopeAudit = { declared: ['src/api/**'], actual: ['src/api/a.ts'], passed: true, violations: [] };
    w.dispatchAttempts = [1];
    w.verificationAttempts = [1];
    await writeWorkspace(speccraftDir, run.id, 'api', w);
    await writeWaveManifest(speccraftDir, run.id, {
      wave: 1,
      baseCommit: '0123456789abcdef0123456789abcdef01234567',
      maxParallel: 2,
      tasks: ['api'],
      integrationOrder: ['api'],
      startedAt: '2026-08-31T00:00:00.000Z',
      finishedAt: '2026-08-31T00:01:00.000Z',
      results: [{ taskId: 'api', result: 'integrated' }],
    });

    const { workflow } = await loadProject(root);
    const runManifest = await readRun(speccraftDir, run.id);
    const written = await compileHandoffPackage({
      speccraftDir,
      projectRoot: root,
      projectName: 'hows-test',
      workflow,
      run: runManifest,
      handoffId: 'handoff-001',
      createdAt: '2026-08-31T00:00:00.000Z',
    });

    assert.equal(written.includes('workspace-history.md'), true);
    const content = await readFile(path.join(speccraftDir, 'handoffs', 'handoff-001', 'workspace-history.md'), 'utf8');
    assert.match(content, /# Workspace History/);
    assert.match(content, /Execution Mode: parallel/);
    assert.match(content, /wave-001.*tasks \[api\]/);
    assert.match(content, /attempt 1（cleaned）/);
    assert.match(content, /integration commit: fedcba98/);
    assert.match(content, /scope audit: PASS/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M6.8：handoff — sequential route 不生成 workspace-history.md', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-hows-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const run = await createRun(speccraftDir, { id: 'run-1' });
    await writeTaskGraph(speccraftDir, run.id, oneTaskGraph(run.id));

    const { workflow } = await loadProject(root);
    const runManifest = await readRun(speccraftDir, run.id);
    const written = await compileHandoffPackage({
      speccraftDir,
      projectRoot: root,
      projectName: 'hows-test',
      workflow,
      run: runManifest,
      handoffId: 'handoff-001',
      createdAt: '2026-08-31T00:00:00.000Z',
    });

    assert.equal(written.includes('workspace-history.md'), false);
    assert.equal(await exists(path.join(speccraftDir, 'handoffs', 'handoff-001', 'workspace-history.md')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    void mkdir;
  }
});

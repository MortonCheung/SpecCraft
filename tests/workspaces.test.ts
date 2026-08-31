import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { createRun } from '../src/core/execution/store.js';
import { isWorkspaceStatus, WORKSPACE_STATUSES } from '../src/core/workspaces/types.js';
import type { WorkspaceManifest } from '../src/core/workspaces/types.js';
import {
  stringifyWorkspaceManifest,
  parseWorkspaceManifest,
  nextWorkspaceAttempt,
  readWorkspace,
  writeWorkspace,
  listWorkspaceAttempts,
  readLatestWorkspace,
  findReusableWorkspace,
  stringifyWaveManifest,
  parseWaveManifest,
  writeWaveManifest,
  readWaveManifest,
  nextWave,
} from '../src/core/workspaces/store.js';

function sampleWorkspace(runId: string, taskId: string, attempt: number): WorkspaceManifest {
  return {
    version: 1,
    runId,
    taskId,
    attempt,
    status: 'created',
    workspaceRoot: `/tmp/ws/${taskId}/attempt-${String(attempt).padStart(3, '0')}`,
    branch: `speccraft/${runId}/${taskId}/w${String(attempt).padStart(3, '0')}`,
    baseCommit: 'abc123',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    dispatchAttempts: [],
    verificationAttempts: [],
    changedPaths: [],
    scopeAudit: { declared: [], actual: [], passed: false, violations: [] },
  };
}

async function makeWorkspaceTestProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-ws-'));
  const { speccraftDir } = await initProject({ projectRoot: root });
  const run = await createRun(speccraftDir, { id: 'run-ws-1' });
  return { root, speccraftDir, runId: run.id, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('M6.1：WorkspaceStatus 仅 8 态 + isWorkspaceStatus 校验', () => {
  assert.deepEqual(WORKSPACE_STATUSES, [
    'created', 'active', 'verified', 'committed', 'integrated', 'failed', 'integration_conflict', 'cleaned',
  ]);
  for (const s of WORKSPACE_STATUSES) assert.equal(isWorkspaceStatus(s), true);
  assert.equal(isWorkspaceStatus('bogus'), false);
});

test('M6.1：workspace manifest parse/stringify 往返', () => {
  const m = sampleWorkspace('run-1', 'api', 1);
  m.status = 'committed';
  m.dispatchAttempts = [3, 4];
  m.verificationAttempts = [2];
  m.changedPaths = ['src/api/a.ts'];
  m.scopeAudit = { declared: ['src/api/**'], actual: ['src/api/a.ts'], passed: true, violations: [] };
  m.taskCommit = 'deadbeef';
  const round = parseWorkspaceManifest(stringifyWorkspaceManifest(m));
  assert.equal(round.runId, 'run-1');
  assert.equal(round.taskId, 'api');
  assert.equal(round.attempt, 1);
  assert.equal(round.status, 'committed');
  assert.deepEqual(round.dispatchAttempts, [3, 4]);
  assert.deepEqual(round.verificationAttempts, [2]);
  assert.deepEqual(round.changedPaths, ['src/api/a.ts']);
  assert.equal(round.scopeAudit.passed, true);
  assert.deepEqual(round.scopeAudit.violations, []);
  assert.equal(round.taskCommit, 'deadbeef');
});

test('M6.1：attempt numbering 用 max+1（含缺号安全）', async () => {
  const c = await makeWorkspaceTestProject();
  try {
    for (const attempt of [1, 2, 4]) {
      await writeWorkspace(c.speccraftDir, c.runId, 'api', {
        ...sampleWorkspace(c.runId, 'api', attempt),
        status: 'failed',
      });
    }
    // 存在 attempt 1/2/4，缺 3 → 下一个应为 5（max+1，不是 entries.length+1=4）
    const next = await nextWorkspaceAttempt(c.speccraftDir, c.runId, 'api');
    assert.equal(next, 5);
  } finally {
    await c.cleanup();
  }
});

test('M6.1：readLatestWorkspace 返回最新 attempt', async () => {
  const c = await makeWorkspaceTestProject();
  try {
    await writeWorkspace(c.speccraftDir, c.runId, 'api', { ...sampleWorkspace(c.runId, 'api', 1), status: 'failed' });
    await writeWorkspace(c.speccraftDir, c.runId, 'api', { ...sampleWorkspace(c.runId, 'api', 2), status: 'committed' });
    const latest = await readLatestWorkspace(c.speccraftDir, c.runId, 'api');
    assert.equal(latest?.attempt, 2);
    assert.equal(latest?.status, 'committed');

    const attempts = await listWorkspaceAttempts(c.speccraftDir, c.runId, 'api');
    assert.deepEqual(attempts, [1, 2]);
  } finally {
    await c.cleanup();
  }
});

test('M6.1：failed pre-integration → 复用 attempt', async () => {
  const c = await makeWorkspaceTestProject();
  try {
    await writeWorkspace(c.speccraftDir, c.runId, 'api', { ...sampleWorkspace(c.runId, 'api', 1), status: 'failed' });
    const reusable = await findReusableWorkspace(c.speccraftDir, c.runId, 'api');
    assert.equal(reusable?.attempt, 1);
  } finally {
    await c.cleanup();
  }
});

test('M6.1：integrated workspace → 不复用（新 attempt）', async () => {
  const c = await makeWorkspaceTestProject();
  try {
    await writeWorkspace(c.speccraftDir, c.runId, 'api', { ...sampleWorkspace(c.runId, 'api', 1), status: 'integrated' });
    const reusable = await findReusableWorkspace(c.speccraftDir, c.runId, 'api');
    assert.equal(reusable, null);
  } finally {
    await c.cleanup();
  }
});

test('M6.1：integration_conflict → 不复用（新 attempt）', async () => {
  const c = await makeWorkspaceTestProject();
  try {
    await writeWorkspace(c.speccraftDir, c.runId, 'api', {
      ...sampleWorkspace(c.runId, 'api', 1),
      status: 'integration_conflict',
    });
    const reusable = await findReusableWorkspace(c.speccraftDir, c.runId, 'api');
    assert.equal(reusable, null);
  } finally {
    await c.cleanup();
  }
});

test('M6.1：wave manifest 落盘 / 读取 + nextWave', async () => {
  const c = await makeWorkspaceTestProject();
  try {
    await writeWaveManifest(c.speccraftDir, c.runId, {
      wave: 1,
      baseCommit: 'abc123',
      maxParallel: 2,
      tasks: ['b', 'c'],
      startedAt: '2026-08-31T00:00:00.000Z',
      integrationOrder: ['b', 'c'],
      results: [
        { taskId: 'b', result: 'integrated' },
        { taskId: 'c', result: 'integrated' },
      ],
    });
    assert.equal(await nextWave(c.speccraftDir, c.runId), 2);
    const w = await readWaveManifest(c.speccraftDir, c.runId, 1);
    assert.equal(w?.wave, 1);
    assert.equal(w?.baseCommit, 'abc123');
    assert.equal(w?.maxParallel, 2);
    assert.deepEqual(w?.integrationOrder, ['b', 'c']);

    const round = parseWaveManifest(stringifyWaveManifest(w!));
    assert.equal(round.wave, 1);
    assert.deepEqual(round.results.map((r) => r.taskId), ['b', 'c']);
  } finally {
    await c.cleanup();
  }
});
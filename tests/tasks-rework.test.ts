import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { createRun } from '../src/core/execution/store.js';
import { compileTaskGraph } from '../src/core/tasks/compiler.js';
import { reopenTask } from '../src/core/tasks/rework.js';
import { readAllTaskManifests, writeTaskManifest } from '../src/core/tasks/store.js';

function manualBody(): string {
  return [
    '# Execution Manual',
    '',
    '## Execution Task Graph',
    '',
    '```speccraft-task-graph',
    'version: 1',
    '',
    'tasks:',
    '  - id: a',
    '    title: A',
    '    summary: Do A',
    '    depends_on: []',
    '    scope: { paths: [src/a/**] }',
    '    verification: { commands: [npm test], timeout_seconds: 30 }',
    '  - id: b',
    '    title: B',
    '    summary: Do B',
    '    depends_on: [a]',
    '    scope: { paths: [src/b/**] }',
    '    verification: { commands: [npm test], timeout_seconds: 30 }',
    '  - id: c',
    '    title: C',
    '    summary: Do C',
    '    depends_on: [a]',
    '    scope: { paths: [src/c/**] }',
    '    verification: { commands: [npm test], timeout_seconds: 30 }',
    '  - id: d',
    '    title: D',
    '    summary: Do D',
    '    depends_on: [b, c]',
    '    scope: { paths: [src/d/**] }',
    '    verification: { commands: [npm test], timeout_seconds: 30 }',
    '```',
  ].join('\n');
}

async function setup(): Promise<{ root: string; speccraftDir: string; runId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-rw-'));
  const { speccraftDir } = await initProject({ projectRoot: root });
  const run = await createRun(speccraftDir, { id: 'run-1' });
  await compileTaskGraph({ speccraftDir, runId: run.id, manualBody: manualBody(), source: 'execution-manual' });
  return { root, speccraftDir, runId: run.id };
}

test('M5.6 DoD #30#31：reopen 保留旧 evidence，reopenedCount+1', async () => {
  const { root, speccraftDir, runId } = await setup();
  try {
    // 先把 a 设为 completed（模拟已完成）
    const manifests = await readAllTaskManifests(speccraftDir, runId);
    const a = manifests.get('a')!;
    a.status = 'completed';
    a.verificationAttempts = [1];
    await writeTaskManifest(speccraftDir, runId, a);

    const result = await reopenTask({ speccraftDir, runId, taskId: 'a', cascade: false });
    assert.deepEqual(result.reopened, ['a']);

    const after = await readAllTaskManifests(speccraftDir, runId);
    const a2 = after.get('a')!;
    assert.equal(a2.status, 'ready'); // 无依赖 → ready
    assert.equal(a2.reopenedCount, 1);
    assert.deepEqual(a2.verificationAttempts, [1]); // 旧 evidence 保留
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M5.6 DoD #32：--cascade 重新打开 downstream', async () => {
  const { root, speccraftDir, runId } = await setup();
  try {
    // 全部设为 completed
    const manifests = await readAllTaskManifests(speccraftDir, runId);
    for (const [, m] of manifests) {
      m.status = 'completed';
      m.verificationAttempts = [1];
      await writeTaskManifest(speccraftDir, runId, m);
    }

    const result = await reopenTask({ speccraftDir, runId, taskId: 'a', cascade: true });
    assert.deepEqual(result.reopened, ['a', 'b', 'c', 'd']);

    const after = await readAllTaskManifests(speccraftDir, runId);
    assert.equal(after.get('a')?.status, 'ready'); // 无依赖
    assert.equal(after.get('b')?.status, 'pending'); // 依赖 a（被 reset）
    assert.equal(after.get('c')?.status, 'pending');
    assert.equal(after.get('d')?.status, 'pending');
    // 全部 reopenedCount+1
    for (const [, m] of after) assert.equal(m.reopenedCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M5.6：reopen 不存在的 task 被拒绝', async () => {
  const { root, speccraftDir, runId } = await setup();
  try {
    await assert.rejects(() => reopenTask({ speccraftDir, runId, taskId: 'nope', cascade: false }), /Task 不存在/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

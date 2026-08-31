import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { createRun } from '../src/core/execution/store.js';
import { isTaskStatus, TASK_STATUSES } from '../src/core/tasks/types.js';
import type { TaskGraph, TaskManifest } from '../src/core/tasks/types.js';
import {
  stringifyTaskGraph,
  parseTaskGraph,
  writeTaskGraph,
  readTaskGraph,
  readTaskGraphOrNull,
  createTaskManifest,
  writeTaskManifest,
  readTaskManifest,
  readAllTaskManifests,
  taskDir,
} from '../src/core/tasks/store.js';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function sampleGraph(runId: string): TaskGraph {
  return {
    version: 1,
    runId,
    source: 'execution-manual',
    createdAt: '2026-08-31T00:00:00Z',
    tasks: [
      {
        id: 'a',
        title: 'Task A',
        summary: 'Do A',
        dependsOn: [],
        scope: { paths: ['src/a/**'] },
        verification: { commands: ['npm test'], timeoutSeconds: 120 },
      },
      {
        id: 'b',
        title: 'Task B',
        summary: 'Do B',
        dependsOn: ['a'],
        scope: { paths: ['src/b/**'] },
        verification: { commands: ['npm test'], timeoutSeconds: 120 },
      },
    ],
  };
}

test('M5.1：TaskStatus 仅 6 态 + isTaskStatus 校验', () => {
  assert.deepEqual(TASK_STATUSES, ['pending', 'ready', 'in_progress', 'completed', 'failed', 'blocked']);
  for (const s of TASK_STATUSES) assert.equal(isTaskStatus(s), true);
  assert.equal(isTaskStatus('bogus'), false);
});

test('M5.1：graph parse/stringify 往返', () => {
  const graph = sampleGraph('run-1');
  const round = parseTaskGraph(stringifyTaskGraph(graph));
  assert.equal(round.runId, 'run-1');
  assert.equal(round.tasks.length, 2);
  assert.deepEqual(round.tasks[1].dependsOn, ['a']);
  assert.deepEqual(round.tasks[0].verification.commands, ['npm test']);
  assert.equal(round.tasks[0].verification.timeoutSeconds, 120);
});

test('M5.1：graph 写入/读取（file-first）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-task-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const run = await createRun(speccraftDir, { id: 'run-1' });
    await writeTaskGraph(speccraftDir, run.id, sampleGraph('run-1'));

    assert.equal(await exists(path.join(speccraftDir, 'runs', 'run-1', 'tasks', 'graph.yaml')), true);
    const graph = await readTaskGraph(speccraftDir, 'run-1');
    assert.equal(graph.tasks.length, 2);

    // 不存在时 readTaskGraph 抛错，readTaskGraphOrNull 返回 null
    await assert.rejects(() => readTaskGraph(speccraftDir, 'run-none'), /Task Graph 不存在/);
    assert.equal(await readTaskGraphOrNull(speccraftDir, 'run-none'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M5.1：task manifest 创建/写入/读取', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-task-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const run = await createRun(speccraftDir, { id: 'run-1' });
    await writeTaskGraph(speccraftDir, 'run-1', sampleGraph('run-1'));

    const m = await createTaskManifest(speccraftDir, 'run-1', 'a', 'pending');
    assert.equal(m.status, 'pending');
    assert.deepEqual(m.dispatchAttempts, []);
    assert.equal(m.reopenedCount, 0);
    assert.equal(await exists(path.join(taskDir(speccraftDir, 'run-1', 'a'), 'manifest.yaml')), true);
    assert.equal(await exists(path.join(taskDir(speccraftDir, 'run-1', 'a'), 'verification')), true);

    // 更新状态
    m.status = 'completed';
    m.dispatchAttempts.push(1);
    m.verificationAttempts.push(1);
    await writeTaskManifest(speccraftDir, 'run-1', m);

    const back = await readTaskManifest(speccraftDir, 'run-1', 'a');
    assert.equal(back?.status, 'completed');
    assert.deepEqual(back?.dispatchAttempts, [1]);
    assert.deepEqual(back?.verificationAttempts, [1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M5.1：readAllTaskManifests 返回全部 manifest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-task-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    await createRun(speccraftDir, { id: 'run-1' });
    await writeTaskGraph(speccraftDir, 'run-1', sampleGraph('run-1'));
    await createTaskManifest(speccraftDir, 'run-1', 'a', 'ready');
    await createTaskManifest(speccraftDir, 'run-1', 'b', 'pending');

    const all = await readAllTaskManifests(speccraftDir, 'run-1');
    assert.equal(all.size, 2);
    assert.equal(all.get('a')?.status, 'ready');
    assert.equal(all.get('b')?.status, 'pending');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M5.1：graph 非法输入被拒绝', () => {
  assert.throws(() => parseTaskGraph('version: 2\nrun_id: r\ntasks: []\n'), /version 必须为 1/);
  assert.throws(
    () => parseTaskGraph('version: 1\nrun_id: r\ntasks:\n  - id: a\n    title: A\n    summary: s\n    depends_on: []\n    scope: { paths: [] }\n    verification: { commands: [] }\n'),
    /scope\.paths 不能为空/,
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { createRun } from '../src/core/execution/store.js';
import { planWave, tasksCanShareWave } from '../src/core/parallel/planner.js';
import { saveWaveStart, saveWaveFinish, readWaveManifest, nextWave } from '../src/core/parallel/store.js';
import { DEFAULT_MAX_PARALLEL, isValidMaxParallel } from '../src/core/parallel/types.js';
import type { TaskGraph, TaskDefinition, TaskStatus } from '../src/core/tasks/types.js';

function task(id: string, scope: string[], dependsOn: string[] = []): TaskDefinition {
  return {
    id,
    title: `Task ${id}`,
    summary: `summary ${id}`,
    dependsOn,
    scope: { paths: scope },
    verification: { commands: ['true'], timeoutSeconds: 30 },
  };
}

function graph(tasks: TaskDefinition[]): TaskGraph {
  return { version: 1, runId: 'run-plan', source: 'manual', createdAt: '', tasks };
}

function statuses(map: Record<string, TaskStatus>): Map<string, TaskStatus> {
  return new Map(Object.entries(map));
}

const ALL_READY = (ids: string[]): Record<string, TaskStatus> =>
  Object.fromEntries(ids.map((id) => [id, 'ready' as TaskStatus]));

test('M6.6：diamond graph —— B/C 同 Wave、A/D 单独', () => {
  //        A
  //       / \
  //      B   C
  //       \ /
  //        D
  const g = graph([
    task('a', ['src/a/**']),
    task('b', ['src/backend/**'], ['a']),
    task('c', ['src/frontend/**'], ['a']),
    task('d', ['src/d/**'], ['b', 'c']),
  ]);

  // Wave 1：只有 A ready
  let plan = planWave({ graph: g, statuses: statuses({ a: 'ready', b: 'pending', c: 'pending', d: 'pending' }), maxParallel: 2 });
  assert.deepEqual(plan.tasks, ['a']);
  assert.deepEqual(plan.deferred, []);

  // Wave 2：B + C（scope disjoint）→ 同 Wave
  plan = planWave({ graph: g, statuses: statuses({ a: 'completed', b: 'ready', c: 'ready', d: 'pending' }), maxParallel: 2 });
  assert.deepEqual(plan.tasks, ['b', 'c']);
  assert.deepEqual(plan.deferred, []);

  // Wave 3：D
  plan = planWave({ graph: g, statuses: statuses({ a: 'completed', b: 'completed', c: 'completed', d: 'ready' }), maxParallel: 2 });
  assert.deepEqual(plan.tasks, ['d']);
});

test('M6.6：scope 冲突（src/shared/** vs src/shared/config/**）→ 不得同 Wave', () => {
  // §23.9：G = src/shared/**, H = src/shared/config/**
  const g = graph([task('g', ['src/shared/**']), task('h', ['src/shared/config/**'])]);
  const plan = planWave({ graph: g, statuses: statuses(ALL_READY(['g', 'h'])), maxParallel: 2 });
  // G 先选中，H 与 G 冲突 → 只留 G，H deferred
  assert.deepEqual(plan.tasks, ['g']);
  assert.deepEqual(plan.deferred, ['h']);
  assert.equal(tasksCanShareWave(g, 'g', 'h'), false);
});

test('M6.6：src/** vs src/a/** → 冲突', () => {
  const g = graph([task('a', ['src/**']), task('b', ['src/a/**'])]);
  const plan = planWave({ graph: g, statuses: statuses(ALL_READY(['a', 'b'])), maxParallel: 2 });
  assert.deepEqual(plan.tasks, ['a']);
  assert.deepEqual(plan.deferred, ['b']);
});

test('M6.6：exact file A vs exact file B → compatible 同 Wave', () => {
  const g = graph([task('a', ['src/a.ts']), task('b', ['src/b.ts'])]);
  const plan = planWave({ graph: g, statuses: statuses(ALL_READY(['a', 'b'])), maxParallel: 2 });
  assert.deepEqual(plan.tasks, ['a', 'b']);
});

test('M6.6：maxParallel=2 硬上限（4 个 disjoint 也不得超）', () => {
  const g = graph([
    task('a', ['src/a/**']),
    task('b', ['src/b/**']),
    task('c', ['src/c/**']),
    task('d', ['src/d/**']),
  ]);
  const plan = planWave({ graph: g, statuses: statuses(ALL_READY(['a', 'b', 'c', 'd'])), maxParallel: 2 });
  assert.equal(plan.tasks.length, 2);
  assert.deepEqual(plan.tasks, ['a', 'b']);
  assert.deepEqual(plan.deferred, ['c', 'd']);
});

test('M6.6：maxParallel=1 → 一次只选一个（仍走隔离路线）', () => {
  const g = graph([task('a', ['src/a/**']), task('b', ['src/b/**'])]);
  const plan = planWave({ graph: g, statuses: statuses(ALL_READY(['a', 'b'])), maxParallel: 1 });
  assert.deepEqual(plan.tasks, ['a']);
  assert.deepEqual(plan.deferred, ['b']);
});

test('M6.6：ready 顺序遵循声明顺序（确定性）', () => {
  const g = graph([task('z', ['src/z/**']), task('m', ['src/m/**']), task('a', ['src/a/**'])]);
  const plan = planWave({ graph: g, statuses: statuses(ALL_READY(['z', 'm', 'a'])), maxParallel: 3 });
  assert.deepEqual(plan.tasks, ['z', 'm', 'a']);
});

test('M6.6：planner scopes summary 记录选中 task 的 scope', () => {
  const g = graph([task('a', ['src/a/**', 'docs/a.md'])]);
  const plan = planWave({ graph: g, statuses: statuses({ a: 'ready' }), maxParallel: 2 });
  assert.deepEqual(plan.scopes['a'], ['src/a/**', 'docs/a.md']);
});

test('M6.6：in_progress / failed / blocked 的 task 不进入 wave', () => {
  const g = graph([
    task('a', ['src/a/**']),
    task('b', ['src/b/**']),
    task('c', ['src/c/**']),
    task('d', ['src/d/**']),
  ]);
  const plan = planWave({
    graph: g,
    statuses: statuses({ a: 'in_progress', b: 'failed', c: 'blocked', d: 'ready' }),
    maxParallel: 4,
  });
  assert.deepEqual(plan.tasks, ['d']);
});

test('M6.6：isValidMaxParallel / DEFAULT_MAX_PARALLEL=2', () => {
  assert.equal(DEFAULT_MAX_PARALLEL, 2);
  assert.equal(isValidMaxParallel(1), true);
  assert.equal(isValidMaxParallel(2), true);
  assert.equal(isValidMaxParallel(5), true);
  assert.equal(isValidMaxParallel(0), false);
  assert.equal(isValidMaxParallel(-1), false);
  assert.equal(isValidMaxParallel(2.5), false);
  assert.equal(isValidMaxParallel('3'), false);
});

// ---------------------------------------------------------------------------
// Wave evidence store（§13.6）
// ---------------------------------------------------------------------------

async function makeStoreProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-plan-'));
  const { speccraftDir } = await initProject({ projectRoot: root });
  const run = await createRun(speccraftDir, { id: 'run-plan-1' });
  return { root, speccraftDir, runId: run.id, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('M6.6：saveWaveStart 落盘（wave 序号递增，含 scope tasks）+ saveWaveFinish 补写结果', async () => {
  const c = await makeStoreProject();
  try {
    const g = graph([task('b', ['src/backend/**']), task('c', ['src/frontend/**'])]);
    const plan = planWave({ graph: g, statuses: statuses(ALL_READY(['b', 'c'])), maxParallel: 2 });

    const w1 = await saveWaveStart({
      speccraftDir: c.speccraftDir,
      runId: c.runId,
      plan,
      baseCommit: 'abc123',
      now: new Date('2026-08-31T00:00:00Z'),
    });
    assert.equal(w1.wave, 1);
    assert.equal(w1.baseCommit, 'abc123');
    assert.deepEqual(w1.tasks, ['b', 'c']);
    assert.deepEqual(w1.integrationOrder, ['b', 'c']); // 声明顺序
    assert.equal(w1.startedAt, '2026-08-31T00:00:00.000Z');

    // 落盘可读回
    const read1 = await readWaveManifest(c.speccraftDir, c.runId, 1);
    assert.equal(read1?.wave, 1);
    assert.deepEqual(read1?.tasks, ['b', 'c']);
    assert.deepEqual(read1?.results, []);

    // finish 补写 results + finishedAt
    const w1f = await saveWaveFinish({
      speccraftDir: c.speccraftDir,
      runId: c.runId,
      wave: 1,
      results: [
        { taskId: 'b', result: 'integrated' },
        { taskId: 'c', result: 'conflict' },
      ],
      now: new Date('2026-08-31T00:01:00Z'),
    });
    assert.deepEqual(w1f.results.map((r) => r.result), ['integrated', 'conflict']);
    assert.equal(w1f.finishedAt, '2026-08-31T00:01:00.000Z');
    assert.equal(w1f.integrationOrder.length, 2); // integrationOrder 不被 finish 改动

    // 第二个 wave 序号 = 2
    assert.equal(await nextWave(c.speccraftDir, c.runId), 2);
    const w2 = await saveWaveStart({
      speccraftDir: c.speccraftDir,
      runId: c.runId,
      plan: { ...plan, tasks: ['d'], deferred: [] },
      baseCommit: 'def456',
    });
    assert.equal(w2.wave, 2);
  } finally {
    await c.cleanup();
  }
});

test('M6.6：saveWaveFinish 对不存在的 wave 抛错', async () => {
  const c = await makeStoreProject();
  try {
    await assert.rejects(
      () => saveWaveFinish({ speccraftDir: c.speccraftDir, runId: c.runId, wave: 9, results: [] }),
      /wave manifest 不存在/,
    );
  } finally {
    await c.cleanup();
  }
});
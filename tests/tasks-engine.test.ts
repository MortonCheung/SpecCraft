import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { createRun } from '../src/core/execution/store.js';
import {
  topologicalOrder,
  transitiveDependents,
  refreshStates,
  firstReadyTask,
  hasFailedTask,
  allCompleted,
  blockedReason,
} from '../src/core/tasks/dependency.js';
import {
  normalizeScopePath,
  isValidScopePath,
  scopesOverlap,
  scopesCompatible,
  pathMatchesScope,
} from '../src/core/tasks/scope.js';
import { renderTaskPrompt, renderTaskContext, generateTaskPackage } from '../src/core/tasks/package.js';
import type { TaskGraph, TaskManifest } from '../src/core/tasks/types.js';

function diamond(): TaskGraph {
  return {
    version: 1,
    runId: 'r',
    source: 'x',
    createdAt: 't',
    tasks: [
      { id: 'a', title: 'A', summary: 's', dependsOn: [], scope: { paths: ['src/a/**'] }, verification: { commands: ['true'], timeoutSeconds: 30 } },
      { id: 'b', title: 'B', summary: 's', dependsOn: ['a'], scope: { paths: ['src/b/**'] }, verification: { commands: ['true'], timeoutSeconds: 30 } },
      { id: 'c', title: 'C', summary: 's', dependsOn: ['a'], scope: { paths: ['src/c/**'] }, verification: { commands: ['true'], timeoutSeconds: 30 } },
      { id: 'd', title: 'D', summary: 's', dependsOn: ['b', 'c'], scope: { paths: ['src/d/**'] }, verification: { commands: ['true'], timeoutSeconds: 30 } },
    ],
  };
}

function m(id: string, status: TaskManifest['status']): TaskManifest {
  return { id, status, createdAt: 't', updatedAt: 't', dispatchAttempts: [], verificationAttempts: [], reopenedCount: 0 };
}

test('M5.3：topologicalOrder 确定性（声明顺序）', () => {
  const order = topologicalOrder(diamond());
  assert.deepEqual(order, ['a', 'b', 'c', 'd']);
  // a 在 b/c/d 之前
  assert.ok(order.indexOf('a') < order.indexOf('b'));
  assert.ok(order.indexOf('a') < order.indexOf('c'));
  assert.ok(order.indexOf('d') > order.indexOf('b'));
  assert.ok(order.indexOf('d') > order.indexOf('c'));
});

test('M5.3：transitiveDependents', () => {
  assert.deepEqual(transitiveDependents(diamond(), 'a'), ['b', 'c', 'd']);
  assert.deepEqual(transitiveDependents(diamond(), 'b'), ['d']);
  assert.deepEqual(transitiveDependents(diamond(), 'd'), []);
});

test('M5.3 DoD #9#10#11#12：root ready / dependent pending / failed 传播 blocked / PASS 解锁', () => {
  // 初始：a ready，其余 pending
  let statuses = refreshStates(diamond(), new Map());
  assert.equal(statuses.get('a'), 'ready');
  assert.equal(statuses.get('b'), 'pending');
  assert.equal(statuses.get('d'), 'pending');

  // a completed → b/c ready
  statuses = refreshStates(diamond(), new Map([['a', m('a', 'completed')]]));
  assert.equal(statuses.get('b'), 'ready');
  assert.equal(statuses.get('c'), 'ready');
  assert.equal(statuses.get('d'), 'pending');

  // a failed → b/c blocked → d blocked
  statuses = refreshStates(diamond(), new Map([['a', m('a', 'failed')]]));
  assert.equal(statuses.get('b'), 'blocked');
  assert.equal(statuses.get('c'), 'blocked');
  assert.equal(statuses.get('d'), 'blocked');
  assert.equal(hasFailedTask(statuses), true);

  // b/c completed → d ready
  statuses = refreshStates(
    diamond(),
    new Map([
      ['a', m('a', 'completed')],
      ['b', m('b', 'completed')],
      ['c', m('c', 'completed')],
    ]),
  );
  assert.equal(statuses.get('d'), 'ready');
});

test('M5.3：firstReadyTask / allCompleted / blockedReason', () => {
  const statuses = refreshStates(diamond(), new Map([['a', m('a', 'completed')]]));
  assert.equal(firstReadyTask(diamond(), statuses), 'b');

  const all = refreshStates(
    diamond(),
    new Map([
      ['a', m('a', 'completed')],
      ['b', m('b', 'completed')],
      ['c', m('c', 'completed')],
      ['d', m('d', 'completed')],
    ]),
  );
  assert.equal(allCompleted(diamond(), all), true);

  const failed = refreshStates(diamond(), new Map([['a', m('a', 'failed')]]));
  const br = blockedReason(diamond(), failed);
  assert.ok(br);
  assert.equal(br.failedDep, 'a');
});

test('M5.3：scope normalize / validate / overlap 保守规则', () => {
  assert.equal(normalizeScopePath('./foo'), 'foo');
  assert.equal(normalizeScopePath('src\\a\\b'), 'src/a/b');
  assert.equal(isValidScopePath('src/a'), true);
  assert.equal(isValidScopePath('/abs'), false);
  assert.equal(isValidScopePath('../x'), false);

  // 目录 vs 子目录重叠
  assert.equal(scopesOverlap('src/a', 'src/a/b'), true);
  assert.equal(scopesOverlap('src/a/**', 'src/a/b.ts'), true);
  // 不同目录不重叠
  assert.equal(scopesOverlap('src/a', 'src/b'), false);
  // 相同重叠
  assert.equal(scopesOverlap('src/a', 'src/a'), true);
  // 文件 vs 目录（文件在目录下）重叠
  assert.equal(scopesOverlap('src/a.ts', 'src/**'), true);
});

test('M6.3：scopesCompatible 路径规则（保守）', () => {
  const s = (paths: string[]) => ({ paths });
  // §23.3：不同目录兼容
  assert.equal(scopesCompatible(s(['src/a/**']), s(['src/b/**'])), true);
  // src/** 覆盖 src/a/** → 冲突
  assert.equal(scopesCompatible(s(['src/**']), s(['src/a/**'])), false);
  // shared 父目录 vs shared 子目录 → 冲突
  assert.equal(scopesCompatible(s(['src/shared/**']), s(['src/shared/config/**'])), false);
  // 精确文件 A vs 精确文件 B → 兼容
  assert.equal(scopesCompatible(s(['src/a.ts']), s(['src/b.ts'])), true);
  // 精确文件相同 → 冲突
  assert.equal(scopesCompatible(s(['src/a.ts']), s(['src/a.ts'])), false);
  // 多 path：任一 pair 冲突则整体冲突
  assert.equal(scopesCompatible(s(['src/a/**', 'src/x/**']), s(['src/b/**', 'src/x/y.ts'])), false);
});

test('M6.3：pathMatchesScope 目录 vs 精确路径', () => {
  // 目录 scope 覆盖其下所有路径
  assert.equal(pathMatchesScope('src/a/x.ts', 'src/a/**'), true);
  // 目录 scope 覆盖目录本身
  assert.equal(pathMatchesScope('src/a', 'src/a/**'), true);
  // 精确 scope 只覆盖完全相等
  assert.equal(pathMatchesScope('src/a/x.ts', 'src/a/x.ts'), true);
  assert.equal(pathMatchesScope('src/a/x.ts', 'src/a/y.ts'), false);
  // 精确 scope 不猜测目录
  assert.equal(pathMatchesScope('src/a/x.ts', 'src/a'), false);
  // 不在目录下
  assert.equal(pathMatchesScope('src/b/x.ts', 'src/a/**'), false);
});

test('M5.3：generateTaskPackage 生成 context.md + prompt.md', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-pkg-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    await createRun(speccraftDir, { id: 'run-1' });
    const graph = diamond();
    const task = graph.tasks[0];

    const files = await generateTaskPackage({
      speccraftDir,
      runId: 'run-1',
      graph,
      task,
      runContext: '# Execution Context\n\n需求内容',
      executionGuard: '# Guard\n\nYAGNI',
    });

    assert.deepEqual(files, ['context.md', 'prompt.md']);
    const { readFile } = await import('node:fs/promises');
    const prompt = await readFile(path.join(speccraftDir, 'runs', 'run-1', 'tasks', 'a', 'prompt.md'), 'utf8');
    assert.match(prompt, /Task ID: a/);
    assert.match(prompt, /禁止修改 Scope 之外的文件/);
    assert.match(prompt, /禁止新增 Task/);
    assert.match(prompt, /YAGNI/);

    const ctx = await readFile(path.join(speccraftDir, 'runs', 'run-1', 'tasks', 'a', 'context.md'), 'utf8');
    assert.match(ctx, /需求内容/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

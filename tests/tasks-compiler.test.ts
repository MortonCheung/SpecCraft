import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { createRun } from '../src/core/execution/store.js';
import {
  extractTaskGraphBlock,
  validateScopePaths,
  validateGraphConstraints,
  initialTaskStates,
  compileTaskGraph,
} from '../src/core/tasks/compiler.js';
import { readTaskGraph } from '../src/core/tasks/store.js';
import type { TaskGraph } from '../src/core/tasks/types.js';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function graphBlock(): string {
  return [
    'version: 1',
    '',
    'tasks:',
    '  - id: a',
    '    title: Task A',
    '    summary: Do A',
    '    depends_on: []',
    '    scope: { paths: [src/a/**] }',
    '    verification: { commands: [npm test], timeout_seconds: 120 }',
    '  - id: b',
    '    title: Task B',
    '    summary: Do B',
    '    depends_on: [a]',
    '    scope: { paths: [src/b/**] }',
    '    verification: { commands: [npm test], timeout_seconds: 120 }',
  ].join('\n');
}

function manualBody(block: string): string {
  return `# Execution Manual\n\n## Execution Task Graph\n\n\`\`\`speccraft-task-graph\n${block}\n\`\`\`\n`;
}

function makeGraph(runId: string): TaskGraph {
  return {
    version: 1,
    runId,
    source: 'execution-manual',
    createdAt: '2026-08-31T00:00:00Z',
    tasks: [
      { id: 'a', title: 'A', summary: 's', dependsOn: [], scope: { paths: ['src/a/**'] }, verification: { commands: ['npm test'], timeoutSeconds: 120 } },
      { id: 'b', title: 'B', summary: 's', dependsOn: ['a'], scope: { paths: ['src/b/**'] }, verification: { commands: ['npm test'], timeoutSeconds: 120 } },
    ],
  };
}

test('M5.2：extractTaskGraphBlock 提取唯一 block', () => {
  const block = extractTaskGraphBlock(manualBody(graphBlock()));
  assert.ok(block);
  assert.match(block!, /tasks:/);
  // 多个 block 拒绝
  const twoBlocks = manualBody(graphBlock()) + '\n```speccraft-task-graph\ntasks: []\n```\n';
  assert.throws(() => extractTaskGraphBlock(twoBlocks), /只允许一个/);
  // 无 block 返回 null
  assert.equal(extractTaskGraphBlock('# no graph\n'), null);
});

test('M5.2：validateScopePaths 拒绝绝对路径与 .. 越界', () => {
  assert.deepEqual(validateScopePaths(['./foo', 'src/**']), ['foo', 'src/**']);
  assert.throws(() => validateScopePaths(['/abs/path']), /绝对路径/);
  assert.throws(() => validateScopePaths(['../outside']), /\.\./);
  assert.throws(() => validateScopePaths(['']), /空路径/);
});

test('M5.2：validateGraphConstraints 拒绝 dup/self/missing/cycle', () => {
  validateGraphConstraints(makeGraph('r')); // 合法不抛

  // duplicate
  assert.throws(
    () => validateGraphConstraints({ ...makeGraph('r'), tasks: [...makeGraph('r').tasks, { ...makeGraph('r').tasks[0] }] }),
    /id 重复/,
  );
  // self dep
  const self = makeGraph('r');
  self.tasks[0].dependsOn = ['a'];
  assert.throws(() => validateGraphConstraints(self), /self dependency/);
  // missing dep
  const missing = makeGraph('r');
  missing.tasks[1].dependsOn = ['nope'];
  assert.throws(() => validateGraphConstraints(missing), /依赖不存在/);
  // cycle
  const cyc = makeGraph('r');
  cyc.tasks[0].dependsOn = ['b'];
  assert.throws(() => validateGraphConstraints(cyc), /cycle/);
});

test('M5.2：initialTaskStates 根任务 ready、依赖 pending', () => {
  const states = initialTaskStates(makeGraph('r'));
  assert.equal(states['a'], 'ready');
  assert.equal(states['b'], 'pending');
});

test('M5.2：compileTaskGraph 落盘 graph + 初始 manifest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-compile-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const run = await createRun(speccraftDir, { id: 'run-1' });

    const result = await compileTaskGraph({
      speccraftDir,
      runId: run.id,
      manualBody: manualBody(graphBlock()),
      source: 'execution-manual',
    });

    assert.equal(result.graph.tasks.length, 2);
    assert.equal(result.initial['a'], 'ready');
    assert.equal(result.initial['b'], 'pending');

    const graph = await readTaskGraph(speccraftDir, 'run-1');
    assert.equal(graph.tasks.length, 2);
    assert.equal(await exists(path.join(speccraftDir, 'runs', 'run-1', 'tasks', 'a', 'manifest.yaml')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M5.2：legacy 无 block 时 compile 给清晰诊断（不静默生成）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-compile-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    await createRun(speccraftDir, { id: 'run-1' });
    await assert.rejects(
      () => compileTaskGraph({ speccraftDir, runId: 'run-1', manualBody: '# no graph\n', source: 'x' }),
      /未包含 speccraft-task-graph block/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M5.2：cycle 在 compile 时被拒绝', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-compile-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    await createRun(speccraftDir, { id: 'run-1' });
    const cyclic = [
      'version: 1',
      '',
      'tasks:',
      '  - id: a',
      '    title: A',
      '    summary: s',
      '    depends_on: [b]',
      '    scope: { paths: [src/a/**] }',
      '    verification: { commands: [npm test], timeout_seconds: 30 }',
      '  - id: b',
      '    title: B',
      '    summary: s',
      '    depends_on: [a]',
      '    scope: { paths: [src/b/**] }',
      '    verification: { commands: [npm test], timeout_seconds: 30 }',
    ].join('\n');
    await assert.rejects(
      () => compileTaskGraph({ speccraftDir, runId: 'run-1', manualBody: manualBody(cyclic), source: 'x' }),
      /cycle/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

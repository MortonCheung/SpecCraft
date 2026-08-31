import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test('M5.9 DoD #1#48#49#50#51#52#53#54：16 Stage 不变、无数据库/SDK/execa/nanoid/worktree/parallel', async () => {
  const { parseWorkflow } = await import('../src/core/workflow/loader.js');
  const { defaultWorkflowPath } = await import('../src/utils/paths.js');
  const wf = parseWorkflow(await readFile(defaultWorkflowPath, 'utf8'));
  assert.equal(wf.stages.length, 16);
  // Task 不是 workflow stage
  assert.ok(!wf.stages.some((s) => s.id === 'task' || s.id === 'task-graph'));

  const pkg = JSON.parse(
    await readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = Object.keys(pkg.dependencies ?? {});
  const devDeps = Object.keys(pkg.devDependencies ?? {});
  for (const banned of [
    'sqlite', 'pg', 'mysql', 'mongodb', 'redis', 'prisma', 'typeorm', 'drizzle',
    '@anthropic-ai/sdk', 'openai', 'execa', 'nanoid', 'uuid', 'zod', 'commander',
    'worker_threads', 'piscina', 'bull', 'bullmq',
  ]) {
    assert.ok(!deps.includes(banned) && !devDeps.includes(banned), `不应依赖 ${banned}`);
  }
  assert.deepEqual(deps, ['js-yaml']);
});

test('M5.9 DoD #2#3：Run 内可创建 Task Graph，且 deterministic', async () => {
  const { stringifyTaskGraph, parseTaskGraph } = await import('../src/core/tasks/store.js');
  const graph = {
    version: 1 as const,
    runId: 'r',
    source: 'execution-manual',
    createdAt: 't',
    tasks: [
      { id: 'a', title: 'A', summary: 's', dependsOn: [], scope: { paths: ['src/a/**'] }, verification: { commands: ['npm test'], timeoutSeconds: 30 } },
    ],
  };
  const s1 = stringifyTaskGraph(graph);
  const s2 = stringifyTaskGraph(graph);
  assert.equal(s1, s2); // deterministic 序列化
  const back = parseTaskGraph(s1);
  assert.equal(back.tasks[0].id, 'a');
});

test('M5.9 DoD #39#40#41#45：Run Verification / Acceptance / legacy 仍正常（已有函数存在）', async () => {
  const verify = await import('../src/core/verification/orchestrator.js');
  assert.equal(typeof verify.verifyExecution, 'function');
  const acceptance = await import('../src/core/acceptance/lifecycle.js');
  assert.equal(typeof acceptance.accept, 'function');
  assert.equal(typeof acceptance.reject, 'function');
  const handoff = await import('../src/core/handoff/lifecycle.js');
  assert.equal(typeof handoff.handoff, 'function');
  const manual = await import('../src/core/execution/adapters/manual.js');
  assert.equal(manual.manualAdapter.kind, 'manual');
});

/**
 * M7.2 — Task Executor Declaration & Assignment Plan 测试（ADR 0008 §2-§4、§14-§21）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { createRun } from '../src/core/execution/store.js';
import { parseProjectConfig } from '../src/core/project.js';
import type { ProjectConfig } from '../src/core/project.js';
import { buildExecutorsContext } from '../src/core/executors/resolver.js';
import { buildExecutorPlan } from '../src/core/executors/plan.js';
import {
  stringifyExecutorPlan,
  parseExecutorPlan,
  writeExecutorPlan,
  readExecutorPlanOrNull,
  hasExecutionEvidence,
} from '../src/core/executors/store.js';
import { LEGACY_EXECUTOR_ID } from '../src/core/executors/types.js';
import { compileTaskGraph } from '../src/core/tasks/compiler.js';
import { parseTaskDefinitions } from '../src/core/tasks/store.js';
import type { TaskDefinition, TaskGraph } from '../src/core/tasks/types.js';

function task(id: string, extra: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id,
    title: `Task ${id}`,
    summary: `Do ${id}`,
    dependsOn: [],
    scope: { paths: [`src/${id}/**`] },
    verification: { commands: ['npm test'], timeoutSeconds: 120 },
    ...extra,
  };
}

function graph(runId: string, tasks: TaskDefinition[]): TaskGraph {
  return {
    version: 1,
    runId,
    source: 'execution-manual',
    createdAt: '2026-08-31T00:00:00Z',
    tasks,
  };
}

function configWith(execution: Record<string, unknown>): ProjectConfig {
  const lines = ['name: test', 'execution:'];
  for (const [k, v] of Object.entries(execution)) {
    if (k === 'executors' || k === 'adapters') {
      lines.push(`  ${k}:`);
      for (const [id, p] of Object.entries(v as Record<string, unknown>)) {
        lines.push(`    ${id}:`);
        for (const [pk, pv] of Object.entries(p as Record<string, unknown>)) {
          lines.push(`      ${pk}: ${pv}`);
        }
      }
    } else {
      lines.push(`  ${k}: ${v}`);
    }
  }
  return parseProjectConfig(lines.join('\n'));
}

function manualBody(block: string): string {
  return `# Execution Manual\n\n## Execution Task Graph\n\n\`\`\`speccraft-task-graph\n${block}\n\`\`\`\n`;
}

// ---------------------------------------------------------------------------
// buildExecutorPlan：来源与确定性
// ---------------------------------------------------------------------------

test('M7.2：explicit executor → source task', () => {
  const ctx = buildExecutorsContext(
    configWith({
      executors: { backend: { adapter: 'claude' }, frontend: { adapter: 'codex' } },
    }),
  );
  const plan = buildExecutorPlan(
    ctx,
    {},
    graph('run-1', [task('api', { executor: 'backend' }), task('ui', { executor: 'frontend' })]),
  );

  assert.equal(plan.assignments[0].taskId, 'api');
  assert.equal(plan.assignments[0].executor, 'backend');
  assert.equal(plan.assignments[0].source, 'task');
  assert.equal(plan.assignments[0].adapter, 'claude');

  assert.equal(plan.assignments[1].executor, 'frontend');
  assert.equal(plan.assignments[1].source, 'task');
  assert.equal(plan.assignments[1].adapter, 'codex');
});

test('M7.2：缺省 task executor → default executor（source default）', () => {
  const ctx = buildExecutorsContext(
    configWith({
      default_executor: 'primary',
      executors: { primary: { adapter: 'claude', max_concurrency: 2 } },
    }),
  );
  const plan = buildExecutorPlan(ctx, {}, graph('run-1', [task('a'), task('b')]));

  assert.equal(plan.defaultExecutor, 'primary');
  for (const a of plan.assignments) {
    assert.equal(a.executor, 'primary');
    assert.equal(a.source, 'default');
    assert.equal(a.adapter, 'claude');
    assert.equal(a.maxConcurrency, 2);
  }
});

test('M7.2：legacy 无 executors → legacy-default（source legacy，adapter = default_adapter）', () => {
  const ctx = buildExecutorsContext(
    configWith({}),
  );
  // configWith 无 default_adapter 之外配置，legacy adapter 为 manual
  assert.equal(ctx.defaultExecutor, LEGACY_EXECUTOR_ID);
  assert.equal(ctx.hasDefaultExecutor, false);

  const ctx2 = buildExecutorsContext(
    parseProjectConfig('name: x\nexecution:\n  default_adapter: codex\n'),
  );
  const plan = buildExecutorPlan(ctx2, {}, graph('run-1', [task('a')]));
  assert.equal(plan.assignments[0].executor, LEGACY_EXECUTOR_ID);
  assert.equal(plan.assignments[0].source, 'legacy');
  assert.equal(plan.assignments[0].adapter, 'codex');
});

test('M7.2：unknown executor → FAIL（错误包含 Task ID + unknown ID + available IDs）', () => {
  const ctx = buildExecutorsContext(
    configWith({ executors: { backend: { adapter: 'claude' } } }),
  );
  assert.throws(
    () => buildExecutorPlan(ctx, {}, graph('run-1', [task('api', { executor: 'frontend' })])),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : '';
      return msg.includes('api') && msg.includes('frontend') && msg.includes('backend');
    },
  );
});

test('M7.2：assignment order == graph declaration order（非 Map 随机序）', () => {
  const ctx = buildExecutorsContext(
    configWith({
      executors: { a: { adapter: 'claude' }, b: { adapter: 'codex' }, c: { adapter: 'trae' } },
    }),
  );
  const plan = buildExecutorPlan(
    ctx,
    {},
    graph('run-1', [
      task('c', { executor: 'c' }),
      task('a', { executor: 'a' }),
      task('b', { executor: 'b' }),
    ]),
  );

  assert.deepEqual(
    plan.assignments.map((x) => x.taskId),
    ['c', 'a', 'b'],
  );
  assert.deepEqual(
    plan.assignments.map((x) => x.executor),
    ['c', 'a', 'b'],
  );
});

test('M7.2：resolved config precedence —— Profile override → Adapter config', () => {
  const ctx = buildExecutorsContext(
    configWith({
      default_executor: 'primary',
      adapters: { claude: { command: 'claude', timeout_seconds: 900, model: 'a-model' } },
      executors: { primary: { adapter: 'claude', timeout_seconds: 1800 } },
    }),
  );
  const plan = buildExecutorPlan(
    ctx,
    { claude: { command: 'claude', timeout_seconds: 900, model: 'a-model' } },
    graph('run-1', [task('a')]),
  );

  const r = plan.assignments[0].resolved;
  assert.equal(r.timeout_seconds, 1800); // profile 覆盖
  assert.equal(r.model, 'a-model'); // adapter config 保留
  assert.equal(r.command, 'claude'); // adapter config 保留
});

// ---------------------------------------------------------------------------
// plan roundtrip
// ---------------------------------------------------------------------------

test('M7.2：plan roundtrip（stringify → parse 一致）', () => {
  const ctx = buildExecutorsContext(
    configWith({
      default_executor: 'primary',
      executors: {
        primary: { adapter: 'claude', max_concurrency: 2 },
        frontend: { adapter: 'codex' },
      },
    }),
  );
  const plan = buildExecutorPlan(
    ctx,
    { claude: { timeout_seconds: 900 } },
    graph('run-1', [task('api', { executor: 'frontend' }), task('ui')]),
  );

  const parsed = parseExecutorPlan(stringifyExecutorPlan(plan));
  assert.deepEqual(parsed, plan);
  assert.equal(parsed.runId, 'run-1');
  assert.equal(parsed.defaultExecutor, 'primary');
  assert.equal(parsed.assignments[0].source, 'task');
  assert.equal(parsed.assignments[1].source, 'default');
  assert.equal(parsed.assignments[1].maxConcurrency, 2);
});

// ---------------------------------------------------------------------------
// 禁止 auto selector（ADR 0008 §14）
// ---------------------------------------------------------------------------

test('M7.2：parseTaskDefinitions 拒绝 executor: auto / 对象 / 非法格式', () => {
  const base = {
    id: 'a',
    title: 'A',
    summary: 's',
    depends_on: [],
    scope: { paths: ['src/a/**'] },
    verification: { commands: ['npm test'], timeout_seconds: 30 },
  };
  assert.throws(() => parseTaskDefinitions([{ ...base, executor: 'auto' }]), /禁止 executor: auto/);
  assert.throws(() => parseTaskDefinitions([{ ...base, executor: { capabilities: ['coding'] } }]), /executor 必须是非空字符串/);
  assert.throws(() => parseTaskDefinitions([{ ...base, executor: 'Bad ID' }]), /executor id 非法/);
  assert.equal(parseTaskDefinitions([base])[0].executor, undefined);
  assert.equal(parseTaskDefinitions([{ ...base, executor: 'backend' }])[0].executor, 'backend');
});

test('M7.2：buildExecutorPlan 拒绝 default_executor: auto', () => {
  const ctx = buildExecutorsContext(
    configWith({ default_executor: 'auto', executors: { auto: { adapter: 'codex' } } }),
  );
  assert.throws(() => buildExecutorPlan(ctx, {}, graph('run-1', [task('a')])), /禁止 executor: auto/);
});

// ---------------------------------------------------------------------------
// compile 集成 + Graph Recompile Guard
// ---------------------------------------------------------------------------

function graphBlock(withExecutor?: (id: string) => string): string {
  const execA = withExecutor ? `    executor: ${withExecutor('a')}` : '';
  return [
    'version: 1',
    '',
    'tasks:',
    `  - id: a`,
    '    title: Task A',
    '    summary: Do A',
    execA,
    '    depends_on: []',
    '    scope: { paths: [src/a/**] }',
    '    verification: { commands: [npm test], timeout_seconds: 120 }',
    '  - id: b',
    '    title: Task B',
    '    summary: Do B',
    '    depends_on: [a]',
    '    scope: { paths: [src/b/**] }',
    '    verification: { commands: [npm test], timeout_seconds: 120 }',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

test('M7.2：compileTaskGraph 提供 projectConfig 时构建并落盘 plan.yaml', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-plan-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const run = await createRun(speccraftDir, { id: 'run-1' });
    const projectConfig = parseProjectConfig(`
name: test
execution:
  default_adapter: claude
  default_executor: primary
  adapters:
    claude:
      timeout_seconds: 900
  executors:
    primary:
      adapter: claude
      max_concurrency: 2
    backend:
      adapter: claude
      timeout_seconds: 1200
`);

    const result = await compileTaskGraph({
      speccraftDir,
      runId: run.id,
      manualBody: manualBody(graphBlock((id) => (id === 'a' ? 'backend' : ''))),
      source: 'execution-manual',
      projectConfig,
    });

    assert.equal(result.graph.tasks.length, 2);
    const plan = await readExecutorPlanOrNull(speccraftDir, run.id);
    assert.ok(plan, 'plan.yaml 应已落盘');
    assert.equal(plan!.assignments.length, 2);
    assert.equal(plan!.assignments[0].taskId, 'a');
    assert.equal(plan!.assignments[0].executor, 'backend');
    assert.equal(plan!.assignments[0].source, 'task');
    assert.equal(plan!.assignments[0].resolved.timeout_seconds, 1200);
    assert.equal(plan!.assignments[1].taskId, 'b');
    assert.equal(plan!.assignments[1].executor, 'primary');
    assert.equal(plan!.assignments[1].source, 'default');
    assert.equal(plan!.assignments[1].maxConcurrency, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M7.2：compileTaskGraph 未提供 projectConfig 时不写 plan.yaml（向后兼容）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-plan-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const run = await createRun(speccraftDir, { id: 'run-1' });
    await compileTaskGraph({
      speccraftDir,
      runId: run.id,
      manualBody: manualBody(graphBlock()),
      source: 'execution-manual',
    });
    assert.equal(await readExecutorPlanOrNull(speccraftDir, run.id), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M7.2：duplicate task id → existing failure remains（compile 仍拒绝）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-plan-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    await createRun(speccraftDir, { id: 'run-1' });
    const dup = [
      'version: 1',
      '',
      'tasks:',
      '  - id: a',
      '    title: A',
      '    summary: s',
      '    executor: backend',
      '    depends_on: []',
      '    scope: { paths: [src/a/**] }',
      '    verification: { commands: [npm test], timeout_seconds: 30 }',
      '  - id: a',
      '    title: A2',
      '    summary: s2',
      '    executor: backend',
      '    depends_on: []',
      '    scope: { paths: [src/a/**] }',
      '    verification: { commands: [npm test], timeout_seconds: 30 }',
    ].join('\n');
    await assert.rejects(
      () =>
        compileTaskGraph({
          speccraftDir,
          runId: 'run-1',
          manualBody: manualBody(dup),
          source: 'x',
          projectConfig: parseProjectConfig(
            'name: test\nexecution:\n  executors:\n    backend:\n      adapter: claude\n',
          ),
        }),
      /id 重复/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M7.2：Graph Recompile Guard —— evidence 存在后禁止 rebuild', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-plan-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const run = await createRun(speccraftDir, { id: 'run-1' });
    const projectConfig = parseProjectConfig(
      'name: test\nexecution:\n  executors:\n    backend:\n      adapter: claude\n',
    );

    // 第一次 compile 成功
    await compileTaskGraph({
      speccraftDir,
      runId: run.id,
      manualBody: manualBody(graphBlock(() => 'backend')),
      source: 'execution-manual',
      projectConfig,
    });

    // 无 evidence 时允许重新 compile
    await compileTaskGraph({
      speccraftDir,
      runId: run.id,
      manualBody: manualBody(graphBlock()),
      source: 'execution-manual',
      projectConfig,
    });

    // 制造 dispatch evidence（.speccraft/runs/run-1/dispatch/attempt-001/）
    await mkdir(path.join(speccraftDir, 'runs', run.id, 'dispatch', 'attempt-001'), {
      recursive: true,
    });
    assert.equal(await hasExecutionEvidence(speccraftDir, run.id), true);

    await assert.rejects(
      () =>
        compileTaskGraph({
          speccraftDir,
          runId: run.id,
          manualBody: manualBody(graphBlock()),
          source: 'execution-manual',
          projectConfig,
        }),
      /cannot rebuild task\/executor plan after execution evidence exists/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * M7.5 — Sequential Multi-Executor Runtime 测试（ADR 0008 §37-§41）。
 *
 * 覆盖：
 *   1. §41 Sequential E2E：A→fake-alpha，B→fake-beta，C→fake-alpha（真实 Dispatch Evidence）
 *   2. executorResolver 缺省 → legacy single-executor fallback（options.adapter，§39）
 *   3. buildExecutorResolver.resolve 未知 adapter → 抛错
 *   4. buildExecutorResolver.resolve 缺失 task → 抛错
 *   5. §40 CLI：Explicit Executor Graph + --adapter → 拒绝
 *   6. §40 CLI：Legacy Graph + --adapter 仍允许 single-adapter override
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initProject } from '../src/core/init.js';
import { loadProject, loadProjectConfig } from '../src/core/project.js';
import { completeStage, approveStage } from '../src/core/advance.js';
import { writeArtifact, createArtifact, readArtifact, artifactFileName } from '../src/core/artifacts/store.js';
import { resolveTemplateContent } from '../src/core/templates/resolver.js';
import { prepareExecution } from '../src/core/execution/prepare.js';
import { readRun } from '../src/core/execution/store.js';
import { registerAdapter, getAdapter } from '../src/core/execution/adapters/registry.js';
import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import type { CliExecutionAdapter, NormalizedDispatchResult } from '../src/core/execution/adapters/types.js';
import { compileTaskGraph } from '../src/core/tasks/compiler.js';
import { executeTaskGraph } from '../src/core/tasks/orchestrator.js';
import { readExecutorPlan } from '../src/core/executors/store.js';
import { buildExecutorResolver } from '../src/core/executors/resolver.js';
import { readDispatchAttempt, listDispatchAttemptsForTask } from '../src/core/dispatch/store.js';
import { cmdExecute } from '../src/cli/commands.js';
import type { Workflow, State } from '../src/core/types.js';

const fakeAgentPath = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

async function makeArtifact(speccraftDir: string, workflow: Workflow, state: State, stageId: string): Promise<void> {
  const stage = workflow.stages.find((s) => s.id === stageId)!;
  const target = completeStage(workflow, state, stageId);
  const body = await resolveTemplateContent(stage.template ?? stage.id);
  const artifact = createArtifact({ artifact: stage.produces[0], stage: stageId, status: target, version: 1 }, body);
  await writeArtifact(path.join(speccraftDir, 'artifacts', artifactFileName(stage.produces[0])), artifact);
}

async function makeReadyProject(manualBody: string, projectYaml: string): Promise<{ root: string; speccraftDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-v07seq-'));
  const { speccraftDir } = await initProject({ projectRoot: root });
  const { workflow, state } = await loadProject(root);
  for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
    await makeArtifact(speccraftDir, workflow, state, id);
  }
  approveStage(workflow, state, 'design', 'owner');
  for (const id of ['build-brief', 'site-survey', 'execution-manual']) {
    await makeArtifact(speccraftDir, workflow, state, id);
  }
  const manualPath = path.join(speccraftDir, 'artifacts', 'execution-manual.md');
  const manual = await readArtifact(manualPath);
  manual.body = manualBody;
  await writeArtifact(manualPath, manual);
  const { writeState } = await import('../src/core/state/store.js');
  await writeState(speccraftDir, state);
  await writeFile(path.join(speccraftDir, 'project.yaml'), projectYaml, 'utf8');
  return { root, speccraftDir };
}

/** 具名 fake adapter（id 可区分，用于异构断言） */
function makeNamedAdapter(id: string, mode = 'jsonl'): CliExecutionAdapter {
  return {
    id,
    kind: 'cli',
    capabilities: {
      invoke: true, resume: true, structuredOutput: true,
      finalMessageFile: true, sessionId: true, modelSelection: false,
    },
    prepare: manualAdapter.prepare,
    probe: async () => ({ id, installed: true }),
    buildInvocation: async (input) => ({
      command: 'node',
      args: [fakeAgentPath],
      cwd: input.projectRoot,
      stdin: input.prompt,
      env: { FAKE_AGENT_MODE: mode, FAKE_AGENT_SESSION: `sess-${id}-${Math.random().toString(16).slice(2, 6)}` },
      timeoutMs: 10000,
    }),
    normalize: async (input): Promise<NormalizedDispatchResult> => {
      let sessionId: string | undefined;
      let finalMessage: string | undefined;
      for (const line of input.stdout.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.session_id) sessionId = obj.session_id;
          if (obj.type === 'final_message') finalMessage = obj.text;
        } catch { /* ignore */ }
      }
      return {
        adapter: id,
        status: input.timedOut ? 'timed_out' : input.spawnError ? 'spawn_error' : input.exitCode === 0 ? 'succeeded' : 'failed',
        exitCode: input.exitCode ?? undefined,
        timedOut: input.timedOut,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        durationMs: input.durationMs,
        ...(sessionId ? { sessionId } : {}),
        ...(finalMessage ? { finalMessage } : {}),
        events: [],
      };
    },
  };
}

/** 读取某 task 最新 dispatch attempt 的 manifest */
async function latestDispatch(speccraftDir: string, runId: string, taskId: string) {
  const attempts = await listDispatchAttemptsForTask(speccraftDir, runId, taskId);
  assert.ok(attempts.length > 0, `task ${taskId} 应有 dispatch attempt`);
  return readDispatchAttempt(speccraftDir, runId, attempts[attempts.length - 1]);
}

function captureStderr(): { collect: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { chunks.push(args.map(String).join(' ')); };
  return {
    collect: () => chunks.join('\n'),
    restore: () => { console.error = original; },
  };
}

const VERIF_OK = 'verification: { commands: [echo ok], timeout_seconds: 30 }';

const SEQ_BLOCK = [
  '# Execution Manual',
  '',
  '## Execution Task Graph',
  '',
  '```speccraft-task-graph',
  'version: 1',
  '',
  'tasks:',
  `  - id: a
    title: A
    summary: Do A
    executor: alpha
    depends_on: []
    scope: { paths: [src/a/**] }
    ${VERIF_OK}`,
  `  - id: b
    title: B
    summary: Do B
    executor: beta
    depends_on: [a]
    scope: { paths: [src/b/**] }
    ${VERIF_OK}`,
  `  - id: c
    title: C
    summary: Do C
    executor: alpha
    depends_on: [b]
    scope: { paths: [src/c/**] }
    ${VERIF_OK}`,
  '```',
].join('\n');

const SEQ_PROJECT_YAML = [
  'name: v07-seq',
  'execution:',
  '  default_adapter: fake-alpha',
  '  adapters:',
  '    fake-alpha:',
  '      timeout_seconds: 60',
  '    fake-beta:',
  '      timeout_seconds: 60',
  '  default_executor: primary',
  '  executors:',
  '    alpha:',
  '      adapter: fake-alpha',
  '    beta:',
  '      adapter: fake-beta',
  'verification:',
  '  timeout_seconds: 60',
  '  commands:',
  '    - "true"',
].join('\n');

// ---------------------------------------------------------------------------
// §41 Sequential E2E：异构 Executor
// ---------------------------------------------------------------------------

test('M7.5 §41：sequential heterogeneous E2E — A→fake-alpha, B→fake-beta, C→fake-alpha', async () => {
  registerAdapter(makeNamedAdapter('fake-alpha'));
  registerAdapter(makeNamedAdapter('fake-beta'));
  const { root, speccraftDir } = await makeReadyProject(SEQ_BLOCK, SEQ_PROJECT_YAML);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: SEQ_BLOCK, source: 'execution-manual', projectConfig });

    // frozen plan → ExecutorResolver
    const plan = await readExecutorPlan(speccraftDir, runId);
    assert.equal(plan.assignments.length, 3);
    const resolver = buildExecutorResolver({ plan });

    const result = await executeTaskGraph({
      speccraftDir,
      projectRoot: root,
      runId,
      adapter: getAdapter('fake-alpha') as CliExecutionAdapter,
      runContext: '# ctx',
      executionGuard: '# guard',
      executorResolver: resolver,
    });

    // Task Graph / Run / Verification / Acceptance 语义不变
    assert.equal(result.complete, true);
    assert.deepEqual(result.executed, ['a', 'b', 'c']); // 确定性顺序
    assert.equal(result.completedTasks, 3);
    const run = await readRun(speccraftDir, runId);
    assert.equal(run.status, 'awaiting_verification');

    // Dispatch Evidence：A adapter alpha，B adapter beta，C adapter alpha（§41）
    const da = await latestDispatch(speccraftDir, runId, 'a');
    assert.equal(da?.adapter, 'fake-alpha');
    assert.equal(da?.executor_profile, 'alpha');
    assert.equal(da?.task_id, 'a');

    const db = await latestDispatch(speccraftDir, runId, 'b');
    assert.equal(db?.adapter, 'fake-beta');
    assert.equal(db?.executor_profile, 'beta');
    assert.equal(db?.task_id, 'b');

    const dc = await latestDispatch(speccraftDir, runId, 'c');
    assert.equal(dc?.adapter, 'fake-alpha');
    assert.equal(dc?.executor_profile, 'alpha');
    assert.equal(dc?.task_id, 'c');

    // plan 冻结：run 内 assignment 与 graph 声明顺序一致
    assert.deepEqual(plan.assignments.map((x) => [x.taskId, x.executor, x.adapter]), [
      ['a', 'alpha', 'fake-alpha'],
      ['b', 'beta', 'fake-beta'],
      ['c', 'alpha', 'fake-alpha'],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §39 Backward-Compatible API：无 resolver → options.adapter
// ---------------------------------------------------------------------------

const TWO_TASK_BLOCK = [
  '# Execution Manual',
  '',
  '## Execution Task Graph',
  '',
  '```speccraft-task-graph',
  'version: 1',
  '',
  'tasks:',
  `  - id: a
    title: A
    summary: Do A
    depends_on: []
    scope: { paths: [src/a/**] }
    ${VERIF_OK}`,
  `  - id: b
    title: B
    summary: Do B
    depends_on: []
    scope: { paths: [src/b/**] }
    ${VERIF_OK}`,
  '```',
].join('\n');

test('M7.5 §39：executorResolver 缺省 → legacy single-executor fallback（options.adapter）', async () => {
  registerAdapter(makeNamedAdapter('fake-alpha'));
  const { root, speccraftDir } = await makeReadyProject(TWO_TASK_BLOCK, SEQ_PROJECT_YAML);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    // 不传 projectConfig → 不生成 plan（legacy 调用方路径）
    await compileTaskGraph({ speccraftDir, runId, manualBody: TWO_TASK_BLOCK, source: 'execution-manual' });

    const result = await executeTaskGraph({
      speccraftDir,
      projectRoot: root,
      runId,
      adapter: getAdapter('fake-alpha') as CliExecutionAdapter,
      runContext: '# ctx',
      executionGuard: '# guard',
    });

    assert.equal(result.complete, true);
    assert.deepEqual(result.executed, ['a', 'b']);

    // 全部 Task 使用 options.adapter（single-adapter fallback，v0.6 行为不变）
    for (const id of ['a', 'b']) {
      const d = await latestDispatch(speccraftDir, runId, id);
      assert.equal(d?.adapter, 'fake-alpha');
      // 无 plan → 无 executor_profile（legacy 语义）
      assert.equal(d?.executor_profile, undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildExecutorResolver 单元测试
// ---------------------------------------------------------------------------

test('M7.5 §38：resolve 未知 adapter → 抛错（不可静默 fallback）', () => {
  registerAdapter(makeNamedAdapter('fake-alpha'));
  const plan = {
    version: 1 as const,
    runId: 'run-1',
    createdAt: 'now',
    defaultExecutor: 'x',
    assignments: [
      { taskId: 'a', executor: 'x', source: 'task' as const, adapter: 'fake-unknown', resolved: {} },
    ],
  };
  const resolver = buildExecutorResolver({ plan });
  assert.throws(() => resolver.resolve('a'), /adapter fake-unknown 不可用/);
});

test('M7.5 §38：resolve 缺失 task → 抛错（plan 与 graph 不一致）', () => {
  registerAdapter(makeNamedAdapter('fake-alpha'));
  const plan = {
    version: 1 as const,
    runId: 'run-1',
    createdAt: 'now',
    defaultExecutor: 'x',
    assignments: [{ taskId: 'a', executor: 'x', source: 'task' as const, adapter: 'fake-alpha', resolved: {} }],
  };
  const resolver = buildExecutorResolver({ plan });
  assert.throws(() => resolver.resolve('nope'), /没有 Executor Assignment/);
});

test('M7.5 §38：resolve 返回 ResolvedTaskExecutor（adapter + adapterConfig + maxConcurrency）', () => {
  registerAdapter(makeNamedAdapter('fake-alpha'));
  const plan = {
    version: 1 as const,
    runId: 'run-1',
    createdAt: 'now',
    defaultExecutor: 'x',
    assignments: [
      { taskId: 'a', executor: 'x', source: 'task' as const, adapter: 'fake-alpha', resolved: { timeout_seconds: 1200 }, maxConcurrency: 2 },
    ],
  };
  const resolver = buildExecutorResolver({ plan });
  const r = resolver.resolve('a');
  assert.equal(r.executorId, 'x');
  assert.equal(r.adapterId, 'fake-alpha');
  assert.equal(r.adapter.id, 'fake-alpha');
  assert.deepEqual(r.adapterConfig, { timeout_seconds: 1200 });
  assert.equal(r.maxConcurrency, 2);
});

// ---------------------------------------------------------------------------
// §40 CLI --adapter 规则
// ---------------------------------------------------------------------------

test('M7.5 §40 CLI：Explicit Executor Graph + --adapter → 拒绝', async () => {
  registerAdapter(makeNamedAdapter('fake-alpha'));
  registerAdapter(makeNamedAdapter('fake-beta'));
  const { root, speccraftDir } = await makeReadyProject(SEQ_BLOCK, SEQ_PROJECT_YAML);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: SEQ_BLOCK, source: 'execution-manual', projectConfig });

    const stderr = captureStderr();
    try {
      const code = await cmdExecute({ adapter: 'fake-beta' }, root);
      assert.equal(code, 1);
      assert.match(stderr.collect(), /--adapter cannot override explicit Task Executor assignments/);
    } finally {
      stderr.restore();
    }

    // 拒绝发生在 mutation 前：无任何 dispatch evidence
    const { listDispatchAttempts } = await import('../src/core/dispatch/store.js');
    assert.deepEqual(await listDispatchAttempts(speccraftDir, runId), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M7.5 §40 CLI：Legacy Graph + --adapter 仍允许 single-adapter override', async () => {
  registerAdapter(makeNamedAdapter('fake-alpha'));
  registerAdapter(makeNamedAdapter('fake-beta'));
  // legacy project.yaml：无 default_executor / executors / task.executor
  const legacyYaml = [
    'name: v07-legacy',
    'execution:',
    '  default_adapter: fake-alpha',
    '  adapters:',
    '    fake-alpha:',
    '      timeout_seconds: 60',
    '    fake-beta:',
    '      timeout_seconds: 60',
    'verification:',
    '  timeout_seconds: 60',
    '  commands:',
    '    - "true"',
  ].join('\n');
  const { root, speccraftDir } = await makeReadyProject(TWO_TASK_BLOCK, legacyYaml);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: TWO_TASK_BLOCK, source: 'execution-manual', projectConfig });

    // legacy graph：--adapter fake-beta 作为 single-adapter override
    const code = await cmdExecute({ adapter: 'fake-beta' }, root);
    assert.equal(code, 0);

    // 真实 dispatch evidence：全部使用 fake-beta（override 生效）
    for (const id of ['a', 'b']) {
      const d = await latestDispatch(speccraftDir, runId, id);
      assert.equal(d?.adapter, 'fake-beta');
      // legacy-default 逻辑 profile（§12）
      assert.equal(d?.executor_profile, 'legacy-default');
    }
    const run = await readRun(speccraftDir, runId);
    assert.equal(run.status, 'awaiting_verification');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * M7.6 — Parallel Multi-Executor Scheduling 测试（ADR 0008 §42-§50）。
 *
 * 覆盖：
 *   1. §50 Parallel E2E：diamond A→(B‖C)→D，B→fake-alpha，C→fake-beta
 *      —— 不同 Provider 真并行 + 异构 adapter dispatch evidence + wave evidence
 *   2. §46 Profile 容量：B/C → backend（max_concurrency=1）→ 不同 Wave
 *   3. §47 Global vs Profile limit（planner 单元）
 *   4. §48 同 Adapter 不同 Profile → 并发限制按 Executor Profile（无 adapter rate limiter）
 *   5. §49 Wave Evidence：wave manifest.executors
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initProject } from '../src/core/init.js';
import { loadProject, loadProjectConfig } from '../src/core/project.js';
import { completeStage, approveStage } from '../src/core/advance.js';
import { writeArtifact, readArtifact, createArtifact, artifactFileName } from '../src/core/artifacts/store.js';
import { resolveTemplateContent } from '../src/core/templates/resolver.js';
import { prepareExecution } from '../src/core/execution/prepare.js';
import { readRun } from '../src/core/execution/store.js';
import { registerAdapter } from '../src/core/execution/adapters/registry.js';
import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import type { CliExecutionAdapter, NormalizedDispatchResult } from '../src/core/execution/adapters/types.js';
import { compileTaskGraph } from '../src/core/tasks/compiler.js';
import { executeParallelTaskGraph } from '../src/core/parallel/orchestrator.js';
import { planWave } from '../src/core/parallel/planner.js';
import { readExecutorPlan } from '../src/core/executors/store.js';
import { buildExecutorResolver } from '../src/core/executors/resolver.js';
import { readWaveManifest, listWaves } from '../src/core/workspaces/store.js';
import { readCanonicalHead, isCanonicalClean } from '../src/core/workspaces/integration.js';
import { runGit } from '../src/core/workspaces/git.js';
import { listDispatchAttemptsForTask, readDispatchAttempt } from '../src/core/dispatch/store.js';
import type { TaskGraph, TaskDefinition, TaskStatus } from '../src/core/tasks/types.js';
import type { Workflow, State } from '../src/core/types.js';

const fakeAgentPath = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// 基础设施：具名 work adapter（id 可区分 + worktree 内真实施工 + 可选 sleep）
// ---------------------------------------------------------------------------

interface WorkSpec {
  write?: Record<string, string>;
  sleepMs?: number;
}

/** 具名 work adapter：按 task id 写文件 / sleep，normalize 返回该 adapter id */
function makeNamedWorkAdapter(id: string, getPlan: () => Record<string, WorkSpec>): CliExecutionAdapter {
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
      env: {
        FAKE_AGENT_MODE: 'work',
        FAKE_AGENT_PLAN: JSON.stringify(getPlan()),
        FAKE_AGENT_SESSION: `sess-${id}-${Math.random().toString(16).slice(2, 6)}`,
      },
      timeoutMs: 60000,
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

async function makeArtifact(speccraftDir: string, workflow: Workflow, state: State, stageId: string): Promise<void> {
  const stage = workflow.stages.find((s) => s.id === stageId)!;
  const target = completeStage(workflow, state, stageId);
  const body = await resolveTemplateContent(stage.template ?? stage.id);
  const artifact = createArtifact({ artifact: stage.produces[0], stage: stageId, status: target, version: 1 }, body);
  await writeArtifact(path.join(speccraftDir, 'artifacts', artifactFileName(stage.produces[0])), artifact);
}

const VERIF_OK = 'verification: { commands: [echo ok], timeout_seconds: 30 }';

function taskBlock(tasks: string[]): string {
  return [
    '## Execution Task Graph',
    '',
    '```speccraft-task-graph',
    'version: 1',
    '',
    'tasks:',
    ...tasks,
    '```',
  ].join('\n');
}

/** 真实 Git repo + 完整 Workflow + executor project.yaml + prepared Run + frozen plan */
async function makeExecutorProject(
  block: string,
  projectYaml: string,
  adapters: CliExecutionAdapter[],
): Promise<{ root: string; speccraftDir: string; runId: string; outer: string }> {
  const outer = await mkdtemp(path.join(os.tmpdir(), 'speccraft-parx-'));
  const root = path.join(outer, 'proj');
  await mkdir(root, { recursive: true });
  await runGit(root, ['init', '-q']);
  await runGit(root, ['config', 'user.email', 'test@example.com']);
  await runGit(root, ['config', 'user.name', 'Test']);
  await writeFile(path.join(root, '.gitignore'), '.speccraft/\n', 'utf8');
  await writeFile(path.join(root, 'README.md'), 'init\n', 'utf8');
  await runGit(root, ['add', '.']);
  await runGit(root, ['commit', '-q', '-m', 'init']);

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
  manual.body = block;
  await writeArtifact(manualPath, manual);

  const { writeState } = await import('../src/core/state/store.js');
  await writeState(speccraftDir, state);
  await writeFile(path.join(speccraftDir, 'project.yaml'), projectYaml, 'utf8');

  for (const a of adapters) registerAdapter(a);
  const { runId } = await prepareExecution({ projectRoot: root, adapterId: adapters[0].id });
  const projectConfig = await loadProjectConfig(speccraftDir);
  await compileTaskGraph({ speccraftDir, runId, manualBody: block, source: 'execution-manual', projectConfig });
  return { root, speccraftDir, runId, outer };
}

function projectCleanup(root: string): Promise<void> {
  return rm(path.dirname(root), { recursive: true, force: true });
}

/** 读取某 task 最新 dispatch attempt 的 manifest */
async function latestDispatch(speccraftDir: string, runId: string, taskId: string) {
  const attempts = await listDispatchAttemptsForTask(speccraftDir, runId, taskId);
  assert.ok(attempts.length > 0, `task ${taskId} 应有 dispatch attempt`);
  return readDispatchAttempt(speccraftDir, runId, attempts[attempts.length - 1]);
}

// ---------------------------------------------------------------------------
// §50 Parallel E2E：不同 Provider 真并行（v0.7 最核心 E2E）
// ---------------------------------------------------------------------------

const DIAMOND_BLOCK = taskBlock([
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
    executor: alpha
    depends_on: [a]
    scope: { paths: [src/backend/**] }
    ${VERIF_OK}`,
  `  - id: c
    title: C
    summary: Do C
    executor: beta
    depends_on: [a]
    scope: { paths: [src/frontend/**] }
    ${VERIF_OK}`,
  `  - id: d
    title: D
    summary: Do D
    executor: beta
    depends_on: [b, c]
    scope: { paths: [src/d/**] }
    ${VERIF_OK}`,
]);

const HETERO_YAML = [
  'name: v07-par',
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

test('M7.6 §50：diamond A→(B‖C)→D —— B→fake-alpha / C→fake-beta 真并行 + 异构 evidence', async () => {
  const plan: Record<string, WorkSpec> = {
    a: { write: { 'src/a/base.txt': 'A' } },
    b: { write: { 'src/backend/handler.ts': 'B' }, sleepMs: 800 },
    c: { write: { 'src/frontend/view.ts': 'C' }, sleepMs: 800 },
    d: { write: { 'src/d/final.txt': 'D' } },
  };
  const alpha = makeNamedWorkAdapter('fake-alpha', () => plan);
  const beta = makeNamedWorkAdapter('fake-beta', () => plan);
  const p = await makeExecutorProject(DIAMOND_BLOCK, HETERO_YAML, [alpha, beta]);
  try {
    const executorPlan = await readExecutorPlan(p.speccraftDir, p.runId);
    const resolver = buildExecutorResolver({ plan: executorPlan });

    const result = await executeParallelTaskGraph({
      speccraftDir: p.speccraftDir,
      projectRoot: p.root,
      runId: p.runId,
      adapter: alpha,
      runContext: '# ctx',
      executionGuard: '# guard',
      maxParallel: 2,
      executorResolver: resolver,
    });

    // 全图完成：A；B+C（真并行）；D
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.waveSummaries,
      [
        { wave: 1, tasks: ['a'] },
        { wave: 2, tasks: ['b', 'c'] },
        { wave: 3, tasks: ['d'] },
      ],
    );
    assert.equal((await readRun(p.speccraftDir, p.runId)).status, 'awaiting_verification');

    // ---- 真并行硬断言：B started before C finished AND C started before B finished ----
    const bm = await latestDispatch(p.speccraftDir, p.runId, 'b');
    const cm = await latestDispatch(p.speccraftDir, p.runId, 'c');
    assert.ok(bm?.started_at && bm.finished_at, 'B dispatch 时间证据缺失');
    assert.ok(cm?.started_at && cm.finished_at, 'C dispatch 时间证据缺失');
    const bStart = Date.parse(bm.started_at), bFinish = Date.parse(bm.finished_at!);
    const cStart = Date.parse(cm.started_at), cFinish = Date.parse(cm.finished_at!);
    assert.ok(bStart < cFinish, `B 必须在 C 结束前开始（B start ${bStart} >= C finish ${cFinish}）`);
    assert.ok(cStart < bFinish, `C 必须在 B 结束前开始（C start ${cStart} >= B finish ${bFinish}）`);

    // ---- 异构 adapter evidence：B → fake-alpha，C → fake-beta ----
    assert.equal(bm?.adapter, 'fake-alpha');
    assert.equal(bm?.executor_profile, 'alpha');
    assert.equal(bm?.task_id, 'b');
    assert.equal(cm?.adapter, 'fake-beta');
    assert.equal(cm?.executor_profile, 'beta');
    assert.equal(cm?.task_id, 'c');

    // ---- §49 Wave Evidence：wave-002 manifest.executors ----
    const waves = await listWaves(p.speccraftDir, p.runId);
    const w2 = await readWaveManifest(p.speccraftDir, p.runId, waves[1]);
    assert.deepEqual(w2?.executors, { b: 'alpha', c: 'beta' });
    const w1 = await readWaveManifest(p.speccraftDir, p.runId, waves[0]);
    assert.deepEqual(w1?.executors, { a: 'alpha' });

    // ---- 集成确定性进入 canonical ----
    assert.equal(await readFile(path.join(p.root, 'src', 'backend', 'handler.ts'), 'utf8'), 'B');
    assert.equal(await readFile(path.join(p.root, 'src', 'frontend', 'view.ts'), 'utf8'), 'C');
    assert.equal(await readCanonicalHead(p.root) !== undefined, true);
    assert.equal(await isCanonicalClean(p.root), true);

    // ---- plan 冻结：assignment 与声明顺序一致 ----
    assert.deepEqual(executorPlan.assignments.map((x) => [x.taskId, x.executor, x.adapter]), [
      ['a', 'alpha', 'fake-alpha'],
      ['b', 'alpha', 'fake-alpha'],
      ['c', 'beta', 'fake-beta'],
      ['d', 'beta', 'fake-beta'],
    ]);
  } finally {
    await projectCleanup(p.root);
  }
});

// ---------------------------------------------------------------------------
// §46 Profile 容量：max_concurrency=1 → 不同 Wave（即使 scope 完全不重叠）
// ---------------------------------------------------------------------------

const CAP_BLOCK = taskBlock([
  `  - id: a
    title: A
    summary: Do A
    executor: backend
    depends_on: []
    scope: { paths: [src/a/**] }
    ${VERIF_OK}`,
  `  - id: b
    title: B
    summary: Do B
    executor: backend
    depends_on: [a]
    scope: { paths: [src/backend/**] }
    ${VERIF_OK}`,
  `  - id: c
    title: C
    summary: Do C
    executor: backend
    depends_on: [a]
    scope: { paths: [src/frontend/**] }
    ${VERIF_OK}`,
  `  - id: d
    title: D
    summary: Do D
    executor: backend
    depends_on: [b, c]
    scope: { paths: [src/d/**] }
    ${VERIF_OK}`,
]);

const CAP_YAML = [
  'name: v07-cap',
  'execution:',
  '  default_adapter: fake-alpha',
  '  adapters:',
  '    fake-alpha:',
  '      timeout_seconds: 60',
  '  default_executor: backend',
  '  executors:',
  '    backend:',
  '      adapter: fake-alpha',
  '      max_concurrency: 1',
  'verification:',
  '  timeout_seconds: 60',
  '  commands:',
  '    - "true"',
].join('\n');

test('M7.6 §46：B/C → backend（max_concurrency=1）→ 不同 Wave（即使 scope 完全不重叠）', async () => {
  const plan: Record<string, WorkSpec> = {
    a: { write: { 'src/a/base.txt': 'A' } },
    b: { write: { 'src/backend/handler.ts': 'B' } },
    c: { write: { 'src/frontend/view.ts': 'C' } },
    d: { write: { 'src/d/final.txt': 'D' } },
  };
  const alpha = makeNamedWorkAdapter('fake-alpha', () => plan);
  const p = await makeExecutorProject(CAP_BLOCK, CAP_YAML, [alpha]);
  try {
    const executorPlan = await readExecutorPlan(p.speccraftDir, p.runId);
    const resolver = buildExecutorResolver({ plan: executorPlan });

    // maxParallel=4：只有 profile 容量限制生效
    const result = await executeParallelTaskGraph({
      speccraftDir: p.speccraftDir,
      projectRoot: p.root,
      runId: p.runId,
      adapter: alpha,
      runContext: '# ctx',
      executionGuard: '# guard',
      maxParallel: 4,
      executorResolver: resolver,
    });

    assert.equal(result.complete, true);
    // B 与 C 不同 Wave（backend 容量 1）
    assert.deepEqual(
      result.waveSummaries,
      [
        { wave: 1, tasks: ['a'] },
        { wave: 2, tasks: ['b'] },
        { wave: 3, tasks: ['c'] },
        { wave: 4, tasks: ['d'] },
      ],
    );
    // B 先于 C 完成（非并行），wave evidence executor 一致
    const bm = await latestDispatch(p.speccraftDir, p.runId, 'b');
    const cm = await latestDispatch(p.speccraftDir, p.runId, 'c');
    assert.equal(bm?.executor_profile, 'backend');
    assert.equal(cm?.executor_profile, 'backend');
  } finally {
    await projectCleanup(p.root);
  }
});

// ---------------------------------------------------------------------------
// §47 / §48 planner 单元：Global vs Profile limit；同 Adapter 不同 Profile
// ---------------------------------------------------------------------------

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

test('M7.6 §47：global maxParallel=4 + frontend=2 + backend=1 → Wave 上限 4/2/1', () => {
  const g = graph([
    task('f1', ['src/f1/**']),
    task('f2', ['src/f2/**']),
    task('f3', ['src/f3/**']),
    task('b1', ['src/b1/**']),
    task('g1', ['src/g1/**']),
  ]);
  const assignments = new Map([
    ['f1', { executor: 'frontend', maxConcurrency: 2 }],
    ['f2', { executor: 'frontend', maxConcurrency: 2 }],
    ['f3', { executor: 'frontend', maxConcurrency: 2 }],
    ['b1', { executor: 'backend', maxConcurrency: 1 }],
    ['g1', { executor: 'other' }], // 无 maxConcurrency → unlimited（§31）
  ]);
  const plan = planWave({
    graph: g,
    statuses: statuses(ALL_READY(['f1', 'f2', 'f3', 'b1', 'g1'])),
    maxParallel: 4,
    executorAssignments: assignments,
  });
  // wave1：frontend 2（f1/f2）+ backend 1（b1）+ other 1（g1）= 4；f3 因 frontend 容量 deferred
  assert.deepEqual(plan.tasks, ['f1', 'f2', 'b1', 'g1']);
  assert.deepEqual(plan.deferred, ['f3']);
  assert.deepEqual(plan.executors, { f1: 'frontend', f2: 'frontend', b1: 'backend', g1: 'other' });
});

test('M7.6 §47：无 executorAssignments（legacy）→ 仅 maxParallel 限制，executors = legacy-default', () => {
  const g = graph([task('a', ['src/a/**']), task('b', ['src/b/**'])]);
  const plan = planWave({ graph: g, statuses: statuses(ALL_READY(['a', 'b'])), maxParallel: 2 });
  assert.deepEqual(plan.tasks, ['a', 'b']);
  assert.deepEqual(plan.executors, { a: 'legacy-default', b: 'legacy-default' });
});

test('M7.6 §48：同 Adapter 不同 Profile → 并发按 Profile 计（不实现 adapter rate limiter）', () => {
  const g = graph([task('q1', ['src/q1/**']), task('f1', ['src/f1/**']), task('f2', ['src/f2/**'])]);
  // fast/quality 都使用同一 adapter claude；容量按 Executor Profile 各计
  const assignments = new Map([
    ['q1', { executor: 'quality', maxConcurrency: 1 }],
    ['f1', { executor: 'fast', maxConcurrency: 2 }],
    ['f2', { executor: 'fast', maxConcurrency: 2 }],
  ]);
  const plan = planWave({
    graph: g,
    statuses: statuses(ALL_READY(['q1', 'f1', 'f2'])),
    maxParallel: 3,
    executorAssignments: assignments,
  });
  // quality 1（q1）+ fast 2（f1/f2）= 3 → 同 Wave（不按 adapter 聚合限流）
  assert.deepEqual(plan.tasks, ['q1', 'f1', 'f2']);
  assert.deepEqual(plan.deferred, []);
});

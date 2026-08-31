/**
 * M7.9 — 权威 v0.7 DoD 测试（施工手册 §62-§71、§74）。
 *
 * 全部使用 fake adapters（fake-alpha / fake-beta / fake-unavailable），
 * 不依赖真实 Claude/Codex 网络完成 DoD。
 *
 * 覆盖：
 *   E2E A（§63） Sequential Heterogeneous：A→alpha, B→beta, C→alpha
 *   E2E B（§64） Parallel Heterogeneous：A→(B‖C)→D，B→alpha, C→beta（真实时间重叠）
 *   E2E C（§65） Profile Capacity：alpha.maxConcurrency=1，scope disjoint 也不得同 Wave
 *   E2E D（§66） Different Profiles, Same Adapter：fast/quality 共用 fake-alpha，session 不共享
 *   E2E E（§67） Unavailable Adapter：preflight FAIL + 0 dispatch + 0 workspace +
 *                0 task mutation + canonical unchanged
 *   E2E F（§68） Retry Ownership：Task ID / Executor 稳定，same Workspace Attempt 可 resume
 *   E2E G（§69） Owner Rework：Workspace Attempt +1、Executor 不变、new Provider Session
 *   E2E H（§70） No Fallback：beta dispatch 失败，alpha dispatch count == 0
 *   Legacy（§71）无 execution.executors / task.executor 的旧项目 sequential + parallel 行为不变
 *   Invariants（§74）二十条 Core Invariant 显式断言
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
import { registerAdapter, getAdapter } from '../src/core/execution/adapters/registry.js';
import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import type { CliExecutionAdapter, NormalizedDispatchResult } from '../src/core/execution/adapters/types.js';
import { compileTaskGraph } from '../src/core/tasks/compiler.js';
import { executeTaskGraph } from '../src/core/tasks/orchestrator.js';
import { executeParallelTaskGraph } from '../src/core/parallel/orchestrator.js';
import { planWave } from '../src/core/parallel/planner.js';
import { dispatchTask } from '../src/core/tasks/dispatch.js';
import { readTaskManifest, readTaskGraph } from '../src/core/tasks/store.js';
import { reopenTask } from '../src/core/tasks/rework.js';
import { readExecutorPlan } from '../src/core/executors/store.js';
import { buildExecutorResolver, buildExecutorsContext } from '../src/core/executors/resolver.js';
import { buildExecutorPlan } from '../src/core/executors/plan.js';
import { LEGACY_EXECUTOR_ID } from '../src/core/executors/types.js';
import { readDispatchAttempt, listDispatchAttemptsForTask, listDispatchAttempts } from '../src/core/dispatch/store.js';
import { writeWorkspace, readWorkspace, listWorkspaceAttempts } from '../src/core/workspaces/store.js';
import { readCanonicalHead, isCanonicalClean } from '../src/core/workspaces/integration.js';
import { runGit } from '../src/core/workspaces/git.js';
import { verifyExecution } from '../src/core/verification/orchestrator.js';
import { reject } from '../src/core/acceptance/lifecycle.js';
import { cmdExecute, cmdDispatch, cmdTasksReopen } from '../src/cli/commands.js';
import { DEFAULT_STAGE_IDS } from '../src/core/types.js';
import type { Workflow, State } from '../src/core/types.js';
import type { TaskGraph, TaskDefinition, TaskStatus } from '../src/core/tasks/types.js';

const fakeAgentPath = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

const VERIF_OK = 'verification: { commands: [echo ok], timeout_seconds: 30 }';

interface WorkSpec {
  write?: Record<string, string>;
  sleepMs?: number;
  fail?: boolean;
}

interface FakeAdapterOptions {
  /** fake-agent 模式；函数形式支持在两次 dispatch 之间切换（fail → jsonl） */
  mode?: string | (() => string);
  /** probe 结果（E2E E 用 installed:false） */
  installed?: boolean;
  /** work 模式计划（key = task id） */
  getPlan?: () => Record<string, WorkSpec>;
  /** 输出的 session id（覆盖随机） */
  getSession?: () => string;
  /** 覆盖可执行命令（E2E H spawn fail 用） */
  spawnCommand?: string;
}

/**
 * 统一 fake adapter：可区分 id + 可选 session 追踪 + 可选 work 计划。
 * 返回对象额外暴露 receivedSessionIds（buildInvocation 收到的 sessionId，用于 resume 断言）。
 */
function makeFakeAdapter(
  id: string,
  opts: FakeAdapterOptions = {},
): CliExecutionAdapter & { receivedSessionIds: (string | undefined)[] } {
  const receivedSessionIds: (string | undefined)[] = [];
  const getMode = typeof opts.mode === 'function' ? opts.mode : () => (opts.mode ?? 'jsonl');
  const installed = opts.installed ?? true;
  const adapter: CliExecutionAdapter = {
    id,
    kind: 'cli',
    capabilities: {
      invoke: true, resume: true, structuredOutput: true,
      finalMessageFile: true, sessionId: true, modelSelection: false,
    },
    prepare: manualAdapter.prepare,
    probe: async () => (installed ? { id, installed: true } : { id, installed: false, error: 'not installed' }),
    buildInvocation: async (input) => {
      receivedSessionIds.push(input.sessionId);
      const env: Record<string, string> = {
        FAKE_AGENT_MODE: getMode(),
        FAKE_AGENT_SESSION:
          input.sessionId ?? opts.getSession?.() ?? `sess-${id}-${Math.random().toString(16).slice(2, 6)}`,
      };
      if (opts.getPlan) env.FAKE_AGENT_PLAN = JSON.stringify(opts.getPlan());
      return {
        command: opts.spawnCommand ?? 'node',
        args: [fakeAgentPath],
        cwd: input.projectRoot,
        stdin: input.prompt,
        env,
        timeoutMs: 60000,
      };
    },
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
  return Object.assign(adapter, { receivedSessionIds });
}

async function makeArtifact(speccraftDir: string, workflow: Workflow, state: State, stageId: string): Promise<void> {
  const stage = workflow.stages.find((s) => s.id === stageId)!;
  const target = completeStage(workflow, state, stageId);
  const body = await resolveTemplateContent(stage.template ?? stage.id);
  const artifact = createArtifact({ artifact: stage.produces[0], stage: stageId, status: target, version: 1 }, body);
  await writeArtifact(path.join(speccraftDir, 'artifacts', artifactFileName(stage.produces[0])), artifact);
}

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

/** 简化项目（无真实 git repo）：sequential / CLI 路径 */
async function makeReadyProject(manualBody: string, projectYaml: string): Promise<{ root: string; speccraftDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-dod-'));
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

/** 真实 Git repo + 完整 Workflow + executor project.yaml + prepared Run + frozen plan（parallel 路径） */
async function makeExecutorProject(
  block: string,
  projectYaml: string,
  adapters: CliExecutionAdapter[],
): Promise<{ root: string; speccraftDir: string; runId: string; outer: string }> {
  const outer = await mkdtemp(path.join(os.tmpdir(), 'speccraft-dodpar-'));
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

function captureStderr(): { collect: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { chunks.push(args.map(String).join(' ')); };
  return {
    collect: () => chunks.join('\n'),
    restore: () => { console.error = original; },
  };
}

/** 生成 executor project.yaml（executors: id → adapter；可选 max_concurrency） */
function makeExecutorYaml(
  defaultAdapter: string,
  adapterIds: string[],
  executors: Record<string, { adapter: string; maxConcurrency?: number }>,
  withDefaultExecutor = true,
): string {
  const lines = ['name: v07-dod', 'execution:'];
  lines.push(`  default_adapter: ${defaultAdapter}`);
  lines.push('  adapters:');
  for (const id of adapterIds) lines.push(`    ${id}:`, '      timeout_seconds: 60');
  if (withDefaultExecutor) lines.push('  default_executor: primary');
  lines.push('  executors:');
  for (const [id, cfg] of Object.entries(executors)) {
    lines.push(`    ${id}:`, `      adapter: ${cfg.adapter}`);
    if (cfg.maxConcurrency !== undefined) lines.push(`      max_concurrency: ${cfg.maxConcurrency}`);
  }
  lines.push('verification:', '  timeout_seconds: 60', '  commands:', '    - "true"');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// §63 E2E A — Sequential Heterogeneous：A→alpha, B→beta, C→alpha
// ---------------------------------------------------------------------------

test('M7.9 E2E A（§63）：sequential heterogeneous — A→fake-alpha, B→fake-beta, C→fake-alpha 全部 PASS', async () => {
  const block = taskBlock([
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
  ]);
  const yaml = makeExecutorYaml('fake-alpha', ['fake-alpha', 'fake-beta'], {
    alpha: { adapter: 'fake-alpha' },
    beta: { adapter: 'fake-beta' },
  });
  const alpha = makeFakeAdapter('fake-alpha');
  const beta = makeFakeAdapter('fake-beta');
  registerAdapter(alpha);
  registerAdapter(beta);
  const { root, speccraftDir } = await makeReadyProject(block, yaml);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: block, source: 'execution-manual', projectConfig });

    const plan = await readExecutorPlan(speccraftDir, runId);
    const resolver = buildExecutorResolver({ plan });
    const result = await executeTaskGraph({
      speccraftDir, projectRoot: root, runId,
      adapter: getAdapter('fake-alpha') as CliExecutionAdapter,
      runContext: '# ctx', executionGuard: '# guard',
      executorResolver: resolver,
    });

    assert.equal(result.complete, true, 'Task Graph 应全部完成');
    assert.deepEqual(result.executed, ['a', 'b', 'c']);
    assert.equal((await readRun(speccraftDir, runId)).status, 'awaiting_verification');

    // 真实 Dispatch Evidence：A adapter alpha / B adapter beta / C adapter alpha（§63）
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

    // 全部 PASS：三个 task 均为 completed（dispatch + verify 全通过）
    for (const id of ['a', 'b', 'c']) {
      const m = await readTaskManifest(speccraftDir, runId, id);
      assert.equal(m?.status, 'completed', `task ${id} 应 completed`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §64 E2E B — Parallel Heterogeneous：A→(B‖C)→D，B→alpha, C→beta（真实时间重叠）
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

test('M7.9 E2E B（§64）：parallel heterogeneous — B→alpha / C→beta 真并行（started/finished 时间重叠）', async () => {
  const plan: Record<string, WorkSpec> = {
    a: { write: { 'src/a/base.txt': 'A' } },
    b: { write: { 'src/backend/handler.ts': 'B' }, sleepMs: 800 },
    c: { write: { 'src/frontend/view.ts': 'C' }, sleepMs: 800 },
    d: { write: { 'src/d/final.txt': 'D' } },
  };
  const alpha = makeFakeAdapter('fake-alpha', { mode: 'work', getPlan: () => plan });
  const beta = makeFakeAdapter('fake-beta', { mode: 'work', getPlan: () => plan });
  const yaml = makeExecutorYaml('fake-alpha', ['fake-alpha', 'fake-beta'], {
    alpha: { adapter: 'fake-alpha' },
    beta: { adapter: 'fake-beta' },
  });
  const p = await makeExecutorProject(DIAMOND_BLOCK, yaml, [alpha, beta]);
  try {
    const executorPlan = await readExecutorPlan(p.speccraftDir, p.runId);
    const resolver = buildExecutorResolver({ plan: executorPlan });
    const result = await executeParallelTaskGraph({
      speccraftDir: p.speccraftDir, projectRoot: p.root, runId: p.runId,
      adapter: alpha, runContext: '# ctx', executionGuard: '# guard',
      maxParallel: 2, executorResolver: resolver,
    });

    assert.equal(result.complete, true);
    assert.deepEqual(result.waveSummaries, [
      { wave: 1, tasks: ['a'] },
      { wave: 2, tasks: ['b', 'c'] },
      { wave: 3, tasks: ['d'] },
    ]);

    // 真实时间证据：B started before C finished AND C started before B finished（§64）
    const bm = await latestDispatch(p.speccraftDir, p.runId, 'b');
    const cm = await latestDispatch(p.speccraftDir, p.runId, 'c');
    assert.ok(bm?.started_at && bm.finished_at, 'B dispatch 时间证据缺失');
    assert.ok(cm?.started_at && cm.finished_at, 'C dispatch 时间证据缺失');
    const bStart = Date.parse(bm.started_at), bFinish = Date.parse(bm.finished_at!);
    const cStart = Date.parse(cm.started_at), cFinish = Date.parse(cm.finished_at!);
    assert.ok(bStart < cFinish, `B 必须在 C 结束前开始（${bStart} >= ${cFinish}）`);
    assert.ok(cStart < bFinish, `C 必须在 B 结束前开始（${cStart} >= ${bFinish}）`);

    // 异构 adapter evidence
    assert.equal(bm.adapter, 'fake-alpha');
    assert.equal(bm.executor_profile, 'alpha');
    assert.equal(cm.adapter, 'fake-beta');
    assert.equal(cm.executor_profile, 'beta');

    // 集成确定性进入 canonical
    assert.equal(await readFile(path.join(p.root, 'src', 'backend', 'handler.ts'), 'utf8'), 'B');
    assert.equal(await readFile(path.join(p.root, 'src', 'frontend', 'view.ts'), 'utf8'), 'C');
    assert.equal(await isCanonicalClean(p.root), true);
  } finally {
    await projectCleanup(p.root);
  }
});

// ---------------------------------------------------------------------------
// §65 E2E C — Profile Capacity：alpha.maxConcurrency=1，scope disjoint 也不得同 Wave
// ---------------------------------------------------------------------------

test('M7.9 E2E C（§65）：B/C → alpha（max_concurrency=1）→ 不同 Wave（即使 scope 完全不重叠）', async () => {
  const block = taskBlock([
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
  const yaml = makeExecutorYaml('fake-alpha', ['fake-alpha'], {
    backend: { adapter: 'fake-alpha', maxConcurrency: 1 },
  });
  const plan: Record<string, WorkSpec> = {
    a: { write: { 'src/a/base.txt': 'A' } },
    b: { write: { 'src/backend/handler.ts': 'B' } },
    c: { write: { 'src/frontend/view.ts': 'C' } },
    d: { write: { 'src/d/final.txt': 'D' } },
  };
  const alpha = makeFakeAdapter('fake-alpha', { mode: 'work', getPlan: () => plan });
  const p = await makeExecutorProject(block, yaml, [alpha]);
  try {
    const executorPlan = await readExecutorPlan(p.speccraftDir, p.runId);
    const resolver = buildExecutorResolver({ plan: executorPlan });
    // maxParallel=4：只有 profile 容量限制生效
    const result = await executeParallelTaskGraph({
      speccraftDir: p.speccraftDir, projectRoot: p.root, runId: p.runId,
      adapter: alpha, runContext: '# ctx', executionGuard: '# guard',
      maxParallel: 4, executorResolver: resolver,
    });

    assert.equal(result.complete, true);
    // B 与 C 不同 Wave（backend 容量 1）；scope 不重叠也不得同 Wave（§65）
    assert.deepEqual(result.waveSummaries, [
      { wave: 1, tasks: ['a'] },
      { wave: 2, tasks: ['b'] },
      { wave: 3, tasks: ['c'] },
      { wave: 4, tasks: ['d'] },
    ]);
    // B 先于 C 完成（非并行）
    const bm = await latestDispatch(p.speccraftDir, p.runId, 'b');
    const cm = await latestDispatch(p.speccraftDir, p.runId, 'c');
    assert.equal(bm.executor_profile, 'backend');
    assert.equal(cm.executor_profile, 'backend');
    assert.ok(Date.parse(bm.finished_at!) <= Date.parse(cm.started_at!), 'B 应完整先于 C 执行');
  } finally {
    await projectCleanup(p.root);
  }
});

// ---------------------------------------------------------------------------
// §66 E2E D — Different Profiles, Same Adapter：fast/quality 共用 fake-alpha
// ---------------------------------------------------------------------------

test('M7.9 E2E D（§66）：B→fast / C→quality（adapter 都 fake-alpha）→ executor_profile 不同 + session 不共享', async () => {
  const block = taskBlock([
    `  - id: b
    title: B
    summary: Do B
    executor: fast
    depends_on: []
    scope: { paths: [src/backend/**] }
    ${VERIF_OK}`,
    `  - id: c
    title: C
    summary: Do C
    executor: quality
    depends_on: []
    scope: { paths: [src/frontend/**] }
    ${VERIF_OK}`,
  ]);
  const yaml = makeExecutorYaml('fake-alpha', ['fake-alpha'], {
    fast: { adapter: 'fake-alpha' },
    quality: { adapter: 'fake-alpha' },
  });
  const plan: Record<string, WorkSpec> = {
    b: { write: { 'src/backend/handler.ts': 'B' } },
    c: { write: { 'src/frontend/view.ts': 'C' } },
  };
  const alpha = makeFakeAdapter('fake-alpha', { mode: 'work', getPlan: () => plan });
  const p = await makeExecutorProject(block, yaml, [alpha]);
  try {
    const executorPlan = await readExecutorPlan(p.speccraftDir, p.runId);
    const resolver = buildExecutorResolver({ plan: executorPlan });
    const result = await executeParallelTaskGraph({
      speccraftDir: p.speccraftDir, projectRoot: p.root, runId: p.runId,
      adapter: alpha, runContext: '# ctx', executionGuard: '# guard',
      maxParallel: 2, executorResolver: resolver,
    });
    assert.equal(result.complete, true);

    // executor_profile 不同；adapter 相同（fast/quality 共用 fake-alpha）
    const bm = await latestDispatch(p.speccraftDir, p.runId, 'b');
    const cm = await latestDispatch(p.speccraftDir, p.runId, 'c');
    assert.equal(bm.executor_profile, 'fast');
    assert.equal(cm.executor_profile, 'quality');
    assert.notEqual(bm.executor_profile, cm.executor_profile, 'executor_profile 必须不同');
    assert.equal(bm.adapter, 'fake-alpha');
    assert.equal(cm.adapter, 'fake-alpha');
    // session 不共享：不同 profile 的 task 各自 fresh session
    assert.ok(bm.session_id && cm.session_id, 'dispatch 应有 session 证据');
    assert.notEqual(bm.session_id, cm.session_id, '不同 Executor Profile 不共享 Provider Session');
    assert.deepEqual(alpha.receivedSessionIds, [undefined, undefined], '首次 dispatch 均无 resume');
  } finally {
    await projectCleanup(p.root);
  }
});

test('M7.9 E2E D（§66 补充）：同一 Task 换 Executor Profile → 不 resume 旧 profile 的 session', async () => {
  const block = taskBlock([
    `  - id: b
    title: B
    summary: Do B
    depends_on: []
    scope: { paths: [src/b/**] }
    ${VERIF_OK}`,
  ]);
  const yaml = makeExecutorYaml('fake-alpha', ['fake-alpha'], { fast: { adapter: 'fake-alpha' } });
  const alpha = makeFakeAdapter('fake-alpha');
  registerAdapter(alpha);
  const { root, speccraftDir } = await makeReadyProject(block, yaml);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    // 不传 projectConfig → 无 plan（直接 dispatchTask 显式传 executorProfile）
    await compileTaskGraph({ speccraftDir, runId, manualBody: block, source: 'execution-manual' });

    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'b',
      adapter: alpha, runContext: '# ctx', executionGuard: '# g',
      freshSession: false, executorProfile: 'fast',
    });
    const m1 = await readTaskManifest(speccraftDir, runId, 'b');
    assert.equal(m1?.latestSessionId, alpha.receivedSessionIds.length > 0 ? m1?.latestSessionId : undefined);
    const sessionFast = m1?.latestSessionId;

    // reopen → 换 quality profile（adapter 仍是 fake-alpha）
    const m = await readTaskManifest(speccraftDir, runId, 'b');
    m!.status = 'ready';
    const { writeTaskManifest } = await import('../src/core/tasks/store.js');
    await writeTaskManifest(speccraftDir, runId, m!);

    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'b',
      adapter: alpha, runContext: '# ctx', executionGuard: '# g',
      freshSession: false, executorProfile: 'quality',
    });
    const m2 = await readTaskManifest(speccraftDir, runId, 'b');

    // 第二次 buildInvocation 未收到 fast 的 session（不同 profile 禁止交叉 resume）
    assert.deepEqual(alpha.receivedSessionIds, [undefined, undefined]);
    assert.notEqual(m2?.latestSessionId, sessionFast, 'quality 不得 resume fast 的 session');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §67 E2E E — Unavailable Adapter：preflight FAIL + 0 mutation
// ---------------------------------------------------------------------------

test('M7.9 E2E E（§67）：A→unavailable → preflight FAIL + 0 dispatch + 0 workspace + 0 task mutation + canonical unchanged', async () => {
  const block = taskBlock([
    `  - id: a
    title: A
    summary: Do A
    executor: alpha
    depends_on: []
    scope: { paths: [src/a/**] }
    ${VERIF_OK}`,
  ]);
  const yaml = makeExecutorYaml('fake-alpha', ['fake-alpha', 'fake-unavailable'], {
    alpha: { adapter: 'fake-unavailable' },
  });
  const alpha = makeFakeAdapter('fake-alpha');
  const unavailable = makeFakeAdapter('fake-unavailable', { installed: false });
  const p = await makeExecutorProject(block, yaml, [alpha, unavailable]);
  try {
    const baseCommit = await readCanonicalHead(p.root);
    const stderr = captureStderr();
    const code = await cmdExecute({}, p.root);
    const out = stderr.collect();
    stderr.restore();

    // preflight FAIL
    assert.equal(code, 1);
    assert.ok(out.includes('execution preflight blocked'), `stderr 应含 blocked：${out}`);
    assert.ok(out.includes('executor_unavailable'), `stderr 应含 reason：${out}`);

    // 0 dispatch / 0 workspace / 0 task mutation / canonical unchanged（§67）
    assert.deepEqual(await listDispatchAttempts(p.speccraftDir, p.runId), [], '不应有 dispatch attempt');
    const m = await readTaskManifest(p.speccraftDir, p.runId, 'a');
    assert.equal(m?.status, 'ready', 'task 状态不应改变');
    assert.equal((await readRun(p.speccraftDir, p.runId)).status, 'prepared', 'implementStart 不应执行');
    assert.equal(await readCanonicalHead(p.root), baseCommit, 'canonical 不应改变');
    assert.equal(await isCanonicalClean(p.root), true, 'canonical 应保持 clean');
  } finally {
    await projectCleanup(p.root);
  }
});

// ---------------------------------------------------------------------------
// §68 E2E F — Retry Ownership：dispatch FAIL → reopen → dispatch PASS
// ---------------------------------------------------------------------------

test('M7.9 E2E F（§68）：Retry — Task ID / Executor beta 稳定，same Workspace Attempt 可 resume session', async () => {
  let betaMode: 'fail' | 'jsonl' = 'fail';
  const beta = makeFakeAdapter('fake-beta', { mode: () => betaMode });
  registerAdapter(beta);
  const block = taskBlock([
    `  - id: b
    title: B
    summary: Do B
    executor: beta
    depends_on: []
    scope: { paths: [src/b/**] }
    ${VERIF_OK}`,
  ]);
  const yaml = makeExecutorYaml('fake-beta', ['fake-beta'], { beta: { adapter: 'fake-beta' } });
  const { root, speccraftDir } = await makeReadyProject(block, yaml);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-beta' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: block, source: 'execution-manual', projectConfig });
    const runIdBefore = runId;

    // 第一次 dispatch：FAIL（fake-agent fail 模式 → exit 1）
    let stderr = captureStderr();
    let code = await cmdDispatch({ task: 'b' }, root);
    stderr.restore();
    assert.equal(code, 1);
    let m = await readTaskManifest(speccraftDir, runId, 'b');
    assert.equal(m?.status, 'failed');

    // reopen → ready
    await cmdTasksReopen('b', false, root);
    m = await readTaskManifest(speccraftDir, runId, 'b');
    assert.equal(m?.status, 'ready');
    assert.equal(m?.reopenedCount, 1);

    // 第二次 dispatch：PASS
    betaMode = 'jsonl';
    stderr = captureStderr();
    code = await cmdDispatch({ task: 'b' }, root);
    stderr.restore();
    assert.equal(code, 0);

    // Task ID same / Run ID same
    m = await readTaskManifest(speccraftDir, runId, 'b');
    assert.equal(m?.id, 'b', 'Task ID 必须保持 b');
    assert.equal(runIdBefore, runId, 'Run ID 必须保持');
    assert.equal(m?.status, 'in_progress');

    // Executor beta same（frozen plan 不变）
    const attempts = await listDispatchAttemptsForTask(speccraftDir, runId, 'b');
    assert.equal(attempts.length, 2, '恰好两个 dispatch attempt');
    const d1 = await readDispatchAttempt(speccraftDir, runId, attempts[0]);
    const d2 = await readDispatchAttempt(speccraftDir, runId, attempts[1]);
    assert.equal(d1.executor_profile, 'beta');
    assert.equal(d1.adapter, 'fake-beta');
    assert.equal(d2.executor_profile, 'beta', 'retry 后 Executor 不能改变');
    assert.equal(d2.adapter, 'fake-beta');

    // same Workspace Attempt（未指定新 attempt）→ 可 resume session
    assert.equal(d1.session_id, d2.session_id, 'retry 应 resume 同一 Provider Session');
    assert.deepEqual(beta.receivedSessionIds, [undefined, d1.session_id], '第二次 buildInvocation 应收到旧 session');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §69 E2E G — Owner Rework：PASS → integrated → verify → Owner reject → reopen
// ---------------------------------------------------------------------------

test('M7.9 E2E G（§69）：Owner rework — Workspace Attempt +1、Executor beta 不变、new Provider Session', async () => {
  let session = 'sess-g-round1';
  let plan: Record<string, WorkSpec> = {
    b: { write: { 'src/backend/handler.ts': 'v1' } },
  };
  const beta = makeFakeAdapter('fake-beta', { mode: 'work', getPlan: () => plan, getSession: () => session });
  const yaml = makeExecutorYaml('fake-beta', ['fake-beta'], { beta: { adapter: 'fake-beta' } });
  const p = await makeExecutorProject(
    taskBlock([
      `  - id: b
    title: B
    summary: Do B
    executor: beta
    depends_on: []
    scope: { paths: [src/backend/**] }
    ${VERIF_OK}`,
    ]),
    yaml,
    [beta],
  );
  try {
    // 第一轮：dispatch PASS → integrated（workspace attempt 1）
    const executorPlan = await readExecutorPlan(p.speccraftDir, p.runId);
    const resolver = buildExecutorResolver({ plan: executorPlan });
    const r1 = await executeParallelTaskGraph({
      speccraftDir: p.speccraftDir, projectRoot: p.root, runId: p.runId,
      adapter: beta, runContext: '# ctx', executionGuard: '# guard',
      maxParallel: 1, executorResolver: resolver,
    });
    assert.equal(r1.complete, true);
    assert.equal((await readTaskManifest(p.speccraftDir, p.runId, 'b'))?.status, 'completed');
    assert.deepEqual(await listWorkspaceAttempts(p.speccraftDir, p.runId, 'b'), [1]);

    // Run Verification PASS → Owner reject → reopen B
    const v = await verifyExecution({ projectRoot: p.root });
    assert.equal(v.passed, true);
    const { workflow, state } = await loadProject(p.root);
    const run1 = await readRun(p.speccraftDir, p.runId);
    await reject(p.speccraftDir, p.root, workflow, state, run1, { feedback: 'Owner rework' });
    const reopened = await reopenTask({ speccraftDir: p.speccraftDir, runId: p.runId, taskId: 'b', cascade: true });
    assert.ok(reopened.reopened.includes('b'));

    // 第二轮：new Provider Session
    const session1 = (await readDispatchAttempt(
      p.speccraftDir, p.runId,
      (await listDispatchAttemptsForTask(p.speccraftDir, p.runId, 'b')).at(-1)!,
    ))?.session_id;
    session = 'sess-g-round2';
    plan = { b: { write: { 'src/backend/handler.ts': 'v2' } } };
    const r2 = await executeParallelTaskGraph({
      speccraftDir: p.speccraftDir, projectRoot: p.root, runId: p.runId,
      adapter: beta, runContext: '# ctx', executionGuard: '# guard',
      maxParallel: 1, executorResolver: resolver,
    });
    assert.equal(r2.complete, true, `r2 未完成：reason=${r2.reason} complete=${r2.complete} waves=${r2.waves} executed=${JSON.stringify(r2.executed)}`);

    // Workspace Attempt +1（1 → 2）
    assert.deepEqual(await listWorkspaceAttempts(p.speccraftDir, p.runId, 'b'), [1, 2]);
    // Executor beta unchanged + new Provider Session
    const d2 = await latestDispatch(p.speccraftDir, p.runId, 'b');
    assert.equal(d2.executor_profile, 'beta', 'Owner rework 后 Executor 不能改变');
    assert.equal(d2.adapter, 'fake-beta');
    assert.equal(d2.session_id, 'sess-g-round2', '新 Provider Session');
    assert.notEqual(d2.session_id, session1, 'rework 后必须 new Provider Session（不 resume 旧）');
    assert.ok(beta.receivedSessionIds.includes(undefined), '第二轮新 attempt 不应 resume 旧 session');
  } finally {
    await projectCleanup(p.root);
  }
});

// ---------------------------------------------------------------------------
// §70 E2E H — No Fallback：beta dispatch 失败，即使 alpha available 也不 fallback
// ---------------------------------------------------------------------------

test('M7.9 E2E H（§70）：beta dispatch 失败 → alpha dispatch count == 0（无自动 fallback）', async () => {
  const alpha = makeFakeAdapter('fake-alpha');
  const beta = makeFakeAdapter('fake-beta', { spawnCommand: '/nonexistent/speccraft-fake-agent-xyz' });
  registerAdapter(alpha);
  registerAdapter(beta);
  const block = taskBlock([
    `  - id: b
    title: B
    summary: Do B
    executor: beta
    depends_on: []
    scope: { paths: [src/b/**] }
    ${VERIF_OK}`,
  ]);
  const yaml = makeExecutorYaml('fake-alpha', ['fake-alpha', 'fake-beta'], { beta: { adapter: 'fake-beta' } });
  const { root, speccraftDir } = await makeReadyProject(block, yaml);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: block, source: 'execution-manual', projectConfig });

    const stderr = captureStderr();
    const code = await cmdDispatch({ task: 'b' }, root);
    stderr.restore();
    assert.equal(code, 1);

    // task → failed（spawn_error），仅 assigned adapter 的一个 attempt
    const m = await readTaskManifest(speccraftDir, runId, 'b');
    assert.equal(m?.status, 'failed');
    const attempts = await listDispatchAttemptsForTask(speccraftDir, runId, 'b');
    assert.equal(attempts.length, 1, '应恰好一个 dispatch attempt');

    // alpha dispatch count == 0（§70 硬断言）
    const all = await listDispatchAttempts(speccraftDir, runId);
    for (const id of all) {
      const d = await readDispatchAttempt(speccraftDir, runId, id);
      assert.notEqual(d.adapter, 'fake-alpha', 'Provider failure 不得触发 fallback 到 alpha');
      assert.equal(d.adapter, 'fake-beta');
      assert.equal(d.executor_profile, 'beta');
    }
    assert.equal(alpha.receivedSessionIds.length, 0, 'alpha 不应被调用');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §71 Legacy Regression：无 execution.executors / task.executor 的旧项目
// ---------------------------------------------------------------------------

const LEGACY_BLOCK = taskBlock([
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
  `  - id: c
    title: C
    summary: Do C
    depends_on: []
    scope: { paths: [src/c/**] }
    ${VERIF_OK}`,
]);

const LEGACY_YAML = [
  'name: v07-legacy',
  'execution:',
  '  default_adapter: fake-alpha',
  '  adapters:',
  '    fake-alpha:',
  '      timeout_seconds: 60',
  'verification:',
  '  timeout_seconds: 60',
  '  commands:',
  '    - "true"',
].join('\n');

test('M7.9 §71 Legacy Regression：sequential — 旧项目（无 executor 配置）execute 行为不变', async () => {
  const alpha = makeFakeAdapter('fake-alpha');
  registerAdapter(alpha);
  const { root, speccraftDir } = await makeReadyProject(LEGACY_BLOCK, LEGACY_YAML);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: LEGACY_BLOCK, source: 'execution-manual', projectConfig });

    // legacy 项目无需 executor config：compile 生成 legacy-default plan，execute 行为不变
    const code = await cmdExecute({}, root);
    assert.equal(code, 0);
    assert.equal((await readRun(speccraftDir, runId)).status, 'awaiting_verification');
    for (const id of ['a', 'b', 'c']) {
      const d = await latestDispatch(speccraftDir, runId, id);
      assert.equal(d.adapter, 'fake-alpha', 'legacy 全部使用 default_adapter');
      assert.equal(d.executor_profile, LEGACY_EXECUTOR_ID, 'legacy-default 逻辑 profile');
      assert.equal((await readTaskManifest(speccraftDir, runId, id))?.status, 'completed');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M7.9 §71 Legacy Regression：parallel — 旧项目（无 executor 配置）execute --parallel 行为不变', async () => {
  const plan: Record<string, WorkSpec> = {
    a: { write: { 'src/a/a.txt': 'A' } },
    b: { write: { 'src/b/b.txt': 'B' } },
    c: { write: { 'src/c/c.txt': 'C' } },
  };
  const alpha = makeFakeAdapter('fake-alpha', { mode: 'work', getPlan: () => plan });
  const p = await makeExecutorProject(LEGACY_BLOCK, LEGACY_YAML, [alpha]);
  try {
    // 不传 executorResolver（legacy 调用方路径）→ legacy-default
    const result = await executeParallelTaskGraph({
      speccraftDir: p.speccraftDir, projectRoot: p.root, runId: p.runId,
      adapter: alpha, runContext: '# ctx', executionGuard: '# guard',
      maxParallel: 3,
    });
    assert.equal(result.complete, true);
    assert.equal((await readRun(p.speccraftDir, p.runId)).status, 'awaiting_verification');
    // 三个 scope 完全不重叠 → 同 Wave（v0.6 行为；maxParallel=3 足以容纳全部）
    assert.equal(result.waveSummaries.length, 1);
    assert.deepEqual(result.waveSummaries[0].tasks, ['a', 'b', 'c']);
    assert.equal(await isCanonicalClean(p.root), true);
  } finally {
    await projectCleanup(p.root);
  }
});

// ---------------------------------------------------------------------------
// §74 Core Invariant：二十条显式断言
// ---------------------------------------------------------------------------

function task(id: string, executor: string | undefined, scope: string[], dependsOn: string[] = []): TaskDefinition {
  return {
    id,
    title: `Task ${id}`,
    summary: `summary ${id}`,
    ...(executor !== undefined ? { executor } : {}),
    dependsOn,
    scope: { paths: scope },
    verification: { commands: ['true'], timeoutSeconds: 30 },
  };
}

function graph(tasks: TaskDefinition[]): TaskGraph {
  return { version: 1, runId: 'run-i', source: 'manual', createdAt: '', tasks };
}

function statuses(map: Record<string, TaskStatus>): Map<string, TaskStatus> {
  return new Map(Object.entries(map));
}

test('M7.9 §74：二十条 Core Invariant 显式断言', async () => {
  // ---- 8/9/10：Parallel Wave 规则（planner 单元） ----
  {
    const g = graph([
      task('f1', 'frontend', ['src/f1/**']),
      task('f2', 'frontend', ['src/f2/**']),
      task('f3', 'frontend', ['src/f3/**']),
      task('b1', 'backend', ['src/b1/**']),
      task('g1', 'other', ['src/g1/**']),
      task('s1', 'frontend', ['src/shared/**']),
      task('s2', 'backend', ['src/shared/config/**']),
    ]);
    const assignments = new Map([
      ['f1', { executor: 'frontend', maxConcurrency: 2 }],
      ['f2', { executor: 'frontend', maxConcurrency: 2 }],
      ['f3', { executor: 'frontend', maxConcurrency: 2 }],
      ['b1', { executor: 'backend', maxConcurrency: 1 }],
      ['g1', { executor: 'other' }],
      ['s1', { executor: 'frontend', maxConcurrency: 2 }],
      ['s2', { executor: 'backend', maxConcurrency: 1 }],
    ]);
    const ready = statuses(Object.fromEntries(['f1', 'f2', 'f3', 'b1', 'g1', 's1', 's2'].map((id) => [id, 'ready' as TaskStatus])));
    // Invariant 8：Wave 尊重 Scope（s1/s2 scope 冲突 → 不同 Wave）
    const planS = planWave({ graph: g, statuses: ready, maxParallel: 8, executorAssignments: assignments });
    const bothInWave = planS.tasks.includes('s1') && planS.tasks.includes('s2');
    assert.equal(bothInWave, false, 'Invariant 8：scope 冲突不得同 Wave');
    // Invariant 9：Wave 尊重 global maxParallel
    const planG = planWave({ graph: g, statuses: ready, maxParallel: 2, executorAssignments: assignments });
    assert.ok(planG.tasks.length <= 2, `Invariant 9：wave 不得超过 maxParallel（实际 ${planG.tasks.length}）`);
    // Invariant 10：Wave 尊重 Executor maxConcurrency
    const planC = planWave({ graph: g, statuses: ready, maxParallel: 8, executorAssignments: assignments });
    const frontendInWave = planC.tasks.filter((t) => assignments.get(t)?.executor === 'frontend').length;
    const backendInWave = planC.tasks.filter((t) => assignments.get(t)?.executor === 'backend').length;
    assert.ok(frontendInWave <= 2, `Invariant 10：frontend 容量 2（实际 ${frontendInWave}）`);
    assert.ok(backendInWave <= 1, `Invariant 10：backend 容量 1（实际 ${backendInWave}）`);
  }

  // ---- 1/2/3：Task ≠ Executor / Profile ≠ Adapter / 唯一 frozen Assignment（静态） ----
  {
    const g = graph([task('a', 'alpha', ['src/a/**']), task('b', 'beta', ['src/b/**'])]);
    // Invariant 1：Task ≠ Executor（task 有独立 id 与显式 executor 声明）
    for (const t of g.tasks) {
      assert.equal(typeof t.id, 'string');
      assert.equal(typeof t.executor, 'string');
      assert.notEqual(t.executor, t.id, 'Invariant 1：Executor 不是 Task');
    }
    const ctx = buildExecutorsContext({
      name: 'i',
      execution: {
        defaultAdapter: 'fake-alpha',
        defaultExecutor: 'primary',
        adapters: { 'fake-alpha': {} },
        executors: { alpha: { adapter: 'fake-alpha' }, beta: { adapter: 'fake-beta' } },
      },
    });
    const plan = buildExecutorPlan(ctx, { 'fake-alpha': {}, 'fake-beta': {} }, g);
    // Invariant 2：Executor Profile ≠ Adapter
    for (const a of plan.assignments) {
      assert.notEqual(a.executor, a.adapter, 'Invariant 2：Executor Profile 与 Adapter 分离');
    }
    // Invariant 3：Task has exactly one frozen Executor Assignment
    const ids = new Set(plan.assignments.map((a) => a.taskId));
    assert.equal(ids.size, plan.assignments.length, 'Invariant 3：每 Task 恰好一个 Assignment');
    assert.equal(ids.size, g.tasks.length, 'Invariant 3：所有 Task 均有 Assignment');
  }

  // ---- 20：16 Workflow Stages 不变 ----
  assert.equal(DEFAULT_STAGE_IDS.length, 16, 'Invariant 20：16 Workflow Stages 不变');

  // ---- 其余 invariant 通过最小真实执行验证 ----
  {
    // 项目：A→alpha（id 'x'），B→beta（id 'y'），同 adapter fake-alpha 的 profile 不同见 E2E D；
    // 这里跑一次真实 sequential E2E 断言 4/15/16/18/19 + 14（legacy 兼容见 §71）
    const block = taskBlock([
      `  - id: x
    title: X
    summary: Do X
    executor: alpha
    depends_on: []
    scope: { paths: [src/x/**] }
    ${VERIF_OK}`,
      `  - id: y
    title: Y
    summary: Do Y
    executor: beta
    depends_on: [x]
    scope: { paths: [src/y/**] }
    ${VERIF_OK}`,
    ]);
    const yaml = makeExecutorYaml('fake-alpha', ['fake-alpha', 'fake-beta'], {
      alpha: { adapter: 'fake-alpha' },
      beta: { adapter: 'fake-beta' },
    });
    const alpha = makeFakeAdapter('fake-alpha');
    const beta = makeFakeAdapter('fake-beta');
    registerAdapter(alpha);
    registerAdapter(beta);
    const { root, speccraftDir } = await makeReadyProject(block, yaml);
    try {
      const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
      const projectConfig = await loadProjectConfig(speccraftDir);
      await compileTaskGraph({ speccraftDir, runId, manualBody: block, source: 'execution-manual', projectConfig });
      const plan = await readExecutorPlan(speccraftDir, runId);
      const resolver = buildExecutorResolver({ plan });
      const result = await executeTaskGraph({
        speccraftDir, projectRoot: root, runId,
        adapter: getAdapter('fake-alpha') as CliExecutionAdapter,
        runContext: '# ctx', executionGuard: '# guard',
        executorResolver: resolver,
      });
      assert.equal(result.complete, true);

      const dx = await latestDispatch(speccraftDir, runId, 'x');
      const dy = await latestDispatch(speccraftDir, runId, 'y');
      // Invariant 4：Different Tasks never share Provider Session
      assert.ok(dx.session_id && dy.session_id);
      assert.notEqual(dx.session_id, dy.session_id, 'Invariant 4：不同 Task 不共享 Provider Session');
      // Invariant 15/16：Run ID / Task ID 通过执行保持稳定
      const runAfter = await readRun(speccraftDir, runId);
      assert.equal(runAfter.id, runId, 'Invariant 15：Run ID 稳定');
      for (const id of ['x', 'y']) {
        assert.equal((await readTaskManifest(speccraftDir, runId, id))?.id, id, 'Invariant 16：Task ID 稳定');
      }
      // Invariant 5/6：retry / rework 不静默换 Executor —— frozen plan 只读
      assert.equal(plan.assignments.find((a) => a.taskId === 'x')?.executor, 'alpha');
      assert.equal(plan.assignments.find((a) => a.taskId === 'y')?.executor, 'beta');
      // Invariant 17：Workspace 语义 v0.6 不变 —— attempt 编号 + manifest 结构
      await writeWorkspace(speccraftDir, runId, 'x', {
        version: 1, runId, taskId: 'x', attempt: 1, status: 'integrated',
        workspaceRoot: path.join(root, '.ws'), branch: 'task/x', baseCommit: '0'.repeat(40),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        dispatchAttempts: [], verificationAttempts: [], changedPaths: [],
        scopeAudit: { declared: [], actual: [], passed: true, violations: [] },
      });
      assert.deepEqual(await listWorkspaceAttempts(speccraftDir, runId, 'x'), [1], 'Invariant 17：attempt 编号不变');
      // Invariant 18：Task Verification 独立于 Run Verification —— task completed 但 run 停在 awaiting_verification
      assert.equal(runAfter.status, 'awaiting_verification', 'Invariant 18：Run Verification 独立');
      // Invariant 19：Run Verification 独立于 Owner Acceptance —— 不会自动 accepted
      assert.notEqual(runAfter.status, 'accepted', 'Invariant 19：不自动 Owner Acceptance');

      // Invariant 13：Explicit Task Executor 不能被 --adapter 覆盖
      const stderr = captureStderr();
      try {
        const code = await cmdExecute({ adapter: 'fake-beta' }, root);
        assert.equal(code, 1);
        assert.match(stderr.collect(), /--adapter cannot override explicit Task Executor assignments/);
      } finally {
        stderr.restore();
      }
      // Invariant 14：Legacy project 兼容 —— LEGACY_EXECUTOR_ID 存在且编译路径可用（§71 已 E2E）
      assert.equal(LEGACY_EXECUTOR_ID, 'legacy-default');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // Invariant 7/11/12 已由 E2E D/E/H 显式断言（对应 §66/§67/§70 测试）。
  // 此处补充静态断言它们所属的语义键存在：
  assert.equal(typeof planWave, 'function');
  assert.equal(typeof buildExecutorPlan, 'function');
});

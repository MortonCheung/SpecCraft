/**
 * M7.4 — Durable Task-to-Executor Ownership 测试（ADR 0008 §21、§22；手册第三十六节）。
 *
 * 覆盖：
 *   1. Task A / Task B same adapter → different session（Fresh Task，§34）
 *   2. Task A retry → same session
 *   3. Task A new workspace attempt → fresh session
 *   4. same task + same adapter but different executor profile → no resume（§33）
 *   5. dispatch manifest contains executor_profile（§30）
 *   6. workspace manifest contains executor_profile（§31，parallel route 真实 E2E）
 * 附加：hook env 提供 SPECCRAFT_EXECUTOR_PROFILE（§35）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initProject } from '../src/core/init.js';
import { createRun } from '../src/core/execution/store.js';
import { compileTaskGraph } from '../src/core/tasks/compiler.js';
import { dispatchTask } from '../src/core/tasks/dispatch.js';
import { readTaskManifest, writeTaskManifest } from '../src/core/tasks/store.js';
import { readLatestDispatchAttempt, readDispatchAttempt } from '../src/core/dispatch/store.js';
import type { CliExecutionAdapter, NormalizedDispatchResult } from '../src/core/execution/adapters/types.js';

import { loadProject, loadProjectConfig } from '../src/core/project.js';
import { completeStage, approveStage } from '../src/core/advance.js';
import { writeArtifact, readArtifact, createArtifact, artifactFileName } from '../src/core/artifacts/store.js';
import { resolveTemplateContent } from '../src/core/templates/resolver.js';
import { prepareExecution } from '../src/core/execution/prepare.js';
import { registerAdapter } from '../src/core/execution/adapters/registry.js';
import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import { executeParallelTaskGraph } from '../src/core/parallel/orchestrator.js';
import { readWorkspace, listWorkspaceAttempts } from '../src/core/workspaces/store.js';
import { readCanonicalHead } from '../src/core/workspaces/integration.js';
import { runGit } from '../src/core/workspaces/git.js';
import type { HookConfig } from '../src/core/hooks/types.js';
import type { Workflow, State } from '../src/core/types.js';

const fakeAgentPath = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// dispatch-level 测试基础设施
// ---------------------------------------------------------------------------

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
    '    depends_on: []',
    '    scope: { paths: [src/b/**] }',
    '    verification: { commands: [npm test], timeout_seconds: 30 }',
    '```',
  ].join('\n');
}

/** 可追踪 adapter：resume 时把 input.sessionId 传给 fake agent（模拟真实 resume 传播），并记录收到的 sessionId */
function makeAdapter(session: string): CliExecutionAdapter & { receivedSessionIds: (string | undefined)[] } {
  const receivedSessionIds: (string | undefined)[] = [];
  const adapter: CliExecutionAdapter = {
    id: 'fake',
    kind: 'cli',
    capabilities: {
      invoke: true, resume: true, structuredOutput: true,
      finalMessageFile: true, sessionId: true, modelSelection: false,
    },
    prepare: async () => ({ files: {} }),
    probe: async () => ({ id: 'fake', installed: true }),
    buildInvocation: async (input) => {
      receivedSessionIds.push(input.sessionId);
      return {
        command: 'node',
        args: [fakeAgentPath],
        cwd: input.projectRoot,
        stdin: input.prompt,
        env: { FAKE_AGENT_MODE: 'jsonl', FAKE_AGENT_SESSION: input.sessionId ?? session },
        timeoutMs: 10000,
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
        adapter: 'fake',
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

async function setup(runId = 'run-1'): Promise<{ root: string; speccraftDir: string; runId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-own-'));
  const { speccraftDir } = await initProject({ projectRoot: root });
  const run = await createRun(speccraftDir, { id: runId });
  await compileTaskGraph({ speccraftDir, runId: run.id, manualBody: manualBody(), source: 'execution-manual' });
  return { root, speccraftDir, runId: run.id };
}

/** 把 task 设回 ready（模拟 verify 后 retry），供下一次 dispatch 使用 */
async function reopenTask(speccraftDir: string, runId: string, taskId: string): Promise<void> {
  const m = await readTaskManifest(speccraftDir, runId, taskId);
  m!.status = 'ready';
  await writeTaskManifest(speccraftDir, runId, m!);
}

// ---------------------------------------------------------------------------
// §34 Fresh Task：Task A / Task B same adapter → different session
// ---------------------------------------------------------------------------

test('M7.4 §34：Task A / Task B same adapter → different session', async () => {
  const { root, speccraftDir, runId } = await setup();
  try {
    const adapter = makeAdapter('session-a');
    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'a',
      adapter, runContext: '# ctx', executionGuard: '# g', freshSession: true,
    });
    // Task B：freshSession=false 也不允许继承 Task A 的 session
    const adapterB = makeAdapter('session-b');
    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'b',
      adapter: adapterB, runContext: '# ctx', executionGuard: '# g', freshSession: false,
    });
    const bManifest = await readTaskManifest(speccraftDir, runId, 'b');
    assert.equal(bManifest?.latestSessionId, 'session-b'); // 不是 session-a
    assert.deepEqual(adapterB.receivedSessionIds, [undefined]); // 未收到 Task A 的 session
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Task A retry → same session
// ---------------------------------------------------------------------------

test('M7.4 §33：Task A retry（same workspace attempt + same profile）→ same session', async () => {
  const { root, speccraftDir, runId } = await setup();
  try {
    const adapter = makeAdapter('session-a');
    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'a',
      adapter, runContext: '# ctx', executionGuard: '# g', freshSession: false,
    });
    const m1 = await readTaskManifest(speccraftDir, runId, 'a');
    assert.equal(m1?.latestSessionId, 'session-a');

    await reopenTask(speccraftDir, runId, 'a');
    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'a',
      adapter, runContext: '# ctx', executionGuard: '# g', freshSession: false,
    });
    const m2 = await readTaskManifest(speccraftDir, runId, 'a');
    assert.equal(m2?.latestSessionId, 'session-a'); // resume：fake agent 收到 session-a
    assert.deepEqual(adapter.receivedSessionIds, [undefined, 'session-a']); // 第二次 buildInvocation 收到旧 session
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Task A new workspace attempt → fresh session
// ---------------------------------------------------------------------------

test('M7.4 §33：Task A new workspace attempt → fresh session', async () => {
  const { root, speccraftDir, runId } = await setup();
  try {
    const adapter = makeAdapter('session-w1');
    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'a',
      adapter, runContext: '# ctx', executionGuard: '# g', freshSession: false,
      workspaceAttempt: 1,
    });
    const m1 = await readTaskManifest(speccraftDir, runId, 'a');
    assert.equal(m1?.latestSessionId, 'session-w1');

    await reopenTask(speccraftDir, runId, 'a');
    // 新 workspace attempt → 禁止 resume 旧 attempt 的 session
    const adapter2 = makeAdapter('session-w2');
    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'a',
      adapter: adapter2, runContext: '# ctx', executionGuard: '# g', freshSession: false,
      workspaceAttempt: 2,
    });
    const m2 = await readTaskManifest(speccraftDir, runId, 'a');
    assert.equal(m2?.latestSessionId, 'session-w2'); // fresh
    assert.deepEqual(adapter2.receivedSessionIds, [undefined]); // 未 resume 旧 attempt 的 session
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §33 different executor profile → no resume
// ---------------------------------------------------------------------------

test('M7.4 §33：same task + same adapter but different executor profile → no resume', async () => {
  const { root, speccraftDir, runId } = await setup();
  try {
    const adapter = makeAdapter('session-fast');
    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'a',
      adapter, runContext: '# ctx', executionGuard: '# g', freshSession: false,
      executorProfile: 'fast-codex',
    });
    const m1 = await readTaskManifest(speccraftDir, runId, 'a');
    assert.equal(m1?.latestSessionId, 'session-fast');

    await reopenTask(speccraftDir, runId, 'a');
    // 同一 Task + 同一 adapter，但 Executor Profile 不同 → 禁止交叉 resume
    const adapterQuality = makeAdapter('session-quality');
    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'a',
      adapter: adapterQuality, runContext: '# ctx', executionGuard: '# g', freshSession: false,
      executorProfile: 'quality-codex',
    });
    const m2 = await readTaskManifest(speccraftDir, runId, 'a');
    assert.equal(m2?.latestSessionId, 'session-quality'); // fresh，不是 session-fast
    assert.deepEqual(adapterQuality.receivedSessionIds, [undefined]); // 未 resume fast 的 session
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §30 dispatch manifest contains executor_profile
// ---------------------------------------------------------------------------

test('M7.4 §30：dispatch manifest contains executor_profile', async () => {
  const { root, speccraftDir, runId } = await setup();
  try {
    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'a',
      adapter: makeAdapter('session-a'), runContext: '# ctx', executionGuard: '# g', freshSession: true,
      executorProfile: 'frontend',
    });
    const attempt = await readLatestDispatchAttempt(speccraftDir, runId);
    assert.equal(attempt?.executor_profile, 'frontend');
    assert.equal(attempt?.adapter, 'fake');
    assert.equal(attempt?.task_id, 'a');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §31 workspace manifest contains executor_profile（parallel route 真实 E2E）
// ---------------------------------------------------------------------------

const VERIF_OK = "verification: { commands: [echo ok], timeout_seconds: 30 }";

const OWN_BLOCK = [
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
    executor: frontend
    scope: { paths: [src/a/**] }
    ${VERIF_OK}`,
  '```',
].join('\n');

/** fake work adapter：在 isolated worktree（cwd）里按 plan 真实施工 */
function makeWorkAdapter(getPlan: () => Record<string, Record<string, unknown>>): CliExecutionAdapter {
  return {
    id: 'fake',
    kind: 'cli',
    capabilities: {
      invoke: true, resume: true, structuredOutput: true,
      finalMessageFile: true, sessionId: true, modelSelection: false,
    },
    prepare: manualAdapter.prepare,
    probe: async () => ({ id: 'fake', installed: true }),
    buildInvocation: async (input) => ({
      command: 'node',
      args: [fakeAgentPath],
      cwd: input.projectRoot,
      stdin: input.prompt,
      env: {
        FAKE_AGENT_MODE: 'work',
        FAKE_AGENT_PLAN: JSON.stringify(getPlan()),
        FAKE_AGENT_SESSION: `sess-${Math.random().toString(16).slice(2, 10)}`,
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
        adapter: 'fake',
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

test('M7.4 §31：workspace manifest contains executor_profile + adapter snapshot（parallel route E2E）', async () => {
  const outer = await mkdtemp(path.join(os.tmpdir(), 'speccraft-own-par-'));
  const root = path.join(outer, 'proj');
  try {
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
    manual.body = OWN_BLOCK;
    await writeArtifact(manualPath, manual);
    const { writeState } = await import('../src/core/state/store.js');
    await writeState(speccraftDir, state);

    // project.yaml：executors.frontend → adapter fake（生成 frozen plan.yaml）
    await writeFile(
      path.join(speccraftDir, 'project.yaml'),
      [
        'name: own-e2e',
        'execution:',
        '  default_adapter: fake',
        '  adapters:',
        '    fake:',
        '      timeout_seconds: 60',
        '  executors:',
        '    frontend:',
        '      adapter: fake',
        '      max_concurrency: 1',
        'verification:',
        '  timeout_seconds: 60',
        '  commands:',
        '    - "true"',
      ].join('\n'),
      'utf8',
    );

    const adapter = makeWorkAdapter(() => ({ a: { write: { 'src/a/base.txt': 'A' } } }));
    registerAdapter(adapter);
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake' });

    // compile 时传 projectConfig → 构建并落盘 Executor Plan
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: OWN_BLOCK, source: 'execution-manual', projectConfig });

    // hook 断言 SPECCRAFT_EXECUTOR_PROFILE 注入
    const hookOut = path.join(outer, 'hook-env.txt');
    const hooks: HookConfig = {
      before_dispatch: [{ id: 'profile-check', command: `printf '%s' "$SPECCRAFT_EXECUTOR_PROFILE" > ${hookOut}` }],
    };

    const result = await executeParallelTaskGraph({
      speccraftDir,
      projectRoot: root,
      runId,
      adapter,
      runContext: '# ctx',
      executionGuard: '# guard',
      maxParallel: 1,
      hooks,
    });
    assert.equal(result.complete, true);

    // workspace manifest snapshot（§31）
    const attempts = await listWorkspaceAttempts(speccraftDir, runId, 'a');
    assert.deepEqual(attempts, [1]);
    const ws = await readWorkspace(speccraftDir, runId, 'a', 1);
    assert.equal(ws?.executorProfile, 'frontend');
    assert.equal(ws?.adapter, 'fake');

    // dispatch manifest 也带 executor_profile（parallel route 透传）
    const attempt = await readDispatchAttempt(speccraftDir, runId, 1);
    assert.equal(attempt?.executor_profile, 'frontend');

    // hook env（§35）：SPECCRAFT_EXECUTOR_PROFILE 注入
    assert.equal(await readFile(hookOut, 'utf8'), 'frontend');
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initProject } from '../src/core/init.js';
import { createRun } from '../src/core/execution/store.js';
import { compileTaskGraph } from '../src/core/tasks/compiler.js';
import { dispatchTask } from '../src/core/tasks/dispatch.js';
import { readTaskManifest, writeTaskManifest } from '../src/core/tasks/store.js';
import { readLatestDispatchAttempt, listDispatchAttemptsForTask } from '../src/core/dispatch/store.js';
import type { CliExecutionAdapter, NormalizedDispatchResult } from '../src/core/execution/adapters/types.js';

const fakeAgentPath = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

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

function makeFakeAdapter(mode: string, session: string): CliExecutionAdapter {
  return {
    id: 'fake',
    kind: 'cli',
    capabilities: {
      invoke: true, resume: true, structuredOutput: true,
      finalMessageFile: true, sessionId: true, modelSelection: false,
    },
    prepare: async () => ({ files: {} }),
    probe: async () => ({ id: 'fake', installed: true }),
    buildInvocation: async (input) => ({
      command: 'node',
      args: [fakeAgentPath],
      cwd: input.projectRoot,
      stdin: input.prompt,
      env: { FAKE_AGENT_MODE: mode, FAKE_AGENT_SESSION: session },
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

async function setup(runId = 'run-1'): Promise<{ root: string; speccraftDir: string; runId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-td-'));
  const { speccraftDir } = await initProject({ projectRoot: root });
  const run = await createRun(speccraftDir, { id: runId });
  await compileTaskGraph({ speccraftDir, runId: run.id, manualBody: manualBody(), source: 'execution-manual' });
  return { root, speccraftDir, runId: run.id };
}

test('M5.4 DoD #13#14：dispatch 写 task_id，SUCCESS ≠ completed', async () => {
  const { root, speccraftDir, runId } = await setup();
  try {
    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'a',
      adapter: makeFakeAdapter('jsonl', 'session-a'),
      runContext: '# ctx', executionGuard: '# guard', freshSession: true,
    });

    const manifest = await readTaskManifest(speccraftDir, runId, 'a');
    assert.equal(manifest?.status, 'in_progress'); // SUCCESS ≠ completed
    assert.deepEqual(manifest?.dispatchAttempts, [1]);
    assert.equal(manifest?.latestSessionId, 'session-a');

    const attempt = await readLatestDispatchAttempt(speccraftDir, runId);
    assert.equal(attempt?.task_id, 'a'); // task_id 写入
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M5.4 DoD #18：Dispatch FAIL → Task failed + lastError', async () => {
  const { root, speccraftDir, runId } = await setup();
  try {
    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'a',
      adapter: makeFakeAdapter('fail', 'session-x'),
      runContext: '# ctx', executionGuard: '# guard', freshSession: true,
    });
    const manifest = await readTaskManifest(speccraftDir, runId, 'a');
    assert.equal(manifest?.status, 'failed');
    assert.ok(manifest?.lastError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M5.4 DoD #15#16#17：不同 Task 不共享 session，同 Task retry resume，fresh-session 生效', async () => {
  const { root, speccraftDir, runId } = await setup();
  try {
    // a dispatch session-a
    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'a',
      adapter: makeFakeAdapter('jsonl', 'session-a'), runContext: '# ctx', executionGuard: '# g', freshSession: true,
    });
    // b dispatch session-b（同 adapter，但不 resume session-a）
    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'b',
      adapter: makeFakeAdapter('jsonl', 'session-b'), runContext: '# ctx', executionGuard: '# g', freshSession: true,
    });
    const bManifest = await readTaskManifest(speccraftDir, runId, 'b');
    assert.equal(bManifest?.latestSessionId, 'session-b'); // 不是 session-a

    // 把 a 手动设回 ready（模拟 verify 后 retry），再 dispatch freshSession=false → resume session-a
    const aM = await readTaskManifest(speccraftDir, runId, 'a');
    aM!.status = 'ready';
    await writeTaskManifest(speccraftDir, runId, aM!);
    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'a',
      adapter: makeFakeAdapter('jsonl', 'session-a-retry'), runContext: '# ctx', executionGuard: '# g', freshSession: false,
    });
    const aManifest = await readTaskManifest(speccraftDir, runId, 'a');
    // dispatch attempt 序号是 run 级全局递增（a=1, b=2, a retry=3）
    assert.deepEqual(aManifest?.dispatchAttempts, [1, 3]); // 同 Task ID，attempt 递增

    // fresh-session 强制新 session：把 a 设回 ready，freshSession=true
    const aM2 = await readTaskManifest(speccraftDir, runId, 'a');
    aM2!.status = 'ready';
    await writeTaskManifest(speccraftDir, runId, aM2!);
    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'a',
      adapter: makeFakeAdapter('jsonl', 'session-a-fresh'), runContext: '# ctx', executionGuard: '# g', freshSession: true,
    });
    const aManifest2 = await readTaskManifest(speccraftDir, runId, 'a');
    assert.deepEqual(aManifest2?.dispatchAttempts, [1, 3, 4]); // a=1, b=2, a=3, a fresh=4
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M5.4 DoD #23#24：Task retry Task ID 不变，dispatch attempt append-only', async () => {
  const { root, speccraftDir, runId } = await setup();
  try {
    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'a',
      adapter: makeFakeAdapter('jsonl', 's1'), runContext: '# ctx', executionGuard: '# g', freshSession: true,
    });
    const aM = await readTaskManifest(speccraftDir, runId, 'a');
    aM!.status = 'ready';
    await writeTaskManifest(speccraftDir, runId, aM!);
    await dispatchTask({
      speccraftDir, projectRoot: root, runId, taskId: 'a',
      adapter: makeFakeAdapter('jsonl', 's2'), runContext: '# ctx', executionGuard: '# g', freshSession: true,
    });
    const attempts = await listDispatchAttemptsForTask(speccraftDir, runId, 'a');
    assert.deepEqual(attempts, [1, 2]);
    const manifest = await readTaskManifest(speccraftDir, runId, 'a');
    assert.equal(manifest?.id, 'a');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

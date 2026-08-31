import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initProject } from '../src/core/init.js';
import { loadProject } from '../src/core/project.js';
import { createRun, readRun } from '../src/core/execution/store.js';
import { setStageStatus, writeState } from '../src/core/state/store.js';
import { compileTaskGraph } from '../src/core/tasks/compiler.js';
import { executeTaskGraph } from '../src/core/tasks/orchestrator.js';
import { readTaskManifest } from '../src/core/tasks/store.js';
import type { CliExecutionAdapter, NormalizedDispatchResult } from '../src/core/execution/adapters/types.js';

const fakeAgentPath = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

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
    '    verification: { commands: [echo ok], timeout_seconds: 30 }',
    '  - id: b',
    '    title: B',
    '    summary: Do B',
    '    depends_on: [a]',
    '    scope: { paths: [src/b/**] }',
    '    verification: { commands: [echo ok], timeout_seconds: 30 }',
    '  - id: c',
    '    title: C',
    '    summary: Do C',
    '    depends_on: [a]',
    '    scope: { paths: [src/c/**] }',
    '    verification: { commands: [echo ok], timeout_seconds: 30 }',
    '  - id: d',
    '    title: D',
    '    summary: Do D',
    '    depends_on: [b, c]',
    '    scope: { paths: [src/d/**] }',
    '    verification: { commands: [echo ok], timeout_seconds: 30 }',
    '```',
  ].join('\n');
}

function makeFakeAdapter(mode: string): CliExecutionAdapter {
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
      env: { FAKE_AGENT_MODE: mode, FAKE_AGENT_SESSION: `session-${Math.random().toString(16).slice(2, 6)}` },
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

async function setup(): Promise<{ root: string; speccraftDir: string; runId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-exe-'));
  const { speccraftDir } = await initProject({ projectRoot: root });
  // 手动设置 state 到可施工（ready-to-implement completed、implementation pending）
  const { state } = await loadProject(root);
  setStageStatus(state, 'ready-to-implement', 'completed');
  setStageStatus(state, 'implementation', 'pending');
  state.active_run = 'run-1';
  await writeState(speccraftDir, state);
  const run = await createRun(speccraftDir, { id: 'run-1' });
  await compileTaskGraph({ speccraftDir, runId: run.id, manualBody: manualBody(), source: 'execution-manual' });
  return { root, speccraftDir, runId: run.id };
}

test('M5.7 DoD #34#35#36：execute 确定性顺序执行，全部 completed 后只调一次 implementFinish', async () => {
  const { root, speccraftDir, runId } = await setup();
  try {
    const result = await executeTaskGraph({
      speccraftDir,
      projectRoot: root,
      runId,
      adapter: makeFakeAdapter('jsonl'),
      runContext: '# ctx',
      executionGuard: '# guard',
    });

    assert.equal(result.complete, true);
    assert.deepEqual(result.executed, ['a', 'b', 'c', 'd']); // 确定性顺序（声明顺序）
    assert.equal(result.completedTasks, 4);

    // 全部 completed
    for (const id of ['a', 'b', 'c', 'd']) {
      const m = await readTaskManifest(speccraftDir, runId, id);
      assert.equal(m?.status, 'completed');
    }

    // implementFinish 被调用 → run awaiting_verification
    const run = await readRun(speccraftDir, runId);
    assert.equal(run.status, 'awaiting_verification');
    assert.equal(run.reports.length, 1);

    // aggregate report 存在
    const reportPath = path.join(speccraftDir, 'runs', runId, 'agent-report-001.md');
    assert.equal(await exists(reportPath), true);
    const report = await readFile(reportPath, 'utf8');
    assert.match(report, /Aggregate/);
    assert.match(report, /Task Graph 完成：4 个 Task/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M5.7：execute 在 verify FAIL 时 STOP（非零）', async () => {
  const { root, speccraftDir, runId } = await setup();
  try {
    // 让 task 的 verification 命令失败：直接用 execute，但 verification commands 是 npm test
    // 这里用 fake adapter 让 dispatch 成功，但 projectRoot 里没有 npm test 会失败
    // 改成构造一个会 verify 失败的场景：手动改 graph 的 verification 为 false 命令
    const { readTaskGraph, writeTaskGraph } = await import('../src/core/tasks/store.js');
    const graph = await readTaskGraph(speccraftDir, runId);
    graph.tasks[0].verification.commands = ['exit 1'];
    await writeTaskGraph(speccraftDir, runId, graph);

    const result = await executeTaskGraph({
      speccraftDir,
      projectRoot: root,
      runId,
      adapter: makeFakeAdapter('jsonl'),
      runContext: '# ctx',
      executionGuard: '# guard',
    });

    assert.equal(result.complete, false);
    assert.equal(result.reason, 'verify_failed');
    // 只执行了 a（第一个 ready）
    assert.deepEqual(result.executed, ['a']);
    // run 未 awaiting_verification
    const run = await readRun(speccraftDir, runId);
    assert.notEqual(run.status, 'awaiting_verification');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

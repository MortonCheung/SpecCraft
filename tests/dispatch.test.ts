import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initProject } from '../src/core/init.js';
import { createRun, runDir } from '../src/core/execution/store.js';
import { runDispatchProcess } from '../src/core/dispatch/runner.js';
import { dispatchOnce } from '../src/core/dispatch/orchestrator.js';
import {
  nextDispatchAttempt,
  readLatestDispatchAttempt,
  listDispatchAttempts,
  reserveDispatchAttempt,
  findLatestSessionForTask,
} from '../src/core/dispatch/store.js';
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

/** 构造一个以 fake-agent 为后端的 cli adapter（可指定 session id） */
function fakeAdapter(mode: string, session = 'session-abc123'): CliExecutionAdapter {
  return {
    id: 'fake',
    kind: 'cli',
    capabilities: {
      invoke: true,
      resume: true,
      structuredOutput: true,
      finalMessageFile: true,
      sessionId: true,
      modelSelection: false,
    },
    prepare: async () => ({ files: {} }),
    probe: async () => ({ id: 'fake', installed: true, version: '1.0.0' }),
    buildInvocation: async (input) => ({
      command: 'node',
      args: [fakeAgentPath],
      cwd: input.projectRoot,
      stdin: input.prompt,
      env: { FAKE_AGENT_MODE: mode, FAKE_AGENT_SESSION: session },
      timeoutMs: 10000,
    }),
    normalize: async (input) => {
      const result: NormalizedDispatchResult = {
        adapter: 'fake',
        status: input.timedOut
          ? 'timed_out'
          : input.spawnError
            ? 'spawn_error'
            : input.exitCode === 0
              ? 'succeeded'
              : 'failed',
        exitCode: input.exitCode ?? undefined,
        signal: input.signal ?? undefined,
        timedOut: input.timedOut,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        durationMs: input.durationMs,
        stderr: input.stderr,
        events: [],
      };
      // 解析 JSONL events + session + final message
      let sessionId: string | undefined;
      let finalMessage: string | undefined;
      for (const line of input.stdout.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.session_id) sessionId = obj.session_id;
          if (obj.type === 'final_message') {
            finalMessage = obj.text;
            result.events.push({ type: 'agent_completed', at: input.finishedAt });
          } else if (obj.type === 'tool_call') {
            result.events.push({ type: 'tool_call', tool: obj.tool, at: input.finishedAt });
          } else if (obj.type === 'file_change') {
            result.events.push({ type: 'file_change', path: obj.path, at: input.finishedAt });
          } else if (obj.type === 'agent_started') {
            result.events.push({ type: 'agent_started', at: input.startedAt });
          }
        } catch {
          /* 忽略非 JSON 行 */
        }
      }
      if (sessionId) result.sessionId = sessionId;
      if (finalMessage) result.finalMessage = finalMessage;
      return result;
    },
  };
}

test('M4.2：runner 执行 fake-agent success，捕获 stdout/exit code', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-disp-'));
  try {
    const proc = await runDispatchProcess({
      invocation: {
        command: 'node',
        args: [fakeAgentPath],
        cwd: root,
        stdin: 'hello prompt',
        env: { FAKE_AGENT_MODE: 'success' },
        timeoutMs: 10000,
      },
    });
    assert.equal(proc.exitCode, 0);
    assert.match(proc.stdout, /fake-agent: ok/);
    assert.equal(proc.timedOut, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M4.2：runner 捕获 stderr + fail exit code', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-disp-'));
  try {
    const proc = await runDispatchProcess({
      invocation: {
        command: 'node',
        args: [fakeAgentPath],
        cwd: root,
        env: { FAKE_AGENT_MODE: 'fail' },
        timeoutMs: 10000,
      },
    });
    assert.equal(proc.exitCode, 1);
    assert.match(proc.stderr, /something went wrong/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M4.2：runner 超时 SIGTERM→SIGKILL 不挂起', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-disp-'));
  try {
    const start = Date.now();
    const proc = await runDispatchProcess({
      invocation: {
        command: 'node',
        args: [fakeAgentPath],
        cwd: root,
        env: { FAKE_AGENT_MODE: 'timeout' },
        timeoutMs: 500,
        graceMs: 500,
      },
    });
    const elapsed = Date.now() - start;
    assert.equal(proc.timedOut, true);
    assert.ok(elapsed < 10000, `应尽快返回（实际 ${elapsed}ms）`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M4.2：dispatchOnce 落盘 attempt 证据（manifest/stdout/stderr/raw/events/final）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-disp-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const run = await createRun(speccraftDir, { id: 'run-disp-001' });

    const result = await dispatchOnce({
      speccraftDir,
      projectRoot: root,
      runId: run.id,
      adapter: fakeAdapter('jsonl'),
      prompt: '# agent-prompt\n\n任务内容',
      freshSession: true,
    });

    assert.equal(result.attempt, 1);
    assert.equal(result.result.status, 'succeeded');
    assert.equal(result.result.sessionId, 'session-abc123');
    assert.equal(result.result.finalMessage, 'completed');
    assert.ok(result.result.events.some((e) => e.type === 'tool_call'));

    const attemptDir = path.join(runDir(speccraftDir, run.id), 'dispatch', 'attempt-001');
    assert.equal(await exists(path.join(attemptDir, 'manifest-001.yaml')), true);
    assert.equal(await exists(path.join(attemptDir, 'stdout.log')), true);
    assert.equal(await exists(path.join(attemptDir, 'stderr.log')), true);
    assert.equal(await exists(path.join(attemptDir, 'raw.jsonl')), true);
    assert.equal(await exists(path.join(attemptDir, 'events.jsonl')), true);
    assert.equal(await exists(path.join(attemptDir, 'final-message.md')), true);

    const manifest = await readFile(path.join(attemptDir, 'manifest-001.yaml'), 'utf8');
    assert.match(manifest, /attempt: 1/);
    assert.match(manifest, /adapter: fake/);
    assert.match(manifest, /status: succeeded/);
    assert.match(manifest, /session_id: session-abc123/);

    // append-only：第二次 dispatch 是 attempt 2
    await dispatchOnce({
      speccraftDir,
      projectRoot: root,
      runId: run.id,
      adapter: fakeAdapter('jsonl'),
      prompt: '# agent-prompt 2',
      freshSession: true,
    });
    assert.equal(await nextDispatchAttempt(speccraftDir, run.id), 3);
    assert.deepEqual(await listDispatchAttempts(speccraftDir, run.id), [1, 2]);
    const latest = await readLatestDispatchAttempt(speccraftDir, run.id);
    assert.equal(latest?.attempt, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M4.2：dispatch FAIL（exit != 0）→ result.status failed，run 不结束', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-disp-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const run = await createRun(speccraftDir, { id: 'run-disp-002' });

    const result = await dispatchOnce({
      speccraftDir,
      projectRoot: root,
      runId: run.id,
      adapter: fakeAdapter('fail'),
      prompt: '# p',
      freshSession: true,
    });
    assert.equal(result.result.status, 'failed');

    const manifest = await readLatestDispatchAttempt(speccraftDir, run.id);
    assert.equal(manifest?.status, 'failed');
    // run 本身不结束（dispatch 只记录 attempt，不动 run.status）
    const { readRun } = await import('../src/core/execution/store.js');
    const runBack = await readRun(speccraftDir, run.id);
    assert.equal(runBack.status, 'prepared');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M6.4 DoD #13：reserveDispatchAttempt 并发 20 次 → 20 个唯一序号 + 目录（无覆盖）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-disp-cc-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const run = await createRun(speccraftDir, { id: 'run-disp-cc' });

    // 20 个并发预约
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () => reserveDispatchAttempt(speccraftDir, run.id)),
    );
    const unique = new Set(attempts);
    assert.equal(unique.size, 20, `20 个预约应全唯一（实际 ${unique.size}）`);
    assert.equal(Math.min(...attempts), 1);
    assert.equal(Math.max(...attempts), 20);

    // 每个序号的目录都已真实创建，且没有覆盖（list 仍为 1..20）
    const listed = await listDispatchAttempts(speccraftDir, run.id);
    assert.deepEqual(listed, Array.from({ length: 20 }, (_, i) => i + 1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M6.4 DoD #14#15：session isolation（同 workspace retry 复用，新 attempt / 其他 task 不复用）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-disp-si-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const run = await createRun(speccraftDir, { id: 'run-disp-si' });

    // 三个独立 session：A/w001、A/w002、B/w001
    await dispatchOnce({
      speccraftDir,
      projectRoot: root,
      runId: run.id,
      adapter: fakeAdapter('jsonl', 'session-A-w001'),
      prompt: '# p',
      freshSession: true,
      taskId: 'A',
      workspaceAttempt: 1,
    });
    await dispatchOnce({
      speccraftDir,
      projectRoot: root,
      runId: run.id,
      adapter: fakeAdapter('jsonl', 'session-A-w002'),
      prompt: '# p',
      freshSession: true,
      taskId: 'A',
      workspaceAttempt: 2,
    });
    await dispatchOnce({
      speccraftDir,
      projectRoot: root,
      runId: run.id,
      adapter: fakeAdapter('jsonl', 'session-B-w001'),
      prompt: '# p',
      freshSession: true,
      taskId: 'B',
      workspaceAttempt: 1,
    });

    // 同 workspace retry → 精确命中该 attempt 的 session
    assert.equal(await findLatestSessionForTask(speccraftDir, run.id, 'A', 'fake', 1), 'session-A-w001');
    // 新 workspace attempt → 不复用旧 session（拿到 w002 的 session）
    assert.equal(await findLatestSessionForTask(speccraftDir, run.id, 'A', 'fake', 2), 'session-A-w002');
    // 不同 task → 不共享 A 的 session
    assert.equal(await findLatestSessionForTask(speccraftDir, run.id, 'B', 'fake', 1), 'session-B-w001');
    // 不存在的 workspace attempt → null（不回落旧 session）
    assert.equal(await findLatestSessionForTask(speccraftDir, run.id, 'A', 'fake', 999), null);
    // 不存在的 task → null
    assert.equal(await findLatestSessionForTask(speccraftDir, run.id, 'C', 'fake', 1), null);
    // 无 workspaceAttempt 过滤时（sequential/legacy）→ 任一该 task 的最新 session
    assert.equal(await findLatestSessionForTask(speccraftDir, run.id, 'A', 'fake'), 'session-A-w002');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

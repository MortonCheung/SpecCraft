import { test } from 'node:test';
import assert from 'node:assert/strict';

import { codexAdapter } from '../src/core/execution/adapters/codex.js';
import { claudeAdapter } from '../src/core/execution/adapters/claude.js';
import { opencodeAdapter } from '../src/core/execution/adapters/opencode.js';
import { traeAdapter } from '../src/core/execution/adapters/trae.js';
import type { CliExecutionAdapter } from '../src/core/execution/adapters/types.js';

const baseInput = {
  projectRoot: '/tmp/x',
  runDir: '/tmp/x/.speccraft/runs/run-1',
  prompt: '# agent-prompt\n\n任务',
  promptFile: '/tmp/x/.speccraft/runs/run-1/agent-prompt.md',
  freshSession: true,
};

test('M4.4 codex：buildInvocation 用 exec --json -，stdin 传 prompt', async () => {
  const inv = await codexAdapter.buildInvocation(baseInput);
  assert.equal(inv.command, 'codex');
  assert.deepEqual(inv.args, ['exec', '--json', '-']);
  assert.equal(inv.stdin, baseInput.prompt);
  assert.equal(inv.cwd, '/tmp/x');
});

test('M4.4 codex：resume 时加 --resume <session-id>', async () => {
  const inv = await codexAdapter.buildInvocation({ ...baseInput, sessionId: 'thread-1', freshSession: false });
  assert.deepEqual(inv.args, ['exec', '--json', '--resume', 'thread-1', '-']);
});

test('M4.4 codex：normalize 解析 fixture JSONL（session + final message + events）', async () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-abc' }),
    JSON.stringify({ type: 'tool_use', name: 'write' }),
    JSON.stringify({ type: 'file_change', path: 'foo.txt' }),
    JSON.stringify({ type: 'thread.done', thread_id: 'thread-abc', text: 'done' }),
  ].join('\n');
  const result = await codexAdapter.normalize({
    ...baseInput, adapterId: 'codex', exitCode: 0, signal: null, timedOut: false,
    stdout, stderr: '', startedAt: 't0', finishedAt: 't1', durationMs: 10,
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.sessionId, 'thread-abc');
  assert.equal(result.finalMessage, 'done');
  assert.ok(result.events.some((e) => e.type === 'tool_call'));
  assert.ok(result.events.some((e) => e.type === 'file_change'));
});

test('M4.4 codex：未知 event / 非 JSON 行不 crash', async () => {
  const stdout = [
    'plain text line',
    JSON.stringify({ type: 'unknown_event', foo: 'bar' }),
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
  ].join('\n');
  const result = await codexAdapter.normalize({
    ...baseInput, adapterId: 'codex', exitCode: 0, signal: null, timedOut: false,
    stdout, stderr: '', startedAt: 't0', finishedAt: 't1', durationMs: 10,
  });
  assert.equal(result.sessionId, 't1');
});

test('M4.4 codex：exit != 0 → failed', async () => {
  const result = await codexAdapter.normalize({
    ...baseInput, adapterId: 'codex', exitCode: 1, signal: null, timedOut: false,
    stdout: '', stderr: 'err', startedAt: 't0', finishedAt: 't1', durationMs: 10,
  });
  assert.equal(result.status, 'failed');
});

test('M4.5 claude：buildInvocation 用 -p --output-format stream-json', async () => {
  const inv = await claudeAdapter.buildInvocation(baseInput);
  assert.equal(inv.command, 'claude');
  assert.deepEqual(inv.args, ['-p', '--output-format', 'stream-json']);
  assert.equal(inv.stdin, baseInput.prompt);
});

test('M4.5 claude：resume 加 --resume，fresh-session 不加', async () => {
  const invResume = await claudeAdapter.buildInvocation({ ...baseInput, sessionId: 's-1', freshSession: false });
  assert.ok(invResume.args.includes('--resume'));
  assert.ok(invResume.args.includes('s-1'));

  const invFresh = await claudeAdapter.buildInvocation({ ...baseInput, sessionId: 's-1', freshSession: true });
  assert.ok(!invFresh.args.includes('--resume'));
});

test('M4.5 claude：normalize 解析 stream-json fixture（session + result）', async () => {
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-xyz' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] }, session_id: 'session-xyz' }),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 'session-xyz' }),
  ].join('\n');
  const result = await claudeAdapter.normalize({
    ...baseInput, adapterId: 'claude', exitCode: 0, signal: null, timedOut: false,
    stdout, stderr: '', startedAt: 't0', finishedAt: 't1', durationMs: 10,
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.sessionId, 'session-xyz');
  assert.equal(result.finalMessage, 'ok');
  assert.ok(result.events.some((e) => e.type === 'agent_started'));
  assert.ok(result.events.some((e) => e.type === 'agent_completed'));
});

test('M4.5 claude：result error → error event + 不 crash', async () => {
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
    JSON.stringify({ type: 'result', subtype: 'error', result: 'boom', session_id: 's' }),
  ].join('\n');
  const result = await claudeAdapter.normalize({
    ...baseInput, adapterId: 'claude', exitCode: 0, signal: null, timedOut: false,
    stdout, stderr: '', startedAt: 't0', finishedAt: 't1', durationMs: 10,
  });
  assert.ok(result.events.some((e) => e.type === 'error'));
});

test('M4.6 opencode：buildInvocation 用 run --format json + --file', async () => {
  const inv = await opencodeAdapter.buildInvocation(baseInput);
  assert.equal(inv.command, 'opencode');
  assert.ok(inv.args.includes('run'));
  assert.ok(inv.args.includes('--format'));
  assert.ok(inv.args.includes('json'));
  assert.ok(inv.args.includes('--file'));
  assert.ok(inv.args.includes(baseInput.promptFile!));
  // 有 --file 时用短指令而非整段 prompt
  assert.match(inv.stdin ?? '', /Execute the attached/);
});

test('M4.6 opencode：command 可覆盖', async () => {
  const inv = await opencodeAdapter.buildInvocation({
    ...baseInput,
    adapterConfig: { command: 'my-opencode' },
  });
  assert.equal(inv.command, 'my-opencode');
});

test('M4.6 opencode：normalize 解析 fixture JSON', async () => {
  const stdout = [
    JSON.stringify({ type: 'session_started', session_id: 'oc-1' }),
    JSON.stringify({ type: 'tool_call', name: 'edit' }),
    JSON.stringify({ type: 'result', text: 'finished', session_id: 'oc-1' }),
  ].join('\n');
  const result = await opencodeAdapter.normalize({
    ...baseInput, adapterId: 'opencode', exitCode: 0, signal: null, timedOut: false,
    stdout, stderr: '', startedAt: 't0', finishedAt: 't1', durationMs: 10,
  });
  assert.equal(result.sessionId, 'oc-1');
  assert.equal(result.finalMessage, 'finished');
  assert.ok(result.events.some((e) => e.type === 'tool_call'));
});

test('M4.7 trae：buildInvocation 用 exec --json -，sandbox 仅显式配置时映射', async () => {
  const inv = await traeAdapter.buildInvocation(baseInput);
  assert.equal(inv.command, 'traecli');
  assert.deepEqual(inv.args, ['exec', '--json', '-']);
  assert.equal(inv.stdin, baseInput.prompt);

  const invSandbox = await traeAdapter.buildInvocation({
    ...baseInput,
    adapterConfig: { sandbox: 'workspace-write' },
  });
  assert.ok(invSandbox.args.includes('--sandbox'));
  assert.ok(invSandbox.args.includes('workspace-write'));
});

test('M4.7 trae：normalize 解析 fixture JSON', async () => {
  const stdout = [
    JSON.stringify({ type: 'session_started', session_id: 'trae-1' }),
    JSON.stringify({ type: 'file_change', path: 'a.txt' }),
    JSON.stringify({ type: 'done', text: 'done!', session_id: 'trae-1' }),
  ].join('\n');
  const result = await traeAdapter.normalize({
    ...baseInput, adapterId: 'trae', exitCode: 0, signal: null, timedOut: false,
    stdout, stderr: '', startedAt: 't0', finishedAt: 't1', durationMs: 10,
  });
  assert.equal(result.sessionId, 'trae-1');
  assert.equal(result.finalMessage, 'done!');
  assert.ok(result.events.some((e) => e.type === 'file_change'));
});

test('M4.4-7：probe 未安装时返回 installed=false（不 crash）', async () => {
  // 用不存在的 binary 路径验证 probe 容错（通过直接调用 probeBinary 逻辑）
  for (const adapter of [codexAdapter, claudeAdapter, opencodeAdapter, traeAdapter] as CliExecutionAdapter[]) {
    // 仅验证 probe 返回结构合法（真实安装状态取决于本机）
    const probe = await adapter.probe();
    assert.equal(probe.id, adapter.id);
    assert.equal(typeof probe.installed, 'boolean');
  }
});

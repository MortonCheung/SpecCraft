import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  registerAdapter,
  getAdapter,
  listAdapterIds,
  listAdapters,
  hasAdapter,
  isValidAdapterId,
} from '../src/core/execution/adapters/registry.js';
import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import { probeBinary, resolveCommand, resolveTimeoutSeconds } from '../src/core/execution/adapters/cli-helpers.js';
import { parseProjectConfig } from '../src/core/project.js';
import type { CliExecutionAdapter } from '../src/core/execution/adapters/types.js';

function fakeCliAdapter(id: string, caps: Partial<CliExecutionAdapter['capabilities']> = {}): CliExecutionAdapter {
  return {
    id,
    kind: 'cli',
    capabilities: {
      invoke: true,
      resume: true,
      structuredOutput: true,
      finalMessageFile: true,
      sessionId: true,
      modelSelection: true,
      ...caps,
    },
    prepare: async () => ({ files: {} }),
    probe: async () => ({ id, installed: false }),
    buildInvocation: async () => ({ command: 'x', args: [], cwd: '/', timeoutMs: 1000 }),
    normalize: async () => ({
      adapter: id, status: 'succeeded', timedOut: false, durationMs: 0, events: [],
    }),
  };
}

test('M4.1：registry 显式注册 + 确定性 lookup', () => {
  // registry 模块加载时已内置注册 5 个 adapter（manual/codex/claude/opencode/trae）
  assert.equal(getAdapter('manual')?.id, 'manual');
  assert.equal(hasAdapter('manual'), true);
  assert.equal(hasAdapter('codex'), true);
  assert.equal(getAdapter('codex')?.kind, 'cli');

  registerAdapter(fakeCliAdapter('codex')); // 覆盖注册
  assert.equal(getAdapter('codex')?.kind, 'cli');
  assert.ok(listAdapterIds().includes('manual'));
  assert.ok(listAdapterIds().includes('codex'));
});

test('M4.1：unknown adapter 返回 undefined', () => {
  assert.equal(getAdapter('no-such-adapter'), undefined);
  assert.equal(hasAdapter('no-such-adapter'), false);
});

test('M4.1：isValidAdapterId 校验', () => {
  assert.equal(isValidAdapterId('codex'), true);
  assert.equal(isValidAdapterId('claude-code'), true);
  assert.equal(isValidAdapterId('trae_2'), true);
  assert.equal(isValidAdapterId('bad id'), false);
  assert.equal(isValidAdapterId('-bad'), false);
  assert.equal(isValidAdapterId('UPPER'), false);
});

test('M4.1：probeBinary 已安装 / 未安装', async () => {
  // node 一定存在
  const node = await probeBinary('node');
  assert.equal(node.installed, true);
  assert.ok(node.version);

  // 一个几乎不可能存在的 binary
  const nope = await probeBinary('speccraft-definitely-not-exists-xyz');
  assert.equal(nope.installed, false);
});

test('M4.1：resolveCommand / resolveTimeoutSeconds', () => {
  assert.equal(resolveCommand(undefined, 'codex'), 'codex');
  assert.equal(resolveCommand('', 'codex'), 'codex');
  assert.equal(resolveCommand('  mycodex  ', 'codex'), 'mycodex');
  assert.equal(resolveTimeoutSeconds(undefined, 3600), 3600);
  assert.equal(resolveTimeoutSeconds(0, 3600), 3600);
  assert.equal(resolveTimeoutSeconds(120, 3600), 120);
});

test('M4.1：parseProjectConfig 解析 execution 配置', () => {
  const config = parseProjectConfig(
    [
      'name: x',
      'execution:',
      '  default_adapter: codex',
      '  adapters:',
      '    codex:',
      '      command: codex',
      '      timeout_seconds: 7200',
      '      extra_args: [--model, gpt-5]',
      '    claude:',
      '      command: claude',
    ].join('\n'),
  );
  assert.equal(config.execution?.defaultAdapter, 'codex');
  assert.equal(config.execution?.adapters.codex?.command, 'codex');
  assert.equal(config.execution?.adapters.codex?.timeout_seconds, 7200);
  assert.deepEqual(config.execution?.adapters.codex?.extra_args, ['--model', 'gpt-5']);
  assert.equal(config.execution?.adapters.claude?.command, 'claude');
});

test('M4.1：parseProjectConfig 兼容旧 project.yaml（无 execution）', () => {
  const config = parseProjectConfig('name: old\n');
  assert.equal(config.execution, undefined);
});

test('M4.1：listAdapters 返回全部注册项', () => {
  registerAdapter(manualAdapter);
  const all = listAdapters();
  assert.ok(all.some((a) => a.id === 'manual'));
});

/**
 * M7.1 — Executor Profile Config 测试（ADR 0008 §7、§9、§10）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseExecutorsSection, mergeAdapterConfig } from '../src/core/executors/config.js';
import {
  buildExecutorsContext,
  resolveProfile,
  resolveMergedAdapterConfig,
  isValidExecutorId,
} from '../src/core/executors/resolver.js';
import { LEGACY_EXECUTOR_ID } from '../src/core/executors/types.js';
import { parseProjectConfig } from '../src/core/project.js';

test('M7.1：parseExecutorsSection 解析 default_executor + executors（snake_case）', () => {
  const section = parseExecutorsSection({
    default_adapter: 'claude',
    adapters: {},
    default_executor: 'primary',
    executors: {
      primary: { adapter: 'claude', max_concurrency: 2 },
      frontend: { adapter: 'codex', model: 'some-model', max_concurrency: 1 },
      backend: { adapter: 'claude', timeout_seconds: 1200 },
    },
  });

  assert.equal(section?.defaultExecutor, 'primary');
  assert.deepEqual(section?.executors.primary, { adapter: 'claude', maxConcurrency: 2 });
  assert.deepEqual(section?.executors.frontend, { adapter: 'codex', model: 'some-model', maxConcurrency: 1 });
  assert.deepEqual(section?.executors.backend, { adapter: 'claude', timeoutSeconds: 1200 });
});

test('M7.1：parseExecutorsSection 也接受 camelCase 字段', () => {
  const section = parseExecutorsSection({
    default_executor: 'fast',
    executors: {
      fast: { adapter: 'codex', timeoutSeconds: 60, extraArgs: ['--a'], maxConcurrency: 3 },
    },
  });

  assert.deepEqual(section?.executors.fast, {
    adapter: 'codex',
    timeoutSeconds: 60,
    extraArgs: ['--a'],
    maxConcurrency: 3,
  });
});

test('M7.1：parseExecutorsSection 缺少 adapter 时报错', () => {
  assert.throws(
    () => parseExecutorsSection({ executors: { broken: { max_concurrency: 1 } } }),
    /adapter 必须是非空字符串/,
  );
});

test('M7.1：buildExecutorsContext 无 executors 配置 → legacy-default', () => {
  const ctx = buildExecutorsContext({
    name: 'x',
    execution: { defaultAdapter: 'codex', adapters: {}, executors: {} },
  });

  assert.equal(ctx.defaultExecutor, LEGACY_EXECUTOR_ID);
  assert.equal(ctx.legacyAdapter, 'codex');
  assert.deepEqual(ctx.executors, {});
});

test('M7.1：buildExecutorsContext 有 default_executor 时使用之', () => {
  const ctx = buildExecutorsContext({
    name: 'x',
    execution: {
      defaultAdapter: 'claude',
      adapters: {},
      defaultExecutor: 'primary',
      executors: { primary: { adapter: 'claude' } },
    },
  });

  assert.equal(ctx.defaultExecutor, 'primary');
});

test('M7.1：resolveProfile legacy-default 返回 legacy adapter 逻辑 profile', () => {
  const ctx = buildExecutorsContext({
    name: 'x',
    execution: { defaultAdapter: 'trae', adapters: {}, executors: {} },
  });

  const p = resolveProfile(ctx, LEGACY_EXECUTOR_ID);
  assert.deepEqual(p, { adapter: 'trae' });
});

test('M7.1：resolveProfile 未知 id → null', () => {
  const ctx = buildExecutorsContext({
    name: 'x',
    execution: { defaultAdapter: 'claude', adapters: {}, executors: { primary: { adapter: 'claude' } } },
  });

  assert.equal(resolveProfile(ctx, 'frontend'), null);
  assert.ok(resolveProfile(ctx, 'primary'));
});

test('M7.1：resolveMergedAdapterConfig —— Profile override 覆盖 Adapter config', () => {
  const merged = resolveMergedAdapterConfig(
    { adapter: 'claude', timeoutSeconds: 1800, model: 'p-model' },
    { timeout_seconds: 900, model: 'a-model', command: 'claude', extra_args: ['-a'] },
  );

  assert.equal(merged.timeout_seconds, 1800); // profile 覆盖
  assert.equal(merged.model, 'p-model'); // profile 覆盖
  assert.equal(merged.command, 'claude'); // 保留 adapter config
  assert.deepEqual(merged.extra_args, ['-a']); // 保留 adapter config
});

test('M7.1：mergeAdapterConfig 无 profile 时原样返回 adapter config', () => {
  const merged = mergeAdapterConfig(undefined, { timeout_seconds: 60 });
  assert.deepEqual(merged, { timeout_seconds: 60 });
});

test('M7.1：isValidExecutorId 只校验格式（auto 语义拒绝在 M7.2 assignment 层）', () => {
  assert.equal(isValidExecutorId('Auto'), false); // 大写非法
  assert.equal(isValidExecutorId('a b'), false); // 空格非法
  assert.equal(isValidExecutorId('frontend'), true);
  assert.equal(isValidExecutorId('fast-codex'), true);
  assert.equal(isValidExecutorId('primary'), true);
});

test('M7.1：parseProjectConfig 端到端解析 execution.executors', () => {
  const config = parseProjectConfig(`
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
    frontend:
      adapter: codex
      max_concurrency: 1
`);

  assert.equal(config.execution?.defaultAdapter, 'claude');
  assert.equal(config.execution?.defaultExecutor, 'primary');
  assert.deepEqual(config.execution?.executors.primary, { adapter: 'claude', maxConcurrency: 2 });
  assert.deepEqual(config.execution?.executors.frontend, { adapter: 'codex', maxConcurrency: 1 });
  assert.deepEqual(config.execution?.adapters.claude, { timeout_seconds: 900 });
});

test('M7.1：legacy project.yaml（无 executors）仍可解析', () => {
  const config = parseProjectConfig(`
name: legacy
execution:
  default_adapter: codex
`);

  assert.equal(config.execution?.defaultAdapter, 'codex');
  assert.deepEqual(config.execution?.executors, {});
  assert.equal(config.execution?.defaultExecutor, undefined);
});

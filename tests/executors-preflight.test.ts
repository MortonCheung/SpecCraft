/**
 * M7.3 — Executor Preflight & Diagnostics 测试（ADR 0008 §22-§28）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { createRun } from '../src/core/execution/store.js';
import { parseProjectConfig } from '../src/core/project.js';
import { compileTaskGraph } from '../src/core/tasks/compiler.js';
import { preflightExecutorPlan, formatPreflightBlocked } from '../src/core/executors/preflight.js';
import { collectExecutorDiagnostics, diagnosticsPass } from '../src/core/executors/diagnostics.js';
import { cmdExecutorsList, cmdExecutorsPlan, cmdExecutorsDoctor } from '../src/cli/commands.js';
import { readState, writeState } from '../src/core/state/store.js';
import type { ExecutionAdapter } from '../src/core/execution/adapters/types.js';
import type { ExecutorAssignment, ExecutorPlan } from '../src/core/executors/types.js';

function cliAdapter(
  id: string,
  opts: { installed?: boolean; modelSelection?: boolean; error?: string } = {},
): ExecutionAdapter & { probeCalls: number } {
  const a = {
    id,
    kind: 'cli',
    capabilities: {
      invoke: true,
      resume: true,
      structuredOutput: true,
      finalMessageFile: true,
      sessionId: true,
      modelSelection: opts.modelSelection ?? true,
    },
    probeCalls: 0,
    probe: async () => {
      a.probeCalls += 1;
      return {
        id,
        installed: opts.installed ?? true,
        binary: id,
        version: '1.0.0',
        ...(opts.error ? { error: opts.error } : {}),
      };
    },
    prepare: async () => ({ files: {} }),
    buildInvocation: async () => ({ command: id, args: [], cwd: '', timeoutMs: 1000 }),
    normalize: async () => ({
      adapter: id,
      status: 'succeeded',
      timedOut: false,
      durationMs: 0,
      events: [],
    }),
  } as unknown as ExecutionAdapter & { probeCalls: number };
  return a;
}

const MANUAL_ADAPTER = {
  id: 'manual',
  kind: 'manual',
  prepare: async () => ({ files: {} }),
} as unknown as ExecutionAdapter;

function planWith(assignments: Array<Partial<ExecutorAssignment>>): ExecutorPlan {
  return {
    version: 1,
    runId: 'run-1',
    createdAt: '2026-08-31T00:00:00Z',
    defaultExecutor: 'legacy-default',
    assignments: assignments.map((a, i) => ({
      taskId: `t${i}`,
      executor: 'primary',
      adapter: 'codex',
      source: 'default',
      resolved: {},
      ...a,
    })),
  };
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

test('M7.3：preflight PASS（全部 adapter 可用）', async () => {
  const resolve = (id: string) => (id === 'codex' ? cliAdapter('codex') : undefined);
  const result = await preflightExecutorPlan(
    planWith([{ adapter: 'codex' }, { adapter: 'codex' }]),
    resolve,
  );
  assert.equal(result.status, 'pass');
  assert.equal(result.items.every((i) => i.status === 'pass'), true);
});

test('M7.3：probe 去重 —— 同一 adapter 只 probe 一次', async () => {
  const codex = cliAdapter('codex');
  const resolve = () => codex;
  await preflightExecutorPlan(
    planWith([{ adapter: 'codex' }, { adapter: 'codex' }, { adapter: 'codex' }]),
    resolve,
  );
  assert.equal(codex.probeCalls, 1);
});

test('M7.3：executor_unavailable —— adapter 未安装', async () => {
  const resolve = () => cliAdapter('codex', { installed: false, error: 'binary not found' });
  const result = await preflightExecutorPlan(planWith([{ adapter: 'codex' }]), resolve);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'executor_unavailable');
  assert.equal(result.items[0].status, 'blocked');
  assert.match(result.items[0].message ?? '', /未安装/);
});

test('M7.3：executor_unavailable —— adapter 未注册', async () => {
  const result = await preflightExecutorPlan(planWith([{ adapter: 'nope' }]), () => undefined);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'executor_unavailable');
});

test('M7.3：capability_mismatch —— 指定 model 但 adapter 不支持 modelSelection', async () => {
  const resolve = () => cliAdapter('codex', { modelSelection: false });
  const result = await preflightExecutorPlan(
    planWith([{ resolved: { model: 'gpt-5' } }]),
    resolve,
  );
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'capability_mismatch');
  assert.match(result.items[0].message ?? '', /model "gpt-5"/);
});

test('M7.3：manual executor → blocked（manual executor cannot be auto-dispatched）', async () => {
  const result = await preflightExecutorPlan(planWith([{ adapter: 'manual' }]), () => MANUAL_ADAPTER);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'manual_executor');
  assert.match(result.items[0].message ?? '', /manual executor cannot be auto-dispatched/);
});

test('M7.3：formatPreflightBlocked 输出 execution preflight blocked + reason', async () => {
  const resolve = () => cliAdapter('codex', { installed: false });
  const result = await preflightExecutorPlan(planWith([{ adapter: 'codex' }]), resolve);
  const text = formatPreflightBlocked(result);
  assert.equal(text, 'execution preflight blocked\nreason: executor_unavailable');
});

test('M7.3：任一 assignment blocked → 整体 blocked（无任何施工副作用发生）', async () => {
  const codex = cliAdapter('codex');
  const claude = cliAdapter('claude');
  const resolve = (id: string) => (id === 'codex' ? codex : id === 'claude' ? claude : undefined);
  const result = await preflightExecutorPlan(
    planWith([{ adapter: 'codex' }, { adapter: 'claude' }, { adapter: 'missing' }]),
    resolve,
  );
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'executor_unavailable');
  assert.equal(result.items[0].status, 'pass');
  assert.equal(result.items[2].status, 'blocked');
});

// ---------------------------------------------------------------------------
// diagnostics
// ---------------------------------------------------------------------------

test('M7.3：collectExecutorDiagnostics —— adapter 去重 + blocked 汇总', async () => {
  const codex = cliAdapter('codex');
  const claude = cliAdapter('claude', { installed: false });
  const resolve = (id: string) => (id === 'codex' ? codex : id === 'claude' ? claude : undefined);

  const diag = await collectExecutorDiagnostics(
    planWith([
      { adapter: 'codex' },
      { adapter: 'codex' },
      { adapter: 'claude' },
    ]),
    resolve,
  );

  assert.equal(diag.adapters.length, 2); // 去重
  assert.equal(codex.probeCalls, 1); // codex 只 probe 一次
  assert.equal(claude.probeCalls, 1);
  assert.deepEqual(diag.adapters.find((d) => d.adapter === 'codex')?.usedBy, ['primary', 'primary']);
  assert.equal(diagnosticsPass(diag), false);
  assert.equal(diag.blocked.length, 1);
  assert.equal(diag.blocked[0].adapter, 'claude');
  assert.equal(diag.blocked[0].reason, 'executor_unavailable');
});

test('M7.3：collectExecutorDiagnostics —— capability mismatch 进入 blocked', async () => {
  const codex = cliAdapter('codex', { modelSelection: false });
  const diag = await collectExecutorDiagnostics(
    planWith([{ resolved: { model: 'gpt-5' } }]),
    () => codex,
  );
  assert.equal(diagnosticsPass(diag), false);
  assert.equal(diag.blocked[0].reason, 'capability_mismatch');
  assert.equal(diag.adapters[0].capabilityOk, false);
  assert.equal(diag.adapters[0].modelRequested, 'gpt-5');
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function manualBody(block: string): string {
  return `# Execution Manual\n\n## Execution Task Graph\n\n\`\`\`speccraft-task-graph\n${block}\n\`\`\`\n`;
}

test('M7.3：executors list —— 无 executors 配置返回 0（legacy 提示）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-exec-'));
  try {
    await initProject({ projectRoot: root });
    assert.equal(await cmdExecutorsList(root), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M7.3：executors plan —— 无 Executor Plan 返回 1；compile 后返回 0', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-exec-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    await createRun(speccraftDir, { id: 'run-1' });
    await writeState(speccraftDir, { ...(await readState(speccraftDir)), active_run: 'run-1' });
    assert.equal(await cmdExecutorsPlan(root), 1); // 尚无 plan

    const block = [
      'version: 1',
      '',
      'tasks:',
      '  - id: a',
      '    title: A',
      '    summary: s',
      '    executor: backend',
      '    depends_on: []',
      '    scope: { paths: [src/a/**] }',
      '    verification: { commands: [npm test], timeout_seconds: 30 }',
      '  - id: b',
      '    title: B',
      '    summary: s',
      '    depends_on: [a]',
      '    scope: { paths: [src/b/**] }',
      '    verification: { commands: [npm test], timeout_seconds: 30 }',
    ].join('\n');
    const projectConfig = parseProjectConfig(
      'name: test\nexecution:\n  default_executor: primary\n  executors:\n    primary:\n      adapter: claude\n      max_concurrency: 2\n    backend:\n      adapter: codex\n',
    );
    await compileTaskGraph({
      speccraftDir,
      runId: 'run-1',
      manualBody: manualBody(block),
      source: 'execution-manual',
      projectConfig,
    });
    assert.equal(await cmdExecutorsPlan(root), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M7.3：executors doctor —— 无 Executor Plan 返回 1', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-exec-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    await createRun(speccraftDir, { id: 'run-1' });
    await writeState(speccraftDir, { ...(await readState(speccraftDir)), active_run: 'run-1' });
    assert.equal(await cmdExecutorsDoctor(root), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

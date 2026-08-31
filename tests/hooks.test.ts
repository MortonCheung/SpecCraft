import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { createRun } from '../src/core/execution/store.js';
import { parseHookConfig } from '../src/core/hooks/config.js';
import { runBeforeHooks, runAfterHooks } from '../src/core/hooks/lifecycle.js';
import { runHooks } from '../src/core/hooks/runner.js';
import type { HookConfig } from '../src/core/hooks/types.js';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const baseEnv = (root: string, dir: string) => ({
  SPECCRAFT_EVENT: 'before_dispatch',
  SPECCRAFT_PROJECT_ROOT: root,
  SPECCRAFT_DIR: dir,
  SPECCRAFT_STAGE: 'implementation',
});

test('M4.3：parseHookConfig 解析 + 未知事件拒绝', () => {
  const config = parseHookConfig({
    before_dispatch: [{ id: 'x', command: 'true', timeout_seconds: 30 }],
    after_verify: [{ id: 'y', command: 'echo hi' }],
  });
  assert.equal(config.before_dispatch?.length, 1);
  assert.equal(config.after_verify?.[0].command, 'echo hi');

  assert.throws(() => parseHookConfig({ bogus_event: [{ id: 'x', command: 'true' }] }), /未知 hook 事件/);
  assert.throws(() => parseHookConfig({ before_dispatch: [{ command: 'true' }] }), /缺少 id/);
  assert.throws(() => parseHookConfig({ before_dispatch: [{ id: 'x' }] }), /缺少 command/);
});

test('M4.3：before hook 成功 → 不 block，主体可执行', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-hook-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    await createRun(speccraftDir, { id: 'run-h1' });
    const config: HookConfig = { before_dispatch: [{ id: 'ok', command: 'true' }] };
    const { blocked } = await runBeforeHooks(
      { projectRoot: root, speccraftDir, runId: 'run-h1', env: baseEnv(root, speccraftDir) },
      config,
      'before_dispatch',
    );
    assert.equal(blocked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M4.3：before hook 失败 → block（主体不执行、状态不推进）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-hook-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    await createRun(speccraftDir, { id: 'run-h2' });
    const config: HookConfig = { before_dispatch: [{ id: 'bad', command: 'false' }] };
    const { blocked, outcome } = await runBeforeHooks(
      { projectRoot: root, speccraftDir, runId: 'run-h2', env: baseEnv(root, speccraftDir) },
      config,
      'before_dispatch',
    );
    assert.equal(blocked, true);
    assert.equal(outcome?.anyFailed, true);
    assert.equal(outcome?.results[0].passed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M4.3：after hook 失败 → 只记录 warning，不倒滚（返回结果供提示）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-hook-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    await createRun(speccraftDir, { id: 'run-h3' });
    const config: HookConfig = { after_verify: [{ id: 'fail-after', command: 'false' }] };
    const outcome = await runAfterHooks(
      { projectRoot: root, speccraftDir, runId: 'run-h3', env: baseEnv(root, speccraftDir) },
      config,
      'after_verify',
    );
    assert.ok(outcome);
    assert.equal(outcome.anyFailed, true);
    // after hook 不抛错、不 block，只返回结果
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M4.3：hook log 落盘 + env contract 正确', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-hook-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    await createRun(speccraftDir, { id: 'run-h4' });

    // 用 env 输出到 stdout 验证 env contract
    const config: HookConfig = {
      before_dispatch: [{ id: 'dump-env', command: 'echo "event=$SPECCRAFT_EVENT run=$SPECCRAFT_RUN_ID stage=$SPECCRAFT_STAGE"' }],
    };
    const outcome = await runHooks({
      projectRoot: root,
      speccraftDir,
      runId: 'run-h4',
      event: 'before_dispatch',
      hooks: config.before_dispatch!,
      env: baseEnv(root, speccraftDir),
    });
    assert.equal(outcome.anyFailed, false);

    const logPath = path.join(speccraftDir, 'runs', 'run-h4', 'hooks', 'before_dispatch-001.log');
    assert.equal(await exists(logPath), true);
    const log = await readFile(logPath, 'utf8');
    assert.match(log, /event=before_dispatch/);
    assert.match(log, /run=run-h4/);
    assert.match(log, /stage=implementation/);
    assert.match(log, /id: dump-env/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M4.3：multiple hooks 顺序执行', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-hook-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    await createRun(speccraftDir, { id: 'run-h5' });
    const config: HookConfig = {
      before_dispatch: [
        { id: 'a', command: 'true' },
        { id: 'b', command: 'true' },
        { id: 'c', command: 'false' },
      ],
    };
    const outcome = await runHooks({
      projectRoot: root,
      speccraftDir,
      runId: 'run-h5',
      event: 'before_dispatch',
      hooks: config.before_dispatch!,
      env: baseEnv(root, speccraftDir),
    });
    assert.equal(outcome.results.length, 3);
    assert.equal(outcome.results[0].id, 'a');
    assert.equal(outcome.results[1].id, 'b');
    assert.equal(outcome.results[2].id, 'c');
    assert.equal(outcome.results[2].passed, false);
    assert.equal(outcome.anyFailed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M4.3：hook timeout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-hook-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    await createRun(speccraftDir, { id: 'run-h6' });
    const start = Date.now();
    const outcome = await runHooks({
      projectRoot: root,
      speccraftDir,
      runId: 'run-h6',
      event: 'before_dispatch',
      hooks: [{ id: 'slow', command: 'sleep 30', timeout_seconds: 1 }],
      env: baseEnv(root, speccraftDir),
    });
    assert.equal(outcome.anyFailed, true);
    assert.equal(outcome.results[0].timedOut, true);
    assert.ok(Date.now() - start < 15000, 'hook timeout 应尽快返回');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M4.3：无 Run 场景 log 落 .speccraft/logs/hooks/', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-hook-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    await runHooks({
      projectRoot: root,
      speccraftDir,
      event: 'before_prepare',
      hooks: [{ id: 'nop', command: 'true' }],
      env: baseEnv(root, speccraftDir),
    });
    assert.equal(await exists(path.join(speccraftDir, 'logs', 'hooks', 'before_prepare-001.log')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

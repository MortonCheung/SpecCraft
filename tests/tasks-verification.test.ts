import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { createRun } from '../src/core/execution/store.js';
import { compileTaskGraph } from '../src/core/tasks/compiler.js';
import { readTaskManifest, writeTaskManifest } from '../src/core/tasks/store.js';
import { verifyTask, nextTaskVerificationAttempt, listTaskVerificationAttempts } from '../src/core/tasks/verification/lifecycle.js';

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
    '    verification: { commands: [npm test], timeout_seconds: 30 }',
    '```',
  ].join('\n');
}

async function setup(): Promise<{ root: string; speccraftDir: string; runId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-tv-'));
  const { speccraftDir } = await initProject({ projectRoot: root });
  const run = await createRun(speccraftDir, { id: 'run-1' });
  await compileTaskGraph({ speccraftDir, runId: run.id, manualBody: manualBody(), source: 'execution-manual' });
  return { root, speccraftDir, runId: run.id };
}

test('M5.5 DoD #20：Task Verification PASS → completed', async () => {
  const { root, speccraftDir, runId } = await setup();
  try {
    // 把 a 设为 in_progress（模拟 dispatch 后）
    const m = await readTaskManifest(speccraftDir, runId, 'a');
    m!.status = 'in_progress';
    await writeTaskManifest(speccraftDir, runId, m!);

    const result = await verifyTask({
      speccraftDir,
      projectRoot: root,
      runId,
      taskId: 'a',
      verification: { commands: ['true'], timeoutSeconds: 30 },
    });
    assert.equal(result.passed, true);
    assert.equal(result.attempt, 1);

    const manifest = await readTaskManifest(speccraftDir, runId, 'a');
    assert.equal(manifest?.status, 'completed');
    assert.deepEqual(manifest?.verificationAttempts, [1]);

    // evidence 落盘
    const attemptDir = path.join(speccraftDir, 'runs', 'run-1', 'tasks', 'a', 'verification', 'attempt-001');
    assert.equal(await exists(path.join(attemptDir, 'manifest.yaml')), true);
    assert.equal(await exists(path.join(attemptDir, 'stdout.log')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M5.5 DoD #21#22：Task Verification FAIL → failed + evidence append-only', async () => {
  const { root, speccraftDir, runId } = await setup();
  try {
    const m = await readTaskManifest(speccraftDir, runId, 'a');
    m!.status = 'in_progress';
    await writeTaskManifest(speccraftDir, runId, m!);

    const result = await verifyTask({
      speccraftDir,
      projectRoot: root,
      runId,
      taskId: 'a',
      verification: { commands: ['false'], timeoutSeconds: 30 },
    });
    assert.equal(result.passed, false);

    const manifest = await readTaskManifest(speccraftDir, runId, 'a');
    assert.equal(manifest?.status, 'failed');
    assert.ok(manifest?.lastError?.includes('FAIL'));

    // 第二次 verify（append-only）→ attempt 2，不覆盖
    manifest!.status = 'in_progress';
    await writeTaskManifest(speccraftDir, runId, manifest!);
    await verifyTask({ speccraftDir, projectRoot: root, runId, taskId: 'a', verification: { commands: ['false'], timeoutSeconds: 30 } });

    assert.deepEqual(await listTaskVerificationAttempts(speccraftDir, runId, 'a'), [1, 2]);
    const attempt2 = path.join(speccraftDir, 'runs', 'run-1', 'tasks', 'a', 'verification', 'attempt-002', 'manifest.yaml');
    assert.equal(await exists(attempt2), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M5.5：非 in_progress 状态 verify 被拒绝', async () => {
  const { root, speccraftDir, runId } = await setup();
  try {
    await assert.rejects(
      () => verifyTask({ speccraftDir, projectRoot: root, runId, taskId: 'a', verification: { commands: ['true'], timeoutSeconds: 30 } }),
      /只有 in_progress 可 verify/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M5.5：nextTaskVerificationAttempt 递增', async () => {
  const { root, speccraftDir, runId } = await setup();
  try {
    assert.equal(await nextTaskVerificationAttempt(speccraftDir, runId, 'a'), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

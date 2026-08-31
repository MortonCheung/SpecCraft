import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { loadProject } from '../src/core/project.js';
import { completeStage, approveStage } from '../src/core/advance.js';
import { writeArtifact, createArtifact, artifactFileName } from '../src/core/artifacts/store.js';
import { resolveTemplateContent } from '../src/core/templates/resolver.js';
import { prepareExecution } from '../src/core/execution/prepare.js';
import { implementStart, implementFinish } from '../src/core/execution/lifecycle.js';
import { readRun } from '../src/core/execution/store.js';
import { verifyExecution } from '../src/core/verification/orchestrator.js';
import type { Workflow, State } from '../src/core/types.js';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function makeArtifact(
  speccraftDir: string,
  workflow: Workflow,
  state: State,
  stageId: string,
): Promise<void> {
  const stage = workflow.stages.find((s) => s.id === stageId)!;
  const target = completeStage(workflow, state, stageId);
  const body = await resolveTemplateContent(stage.template ?? stage.id);
  const artifact = createArtifact(
    { artifact: stage.produces[0], stage: stageId, status: target, version: 1 },
    body,
  );
  await writeArtifact(
    path.join(speccraftDir, 'artifacts', artifactFileName(stage.produces[0])),
    artifact,
  );
}

interface SetupOptions {
  commands: string[];
}

/** 建一个已完成 implement finish、等待 verify 的项目 */
async function makeAwaitingVerify(options: SetupOptions): Promise<{
  root: string;
  speccraftDir: string;
  runId: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-ver-'));
  const { speccraftDir } = await initProject({ projectRoot: root });
  const { workflow, state } = await loadProject(root);
  for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
    await makeArtifact(speccraftDir, workflow, state, id);
  }
  approveStage(workflow, state, 'design', 'owner');
  for (const id of ['build-brief', 'site-survey', 'execution-manual']) {
    await makeArtifact(speccraftDir, workflow, state, id);
  }
  const { writeState } = await import('../src/core/state/store.js');
  await writeState(speccraftDir, state);

  await writeFile(
    path.join(speccraftDir, 'project.yaml'),
    [
      'name: verify-test',
      'verification:',
      '  timeout_seconds: 60',
      '  commands:',
      ...options.commands.map((c) => `    - "${c}"`),
    ].join('\n'),
    'utf8',
  );

  const { runId } = await prepareExecution({ projectRoot: root });
  await implementStart({ projectRoot: root });
  const report = path.join(root, 'agent-report.md');
  await writeFile(report, '# Execution Report\n\n完成\n', 'utf8');
  await implementFinish({ projectRoot: root, reportPath: report });
  return { root, speccraftDir, runId };
}

test('M2.4 #14：无 verification commands 时 verify 拒绝（禁止假装成功）', async () => {
  const { root } = await makeAwaitingVerify({ commands: [] });
  try {
    await assert.rejects(
      () => verifyExecution({ projectRoot: root }),
      /未配置 verification\.commands/,
    );
    // 状态未被改动
    const { state } = await loadProject(root);
    assert.equal(state.stages['verification'].status, 'pending');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.4 #15：PASS → verification completed、run verified、verification.md 生成', async () => {
  const { root, speccraftDir, runId } = await makeAwaitingVerify({
    commands: ['true', 'echo ok'],
  });
  try {
    const result = await verifyExecution({ projectRoot: root });
    assert.equal(result.passed, true);
    assert.equal(result.attempt, 1);

    const { state } = await loadProject(root);
    assert.equal(state.stages['verification'].status, 'completed');
    assert.equal(state.current_stage, 'owner-acceptance');
    assert.equal(state.stages['owner-acceptance'].status, 'waiting_owner_approval');
    assert.equal(state.active_run, runId);

    const run = await readRun(speccraftDir, runId);
    assert.equal(run.status, 'awaiting_owner_acceptance');
    assert.equal(run.verificationAttempts, 1);

    // verification.md 存在且与 state 一致
    const verificationPath = path.join(speccraftDir, 'artifacts', 'verification.md');
    assert.equal(await exists(verificationPath), true);
    const content = await readFile(verificationPath, 'utf8');
    assert.match(content, /^---\n/);
    assert.match(content, /artifact: verification/);
    assert.match(content, /status: completed/);
    assert.match(content, /PASS/);
    assert.match(content, new RegExp(`Run: ${runId}`));

    // attempt manifest 存在
    assert.equal(
      await exists(path.join(speccraftDir, 'runs', runId, 'verification', 'attempt-001.yaml')),
      true,
    );
    // log 文件真实存在
    assert.equal(
      await exists(path.join(speccraftDir, 'runs', runId, 'logs', 'verify-001-01.log')),
      true,
    );
    assert.equal(
      await exists(path.join(speccraftDir, 'runs', runId, 'logs', 'verify-001-02.log')),
      true,
    );

    // log 内容含元信息与输出
    const log = await readFile(
      path.join(speccraftDir, 'runs', runId, 'logs', 'verify-001-02.log'),
      'utf8',
    );
    assert.match(log, /command: echo ok/);
    assert.match(log, /exit_code: 0/);
    assert.match(log, /ok/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.4 #16#17#18：FAIL → blocked、implementation 回到 in_progress、同 Run 返工', async () => {
  const { root, speccraftDir, runId } = await makeAwaitingVerify({
    commands: ['true', 'false'],
  });
  try {
    // run all：第一条 pass，第二条 fail，都留下记录
    const result = await verifyExecution({ projectRoot: root });
    assert.equal(result.passed, false);
    assert.equal(result.commands.length, 2);
    assert.equal(result.commands[0].passed, true);
    assert.equal(result.commands[1].passed, false);

    // FAIL：verification = blocked
    const { state } = await loadProject(root);
    assert.equal(state.stages['verification'].status, 'blocked');
    // 立即重开 implementation
    assert.equal(state.stages['implementation'].status, 'in_progress');
    assert.equal(state.current_stage, 'implementation');

    const run = await readRun(speccraftDir, runId);
    assert.equal(run.status, 'verification_failed');
    assert.equal(run.verificationAttempts, 1);

    // 没有产生新 workflow stage / 新 run
    const { readdir } = await import('node:fs/promises');
    const runDirs = await readdir(path.join(speccraftDir, 'runs'));
    assert.equal(runDirs.length, 1);
    assert.equal(runDirs[0], runId);

    // ---- 返工：模拟修复（把失败命令换成可通过的）----
    await writeFile(
      path.join(speccraftDir, 'project.yaml'),
      ['name: verify-test', 'verification:', '  timeout_seconds: 60', '  commands:', '    - "true"'].join('\n'),
      'utf8',
    );
    const report2 = path.join(root, 'agent-report-2.md');
    await writeFile(report2, '# Execution Report 2\n\n修复\n', 'utf8');
    const finishResult = await implementFinish({ projectRoot: root, reportPath: report2 });
    assert.equal(finishResult.reportFile, 'agent-report-002.md');

    // ---- 第二次 verify：同 run、attempt +1、通过 ----
    const result2 = await verifyExecution({ projectRoot: root });
    assert.equal(result2.attempt, 2);
    assert.equal(result2.passed, true);
    assert.equal(result2.runId, runId);

    const run2 = await readRun(speccraftDir, runId);
    assert.equal(run2.status, 'awaiting_owner_acceptance');
    assert.equal(run2.verificationAttempts, 2);
    assert.equal(run2.reports.length, 2);

    // attempt-002.yaml 存在，attempt-001 保留
    assert.equal(
      await exists(path.join(speccraftDir, 'runs', runId, 'verification', 'attempt-001.yaml')),
      true,
    );
    assert.equal(
      await exists(path.join(speccraftDir, 'runs', runId, 'verification', 'attempt-002.yaml')),
      true,
    );

    // 第二次 verify 的 log 命名 verify-002-*.log
    assert.equal(
      await exists(path.join(speccraftDir, 'runs', runId, 'logs', 'verify-002-01.log')),
      true,
    );

    const { state: finalState } = await loadProject(root);
    assert.equal(finalState.stages['verification'].status, 'completed');
    assert.equal(finalState.stages['implementation'].status, 'completed');
    assert.equal(finalState.stages['owner-acceptance'].status, 'waiting_owner_approval');

    // verification.md 与 state 一致（FAIL 未写过 → 这是首次 PASS 写入，version 1，
    // 但 History 记录了 attempt 1 的 FAIL）
    const content = await readFile(
      path.join(speccraftDir, 'artifacts', 'verification.md'),
      'utf8',
    );
    assert.match(content, /version: 1/);
    assert.match(content, /Attempt: 2/);
    assert.match(content, /## History/);
    assert.match(content, /attempt 1: FAIL/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.4 #34：命令超时被终止且 passed=false reason=timeout', async () => {
  const { root } = await makeAwaitingVerify({
    commands: ['sleep 30'],
  });
  try {
    // 覆盖 timeout 为 1 秒
    const { speccraftDir } = await loadProject(root);
    const configPath = path.join(speccraftDir, 'project.yaml');
    await writeFile(
      configPath,
      ['name: verify-test', 'verification:', '  timeout_seconds: 1', '  commands:', '    - "sleep 30"'].join('\n'),
      'utf8',
    );

    const start = Date.now();
    const result = await verifyExecution({ projectRoot: root });
    const elapsed = Date.now() - start;
    assert.equal(result.passed, false);
    assert.equal(result.commands[0].reason, 'timeout');
    // 不无限挂住：应远小于 30 秒
    assert.ok(elapsed < 15000, `verify 应在超时后返回（实际 ${elapsed}ms）`);

    const { state } = await loadProject(root);
    assert.equal(state.stages['verification'].status, 'blocked');
    assert.equal(state.stages['implementation'].status, 'in_progress');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.4：implementation 未完成时 verify 拒绝', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-ver-'));
  try {
    await initProject({ projectRoot: root });
    await assert.rejects(
      () => verifyExecution({ projectRoot: root }),
      /implementation == completed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.4：命令失败但 run all 保留后续命令信息', async () => {
  const { root, speccraftDir, runId } = await makeAwaitingVerify({
    commands: ['false', 'echo after-fail'],
  });
  try {
    const result = await verifyExecution({ projectRoot: root });
    assert.equal(result.commands.length, 2);
    assert.equal(result.commands[0].passed, false);
    assert.equal(result.commands[1].passed, true); // 第二条照常执行并留档
    assert.equal(
      await exists(path.join(speccraftDir, 'runs', runId, 'logs', 'verify-001-02.log')),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

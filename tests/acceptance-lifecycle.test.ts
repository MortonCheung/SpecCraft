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
import { verifyExecution } from '../src/core/verification/orchestrator.js';
import { readRun } from '../src/core/execution/store.js';
import { accept, reject, canAccept } from '../src/core/acceptance/lifecycle.js';
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

/** 建一个 verification PASS、等待 owner acceptance 的项目 */
async function makeAwaitingAcceptance(): Promise<{ root: string; speccraftDir: string; runId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-acclife-'));
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
    'name: acclife\nverification:\n  timeout_seconds: 60\n  commands:\n    - "true"\n',
    'utf8',
  );
  const { runId } = await prepareExecution({ projectRoot: root });
  await implementStart({ projectRoot: root });
  const report = path.join(root, 'agent-report.md');
  await writeFile(report, '# Execution Report\n\n完成\n', 'utf8');
  await implementFinish({ projectRoot: root, reportPath: report });
  await verifyExecution({ projectRoot: root });
  return { root, speccraftDir, runId };
}

test('M3.2 DoD #1#2：verify PASS → waiting_owner_approval（不自动 acceptance）', async () => {
  const { root, speccraftDir, runId } = await makeAwaitingAcceptance();
  try {
    const { state } = await loadProject(root);
    assert.equal(state.stages['verification'].status, 'completed');
    assert.equal(state.stages['owner-acceptance'].status, 'waiting_owner_approval');
    assert.equal(state.stages['handoff'].status, 'pending');
    assert.equal(state.current_stage, 'owner-acceptance');

    const run = await readRun(speccraftDir, runId);
    assert.equal(run.status, 'awaiting_owner_acceptance');
    assert.notEqual(run.status, 'accepted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.2 DoD #3：verify 未 PASS 时 accept 拒绝', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-acclife-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const { workflow, state } = await loadProject(root);

    // 无 active run
    const gateNoRun = await canAccept(speccraftDir, state, null);
    assert.equal(gateNoRun.ok, false);
    assert.match(gateNoRun.reason ?? '', /没有活跃的 Execution Run/);

    // 有 run 但 verification 未 completed
    const { createRun } = await import('../src/core/execution/store.js');
    const run = await createRun(speccraftDir, { id: 'run-x' });
    await assert.rejects(
      () => accept(speccraftDir, root, workflow, state, run, { by: 'owner' }),
      /verification 尚未 completed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.2 DoD #14：accept → owner-acceptance completed、run accepted', async () => {
  const { root, speccraftDir, runId } = await makeAwaitingAcceptance();
  try {
    const { workflow, state } = await loadProject(root);
    const run = await readRun(speccraftDir, runId);

    const { attempt } = await accept(speccraftDir, root, workflow, state, run, {
      by: 'owner',
      feedback: 'Owner acceptance passed.',
    });
    assert.equal(attempt, 1);

    assert.equal(state.stages['owner-acceptance'].status, 'completed');
    assert.equal(state.current_stage, 'handoff');
    assert.equal(run.status, 'accepted');
    assert.equal(run.acceptance.attempt, 1);
    assert.equal(run.acceptance.status, 'accepted');

    // acceptance record 落盘
    const recordPath = path.join(
      speccraftDir, 'runs', runId, 'acceptance', 'acceptance-001.md',
    );
    assert.equal(await exists(recordPath), true);
    const content = await readFile(recordPath, 'utf8');
    assert.match(content, /decision: accepted/);
    assert.match(content, /ACCEPTED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.2 DoD #6#7#8#9#10：reject → 同 Run 重开、不建 Stage/Run、历史保留', async () => {
  const { root, speccraftDir, runId } = await makeAwaitingAcceptance();
  try {
    const { workflow, state } = await loadProject(root);
    const run = await readRun(speccraftDir, runId);

    const { attempt } = await reject(speccraftDir, root, workflow, state, run, {
      feedback: '交互逻辑不符合批准方案。',
    });
    assert.equal(attempt, 1);

    // DoD #9：reject 后状态
    assert.equal(state.stages['owner-acceptance'].status, 'blocked');
    assert.equal(state.stages['implementation'].status, 'in_progress');
    assert.equal(state.stages['verification'].status, 'pending');
    assert.equal(state.current_stage, 'implementation');
    assert.equal(run.status, 'acceptance_rejected');
    assert.equal(run.acceptance.status, 'rejected');

    // DoD #7：不创建新 Workflow Stage（state 里 stage 数量不变）
    const { readdir } = await import('node:fs/promises');
    const workflowStageCount = workflow.stages.length;
    assert.equal(workflowStageCount, 16);
    assert.equal(Object.keys(state.stages).length, 16);

    // DoD #8：不创建新 Run
    const runDirs = await readdir(path.join(speccraftDir, 'runs'));
    assert.equal(runDirs.length, 1);
    assert.equal(runDirs[0], runId);

    // DoD #10：历史 PASS verification attempt 保留
    const attempt1 = path.join(speccraftDir, 'runs', runId, 'verification', 'attempt-001.yaml');
    assert.equal(await exists(attempt1), true);

    // DoD #6：acceptance-001.md decision=rejected
    const rec = await readFile(
      path.join(speccraftDir, 'runs', runId, 'acceptance', 'acceptance-001.md'),
      'utf8',
    );
    assert.match(rec, /decision: rejected/);
    assert.match(rec, /REJECTED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.2 DoD #5：reject 无反馈被拒绝', async () => {
  const { root, speccraftDir, runId } = await makeAwaitingAcceptance();
  try {
    const { workflow, state } = await loadProject(root);
    const run = await readRun(speccraftDir, runId);
    await assert.rejects(
      () => reject(speccraftDir, root, workflow, state, run, { feedback: '   ' }),
      /必须提供反馈/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.2 DoD #11#12#13：reject 后 finish→verify 产生新 attempt，重新 waiting，acceptance-002 不覆盖 001', async () => {
  const { root, speccraftDir, runId } = await makeAwaitingAcceptance();
  try {
    const { workflow, state } = await loadProject(root);
    let run = await readRun(speccraftDir, runId);

    // 第一次 reject
    await reject(speccraftDir, root, workflow, state, run, {
      feedback: '体验不合格',
    });

    // 返工：继续修改 → implement finish（不重新 start）
    const report2 = path.join(root, 'agent-report-2.md');
    await writeFile(report2, '# Execution Report 2\n\n修复\n', 'utf8');
    await implementFinish({ projectRoot: root, reportPath: report2 });

    // 第二次 verify：attempt +1，PASS
    const result = await verifyExecution({ projectRoot: root });
    assert.equal(result.attempt, 2);
    assert.equal(result.passed, true);

    const { state: s2 } = await loadProject(root);
    assert.equal(s2.stages['verification'].status, 'completed');
    assert.equal(s2.stages['owner-acceptance'].status, 'waiting_owner_approval');
    assert.equal(s2.current_stage, 'owner-acceptance');

    run = await readRun(speccraftDir, runId);
    assert.equal(run.status, 'awaiting_owner_acceptance');
    assert.equal(run.verificationAttempts, 2);

    // 第二次 accept → acceptance-002.md（不覆盖 001）
    const { attempt } = await accept(speccraftDir, root, workflow, s2, run, {
      by: 'owner',
      feedback: '通过。',
    });
    assert.equal(attempt, 2);
    assert.equal(run.status, 'accepted');
    assert.equal(run.acceptance.attempt, 2);

    const rec1 = await readFile(
      path.join(speccraftDir, 'runs', runId, 'acceptance', 'acceptance-001.md'),
      'utf8',
    );
    const rec2 = await readFile(
      path.join(speccraftDir, 'runs', runId, 'acceptance', 'acceptance-002.md'),
      'utf8',
    );
    assert.match(rec1, /decision: rejected/);
    assert.match(rec2, /decision: accepted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

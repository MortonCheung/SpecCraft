import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
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
import { cmdAccept, cmdReject, cmdStatus, cmdNext, cmdValidate } from '../src/cli/commands.js';
import type { Workflow, State } from '../src/core/types.js';

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

async function capture(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => chunks.push(a.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return chunks.join('\n');
}

async function makeAcceptedReady(): Promise<{ root: string; speccraftDir: string; runId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-cli3-'));
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
    'name: cli3\nverification:\n  timeout_seconds: 60\n  commands:\n    - "true"\n',
    'utf8',
  );
  const { runId } = await prepareExecution({ projectRoot: root });
  await implementStart({ projectRoot: root });
  const report = path.join(root, 'r.md');
  await writeFile(report, '# Execution Report\n\n完成\n', 'utf8');
  await implementFinish({ projectRoot: root, reportPath: report });
  await verifyExecution({ projectRoot: root });
  return { root, speccraftDir, runId };
}

test('M3.3：accept 在 verify 未 PASS 时失败', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-cli3-'));
  try {
    await initProject({ projectRoot: root });
    const code = await cmdAccept({ by: 'owner' }, root);
    assert.equal(code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.3：reject 无 reason/file 失败', async () => {
  const { root } = await makeAcceptedReady();
  try {
    const code = await cmdReject({}, root);
    assert.equal(code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.3：reject 在 verify 未 PASS 时失败', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-cli3-'));
  try {
    await initProject({ projectRoot: root });
    const code = await cmdReject({ reason: 'x' }, root);
    assert.equal(code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.3：accept 后 PASS（生成 acceptance record、run accepted）', async () => {
  const { root, speccraftDir, runId } = await makeAcceptedReady();
  try {
    const code = await cmdAccept({ by: 'owner', note: '验收通过。' }, root);
    assert.equal(code, 0);

    const { state } = await loadProject(root);
    assert.equal(state.stages['owner-acceptance'].status, 'completed');
    assert.equal(state.current_stage, 'handoff');

    const { readRun } = await import('../src/core/execution/store.js');
    const run = await readRun(speccraftDir, runId);
    assert.equal(run.status, 'accepted');
    assert.equal(run.acceptance.attempt, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.3：reject 后 PASS（acceptance record rejected、implementation 重开）', async () => {
  const { root, speccraftDir, runId } = await makeAcceptedReady();
  try {
    const code = await cmdReject({ reason: '体验不合格。' }, root);
    assert.equal(code, 0);

    const { state } = await loadProject(root);
    assert.equal(state.stages['owner-acceptance'].status, 'blocked');
    assert.equal(state.stages['implementation'].status, 'in_progress');
    assert.equal(state.current_stage, 'implementation');

    const { readRun } = await import('../src/core/execution/store.js');
    const run = await readRun(speccraftDir, runId);
    assert.equal(run.status, 'acceptance_rejected');
    assert.equal(run.acceptance.status, 'rejected');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.3：reject --file 读取文件作为反馈', async () => {
  const { root, speccraftDir, runId } = await makeAcceptedReady();
  try {
    const feedbackFile = path.join(root, 'feedback.md');
    await writeFile(feedbackFile, '文件里的反馈内容。', 'utf8');
    const code = await cmdReject({ file: feedbackFile }, root);
    assert.equal(code, 0);

    const { readRun } = await import('../src/core/execution/store.js');
    const run = await readRun(speccraftDir, runId);
    assert.equal(run.status, 'acceptance_rejected');

    const { readFile } = await import('node:fs/promises');
    const rec = await readFile(
      path.join(speccraftDir, 'runs', runId, 'acceptance', 'acceptance-001.md'),
      'utf8',
    );
    assert.match(rec, /文件里的反馈内容/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.3 DoD #20#21：status 显示 acceptance，next 区分 owner acceptance / rework', async () => {
  const { root } = await makeAcceptedReady();
  try {
    // 等待 acceptance 时 status 显示 waiting
    const statusOut = await capture(() => cmdStatus(root));
    assert.match(statusOut, /waiting_owner_approval/);

    const nextOut = await capture(() => cmdNext(root));
    assert.match(nextOut, /Waiting for Owner Acceptance/);
    assert.match(nextOut, /speccraft accept/);

    // reject 后 next 提示继续施工
    await cmdReject({ reason: '重做。' }, root);
    const nextAfterReject = await capture(() => cmdNext(root));
    assert.match(nextAfterReject, /Owner rejected/);
    assert.match(nextAfterReject, /implement finish/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.3 DoD #22：validate 能识别 acceptance 状态矛盾', async () => {
  const { root, speccraftDir, runId } = await makeAcceptedReady();
  try {
    // 正常状态 validate 通过
    assert.equal(await cmdValidate(root), 0);

    // 构造矛盾：run accepted 但 owner-acceptance 改回 waiting
    const { readRun } = await import('../src/core/execution/store.js');
    const { writeRun } = await import('../src/core/execution/store.js');
    const { loadProject } = await import('../src/core/project.js');
    const { setStageStatus, writeState } = await import('../src/core/state/store.js');

    const { workflow, state } = await loadProject(root);
    const run = await readRun(speccraftDir, runId);
    // 模拟 accept 完成但 state 不一致
    run.status = 'accepted';
    run.acceptance = { attempt: 1, status: 'accepted', latestRecord: 'acceptance/acceptance-001.md' };
    await writeRun(speccraftDir, run);
    setStageStatus(state, 'verification', 'completed');
    setStageStatus(state, 'owner-acceptance', 'waiting_owner_approval'); // 矛盾：accepted 但 waiting
    await writeState(speccraftDir, state);

    const code = await cmdValidate(root);
    assert.equal(code, 1);

    void workflow;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

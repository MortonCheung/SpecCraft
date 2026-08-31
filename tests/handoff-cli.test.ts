import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, mkdtemp, rm, readdir } from 'node:fs/promises';
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
import { accept, reject } from '../src/core/acceptance/lifecycle.js';
import { handoff, canHandoff, nextHandoffId } from '../src/core/handoff/lifecycle.js';
import { cmdHandoff } from '../src/cli/commands.js';
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

/** 建一个 verify PASS、尚未 accept 的项目 */
async function makeVerifiedNotAccepted(): Promise<{ root: string; speccraftDir: string; runId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-ho2-'));
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
    'name: ho2\nverification:\n  timeout_seconds: 60\n  commands:\n    - "true"\n',
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

test('M3.5 DoD #15：未 accept 时 handoff 失败', async () => {
  const { root, speccraftDir, runId } = await makeVerifiedNotAccepted();
  try {
    const { workflow, state } = await loadProject(root);
    const run = await readRun(speccraftDir, runId);
    const gate = await canHandoff(speccraftDir, state, run);
    assert.equal(gate.ok, false);
    await assert.rejects(
      () => handoff(speccraftDir, root, 'ho2', workflow, state, run),
      /owner-acceptance 尚未 completed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.5 DoD #16：accept 后 handoff 成功，handoff=completed、run=handed_off', async () => {
  const { root, speccraftDir, runId } = await makeVerifiedNotAccepted();
  try {
    const { workflow, state } = await loadProject(root);
    let run = await readRun(speccraftDir, runId);
    await accept(speccraftDir, root, workflow, state, run, { by: 'owner', feedback: '通过。' });

    const result = await handoff(speccraftDir, root, 'ho2', workflow, state, run);
    assert.equal(result.reused, false);
    assert.equal(result.handoffId, 'handoff-001');

    assert.equal(state.stages['handoff'].status, 'completed');
    assert.equal(state.current_stage, 'handoff');
    assert.equal(run.status, 'handed_off');
    assert.equal(run.handoffId, 'handoff-001');
    assert.ok(run.handoffAt);

    // handoff package 目录存在
    assert.equal(await exists(path.join(speccraftDir, 'handoffs', 'handoff-001', 'HANDOFF.md')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.5 DoD #19：重复 handoff 幂等（不产生 handoff-002）', async () => {
  const { root, speccraftDir, runId } = await makeVerifiedNotAccepted();
  try {
    const { workflow, state } = await loadProject(root);
    const run = await readRun(speccraftDir, runId);
    await accept(speccraftDir, root, workflow, state, run, { by: 'owner', feedback: '通过。' });

    await handoff(speccraftDir, root, 'ho2', workflow, state, run);
    const second = await handoff(speccraftDir, root, 'ho2', workflow, state, run);
    assert.equal(second.reused, true);
    assert.equal(second.handoffId, 'handoff-001');

    // 只有一个 handoff 目录
    const dirs = (await readdir(path.join(speccraftDir, 'handoffs'))).filter((d) => /^handoff-\d+$/.test(d));
    assert.deepEqual(dirs, ['handoff-001']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.5：reject 后 handoff 失败', async () => {
  const { root, speccraftDir, runId } = await makeVerifiedNotAccepted();
  try {
    const { workflow, state } = await loadProject(root);
    const run = await readRun(speccraftDir, runId);
    await reject(speccraftDir, root, workflow, state, run, { feedback: '不合格' });

    await assert.rejects(
      () => handoff(speccraftDir, root, 'ho2', workflow, state, run),
      /verification 尚未 completed|owner-acceptance 尚未 completed|run.status 为/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.5：handoff 后 terminal run 不阻塞未来 prepare', async () => {
  const { root, speccraftDir, runId } = await makeVerifiedNotAccepted();
  try {
    const { workflow, state } = await loadProject(root);
    const run = await readRun(speccraftDir, runId);
    await accept(speccraftDir, root, workflow, state, run, { by: 'owner', feedback: '通过。' });
    await handoff(speccraftDir, root, 'ho2', workflow, state, run);

    // 历史 run 保留
    assert.equal(await exists(path.join(speccraftDir, 'runs', runId)), true);

    // 未来 prepare 能创建新 run（覆盖 active_run，不删除历史）
    const result = await prepareExecution({ projectRoot: root });
    assert.notEqual(result.runId, runId);
    const { state: s2 } = await loadProject(root);
    assert.equal(s2.active_run, result.runId);

    // 历史 run 仍在
    assert.equal(await exists(path.join(speccraftDir, 'runs', runId)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.5：CLI handoff 端到端', async () => {
  const { root, speccraftDir, runId } = await makeVerifiedNotAccepted();
  try {
    const { workflow, state } = await loadProject(root);
    const run = await readRun(speccraftDir, runId);
    await accept(speccraftDir, root, workflow, state, run, { by: 'owner', feedback: '通过。' });
    const { writeState } = await import('../src/core/state/store.js');
    await writeState(speccraftDir, state);

    const code = await cmdHandoff(root);
    assert.equal(code, 0);

    const { state: s2 } = await loadProject(root);
    assert.equal(s2.stages['handoff'].status, 'completed');

    const run2 = await readRun(speccraftDir, runId);
    assert.equal(run2.status, 'handed_off');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.5：nextHandoffId 递增', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-ho2-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(speccraftDir, 'handoffs', 'handoff-001'), { recursive: true });
    await mkdir(path.join(speccraftDir, 'handoffs', 'handoff-002'), { recursive: true });
    assert.equal(await nextHandoffId(speccraftDir), 'handoff-003');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

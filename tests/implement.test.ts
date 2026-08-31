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

async function makeStartedRun(): Promise<{
  root: string;
  speccraftDir: string;
  runId: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-impl-'));
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

  const { runId } = await prepareExecution({ projectRoot: root });
  await implementStart({ projectRoot: root });
  return { root, speccraftDir, runId };
}

test('M2.3 #9：没有 run 时不能 start', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-impl-'));
  try {
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

    await assert.rejects(() => implementStart({ projectRoot: root }), /没有活跃的 Execution Run/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.3 #10：start → implementation in_progress、run in_progress', async () => {
  const { root, runId } = await makeStartedRun();
  try {
    const { state } = await loadProject(root);
    assert.equal(state.stages['implementation'].status, 'in_progress');
    assert.equal(state.current_stage, 'implementation');
    assert.equal(state.active_run, runId);

    const run = await readRun(path.join(root, '.speccraft'), runId);
    assert.equal(run.status, 'in_progress');
    assert.ok(run.startedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.3：run 状态非 prepared 时不能 start', async () => {
  const { root } = await makeStartedRun();
  try {
    // 已经 start 过，再次 start 应拒绝
    await assert.rejects(
      () => implementStart({ projectRoot: root }),
      /只有 prepared 状态才能 start/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.3 #11：无 report 时 finish 拒绝（缺失 / 空文件）', async () => {
  const { root } = await makeStartedRun();
  try {
    await assert.rejects(
      () => implementFinish({ projectRoot: root, reportPath: './no-such-report.md' }),
      /报告不存在/,
    );

    const emptyReport = path.join(root, 'empty-report.md');
    await writeFile(emptyReport, '', 'utf8');
    await assert.rejects(
      () => implementFinish({ projectRoot: root, reportPath: emptyReport }),
      /报告为空文件/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.3 #12：finish → implementation completed、run awaiting_verification', async () => {
  const { root, speccraftDir, runId } = await makeStartedRun();
  try {
    const report = path.join(root, 'agent-report.md');
    await writeFile(
      report,
      '# Execution Report\n\n## 实际修改\n- 完成施工\n',
      'utf8',
    );
    const result = await implementFinish({ projectRoot: root, reportPath: report });
    assert.equal(result.runId, runId);
    assert.equal(result.reportFile, 'agent-report-001.md');

    assert.equal(
      await exists(path.join(speccraftDir, 'runs', runId, 'agent-report-001.md')),
      true,
    );

    const { state } = await loadProject(root);
    assert.equal(state.stages['implementation'].status, 'completed');
    assert.equal(state.current_stage, 'verification');

    const run = await readRun(speccraftDir, runId);
    assert.equal(run.status, 'awaiting_verification');
    assert.equal(run.reports.length, 1);
    assert.ok(run.finishedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.3 #13：Git 文件变化本身不能改变状态', async () => {
  const { root } = await makeStartedRun();
  try {
    // 模拟施工 Agent 写入代码文件（Git 工作区出现改动）
    await writeFile(path.join(root, 'src-changed.ts'), 'export const x = 1;\n', 'utf8');

    const { state } = await loadProject(root);
    assert.equal(state.stages['implementation'].status, 'in_progress');
    assert.equal(state.current_stage, 'implementation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.3 #13b：report 文件存在本身不能改变状态', async () => {
  const { root, speccraftDir, runId } = await makeStartedRun();
  try {
    // 直接把报告放进 run 目录，不执行 finish
    await writeFile(
      path.join(speccraftDir, 'runs', runId, 'agent-report.md'),
      '# Execution Report\n',
      'utf8',
    );
    const { state } = await loadProject(root);
    assert.equal(state.stages['implementation'].status, 'in_progress');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.3 #40：再次 finish 报告版本化不覆盖', async () => {
  const { root, speccraftDir, runId } = await makeStartedRun();
  try {
    const report1 = path.join(root, 'r1.md');
    await writeFile(report1, '# Execution Report 1\n', 'utf8');
    await implementFinish({ projectRoot: root, reportPath: report1 });

    // 模拟 verification 失败后返工：直接回到 in_progress（reopen 由 verify 触发，
    // 这里手动改状态验证 finish 的版本化逻辑）
    const { state } = await loadProject(root);
    state.stages['implementation'].status = 'in_progress';
    const { writeState } = await import('../src/core/state/store.js');
    await writeState(speccraftDir, state);

    const report2 = path.join(root, 'r2.md');
    await writeFile(report2, '# Execution Report 2\n', 'utf8');
    const result = await implementFinish({ projectRoot: root, reportPath: report2 });
    assert.equal(result.reportFile, 'agent-report-002.md');

    // 历史报告保留
    const first = await readFile(
      path.join(speccraftDir, 'runs', runId, 'agent-report-001.md'),
      'utf8',
    );
    assert.match(first, /Execution Report 1/);

    const run = await readRun(speccraftDir, runId);
    assert.equal(run.reports.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.3：implementation 非 in_progress 时 finish 拒绝', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-impl-'));
  try {
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
    await prepareExecution({ projectRoot: root });

    const report = path.join(root, 'r.md');
    await writeFile(report, '# report\n', 'utf8');
    await assert.rejects(
      () => implementFinish({ projectRoot: root, reportPath: report }),
      /只有 in_progress 才能 finish/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
import { cmdStatus, cmdNext, cmdValidate, cmdArtifact } from '../src/cli/commands.js';
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

interface Step {
  root: string;
  speccraftDir: string;
}

async function newProject(): Promise<Step> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-cli-'));
  const { speccraftDir } = await initProject({ projectRoot: root });
  return { root, speccraftDir };
}

async function reachReady(s: Step, commands: string[]): Promise<void> {
  const { workflow, state } = await loadProject(s.root);
  for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
    await makeArtifact(s.speccraftDir, workflow, state, id);
  }
  approveStage(workflow, state, 'design', 'owner');
  for (const id of ['build-brief', 'site-survey', 'execution-manual']) {
    await makeArtifact(s.speccraftDir, workflow, state, id);
  }
  const { writeState } = await import('../src/core/state/store.js');
  await writeState(s.speccraftDir, state);

  await writeFile(
    path.join(s.speccraftDir, 'project.yaml'),
    ['name: cli-test', 'verification:', '  timeout_seconds: 60', '  commands:', ...commands.map((c) => `    - "${c}"`)].join('\n'),
    'utf8',
  );
}

/** 捕获 console.log 输出 */
async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return chunks.join('\n');
}

test('M2.5 #23a：next 情况1 —— ready-to-implement 完成且无 run 时提示 prepare', async () => {
  const s = await newProject();
  try {
    await reachReady(s, ['true']);
    const out = await captureStdout(() => cmdNext(s.root));
    assert.match(out, /speccraft prepare/);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test('M2.5 #23b：next 情况2 —— run prepared 时提示 implement start', async () => {
  const s = await newProject();
  try {
    await reachReady(s, ['true']);
    await prepareExecution({ projectRoot: s.root });
    const out = await captureStdout(() => cmdNext(s.root));
    assert.match(out, /speccraft implement start/);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test('M2.5 #23c：next 情况3 —— in_progress 时提示 implement finish', async () => {
  const s = await newProject();
  try {
    await reachReady(s, ['true']);
    await prepareExecution({ projectRoot: s.root });
    await implementStart({ projectRoot: s.root });
    const out = await captureStdout(() => cmdNext(s.root));
    assert.match(out, /implement finish --report/);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test('M2.5 #23d：next 情况4 —— implementation completed 时提示 verify', async () => {
  const s = await newProject();
  try {
    await reachReady(s, ['true']);
    await prepareExecution({ projectRoot: s.root });
    await implementStart({ projectRoot: s.root });
    const report = path.join(s.root, 'r.md');
    await writeFile(report, '# report\n', 'utf8');
    await implementFinish({ projectRoot: s.root, reportPath: report });

    const out = await captureStdout(() => cmdNext(s.root));
    assert.match(out, /speccraft verify/);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test('M2.5 #23e：next 情况5 —— verification 未通过时提示返工', async () => {
  const s = await newProject();
  try {
    await reachReady(s, ['false']);
    await prepareExecution({ projectRoot: s.root });
    await implementStart({ projectRoot: s.root });
    const report = path.join(s.root, 'r.md');
    await writeFile(report, '# report\n', 'utf8');
    await implementFinish({ projectRoot: s.root, reportPath: report });
    await verifyExecution({ projectRoot: s.root });

    const out = await captureStdout(() => cmdNext(s.root));
    assert.match(out, /Verification 未通过/);
    assert.match(out, /implement finish/);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test('M2.5 #23f：next 情况6 —— verification PASS 后提示 Owner Acceptance', async () => {
  const s = await newProject();
  try {
    await reachReady(s, ['true']);
    await prepareExecution({ projectRoot: s.root });
    await implementStart({ projectRoot: s.root });
    const report = path.join(s.root, 'r.md');
    await writeFile(report, '# report\n', 'utf8');
    await implementFinish({ projectRoot: s.root, reportPath: report });
    await verifyExecution({ projectRoot: s.root });

    const out = await captureStdout(() => cmdNext(s.root));
    assert.match(out, /Machine verification passed/);
    assert.match(out, /Waiting for Owner Acceptance/);
    assert.match(out, /speccraft accept/);
    assert.match(out, /speccraft reject --reason/);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test('M2.5 #22：status 正确显示 active run', async () => {
  const s = await newProject();
  try {
    await reachReady(s, ['false']);
    const { runId } = await prepareExecution({ projectRoot: s.root });
    await implementStart({ projectRoot: s.root });
    const report = path.join(s.root, 'r.md');
    await writeFile(report, '# report\n', 'utf8');
    await implementFinish({ projectRoot: s.root, reportPath: report });
    await verifyExecution({ projectRoot: s.root }); // FAIL

    const out = await captureStdout(() => cmdStatus(s.root));
    assert.match(out, new RegExp(runId));
    assert.match(out, /status: verification_failed/);
    assert.match(out, /verification attempts: 1/);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test('M2.5 #24：validate 能发现 run/state 不一致', async () => {
  const s = await newProject();
  try {
    await reachReady(s, ['true']);

    // 构造矛盾：implementation in_progress 但没有 active run
    const { state } = await loadProject(s.root);
    const { setStageStatus, writeState } = await import('../src/core/state/store.js');
    setStageStatus(state, 'implementation', 'in_progress');
    state.current_stage = 'implementation';
    await writeState(s.speccraftDir, state);

    const exitCode = await cmdValidate(s.root);
    assert.equal(exitCode, 1);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test('M2.5 #24b：validate 发现 verification completed 但无 PASS attempt', async () => {
  const s = await newProject();
  try {
    await reachReady(s, ['true']);
    const { runId } = await prepareExecution({ projectRoot: s.root });
    await implementStart({ projectRoot: s.root });
    const report = path.join(s.root, 'r.md');
    await writeFile(report, '# report\n', 'utf8');
    await implementFinish({ projectRoot: s.root, reportPath: report });

    // 正常 PASS 流程
    await verifyExecution({ projectRoot: s.root });
    let exitCode = await cmdValidate(s.root);
    assert.equal(exitCode, 0);

    // 构造矛盾：删除 attempt 记录但保留 verification completed
    const { rm: rmFile } = await import('node:fs/promises');
    await rmFile(path.join(s.speccraftDir, 'runs', runId, 'verification', 'attempt-001.yaml'));
    exitCode = await cmdValidate(s.root);
    assert.equal(exitCode, 1);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test('M2.5 #24c：validate 发现 active_run 指向不存在的 run', async () => {
  const s = await newProject();
  try {
    await reachReady(s, ['true']);
    const { state } = await loadProject(s.root);
    state.active_run = 'run-not-exist';
    const { writeState } = await import('../src/core/state/store.js');
    await writeState(s.speccraftDir, state);

    const exitCode = await cmdValidate(s.root);
    assert.equal(exitCode, 1);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test('M2.5 #24d：validate 发现 run verified 但 verification 未 completed', async () => {
  const s = await newProject();
  try {
    await reachReady(s, ['true']);
    await prepareExecution({ projectRoot: s.root });
    await implementStart({ projectRoot: s.root });
    const report = path.join(s.root, 'r.md');
    await writeFile(report, '# report\n', 'utf8');
    await implementFinish({ projectRoot: s.root, reportPath: report });
    await verifyExecution({ projectRoot: s.root });

    // 构造矛盾：手动把 verification 改回 pending
    const { state } = await loadProject(s.root);
    const { setStageStatus, writeState } = await import('../src/core/state/store.js');
    setStageStatus(state, 'verification', 'pending');
    await writeState(s.speccraftDir, state);

    const exitCode = await cmdValidate(s.root);
    assert.equal(exitCode, 1);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test('M2.5：完整 PASS 流程后 validate 通过', async () => {
  const s = await newProject();
  try {
    await reachReady(s, ['true', 'echo ok']);
    await prepareExecution({ projectRoot: s.root });
    await implementStart({ projectRoot: s.root });
    const report = path.join(s.root, 'r.md');
    await writeFile(report, '# report\n', 'utf8');
    await implementFinish({ projectRoot: s.root, reportPath: report });
    await verifyExecution({ projectRoot: s.root });

    const exitCode = await cmdValidate(s.root);
    assert.equal(exitCode, 0);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test('M2.5：artifact implementation 仍然拒绝（implementation 不产出阶段 artifact）', async () => {
  const s = await newProject();
  try {
    await reachReady(s, ['true']);
    await assert.rejects(() => cmdArtifact('implementation', s.root), /不产出 artifact/);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

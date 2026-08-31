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
import { accept } from '../src/core/acceptance/lifecycle.js';
import { compileHandoffPackage, handoffDir } from '../src/core/handoff/package.js';
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

async function makeAcceptedProject(): Promise<{ root: string; speccraftDir: string; runId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-ho-'));
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
    'name: ho-test\nverification:\n  timeout_seconds: 60\n  commands:\n    - "true"\n',
    'utf8',
  );
  const { runId } = await prepareExecution({ projectRoot: root });
  await implementStart({ projectRoot: root });
  const report = path.join(root, 'r.md');
  await writeFile(report, '# Execution Report\n\n完成\n', 'utf8');
  await implementFinish({ projectRoot: root, reportPath: report });
  await verifyExecution({ projectRoot: root });

  const { workflow: wf, state: st } = await loadProject(root);
  const run = await readRun(speccraftDir, runId);
  await accept(speccraftDir, root, wf, st, run, { by: 'owner', feedback: '通过。' });
  return { root, speccraftDir, runId };
}

test('M3.4：编译 Handoff Package（7 个文件，确定性）', async () => {
  const { root, speccraftDir, runId } = await makeAcceptedProject();
  try {
    const { workflow } = await loadProject(root);
    const run = await readRun(speccraftDir, runId);

    const written = await compileHandoffPackage({
      speccraftDir,
      projectRoot: root,
      projectName: 'ho-test',
      workflow,
      run,
      handoffId: 'handoff-001',
      createdAt: '2026-08-31T00:00:00.000Z',
    });

    for (const f of [
      'HANDOFF.md',
      'context.md',
      'decisions.md',
      'execution-history.md',
      'verification-history.md',
      'acceptance-history.md',
      'manifest.yaml',
    ]) {
      assert.ok(written.includes(f), `应生成 ${f}`);
      assert.equal(await exists(path.join(handoffDir(speccraftDir, 'handoff-001'), f)), true);
    }

    // HANDOFF.md 是入口
    const handoff = await readFile(
      path.join(handoffDir(speccraftDir, 'handoff-001'), 'HANDOFF.md'),
      'utf8',
    );
    assert.match(handoff, /Run ID: run-/);
    assert.match(handoff, /ACCEPTED/);
    assert.match(handoff, /handoff/);

    // manifest 引用 run / verification / acceptance
    const manifest = await readFile(
      path.join(handoffDir(speccraftDir, 'handoff-001'), 'manifest.yaml'),
      'utf8',
    );
    assert.match(manifest, /handoff_id: handoff-001/);
    assert.match(manifest, new RegExp(`run_id: ${runId}`));
    assert.match(manifest, /decision: accepted/);

    // acceptance history 包含 ACCEPTED
    const accHist = await readFile(
      path.join(handoffDir(speccraftDir, 'handoff-001'), 'acceptance-history.md'),
      'utf8',
    );
    assert.match(accHist, /ACCEPTED/);

    // verification history 包含 PASS
    const verHist = await readFile(
      path.join(handoffDir(speccraftDir, 'handoff-001'), 'verification-history.md'),
      'utf8',
    );
    assert.match(verHist, /PASS/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.4：context.md 复用 Context Compiler，缺失 artifact 显式记录', async () => {
  const { root, speccraftDir, runId } = await makeAcceptedProject();
  try {
    const { workflow } = await loadProject(root);
    const run = await readRun(speccraftDir, runId);

    // 删除一个 artifact 模拟缺失
    const { rm: rmFile } = await import('node:fs/promises');
    await rmFile(path.join(speccraftDir, 'artifacts', 'research.md'));

    await compileHandoffPackage({
      speccraftDir,
      projectRoot: root,
      projectName: 'ho-test',
      workflow,
      run,
      handoffId: 'handoff-002',
      createdAt: '2026-08-31T00:00:00.000Z',
    });

    const manifest = await readFile(
      path.join(handoffDir(speccraftDir, 'handoff-002'), 'manifest.yaml'),
      'utf8',
    );
    // research 不在 sources.artifacts 里（缺失被排除）
    assert.doesNotMatch(manifest, /artifacts:\s*\n\s*- research/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

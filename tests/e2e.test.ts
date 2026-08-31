import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { loadProject } from '../src/core/project.js';
import { completeStage, approveStage } from '../src/core/advance.js';
import { validateState } from '../src/core/guards/index.js';
import { writeArtifact, createArtifact, artifactFileName } from '../src/core/artifacts/store.js';
import { resolveTemplateContent } from '../src/core/templates/resolver.js';
import { compileContext, renderContext } from '../src/core/context/compiler.js';
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

test('DoD #1#2#13：空项目 init 并完整推进到 ready-to-implement', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'speccraft-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: dir });
    assert.equal(await exists(path.join(speccraftDir, 'state.yaml')), true);
    assert.equal(await exists(path.join(speccraftDir, 'workflow.yaml')), true);
    assert.equal(await exists(path.join(speccraftDir, 'project.yaml')), true);
    assert.equal(await exists(path.join(speccraftDir, 'artifacts')), true);

    const { workflow, state } = await loadProject(dir);
    assert.equal(state.current_stage, 'idea');

    for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
      await makeArtifact(speccraftDir, workflow, state, id);
    }
    assert.equal(state.stages['design'].status, 'waiting_owner_approval');

    approveStage(workflow, state, 'design', 'owner');
    for (const id of ['build-brief', 'site-survey', 'execution-manual']) {
      await makeArtifact(speccraftDir, workflow, state, id);
    }

    assert.equal(state.stages['ready-to-implement'].status, 'completed');
    assert.equal(state.current_stage, 'ready-to-implement');
    assert.deepEqual(validateState(workflow, state), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DoD #14：文件存在不等于阶段完成（state.yaml 是权威）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'speccraft-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: dir });
    // 人为放置一个 idea.md，但不改 state.yaml
    const ideaPath = path.join(speccraftDir, 'artifacts', 'idea.md');
    await writeFile(
      ideaPath,
      '---\nartifact: idea\nstage: idea\nstatus: completed\nversion: 1\n---\n\n# 概述\n',
      'utf8',
    );
    const { state } = await loadProject(dir);
    assert.equal(state.stages['idea'].status, 'pending');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Context Compiler：编译 execution-manual 上游为 Execution Context', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'speccraft-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: dir });
    const { workflow, state } = await loadProject(dir);
    for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
      await makeArtifact(speccraftDir, workflow, state, id);
    }
    approveStage(workflow, state, 'design', 'owner');
    for (const id of ['build-brief', 'site-survey']) {
      await makeArtifact(speccraftDir, workflow, state, id);
    }

    const ctx = await compileContext(speccraftDir, workflow, 'execution-manual');
    assert.equal(ctx.sections.length, 9);
    assert.equal(ctx.sections[0].artifactId, 'idea');
    assert.match(renderContext(ctx), /Execution Context/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initProject } from '../src/core/init.js';
import { loadProject } from '../src/core/project.js';
import { completeStage, approveStage } from '../src/core/advance.js';
import { writeArtifact, createArtifact, artifactFileName } from '../src/core/artifacts/store.js';
import { resolveTemplateContent } from '../src/core/templates/resolver.js';
import { prepareExecution } from '../src/core/execution/prepare.js';
import { readRun } from '../src/core/execution/store.js';
import { registerAdapter } from '../src/core/execution/adapters/registry.js';
import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import { verifyExecution } from '../src/core/verification/orchestrator.js';
import { accept, reject } from '../src/core/acceptance/lifecycle.js';
import { handoff } from '../src/core/handoff/lifecycle.js';
import { dispatchExecution } from '../src/core/dispatch/lifecycle.js';
import type { CliExecutionAdapter, NormalizedDispatchResult } from '../src/core/execution/adapters/types.js';
import type { Workflow, State } from '../src/core/types.js';

const fakeAgentPath = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

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

function makeFakeAdapter(mode: string): CliExecutionAdapter {
  return {
    id: 'fake',
    kind: 'cli',
    capabilities: {
      invoke: true, resume: true, structuredOutput: true,
      finalMessageFile: true, sessionId: true, modelSelection: false,
    },
    prepare: manualAdapter.prepare,
    probe: async () => ({ id: 'fake', installed: true }),
    buildInvocation: async (input) => ({
      command: 'node',
      args: [fakeAgentPath],
      cwd: input.projectRoot,
      stdin: input.prompt,
      env: { FAKE_AGENT_MODE: mode, FAKE_AGENT_SESSION: 'session-e2e-1' },
      timeoutMs: 10000,
    }),
    normalize: async (input): Promise<NormalizedDispatchResult> => {
      let sessionId: string | undefined;
      let finalMessage: string | undefined;
      for (const line of input.stdout.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.session_id) sessionId = obj.session_id;
          if (obj.type === 'final_message') finalMessage = obj.text;
        } catch { /* ignore */ }
      }
      return {
        adapter: 'fake',
        status: input.timedOut ? 'timed_out' : input.spawnError ? 'spawn_error' : input.exitCode === 0 ? 'succeeded' : 'failed',
        exitCode: input.exitCode ?? undefined,
        timedOut: input.timedOut,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        durationMs: input.durationMs,
        ...(sessionId ? { sessionId } : {}),
        ...(finalMessage ? { finalMessage } : {}),
        events: [],
      };
    },
  };
}

async function makeReady(verifyCmd: string, adapterId = 'fake'): Promise<{ root: string; speccraftDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-e2e4-'));
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
    ['name: e2e4', `execution:\n  default_adapter: ${adapterId}`, 'verification:', '  timeout_seconds: 60', '  commands:', `    - "${verifyCmd}"`].join('\n'),
    'utf8',
  );
  return { root, speccraftDir };
}

test('M4.9 DoD #52：自动路线 dispatch → verify PASS → accept → handoff 完整走通（Run ID 不变）', async () => {
  registerAdapter(makeFakeAdapter('jsonl'));
  const { root, speccraftDir } = await makeReady('true');
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake' });
    const { workflow, state } = await loadProject(root);
    let run = await readRun(speccraftDir, runId);

    // dispatch（自动施工）
    const d = await dispatchExecution({
      projectRoot: root, speccraftDir, workflow, state, run,
      adapter: makeFakeAdapter('jsonl'),
      promptFile: path.join(speccraftDir, 'runs', runId, 'agent-prompt.md'),
      freshSession: true,
    });
    assert.equal(d.success, true);

    // verify PASS
    const v = await verifyExecution({ projectRoot: root });
    assert.equal(v.passed, true);

    // accept + handoff
    const { workflow: wf2, state: st2 } = await loadProject(root);
    run = await readRun(speccraftDir, runId);
    await accept(speccraftDir, root, wf2, st2, run, { by: 'owner', feedback: 'ok' });
    await handoff(speccraftDir, root, 'e2e4', wf2, st2, run);

    const finalRun = await readRun(speccraftDir, runId);
    assert.equal(finalRun.id, runId); // Run ID 不变
    assert.equal(finalRun.status, 'handed_off');
    assert.equal(await exists(path.join(speccraftDir, 'handoffs', 'handoff-001', 'HANDOFF.md')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M4.9 DoD #53#54：FAIL→FIX→PASS + PASS→REJECT→FIX→PASS→ACCEPT→HANDOFF 全为 same Run', async () => {
  registerAdapter(makeFakeAdapter('jsonl'));
  const { root, speccraftDir } = await makeReady('true');
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake' });

    // attempt 1：dispatch 成功但 verification 失败
    let { workflow, state } = await loadProject(root);
    let run = await readRun(speccraftDir, runId);
    await dispatchExecution({
      projectRoot: root, speccraftDir, workflow, state, run,
      adapter: makeFakeAdapter('jsonl'),
      promptFile: path.join(speccraftDir, 'runs', runId, 'agent-prompt.md'),
      freshSession: true,
    });
    // 让 verification 失败
    await writeFile(
      path.join(speccraftDir, 'project.yaml'),
      'name: e2e4\nverification:\n  timeout_seconds: 60\n  commands:\n    - "false"\n',
      'utf8',
    );
    const v1 = await verifyExecution({ projectRoot: root });
    assert.equal(v1.passed, false);

    // 返工：dispatch（resume 同 adapter，same run）
    ({ workflow, state } = await loadProject(root));
    run = await readRun(speccraftDir, runId);
    const d2 = await dispatchExecution({
      projectRoot: root, speccraftDir, workflow, state, run,
      adapter: makeFakeAdapter('jsonl'),
      promptFile: path.join(speccraftDir, 'runs', runId, 'agent-prompt.md'),
      freshSession: false, // resume
    });
    assert.equal(d2.success, true);
    assert.equal(d2.attempt, 2); // 同 run，新 attempt

    // verify PASS
    await writeFile(
      path.join(speccraftDir, 'project.yaml'),
      'name: e2e4\nverification:\n  timeout_seconds: 60\n  commands:\n    - "true"\n',
      'utf8',
    );
    const v2 = await verifyExecution({ projectRoot: root });
    assert.equal(v2.passed, true);

    // reject
    ({ workflow, state } = await loadProject(root));
    run = await readRun(speccraftDir, runId);
    await reject(speccraftDir, root, workflow, state, run, { feedback: '体验不合格' });

    // dispatch again（attempt 3）
    ({ workflow, state } = await loadProject(root));
    run = await readRun(speccraftDir, runId);
    const d3 = await dispatchExecution({
      projectRoot: root, speccraftDir, workflow, state, run,
      adapter: makeFakeAdapter('jsonl'),
      promptFile: path.join(speccraftDir, 'runs', runId, 'agent-prompt.md'),
      freshSession: true, // 或 fresh
    });
    assert.equal(d3.success, true);
    assert.equal(d3.attempt, 3);

    // verify PASS + accept + handoff
    const v3 = await verifyExecution({ projectRoot: root });
    assert.equal(v3.passed, true);
    ({ workflow, state } = await loadProject(root));
    run = await readRun(speccraftDir, runId);
    await accept(speccraftDir, root, workflow, state, run, { by: 'owner', feedback: 'ok' });
    await handoff(speccraftDir, root, 'e2e4', workflow, state, run);

    // 全程 Run ID 不变，3 个 dispatch attempt，无新 stage
    const finalRun = await readRun(speccraftDir, runId);
    assert.equal(finalRun.id, runId);
    assert.equal(finalRun.status, 'handed_off');
    assert.equal(finalRun.verificationAttempts, 3);
    assert.equal(finalRun.acceptance.attempt, 2); // reject + accept

    const dispatchDirs = (await readdir(path.join(speccraftDir, 'runs', runId, 'dispatch'))).filter((d) => /^attempt-\d+$/.test(d));
    assert.deepEqual(dispatchDirs.sort(), ['attempt-001', 'attempt-002', 'attempt-003']);

    // 只有一个 run，16 stage
    const runDirs = (await readdir(path.join(speccraftDir, 'runs'))).filter((d) => !d.startsWith('.'));
    assert.equal(runDirs.length, 1);
    const { state: st } = await loadProject(root);
    assert.equal(Object.keys(st.stages).length, 16);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

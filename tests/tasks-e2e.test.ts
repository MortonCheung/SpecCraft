import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, mkdtemp, rm } from 'node:fs/promises';
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
import { compileTaskGraph } from '../src/core/tasks/compiler.js';
import { dispatchTask } from '../src/core/tasks/dispatch.js';
import { verifyTask } from '../src/core/tasks/verification/lifecycle.js';
import { reopenTask } from '../src/core/tasks/rework.js';
import { executeTaskGraph } from '../src/core/tasks/orchestrator.js';
import { readTaskManifest, readAllTaskManifests } from '../src/core/tasks/store.js';
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

async function makeArtifact(speccraftDir: string, workflow: Workflow, state: State, stageId: string): Promise<void> {
  const stage = workflow.stages.find((s) => s.id === stageId)!;
  const target = completeStage(workflow, state, stageId);
  const body = await resolveTemplateContent(stage.template ?? stage.id);
  const artifact = createArtifact({ artifact: stage.produces[0], stage: stageId, status: target, version: 1 }, body);
  await writeArtifact(path.join(speccraftDir, 'artifacts', artifactFileName(stage.produces[0])), artifact);
}

const TASK_BLOCK = [
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
  '    verification: { commands: [echo ok], timeout_seconds: 30 }',
  '  - id: b',
  '    title: B',
  '    summary: Do B',
  '    depends_on: [a]',
  '    scope: { paths: [src/b/**] }',
  '    verification: { commands: [echo ok], timeout_seconds: 30 }',
  '  - id: c',
  '    title: C',
  '    summary: Do C',
  '    depends_on: [a]',
  '    scope: { paths: [src/c/**] }',
  '    verification: { commands: [echo ok], timeout_seconds: 30 }',
  '  - id: d',
  '    title: D',
  '    summary: Do D',
  '    depends_on: [b, c]',
  '    scope: { paths: [src/d/**] }',
  '    verification: { commands: [echo ok], timeout_seconds: 30 }',
  '```',
].join('\n');

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
      env: { FAKE_AGENT_MODE: mode, FAKE_AGENT_SESSION: `sess-${Math.random().toString(16).slice(2, 6)}` },
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

async function makeReadyProject(): Promise<{ root: string; speccraftDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-v05-'));
  const { speccraftDir } = await initProject({ projectRoot: root });
  const { workflow, state } = await loadProject(root);
  for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
    await makeArtifact(speccraftDir, workflow, state, id);
  }
  approveStage(workflow, state, 'design', 'owner');
  for (const id of ['build-brief', 'site-survey', 'execution-manual']) {
    await makeArtifact(speccraftDir, workflow, state, id);
  }
  // 覆盖 execution-manual 为含 task graph block 的正文
  const { readArtifact } = await import('../src/core/artifacts/store.js');
  const manualPath = path.join(speccraftDir, 'artifacts', 'execution-manual.md');
  const manual = await readArtifact(manualPath);
  manual.body = TASK_BLOCK;
  await writeArtifact(manualPath, manual);

  const { writeState } = await import('../src/core/state/store.js');
  await writeState(speccraftDir, state);

  await writeFile(
    path.join(speccraftDir, 'project.yaml'),
    'name: v05\nexecution:\n  default_adapter: fake\nverification:\n  timeout_seconds: 60\n  commands:\n    - "true"\n',
    'utf8',
  );
  return { root, speccraftDir };
}

test('M5.9 E2E：A/B dispatch+verify PASS，C verify FAIL → D blocked，reopen C → 全部 complete → execute → reject → reopen cascade → accept → handoff', async () => {
  registerAdapter(makeFakeAdapter('jsonl'));
  const { root, speccraftDir } = await makeReadyProject();
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake' });
    const runIdAtStart = runId;

    // tasks compile
    const { readExecutionManualBody } = await import('../src/core/tasks/compiler.js');
    const manualBody = await readExecutionManualBody(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody, source: 'execution-manual' });

    const adapter = makeFakeAdapter('jsonl');
    const dispatchOpts = { speccraftDir, projectRoot: root, runId, adapter, runContext: '# ctx', executionGuard: '# guard', freshSession: true };
    const { persistRefreshedStates } = await import('../src/core/tasks/orchestrator.js');
    const { refreshStates } = await import('../src/core/tasks/dependency.js');
    const { readTaskGraph } = await import('../src/core/tasks/store.js');
    const refreshPersist = async () => {
      const g = await readTaskGraph(speccraftDir, runId);
      const ms = await readAllTaskManifests(speccraftDir, runId);
      await persistRefreshedStates(speccraftDir, runId, g, refreshStates(g, ms), ms);
    };

    // A dispatch + verify PASS
    await dispatchTask({ ...dispatchOpts, taskId: 'a' });
    await verifyTask({ speccraftDir, projectRoot: root, runId, taskId: 'a', verification: { commands: ['echo ok'], timeoutSeconds: 30 } });
    assert.equal((await readTaskManifest(speccraftDir, runId, 'a'))?.status, 'completed');
    await refreshPersist();

    // B dispatch + verify PASS
    await dispatchTask({ ...dispatchOpts, taskId: 'b' });
    await verifyTask({ speccraftDir, projectRoot: root, runId, taskId: 'b', verification: { commands: ['echo ok'], timeoutSeconds: 30 } });
    assert.equal((await readTaskManifest(speccraftDir, runId, 'b'))?.status, 'completed');
    await refreshPersist();

    // C dispatch + verify FAIL → C failed, D blocked
    await dispatchTask({ ...dispatchOpts, taskId: 'c' });
    await verifyTask({ speccraftDir, projectRoot: root, runId, taskId: 'c', verification: { commands: ['exit 1'], timeoutSeconds: 30 } });
    assert.equal((await readTaskManifest(speccraftDir, runId, 'c'))?.status, 'failed');
    await refreshPersist();
    // D 应 blocked
    const manifests = await readAllTaskManifests(speccraftDir, runId);
    const statuses = refreshStates(await readTaskGraph(speccraftDir, runId), manifests);
    assert.equal(statuses.get('d'), 'blocked');
    // Run ID 未变
    assert.equal((await readRun(speccraftDir, runId)).id, runIdAtStart);

    // reopen C（重新 dispatch SAME Task C + verify PASS）
    await reopenTask({ speccraftDir, runId, taskId: 'c', cascade: false });
    await dispatchTask({ ...dispatchOpts, taskId: 'c' });
    await verifyTask({ speccraftDir, projectRoot: root, runId, taskId: 'c', verification: { commands: ['echo ok'], timeoutSeconds: 30 } });
    assert.equal((await readTaskManifest(speccraftDir, runId, 'c'))?.status, 'completed');
    await refreshPersist();

    // D dispatch + verify PASS → 全部 completed
    await dispatchTask({ ...dispatchOpts, taskId: 'd' });
    await verifyTask({ speccraftDir, projectRoot: root, runId, taskId: 'd', verification: { commands: ['echo ok'], timeoutSeconds: 30 } });
    assert.equal((await readTaskManifest(speccraftDir, runId, 'd'))?.status, 'completed');
    await refreshPersist();

    // execute（聚合 finish）→ awaiting_verification
    const exe = await executeTaskGraph({ speccraftDir, projectRoot: root, runId, adapter, runContext: '# ctx', executionGuard: '# guard' });
    assert.equal(exe.complete, true);
    assert.equal((await readRun(speccraftDir, runId)).status, 'awaiting_verification');

    // Run verify PASS
    const v = await verifyExecution({ projectRoot: root });
    assert.equal(v.passed, true);

    // Owner REJECT
    let { workflow, state } = await loadProject(root);
    let run = await readRun(speccraftDir, runId);
    await reject(speccraftDir, root, workflow, state, run, { feedback: '体验不合格' });

    // 显式 reopen C --cascade → C/D 重新施工，Task ID 不变，旧 evidence 保留
    const reopen = await reopenTask({ speccraftDir, runId, taskId: 'c', cascade: true });
    assert.ok(reopen.reopened.includes('c'));
    assert.ok(reopen.reopened.includes('d'));

    // C/D 重新 dispatch + verify PASS
    await dispatchTask({ ...dispatchOpts, taskId: 'c', freshSession: true });
    await verifyTask({ speccraftDir, projectRoot: root, runId, taskId: 'c', verification: { commands: ['echo ok'], timeoutSeconds: 30 } });
    await refreshPersist();
    await dispatchTask({ ...dispatchOpts, taskId: 'd', freshSession: true });
    await verifyTask({ speccraftDir, projectRoot: root, runId, taskId: 'd', verification: { commands: ['echo ok'], timeoutSeconds: 30 } });
    await refreshPersist();

    // 再次聚合 finish
    await executeTaskGraph({ speccraftDir, projectRoot: root, runId, adapter, runContext: '# ctx', executionGuard: '# guard' });

    // Run verify PASS + accept + handoff
    const v2 = await verifyExecution({ projectRoot: root });
    assert.equal(v2.passed, true);
    ({ workflow, state } = await loadProject(root));
    run = await readRun(speccraftDir, runId);
    await accept(speccraftDir, root, workflow, state, run, { by: 'owner', feedback: 'ok' });
    await handoff(speccraftDir, root, 'v05', workflow, state, run);

    // 最终断言
    const finalRun = await readRun(speccraftDir, runId);
    assert.equal(finalRun.id, runIdAtStart); // Run ID 全程不变
    assert.equal(finalRun.status, 'handed_off');

    // Task history 存在于 handoff package
    const handoffDir = path.join(speccraftDir, 'handoffs', 'handoff-001');
    assert.equal(await exists(path.join(handoffDir, 'task-history.md')), true);
    const taskHistory = await readFile(path.join(handoffDir, 'task-history.md'), 'utf8');
    assert.match(taskHistory, /Task 最终状态/);
    assert.match(taskHistory, /- a: completed/);
    assert.match(taskHistory, /reopened count/);

    // 16 stage 保持
    const { state: finalState } = await loadProject(root);
    assert.equal(Object.keys(finalState.stages).length, 16);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

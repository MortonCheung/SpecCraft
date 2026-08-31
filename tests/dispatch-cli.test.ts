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
import { cmdDispatch, cmdAdaptersList, cmdAdaptersDoctor } from '../src/cli/commands.js';
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

/** 一个以 fake-agent 为后端、prepare 复用 manual 的 cli adapter */
function makeFakeCliAdapter(): CliExecutionAdapter {
  return {
    id: 'fake',
    kind: 'cli',
    capabilities: {
      invoke: true, resume: true, structuredOutput: true,
      finalMessageFile: true, sessionId: true, modelSelection: false,
    },
    prepare: manualAdapter.prepare,
    probe: async () => ({ id: 'fake', installed: true, version: '1.0.0' }),
    buildInvocation: async (input) => ({
      command: 'node',
      args: [fakeAgentPath],
      cwd: input.projectRoot,
      stdin: input.prompt,
      env: { FAKE_AGENT_MODE: 'jsonl', FAKE_AGENT_SESSION: 'session-fake-1' },
      timeoutMs: 10000,
    }),
    normalize: async (input): Promise<NormalizedDispatchResult> => {
      let sessionId: string | undefined;
      let finalMessage: string | undefined;
      const events: NormalizedDispatchResult['events'] = [];
      for (const line of input.stdout.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.session_id) sessionId = obj.session_id;
          if (obj.type === 'final_message') finalMessage = obj.text;
          if (obj.type === 'tool_call') events.push({ type: 'tool_call', tool: obj.tool });
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
        events,
      };
    },
  };
}

async function makeReadyProject(defaultAdapter: string, commands: string[] = ['true']): Promise<{ root: string; speccraftDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-dcli-'));
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
      'name: dcli',
      'execution:',
      `  default_adapter: ${defaultAdapter}`,
      'verification:',
      '  timeout_seconds: 60',
      '  commands:',
      ...commands.map((c) => `    - "${c}"`),
    ].join('\n'),
    'utf8',
  );
  return { root, speccraftDir };
}

test('M4.8：adapters list 列出 5 个内置 adapter', async () => {
  const chunks: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => chunks.push(a.map(String).join(' '));
  try {
    await cmdAdaptersList('/tmp');
  } finally {
    console.log = orig;
  }
  const out = chunks.join('\n');
  for (const id of ['manual', 'codex', 'claude', 'opencode', 'trae']) {
    assert.ok(out.includes(id), `list 应包含 ${id}`);
  }
});

test('M4.8：adapters doctor 未安装时给清晰诊断而非 crash', async () => {
  const code = await cmdAdaptersDoctor('no-such-adapter', '/tmp');
  assert.equal(code, 1);
});

test('M4.8：dispatch 完整流程（fake adapter）成功 → implementation completed + agent-report', async () => {
  registerAdapter(makeFakeCliAdapter());
  const { root, speccraftDir } = await makeReadyProject('fake');
  try {
    await prepareExecution({ projectRoot: root, adapterId: 'fake' });

    const code = await cmdDispatch({ adapter: 'fake' }, root);
    assert.equal(code, 0);

    const { state } = await loadProject(root);
    assert.equal(state.stages['implementation'].status, 'completed');
    assert.equal(state.current_stage, 'verification');

    const run = await readRun(speccraftDir, state.active_run!);
    assert.equal(run.status, 'awaiting_verification');
    assert.equal(run.reports.length, 1);
    assert.equal(run.reports[0].file, 'agent-report-001.md');

    // dispatch attempt 证据存在
    const attemptDir = path.join(speccraftDir, 'runs', run.id, 'dispatch', 'attempt-001');
    assert.equal(await exists(path.join(attemptDir, 'manifest-001.yaml')), true);
    assert.equal(await exists(path.join(attemptDir, 'stdout.log')), true);

    // 报告内容来自 finalMessage
    const report = await readFile(path.join(speccraftDir, 'runs', run.id, 'agent-report-001.md'), 'utf8');
    assert.match(report, /completed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M4.8：dispatch FAIL → implementation 保持 in_progress，verification 不开始', async () => {
  registerAdapter(makeFakeCliAdapter());
  const { root, speccraftDir } = await makeReadyProject('fake');
  try {
    await prepareExecution({ projectRoot: root, adapterId: 'fake' });

    // 改用失败模式：覆盖注册一个 fail 版 adapter
    registerAdapter({ ...makeFakeCliAdapter(), buildInvocation: async (input) => ({
      command: 'node', args: [fakeAgentPath], cwd: input.projectRoot,
      stdin: input.prompt, env: { FAKE_AGENT_MODE: 'fail' }, timeoutMs: 10000,
    }) });

    const code = await cmdDispatch({ adapter: 'fake' }, root);
    assert.equal(code, 1);

    const { state } = await loadProject(root);
    assert.equal(state.stages['implementation'].status, 'in_progress');
    assert.notEqual(state.stages['verification'].status, 'completed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M4.8：manual adapter 不支持 dispatch', async () => {
  const { root } = await makeReadyProject('manual');
  try {
    await prepareExecution({ projectRoot: root }); // manual
    const code = await cmdDispatch({}, root);
    assert.equal(code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

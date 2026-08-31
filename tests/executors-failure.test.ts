/**
 * M7.8 — Failure & Rework Semantics 冻结测试（ADR 0008 §58、§59）。
 *
 * 覆盖：
 *   1. §58.1 cmdExecute：adapter 未安装 → preflight FAIL + 零副作用
 *      （no implementStart / no worktree / no task status change / no dispatch attempt）
 *   2. §58.1 cmdDispatch --task：单 Task adapter 未安装 → preflight blocked
 *   3. §58.2/§58.6 Provider spawn failure：task → failed，禁止 fallback
 *      （只有 assigned adapter 的 dispatch attempt）
 *   4. §58.3 Retry：Dispatch FAIL → reopen → 再次 dispatch 仍同一 executor
 *   5. §58.4 Owner rework：新 Workspace Attempt 后 executor 仍不变
 *   6. §58.5 project.yaml 修改：当前 Run 仍使用 frozen plan.yaml assignment
 *   7. §59 Executor Plan Recompile Guard：evidence 存在时 tasks compile 拒绝覆盖
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initProject } from '../src/core/init.js';
import { loadProject, loadProjectConfig } from '../src/core/project.js';
import { completeStage, approveStage } from '../src/core/advance.js';
import { writeArtifact, createArtifact, readArtifact, artifactFileName } from '../src/core/artifacts/store.js';
import { resolveTemplateContent } from '../src/core/templates/resolver.js';
import { prepareExecution } from '../src/core/execution/prepare.js';
import { readRun } from '../src/core/execution/store.js';
import { registerAdapter, getAdapter } from '../src/core/execution/adapters/registry.js';
import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import type { CliExecutionAdapter, NormalizedDispatchResult } from '../src/core/execution/adapters/types.js';
import { compileTaskGraph } from '../src/core/tasks/compiler.js';
import { readTaskManifest } from '../src/core/tasks/store.js';
import { readExecutorPlan } from '../src/core/executors/store.js';
import { readDispatchAttempt, listDispatchAttemptsForTask } from '../src/core/dispatch/store.js';
import { writeWorkspace, readWorkspace } from '../src/core/workspaces/store.js';
import { cmdExecute, cmdDispatch, cmdTasksReopen } from '../src/cli/commands.js';
import type { Workflow, State } from '../src/core/types.js';

const fakeAgentPath = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

async function makeArtifact(speccraftDir: string, workflow: Workflow, state: State, stageId: string): Promise<void> {
  const stage = workflow.stages.find((s) => s.id === stageId)!;
  const target = completeStage(workflow, state, stageId);
  const body = await resolveTemplateContent(stage.template ?? stage.id);
  const artifact = createArtifact({ artifact: stage.produces[0], stage: stageId, status: target, version: 1 }, body);
  await writeArtifact(path.join(speccraftDir, 'artifacts', artifactFileName(stage.produces[0])), artifact);
}

async function makeReadyProject(manualBody: string, projectYaml: string): Promise<{ root: string; speccraftDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-v07fail-'));
  const { speccraftDir } = await initProject({ projectRoot: root });
  const { workflow, state } = await loadProject(root);
  for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
    await makeArtifact(speccraftDir, workflow, state, id);
  }
  approveStage(workflow, state, 'design', 'owner');
  for (const id of ['build-brief', 'site-survey', 'execution-manual']) {
    await makeArtifact(speccraftDir, workflow, state, id);
  }
  const manualPath = path.join(speccraftDir, 'artifacts', 'execution-manual.md');
  const manual = await readArtifact(manualPath);
  manual.body = manualBody;
  await writeArtifact(manualPath, manual);
  const { writeState } = await import('../src/core/state/store.js');
  await writeState(speccraftDir, state);
  await writeFile(path.join(speccraftDir, 'project.yaml'), projectYaml, 'utf8');
  return { root, speccraftDir };
}

/** 可配置 probe 的 fake adapter（mode 控制 fake-agent 行为；installed 控制 preflight 结果） */
function makeAdapter(id: string, opts: { mode?: string; installed?: boolean } = {}): CliExecutionAdapter {
  const mode = opts.mode ?? 'jsonl';
  const installed = opts.installed ?? true;
  return {
    id,
    kind: 'cli',
    capabilities: {
      invoke: true, resume: true, structuredOutput: true,
      finalMessageFile: true, sessionId: true, modelSelection: false,
    },
    prepare: manualAdapter.prepare,
    probe: async () => (installed ? { id, installed: true } : { id, installed: false, error: 'not installed' }),
    buildInvocation: async (input) => ({
      command: 'node',
      args: [fakeAgentPath],
      cwd: input.projectRoot,
      stdin: input.prompt,
      env: { FAKE_AGENT_MODE: mode, FAKE_AGENT_SESSION: `sess-${id}-${Math.random().toString(16).slice(2, 6)}` },
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
        adapter: id,
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

/** spawn 失败的 adapter：probe 通过（preflight OK），但真实 spawn 失败 */
function makeSpawnFailAdapter(id: string): CliExecutionAdapter {
  return {
    ...makeAdapter(id, { mode: 'jsonl' }),
    buildInvocation: async (input) => ({
      command: '/nonexistent/speccraft-fake-agent-xyz',
      args: [],
      cwd: input.projectRoot,
      stdin: input.prompt,
      timeoutMs: 10000,
    }),
  };
}

function captureStderr(): { collect: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { chunks.push(args.map(String).join(' ')); };
  return {
    collect: () => chunks.join('\n'),
    restore: () => { console.error = original; },
  };
}

/** 读取某 task 最新 dispatch attempt 的 manifest */
async function latestDispatch(speccraftDir: string, runId: string, taskId: string) {
  const attempts = await listDispatchAttemptsForTask(speccraftDir, runId, taskId);
  assert.ok(attempts.length > 0, `task ${taskId} 应有 dispatch attempt`);
  return readDispatchAttempt(speccraftDir, runId, attempts[attempts.length - 1]);
}

const VERIF_OK = 'verification: { commands: [echo ok], timeout_seconds: 30 }';

function makeSingleTaskBlock(id: string, executor: string, verif: string = VERIF_OK): string {
  return [
    '# Execution Manual',
    '',
    '## Execution Task Graph',
    '',
    '```speccraft-task-graph',
    'version: 1',
    '',
    'tasks:',
    `  - id: ${id}
    title: ${id.toUpperCase()}
    summary: Do ${id}
    executor: ${executor}
    depends_on: []
    scope: { paths: [src/${id}/**] }
    ${verif}`,
    '```',
  ].join('\n');
}

const SEQ_BLOCK = [
  '# Execution Manual',
  '',
  '## Execution Task Graph',
  '',
  '```speccraft-task-graph',
  'version: 1',
  '',
  'tasks:',
  `  - id: a
    title: A
    summary: Do A
    executor: alpha
    depends_on: []
    scope: { paths: [src/a/**] }
    ${VERIF_OK}`,
  `  - id: b
    title: B
    summary: Do B
    executor: beta
    depends_on: [a]
    scope: { paths: [src/b/**] }
    ${VERIF_OK}`,
  '```',
].join('\n');

function makeProjectYaml(adapterIds: string[], executors: Record<string, string>): string {
  const lines = ['name: v07-failure', 'execution:'];
  lines.push('  default_adapter: fake-alpha');
  lines.push('  adapters:');
  for (const id of adapterIds) lines.push(`    ${id}:`, '      timeout_seconds: 60');
  lines.push('  default_executor: primary');
  lines.push('  executors:');
  for (const [id, adapter] of Object.entries(executors)) lines.push(`    ${id}:`, `      adapter: ${adapter}`);
  lines.push('verification:', '  timeout_seconds: 60', '  commands:', '    - "true"');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// §58.1 Executor unavailable before execution
// ---------------------------------------------------------------------------

test('M7.8 §58.1：cmdExecute — adapter 未安装 → preflight FAIL + 零副作用', async () => {
  registerAdapter(makeAdapter('fake-alpha'));
  registerAdapter(makeAdapter('fake-gone', { installed: false }));
  const projectYaml = makeProjectYaml(['fake-alpha', 'fake-gone'], { alpha: 'fake-alpha', beta: 'fake-gone' });
  const { root, speccraftDir } = await makeReadyProject(SEQ_BLOCK, projectYaml);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: SEQ_BLOCK, source: 'execution-manual', projectConfig });

    const stderr = captureStderr();
    const code = await cmdExecute({}, root);
    const out = stderr.collect();
    stderr.restore();

    assert.equal(code, 1);
    assert.ok(out.includes('execution preflight blocked'), `stderr 应含 preflight blocked：${out}`);
    assert.ok(out.includes('executor_unavailable'), `stderr 应含 reason：${out}`);

    // 零副作用：no task status change / no dispatch attempt / no implementStart
    const initialStatus: Record<string, string> = { a: 'ready', b: 'pending' };
    for (const id of ['a', 'b']) {
      const m = await readTaskManifest(speccraftDir, runId, id);
      assert.ok(m, `task ${id} manifest 应存在`);
      assert.equal(m.status, initialStatus[id], `task ${id} status 不应改变`);
      const attempts = await listDispatchAttemptsForTask(speccraftDir, runId, id);
      assert.equal(attempts.length, 0, `task ${id} 不应有 dispatch attempt`);
    }
    const run = await readRun(speccraftDir, runId);
    assert.equal(run.status, 'prepared', 'implementStart 不应执行（run 仍 prepared）');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M7.8 §58.1：cmdDispatch --task — 单 Task adapter 未安装 → preflight blocked + 零副作用', async () => {
  registerAdapter(makeAdapter('fake-gone2', { installed: false }));
  const projectYaml = makeProjectYaml(['fake-gone2'], { beta: 'fake-gone2' });
  const block = makeSingleTaskBlock('b', 'beta');
  const { root, speccraftDir } = await makeReadyProject(block, projectYaml);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-gone2' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: block, source: 'execution-manual', projectConfig });

    const stderr = captureStderr();
    const code = await cmdDispatch({ task: 'b' }, root);
    const out = stderr.collect();
    stderr.restore();

    assert.equal(code, 1);
    assert.ok(out.includes('execution preflight blocked'), `stderr 应含 preflight blocked：${out}`);

    const m = await readTaskManifest(speccraftDir, runId, 'b');
    assert.equal(m.status, 'ready', 'task 状态不应改变');
    const attempts = await listDispatchAttemptsForTask(speccraftDir, runId, 'b');
    assert.equal(attempts.length, 0, '不应有 dispatch attempt');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §58.2 Provider spawn failure + §58.6 No auto fallback
// ---------------------------------------------------------------------------

test('M7.8 §58.2/§58.6：spawn_error → task failed，禁止 fallback（仅 assigned adapter attempt）', async () => {
  registerAdapter(makeSpawnFailAdapter('fake-spawn'));
  const projectYaml = makeProjectYaml(['fake-spawn'], { alpha: 'fake-spawn' });
  const block = makeSingleTaskBlock('a', 'alpha');
  const { root, speccraftDir } = await makeReadyProject(block, projectYaml);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-spawn' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: block, source: 'execution-manual', projectConfig });

    const stderr = captureStderr();
    const code = await cmdDispatch({ task: 'a' }, root);
    stderr.restore();

    assert.equal(code, 1);
    // 当前 Task failure 语义：task → failed
    const m = await readTaskManifest(speccraftDir, runId, 'a');
    assert.equal(m.status, 'failed', 'spawn_error 应使 task failed');
    assert.ok(m.lastError?.includes('spawn_error'), `lastError 应含 spawn_error：${m.lastError}`);

    // §58.6：只有 assigned adapter 的一个 dispatch attempt，无其它 adapter 尝试
    const attempts = await listDispatchAttemptsForTask(speccraftDir, runId, 'a');
    assert.equal(attempts.length, 1, '应恰好一个 dispatch attempt（禁止 fallback）');
    const d = await readDispatchAttempt(speccraftDir, runId, attempts[0]);
    assert.equal(d.adapter, 'fake-spawn');
    assert.equal(d.executor_profile, 'alpha');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §58.3 Retry：Dispatch FAIL → reopen → 再次 dispatch 仍同一 executor
// ---------------------------------------------------------------------------

test('M7.8 §58.3：Retry — dispatch FAIL → reopen → 再次 dispatch 仍同一 executor（不变 primary）', async () => {
  registerAdapter(makeAdapter('fake-beta1', { mode: 'fail' }));
  const projectYaml = makeProjectYaml(['fake-beta1'], { beta: 'fake-beta1' });
  const block = makeSingleTaskBlock('b', 'beta');
  const { root, speccraftDir } = await makeReadyProject(block, projectYaml);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-beta1' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: block, source: 'execution-manual', projectConfig });

    // 第一次 dispatch：FAIL（fake-agent fail 模式 → exit 1）
    let stderr = captureStderr();
    let code = await cmdDispatch({ task: 'b' }, root);
    stderr.restore();
    assert.equal(code, 1);
    let m = await readTaskManifest(speccraftDir, runId, 'b');
    assert.equal(m.status, 'failed');

    // reopen → ready
    await cmdTasksReopen('b', false, root);
    m = await readTaskManifest(speccraftDir, runId, 'b');
    assert.equal(m.status, 'ready');
    assert.equal(m.reopenedCount, 1);

    // 第二次 dispatch：成功（覆盖为成功模式 adapter）
    registerAdapter(makeAdapter('fake-beta1', { mode: 'jsonl' }));
    stderr = captureStderr();
    code = await cmdDispatch({ task: 'b' }, root);
    stderr.restore();
    assert.equal(code, 0);

    // 两次 attempt 的 executor profile / adapter 必须相同（frozen plan）
    const attempts = await listDispatchAttemptsForTask(speccraftDir, runId, 'b');
    assert.equal(attempts.length, 2);
    const d1 = await readDispatchAttempt(speccraftDir, runId, attempts[0]);
    const d2 = await readDispatchAttempt(speccraftDir, runId, attempts[1]);
    assert.equal(d1.executor_profile, 'beta');
    assert.equal(d1.adapter, 'fake-beta1');
    assert.equal(d2.executor_profile, 'beta', 'retry 后 executor 不能变 primary');
    assert.equal(d2.adapter, 'fake-beta1');
    m = await readTaskManifest(speccraftDir, runId, 'b');
    assert.equal(m.status, 'in_progress');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §58.4 Owner rework：integrated → reject → reopen → 新 Workspace Attempt 仍同一 executor
// ---------------------------------------------------------------------------

test('M7.8 §58.4：Owner rework — 新 Workspace Attempt 后 executor 仍不变', async () => {
  registerAdapter(makeAdapter('fake-beta2'));
  const projectYaml = makeProjectYaml(['fake-beta2'], { beta: 'fake-beta2' });
  const block = makeSingleTaskBlock('b', 'beta');
  const { root, speccraftDir } = await makeReadyProject(block, projectYaml);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-beta2' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: block, source: 'execution-manual', projectConfig });

    // 第一次 dispatch：成功（in_progress）
    const stderr = captureStderr();
    const code = await cmdDispatch({ task: 'b' }, root);
    stderr.restore();
    assert.equal(code, 0);

    // 模拟已集成：写入一个 integrated Workspace Attempt（executorProfile: beta）
    await writeWorkspace(speccraftDir, runId, 'b', {
      version: 1,
      runId,
      taskId: 'b',
      attempt: 1,
      status: 'integrated',
      workspaceRoot: path.join(root, '.tmp-ws-b'),
      branch: 'task/b',
      baseCommit: '0'.repeat(40),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dispatchAttempts: [1],
      verificationAttempts: [],
      changedPaths: [],
      scopeAudit: { declared: [], actual: [], passed: true, violations: [] },
      executorProfile: 'beta',
      adapter: 'fake-beta2',
    });

    // Owner reject → reopen → 新的 Workspace Attempt 仍用 frozen assignment
    await cmdTasksReopen('b', false, root);
    const m = await readTaskManifest(speccraftDir, runId, 'b');
    assert.equal(m.status, 'ready');

    const stderr2 = captureStderr();
    const code2 = await cmdDispatch({ task: 'b' }, root);
    stderr2.restore();
    assert.equal(code2, 0);

    const attempts = await listDispatchAttemptsForTask(speccraftDir, runId, 'b');
    assert.equal(attempts.length, 2);
    const d2 = await readDispatchAttempt(speccraftDir, runId, attempts[1]);
    assert.equal(d2.executor_profile, 'beta', 'rework 后 executor 仍不变');
    assert.equal(d2.adapter, 'fake-beta2');

    // workspace attempt 1 的 executorProfile 也记录 beta（§55 invariant 8/12 冻结）
    const ws = await readWorkspace(speccraftDir, runId, 'b', 1);
    assert.equal(ws?.executorProfile, 'beta');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §58.5 project.yaml 修改：当前 Run 仍使用 frozen plan.yaml assignment
// ---------------------------------------------------------------------------

test('M7.8 §58.5：project.yaml 修改不影响当前 Run（frozen plan 不偷换 Provider）', async () => {
  registerAdapter(makeAdapter('fake-alpha3'));
  registerAdapter(makeAdapter('fake-beta3'));
  const projectYaml = makeProjectYaml(['fake-alpha3', 'fake-beta3'], { alpha: 'fake-alpha3' });
  const block = makeSingleTaskBlock('a', 'alpha');
  const { root, speccraftDir } = await makeReadyProject(block, projectYaml);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha3' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: block, source: 'execution-manual', projectConfig });

    // 用户修改 project.yaml：alpha → fake-beta3
    const newYaml = makeProjectYaml(['fake-alpha3', 'fake-beta3'], { alpha: 'fake-beta3' });
    await writeFile(path.join(speccraftDir, 'project.yaml'), newYaml, 'utf8');

    // 当前 Run：plan.yaml 已冻结，assignment 不变
    const plan = await readExecutorPlan(speccraftDir, runId);
    assert.equal(plan.assignments[0].adapter, 'fake-alpha3', 'frozen plan 不能被 project.yaml 修改影响');

    // dispatch 仍走 fake-alpha3（不是 fake-beta3）
    const stderr = captureStderr();
    const code = await cmdDispatch({ task: 'a' }, root);
    stderr.restore();
    assert.equal(code, 0);
    const d = await latestDispatch(speccraftDir, runId, 'a');
    assert.equal(d.adapter, 'fake-alpha3', '不能偷偷切换 Provider');
    assert.equal(d.executor_profile, 'alpha');

    // 新配置只影响 future plan：重建后（新 evidence 前无 evidence？有 dispatch evidence，§59 会阻止）
    // —— §58.5 只需证明当前 Run 不变，future plan 由 §59 保护
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §59 Executor Plan Recompile Guard
// ---------------------------------------------------------------------------

test('M7.8 §59：dispatch evidence 存在时 tasks compile 拒绝覆盖 Executor Plan', async () => {
  registerAdapter(makeAdapter('fake-alpha4'));
  const projectYaml = makeProjectYaml(['fake-alpha4'], { alpha: 'fake-alpha4' });
  const block = makeSingleTaskBlock('a', 'alpha');
  const { root, speccraftDir } = await makeReadyProject(block, projectYaml);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha4' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: block, source: 'execution-manual', projectConfig });

    // 第一次 dispatch：成功（产生 dispatch evidence）
    const stderr = captureStderr();
    const code = await cmdDispatch({ task: 'a' }, root);
    stderr.restore();
    assert.equal(code, 0);

    // 再次 compile：必须拒绝（§59：dispatchAttempts > 0 → 不得覆盖 Executor Plan）
    await assert.rejects(
      compileTaskGraph({ speccraftDir, runId, manualBody: block, source: 'execution-manual', projectConfig }),
      /cannot rebuild task\/executor plan after execution evidence exists/,
    );

    // plan 未变（executor 仍 alpha）
    const plan = await readExecutorPlan(speccraftDir, runId);
    assert.equal(plan.assignments[0].executor, 'alpha');
    assert.equal(plan.assignments[0].adapter, 'fake-alpha4');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

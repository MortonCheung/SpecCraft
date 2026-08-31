/**
 * M7.7 — Executor Runtime Integration 测试（v0.7 §51-§56）。
 *
 * 覆盖：
 *   1. §52 cmdStatus：Executors / Assignments 摘要；legacy 无 plan 不打印
 *   2. §53 cmdTasksShow：Executor / Adapter / Assignment source（plan + legacy）
 *   3. §54 cmdNext：plan 未生成 → "Compile Task Graph / Executor Plan first."
 *        adapter unavailable → "Execution blocked: ... speccraft executors doctor"
 *   4. §51 cmdDispatch --task：hooks env 注入 SPECCRAFT_EXECUTOR_PROFILE / SPECCRAFT_TASK_ID
 *   5. §55 cmdValidate：Executor invariants（pass / run_id tamper / dispatch mismatch）
 *   6. §56 Handoff：executor-history.md 内容 + manifest.yaml files 更新（含 legacy）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdtemp, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initProject } from '../src/core/init.js';
import { loadProject, loadProjectConfig } from '../src/core/project.js';
import { completeStage, approveStage } from '../src/core/advance.js';
import { writeArtifact, createArtifact, readArtifact, artifactFileName } from '../src/core/artifacts/store.js';
import { resolveTemplateContent } from '../src/core/templates/resolver.js';
import { prepareExecution } from '../src/core/execution/prepare.js';
import { createRun, readRun } from '../src/core/execution/store.js';
import { registerAdapter } from '../src/core/execution/adapters/registry.js';
import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import type { CliExecutionAdapter, NormalizedDispatchResult } from '../src/core/execution/adapters/types.js';
import { compileTaskGraph } from '../src/core/tasks/compiler.js';
import { writeTaskGraph, createTaskManifest } from '../src/core/tasks/store.js';
import { writeExecutorPlan } from '../src/core/executors/store.js';
import { writeDispatchAttempt } from '../src/core/dispatch/store.js';
import { cmdStatus, cmdNext, cmdTasksShow, cmdDispatch, cmdValidate } from '../src/cli/commands.js';
import { compileHandoffPackage } from '../src/core/handoff/package.js';
import type { Workflow, State } from '../src/core/types.js';
import type { ExecutorPlan } from '../src/core/executors/types.js';
import type { TaskGraph } from '../src/core/tasks/types.js';

const fakeAgentPath = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// 基础设施（与 executors-sequential.test.ts 一致）
// ---------------------------------------------------------------------------

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

async function makeReadyProject(manualBody: string, projectYaml: string): Promise<{ root: string; speccraftDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-v07rt-'));
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

function makeNamedAdapter(id: string, mode = 'jsonl'): CliExecutionAdapter {
  return {
    id,
    kind: 'cli',
    capabilities: {
      invoke: true, resume: true, structuredOutput: true,
      finalMessageFile: true, sessionId: true, modelSelection: false,
    },
    prepare: manualAdapter.prepare,
    probe: async () => ({ id, installed: true }),
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

function captureStdout(): { collect: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { chunks.push(args.map(String).join(' ')); };
  return {
    collect: () => chunks.join('\n'),
    restore: () => { console.log = original; },
  };
}

const VERIF_OK = 'verification: { commands: [echo ok], timeout_seconds: 30 }';

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
  `  - id: c
    title: C
    summary: Do C
    executor: alpha
    depends_on: [b]
    scope: { paths: [src/c/**] }
    ${VERIF_OK}`,
  '```',
].join('\n');

const SEQ_PROJECT_YAML = [
  'name: v07-seq',
  'execution:',
  '  default_adapter: fake-alpha',
  '  adapters:',
  '    fake-alpha:',
  '      timeout_seconds: 60',
  '    fake-beta:',
  '      timeout_seconds: 60',
  '  default_executor: primary',
  '  executors:',
  '    alpha:',
  '      adapter: fake-alpha',
  '    beta:',
  '      adapter: fake-beta',
  'verification:',
  '  timeout_seconds: 60',
  '  commands:',
  '    - "true"',
].join('\n');

// ---------------------------------------------------------------------------
// §52 cmdStatus：Executors / Assignments 摘要
// ---------------------------------------------------------------------------

test('M7.7 §52：cmdStatus 显示 Executors / Assignments 摘要', async () => {
  registerAdapter(makeNamedAdapter('fake-alpha'));
  registerAdapter(makeNamedAdapter('fake-beta'));
  const { root, speccraftDir } = await makeReadyProject(SEQ_BLOCK, SEQ_PROJECT_YAML);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: SEQ_BLOCK, source: 'execution-manual', projectConfig });

    const out = await captureStdout();
    try {
      await cmdStatus(root);
    } finally {
      out.restore();
    }
    const text = out.collect();
    assert.match(text, /Executors:/);
    assert.match(text, /alpha → fake-alpha/);
    assert.match(text, /beta → fake-beta/);
    assert.match(text, /Assignments:/);
    assert.match(text, /3 tasks/);
    assert.match(text, /2 executors/);
    assert.match(text, /2 adapters/);
    // sequential route：无 parallel wave → 不显示 active executor capacity
    assert.doesNotMatch(text, /active executor capacity/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M7.7 §52：legacy（无 Executor Plan）不打印 Executors 区块', async () => {
  registerAdapter(makeNamedAdapter('fake-alpha'));
  const { root, speccraftDir } = await makeReadyProject(SEQ_BLOCK, SEQ_PROJECT_YAML);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    // 不传 projectConfig → 只生成 graph，不生成 plan（legacy 路径）
    await compileTaskGraph({ speccraftDir, runId, manualBody: SEQ_BLOCK, source: 'execution-manual' });

    const out = await captureStdout();
    try {
      await cmdStatus(root);
    } finally {
      out.restore();
    }
    assert.doesNotMatch(out.collect(), /Executors:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §53 cmdTasksShow：Executor / Adapter / Assignment source
// ---------------------------------------------------------------------------

test('M7.7 §53：cmdTasksShow 显示 executor / adapter / assignment source（plan）', async () => {
  registerAdapter(makeNamedAdapter('fake-alpha'));
  registerAdapter(makeNamedAdapter('fake-beta'));
  const { root, speccraftDir } = await makeReadyProject(SEQ_BLOCK, SEQ_PROJECT_YAML);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: SEQ_BLOCK, source: 'execution-manual', projectConfig });

    const out = await captureStdout();
    try {
      const code = await cmdTasksShow('a', root);
      assert.equal(code, 0);
    } finally {
      out.restore();
    }
    const text = out.collect();
    assert.match(text, /executor: alpha/);
    assert.match(text, /adapter: fake-alpha/);
    assert.match(text, /assignment source: task/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M7.7 §53：cmdTasksShow 显示 legacy-default（无 plan）', async () => {
  registerAdapter(makeNamedAdapter('fake-alpha'));
  const { root, speccraftDir } = await makeReadyProject(SEQ_BLOCK, SEQ_PROJECT_YAML);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    await compileTaskGraph({ speccraftDir, runId, manualBody: SEQ_BLOCK, source: 'execution-manual' });

    const out = await captureStdout();
    try {
      await cmdTasksShow('a', root);
    } finally {
      out.restore();
    }
    const text = out.collect();
    assert.match(text, /executor: legacy-default/);
    assert.match(text, /adapter: manual/);
    assert.match(text, /assignment source: legacy/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §54 cmdNext：plan 未生成 / adapter unavailable 引导
// ---------------------------------------------------------------------------

test('M7.7 §54：cmdNext — explicit executor 但无 Executor Plan → Compile first', async () => {
  registerAdapter(makeNamedAdapter('fake-alpha'));
  const { root, speccraftDir } = await makeReadyProject(SEQ_BLOCK, SEQ_PROJECT_YAML);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    // explicit task.executor 存在但未 compile plan
    await compileTaskGraph({ speccraftDir, runId, manualBody: SEQ_BLOCK, source: 'execution-manual' });

    const out = await captureStdout();
    try {
      await cmdNext(root);
    } finally {
      out.restore();
    }
    assert.match(out.collect(), /Compile Task Graph \/ Executor Plan first\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M7.7 §54：cmdNext — executor adapter 不可用 → Execution blocked + doctor', async () => {
  registerAdapter(makeNamedAdapter('fake-alpha'));
  // alpha → fake-gone（未注册 adapter）→ diagnostics blocked；beta → fake-alpha
  const goneYaml = [
    'name: v07-gone',
    'execution:',
    '  default_adapter: fake-alpha',
    '  adapters:',
    '    fake-alpha:',
    '      timeout_seconds: 60',
    '    fake-gone:',
    '      timeout_seconds: 60',
    '  default_executor: primary',
    '  executors:',
    '    alpha:',
    '      adapter: fake-gone',
    '    beta:',
    '      adapter: fake-alpha',
    'verification:',
    '  timeout_seconds: 60',
    '  commands:',
    '    - "true"',
  ].join('\n');
  const { root, speccraftDir } = await makeReadyProject(SEQ_BLOCK, goneYaml);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: SEQ_BLOCK, source: 'execution-manual', projectConfig });

    const out = await captureStdout();
    try {
      await cmdNext(root);
    } finally {
      out.restore();
    }
    const text = out.collect();
    assert.match(text, /Execution blocked:/);
    assert.match(text, /executor alpha requires unavailable adapter fake-gone\./);
    assert.match(text, /speccraft executors doctor/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §51 cmdDispatch --task：hooks env 注入 executor profile
// ---------------------------------------------------------------------------

test('M7.7 §51：cmdDispatch --task hooks 注入 SPECCRAFT_EXECUTOR_PROFILE / SPECCRAFT_TASK_ID', async () => {
  registerAdapter(makeNamedAdapter('fake-alpha'));
  registerAdapter(makeNamedAdapter('fake-beta'));
  const hookYaml = SEQ_PROJECT_YAML + '\n' + [
    'hooks:',
    '  before_dispatch:',
    '    - id: dump',
    '      command: echo "event=$SPECCRAFT_EVENT task=$SPECCRAFT_TASK_ID profile=$SPECCRAFT_EXECUTOR_PROFILE adapter=$SPECCRAFT_ADAPTER"',
    '      timeout_seconds: 30',
  ].join('\n');
  const { root, speccraftDir } = await makeReadyProject(SEQ_BLOCK, hookYaml);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: SEQ_BLOCK, source: 'execution-manual', projectConfig });

    const code = await cmdDispatch({ task: 'a' }, root);
    assert.equal(code, 0);

    const logPath = path.join(speccraftDir, 'runs', runId, 'hooks', 'before_dispatch-001.log');
    assert.equal(await exists(logPath), true);
    const log = await readFile(logPath, 'utf8');
    assert.match(log, /event=before_dispatch/);
    assert.match(log, /task=a/);
    assert.match(log, /profile=alpha/);
    assert.match(log, /adapter=fake-alpha/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §55 cmdValidate：Executor invariants
// ---------------------------------------------------------------------------

/** 手工构造 run + graph + plan + task manifests（不执行 dispatch，validate 应 pass） */
async function makeValidateProject(plan?: ExecutorPlan): Promise<{ root: string; speccraftDir: string; runId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-v07val-'));
  const { speccraftDir } = await initProject({ projectRoot: root });
  const run = await createRun(speccraftDir, { id: 'run-v07' });
  const { workflow, state } = await loadProject(root);
  state.active_run = run.id;
  const { writeState } = await import('../src/core/state/store.js');
  await writeState(speccraftDir, state);

  const graph: TaskGraph = {
    version: 1,
    runId: run.id,
    source: 'execution-manual',
    createdAt: new Date().toISOString(),
    tasks: [
      { id: 'a', title: 'A', summary: 'Do A', executor: 'alpha', dependsOn: [], scope: { paths: ['src/a/**'] }, verification: { commands: ['echo ok'], timeoutSeconds: 30 } },
      { id: 'b', title: 'B', summary: 'Do B', executor: 'beta', dependsOn: ['a'], scope: { paths: ['src/b/**'] }, verification: { commands: ['echo ok'], timeoutSeconds: 30 } },
    ],
  };
  await writeTaskGraph(speccraftDir, run.id, graph);
  await createTaskManifest(speccraftDir, run.id, 'a', 'pending');
  await createTaskManifest(speccraftDir, run.id, 'b', 'pending');

  await writeExecutorPlan(speccraftDir, run.id, plan ?? {
    version: 1,
    runId: run.id,
    createdAt: new Date().toISOString(),
    defaultExecutor: 'alpha',
    assignments: [
      { taskId: 'a', executor: 'alpha', source: 'task' as const, adapter: 'fake-alpha', resolved: {} },
      { taskId: 'b', executor: 'beta', source: 'task' as const, adapter: 'fake-beta', resolved: {} },
    ],
  });

  await writeFile(path.join(speccraftDir, 'project.yaml'), SEQ_PROJECT_YAML, 'utf8');
  return { root, speccraftDir, runId: run.id };
}

test('M7.7 §55：validate — Executor Plan invariants pass', async () => {
  const p = await makeValidateProject();
  try {
    const out = await captureStdout();
    try {
      const code = await cmdValidate(p.root);
      out.restore();
      assert.equal(code, 0);
    } finally {
      out.restore();
    }
    assert.match(out.collect(), /校验通过/);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test('M7.7 §55：validate — plan run_id 篡改 → 违规', async () => {
  const p = await makeValidateProject();
  try {
    const planPath = path.join(p.speccraftDir, 'runs', p.runId, 'executors', 'plan.yaml');
    const src = await readFile(planPath, 'utf8');
    await writeFile(planPath, src.replace(/run_id: .+/, 'run_id: run-tampered'), 'utf8');

    const out = await captureStdout();
    try {
      const code = await cmdValidate(p.root);
      assert.equal(code, 1);
    } finally {
      out.restore();
    }
    assert.match(out.collect(), /run_id/);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test('M7.7 §55：validate — dispatch executor_profile 与 assignment 不一致 → 违规', async () => {
  const p = await makeValidateProject();
  try {
    await writeDispatchAttempt(
      p.speccraftDir,
      p.runId,
      {
        attempt: 1,
        adapter: 'fake-alpha',
        status: 'succeeded',
        started_at: '2026-01-01T00:00:00.000Z',
        duration_ms: 100,
        timed_out: false,
        task_id: 'a',
        executor_profile: 'wrong',
        stdout_file: 'stdout.log',
        stderr_file: 'stderr.log',
      },
      { stdout: '', stderr: '' },
    );

    const out = await captureStdout();
    try {
      const code = await cmdValidate(p.root);
      assert.equal(code, 1);
    } finally {
      out.restore();
    }
    assert.match(out.collect(), /executor_profile/);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §56 Handoff：executor-history.md
// ---------------------------------------------------------------------------

test('M7.7 §56：Handoff 包含 executor-history.md + manifest files 更新', async () => {
  registerAdapter(makeNamedAdapter('fake-alpha'));
  registerAdapter(makeNamedAdapter('fake-beta'));
  const { root, speccraftDir } = await makeReadyProject(SEQ_BLOCK, SEQ_PROJECT_YAML);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: SEQ_BLOCK, source: 'execution-manual', projectConfig });

    const { workflow } = await loadProject(root);
    const run = await readRun(speccraftDir, runId);
    const written = await compileHandoffPackage({
      speccraftDir,
      projectRoot: root,
      projectName: 'v07-seq',
      workflow,
      run,
      handoffId: 'handoff-1',
      createdAt: new Date().toISOString(),
    });
    assert.ok(written.includes('executor-history.md'));

    const dir = path.join(speccraftDir, 'handoffs', 'handoff-1');
    const eh = await readFile(path.join(dir, 'executor-history.md'), 'utf8');
    assert.match(eh, /Executor Run: /);
    assert.match(eh, /Executor Profile: alpha/);
    assert.match(eh, /- Adapter: fake-alpha/);
    assert.match(eh, /- Executor Profile: beta/);
    assert.match(eh, /- Adapter: fake-beta/);
    // Task / Dispatch Attempts / Workspace Attempts / Provider Sessions 列存在
    assert.match(eh, /- Dispatch Attempts: \[无\]/);
    assert.match(eh, /- Workspace Attempts: \[无\]/);
    assert.match(eh, /- Provider Sessions: \[无\]/);

    const manifestYaml = await readFile(path.join(dir, 'manifest.yaml'), 'utf8');
    assert.match(manifestYaml, /executor-history\.md/);
    assert.match(manifestYaml, /task-history\.md/);
    assert.match(manifestYaml, /workspace-history\.md/);

    // HANDOFF.md 摘要段
    const handoffDoc = await readFile(path.join(dir, 'HANDOFF.md'), 'utf8');
    assert.match(handoffDoc, /Executor history 摘要/);
    assert.match(handoffDoc, /Executor Profile: alpha/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M7.7 §56：Handoff — legacy 无 plan → executor-history.md 占位说明', async () => {
  const { root, speccraftDir } = await makeReadyProject(SEQ_BLOCK, SEQ_PROJECT_YAML);
  try {
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    await compileTaskGraph({ speccraftDir, runId, manualBody: SEQ_BLOCK, source: 'execution-manual' });

    const { workflow } = await loadProject(root);
    const run = await readRun(speccraftDir, runId);
    const written = await compileHandoffPackage({
      speccraftDir,
      projectRoot: root,
      projectName: 'v07-seq',
      workflow,
      run,
      handoffId: 'handoff-legacy',
      createdAt: new Date().toISOString(),
    });
    assert.ok(written.includes('executor-history.md'));

    const eh = await readFile(path.join(speccraftDir, 'handoffs', 'handoff-legacy', 'executor-history.md'), 'utf8');
    assert.match(eh, /无 Executor Plan/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

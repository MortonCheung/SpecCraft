/**
 * E2E N — Review Hooks（spec v0.8 §13）。
 *
 * 通过 executeTaskGraph() 真实链路验证 before_review / after_review 接线：
 *   N1: before_review hook 失败 →
 *         Reviewer 未调用（buildInvocation observations == 0）
 *         Review Attempt decision=error + error_code=before_review_hook_failed
 *         Task failed（review_failed）
 *   N2: after_review hook 失败 → warning only
 *         Review PASS 不回滚（manifest.decision == pass）
 *         Task completed（execute complete）
 *   N3: hook env 契约（§13.3）—— SPECCRAFT_REVIEW_GATE / SPECCRAFT_REVIEW_ATTEMPT /
 *         SPECCRAFT_REVIEWER_PROFILE / SPECCRAFT_ADAPTER / SPECCRAFT_TASK_ID /
 *         SPECCRAFT_RUN_ID 必须真实传到 hook 子进程（结合 N1/N2 的 obs 断言）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { initProject } from '../src/core/init.js';
import { loadProject } from '../src/core/project.js';
import { completeStage, approveStage } from '../src/core/advance.js';
import { writeArtifact, createArtifact, artifactFileName } from '../src/core/artifacts/store.js';
import { resolveTemplateContent } from '../src/core/templates/resolver.js';
import { prepareExecution } from '../src/core/execution/prepare.js';
import { registerAdapter } from '../src/core/execution/adapters/registry.js';
import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import { compileTaskGraph, readExecutionManualBody } from '../src/core/tasks/compiler.js';
import { readTaskGraph, readTaskManifest } from '../src/core/tasks/store.js';
import { executeTaskGraph } from '../src/core/tasks/orchestrator.js';
import { readReviewManifestOrNull } from '../src/core/reviews/attempt.js';
import { readReviewPlanOrNull } from '../src/core/reviews/store.js';
import { loadProjectConfig } from '../src/core/project.js';
import type { CliExecutionAdapter, NormalizedDispatchResult } from '../src/core/execution/adapters/types.js';
import type { Workflow, State } from '../src/core/types.js';

const fakeAgentPath = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

function runGit(cwd: string, args: string[]): void {
  spawnSync('git', args, { cwd, stdio: 'ignore' });
}

async function makeArtifact(speccraftDir: string, workflow: Workflow, state: State, stageId: string): Promise<void> {
  const stage = workflow.stages.find((s) => s.id === stageId)!;
  const target = completeStage(workflow, state, stageId);
  const body = await resolveTemplateContent(stage.template ?? stage.id);
  const artifact = createArtifact({ artifact: stage.produces[0], stage: stageId, status: target, version: 1 }, body);
  await writeArtifact(path.join(speccraftDir, 'artifacts', artifactFileName(stage.produces[0])), artifact);
}

const TASK_BLOCK = [
  '# Execution Manual',
  '',
  '## Execution Task Graph',
  '',
  '```speccraft-task-graph',
  'version: 1',
  '',
  'tasks:',
  '  - id: task-a',
  '    title: Task A',
  '    summary: Do A',
  '    depends_on: []',
  '    scope: { paths: [src/a/**] }',
  '    verification: { commands: [echo ok], timeout_seconds: 30 }',
  '```',
].join('\n');

async function makeReadyProject(projectYaml: string): Promise<{ root: string; speccraftDir: string; runId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-review-hooks-e2e-'));
  const { speccraftDir } = await initProject({ projectRoot: root });
  runGit(root, ['init']);
  runGit(root, ['config', 'user.name', 'Test']);
  runGit(root, ['config', 'user.email', 'test@test.com']);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', 'init']);

  const { workflow, state } = await loadProject(root);
  for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
    await makeArtifact(speccraftDir, workflow, state, id);
  }
  approveStage(workflow, state, 'design', 'owner');
  for (const id of ['build-brief', 'site-survey', 'execution-manual']) {
    await makeArtifact(speccraftDir, workflow, state, id);
  }

  const { readArtifact } = await import('../src/core/artifacts/store.js');
  const manualPath = path.join(speccraftDir, 'artifacts', 'execution-manual.md');
  const manual = await readArtifact(manualPath);
  manual.body = TASK_BLOCK;
  await writeArtifact(manualPath, manual);

  const { writeState } = await import('../src/core/state/store.js');
  await writeState(speccraftDir, state);
  await writeFile(path.join(speccraftDir, 'project.yaml'), projectYaml, 'utf8');

  await mkdir(path.join(root, 'src', 'a'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a', 'value.txt'), '', 'utf8');
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', 'scaffold']);

  const { runId } = await prepareExecution({ projectRoot: root, adapter: 'fake-reviewer', runContext: 'test' });
  return { root, speccraftDir, runId };
}

/** 构造 fake-agent work plan：真实改写工作区文件，令 exact delta（pre/post tree）非空 */
function makeValueWritePlan(taskId: string, content: string): Record<string, unknown> {
  return { [taskId]: { write: { 'src/a/value.txt': content } } };
}

function extractSessionId(stdout: string): string | undefined {
  let sessionId: string | undefined;
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const obj = JSON.parse(t) as { session_id?: string };
      if (obj.session_id) sessionId = obj.session_id;
    } catch { /* ignore */ }
  }
  return sessionId;
}

interface AdapterObservation {
  role: 'executor' | 'reviewer';
  sessionId: string | undefined;
  freshSession: boolean;
}

function makeFakeExecutor(plan?: Record<string, unknown>): CliExecutionAdapter {
  return {
    id: 'fake-executor',
    kind: 'cli',
    capabilities: { invoke: true, resume: true, structuredOutput: true, finalMessageFile: true, sessionId: true, modelSelection: false },
    prepare: manualAdapter.prepare,
    probe: async () => ({ id: 'fake-executor', installed: true }),
    buildInvocation: async (input) => ({
      command: 'node',
      args: [fakeAgentPath],
      cwd: input.projectRoot,
      stdin: input.prompt,
      env: {
        FAKE_AGENT_MODE: 'work',
        FAKE_AGENT_SESSION: 'exec-session',
        // exact delta 不含 .speccraft/**，executor 必须真实写入工作区文件（否则 no_changes）
        FAKE_AGENT_PLAN: JSON.stringify(plan ?? {}),
      },
      timeoutMs: 10000,
    }),
    normalize: async (input): Promise<NormalizedDispatchResult> => {
      const sessionId = extractSessionId(input.stdout);
      return {
        adapter: 'fake-executor',
        status: input.exitCode === 0 ? 'succeeded' : 'failed',
        exitCode: input.exitCode ?? undefined, timedOut: input.timedOut,
        startedAt: input.startedAt, finishedAt: input.finishedAt, durationMs: input.durationMs,
        ...(sessionId ? { sessionId } : {}), events: [],
      };
    },
  };
}

/** Fake Reviewer：记录 buildInvocation 观察（用于断言 Reviewer 是否被调用） */
function makeFakeReviewer(mode: string): CliExecutionAdapter & { observations: AdapterObservation[] } {
  const observations: AdapterObservation[] = [];
  const adapter: CliExecutionAdapter = {
    id: 'fake-reviewer',
    kind: 'cli',
    capabilities: { invoke: true, resume: false, structuredOutput: false, finalMessageFile: false, sessionId: true, modelSelection: false },
    prepare: manualAdapter.prepare,
    probe: async () => ({ id: 'fake-reviewer', installed: true }),
    buildInvocation: async (input) => {
      observations.push({ role: 'reviewer', sessionId: input.sessionId, freshSession: input.freshSession });
      return {
        command: 'node',
        args: [fakeAgentPath],
        cwd: input.projectRoot,
        stdin: input.prompt,
        env: { FAKE_AGENT_MODE: mode, FAKE_AGENT_SESSION: 'review-session-1' },
        timeoutMs: 10000,
      };
    },
    normalize: async (input): Promise<NormalizedDispatchResult> => {
      const sessionId = extractSessionId(input.stdout);
      return {
        adapter: 'fake-reviewer',
        status: input.exitCode === 0 ? 'succeeded' : 'failed',
        exitCode: input.exitCode ?? undefined, timedOut: input.timedOut,
        startedAt: input.startedAt, finishedAt: input.finishedAt, durationMs: input.durationMs,
        ...(sessionId ? { sessionId } : {}), events: [],
      };
    },
  };
  return Object.assign(adapter, { observations });
}

const REVIEW_ENABLED_YAML = [
  'version: 1',
  'execution: { mode: sequential }',
  'review:',
  '  enabled: true',
  '  default_reviewer: fake-reviewer',
  '  reviewers:',
  '    fake-reviewer: { adapter: fake-reviewer }',
  '  gates:',
  '    - id: spec_compliance',
  '      kind: spec_compliance',
  '      reviewer: fake-reviewer',
].join('\n');

async function compileTaskGraphForRun(speccraftDir: string, runId: string): Promise<void> {
  registerAdapter({ ...manualAdapter, id: 'fake-reviewer' } as any);
  const manualBody = await readExecutionManualBody(speccraftDir);
  const projectConfig = await loadProjectConfig(speccraftDir);
  await compileTaskGraph({ speccraftDir, runId, manualBody, source: 'execution-manual', projectConfig });
}

/**
 * hook 命令：把 §13.3 env 契约的关键字段写入 OBS 文件，然后按 failWith 退出。
 * shell: true 执行；脚本只用单引号（JS 内无双引号），join 用 String.fromCharCode(10)
 * 避免 '\n' 反斜杠在 shell 双引号里的转义歧义。
 */
function makeHookCommand(exitCode: number): string {
  const keys = [
    'SPECCRAFT_EVENT', 'SPECCRAFT_RUN_ID', 'SPECCRAFT_TASK_ID', 'SPECCRAFT_REVIEW_GATE',
    'SPECCRAFT_REVIEW_ATTEMPT', 'SPECCRAFT_REVIEWER_PROFILE', 'SPECCRAFT_ADAPTER', 'SPECCRAFT_REVIEW_DECISION',
  ];
  const script =
    `const fs=require('fs');const k=[${keys.map((k) => `'${k}'`).join(',')}];` +
    `fs.writeFileSync(process.env.E2E_HOOK_OBS,k.map(x=>x+'='+(process.env[x]||'')).join(String.fromCharCode(10)));` +
    `process.exit(${exitCode})`;
  return `node -e "${script.replace(/"/g, '\\"')}"`;
}

test('E2E N1 — before_review hook 失败 → Reviewer 未调用 + Review ERROR(before_review_hook_failed)', async () => {
  const obsFile = path.join(os.tmpdir(), `hook-before-${Date.now()}.txt`);
  process.env.E2E_HOOK_OBS = obsFile;
  const { root, speccraftDir, runId } = await makeReadyProject(REVIEW_ENABLED_YAML);
  try {
    await compileTaskGraphForRun(speccraftDir, runId);

    const graph = await readTaskGraph(speccraftDir, runId);
    const taskId = graph.tasks[0].id;

    // executor 必须真实改写工作区文件，令 exact delta 非空（否则 no_changes 在 hook 前提前失败）
    const workPlan = makeValueWritePlan(taskId, 'v2');

    const reviewer = makeFakeReviewer('review-pass');
    registerAdapter(makeFakeExecutor(workPlan));
    registerAdapter(reviewer);

    await mkdir(path.join(root, 'src', 'a'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a', 'value.txt'), 'v1', 'utf8');

    const reviewPlan = await readReviewPlanOrNull(speccraftDir, runId);
    assert.ok(reviewPlan, 'Frozen review plan must exist');

    const hooks = {
      before_review: [{ id: 'fail-before-review', command: makeHookCommand(1) }],
    };

    const result = await executeTaskGraph({
      speccraftDir, projectRoot: root, runId,
      adapter: makeFakeExecutor(workPlan),
      runContext: 'test', executionGuard: 'test',
      reviewPlan: reviewPlan!,
      hooks,
    });

    // §13.1：before_review blocking —— failure → Task failed（review_failed）
    assert.equal(result.complete, false, 'before_review hook failure must block completion');
    assert.equal(result.reason, 'review_failed');

    const taskManifest = await readTaskManifest(speccraftDir, runId, taskId);
    assert.equal(taskManifest?.status, 'failed', 'Task must be failed');

    // §13.1：Reviewer 未调用（buildInvocation observations == 0）
    assert.equal(reviewer.observations.length, 0, 'Reviewer Provider must NOT be invoked');

    // Review Attempt decision=error + error_code=before_review_hook_failed（结构化）
    const attemptDir = path.join(speccraftDir, 'runs', runId, 'tasks', taskId, 'reviews', 'spec_compliance', 'attempt-001');
    const manifest = await readReviewManifestOrNull(attemptDir);
    assert.ok(manifest, 'attempt-001 manifest must exist');
    assert.equal(manifest!.decision, 'error');
    assert.equal(manifest!.error_code, 'before_review_hook_failed', 'manifest must carry structured error_code');
    assert.ok(manifest!.error_message && manifest!.error_message.length > 0);

    // §13.3：hook env 必须真实传递（含 review 专用变量）
    const obs = await readFile(obsFile, 'utf8');
    const envMap = new Map(obs.split('\n').filter((l) => l.includes('=')).map((l) => l.split('=')));
    assert.equal(envMap.get('SPECCRAFT_EVENT'), 'before_review');
    assert.equal(envMap.get('SPECCRAFT_RUN_ID'), runId);
    assert.equal(envMap.get('SPECCRAFT_TASK_ID'), taskId);
    assert.equal(envMap.get('SPECCRAFT_REVIEW_GATE'), 'spec_compliance');
    assert.equal(envMap.get('SPECCRAFT_REVIEW_ATTEMPT'), '1');
    assert.equal(envMap.get('SPECCRAFT_REVIEWER_PROFILE'), 'fake-reviewer');
    assert.equal(envMap.get('SPECCRAFT_ADAPTER'), 'fake-reviewer');
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.E2E_HOOK_OBS;
    try { await rm(obsFile); } catch { /* */ }
  }
});

test('E2E N2 — after_review hook 失败 → warning only，PASS 不回滚', async () => {
  const obsFile = path.join(os.tmpdir(), `hook-after-${Date.now()}.txt`);
  process.env.E2E_HOOK_OBS = obsFile;
  const { root, speccraftDir, runId } = await makeReadyProject(REVIEW_ENABLED_YAML);
  try {
    await compileTaskGraphForRun(speccraftDir, runId);

    const graph = await readTaskGraph(speccraftDir, runId);
    const taskId = graph.tasks[0].id;

    const workPlan = makeValueWritePlan(taskId, 'v2');

    const reviewer = makeFakeReviewer('review-pass');
    registerAdapter(makeFakeExecutor(workPlan));
    registerAdapter(reviewer);

    await mkdir(path.join(root, 'src', 'a'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a', 'value.txt'), 'v1', 'utf8');

    const reviewPlan = await readReviewPlanOrNull(speccraftDir, runId);
    assert.ok(reviewPlan);

    const hooks = {
      after_review: [{ id: 'fail-after-review', command: makeHookCommand(1) }],
    };

    const result = await executeTaskGraph({
      speccraftDir, projectRoot: root, runId,
      adapter: makeFakeExecutor(workPlan),
      runContext: 'test', executionGuard: 'test',
      reviewPlan: reviewPlan!,
      hooks,
    });

    // §13.2：after_review 失败只 warning —— PASS 不回滚、Task completed
    assert.equal(result.complete, true, 'after_review hook failure must not roll back a PASS');

    const attemptDir = path.join(speccraftDir, 'runs', runId, 'tasks', taskId, 'reviews', 'spec_compliance', 'attempt-001');
    const manifest = await readReviewManifestOrNull(attemptDir);
    assert.ok(manifest);
    assert.equal(manifest!.decision, 'pass', 'after_review failure must not rewrite the PASS decision');

    const taskManifest = await readTaskManifest(speccraftDir, runId, taskId);
    assert.equal(taskManifest?.status, 'completed', 'Task must remain completed');

    // after_review hook 确实执行，且收到最终 decision env
    const obs = await readFile(obsFile, 'utf8');
    const envMap = new Map(obs.split('\n').filter((l) => l.includes('=')).map((l) => l.split('=')));
    assert.equal(envMap.get('SPECCRAFT_EVENT'), 'after_review');
    assert.equal(envMap.get('SPECCRAFT_REVIEW_GATE'), 'spec_compliance');
    assert.equal(envMap.get('SPECCRAFT_REVIEW_ATTEMPT'), '1');
    assert.equal(envMap.get('SPECCRAFT_REVIEW_DECISION'), 'pass');
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.E2E_HOOK_OBS;
    try { await rm(obsFile); } catch { /* */ }
  }
});

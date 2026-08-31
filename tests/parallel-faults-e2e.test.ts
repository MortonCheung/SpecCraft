import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initProject } from '../src/core/init.js';
import { loadProject } from '../src/core/project.js';
import { completeStage, approveStage } from '../src/core/advance.js';
import { writeArtifact, readArtifact, createArtifact, artifactFileName } from '../src/core/artifacts/store.js';
import { resolveTemplateContent } from '../src/core/templates/resolver.js';
import { prepareExecution } from '../src/core/execution/prepare.js';
import { readRun } from '../src/core/execution/store.js';
import { registerAdapter } from '../src/core/execution/adapters/registry.js';
import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import { verifyExecution } from '../src/core/verification/orchestrator.js';
import { reject } from '../src/core/acceptance/lifecycle.js';
import { compileTaskGraph } from '../src/core/tasks/compiler.js';
import { readTaskManifest } from '../src/core/tasks/store.js';
import { reopenTask } from '../src/core/tasks/rework.js';
import { refreshStates } from '../src/core/tasks/dependency.js';
import { readTaskGraph, readAllTaskManifests } from '../src/core/tasks/store.js';
import { executeParallelTaskGraph } from '../src/core/parallel/orchestrator.js';
import { readWorkspace, listWorkspaceAttempts } from '../src/core/workspaces/store.js';
import { readCanonicalHead, isCanonicalClean } from '../src/core/workspaces/integration.js';
import { runGit } from '../src/core/workspaces/git.js';
import { listDispatchAttemptsForTask, readDispatchAttempt } from '../src/core/dispatch/store.js';
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

// ---------------------------------------------------------------------------
// fake work adapter（同 parallel-e2e，plan 可在两次 execute 之间变更）
// ---------------------------------------------------------------------------

interface WorkSpec {
  write?: Record<string, string>;
  outOfScope?: string[];
  sleepMs?: number;
  gitCommit?: boolean;
  drift?: boolean;
  fail?: boolean;
}

function makeWorkAdapter(
  getPlan: () => Record<string, WorkSpec>,
  getSession: () => string = () => `sess-${Math.random().toString(16).slice(2, 10)}`,
  canonical?: string,
): CliExecutionAdapter {
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
      env: {
        FAKE_AGENT_MODE: 'work',
        FAKE_AGENT_PLAN: JSON.stringify(getPlan()),
        FAKE_AGENT_SESSION: getSession(),
        ...(canonical ? { FAKE_AGENT_CANONICAL: canonical } : {}),
      },
      timeoutMs: 60000,
    }),
    normalize: async (input): Promise<NormalizedDispatchResult> => {
      let sessionId: string | undefined;
      for (const line of input.stdout.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.session_id) sessionId = obj.session_id;
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
        events: [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 最小可执行项目（真实 Git repo）
// ---------------------------------------------------------------------------

async function makeArtifact(speccraftDir: string, workflow: Workflow, state: State, stageId: string): Promise<void> {
  const stage = workflow.stages.find((s) => s.id === stageId)!;
  const target = completeStage(workflow, state, stageId);
  const body = await resolveTemplateContent(stage.template ?? stage.id);
  const artifact = createArtifact({ artifact: stage.produces[0], stage: stageId, status: target, version: 1 }, body);
  await writeArtifact(path.join(speccraftDir, 'artifacts', artifactFileName(stage.produces[0])), artifact);
}

function taskBlock(tasks: string[]): string {
  return [
    '## Execution Task Graph',
    '',
    '```speccraft-task-graph',
    'version: 1',
    '',
    'tasks:',
    ...tasks,
    '```',
  ].join('\n');
}

/** 单 task（scope src/api/**，验证依赖 done.txt 标记） */
const SINGLE_BLOCK = taskBlock([
  `  - id: t
    title: T
    summary: Do T
    depends_on: []
    scope: { paths: [src/api/**] }
    verification: { commands: [test -f src/api/done.txt], timeout_seconds: 30 }`,
]);

/** t + u（u depends_on t） */
const DEPENDENT_BLOCK = taskBlock([
  `  - id: t
    title: T
    summary: Do T
    depends_on: []
    scope: { paths: [src/api/**] }
    verification: { commands: [test -f src/api/done.txt], timeout_seconds: 30 }`,
  `  - id: u
    title: U
    summary: Do U
    depends_on: [t]
    scope: { paths: [src/u/**] }
    verification: { commands: [echo ok], timeout_seconds: 30 }`,
]);

/** c + d（owner rework 场景，d depends_on c） */
const REWORK_BLOCK = taskBlock([
  `  - id: c
    title: C
    summary: Do C
    depends_on: []
    scope: { paths: [src/api/**] }
    verification: { commands: [echo ok], timeout_seconds: 30 }`,
  `  - id: d
    title: D
    summary: Do D
    depends_on: [c]
    scope: { paths: [src/d/**] }
    verification: { commands: [echo ok], timeout_seconds: 30 }`,
]);

interface TestProject {
  root: string;
  speccraftDir: string;
  runId: string;
  baseCommit: string;
}

async function makeFaultProject(block: string): Promise<TestProject> {
  // repo 放在 mkdtemp 外层目录的子目录里：每个测试独享 <outer>/.speccraft-worktrees，
  // 避免跨测试文件并行时共享/误删同一个 worktrees 根目录。
  const outer = await mkdtemp(path.join(os.tmpdir(), 'speccraft-fault-'));
  const root = path.join(outer, 'proj');
  await mkdir(root, { recursive: true });
  await runGit(root, ['init', '-q']);
  await runGit(root, ['config', 'user.email', 'test@example.com']);
  await runGit(root, ['config', 'user.name', 'Test']);
  await writeFile(path.join(root, '.gitignore'), '.speccraft/\n', 'utf8');
  await writeFile(path.join(root, 'README.md'), 'init\n', 'utf8');
  await runGit(root, ['add', '.']);
  await runGit(root, ['commit', '-q', '-m', 'init']);
  const baseCommit = (await readCanonicalHead(root))!;

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
  manual.body = block;
  await writeArtifact(manualPath, manual);

  const { writeState } = await import('../src/core/state/store.js');
  await writeState(speccraftDir, state);

  await writeFile(
    path.join(speccraftDir, 'project.yaml'),
    'name: fault-e2e\nexecution:\n  default_adapter: fake\nverification:\n  timeout_seconds: 60\n  commands:\n    - "true"\n',
    'utf8',
  );

  const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake' });
  await compileTaskGraph({ speccraftDir, runId, manualBody: block, source: 'execution-manual' });
  return { root, speccraftDir, runId, baseCommit };
}

async function cleanup(p: { root: string }): Promise<void> {
  // 删除整个外层目录（含 repo 与 <outer>/.speccraft-worktrees）
  await rm(path.dirname(p.root), { recursive: true, force: true });
}

async function run(adapter: CliExecutionAdapter, p: TestProject, freshSession = false) {
  return executeParallelTaskGraph({
    speccraftDir: p.speccraftDir,
    projectRoot: p.root,
    runId: p.runId,
    adapter,
    runContext: '# ctx',
    executionGuard: '# guard',
    maxParallel: 2,
    freshSession,
  });
}

// ---------------------------------------------------------------------------
// §25 Fault A — Scope Violation
// ---------------------------------------------------------------------------

test('M6.9 §25 Fault A：out-of-scope 写 → scope audit FAIL → task failed → 无集成 → canonical 不变', async () => {
  const plan: Record<string, WorkSpec> = {
    t: { write: { 'src/api/a.ts': 'v' }, outOfScope: ['package.json'] },
  };
  const adapter = makeWorkAdapter(() => plan);
  registerAdapter(adapter);
  const p = await makeFaultProject(SINGLE_BLOCK);
  try {
    const result = await run(adapter, p);

    assert.equal(result.complete, false);
    assert.equal(result.reason, 'failed_task');
    assert.equal(result.integrationCommits.length, 0);

    // Task failed，workspace retained + scope audit FAIL
    assert.equal((await readTaskManifest(p.speccraftDir, p.runId, 't'))?.status, 'failed');
    const ws = await readWorkspace(p.speccraftDir, p.runId, 't', 1);
    assert.ok(ws);
    assert.equal(ws.status, 'failed');
    assert.equal(ws.scopeAudit.passed, false);
    assert.deepEqual(ws.scopeAudit.violations, ['package.json']);
    assert.equal(ws.taskCommit, undefined); // 无 runtime task commit
    assert.equal(await exists(ws.workspaceRoot), true); // worktree retained

    // canonical HEAD unchanged + clean（失败变更绝不进入 canonical）
    assert.equal(await readCanonicalHead(p.root), p.baseCommit);
    assert.equal(await isCanonicalClean(p.root), true);
  } finally {
    await cleanup(p);
  }
});

// ---------------------------------------------------------------------------
// §26 Fault B — Task Verification FAIL → reopen 复用同一 Workspace Attempt
// ---------------------------------------------------------------------------

test('M6.9 §26 Fault B：verify FAIL → task failed / workspace retained / dependent blocked → reopen 复用 attempt 001 → 修复 PASS', async () => {
  let plan: Record<string, WorkSpec> = {
    t: { write: { 'src/api/a.ts': 'v1' } }, // 缺 done.txt → verification FAIL
  };
  const adapter = makeWorkAdapter(() => plan);
  registerAdapter(adapter);
  const p = await makeFaultProject(DEPENDENT_BLOCK);
  try {
    const r1 = await run(adapter, p);
    assert.equal(r1.complete, false);
    assert.equal(r1.reason, 'failed_task');

    // Task failed、Workspace retained、canonical unchanged、dependent blocked
    assert.equal((await readTaskManifest(p.speccraftDir, p.runId, 't'))?.status, 'failed');
    const ws1 = await readWorkspace(p.speccraftDir, p.runId, 't', 1);
    assert.ok(ws1);
    assert.equal(ws1.status, 'failed');
    assert.equal(ws1.failurePhase, 'verify');
    assert.equal(await exists(ws1.workspaceRoot), true);
    assert.equal(await readCanonicalHead(p.root), p.baseCommit);
    const statuses = refreshStates(
      await readTaskGraph(p.speccraftDir, p.runId),
      await readAllTaskManifests(p.speccraftDir, p.runId),
    );
    assert.equal(statuses.get('u'), 'blocked');

    // reopen（same Task ID）→ 修复（写 done.txt）→ 重新 execute
    await reopenTask({ speccraftDir: p.speccraftDir, runId: p.runId, taskId: 't', cascade: false });
    plan = {
      t: { write: { 'src/api/a.ts': 'v2', 'src/api/done.txt': 'ok' } },
      u: { write: { 'src/u/u.txt': 'U' } },
    };
    const r2 = await run(adapter, p);
    assert.equal(r2.complete, true);

    // same Task ID + same Workspace Attempt（001 复用，§16.1）
    assert.equal((await readTaskManifest(p.speccraftDir, p.runId, 't'))?.id, 't');
    assert.deepEqual(await listWorkspaceAttempts(p.speccraftDir, p.runId, 't'), [1]);
    const ws = await readWorkspace(p.speccraftDir, p.runId, 't', 1);
    assert.ok(ws);
    assert.equal(ws.status, 'cleaned'); // integrated → cleaned
    // dispatch 尝试 2 次（同一 workspace attempt）
    assert.equal((await listDispatchAttemptsForTask(p.speccraftDir, p.runId, 't')).length, 2);
    assert.deepEqual(ws.dispatchAttempts.length, 2);
    // 依赖解锁后完成
    assert.equal((await readTaskManifest(p.speccraftDir, p.runId, 'u'))?.status, 'completed');
  } finally {
    await cleanup(p);
  }
});

// ---------------------------------------------------------------------------
// §27 Fault C — Integration Conflict（真实 Git conflict → abort → 新 attempt）
// ---------------------------------------------------------------------------

test('M6.9 §27 Fault C：cherry-pick conflict → abort → integration_conflict → reopen → attempt 002 → 集成成功', async () => {
  let plan: Record<string, WorkSpec> = {
    t: { write: { 'src/api/a.ts': 'task-version' } }, // verify FAIL（无 done.txt）
  };
  const adapter = makeWorkAdapter(() => plan);
  registerAdapter(adapter);
  const p = await makeFaultProject(SINGLE_BLOCK);
  try {
    // 第 1 次：verify FAIL → workspace 001 failed（worktree 停在 base C0）
    const r1 = await run(adapter, p);
    assert.equal(r1.reason, 'failed_task');

    // 人为推进 canonical：同文件不同内容（制造真实 conflict 前提）
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(p.root, 'src', 'api'), { recursive: true });
    await writeFile(path.join(p.root, 'src', 'api', 'a.ts'), 'canonical-version\n', 'utf8');
    await runGit(p.root, ['add', '.']);
    await runGit(p.root, ['commit', '-q', '-m', 'canonical move']);
    const drifted = (await readCanonicalHead(p.root))!;

    // reopen → 第 2 次：复用 attempt 001（base=旧 C0）→ task commit 与 canonical 冲突
    await reopenTask({ speccraftDir: p.speccraftDir, runId: p.runId, taskId: 't', cascade: false });
    plan = { t: { write: { 'src/api/a.ts': 'task-v2\n', 'src/api/done.txt': 'ok' } } };
    const r2 = await run(adapter, p);
    assert.equal(r2.complete, false);
    assert.equal(r2.reason, 'failed_task');

    const ws1 = await readWorkspace(p.speccraftDir, p.runId, 't', 1);
    assert.ok(ws1);
    assert.equal(ws1.status, 'integration_conflict');
    assert.equal(ws1.failurePhase, 'integration');
    assert.deepEqual(ws1.conflictingPaths, ['src/api/a.ts']);
    assert.ok(ws1.taskCommit); // task commit 证据保留
    assert.equal((await readTaskManifest(p.speccraftDir, p.runId, 't'))?.status, 'failed');
    // cherry-pick 已 abort：canonical clean、HEAD 未被覆盖
    assert.equal(await isCanonicalClean(p.root), true);
    assert.equal(await readCanonicalHead(p.root), drifted);
    // evidence retained：worktree 保留
    assert.equal(await exists(ws1.workspaceRoot), true);

    // §16.2：conflict 后 reopen → 下一次 execute 必须 Workspace Attempt 002
    await reopenTask({ speccraftDir: p.speccraftDir, runId: p.runId, taskId: 't', cascade: false });
    plan = { t: { write: { 'src/api/a.ts': 'task-v3\n', 'src/api/done.txt': 'ok' } } };
    const r3 = await run(adapter, p);
    assert.equal(r3.complete, true);

    assert.deepEqual(await listWorkspaceAttempts(p.speccraftDir, p.runId, 't'), [1, 2]);
    const ws2 = await readWorkspace(p.speccraftDir, p.runId, 't', 2);
    assert.ok(ws2);
    assert.equal(ws2.status, 'cleaned');
    assert.equal(ws2.baseCommit, drifted); // 新 attempt 基于最新 canonical HEAD
    // 旧 evidence 保留
    assert.equal((await readWorkspace(p.speccraftDir, p.runId, 't', 1))?.status, 'integration_conflict');
    assert.equal((await readTaskManifest(p.speccraftDir, p.runId, 't'))?.status, 'completed');
  } finally {
    await cleanup(p);
  }
});

// ---------------------------------------------------------------------------
// §28 Fault D — Owner Rework（integrated 后 reject → reopen cascade → attempt 002）
// ---------------------------------------------------------------------------

test('M6.9 §28 Fault D：completed/integrated → verify PASS → Owner REJECT → reopen C --cascade → attempt 002（fresh session，新 base）→ 重新集成', async () => {
  let plan: Record<string, WorkSpec> = {
    c: { write: { 'src/api/c.txt': 'v1' } },
    d: { write: { 'src/d/d.txt': 'D1' } },
  };
  let session = 'sess-c-round1';
  const adapter = makeWorkAdapter(() => plan, () => session);
  registerAdapter(adapter);
  const p = await makeFaultProject(REWORK_BLOCK);
  try {
    const r1 = await run(adapter, p);
    assert.equal(r1.complete, true);
    assert.equal((await readTaskManifest(p.speccraftDir, p.runId, 'c'))?.status, 'completed');
    const ws1 = await readWorkspace(p.speccraftDir, p.runId, 'c', 1);
    assert.ok(ws1);
    assert.equal(ws1.status, 'cleaned');

    // Run Verification PASS → Owner REJECT
    const v = await verifyExecution({ projectRoot: p.root });
    assert.equal(v.passed, true);
    const { workflow, state } = await loadProject(p.root);
    const run1 = await readRun(p.speccraftDir, p.runId);
    const cSession1 = (await readDispatchAttempt(
      p.speccraftDir,
      p.runId,
      (await listDispatchAttemptsForTask(p.speccraftDir, p.runId, 'c')).at(-1)!,
    ))?.session_id;
    await reject(p.speccraftDir, p.root, workflow, state, run1, { feedback: 'Owner rework' });

    // reopen C --cascade
    const reopened = await reopenTask({ speccraftDir: p.speccraftDir, runId: p.runId, taskId: 'c', cascade: true });
    assert.ok(reopened.reopened.includes('c'));
    assert.ok(reopened.reopened.includes('d'));

    // 重新 execute（fresh provider session）
    const canonicalBeforeR2 = await readCanonicalHead(p.root);
    plan = {
      c: { write: { 'src/api/c.txt': 'v2' } },
      d: { write: { 'src/d/d.txt': 'D2' } },
    };
    session = 'sess-c-round2';
    const r2 = await run(adapter, p, true);
    assert.equal(r2.complete, true);

    // Task ID / Run ID 不变；Workspace Attempt 1 → 2；旧 evidence 保留
    assert.equal((await readTaskManifest(p.speccraftDir, p.runId, 'c'))?.id, 'c');
    assert.equal((await readRun(p.speccraftDir, p.runId)).id, p.runId);
    assert.deepEqual(await listWorkspaceAttempts(p.speccraftDir, p.runId, 'c'), [1, 2]);
    const wsA1 = await readWorkspace(p.speccraftDir, p.runId, 'c', 1);
    const wsA2 = await readWorkspace(p.speccraftDir, p.runId, 'c', 2);
    assert.ok(wsA1 && wsA2);
    assert.equal(wsA1.status, 'cleaned'); // 旧 evidence 保留
    assert.equal(wsA2.status, 'cleaned');
    assert.equal(wsA2.baseCommit, canonicalBeforeR2); // base = 最新 canonical HEAD

    // fresh provider session（不 resume 旧 session）
    const cSession2 = (await readDispatchAttempt(
      p.speccraftDir,
      p.runId,
      (await listDispatchAttemptsForTask(p.speccraftDir, p.runId, 'c')).at(-1)!,
    ))?.session_id;
    assert.equal(cSession2, 'sess-c-round2');
    assert.notEqual(cSession2, cSession1);

    // d 也被 cascade 重新施工（attempt 1 → 2）
    assert.deepEqual(await listWorkspaceAttempts(p.speccraftDir, p.runId, 'd'), [1, 2]);
    assert.equal((await readTaskManifest(p.speccraftDir, p.runId, 'd'))?.status, 'completed');
    // canonical 里是新版内容
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(path.join(p.root, 'src', 'api', 'c.txt'), 'utf8'), 'v2');
  } finally {
    await cleanup(p);
  }
});

// ---------------------------------------------------------------------------
// §29 Fault E — Canonical Drift（agent 运行中 canonical 前进 → 停止集成）
// ---------------------------------------------------------------------------

test('M6.9 §29 Fault E：wave 运行中 canonical 产生新 commit → 停止 integration → 不 reset / workspaces retained', async () => {
  const plan: Record<string, WorkSpec> = {
    t: { write: { 'src/api/a.ts': 'v', 'src/api/done.txt': 'ok' }, drift: true },
  };
  const adapter = makeWorkAdapter(() => plan, undefined, undefined);
  // canonical path 需要在项目创建后注入：用包装 adapter 传递
  registerAdapter(adapter);
  const p = await makeFaultProject(SINGLE_BLOCK);
  try {
    // 用带 canonical 的 adapter 重跑（项目 root 已知）
    const driftAdapter = makeWorkAdapter(() => plan, () => 'sess-drift', p.root);
    const result = await run(driftAdapter, p);

    assert.equal(result.complete, false);
    assert.equal(result.reason, 'canonical_drift');
    assert.equal(result.integrationCommits.length, 0);

    // task 保持 in_progress（不是 completed / failed）；workspace 保持 committed
    const tm = await readTaskManifest(p.speccraftDir, p.runId, 't');
    assert.equal(tm?.status, 'in_progress');
    const ws = await readWorkspace(p.speccraftDir, p.runId, 't', 1);
    assert.ok(ws);
    assert.equal(ws.status, 'committed');
    assert.ok(ws.taskCommit);
    assert.equal(await exists(ws.workspaceRoot), true); // worktree retained

    // 用户代码不丢失：drift commit 仍在 canonical（不 reset / 不覆盖）
    const head = await readCanonicalHead(p.root);
    assert.notEqual(head, p.baseCommit);
    assert.equal(await isCanonicalClean(p.root), true);
    const subject = (await runGit(p.root, ['log', '-1', '--format=%s'])).stdout.trim();
    assert.equal(subject, 'drift');
  } finally {
    await cleanup(p);
  }
});

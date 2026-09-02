/**
 * M8.2 — Review Preflight & Diagnostics（ADR 0009 §22-§31）。
 *
 * 覆盖：
 *   §5.2 Adapter probe 去重（同一 adapter 只 probe 一次，不按 Task × Gate）
 *   §5.3 manual reviewer → 自动执行明确失败（不假装 PASS / 不跳过 / 不 fallback）
 *   §5.4 unavailable reviewer → preflight blocked（不 fallback 到其它 reviewer）
 *   §5.5 capability guard（声明 model 但 adapter 不支持 modelSelection → fail closed）
 *   §5.1 cmdDispatch --task：reviewer 不可用 → 0 dispatch + 0 task mutation
 *   §6   reviews list / reviews plan / reviews doctor / reviews show
 *   §18  tasks compile 产出 frozen Review Plan（此前从未落盘 → review 不可达）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { loadProject, loadProjectConfig } from '../src/core/project.js';
import { completeStage, approveStage } from '../src/core/advance.js';
import { writeArtifact, createArtifact, readArtifact, artifactFileName } from '../src/core/artifacts/store.js';
import { resolveTemplateContent } from '../src/core/templates/resolver.js';
import { prepareExecution } from '../src/core/execution/prepare.js';
import { registerAdapter } from '../src/core/execution/adapters/registry.js';
import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import type { CliExecutionAdapter, NormalizedDispatchResult } from '../src/core/execution/adapters/types.js';
import { compileTaskGraph } from '../src/core/tasks/compiler.js';
import { writeReviewPlan } from '../src/core/reviews/store.js';
import { readReviewPlanOrNull } from '../src/core/reviews/store.js';
import { tasksDir } from '../src/core/tasks/store.js';
import type { ReviewPlan, ReviewAttemptManifest } from '../src/core/reviews/types.js';
import { listDispatchAttemptsForTask } from '../src/core/dispatch/store.js';
import { preflightReviewPlanWithPlan } from '../src/core/reviews/preflight.js';
import { reviewsDoctor, reviewsListFromPlan, reviewsPlanFromPlan } from '../src/core/reviews/diagnostics.js';
import { cmdDispatch, cmdReviewsList, cmdReviewsPlan, cmdReviewsDoctor, cmdReviewsShow } from '../src/cli/commands.js';
import type { Workflow, State } from '../src/core/types.js';

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-v08rev-'));
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

/** probe 计数 adapter：用于证明 adapter 去重（§5.2） */
function makeCountingAdapter(
  id: string,
  opts: { installed?: boolean; modelSelection?: boolean } = {},
): { adapter: CliExecutionAdapter; probes: () => number } {
  const installed = opts.installed ?? true;
  const modelSelection = opts.modelSelection ?? false;
  let count = 0;
  const adapter: CliExecutionAdapter = {
    id,
    kind: 'cli',
    capabilities: {
      invoke: true, resume: false, structuredOutput: true,
      finalMessageFile: true, sessionId: true, modelSelection,
    },
    prepare: manualAdapter.prepare,
    probe: async () => {
      count++;
      return {
        id,
        installed,
        version: '1.0.0',
        capabilities: {
          invoke: true, resume: false, structuredOutput: true,
          finalMessageFile: true, sessionId: true, modelSelection,
        },
        ...(installed ? {} : { error: 'not installed' }),
      };
    },
    buildInvocation: async (input) => ({
      command: 'true', args: [], cwd: input.projectRoot, stdin: input.prompt, timeoutMs: 5000,
    }),
    normalize: async (input): Promise<NormalizedDispatchResult> => ({
      adapter: id,
      status: input.exitCode === 0 ? 'succeeded' : 'failed',
      exitCode: input.exitCode ?? undefined,
      timedOut: input.timedOut,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs: input.durationMs,
      events: [],
    }),
  };
  return { adapter, probes: () => count };
}

function capture(): { out: () => string; err: () => string; restore: () => void } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => { outChunks.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { errChunks.push(a.map(String).join(' ')); };
  return {
    out: () => outChunks.join('\n'),
    err: () => errChunks.join('\n'),
    restore: () => { console.log = origOut; console.error = origErr; },
  };
}

function makePlan(gates: ReviewPlan['gates'], enabled = true): ReviewPlan {
  return {
    version: 1, run_id: 'run-1', enabled, created_at: '2026-09-01T00:00:00Z', gates,
  };
}

const VERIF_OK = 'verification: { commands: [echo ok], timeout_seconds: 30 }';

const ONE_TASK_BLOCK = [
  '# Execution Manual', '', '## Execution Task Graph', '',
  '```speccraft-task-graph', 'version: 1', '', 'tasks:',
  '  - id: a',
  '    title: A',
  '    summary: Do A',
  '    executor: primary',
  '    depends_on: []',
  '    scope: { paths: [src/a/**] }',
  `    ${VERIF_OK}`,
  '```',
].join('\n');

/** 两个 gate 共用同一 adapter —— 用于证明去重 */
function projectYamlWith(specReviewerAdapter: string, qualityReviewerAdapter: string): string {
  return [
    'name: v08-review',
    'execution:',
    '  default_adapter: fake-alpha',
    '  adapters:',
    '    fake-alpha:',
    '      timeout_seconds: 60',
    '  default_executor: primary',
    '  executors:',
    '    primary:',
    '      adapter: fake-alpha',
    'verification:',
    '  timeout_seconds: 60',
    '  commands:',
    '    - "true"',
    'review:',
    '  enabled: true',
    '  reviewers:',
    '    spec-reviewer:',
    `      adapter: ${specReviewerAdapter}`,
    '      timeout_seconds: 300',
    '    quality-reviewer:',
    `      adapter: ${qualityReviewerAdapter}`,
    '  gates:',
    '    - id: spec',
    '      kind: spec_compliance',
    '      reviewer: spec-reviewer',
    '    - id: quality',
    '      kind: code_quality',
    '      reviewer: quality-reviewer',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// §5.2 Adapter probe 去重
// ---------------------------------------------------------------------------

describe('M8.2 — §5.2 Adapter Probe 去重', () => {
  test('两个 gate 共用同一 adapter → preflight 只 probe 一次', async () => {
    const { adapter, probes } = makeCountingAdapter('fake-alpha');
    registerAdapter(adapter);
    const plan = makePlan([
      { id: 'spec', kind: 'spec_compliance', reviewer: 'spec-reviewer', adapter: 'fake-alpha', resolved: { timeout_seconds: 300 } },
      { id: 'quality', kind: 'code_quality', reviewer: 'quality-reviewer', adapter: 'fake-alpha', resolved: { timeout_seconds: 900 } },
    ]);
    const result = await preflightReviewPlanWithPlan(plan);
    assert.equal(result.status, 'pass');
    assert.equal(probes(), 1, `应只 probe 一次（实际 ${probes()}）`);
  });

  test('reviewsDoctor 同样只 probe 一次', async () => {
    const { adapter, probes } = makeCountingAdapter('fake-alpha');
    registerAdapter(adapter);
    const plan = makePlan([
      { id: 'spec', kind: 'spec_compliance', reviewer: 'spec-reviewer', adapter: 'fake-alpha', resolved: { timeout_seconds: 300 } },
      { id: 'quality', kind: 'code_quality', reviewer: 'quality-reviewer', adapter: 'fake-alpha', resolved: { timeout_seconds: 300 } },
    ]);
    const items = await reviewsDoctor(plan);
    assert.equal(items.length, 1, '去重后应只有 1 个 adapter 条目');
    assert.equal(probes(), 1, `应只 probe 一次（实际 ${probes()}）`);
  });
});

// ---------------------------------------------------------------------------
// §5.3 / §5.4 / §5.5 Preflight 失败语义
// ---------------------------------------------------------------------------

describe('M8.2 — §5.3-§5.5 Preflight 失败语义', () => {
  test('§5.3 manual reviewer → 明确失败，不自动执行', async () => {
    const plan = makePlan([
      { id: 'spec', kind: 'spec_compliance', reviewer: 'human-review', adapter: 'manual', resolved: { timeout_seconds: 900 } },
    ]);
    const result = await preflightReviewPlanWithPlan(plan);
    assert.equal(result.status, 'blocked');
    assert.match(result.reason ?? '', /manual reviewer cannot run automatic review gates/);
  });

  test('§5.4 unavailable reviewer → blocked，不 fallback 到其它 reviewer', async () => {
    registerAdapter(makeCountingAdapter('fake-alpha').adapter);
    const plan = makePlan([
      { id: 'spec', kind: 'spec_compliance', reviewer: 'spec-reviewer', adapter: 'fake-alpha', resolved: { timeout_seconds: 300 } },
      { id: 'quality', kind: 'code_quality', reviewer: 'quality-reviewer', adapter: 'fake-gone', resolved: { timeout_seconds: 300 } },
    ]);
    const result = await preflightReviewPlanWithPlan(plan);
    assert.equal(result.status, 'blocked', '任一 reviewer 不可用 → 整体 blocked');
    assert.ok(
      result.items.some((i) => i.adapter === 'fake-gone' && !i.installed),
      '不可用 adapter 必须被标记为 not installed',
    );
  });

  test('§5.5 capability guard：声明 model 但 adapter 不支持 modelSelection → fail closed', async () => {
    registerAdapter(makeCountingAdapter('fake-nomodel', { modelSelection: false }).adapter);
    const plan = makePlan([
      {
        id: 'spec', kind: 'spec_compliance', reviewer: 'spec-reviewer',
        adapter: 'fake-nomodel', resolved: { timeout_seconds: 300, model: 'gpt-9' },
      },
    ]);
    const result = await preflightReviewPlanWithPlan(plan);
    assert.equal(result.status, 'blocked');
    assert.match(result.reason ?? '', /modelSelection/);
  });

  test('§5.5 反向：adapter 支持 modelSelection → pass', async () => {
    registerAdapter(makeCountingAdapter('fake-model', { modelSelection: true }).adapter);
    const plan = makePlan([
      {
        id: 'spec', kind: 'spec_compliance', reviewer: 'spec-reviewer',
        adapter: 'fake-model', resolved: { timeout_seconds: 300, model: 'gpt-9' },
      },
    ]);
    const result = await preflightReviewPlanWithPlan(plan);
    assert.equal(result.status, 'pass');
  });
});

// ---------------------------------------------------------------------------
// §18 tasks compile 产出 frozen Review Plan（此前从未落盘）
// ---------------------------------------------------------------------------

describe('M8.2 — §18 tasks compile 产出 frozen Review Plan', () => {
  test('review enabled → compile 落盘 plan.yaml（2 gates）', async () => {
    registerAdapter(makeCountingAdapter('fake-alpha').adapter);
    const { root, speccraftDir } = await makeReadyProject(ONE_TASK_BLOCK, projectYamlWith('fake-alpha', 'fake-alpha'));
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const config = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: ONE_TASK_BLOCK, source: 'execution-manual', projectConfig: config });

    const plan = await readReviewPlanOrNull(speccraftDir, runId);
    assert.ok(plan, 'compile 必须落盘 Review Plan');
    assert.equal(plan.enabled, true);
    assert.equal(plan.gates.length, 2);
    assert.deepEqual(plan.gates.map((g) => g.id), ['spec', 'quality']);
    // resolved adapter config 已 freeze
    assert.equal(plan.gates[0].resolved.timeout_seconds, 300);
  });

  test('review 未配置 → 不产生 Review Plan', async () => {
    registerAdapter(makeCountingAdapter('fake-alpha').adapter);
    const yaml = [
      'name: v08-noreview',
      'execution:',
      '  default_adapter: fake-alpha',
      '  default_executor: primary',
      '  executors:',
      '    primary:',
      '      adapter: fake-alpha',
      'verification:', '  timeout_seconds: 60', '  commands:', '    - "true"',
    ].join('\n');
    const { root, speccraftDir } = await makeReadyProject(ONE_TASK_BLOCK, yaml);
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const config = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: ONE_TASK_BLOCK, source: 'execution-manual', projectConfig: config });

    const plan = await readReviewPlanOrNull(speccraftDir, runId);
    assert.equal(plan, null);
  });
});

// ---------------------------------------------------------------------------
// §5.1 cmdDispatch --task：reviewer 不可用 → 0 dispatch
// ---------------------------------------------------------------------------

test('M8.2 §5.1：cmdDispatch --task — reviewer 不可用 → Review Preflight BLOCKED + 0 dispatch', async () => {
  registerAdapter(makeCountingAdapter('fake-alpha').adapter);
  registerAdapter(makeCountingAdapter('fake-gone', { installed: false }).adapter);

  const yaml = projectYamlWith('fake-alpha', 'fake-gone');
  const { root, speccraftDir } = await makeReadyProject(ONE_TASK_BLOCK, yaml);
  const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
  const config = await loadProjectConfig(speccraftDir);
  await compileTaskGraph({ speccraftDir, runId, manualBody: ONE_TASK_BLOCK, source: 'execution-manual', projectConfig: config });

  const cap = capture();
  let code = 0;
  try {
    code = await cmdDispatch({ task: 'a' }, root);
  } finally {
    cap.restore();
  }

  assert.equal(code, 1, 'reviewer 不可用必须中止 dispatch');
  assert.match(cap.err(), /Review Preflight BLOCKED/);
  const attempts = await listDispatchAttemptsForTask(speccraftDir, runId, 'a');
  assert.equal(attempts.length, 0, '必须 0 dispatch attempt（零副作用）');
});

// ---------------------------------------------------------------------------
// §6 reviews list / plan / doctor / show
// ---------------------------------------------------------------------------

describe('M8.2 — §6 Reviews Diagnostics CLI', () => {
  test('reviews list 展示 Gate / Kind / Reviewer / Adapter', async () => {
    registerAdapter(makeCountingAdapter('fake-alpha').adapter);
    const { root, speccraftDir } = await makeReadyProject(ONE_TASK_BLOCK, projectYamlWith('fake-alpha', 'fake-alpha'));
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const config = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: ONE_TASK_BLOCK, source: 'execution-manual', projectConfig: config });

    const cap = capture();
    let code = 0;
    try {
      code = await cmdReviewsList(root);
    } finally {
      cap.restore();
    }
    const out = cap.out();
    assert.equal(code, 0);
    assert.match(out, /Gate/);
    assert.match(out, /Kind/);
    assert.match(out, /Reviewer/);
    assert.match(out, /Adapter/);
    assert.match(out, /spec_compliance/);
    assert.match(out, /code_quality/);
    assert.match(out, /spec-reviewer/);
    assert.match(out, /fake-alpha/);
    assert.ok(runId.length > 0);
  });

  test('reviews plan 展示 frozen Run Review Plan', async () => {
    registerAdapter(makeCountingAdapter('fake-alpha').adapter);
    const { root, speccraftDir } = await makeReadyProject(ONE_TASK_BLOCK, projectYamlWith('fake-alpha', 'fake-alpha'));
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const config = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: ONE_TASK_BLOCK, source: 'execution-manual', projectConfig: config });

    const cap = capture();
    let code = 0;
    try {
      code = await cmdReviewsPlan(root);
    } finally {
      cap.restore();
    }
    const out = cap.out();
    assert.equal(code, 0);
    assert.match(out, /Review Plan/);
    assert.match(out, new RegExp(runId));
    assert.match(out, /frozen/);
    assert.match(out, /spec/);
    assert.match(out, /quality/);
  });

  test('reviews doctor：adapter 可用 → PASS（且只 probe 一次）', async () => {
    const { adapter, probes } = makeCountingAdapter('fake-alpha');
    registerAdapter(adapter);
    const { root, speccraftDir } = await makeReadyProject(ONE_TASK_BLOCK, projectYamlWith('fake-alpha', 'fake-alpha'));
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const config = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: ONE_TASK_BLOCK, source: 'execution-manual', projectConfig: config });

    probes();
    const cap = capture();
    let code = 0;
    try {
      code = await cmdReviewsDoctor(root);
    } finally {
      cap.restore();
    }
    assert.equal(code, 0);
    assert.match(cap.out(), /review preflight PASS/);
    assert.equal(probes(), 1, `doctor 应只 probe 一次（实际 ${probes()}）`);
  });

  test('reviews doctor：adapter 不可用 → blocked（exit 1）', async () => {
    registerAdapter(makeCountingAdapter('fake-alpha').adapter);
    registerAdapter(makeCountingAdapter('fake-gone', { installed: false }).adapter);
    const { root, speccraftDir } = await makeReadyProject(ONE_TASK_BLOCK, projectYamlWith('fake-alpha', 'fake-gone'));
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const config = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: ONE_TASK_BLOCK, source: 'execution-manual', projectConfig: config });

    const cap = capture();
    let code = 0;
    try {
      code = await cmdReviewsDoctor(root);
    } finally {
      cap.restore();
    }
    assert.equal(code, 1);
    assert.match(cap.out(), /review preflight blocked/);
    assert.match(cap.out(), /fake-gone/);
  });

  test('reviews show 展示 Gate / Attempts / Decision / Reviewer / Adapter / Findings / Source Verification', async () => {
    registerAdapter(makeCountingAdapter('fake-alpha').adapter);
    const { root, speccraftDir } = await makeReadyProject(ONE_TASK_BLOCK, projectYamlWith('fake-alpha', 'fake-alpha'));
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const config = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: ONE_TASK_BLOCK, source: 'execution-manual', projectConfig: config });

    // 手写 review attempt manifest（与 runner.ts 的 JSON.stringify 落盘格式一致）
    const attemptDir = path.join(tasksDir(speccraftDir, runId), 'a', 'reviews', 'spec', 'attempt-001');
    await mkdir(attemptDir, { recursive: true });
    const manifest: ReviewAttemptManifest = {
      version: 1,
      attempt: 1,
      run_id: runId,
      task_id: 'a',
      gate_id: 'spec',
      gate_kind: 'spec_compliance',
      reviewer_profile: 'spec-reviewer',
      adapter: 'fake-alpha',
      decision: 'changes_required',
      source_dispatch_attempt: 2,
      source_verification_attempt: 3,
      pre_tree: 'a'.repeat(40),
      post_tree: 'b'.repeat(40),
      pre_commit: 'c'.repeat(40),
      post_commit: 'd'.repeat(40),
      started_at: '2026-09-01T00:00:00Z',
      finished_at: '2026-09-01T00:01:00Z',
      finding_count: 4,
      blocking_findings: 1,
    };
    await writeFile(path.join(attemptDir, 'manifest.yaml'), JSON.stringify(manifest, null, 2), 'utf8');

    const cap = capture();
    let code = 0;
    try {
      code = await cmdReviewsShow('a', root);
    } finally {
      cap.restore();
    }
    const out = cap.out();
    assert.equal(code, 0);
    assert.match(out, /Gate/);
    assert.match(out, /Attempts/);
    assert.match(out, /Decision/);
    assert.match(out, /Reviewer/);
    assert.match(out, /Adapter/);
    assert.match(out, /Findings/);
    // 具体值
    assert.match(out, /spec/);
    assert.match(out, /changes_required/);
    assert.match(out, /spec-reviewer/);
    assert.match(out, /fake-alpha/);
    assert.match(out, /blocking 1/);
    // §6 要求显示 Source Verification（证据绑定）
    assert.match(out, /source:/);
    assert.match(out, /dispatch_attempt=2/);
    assert.match(out, /verification_attempt=3/);
  });

  test('reviews show：无证据时不报错', async () => {
    registerAdapter(makeCountingAdapter('fake-alpha').adapter);
    const { root, speccraftDir } = await makeReadyProject(ONE_TASK_BLOCK, projectYamlWith('fake-alpha', 'fake-alpha'));
    const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
    const config = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody: ONE_TASK_BLOCK, source: 'execution-manual', projectConfig: config });

    const cap = capture();
    let code = 0;
    try {
      code = await cmdReviewsShow('a', root);
    } finally {
      cap.restore();
    }
    assert.equal(code, 0);
    assert.match(cap.out(), /无 review attempt 证据/);
  });
});

// ---------------------------------------------------------------------------
// §19 Review Plan frozen：review evidence 存在时禁止重建
// ---------------------------------------------------------------------------

test('M8.2 §19：review evidence 存在 → compile 拒绝重建 Review Plan', async () => {
  registerAdapter(makeCountingAdapter('fake-alpha').adapter);
  const { root, speccraftDir } = await makeReadyProject(ONE_TASK_BLOCK, projectYamlWith('fake-alpha', 'fake-alpha'));
  const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake-alpha' });
  const config = await loadProjectConfig(speccraftDir);
  await compileTaskGraph({ speccraftDir, runId, manualBody: ONE_TASK_BLOCK, source: 'execution-manual', projectConfig: config });

  // 伪造 review evidence
  const attemptDir = path.join(tasksDir(speccraftDir, runId), 'a', 'reviews', 'spec', 'attempt-001');
  await mkdir(attemptDir, { recursive: true });
  await writeFile(path.join(attemptDir, 'manifest.yaml'), '{}', 'utf8');

  await assert.rejects(
    () => compileTaskGraph({ speccraftDir, runId, manualBody: ONE_TASK_BLOCK, source: 'execution-manual', projectConfig: config }),
    /cannot rebuild review plan after review evidence exists/,
  );
});

// ---------------------------------------------------------------------------
// diagnostics 纯函数（供 CLI 复用，无副作用）
// ---------------------------------------------------------------------------

describe('M8.2 — diagnostics 纯函数', () => {
  test('reviewsListFromPlan：disabled → 空结果', () => {
    const list = reviewsListFromPlan(null);
    assert.equal(list.enabled, false);
    assert.equal(list.gates.length, 0);
  });

  test('reviewsPlanFromPlan：输出 run_id 与 gates', () => {
    const plan = makePlan([
      { id: 'spec', kind: 'spec_compliance', reviewer: 'r1', adapter: 'fake-alpha', resolved: { timeout_seconds: 120 } },
    ]);
    const p = reviewsPlanFromPlan(plan);
    assert.equal(p.runId, 'run-1');
    assert.equal(p.enabled, true);
    assert.equal(p.gates[0].timeout, 120);
  });
});

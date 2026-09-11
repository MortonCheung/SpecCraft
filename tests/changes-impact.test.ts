/**
 * SpecCraft v0.9 §70 —— Commit 3 单元测试。
 *
 * 覆盖：workflow downstream closure / artifact resolution /
 * incomplete analysis / complete analysis / task graph diff / task dependency closure。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { createRun } from '../src/core/execution/store.js';
import { loadProject } from '../src/core/project.js';
import { createChange } from '../src/core/changes/create.js';
import { readChangeManifest } from '../src/core/changes/store.js';
import { stageProposalArtifact, retainArtifact } from '../src/core/changes/proposal.js';
import {
  analyzeChange,
  analysisAttemptDir,
  parseAnalysisAttempt,
  readAnalysisAttemptOrNull,
} from '../src/core/changes/analyze.js';
import {
  computeArtifactClosure,
  diffTaskGraphs,
  impactedTasks,
  transitiveDependents,
} from '../src/core/changes/impact.js';
import { resolveArtifacts } from '../src/core/changes/impact.js';
import { compileTaskGraphFromManual } from '../src/core/tasks/compiler.js';
import { writeTaskGraph } from '../src/core/tasks/store.js';
import type { TaskGraph } from '../src/core/tasks/types.js';
import {
  cmdChangesAnalyze,
  cmdChangesRetain,
  cmdChangesStage,
} from '../src/cli/commands.js';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return chunks.join('\n');
}

async function newProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-impact-'));
  await initProject({ projectRoot: root });
  return root;
}

/** 写入 canonical artifact（合法 frontmatter，供 baseline snapshot 使用） */
async function seedArtifact(
  speccraftDir: string,
  stage: string,
  artifact: string,
  body: string,
): Promise<string> {
  const source = `---\nartifact: ${artifact}\nstage: ${stage}\nstatus: completed\nversion: 1\n---\n\n${body}`;
  await writeFile(path.join(speccraftDir, 'artifacts', `${artifact}.md`), source, 'utf8');
  return source;
}

function manualBody(block: string): string {
  return `# Execution Manual\n\n## Execution Task Graph\n\n\`\`\`speccraft-task-graph\n${block}\n\`\`\`\n`;
}

function graphBlock(tasks: Array<{ id: string; summary: string; dependsOn: string[] }>): string {
  const lines = ['version: 1', '', 'tasks:'];
  for (const t of tasks) {
    lines.push(`  - id: ${t.id}`);
    lines.push(`    title: Task ${t.id.toUpperCase()}`);
    lines.push(`    summary: ${t.summary}`);
    lines.push(`    depends_on: [${t.dependsOn.join(', ')}]`);
    lines.push(`    scope: { paths: [src/${t.id}/**] }`);
    lines.push('    verification: { commands: [npm test], timeout_seconds: 60 }');
  }
  return lines.join('\n');
}

/** 下游均产出 artifact 的最小 baseline stage 集合（用于 closure 测试） */
const DOWNSTREAM_OF_REQUIREMENT = [
  'requirement',
  'concept',
  'research',
  'design',
  'build-brief',
  'site-survey',
  'execution-manual',
] as const;

/** 直接构造一个 TaskGraph（纯函数测试用） */
function makeGraph(runId: string, tasks: Array<[string, string, string[]]>): TaskGraph {
  return {
    version: 1,
    runId,
    source: 'execution-manual',
    createdAt: '2026-09-12T00:00:00.000Z',
    tasks: tasks.map(([id, summary, dependsOn]) => ({
      id,
      title: `Task ${id.toUpperCase()}`,
      summary,
      dependsOn,
      scope: { paths: [`src/${id}/**`] },
      verification: { commands: ['npm test'], timeoutSeconds: 60 },
    })),
  };
}

// ---------------------------------------------------------------------------
// §18 Workflow downstream closure
// ---------------------------------------------------------------------------

test('v0.9 §18：artifact closure 沿真实 Workflow DAG 传播到全部下游', async () => {
  const root = await newProject();
  try {
    const { workflow } = await loadProject(root);
    const existingStages = new Set<string>([
      'idea',
      'feasibility',
      'discovery',
      ...DOWNSTREAM_OF_REQUIREMENT,
    ]);

    const closure = computeArtifactClosure({
      workflow,
      changedStages: ['requirement'],
      existingStages,
    });

    assert.deepEqual(closure.directlyChanged, ['requirement']);
    // requirement 的整条下游链（经 concept / design / build-brief / execution-manual）
    assert.deepEqual(closure.transitivelyAffected, [
      'concept',
      'research',
      'design',
      'build-brief',
      'site-survey',
      'execution-manual',
    ]);
    // 上游 artifact 不受下游变更影响
    assert.deepEqual(closure.unaffected, ['idea', 'feasibility', 'discovery']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §18：不产出 artifact 或尚无 artifact 的 stage 不进入分类', async () => {
  const root = await newProject();
  try {
    const { workflow } = await loadProject(root);
    const closure = computeArtifactClosure({
      workflow,
      changedStages: ['requirement'],
      // 只有 requirement 自身存在 artifact
      existingStages: new Set(['requirement']),
    });

    assert.deepEqual(closure.directlyChanged, ['requirement']);
    // owner-approval / implementation 等过渡 stage 不产出 artifact，被排除
    assert.deepEqual(closure.transitivelyAffected, []);
    assert.deepEqual(closure.unaffected, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §19–§20 Artifact resolution
// ---------------------------------------------------------------------------

test('v0.9 §19–§20：受影响 artifact 无显式决策 → unresolved（禁止自动保留）', async () => {
  const root = await newProject();
  try {
    const { workflow } = await loadProject(root);
    const closure = {
      directlyChanged: ['requirement'],
      transitivelyAffected: ['design', 'execution-manual'],
      unaffected: ['idea'],
    };

    const result = resolveArtifacts({
      closure,
      workflow,
      replacedStages: new Set(['requirement']),
      retainedStages: new Set(),
    });

    assert.deepEqual(result.unresolved, ['design', 'execution-manual']);
    // 未解决项不写入 resolution 列表
    assert.deepEqual(
      result.entries.map((e) => [e.stage, e.resolution]),
      [
        ['requirement', 'replace'],
        ['idea', 'baseline'],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §19–§20：显式 retain → retain；unaffected → baseline', async () => {
  const root = await newProject();
  try {
    const { workflow } = await loadProject(root);
    const result = resolveArtifacts({
      closure: {
        directlyChanged: ['requirement'],
        transitivelyAffected: ['design', 'execution-manual'],
        unaffected: ['idea'],
      },
      workflow,
      replacedStages: new Set(['requirement']),
      retainedStages: new Set(['design']),
    });

    assert.deepEqual(result.unresolved, ['execution-manual']);
    assert.deepEqual(
      result.entries.map((e) => [e.stage, e.classification, e.resolution]),
      [
        ['requirement', 'directly_changed', 'replace'],
        ['design', 'transitively_affected', 'retain'],
        ['idea', 'unaffected', 'baseline'],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §19：directly_changed 但无 replacement → 一致性守卫报 unresolved', async () => {
  const root = await newProject();
  try {
    const { workflow } = await loadProject(root);
    const result = resolveArtifacts({
      closure: { directlyChanged: ['requirement'], transitivelyAffected: [], unaffected: [] },
      workflow,
      replacedStages: new Set(),
      retainedStages: new Set(),
    });
    assert.deepEqual(result.unresolved, ['requirement']);
    assert.deepEqual(result.entries, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §25 Task Graph Diff
// ---------------------------------------------------------------------------

test('v0.9 §25：Task Graph diff 比较声明字段（不只比较 Task ID）', () => {
  const base = makeGraph('run-1', [
    ['a', 'Do A', []],
    ['b', 'Do B', ['a']],
    ['c', 'Do C', ['b']],
  ]);
  const candidate = makeGraph('run-1', [
    ['a', 'Do A differently', []],
    ['b', 'Do B', ['a']],
    ['d', 'Do D', ['b']],
  ]);

  const diff = diffTaskGraphs(base, candidate);
  assert.deepEqual(diff.modified, ['a']);
  assert.deepEqual(diff.unchanged, ['b']);
  assert.deepEqual(diff.removed, ['c']);
  assert.deepEqual(diff.added, ['d']);

  const a = diff.entries.find((e) => e.id === 'a');
  assert.deepEqual(a?.fields, ['summary']);
});

test('v0.9 §25：depends_on / scope 视为集合，顺序变化不算修改', () => {
  const base = makeGraph('run-1', [
    ['a', 'Do A', []],
    ['b', 'Do B', []],
    ['c', 'Do C', ['a', 'b']],
  ]);
  const candidate = makeGraph('run-1', [
    ['a', 'Do A', []],
    ['b', 'Do B', []],
    ['c', 'Do C', ['b', 'a']],
  ]);
  const diff = diffTaskGraphs(base, candidate);
  assert.deepEqual(diff.unchanged, ['a', 'b', 'c']);
  assert.deepEqual(diff.modified, []);
});

// ---------------------------------------------------------------------------
// §26 Task Dependency Closure
// ---------------------------------------------------------------------------

test('v0.9 §26：transitive dependents 覆盖全部下游 Task（不含 seed 自身）', () => {
  const graph = makeGraph('run-1', [
    ['a', 'Do A', []],
    ['b', 'Do B', ['a']],
    ['c', 'Do C', ['b']],
    ['x', 'Do X', []],
  ]);

  assert.deepEqual(transitiveDependents(graph, ['a']), ['b', 'c']);
  assert.deepEqual(transitiveDependents(graph, ['b']), ['c']);
  assert.deepEqual(transitiveDependents(graph, ['c']), []);
  // impacted = seeds ∪ dependents
  assert.deepEqual(impactedTasks(graph, ['a']), ['a', 'b', 'c']);
  assert.deepEqual(impactedTasks(graph, ['x']), ['x']);
});

// ---------------------------------------------------------------------------
// §21–§24 Incomplete / Complete Analysis
// ---------------------------------------------------------------------------

test('v0.9 §21–§22：incomplete analysis 不生成 resolved snapshot，Change 保持 draft', async () => {
  const root = await newProject();
  try {
    const speccraftDir = path.join(root, '.speccraft');
    await createRun(speccraftDir, { id: 'run-1' });
    const { workflow } = await loadProject(root);

    const bodies: Record<string, string> = {};
    for (const stage of DOWNSTREAM_OF_REQUIREMENT) {
      const artifact = workflow.stages.find((s) => s.id === stage)!.produces[0]!;
      bodies[stage] = await seedArtifact(speccraftDir, stage, artifact, `# ${artifact}\n`);
    }

    const manifest = await createChange({
      speccraftDir,
      projectRoot: root,
      workflow,
      baseRunId: 'run-1',
      reason: '新增安全需求',
    });
    assert.equal(manifest.id, 'change-001');

    // 只 stage requirement，不给任何 downstream 决策
    await stageProposalArtifact({
      speccraftDir,
      changeId: manifest.id,
      stageId: 'requirement',
      source: `---\nartifact: requirements\nstage: requirement\nstatus: completed\nversion: 2\n---\n\n# Requirements v2\n`,
      workflow,
    });

    const result = await analyzeChange({ speccraftDir, changeId: manifest.id, workflow });

    assert.equal(result.attempt, 'attempt-001');
    assert.equal(result.result, 'incomplete');
    assert.deepEqual(result.unresolved, [
      'build-brief',
      'concept',
      'design',
      'execution-manual',
      'research',
      'site-survey',
    ]);

    const dir = analysisAttemptDir(speccraftDir, manifest.id, result.attempt);
    assert.ok(await exists(path.join(dir, 'analysis.yaml')));
    assert.ok(await exists(path.join(dir, 'impact.yaml')));
    assert.ok(await exists(path.join(dir, 'impact.md')));
    assert.equal(await exists(path.join(dir, 'resolved')), false);
    assert.equal(await exists(path.join(dir, 'candidate')), false);

    const attempt = parseAnalysisAttempt(await readFile(path.join(dir, 'analysis.yaml'), 'utf8'));
    assert.equal(attempt.result, 'incomplete');
    assert.deepEqual(attempt.resolved, []);
    assert.equal(attempt.candidate.task_graph, null);

    // incomplete 不推进状态，用户可以继续补决策
    assert.equal((await readChangeManifest(speccraftDir, manifest.id)).status, 'draft');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §23–§26：complete analysis 生成 resolved snapshot + candidate plans + 新 Attempt', async () => {
  const root = await newProject();
  try {
    const speccraftDir = path.join(root, '.speccraft');
    await createRun(speccraftDir, { id: 'run-1' });
    const { workflow } = await loadProject(root);

    const baseBlock = graphBlock([
      { id: 'a', summary: 'Do A', dependsOn: [] },
      { id: 'b', summary: 'Do B', dependsOn: ['a'] },
      { id: 'c', summary: 'Do C', dependsOn: ['b'] },
    ]);
    const nextBlock = graphBlock([
      { id: 'a', summary: 'Do A differently', dependsOn: [] },
      { id: 'b', summary: 'Do B', dependsOn: ['a'] },
      { id: 'd', summary: 'Do D', dependsOn: ['b'] },
    ]);

    for (const stage of DOWNSTREAM_OF_REQUIREMENT) {
      const artifact = workflow.stages.find((s) => s.id === stage)!.produces[0]!;
      const body = stage === 'execution-manual' ? manualBody(baseBlock) : `# ${artifact}\n`;
      await seedArtifact(speccraftDir, stage, artifact, body);
    }
    const baseGraph = compileTaskGraphFromManual({
      manualBody: manualBody(baseBlock),
      runId: 'run-1',
      source: 'execution-manual',
    });
    await writeTaskGraph(speccraftDir, 'run-1', baseGraph);

    const manifest = await createChange({
      speccraftDir,
      projectRoot: root,
      workflow,
      baseRunId: 'run-1',
      reason: '新增安全需求并调整任务图',
    });

    await stageProposalArtifact({
      speccraftDir,
      changeId: manifest.id,
      stageId: 'requirement',
      source: `---\nartifact: requirements\nstage: requirement\nstatus: completed\nversion: 2\n---\n\n# Requirements v2\n`,
      workflow,
    });
    await stageProposalArtifact({
      speccraftDir,
      changeId: manifest.id,
      stageId: 'execution-manual',
      source: `---\nartifact: execution-manual\nstage: execution-manual\nstatus: completed\nversion: 2\n---\n\n${manualBody(nextBlock)}`,
      workflow,
    });
    for (const stage of ['concept', 'research', 'design', 'build-brief', 'site-survey']) {
      await retainArtifact({ speccraftDir, changeId: manifest.id, stageId: stage, workflow });
    }

    const result = await analyzeChange({ speccraftDir, changeId: manifest.id, workflow });

    assert.equal(result.attempt, 'attempt-001');
    assert.equal(result.result, 'complete');
    assert.deepEqual(result.unresolved, []);
    assert.equal(result.noEffect, false);
    assert.equal(result.impact.required_successor_run, true);

    const dir = analysisAttemptDir(speccraftDir, manifest.id, result.attempt);
    // §23：resolved snapshot 是完全 resolved 的世界
    for (const stage of DOWNSTREAM_OF_REQUIREMENT) {
      assert.ok(
        await exists(path.join(dir, 'resolved', 'artifacts', `${stage}.md`)),
        `resolved/${stage}.md 应存在`,
      );
    }
    assert.ok(await exists(path.join(dir, 'resolved', 'project.yaml')));
    // §24–§28：candidate plans
    assert.ok(await exists(path.join(dir, 'candidate', 'task-graph.yaml')));
    assert.ok(await exists(path.join(dir, 'candidate', 'executor-plan.yaml')));

    const attempt = parseAnalysisAttempt(await readFile(path.join(dir, 'analysis.yaml'), 'utf8'));
    assert.equal(attempt.result, 'complete');
    assert.equal(attempt.required_successor_run, true);
    assert.equal(attempt.staged_stages.includes('requirement'), true);
    assert.deepEqual(attempt.retained_stages, [
      'build-brief',
      'concept',
      'design',
      'research',
      'site-survey',
    ]);
    assert.ok(attempt.resolved.some((r) => r.stage === 'requirement' && r.resolution === 'replace'));
    assert.ok(attempt.resolved.some((r) => r.stage === 'design' && r.resolution === 'retain'));
    assert.ok(attempt.analysis_bundle_sha256);
    assert.ok(attempt.impact_sha256);
    assert.equal(attempt.candidate.task_graph, 'candidate/task-graph.yaml');

    // §25–§26：Task Graph diff 与依赖影响
    const diff = result.impact.task_graph.diff;
    assert.equal(result.impact.task_graph.applicable, true);
    assert.equal(result.impact.task_graph.changed, true);
    assert.deepEqual(diff.modified, ['a']);
    assert.deepEqual(diff.removed, ['c']);
    assert.deepEqual(diff.added, ['d']);
    assert.deepEqual(diff.unchanged, ['b']);
    assert.deepEqual(result.impact.task_graph.old_graph_impacted, ['a', 'b', 'c']);
    assert.deepEqual(result.impact.task_graph.new_graph_impacted, ['a', 'b', 'd']);

    // complete → analyzed
    assert.equal((await readChangeManifest(speccraftDir, manifest.id)).status, 'analyzed');

    // §21：再次分析产生新 Attempt，永不覆盖
    const second = await analyzeChange({ speccraftDir, changeId: manifest.id, workflow });
    assert.equal(second.attempt, 'attempt-002');
    assert.ok(await exists(path.join(dir, 'analysis.yaml')));
    assert.ok(await exists(analysisAttemptDir(speccraftDir, manifest.id, 'attempt-002')));
    assert.ok(await readAnalysisAttemptOrNull(speccraftDir, manifest.id, 'attempt-001'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §31：内容与 baseline 完全一致的 Change → no_effect，不要求 Successor Run', async () => {
  const root = await newProject();
  try {
    const speccraftDir = path.join(root, '.speccraft');
    await createRun(speccraftDir, { id: 'run-1' });
    const { workflow } = await loadProject(root);

    let requirementSource = '';
    for (const stage of DOWNSTREAM_OF_REQUIREMENT) {
      const artifact = workflow.stages.find((s) => s.id === stage)!.produces[0]!;
      const body = `# ${artifact}\n`;
      const source = await seedArtifact(speccraftDir, stage, artifact, body);
      if (stage === 'requirement') requirementSource = source;
    }

    const manifest = await createChange({
      speccraftDir,
      projectRoot: root,
      workflow,
      baseRunId: 'run-1',
      reason: '无实际变化的变更',
    });

    // replacement 与 baseline 字节完全一致
    await stageProposalArtifact({
      speccraftDir,
      changeId: manifest.id,
      stageId: 'requirement',
      source: requirementSource,
      workflow,
    });
    for (const stage of ['concept', 'research', 'design', 'build-brief', 'site-survey', 'execution-manual']) {
      await retainArtifact({ speccraftDir, changeId: manifest.id, stageId: stage, workflow });
    }

    const result = await analyzeChange({ speccraftDir, changeId: manifest.id, workflow });
    assert.equal(result.result, 'complete');
    assert.equal(result.noEffect, true);
    assert.equal(result.impact.required_successor_run, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI（§15–§16、§21–§22）
// ---------------------------------------------------------------------------

test('v0.9 §15–§22：changes stage / retain / analyze 的 CLI 输出契约', async () => {
  const root = await newProject();
  try {
    const speccraftDir = path.join(root, '.speccraft');
    await createRun(speccraftDir, { id: 'run-1' });
    const { workflow } = await loadProject(root);

    for (const stage of DOWNSTREAM_OF_REQUIREMENT) {
      const artifact = workflow.stages.find((s) => s.id === stage)!.produces[0]!;
      await seedArtifact(speccraftDir, stage, artifact, `# ${artifact}\n`);
    }
    const manifest = await createChange({
      speccraftDir,
      projectRoot: root,
      workflow,
      baseRunId: 'run-1',
      reason: 'CLI 契约',
    });

    const replacementPath = path.join(root, 'requirement-v2.md');
    await writeFile(
      replacementPath,
      `---\nartifact: requirements\nstage: requirement\nstatus: completed\nversion: 2\n---\n\n# Requirements v2\n`,
      'utf8',
    );

    const stageOut = await captureStdout(() =>
      cmdChangesStage(
        manifest.id,
        { artifact: 'requirement', file: replacementPath },
        root,
      ),
    );
    assert.match(stageOut, /已 stage artifact replacement：change-001/);
    assert.match(stageOut, /proposal\/artifacts\/requirement\.md/);

    const retainOut = await captureStdout(() =>
      cmdChangesRetain(manifest.id, { artifact: 'design' }, root),
    );
    assert.match(retainOut, /已 retain artifact：change-001/);

    // 仍有未解决项 → CLI 打印 Unresolved 列表并返回非 0
    const incompleteOut = await captureStdout(async () => {
      const code = await cmdChangesAnalyze(manifest.id, root);
      assert.equal(code, 1);
    });
    assert.match(incompleteOut, /Analysis Attempt：attempt-001（incomplete）/);
    assert.match(incompleteOut, /Unresolved affected artifacts:/);
    assert.match(incompleteOut, /- concept/);
    assert.match(incompleteOut, /- execution-manual/);

    for (const stage of ['concept', 'research', 'build-brief', 'site-survey', 'execution-manual']) {
      await captureStdout(() => cmdChangesRetain(manifest.id, { artifact: stage }, root));
    }

    const completeOut = await captureStdout(async () => {
      const code = await cmdChangesAnalyze(manifest.id, root);
      assert.equal(code, 0);
    });
    assert.match(completeOut, /Analysis Attempt：attempt-002（complete）/);
    assert.match(completeOut, /no effect: no/);
    assert.match(completeOut, /successor run required: yes/);
    assert.match(completeOut, /speccraft changes approve change-001 --by <owner>/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

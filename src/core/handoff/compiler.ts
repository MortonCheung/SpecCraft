/**
 * Handoff Package 确定性编译（ADR 0004 §6）。
 *
 * 复用 Context Compiler / Git 快照 / acceptance & verification 记录，
 * 不调用 AI、不修改源 Artifact、不复制 node_modules / 整个 repo。
 */

import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { artifactFileName } from '../artifacts/store.js';
import { runDir } from '../execution/store.js';
import { captureGitSnapshot } from '../execution/git.js';
import type { Workflow, State } from '../types.js';
import type { DecisionSource, HandoffCompileInput, HandoffManifest } from './types.js';

/** handoff 需要纳入 context 的核心 artifact（按 workflow 顺序） */
export const HANDOFF_ARTIFACTS = [
  'idea',
  'requirements',
  'concept',
  'research',
  'design',
  'build-brief',
  'site-survey',
  'execution-manual',
  'verification',
];

/** 读取 .speccraft/decisions/ 按稳定顺序编译（不总结，保留原文） */
export async function compileDecisions(speccraftDir: string): Promise<DecisionSource[]> {
  const dir = path.join(speccraftDir, 'decisions');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
  const out: DecisionSource[] = [];
  for (const f of files) {
    const body = await readFile(path.join(dir, f), 'utf8');
    out.push({ filename: f, title: extractTitle(body), body });
  }
  return out;
}

/** 编译 handoff 的 context（复用 Context Compiler 读取 artifact） */
export async function compileHandoffContext(
  speccraftDir: string,
  workflow: Workflow,
): Promise<{ markdown: string; missing: string[] }> {
  const sections: string[] = [];
  const missing: string[] = [];

  for (const id of HANDOFF_ARTIFACTS) {
    const file = path.join(speccraftDir, 'artifacts', artifactFileName(id));
    if (!(await pathExists(file))) {
      missing.push(id);
      continue;
    }
    const source = await readFile(file, 'utf8');
    const body = extractBody(source);
    sections.push(`## [${id}]\n\n${body.trim()}`);
  }

  const markdown = sections.length > 0
    ? `# Handoff Context\n\n${sections.join('\n\n---\n\n')}\n`
    : '# Handoff Context\n\n（无 artifact）\n';
  return { markdown, missing };
}

/**
 * 编译 review history 摘要（v0.8 §17）。
 *
 * 确定性编译 Review Attempt Evidence（不调用 AI、不复制 Finding 正文）。
 * 稳定顺序：Task Graph order → Frozen Review Plan gate order → attempt ascending。
 * 无 Review Plan / review disabled / 无任何 review attempt → 返回 []（不写文件）。
 *
 * 数据源：frozen Review Plan + runs/<run>/tasks/<task>/reviews/<gate>/attempt-NNN/manifest.yaml。
 */
export async function compileReviewHistory(speccraftDir: string, runId: string): Promise<string[]> {
  const { readReviewPlanOrNull } = await import('../reviews/store.js');
  const plan = await readReviewPlanOrNull(speccraftDir, runId);
  if (!plan || !plan.enabled || plan.gates.length === 0) return [];

  const { readTaskGraphOrNull } = await import('../tasks/store.js');
  const graph = await readTaskGraphOrNull(speccraftDir, runId);
  if (!graph) return [];

  const { listReviewAttempts } = await import('../reviews/attempt.js');
  const { tasksDir } = await import('../tasks/store.js');

  const lines: string[] = ['# Review History', '', `Run: ${runId}`, '', '## Review Attempts', ''];
  let total = 0;
  for (const t of graph.tasks) {
    for (const gate of plan.gates) {
      const attempts = await listReviewAttempts(speccraftDir, runId, t.id, gate.id);
      if (attempts.length === 0) continue;
      total += attempts.length;
      lines.push(`### ${t.id} / ${gate.id}`);
      for (const m of attempts) {
        lines.push('');
        lines.push(`#### Attempt ${m.attempt}`);
        lines.push(`- kind: ${m.gate_kind}`);
        lines.push(`- reviewer profile: ${m.reviewer_profile}`);
        lines.push(`- adapter: ${m.adapter}`);
        lines.push(`- review attempt: ${m.attempt}`);
        lines.push(`- source dispatch attempt: ${m.source_dispatch_attempt}`);
        lines.push(`- source verification attempt: ${m.source_verification_attempt}`);
        if (m.workspace_attempt !== undefined) {
          lines.push(`- workspace attempt: ${m.workspace_attempt}`);
        } else {
          lines.push('- workspace attempt: （无）');
        }
        lines.push(`- decision: ${m.decision}`);
        lines.push(`- error code: ${m.error_code ?? '（无）'}`);
        lines.push(`- blocking findings: ${m.blocking_findings}`);
        lines.push(`- minor findings: ${await countMinorFindings(path.join(tasksDir(speccraftDir, runId), t.id, 'reviews', gate.id, `attempt-${String(m.attempt).padStart(3, '0')}`))}`);
        lines.push(`- review session: ${m.session_id ?? '（无）'}`);
        lines.push(`- started at: ${m.started_at}`);
        lines.push(`- finished at: ${m.finished_at}`);
      }
      lines.push('');
    }
  }
  if (total === 0) return [];
  return lines;
}

/**
 * v0.9 §52：Successor Handoff 的 `change-history.md`。
 *
 * 数据源全部来自 Change Evidence（lineage / manifest / analysis attempt /
 * approval / materialization / close），确定性渲染，不调用 AI。
 * 非 Change 产生的 Run（无 lineage.yaml）返回 null。
 */
export async function compileChangeHistory(
  speccraftDir: string,
  runId: string,
): Promise<string | null> {
  const { readRunLineageOrNull, readChangeMaterializationOrNull } = await import(
    '../changes/lineage.js'
  );
  const lineage = await readRunLineageOrNull(speccraftDir, runId);
  if (!lineage) return null;

  const changeId = lineage.change_id;
  const { readChangeManifestOrNull } = await import('../changes/store.js');
  const { readApprovalOrNull } = await import('../changes/approval.js');
  const { readChangeCloseOrNull } = await import('../changes/close.js');
  const { analysisAttemptDir, readAnalysisAttemptOrNull, IMPACT_YAML_FILE } = await import(
    '../changes/analyze.js'
  );

  const manifest = await readChangeManifestOrNull(speccraftDir, changeId);
  const approval = await readApprovalOrNull(speccraftDir, changeId);
  const materialization = await readChangeMaterializationOrNull(speccraftDir, changeId);
  const close = await readChangeCloseOrNull(speccraftDir, changeId);
  const attempt = approval
    ? await readAnalysisAttemptOrNull(speccraftDir, changeId, approval.analysis_attempt)
    : null;
  const impact = attempt
    ? await readImpactYamlOrNull(
        path.join(analysisAttemptDir(speccraftDir, changeId, attempt.attempt), IMPACT_YAML_FILE),
      )
    : null;

  const replaced = (attempt?.resolved ?? [])
    .filter((r) => r.resolution === 'replace')
    .map((r) => `${r.artifact}（stage ${r.stage}）`);
  const retained = (attempt?.resolved ?? [])
    .filter((r) => r.resolution === 'retain')
    .map((r) => `${r.artifact}（stage ${r.stage}）`);

  const lines: string[] = [
    '# Change History',
    '',
    `- Change ID: ${changeId}`,
    `- Predecessor Run: ${lineage.predecessor_run}`,
    `- Successor Run: ${runId}`,
    `- Reason: ${indentValue(manifest?.reason ?? '（缺失）')}`,
    `- Source: ${manifest?.source ?? '（缺失）'}${
      manifest?.sourceRef ? `（${manifest.sourceRef}）` : ''
    }`,
    `- Approved By: ${approval?.approved_by ?? '（缺失）'}`,
    `- Approved Analysis Attempt: ${lineage.approved_analysis_attempt}`,
    `- Materialized At: ${materialization?.created_at ?? '（缺失）'}`,
    `- Closed At: ${close?.closed_at ?? '（未 close）'}`,
    '',
    '## Changed Artifacts',
    '',
  ];
  pushMarkdownList(lines, replaced);
  lines.push('', '## Retained Artifacts', '');
  pushMarkdownList(lines, retained);

  const diff = impact?.task_graph?.diff;
  lines.push('', '## Task Diff', '');
  if (impact) {
    lines.push(`- added: ${inlineList(diff?.added)}`);
    lines.push(`- removed: ${inlineList(diff?.removed)}`);
    lines.push(`- modified: ${inlineList(diff?.modified)}`);
    lines.push(`- unchanged: ${diff?.unchanged?.length ?? 0}`);
  } else {
    lines.push('- （无 impact evidence）');
  }

  lines.push('', '## Executor Diff', '');
  const assignmentChanges = (impact?.executor_plan?.assignments ?? []).filter(
    (a) => a.change !== 'unchanged',
  );
  if (!impact) {
    lines.push('- （无 impact evidence）');
  } else if (assignmentChanges.length === 0) {
    lines.push('- （无变更）');
  } else {
    for (const a of assignmentChanges) {
      lines.push(
        `- ${a.task_id ?? '?'}: ${a.change ?? '?'}（${a.base_executor ?? '（无）'} → ${
          a.candidate_executor ?? '（无）'
        }）`,
      );
    }
  }

  lines.push('', '## Review Diff', '');
  const reviewPlan = impact?.review_plan;
  if (!reviewPlan) {
    lines.push('- （无 impact evidence）');
  } else {
    lines.push(`- enabled: ${String(reviewPlan.base_enabled)} → ${String(reviewPlan.candidate_enabled)}`);
    lines.push(`- changed: ${reviewPlan.changed === true}`);
    const gateChanges = (reviewPlan.gates ?? []).filter((g) => g.change !== 'unchanged');
    if (gateChanges.length === 0) {
      lines.push('- gates: （无变更）');
    } else {
      for (const g of gateChanges) {
        lines.push(
          `- ${g.id ?? '?'}: ${g.change ?? '?'}（${g.base_kind ?? '（无）'} → ${
            g.candidate_kind ?? '（无）'
          }）`,
        );
      }
    }
  }
  lines.push('');

  return lines.join('\n');
}

/** 缩进多行值（Reason 允许换行，保持确定性） */
function indentValue(value: string): string {
  return value.replace(/\n/g, '\n  ');
}

function pushMarkdownList(lines: string[], items: readonly string[]): void {
  if (items.length === 0) {
    lines.push('- （无）');
    return;
  }
  for (const item of items) lines.push(`- ${item}`);
}

function inlineList(items: readonly string[] | undefined): string {
  return items && items.length > 0 ? items.join(', ') : '（无）';
}

interface ImpactDoc {
  task_graph?: {
    diff?: { added?: string[]; removed?: string[]; modified?: string[]; unchanged?: string[] };
  };
  executor_plan?: {
    assignments?: Array<{
      task_id?: string;
      change?: string;
      base_executor?: string | null;
      candidate_executor?: string | null;
    }>;
  };
  review_plan?: {
    base_enabled?: boolean | null;
    candidate_enabled?: boolean | null;
    changed?: boolean;
    gates?: Array<{
      id?: string;
      change?: string;
      base_kind?: string | null;
      candidate_kind?: string | null;
    }>;
  };
}

/** 读取 Attempt 的 impact.yaml（缺失或非法 → null，不阻塞 handoff） */
async function readImpactYamlOrNull(file: string): Promise<ImpactDoc | null> {
  try {
    const loaded = yaml.load(await readFile(file, 'utf8'));
    if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) return null;
    return loaded as ImpactDoc;
  } catch {
    return null;
  }
}

/** 统计 attempt 目录 findings.yaml 中 minor severity 数量（§17；error/无 findings 时文件不存在 → 0） */
async function countMinorFindings(attemptDir: string): Promise<number> {
  const findingsPath = path.join(attemptDir, 'findings.yaml');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(findingsPath, 'utf8'));
  } catch {
    return 0;
  }
  if (!Array.isArray(parsed)) return 0;
  let minor = 0;
  for (const f of parsed) {
    if (f && typeof f === 'object' && (f as { severity?: unknown }).severity === 'minor') minor += 1;
  }
  return minor;
}

/** 编译 execution history 摘要（Run 报告 + 生命周期，不删失败/reject 历史） */
export async function compileExecutionHistory(
  speccraftDir: string,
  runId: string,
): Promise<string[]> {
  const lines: string[] = [`Execution Run: ${runId}`];
  const reportsDir = runDir(speccraftDir, runId);
  let files: string[];
  try {
    files = (await readdir(reportsDir)).filter((f) => /^agent-report-\d+\.md$/.test(f)).sort();
  } catch {
    files = [];
  }
  if (files.length === 0) {
    lines.push('（无 execution report）');
  } else {
    for (const f of files) {
      const source = await readFile(path.join(reportsDir, f), 'utf8');
      const title = extractTitle(source) || f;
      lines.push('');
      lines.push(`### ${f}`);
      lines.push(`${title}`);
      lines.push(source.trim());
    }
  }
  return lines;
}

/** 编译 verification history 摘要（含失败 attempt） */
export async function compileVerificationHistory(
  speccraftDir: string,
  runId: string,
): Promise<string[]> {
  const dir = path.join(runDir(speccraftDir, runId), 'verification');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => /^attempt-\d+\.yaml$/.test(f)).sort();
  } catch {
    return ['（无 verification attempt）'];
  }
  if (files.length === 0) return ['（无 verification attempt）'];
  const lines: string[] = [];
  for (const f of files) {
    const parsed = yaml.load(await readFile(path.join(dir, f), 'utf8')) as {
      attempt?: number;
      passed?: boolean;
      started_at?: string;
      finished_at?: string;
      commands?: { command?: string; passed?: boolean; log?: string }[];
    } | null;
    if (!parsed) continue;
    lines.push('');
    lines.push(`### Attempt ${parsed.attempt ?? '?'}`);
    lines.push(`- passed: ${parsed.passed ? 'PASS' : 'FAIL'}`);
    if (parsed.finished_at) lines.push(`- finished_at: ${parsed.finished_at}`);
    for (const c of parsed.commands ?? []) {
      lines.push(`  - ${c.passed ? 'PASS' : 'FAIL'} ${c.command ?? ''}（log: ${c.log ?? ''}）`);
    }
  }
  return lines;
}

/** 编译 acceptance history 摘要（含 reject，保留 REJECT→FIX→PASS→ACCEPT 路径） */
export async function compileAcceptanceHistory(
  speccraftDir: string,
  runId: string,
): Promise<string[]> {
  const { listAcceptanceRecords } = await import('../acceptance/store.js');
  const records = await listAcceptanceRecords(speccraftDir, runId);
  if (records.length === 0) return ['（无 acceptance record）'];
  const lines: string[] = [];
  for (const rec of records) {
    const fm = rec.frontmatter;
    lines.push('');
    lines.push(`### ${rec.filename}`);
    lines.push(`- decision: ${fm.decision.toUpperCase()}`);
    lines.push(`- owner: ${fm.owner}`);
    lines.push(`- verification_attempt: ${fm.verification_attempt}`);
    if (fm.git_commit) lines.push(`- git_commit: ${fm.git_commit}`);
    lines.push(rec.body.trim());
  }
  return lines;
}

/**
 * 编译 executor history（v0.7 §56）。
 *
 * 确定性聚合：Task | Executor Profile | Adapter | Model（如果声明）|
 * Dispatch Attempts | Workspace Attempts | Provider Sessions。
 * 数据源为 frozen Executor Plan / dispatch manifests / workspace manifests；
 * 不调用 AI。legacy Run（无 Executor Plan）输出占位说明。
 */
export async function compileExecutorHistory(
  speccraftDir: string,
  runId: string,
): Promise<string[]> {
  const { readExecutorPlanOrNull } = await import('../executors/store.js');
  const plan = await readExecutorPlanOrNull(speccraftDir, runId);
  if (!plan) {
    return ['（无 Executor Plan：Run 未编译 Task Graph / Executor Plan）'];
  }

  const { readTaskGraphOrNull } = await import('../tasks/store.js');
  const graph = await readTaskGraphOrNull(speccraftDir, runId);
  const { listDispatchAttempts, readDispatchAttempt } = await import('../dispatch/store.js');
  const { listWorkspaceAttempts, readWorkspace } = await import('../workspaces/store.js');

  const byTask = new Map(plan.assignments.map((a) => [a.taskId, a]));

  // Task → dispatch attempts / provider sessions（去重保留顺序）
  const dispatchByTask = new Map<string, string[]>();
  const sessionsByTask = new Map<string, string[]>();
  for (const n of await listDispatchAttempts(speccraftDir, runId)) {
    const m = await readDispatchAttempt(speccraftDir, runId, n);
    if (!m?.task_id) continue;
    if (!dispatchByTask.has(m.task_id)) dispatchByTask.set(m.task_id, []);
    dispatchByTask.get(m.task_id)!.push(String(n));
    if (m.session_id) {
      if (!sessionsByTask.has(m.task_id)) sessionsByTask.set(m.task_id, []);
      if (!sessionsByTask.get(m.task_id)!.includes(m.session_id)) {
        sessionsByTask.get(m.task_id)!.push(m.session_id);
      }
    }
  }

  // Task → workspace attempts
  const workspaceByTask = new Map<string, string[]>();
  for (const [taskId] of byTask) {
    const attempts = await listWorkspaceAttempts(speccraftDir, runId, taskId);
    if (attempts.length > 0) workspaceByTask.set(taskId, attempts.map(String));
  }

  const lines: string[] = [`Executor Run: ${runId}`];
  for (const t of graph?.tasks ?? []) {
    const a = byTask.get(t.id);
    if (!a) continue;
    lines.push('');
    lines.push(`### ${t.id}`);
    lines.push(`- Executor Profile: ${a.executor}`);
    lines.push(`- Adapter: ${a.adapter}`);
    if (a.resolved.model) lines.push(`- Model: ${a.resolved.model}`);
    lines.push(`- Dispatch Attempts: [${(dispatchByTask.get(t.id) ?? []).join(', ') || '无'}]`);
    lines.push(`- Workspace Attempts: [${(workspaceByTask.get(t.id) ?? []).join(', ') || '无'}]`);
    lines.push(`- Provider Sessions: [${(sessionsByTask.get(t.id) ?? []).join(', ') || '无'}]`);
  }
  return lines;
}

/** 采集 handoff 时点的只读 Git 快照（非 Git 仓库返回 available:false，不伪造 commit） */
export async function compileGitSnapshot(projectRoot: string): Promise<HandoffManifest['git']> {
  const snap = await captureGitSnapshot(projectRoot);
  if (!snap) return { available: false };
  return {
    available: true,
    ...(snap.branch ? { branch: snap.branch } : {}),
    ...(snap.commit ? { commit: snap.commit } : {}),
    dirty: snap.dirty,
  };
}

/** 渲染 HANDOFF.md（人类 / 下一任 AI 首先阅读，确定性模板） */
export function renderHandoffDoc(input: HandoffCompileInput): string {
  const g = input.git;
  const gitLine = g.available
    ? `${g.branch ?? '?'} @ ${g.commit ?? '?'}${g.dirty ? '（dirty）' : ''}`
    : '（非 Git 仓库）';

  return [
    `# Handoff — ${input.projectName}`,
    '',
    `- Handoff ID: ${input.handoffId}`,
    `- Run ID: ${input.runId}`,
    `- 生成时间: ${input.createdAt}`,
    `- Workflow 终态: handoff`,
    '',
    '## Repository',
    '',
    gitLine,
    '',
    '## Owner Acceptance 结果',
    '',
    `decision: ${input.acceptance.decision.toUpperCase()}（attempt ${input.acceptance.latest_attempt}）`,
    '',
    '## 核心 Artifact 索引',
    '',
    ...HANDOFF_ARTIFACTS.map((id) => `- ${id}`),
    '',
    '## 关键 Decision 索引',
    '',
    ...(input.decisions.length > 0
      ? input.decisions.map((d) => `- ${d.filename} — ${d.title}`)
      : ['- （无）']),
    '',
    '## Execution history 摘要',
    '',
    ...input.executionHistory,
    '',
    '## Verification history 摘要',
    '',
    ...input.verificationHistory,
    '',
    '## Acceptance history 摘要',
    '',
    ...input.acceptanceHistory,
    '',
    '## Executor history 摘要',
    '',
    ...input.executorHistory,
    '',
    '## Review history 摘要',
    '',
    ...(input.reviewHistory.length > 0
      ? input.reviewHistory
      : ['（无 review attempt：review disabled 或 Run 无 review evidence）']),
    '',
    '## 如何继续接手',
    '',
    '1. 阅读本目录下 HANDOFF.md 与 context.md；',
    '2. 核对 manifest.yaml 中的 git 快照与 verification/acceptance 证据链；',
    '3. 如需新一轮施工：在项目根目录运行 `speccraft prepare`（新 Run 不会删除历史）。',
    '',
  ].join('\n');
}

/** 渲染 decisions.md（稳定顺序，保留原文） */
export function renderDecisionsDoc(decisions: DecisionSource[]): string {
  if (decisions.length === 0) return '# Decisions\n\n（无）\n';
  const parts = decisions.map((d) => {
    const heading = d.title || d.filename;
    return `## ${d.filename} — ${heading}\n\n${d.body.trim()}`;
  });
  return `# Decisions\n\n${parts.join('\n\n---\n\n')}\n`;
}

/** 渲染 manifest.yaml（机器读取入口；fileHashes 为 Package 内文件 hash，不含自身） */
export function renderManifestYaml(
  input: HandoffCompileInput,
  fileHashes: Record<string, string> = {},
): string {
  const manifest: HandoffManifest = {
    handoff_id: input.handoffId,
    run_id: input.runId,
    created_at: input.createdAt,
    workflow_stage: 'handoff',
    verification: input.verification,
    acceptance: input.acceptance,
    git: input.git,
    sources: {
      artifacts: HANDOFF_ARTIFACTS.filter((a) => !input.missingArtifacts.includes(a)),
      decisions: input.decisions.map((d) => d.filename),
      execution_reports: input.sourceLists.execution_reports,
      verification_attempts: input.sourceLists.verification_attempts,
      acceptance_records: input.sourceLists.acceptance_records,
      review_attempts: input.sourceLists.review_attempts,
    },
    files: [
      'HANDOFF.md',
      'context.md',
      'decisions.md',
      'execution-history.md',
      'task-history.md',
      'workspace-history.md',
      'executor-history.md',
      'verification-history.md',
      'acceptance-history.md',
      ...(input.reviewHistory.length > 0 ? ['review-history.md'] : []),
      ...(input.changeHistory !== null ? ['change-history.md'] : []),
      'manifest.yaml',
    ],
    file_hashes: fileHashes,
  };
  // sources.execution_reports / verification_attempts / acceptance_records / review_attempts 由 lifecycle 填充
  return yaml.dump(manifest, { indent: 2, lineWidth: -1, noRefs: true });
}

/** 提取 markdown 首个 # 标题 */
function extractTitle(body: string): string {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

/** 去掉 frontmatter，取正文 */
function extractBody(source: string): string {
  const m = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? source.slice(m[0].length) : source;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function makeSourceLists(
  speccraftDir: string,
  runId: string,
): Promise<{
  execution_reports: string[];
  verification_attempts: string[];
  acceptance_records: string[];
  review_attempts: string[];
}> {
  return listRunSources(speccraftDir, runId);
}

async function listRunSources(
  speccraftDir: string,
  runId: string,
): Promise<{
  execution_reports: string[];
  verification_attempts: string[];
  acceptance_records: string[];
  review_attempts: string[];
}> {
  const base = runDir(speccraftDir, runId);
  const result = {
    execution_reports: [] as string[],
    verification_attempts: [] as string[],
    acceptance_records: [] as string[],
    review_attempts: [] as string[],
  };
  try {
    result.execution_reports = (await readdir(base)).filter((f) => /^agent-report-\d+\.md$/.test(f)).sort();
  } catch {
    /* ignore */
  }
  try {
    result.verification_attempts = (await readdir(path.join(base, 'verification'))).filter((f) => /^attempt-\d+\.yaml$/.test(f)).sort();
  } catch {
    /* ignore */
  }
  try {
    result.acceptance_records = (await readdir(path.join(base, 'acceptance'))).filter((f) => /^acceptance-\d+\.md$/.test(f)).sort();
  } catch {
    /* ignore */
  }
  // §17.1：review attempt evidence（tasks/<task>/reviews/<gate>/attempt-NNN/manifest.yaml）
  const tasksBase = path.join(base, 'tasks');
  try {
    const taskIds = (await readdir(tasksBase, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const taskId of taskIds) {
      const reviewsDir = path.join(tasksBase, taskId, 'reviews');
      let gateIds: string[] = [];
      try {
        gateIds = (await readdir(reviewsDir, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();
      } catch {
        continue;
      }
      for (const gateId of gateIds) {
        const gateDir = path.join(reviewsDir, gateId);
        let attemptDirs: string[] = [];
        try {
          attemptDirs = (await readdir(gateDir, { withFileTypes: true }))
            .filter((e) => e.isDirectory() && /^attempt-\d+$/.test(e.name))
            .map((e) => e.name)
            .sort();
        } catch {
          continue;
        }
        for (const attemptDir of attemptDirs) {
          result.review_attempts.push(
            path.join('tasks', taskId, 'reviews', gateId, attemptDir, 'manifest.yaml'),
          );
        }
      }
    }
  } catch {
    /* ignore */
  }
  return result;
}

export type { HandoffCompileInput as CompileInput };
export { listRunSources };

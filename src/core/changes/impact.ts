/**
 * Deterministic Change Impact Analysis（SpecCraft v0.9 §17–§31，ADR 0010）。
 *
 * 核心原则：Runtime 只依据显式 changed artifact + Workflow dependency graph +
 * Task dependency graph + candidate plan diff 做判断。
 * 禁止 LLM / AI ranking / auto selection / 语义推断。
 *
 * 本模块只做纯计算与报告渲染：
 *   - Artifact Closure（§18）
 *   - Affected artifact Resolution（§19–§20）
 *   - Task Dependency Impact（§26）
 *   - Task Graph Diff（§25）
 *   - Executor / Review Plan Diff（§27–§29）
 *   - Frozen Evidence Invalidation 措辞（§30）
 *   - Impact Report（§29）渲染
 *
 * 持久化（Analysis Attempt / Resolved Snapshot）由 analyze.ts 负责。
 */

import yaml from 'js-yaml';
import type { Workflow } from '../types.js';
import type { TaskGraph } from '../tasks/types.js';
import type { ExecutorPlan } from '../executors/types.js';
import type { ReviewPlan } from '../reviews/types.js';

// ---------------------------------------------------------------------------
// §18 Artifact Closure
// ---------------------------------------------------------------------------

/** Artifact 影响分类（v0.9 §18） */
export type ImpactClassification = 'directly_changed' | 'transitively_affected' | 'unaffected';

export interface ArtifactClosure {
  /** 显式 stage 了新版本的 artifact（按 workflow 声明顺序） */
  directlyChanged: string[];
  /** 从真实 Workflow DAG 计算出的 downstream affected artifact（按 workflow 声明顺序） */
  transitivelyAffected: string[];
  /** 未受影响的既有 artifact（按 workflow 声明顺序） */
  unaffected: string[];
}

/**
 * 从真实 Workflow DAG 计算 Artifact Closure（v0.9 §18）。
 *
 * 禁止硬编码 `requirement → design → execution-manual`：
 * 只读取 workflow 声明中的 `requires` 边，做下游可达性计算。
 *
 * @param changedStages  显式 changed 的 stage（proposal 中已 stage replacement）
 * @param existingStages 已有 canonical artifact 的 stage（baseline snapshot 中存在）
 *
 * 说明：不产出 artifact 的过渡阶段（produces 为空）与尚无 artifact 的阶段
 * 不进入 affected / unaffected 分类 —— 它们没有可 resolution 的内容。
 */
export function computeArtifactClosure(options: {
  workflow: Workflow;
  changedStages: readonly string[];
  existingStages: ReadonlySet<string>;
}): ArtifactClosure {
  const { workflow } = options;
  const order = new Map<string, number>();
  workflow.stages.forEach((s, i) => order.set(s.id, i));
  const sortByWorkflow = (a: string, b: string): number =>
    (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER);

  const known = new Set(workflow.stages.map((s) => s.id));
  const changed = new Set(options.changedStages.filter((id) => known.has(id)));

  const produces = new Map<string, string>();
  const requires = new Map<string, readonly string[]>();
  for (const stage of workflow.stages) {
    const artifact = stage.produces[0];
    if (artifact) produces.set(stage.id, artifact);
    requires.set(stage.id, stage.requires);
  }

  // 下游可达性：从 changed 出发，沿 requires 反向边传播（直接 changed 永不降级）
  const affected = new Set<string>();
  let frontier = [...changed];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const stage of workflow.stages) {
      if (changed.has(stage.id) || affected.has(stage.id)) continue;
      if (!stage.requires.some((r) => frontier.includes(r))) continue;
      affected.add(stage.id);
      next.push(stage.id);
    }
    frontier = next;
  }

  const directlyChanged = [...changed].sort(sortByWorkflow);
  const transitivelyAffected = [...affected]
    .filter((id) => produces.has(id) && options.existingStages.has(id))
    .sort(sortByWorkflow);
  const unaffected = workflow.stages
    .map((s) => s.id)
    .filter(
      (id) =>
        produces.has(id) &&
        options.existingStages.has(id) &&
        !changed.has(id) &&
        !affected.has(id),
    )
    .sort(sortByWorkflow);

  return { directlyChanged, transitivelyAffected, unaffected };
}

// ---------------------------------------------------------------------------
// §19–§20 Resolution
// ---------------------------------------------------------------------------

/** Resolution 类型（v0.9 §23） */
export type ResolutionKind = 'replace' | 'retain' | 'baseline';

export interface ArtifactResolutionEntry {
  stage: string;
  artifact: string;
  classification: ImpactClassification;
  resolution: ResolutionKind;
}

export interface ArtifactResolutionResult {
  entries: ArtifactResolutionEntry[];
  /** 既无 replacement 也无 retain 的 affected artifact（v0.9 §20） */
  unresolved: string[];
}

/**
 * 计算每个 artifact 的 Resolution（v0.9 §19–§20）。
 *
 * - directly changed → replace（proposal 版本）
 * - transitively affected → replace（proposal 有）/ retain（显式决策）/ 否则 unresolved
 * - unaffected → baseline
 *
 * 不允许“自动保留”：受影响但没有显式决策的 artifact 必须报告 unresolved。
 */
export function resolveArtifacts(options: {
  closure: ArtifactClosure;
  workflow: Workflow;
  replacedStages: ReadonlySet<string>;
  retainedStages: ReadonlySet<string>;
}): ArtifactResolutionResult {
  const artifactOf = new Map<string, string>();
  for (const stage of options.workflow.stages) {
    const artifact = stage.produces[0];
    if (artifact) artifactOf.set(stage.id, artifact);
  }

  const entries: ArtifactResolutionEntry[] = [];
  const unresolved: string[] = [];

  const all: Array<{ stage: string; classification: ImpactClassification }> = [
    ...options.closure.directlyChanged.map((stage) => ({
      stage,
      classification: 'directly_changed' as const,
    })),
    ...options.closure.transitivelyAffected.map((stage) => ({
      stage,
      classification: 'transitively_affected' as const,
    })),
    ...options.closure.unaffected.filter((stage) => !options.replacedStages.has(stage)).map((stage) => ({
      stage,
      classification: 'unaffected' as const,
    })),
  ];

  for (const item of all) {
    const artifact = artifactOf.get(item.stage) ?? '';
    let resolution: ResolutionKind;

    if (item.classification === 'directly_changed') {
      // directly changed 必须来自 proposal replacement，此处做一致性断言
      if (!options.replacedStages.has(item.stage)) {
        unresolved.push(item.stage);
        continue;
      }
      resolution = 'replace';
    } else if (options.replacedStages.has(item.stage)) {
      resolution = 'replace';
    } else if (item.classification === 'transitively_affected') {
      if (!options.retainedStages.has(item.stage)) {
        unresolved.push(item.stage);
        continue; // 未解决项不写入 resolution 列表
      }
      resolution = 'retain';
    } else {
      resolution = 'baseline';
    }

    entries.push({ stage: item.stage, artifact, classification: item.classification, resolution });
  }

  return { entries, unresolved: [...new Set(unresolved)].sort() };
}

// ---------------------------------------------------------------------------
// §25 Task Graph Diff
// ---------------------------------------------------------------------------

/** Task Definition 的比较字段（v0.9 §25，至少包含这些） */
export const TASK_DIFF_FIELDS = [
  'title',
  'summary',
  'executor',
  'depends_on',
  'scope',
  'verification',
] as const;

export type TaskDiffField = (typeof TASK_DIFF_FIELDS)[number];

export type TaskChangeKind = 'added' | 'removed' | 'modified' | 'unchanged';

export interface TaskDiffEntry {
  id: string;
  change: TaskChangeKind;
  /** modified 时发生变化的具体字段 */
  fields: TaskDiffField[];
}

export interface TaskGraphDiff {
  added: string[];
  removed: string[];
  modified: string[];
  unchanged: string[];
  entries: TaskDiffEntry[];
}

/** 单 Task 的可比较规范形式（depends_on / scope.paths 视为集合；commands 保持顺序） */
function canonicalTaskFields(task: {
  title: string;
  summary: string;
  executor?: string;
  dependsOn: string[];
  scope: { paths: string[] };
  verification: { commands: string[]; timeoutSeconds: number };
}): Record<TaskDiffField, string> {
  return {
    title: task.title,
    summary: task.summary,
    executor: task.executor ?? '',
    depends_on: [...task.dependsOn].sort().join(','),
    scope: [...task.scope.paths].sort().join('|'),
    verification: `${task.verification.timeoutSeconds}\u0000${task.verification.commands.join('\u0001')}`,
  };
}

/**
 * 比较 base Task Graph 与 candidate Task Graph（v0.9 §25）。
 *
 * 只有 Task ID 相同但任一声明字段变化 → modified；不允许只比较 Task ID。
 */
export function diffTaskGraphs(
  base: TaskGraph | null,
  candidate: TaskGraph | null,
): TaskGraphDiff {
  const baseTasks = new Map((base?.tasks ?? []).map((t) => [t.id, t]));
  const candidateTasks = new Map((candidate?.tasks ?? []).map((t) => [t.id, t]));

  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];
  const entries: TaskDiffEntry[] = [];

  // 顺序：base 声明顺序 → 新增按 candidate 声明顺序
  const orderedIds: string[] = [];
  for (const t of base?.tasks ?? []) orderedIds.push(t.id);
  for (const t of candidate?.tasks ?? []) if (!baseTasks.has(t.id)) orderedIds.push(t.id);

  for (const id of orderedIds) {
    const before = baseTasks.get(id);
    const after = candidateTasks.get(id);
    if (before && after) {
      const a = canonicalTaskFields(before);
      const b = canonicalTaskFields(after);
      const fields = TASK_DIFF_FIELDS.filter((f) => a[f] !== b[f]);
      if (fields.length > 0) {
        modified.push(id);
        entries.push({ id, change: 'modified', fields });
      } else {
        unchanged.push(id);
        entries.push({ id, change: 'unchanged', fields: [] });
      }
      continue;
    }
    if (before) {
      removed.push(id);
      entries.push({ id, change: 'removed', fields: [] });
      continue;
    }
    added.push(id);
    entries.push({ id, change: 'added', fields: [] });
  }

  return { added, removed, modified, unchanged, entries };
}

// ---------------------------------------------------------------------------
// §26 Task Dependency Impact
// ---------------------------------------------------------------------------

/** 从 Task Graph 计算 seeds 的 transitive dependents（不含 seeds 自身） */
export function transitiveDependents(graph: TaskGraph, seeds: readonly string[]): string[] {
  const dependentsOf = new Map<string, string[]>();
  for (const task of graph.tasks) {
    for (const dep of task.dependsOn) {
      const list = dependentsOf.get(dep);
      if (list) list.push(task.id);
      else dependentsOf.set(dep, [task.id]);
    }
  }

  const seen = new Set<string>();
  let frontier = [...new Set(seeds)].filter((id) => graph.tasks.some((t) => t.id === id));
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const dependent of dependentsOf.get(id) ?? []) {
        if (seen.has(dependent)) continue;
        seen.add(dependent);
        next.push(dependent);
      }
    }
    frontier = next;
  }
  // seeds 本身不算 dependent（即使循环依赖被 DAG 校验禁止）
  for (const seed of seeds) seen.delete(seed);
  return [...seen].sort();
}

/** seeds ∪ transitive dependents（Impact Report 的 impacted 集合） */
export function impactedTasks(graph: TaskGraph, seeds: readonly string[]): string[] {
  const dependents = transitiveDependents(graph, seeds);
  return [...new Set([...seeds.filter((id) => graph.tasks.some((t) => t.id === id)), ...dependents])].sort();
}

// ---------------------------------------------------------------------------
// §27–§28 Candidate Plan Diff
// ---------------------------------------------------------------------------

export type AssignmentChangeKind = 'added' | 'removed' | 'modified' | 'unchanged';

export interface ExecutorAssignmentDiff {
  task_id: string;
  change: AssignmentChangeKind;
  base_executor: string | null;
  candidate_executor: string | null;
  base_adapter: string | null;
  candidate_adapter: string | null;
}

/** 比较 base 与 candidate Executor Plan 的 Task → Executor / Adapter 分配 */
export function diffExecutorPlans(
  base: ExecutorPlan | null,
  candidate: ExecutorPlan | null,
): ExecutorAssignmentDiff[] {
  const baseByTask = new Map((base?.assignments ?? []).map((a) => [a.taskId, a]));
  const candidateByTask = new Map((candidate?.assignments ?? []).map((a) => [a.taskId, a]));

  const orderedIds: string[] = [];
  for (const a of base?.assignments ?? []) orderedIds.push(a.taskId);
  for (const a of candidate?.assignments ?? []) if (!baseByTask.has(a.taskId)) orderedIds.push(a.taskId);

  return orderedIds.map((taskId) => {
    const before = baseByTask.get(taskId);
    const after = candidateByTask.get(taskId);
    let change: AssignmentChangeKind;
    if (before && after) {
      change =
        before.executor === after.executor && before.adapter === after.adapter
          ? 'unchanged'
          : 'modified';
    } else if (before) {
      change = 'removed';
    } else {
      change = 'added';
    }
    return {
      task_id: taskId,
      change,
      base_executor: before?.executor ?? null,
      candidate_executor: after?.executor ?? null,
      base_adapter: before?.adapter ?? null,
      candidate_adapter: after?.adapter ?? null,
    };
  });
}

export interface ReviewGateDiff {
  id: string;
  change: AssignmentChangeKind;
  base_kind: string | null;
  candidate_kind: string | null;
  base_reviewer: string | null;
  candidate_reviewer: string | null;
  base_adapter: string | null;
  candidate_adapter: string | null;
}

export interface ReviewPlanDiff {
  base_enabled: boolean | null;
  candidate_enabled: boolean | null;
  changed: boolean;
  gates: ReviewGateDiff[];
}

/** 比较 base 与 candidate Review Plan（复用 v0.8 Compiler 的 gate 结构，不发明 Change Reviewer） */
export function diffReviewPlans(
  base: ReviewPlan | null,
  candidate: ReviewPlan | null,
): ReviewPlanDiff {
  const baseEnabled = base ? base.enabled : null;
  const candidateEnabled = candidate ? candidate.enabled : null;

  const baseById = new Map((base?.gates ?? []).map((g) => [g.id, g]));
  const candidateById = new Map((candidate?.gates ?? []).map((g) => [g.id, g]));

  const orderedIds: string[] = [];
  for (const g of base?.gates ?? []) orderedIds.push(g.id);
  for (const g of candidate?.gates ?? []) if (!baseById.has(g.id)) orderedIds.push(g.id);

  const gates: ReviewGateDiff[] = orderedIds.map((id) => {
    const before = baseById.get(id);
    const after = candidateById.get(id);
    let change: AssignmentChangeKind;
    if (before && after) {
      change =
        before.kind === after.kind &&
        before.reviewer === after.reviewer &&
        before.adapter === after.adapter
          ? 'unchanged'
          : 'modified';
    } else if (before) {
      change = 'removed';
    } else {
      change = 'added';
    }
    return {
      id,
      change,
      base_kind: before?.kind ?? null,
      candidate_kind: after?.kind ?? null,
      base_reviewer: before?.reviewer ?? null,
      candidate_reviewer: after?.reviewer ?? null,
      base_adapter: before?.adapter ?? null,
      candidate_adapter: after?.adapter ?? null,
    };
  });

  const changed =
    baseEnabled !== candidateEnabled || gates.some((g) => g.change !== 'unchanged');
  return { base_enabled: baseEnabled, candidate_enabled: candidateEnabled, changed, gates };
}

// ---------------------------------------------------------------------------
// §30 Frozen Evidence Invalidated
// ---------------------------------------------------------------------------

/**
 * §30 措辞约束：旧 Evidence 是历史事实，不能被写成 invalid / corrupt / wrong，
 * 只能是 superseded for future work。
 */
export const FROZEN_EVIDENCE_SUPERSEDED = 'historically valid; future execution invalidated';
export const FROZEN_EVIDENCE_STILL_VALID = 'still valid for future execution';

export interface FrozenEvidenceInvalidation {
  name: 'task_graph' | 'executor_plan' | 'review_plan';
  base_digest: string | null;
  candidate_digest: string | null;
  changed: boolean;
  state: string;
}

// ---------------------------------------------------------------------------
// §29 Impact Report
// ---------------------------------------------------------------------------

export interface ImpactReport {
  change_id: string;
  attempt: string;
  analysis_result: 'complete' | 'incomplete';
  base_run: string;
  base_git_head: string | null;
  base_workflow: { name: string; version: string; digest: string | null };
  changed_artifacts: string[];
  affected_artifacts: string[];
  unaffected_artifacts: string[];
  resolutions: ArtifactResolutionEntry[];
  unresolved: string[];
  task_graph: {
    /** base Run 是否具备 Task Graph（legacy base 不适用，v0.9 §62） */
    applicable: boolean;
    changed: boolean;
    base_digest: string | null;
    candidate_digest: string | null;
    diff: TaskGraphDiff;
    old_graph_impacted: string[];
    new_graph_impacted: string[];
  };
  executor_plan: {
    changed: boolean;
    base_digest: string | null;
    candidate_digest: string | null;
    assignments: ExecutorAssignmentDiff[];
  };
  review_plan: ReviewPlanDiff & {
    base_digest: string | null;
    candidate_digest: string | null;
  };
  frozen_evidence_invalidated: FrozenEvidenceInvalidation[];
  required_successor_run: boolean;
  no_effect: boolean;
}

/** 序列化 impact.yaml（机器 Evidence，v0.9 §29） */
export function stringifyImpactYaml(report: ImpactReport): string {
  return yaml.dump(report, { indent: 2, lineWidth: -1, noRefs: true });
}

/** 渲染 impact.md（人类可读 Evidence，v0.9 §29 要求的全部小节） */
export function renderImpactMarkdown(report: ImpactReport): string {
  const lines: string[] = [];
  const list = (items: readonly string[], empty = '（无）'): void => {
    if (items.length === 0) {
      lines.push(`  ${empty}`);
      return;
    }
    for (const item of items) lines.push(`- ${item}`);
  };

  lines.push(`# Change Impact Report — ${report.change_id}`);
  lines.push('');
  lines.push(`- Analysis Attempt: ${report.attempt}`);
  lines.push(`- Result: ${report.analysis_result}`);
  lines.push(`- No-Effect Change: ${report.no_effect ? 'yes' : 'no'}`);
  lines.push('');

  lines.push('## Base Run');
  lines.push('');
  lines.push(report.base_run);
  lines.push('');

  lines.push('## Base Git HEAD');
  lines.push('');
  lines.push(report.base_git_head ?? 'null');
  lines.push('');

  lines.push('## Changed Artifacts');
  lines.push('');
  list(report.changed_artifacts);
  lines.push('');

  lines.push('## Affected Artifacts');
  lines.push('');
  list(report.affected_artifacts);
  lines.push('');

  lines.push('## Resolution');
  lines.push('');
  if (report.resolutions.length === 0) {
    lines.push('  （无）');
  } else {
    lines.push('| stage | artifact | classification | resolution |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of report.resolutions) {
      lines.push(`| ${r.stage} | ${r.artifact} | ${r.classification} | ${r.resolution} |`);
    }
  }
  lines.push('');

  lines.push('## Task Graph Diff');
  lines.push('');
  if (!report.task_graph.applicable) {
    lines.push('  base Run 无 Task Graph（legacy base），不适用。');
  } else {
    const diff = report.task_graph.diff;
    lines.push(`- changed: ${report.task_graph.changed ? 'yes' : 'no'}`);
    lines.push(`- base digest: ${report.task_graph.base_digest ?? 'null'}`);
    lines.push(`- candidate digest: ${report.task_graph.candidate_digest ?? 'null'}`);
    lines.push(`- added: ${formatList(diff.added)}`);
    lines.push(`- removed: ${formatList(diff.removed)}`);
    lines.push(`- modified: ${formatList(diff.modified)}`);
    lines.push(`- unchanged: ${formatList(diff.unchanged)}`);
    for (const entry of diff.entries) {
      if (entry.change === 'modified') {
        lines.push(`  - ${entry.id}: modified（${entry.fields.join(', ')}）`);
      }
    }
  }
  lines.push('');

  lines.push('## Affected Old Tasks');
  lines.push('');
  list(report.task_graph.old_graph_impacted);
  lines.push('');

  lines.push('## Affected New Tasks');
  lines.push('');
  list(report.task_graph.new_graph_impacted);
  lines.push('');

  lines.push('## Executor Assignment Diff');
  lines.push('');
  if (report.executor_plan.assignments.length === 0) {
    lines.push('  （无）');
  } else {
    lines.push('| task | change | base executor | candidate executor | base adapter | candidate adapter |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const a of report.executor_plan.assignments) {
      lines.push(
        `| ${a.task_id} | ${a.change} | ${a.base_executor ?? 'null'} | ` +
          `${a.candidate_executor ?? 'null'} | ${a.base_adapter ?? 'null'} | ${a.candidate_adapter ?? 'null'} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Review Plan Diff');
  lines.push('');
  lines.push(`- base enabled: ${String(report.review_plan.base_enabled)}`);
  lines.push(`- candidate enabled: ${String(report.review_plan.candidate_enabled)}`);
  lines.push(`- changed: ${report.review_plan.changed ? 'yes' : 'no'}`);
  if (report.review_plan.gates.length === 0) {
    lines.push('  （无 gate）');
  } else {
    for (const g of report.review_plan.gates) {
      lines.push(`- ${g.id}: ${g.change}`);
    }
  }
  lines.push('');

  lines.push('## Frozen Evidence Invalidated');
  lines.push('');
  for (const item of report.frozen_evidence_invalidated) {
    lines.push(`- ${item.name}: ${item.state}`);
  }
  lines.push('');

  lines.push('## Required Successor Run');
  lines.push('');
  lines.push(report.required_successor_run ? 'yes' : 'no');
  lines.push('');

  lines.push('## Unresolved Items');
  lines.push('');
  list(report.unresolved);
  lines.push('');

  return lines.join('\n');
}

function formatList(items: readonly string[]): string {
  return items.length === 0 ? '（无）' : items.join(', ');
}

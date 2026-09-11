/**
 * Change Impact Analysis Attempt（SpecCraft v0.9 §21–§25、§29–§31，ADR 0010）。
 *
 * 每次 `changes analyze` 创建一个新的 Analysis Attempt（永不覆盖）：
 *
 *   analysis/attempt-NNN/
 *     ├── analysis.yaml           Attempt 元数据 + digests（Commit 4 approval 绑定用）
 *     ├── impact.yaml / impact.md Impact Report（§29）
 *     ├── resolved/               complete Attempt 才有：Successor Run 应看到的世界（§23）
 *     │   ├── artifacts/<stage>.md
 *     │   └── project.yaml
 *     └── candidate/              §24–§28
 *         ├── task-graph.yaml
 *         ├── executor-plan.yaml
 *         └── review-plan.yaml
 *
 * 关键规则：
 *   - Replan 只允许读取 approved Attempt 的 resolved snapshot，禁止再读 mutable proposal（§23）。
 *   - 不创建 Run（§24）；不自动保留（§20）。
 */

import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Workflow } from '../types.js';
import type { TaskGraph } from '../tasks/types.js';
import type { ProjectConfig } from '../project.js';
import { loadProjectConfig, parseProjectConfig } from '../project.js';
import { readRun } from '../execution/store.js';
import { readTaskGraphOrNull } from '../tasks/store.js';
import { readExecutorPlanOrNull, stringifyExecutorPlan } from '../executors/store.js';
import { readReviewPlanOrNull, stringifyReviewPlan } from '../reviews/store.js';
import { buildExecutorsContext } from '../executors/resolver.js';
import { buildExecutorPlan } from '../executors/plan.js';
import { buildFrozenReviewPlan } from '../reviews/plan.js';
import { validateReviewConfig } from '../reviews/config.js';
import { listAdapterIds } from '../execution/adapters/registry.js';
import { compileTaskGraphFromManual } from '../tasks/compiler.js';
import { stringifyTaskGraph } from '../tasks/store.js';
import { ANALYSIS_DIR, changeDir, listAnalysisAttempts, readChangeManifest } from './store.js';
import { ChangeError } from './types.js';
import type { ChangeSetManifest } from './types.js';
import {
  PROPOSAL_CONFIG_FILE,
  listStagedStages,
  proposalArtifactPath,
  proposalBundleDigest,
  proposalConfigPath,
  readRetainedStages,
  hasStagedConfig,
} from './proposal.js';
import {
  bundleDigest,
  executorPlanDigest,
  reviewPlanDigest,
  sha256Bytes,
  sha256File,
  taskGraphDigest,
} from './digest.js';
import type { BundleEntry } from './digest.js';
import {
  FROZEN_EVIDENCE_STILL_VALID,
  FROZEN_EVIDENCE_SUPERSEDED,
  computeArtifactClosure,
  diffExecutorPlans,
  diffReviewPlans,
  diffTaskGraphs,
  impactedTasks,
  renderImpactMarkdown,
  resolveArtifacts,
  stringifyImpactYaml,
} from './impact.js';
import type {
  ArtifactResolutionEntry,
  FrozenEvidenceInvalidation,
  ImpactReport,
  ReviewPlanDiff,
} from './impact.js';

/** analysis 目录下的 Attempt 目录名 */
export const ATTEMPT_PREFIX = 'attempt-';
/** Attempt 元数据文件名 */
export const ANALYSIS_ATTEMPT_FILE = 'analysis.yaml';
/** 机器 Impact Report 文件名 */
export const IMPACT_YAML_FILE = 'impact.yaml';
/** 人类可读 Impact Report 文件名 */
export const IMPACT_MD_FILE = 'impact.md';
/** Resolved Snapshot 目录名 */
export const RESOLVED_DIR = 'resolved';
/** Candidate Plan 目录名 */
export const CANDIDATE_DIR = 'candidate';
/** baseline 快照中的 project.yaml 相对路径 */
const BASELINE_PROJECT_FILE = 'baseline/project.yaml';

export function analysisDir(speccraftDir: string, changeId: string): string {
  return path.join(changeDir(speccraftDir, changeId), ANALYSIS_DIR);
}

export function analysisAttemptDir(
  speccraftDir: string,
  changeId: string,
  attempt: string,
): string {
  return path.join(analysisDir(speccraftDir, changeId), attempt);
}

/** 单个 resolved artifact 的记录（§23） */
export interface ResolvedArtifactRecord extends ArtifactResolutionEntry {
  /** 相对 Attempt 目录的路径，如 resolved/artifacts/requirement.md */
  path: string;
  sha256: string;
}

export interface ResolvedProjectRecord {
  path: string;
  sha256: string;
  /** 是否来自 proposal（project config change，§16） */
  staged: boolean;
}

/** analysis.yaml 的结构（Attempt 元数据，Commit 4 approval 绑定用） */
export interface AnalysisAttempt {
  version: 1;
  change_id: string;
  attempt: string;
  result: 'complete' | 'incomplete';
  created_at: string;
  base_run: string;
  base_git_head: string | null;
  proposal_digest: string | null;
  staged_stages: string[];
  retained_stages: string[];
  unresolved: string[];
  no_effect: boolean;
  required_successor_run: boolean;
  /** complete 时存在 */
  resolved: ResolvedArtifactRecord[];
  project: ResolvedProjectRecord | null;
  candidate: {
    task_graph: string | null;
    task_graph_digest: string | null;
    executor_plan: string | null;
    executor_plan_digest: string | null;
    review_plan: string | null;
    review_plan_digest: string | null;
  };
  base: {
    task_graph_digest: string | null;
    executor_plan_digest: string | null;
    review_plan_digest: string | null;
  };
  impact_sha256: string | null;
  /** Attempt 快照内容 digest（resolved/ + candidate/）；Commit 4 approval 绑定 */
  analysis_bundle_sha256: string | null;
}

export interface AnalyzeChangeOptions {
  speccraftDir: string;
  changeId: string;
  workflow: Workflow;
  now?: Date;
}

export interface AnalyzeChangeResult {
  changeId: string;
  attempt: string;
  result: 'complete' | 'incomplete';
  unresolved: string[];
  noEffect: boolean;
  impact: ImpactReport;
  attemptDir: string;
}

/** 只有 draft / analyzed 允许重新分析（§21、§34） */
function assertAnalysisAllowed(manifest: ChangeSetManifest): void {
  if (manifest.status === 'draft' || manifest.status === 'analyzed') return;
  if (manifest.status === 'rejected') {
    throw new ChangeError('change_rejected', `Change ${manifest.id} 已 rejected，不可分析。`);
  }
  throw new ChangeError(
    'change_already_approved',
    `Change ${manifest.id} 已处于 ${manifest.status}，不可重新分析。`,
  );
}

interface PlannedFile {
  /** 相对 Attempt 目录的路径（`/` 分隔） */
  path: string;
  bytes: Buffer;
}

/**
 * 执行一次 Impact Analysis，落盘一个不可变的 Analysis Attempt。
 */
export async function analyzeChange(options: AnalyzeChangeOptions): Promise<AnalyzeChangeResult> {
  const { speccraftDir, changeId } = options;
  const manifest = await readChangeManifest(speccraftDir, changeId);
  assertAnalysisAllowed(manifest);

  const baseRun = await readRun(speccraftDir, manifest.baseRunId);
  const now = options.now ?? new Date();
  const createdAt = now.toISOString();

  // ---------------------------------------------------------------- proposal
  const stagedStages = await listStagedStages(speccraftDir, changeId);
  const retainedStages = await readRetainedStages(speccraftDir, changeId);
  const configStaged = await hasStagedConfig(speccraftDir, changeId);
  const proposalDigest = await proposalBundleDigest(speccraftDir, changeId);

  // ------------------------------------------------------------- §18 closure
  const existingStages = new Set(manifest.artifacts.map((a) => a.stage));
  const closure = computeArtifactClosure({
    workflow: options.workflow,
    changedStages: stagedStages,
    existingStages,
  });

  // --------------------------------------------------------- §19–§20 resolve
  const replacedStages = new Set(stagedStages);
  const resolution = resolveArtifacts({
    closure,
    workflow: options.workflow,
    replacedStages,
    retainedStages: new Set(retainedStages),
  });
  const complete = resolution.unresolved.length === 0;

  // ------------------------------------------------- base frozen plans / graph
  const baseGraph = await readTaskGraphOrNull(speccraftDir, manifest.baseRunId);
  const baseExecutorPlan = await readExecutorPlanOrNull(speccraftDir, manifest.baseRunId);
  const baseReviewPlan = await readReviewPlanOrNull(speccraftDir, manifest.baseRunId);

  // ---------------------------------------------------- §23 resolved snapshot
  const resolvedFiles: PlannedFile[] = [];
  const resolvedRecords: ResolvedArtifactRecord[] = [];
  let projectRecord: ResolvedProjectRecord | null = null;
  let resolvedProjectBytes: Buffer | null = null;
  let baselineProjectBytes: Buffer | null = null;
  let resolvedManualBytes: Buffer | null = null;

  if (complete) {
    for (const entry of resolution.entries) {
      const bytes = await readResolvedArtifactBytes({
        speccraftDir,
        changeId,
        manifest,
        stage: entry.stage,
        resolution: entry.resolution,
      });
      if (bytes === null) continue; // 该 stage 尚无 artifact（既不 replace 也无 baseline）
      const rel = `${RESOLVED_DIR}/artifacts/${entry.stage}.md`;
      resolvedFiles.push({ path: rel, bytes });
      resolvedRecords.push({
        ...entry,
        path: rel,
        sha256: sha256Bytes(bytes),
      });
      if (entry.stage === 'execution-manual') resolvedManualBytes = bytes;
    }

    // project config：staged → proposal 版本；否则 → baseline 版本
    const baselineProject = await readFileOrNull(path.join(changeDir(speccraftDir, changeId), BASELINE_PROJECT_FILE));
    baselineProjectBytes = baselineProject;
    resolvedProjectBytes = configStaged
      ? await readFile(proposalConfigPath(speccraftDir, changeId))
      : baselineProject;
    if (resolvedProjectBytes !== null) {
      const rel = `${RESOLVED_DIR}/${PROPOSAL_CONFIG_FILE}`;
      resolvedFiles.push({ path: rel, bytes: resolvedProjectBytes });
      projectRecord = {
        path: rel,
        sha256: sha256Bytes(resolvedProjectBytes),
        staged: configStaged,
      };
    }
  }

  // ------------------------------------------- §24–§28 candidate plans
  const baseManualRel = baselineArtifactPath(manifest, 'execution-manual');
  const baseManualBytes = baseManualRel
    ? await readFileOrNull(path.join(changeDir(speccraftDir, changeId), baseManualRel))
    : null;
  const manualChanged =
    resolvedManualBytes !== null && !buffersEqual(resolvedManualBytes, baseManualBytes);

  let candidateGraph: TaskGraph | null = null;
  if (manualChanged) {
    // §24：从 resolved snapshot 的 Execution Manual 编译 Candidate Task Graph（不创建 Run）
    candidateGraph = compileTaskGraphFromManual({
      manualBody: resolvedManualBytes!.toString('utf8'),
      runId: baseGraph?.runId ?? manifest.baseRunId,
      source: 'execution-manual',
    });
  }
  const effectiveGraph = candidateGraph ?? baseGraph;

  let projectConfig: ProjectConfig | null = null;
  if (effectiveGraph) {
    projectConfig = configStaged
      ? parseProjectConfig(resolvedProjectBytes!.toString('utf8'))
      : await loadProjectConfig(speccraftDir);
  }

  let candidateExecutorPlan = null;
  let candidateReviewPlan = null;
  if (effectiveGraph && projectConfig) {
    const ctx = buildExecutorsContext(projectConfig);
    const adapters = projectConfig.execution?.adapters ?? {};
    candidateExecutorPlan = buildExecutorPlan(ctx, adapters, effectiveGraph, now);

    const reviewConfig = projectConfig.review ?? null;
    if (reviewConfig?.enabled) {
      const knownAdapters = new Set(listAdapterIds());
      validateReviewConfig(reviewConfig, knownAdapters);
    }
    candidateReviewPlan = buildFrozenReviewPlan({
      runId: effectiveGraph.runId,
      reviewConfig,
      projectAdapters: adapters,
      knownAdapters: new Set(listAdapterIds()),
    });
  }

  // --------------------------------------------------------------- digests
  const baseTaskGraphDigest = baseGraph ? taskGraphDigest(baseGraph) : null;
  const candidateTaskGraphDigest = effectiveGraph ? taskGraphDigest(effectiveGraph) : null;
  const baseExecutorPlanDigest = baseExecutorPlan ? executorPlanDigest(baseExecutorPlan) : null;
  const candidateExecutorPlanDigest = candidateExecutorPlan
    ? executorPlanDigest(candidateExecutorPlan)
    : null;
  const baseReviewPlanDigest = baseReviewPlan ? reviewPlanDigest(baseReviewPlan) : null;
  const candidateReviewPlanDigest = candidateReviewPlan ? reviewPlanDigest(candidateReviewPlan) : null;

  const taskGraphChanged = candidateTaskGraphDigest !== baseTaskGraphDigest;
  const executorPlanChanged = candidateExecutorPlanDigest !== baseExecutorPlanDigest;
  const reviewPlanChanged = candidateReviewPlanDigest !== baseReviewPlanDigest;

  // ------------------------------------------- §31 no-effect / bundle compare
  const resolvedEntries: BundleEntry[] = resolvedFiles
    .filter((f) => !f.path.endsWith(`/${PROPOSAL_CONFIG_FILE}`))
    .map((f) => ({ path: f.path.slice(`${RESOLVED_DIR}/`.length), sha256: sha256Bytes(f.bytes) }));
  if (resolvedProjectBytes !== null) {
    resolvedEntries.push({ path: PROPOSAL_CONFIG_FILE, sha256: sha256Bytes(resolvedProjectBytes) });
  }
  const baselineEntries: BundleEntry[] = manifest.artifacts.map((a) => ({
    path: `artifacts/${a.stage}.md`,
    sha256: a.sha256,
  }));
  if (manifest.projectDigest) {
    baselineEntries.push({ path: PROPOSAL_CONFIG_FILE, sha256: manifest.projectDigest });
  }
  const artifactBundleChanged =
    bundleDigest(baselineEntries) !== bundleDigest(resolvedEntries);
  const projectConfigChanged = !buffersEqual(resolvedProjectBytes, baselineProjectBytes);

  const noEffect =
    complete &&
    !artifactBundleChanged &&
    !projectConfigChanged &&
    !taskGraphChanged &&
    !executorPlanChanged &&
    !reviewPlanChanged;

  // ------------------------------------------------------------- §29 report
  const taskDiff = diffTaskGraphs(baseGraph, effectiveGraph);
  const oldGraphImpacted = baseGraph ? impactedTasks(baseGraph, [...taskDiff.removed, ...taskDiff.modified]) : [];
  const newGraphImpacted = effectiveGraph
    ? impactedTasks(effectiveGraph, [...taskDiff.added, ...taskDiff.modified])
    : [];

  const reviewPlanDiff: ReviewPlanDiff = diffReviewPlans(baseReviewPlan, candidateReviewPlan);
  const frozenEvidence: FrozenEvidenceInvalidation[] = [
    frozenEntry('task_graph', baseTaskGraphDigest, candidateTaskGraphDigest, taskGraphChanged),
    frozenEntry('executor_plan', baseExecutorPlanDigest, candidateExecutorPlanDigest, executorPlanChanged),
    frozenEntry('review_plan', baseReviewPlanDigest, candidateReviewPlanDigest, reviewPlanChanged),
  ];

  const impact: ImpactReport = {
    change_id: changeId,
    attempt: '', // 分配 Attempt 编号后回填
    analysis_result: complete ? 'complete' : 'incomplete',
    base_run: manifest.baseRunId,
    base_git_head: baseRun.baseGit?.commit ?? manifest.gitHead,
    base_workflow: manifest.workflow,
    changed_artifacts: closure.directlyChanged,
    affected_artifacts: closure.transitivelyAffected,
    unaffected_artifacts: closure.unaffected,
    resolutions: resolution.entries,
    unresolved: resolution.unresolved,
    task_graph: {
      applicable: baseGraph !== null,
      changed: taskGraphChanged,
      base_digest: baseTaskGraphDigest,
      candidate_digest: candidateTaskGraphDigest,
      diff: taskDiff,
      old_graph_impacted: oldGraphImpacted,
      new_graph_impacted: newGraphImpacted,
    },
    executor_plan: {
      changed: executorPlanChanged,
      base_digest: baseExecutorPlanDigest,
      candidate_digest: candidateExecutorPlanDigest,
      assignments: diffExecutorPlans(baseExecutorPlan, candidateExecutorPlan),
    },
    review_plan: {
      ...reviewPlanDiff,
      base_digest: baseReviewPlanDigest,
      candidate_digest: candidateReviewPlanDigest,
    },
    frozen_evidence_invalidated: frozenEvidence,
    required_successor_run: complete && !noEffect,
    no_effect: noEffect,
  };

  const candidateFiles: PlannedFile[] = [];
  if (effectiveGraph && candidateGraph) {
    candidateFiles.push({
      path: `${CANDIDATE_DIR}/task-graph.yaml`,
      bytes: Buffer.from(stringifyTaskGraph(candidateGraph), 'utf8'),
    });
  }
  if (candidateExecutorPlan) {
    candidateFiles.push({
      path: `${CANDIDATE_DIR}/executor-plan.yaml`,
      bytes: Buffer.from(stringifyExecutorPlan(candidateExecutorPlan), 'utf8'),
    });
  }
  if (candidateReviewPlan) {
    candidateFiles.push({
      path: `${CANDIDATE_DIR}/review-plan.yaml`,
      bytes: Buffer.from(stringifyReviewPlan(candidateReviewPlan), 'utf8'),
    });
  }

  // ------------------------------------------------- write immutable attempt
  const { attempt, dir } = await claimAttemptDir(speccraftDir, changeId);
  try {
    impact.attempt = attempt;

    for (const file of [...resolvedFiles, ...candidateFiles]) {
      const target = path.join(dir, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.bytes);
    }

    const impactYamlPath = path.join(dir, IMPACT_YAML_FILE);
    await writeFile(impactYamlPath, stringifyImpactYaml(impact), 'utf8');
    await writeFile(path.join(dir, IMPACT_MD_FILE), renderImpactMarkdown(impact), 'utf8');

    const bundleDigestValue = await analysisBundleDigest(dir);
    const impactSha = await sha256File(impactYamlPath);

    const record: AnalysisAttempt = {
      version: 1,
      change_id: changeId,
      attempt,
      result: complete ? 'complete' : 'incomplete',
      created_at: createdAt,
      base_run: manifest.baseRunId,
      base_git_head: impact.base_git_head,
      proposal_digest: proposalDigest,
      staged_stages: stagedStages,
      retained_stages: retainedStages,
      unresolved: resolution.unresolved,
      no_effect: noEffect,
      required_successor_run: complete && !noEffect,
      resolved: resolvedRecords,
      project: projectRecord,
      candidate: {
        task_graph: candidateGraph ? `${CANDIDATE_DIR}/task-graph.yaml` : null,
        task_graph_digest: candidateGraph ? candidateTaskGraphDigest : null,
        executor_plan: candidateExecutorPlan ? `${CANDIDATE_DIR}/executor-plan.yaml` : null,
        executor_plan_digest: candidateExecutorPlan ? candidateExecutorPlanDigest : null,
        review_plan: candidateReviewPlan ? `${CANDIDATE_DIR}/review-plan.yaml` : null,
        review_plan_digest: candidateReviewPlan ? candidateReviewPlanDigest : null,
      },
      base: {
        task_graph_digest: baseTaskGraphDigest,
        executor_plan_digest: baseExecutorPlanDigest,
        review_plan_digest: baseReviewPlanDigest,
      },
      impact_sha256: impactSha,
      analysis_bundle_sha256: bundleDigestValue,
    };
    await writeFile(
      path.join(dir, ANALYSIS_ATTEMPT_FILE),
      yaml.dump(record, { indent: 2, lineWidth: -1, noRefs: true }),
      'utf8',
    );
  } catch (err) {
    // 不留半成品 Attempt（§21）
    await rm(dir, { recursive: true, force: true });
    throw err;
  }

  // draft → analyzed（complete 时）；incomplete 保持 draft 以便继续 resolution
  if (complete && manifest.status === 'draft') {
    const { updateChangeStatus } = await import('./store.js');
    await updateChangeStatus(speccraftDir, manifest, 'analyzed');
  }

  return {
    changeId,
    attempt,
    result: complete ? 'complete' : 'incomplete',
    unresolved: resolution.unresolved,
    noEffect,
    impact,
    attemptDir: dir,
  };
}

// ---------------------------------------------------------------------------
// Attempt 读取（Commit 4 approval / replan 使用）
// ---------------------------------------------------------------------------

/** 解析 analysis.yaml */
export function parseAnalysisAttempt(source: string): AnalysisAttempt {
  const loaded = yaml.load(source);
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error('analysis.yaml 顶层必须是对象');
  }
  const obj = loaded as Record<string, unknown>;
  const attempt = typeof obj.attempt === 'string' ? obj.attempt : '';
  if (!attempt) throw new Error('analysis.yaml 缺少 attempt');
  const result = obj.result === 'complete' ? 'complete' : obj.result === 'incomplete' ? 'incomplete' : null;
  if (!result) throw new Error(`analysis attempt ${attempt} 的 result 非法：${String(obj.result)}`);
  return {
    version: 1,
    change_id: typeof obj.change_id === 'string' ? obj.change_id : '',
    attempt,
    result,
    created_at: typeof obj.created_at === 'string' ? obj.created_at : '',
    base_run: typeof obj.base_run === 'string' ? obj.base_run : '',
    base_git_head: typeof obj.base_git_head === 'string' ? obj.base_git_head : null,
    proposal_digest: typeof obj.proposal_digest === 'string' ? obj.proposal_digest : null,
    staged_stages: toStringArray(obj.staged_stages),
    retained_stages: toStringArray(obj.retained_stages),
    unresolved: toStringArray(obj.unresolved),
    no_effect: obj.no_effect === true,
    required_successor_run: obj.required_successor_run === true,
    resolved: parseResolvedRecords(obj.resolved),
    project: parseProjectRecord(obj.project),
    candidate: parseCandidateSection(obj.candidate),
    base: parseBaseSection(obj.base),
    impact_sha256: typeof obj.impact_sha256 === 'string' ? obj.impact_sha256 : null,
    analysis_bundle_sha256:
      typeof obj.analysis_bundle_sha256 === 'string' ? obj.analysis_bundle_sha256 : null,
  };
}

/** 读取 analysis.yaml；不存在时返回 null */
export async function readAnalysisAttemptOrNull(
  speccraftDir: string,
  changeId: string,
  attempt: string,
): Promise<AnalysisAttempt | null> {
  const file = path.join(analysisAttemptDir(speccraftDir, changeId, attempt), ANALYSIS_ATTEMPT_FILE);
  if (!(await pathExists(file))) return null;
  return parseAnalysisAttempt(await readFile(file, 'utf8'));
}

/**
 * Attempt 快照内容 digest（v0.9 §32）：resolved/ + candidate/ 的 bundle digest。
 *
 * 不含 analysis.yaml / impact.yaml —— 它们由 approval.yaml 单独绑定各自的 sha256，
 * 避免自引用。
 */
export async function analysisBundleDigest(attemptDir: string): Promise<string | null> {
  const entries: BundleEntry[] = [];
  for (const sub of [RESOLVED_DIR, CANDIDATE_DIR]) {
    const root = path.join(attemptDir, sub);
    for (const rel of await listFilesRecursive(root, `${sub}/`)) {
      const bytes = await readFile(path.join(attemptDir, rel));
      entries.push({ path: rel, sha256: sha256Bytes(bytes) });
    }
  }
  if (entries.length === 0) return null;
  return bundleDigest(entries);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** 按 Resolution 规则读取 resolved 内容（§23） */
async function readResolvedArtifactBytes(input: {
  speccraftDir: string;
  changeId: string;
  manifest: ChangeSetManifest;
  stage: string;
  resolution: 'replace' | 'retain' | 'baseline';
}): Promise<Buffer | null> {
  if (input.resolution === 'replace') {
    return readFileOrNull(
      proposalArtifactPath(input.speccraftDir, input.changeId, input.stage),
    );
  }
  const rel = baselineArtifactPath(input.manifest, input.stage);
  return rel ? readFileOrNull(path.join(changeDir(input.speccraftDir, input.changeId), rel)) : null;
}

function baselineArtifactPath(manifest: ChangeSetManifest, stage: string): string | null {
  return manifest.artifacts.find((a) => a.stage === stage)?.path ?? null;
}

function frozenEntry(
  name: FrozenEvidenceInvalidation['name'],
  baseDigest: string | null,
  candidateDigest: string | null,
  changed: boolean,
): FrozenEvidenceInvalidation {
  return {
    name,
    base_digest: baseDigest,
    candidate_digest: candidateDigest,
    changed,
    state: changed ? FROZEN_EVIDENCE_SUPERSEDED : FROZEN_EVIDENCE_STILL_VALID,
  };
}

async function claimAttemptDir(
  speccraftDir: string,
  changeId: string,
): Promise<{ attempt: string; dir: string }> {
  const root = analysisDir(speccraftDir, changeId);
  await mkdir(root, { recursive: true });
  let n = (await listAnalysisAttempts(speccraftDir, changeId)).length + 1;
  for (let i = 0; i < 1000; i++) {
    const attempt = `${ATTEMPT_PREFIX}${String(n).padStart(3, '0')}`;
    const dir = path.join(root, attempt);
    try {
      await mkdir(dir);
      return { attempt, dir };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      n += 1;
    }
  }
  throw new Error('无法分配 Analysis Attempt 编号：连续 1000 个编号均已被占用');
}

async function listFilesRecursive(dir: string, prefix: string): Promise<string[]> {
  if (!(await pathExists(dir))) return [];
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(path.join(dir, entry.name), `${prefix}${entry.name}/`)));
    } else if (entry.isFile()) {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out.sort();
}

async function readFileOrNull(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.equals(b);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function parseResolvedRecords(value: unknown): ResolvedArtifactRecord[] {
  if (!Array.isArray(value)) return [];
  const out: ResolvedArtifactRecord[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const obj = raw as Record<string, unknown>;
    const stage = typeof obj.stage === 'string' ? obj.stage : '';
    if (!stage) continue;
    out.push({
      stage,
      artifact: typeof obj.artifact === 'string' ? obj.artifact : '',
      classification:
        obj.classification === 'directly_changed' || obj.classification === 'transitively_affected'
          ? obj.classification
          : 'unaffected',
      resolution:
        obj.resolution === 'replace' || obj.resolution === 'retain' ? obj.resolution : 'baseline',
      path: typeof obj.path === 'string' ? obj.path : '',
      sha256: typeof obj.sha256 === 'string' ? obj.sha256 : '',
    });
  }
  return out;
}

function parseProjectRecord(value: unknown): ResolvedProjectRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.path !== 'string' || !obj.path) return null;
  return {
    path: obj.path,
    sha256: typeof obj.sha256 === 'string' ? obj.sha256 : '',
    staged: obj.staged === true,
  };
}

function parseCandidateSection(value: unknown): AnalysisAttempt['candidate'] {
  const obj = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    task_graph: str(obj.task_graph),
    task_graph_digest: str(obj.task_graph_digest),
    executor_plan: str(obj.executor_plan),
    executor_plan_digest: str(obj.executor_plan_digest),
    review_plan: str(obj.review_plan),
    review_plan_digest: str(obj.review_plan_digest),
  };
}

function parseBaseSection(value: unknown): AnalysisAttempt['base'] {
  const obj = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    task_graph_digest: str(obj.task_graph_digest),
    executor_plan_digest: str(obj.executor_plan_digest),
    review_plan_digest: str(obj.review_plan_digest),
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

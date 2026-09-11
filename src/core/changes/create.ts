/**
 * Change Request 创建（SpecCraft v0.9 §10–§12，ADR 0010）。
 *
 * `changes create` 必须对当前 canonical artifacts 做真实 baseline snapshot，
 * 并捕获创建瞬间的 workflow / project / frozen plan digests。
 * 不存在的事实记为 null，不伪造（§10）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Workflow } from '../types.js';
import { PROJECT_FILE, WORKFLOW_FILE } from '../state/store.js';
import { readRun } from '../execution/store.js';
import { captureGitSnapshot } from '../execution/git.js';
import { GRAPH_FILE, tasksDir } from '../tasks/store.js';
import { executorPlanPath } from '../executors/store.js';
import { reviewPlanPath } from '../reviews/store.js';
import { sha256Bytes, sha256File } from './digest.js';
import {
  BASELINE_DIR,
  allocateChangeDir,
  discardChangeDir,
  findActiveChangeForRun,
  writeChangeManifest,
  writeChangeRequest,
} from './store.js';
import type {
  ChangeBaselineArtifact,
  ChangeSetManifest,
  ChangeSource,
  ChangeWorkflowIdentity,
} from './types.js';
import { ChangeError } from './types.js';

const BASELINE_ARTIFACTS_DIR = 'artifacts';
const BASELINE_MANIFEST_FILE = 'manifest.yaml';
const BASELINE_PROJECT_FILE = 'project.yaml';

export interface CreateChangeOptions {
  speccraftDir: string;
  /** 目标项目根目录（用于 Git HEAD 采集） */
  projectRoot: string;
  /** 当前 workflow（决定需要 snapshot 哪些 canonical artifacts） */
  workflow: Workflow;
  baseRunId: string;
  /** Change 请求正文（来自 --reason 或 --file） */
  reason: string;
  source?: ChangeSource;
  sourceRef?: string;
  now?: Date;
}

/** baseline/manifest.yaml 的结构（v0.9 §9） */
interface BaselineManifest {
  changeId: string;
  baseRunId: string;
  createdAt: string;
  gitHead: string | null;
  workflow: ChangeWorkflowIdentity;
  projectDigest: string | null;
  artifacts: ChangeBaselineArtifact[];
  baseTaskGraphDigest: string | null;
  baseExecutorPlanDigest: string | null;
  baseReviewPlanDigest: string | null;
}

/**
 * 创建 Change Set：分配确定性 ID、snapshot baseline、捕获 digests、写入 draft manifest。
 *
 * 失败时清理本次创建的 change 目录，不留下半成品 Evidence。
 */
export async function createChange(options: CreateChangeOptions): Promise<ChangeSetManifest> {
  const reason = options.reason;
  if (!reason.trim()) {
    throw new Error('Change 请求不能为空（--reason 或 --file 必须提供内容）');
  }

  // base Run 必须真实存在（不伪造 base evidence）
  const run = await readRun(options.speccraftDir, options.baseRunId);

  // v0.9 §61：同一 base Run 同时最多一个 active Change
  const active = await findActiveChangeForRun(options.speccraftDir, run.id);
  if (active) {
    throw new ChangeError(
      'change_already_active',
      `Run ${run.id} already has active Change Set ${active.id} (${active.status}).`,
    );
  }

  const now = options.now ?? new Date();
  const createdAt = now.toISOString();
  const { changeId, dir } = await allocateChangeDir(options.speccraftDir);

  try {
    const gitSnapshot = await captureGitSnapshot(options.projectRoot);
    const gitHead = gitSnapshot?.commit ?? null;

    const workflow = await readWorkflowIdentity(options.speccraftDir, options.workflow);
    const projectDigest = await readProjectDigest(options.speccraftDir);

    const artifacts = await snapshotBaselineArtifacts({
      speccraftDir: options.speccraftDir,
      changeDir: dir,
      workflow: options.workflow,
    });

    const baseTaskGraphDigest = await digestIfExists(
      path.join(tasksDir(options.speccraftDir, run.id), GRAPH_FILE),
    );
    const baseExecutorPlanDigest = await digestIfExists(
      executorPlanPath(options.speccraftDir, run.id),
    );
    const baseReviewPlanDigest = await digestIfExists(reviewPlanPath(options.speccraftDir, run.id));

    const manifest: ChangeSetManifest = {
      id: changeId,
      status: 'draft',
      baseRunId: run.id,
      source: options.source ?? 'owner',
      ...(options.sourceRef ? { sourceRef: options.sourceRef } : {}),
      reason,
      createdAt,
      gitHead,
      workflow,
      projectDigest,
      artifacts,
      baseTaskGraphDigest,
      baseExecutorPlanDigest,
      baseReviewPlanDigest,
    };

    await writeChangeRequest(options.speccraftDir, changeId, reason);
    await writeBaselineManifest(dir, {
      changeId,
      baseRunId: run.id,
      createdAt,
      gitHead,
      workflow,
      projectDigest,
      artifacts,
      baseTaskGraphDigest,
      baseExecutorPlanDigest,
      baseReviewPlanDigest,
    });
    await writeChangeManifest(options.speccraftDir, manifest);

    return manifest;
  } catch (err) {
    await discardChangeDir(options.speccraftDir, changeId);
    throw err;
  }
}

/** 对 canonical artifacts 做真实字节 snapshot（v0.9 §11） */
async function snapshotBaselineArtifacts(input: {
  speccraftDir: string;
  changeDir: string;
  workflow: Workflow;
}): Promise<ChangeBaselineArtifact[]> {
  const artifactsDir = path.join(input.changeDir, BASELINE_DIR, BASELINE_ARTIFACTS_DIR);
  const out: ChangeBaselineArtifact[] = [];

  for (const stage of input.workflow.stages) {
    const artifact = stage.produces[0];
    if (!artifact) continue; // 过渡阶段不产出 artifact
    const canonical = path.join(input.speccraftDir, 'artifacts', `${artifact}.md`);
    // 先读取原始字节，再落盘快照 —— 保证 digest 与快照内容严格一致
    let bytes: Buffer;
    try {
      bytes = await readFile(canonical);
    } catch {
      continue; // 该 artifact 尚未产出：不记录、不伪造
    }
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(path.join(artifactsDir, `${stage.id}.md`), bytes);
    out.push({
      stage: stage.id,
      artifact,
      path: `${BASELINE_DIR}/${BASELINE_ARTIFACTS_DIR}/${stage.id}.md`,
      sha256: sha256Bytes(bytes),
    });
  }

  // baseline/project.yaml：project.yaml 的原始字节副本（§9）
  try {
    const projectBytes = await readFile(path.join(input.speccraftDir, PROJECT_FILE));
    await writeFile(path.join(input.changeDir, BASELINE_DIR, BASELINE_PROJECT_FILE), projectBytes);
  } catch {
    // 老项目可能没有 project.yaml：不伪造
  }

  return out;
}

async function readWorkflowIdentity(
  speccraftDir: string,
  workflow: Workflow,
): Promise<ChangeWorkflowIdentity> {
  const digest = await digestIfExists(path.join(speccraftDir, WORKFLOW_FILE));
  return { name: workflow.name, version: workflow.version, digest };
}

async function readProjectDigest(speccraftDir: string): Promise<string | null> {
  return digestIfExists(path.join(speccraftDir, PROJECT_FILE));
}

async function digestIfExists(filePath: string): Promise<string | null> {
  try {
    return await sha256File(filePath);
  } catch {
    return null;
  }
}

async function writeBaselineManifest(
  changeDirPath: string,
  baseline: BaselineManifest,
): Promise<void> {
  const dir = path.join(changeDirPath, BASELINE_DIR);
  await mkdir(dir, { recursive: true });
  const dumped = yaml.dump(
    {
      change_id: baseline.changeId,
      base_run_id: baseline.baseRunId,
      created_at: baseline.createdAt,
      git_head: baseline.gitHead,
      workflow: baseline.workflow,
      project_digest: baseline.projectDigest,
      artifacts: baseline.artifacts.map((a) => ({
        stage: a.stage,
        artifact: a.artifact,
        path: a.path,
        sha256: a.sha256,
      })),
      base_task_graph_digest: baseline.baseTaskGraphDigest,
      base_executor_plan_digest: baseline.baseExecutorPlanDigest,
      base_review_plan_digest: baseline.baseReviewPlanDigest,
    },
    { indent: 2, lineWidth: -1, noRefs: true },
  );
  await writeFile(path.join(dir, BASELINE_MANIFEST_FILE), dumped, 'utf8');
}

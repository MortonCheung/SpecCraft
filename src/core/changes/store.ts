/**
 * Change Set Store（SpecCraft v0.9 §8–§9，ADR 0010）。
 *
 * 职责边界：只负责 `.speccraft/changes/<change-id>/` 的持久化与只读发现。
 * 不负责 Impact Analysis、Approval、Replan、Promotion（各自独立模块）。
 */

import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import type {
  ChangeBaselineArtifact,
  ChangeSetManifest,
  ChangeSetStatus,
  ChangeSource,
  ChangeWorkflowIdentity,
} from './types.js';
import {
  ChangeError,
  canTransitionChange,
  isActiveChangeStatus,
  isChangeSetStatus,
  isChangeSource,
} from './types.js';

/** .speccraft/ 下的 changes 目录名 */
export const CHANGES_DIR = 'changes';
/** Change manifest 文件名 */
export const CHANGE_MANIFEST_FILE = 'manifest.yaml';
/** Change 请求正文文件名 */
export const CHANGE_REQUEST_FILE = 'request.md';
/** Change 拒绝证据文件名（v0.9 §14） */
export const REJECTION_FILE = 'rejection.yaml';
/** baseline 快照目录（相对 change 目录） */
export const BASELINE_DIR = 'baseline';
/** proposal 工作目录（相对 change 目录） */
export const PROPOSAL_DIR = 'proposal';
/** analysis attempt 目录（相对 change 目录） */
export const ANALYSIS_DIR = 'analysis';

export function changesDir(speccraftDir: string): string {
  return path.join(speccraftDir, CHANGES_DIR);
}

export function changeDir(speccraftDir: string, changeId: string): string {
  return path.join(changesDir(speccraftDir), changeId);
}

const CHANGE_ID_RE = /^change-(\d+)$/;

/** 解析 change id 为编号；非法返回 null */
export function parseChangeNumber(changeId: string): number | null {
  const m = CHANGE_ID_RE.exec(changeId);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function isChangeId(value: unknown): value is string {
  return typeof value === 'string' && parseChangeNumber(value) !== null;
}

/** 确定性本地编号：change-001（v0.9 §8，禁止 UUID / random / timestamp-only） */
export function formatChangeId(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`非法 Change 编号：${n}`);
  return `change-${String(n).padStart(3, '0')}`;
}

/** 列出全部 change id（按编号升序） */
export async function listChangeIds(speccraftDir: string): Promise<string[]> {
  const dir = changesDir(speccraftDir);
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && parseChangeNumber(e.name) !== null)
    .map((e) => e.name)
    .sort((a, b) => (parseChangeNumber(a) ?? 0) - (parseChangeNumber(b) ?? 0));
}

/** 下一个可用编号（已有目录最大值 + 1） */
export async function nextChangeNumber(speccraftDir: string): Promise<number> {
  const max = (await listChangeIds(speccraftDir)).reduce(
    (acc, id) => Math.max(acc, parseChangeNumber(id) ?? 0),
    0,
  );
  return max + 1;
}

/**
 * 分配 Change ID 并创建目录（v0.9 §8：编号分配必须防止碰撞）。
 *
 * 用非递归 mkdir 抢占编号；若已被并发占用（EEXIST）则递增重试。
 * 返回的目录保证由本次调用创建。
 */
export async function allocateChangeDir(
  speccraftDir: string,
): Promise<{ changeId: string; dir: string }> {
  const root = changesDir(speccraftDir);
  await mkdir(root, { recursive: true });
  let n = await nextChangeNumber(speccraftDir);
  for (let i = 0; i < 1000; i++) {
    const changeId = formatChangeId(n);
    const dir = path.join(root, changeId);
    try {
      await mkdir(dir);
      return { changeId, dir };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      n += 1;
    }
  }
  throw new Error('无法分配 Change ID：连续 1000 个编号均已被占用');
}

/** 丢弃一个刚分配、尚未写入 manifest 的 change 目录（创建失败时清理） */
export async function discardChangeDir(speccraftDir: string, changeId: string): Promise<void> {
  await rm(changeDir(speccraftDir, changeId), { recursive: true, force: true });
}

/** 序列化 Change manifest（snake_case 键，贴近用户阅读习惯） */
export function stringifyChangeManifest(manifest: ChangeSetManifest): string {
  return yaml.dump(
    {
      id: manifest.id,
      status: manifest.status,
      base_run_id: manifest.baseRunId,
      source: manifest.source,
      ...(manifest.sourceRef ? { source_ref: manifest.sourceRef } : {}),
      reason: manifest.reason,
      created_at: manifest.createdAt,
      git_head: manifest.gitHead,
      workflow: {
        name: manifest.workflow.name,
        version: manifest.workflow.version,
        digest: manifest.workflow.digest,
      },
      project_digest: manifest.projectDigest,
      artifacts: manifest.artifacts.map((a) => ({
        stage: a.stage,
        artifact: a.artifact,
        path: a.path,
        sha256: a.sha256,
      })),
      base_task_graph_digest: manifest.baseTaskGraphDigest,
      base_executor_plan_digest: manifest.baseExecutorPlanDigest,
      base_review_plan_digest: manifest.baseReviewPlanDigest,
    },
    { indent: 2, lineWidth: -1, noRefs: true },
  );
}

/** 解析 Change manifest 文本 */
export function parseChangeManifest(source: string): ChangeSetManifest {
  const loaded = yaml.load(source);
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error('change manifest 顶层必须是对象');
  }
  const obj = loaded as Record<string, unknown>;

  const id = typeof obj.id === 'string' ? obj.id : '';
  if (!isChangeId(id)) throw new Error(`change manifest 的 id 非法：${String(obj.id)}`);
  if (!isChangeSetStatus(obj.status)) {
    throw new Error(`change ${id} 的 status 非法：${String(obj.status)}`);
  }
  const baseRunId = readStr(obj.base_run_id) ?? readStr(obj.baseRunId) ?? '';
  if (!baseRunId) throw new Error(`change ${id} 缺少 base_run_id`);
  if (!isChangeSource(obj.source)) {
    throw new Error(`change ${id} 的 source 非法：${String(obj.source)}`);
  }
  const createdAt = readStr(obj.created_at) ?? readStr(obj.createdAt) ?? '';

  const manifest: ChangeSetManifest = {
    id,
    status: obj.status,
    baseRunId,
    source: obj.source,
    reason: typeof obj.reason === 'string' ? obj.reason : '',
    createdAt,
    gitHead: readNullableStr(obj.git_head ?? obj.gitHead),
    workflow: parseWorkflowIdentity(obj.workflow, id),
    projectDigest: readNullableStr(obj.project_digest ?? obj.projectDigest),
    artifacts: parseBaselineArtifacts(obj.artifacts, id),
    baseTaskGraphDigest: readNullableStr(obj.base_task_graph_digest ?? obj.baseTaskGraphDigest),
    baseExecutorPlanDigest: readNullableStr(
      obj.base_executor_plan_digest ?? obj.baseExecutorPlanDigest,
    ),
    baseReviewPlanDigest: readNullableStr(obj.base_review_plan_digest ?? obj.baseReviewPlanDigest),
  };

  const sourceRef = readStr(obj.source_ref) ?? readStr(obj.sourceRef);
  if (sourceRef) manifest.sourceRef = sourceRef;

  return manifest;
}

function parseWorkflowIdentity(value: unknown, changeId: string): ChangeWorkflowIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`change ${changeId} 缺少 workflow 身份`);
  }
  const obj = value as Record<string, unknown>;
  return {
    name: typeof obj.name === 'string' ? obj.name : '',
    version: typeof obj.version === 'string' ? obj.version : '',
    digest: readNullableStr(obj.digest),
  };
}

function parseBaselineArtifacts(value: unknown, changeId: string): ChangeBaselineArtifact[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`change ${changeId} 的 artifacts 必须是数组`);
  const out: ChangeBaselineArtifact[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const obj = raw as Record<string, unknown>;
    const stage = typeof obj.stage === 'string' ? obj.stage : '';
    const artifact = typeof obj.artifact === 'string' ? obj.artifact : '';
    const snapshotPath = typeof obj.path === 'string' ? obj.path : '';
    const sha256 = typeof obj.sha256 === 'string' ? obj.sha256 : '';
    if (!stage || !sha256) throw new Error(`change ${changeId} 的 baseline artifact 不完整`);
    out.push({ stage, artifact, path: snapshotPath, sha256 });
  }
  return out;
}

/** 写入 manifest.yaml（创建目录如不存在） */
export async function writeChangeManifest(
  speccraftDir: string,
  manifest: ChangeSetManifest,
): Promise<void> {
  const dir = changeDir(speccraftDir, manifest.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, CHANGE_MANIFEST_FILE), stringifyChangeManifest(manifest), 'utf8');
}

/** 读取 manifest.yaml；不存在时抛错 */
export async function readChangeManifest(
  speccraftDir: string,
  changeId: string,
): Promise<ChangeSetManifest> {
  const file = path.join(changeDir(speccraftDir, changeId), CHANGE_MANIFEST_FILE);
  if (!(await pathExists(file))) {
    throw new Error(`Change 不存在：${changeId}（${file}）`);
  }
  return parseChangeManifest(await readFile(file, 'utf8'));
}

/** 读取 manifest.yaml；不存在时返回 null */
export async function readChangeManifestOrNull(
  speccraftDir: string,
  changeId: string,
): Promise<ChangeSetManifest | null> {
  const file = path.join(changeDir(speccraftDir, changeId), CHANGE_MANIFEST_FILE);
  if (!(await pathExists(file))) return null;
  return parseChangeManifest(await readFile(file, 'utf8'));
}

/** 读取全部 Change manifest（按编号升序；跳过缺少 manifest 的残缺目录） */
export async function listChangeManifests(speccraftDir: string): Promise<ChangeSetManifest[]> {
  const out: ChangeSetManifest[] = [];
  for (const id of await listChangeIds(speccraftDir)) {
    const manifest = await readChangeManifestOrNull(speccraftDir, id);
    if (manifest) out.push(manifest);
  }
  return out;
}

/** 迁移 Change 状态（非法迁移直接失败，不做隐式修正） */
export async function updateChangeStatus(
  speccraftDir: string,
  manifest: ChangeSetManifest,
  status: ChangeSetStatus,
): Promise<void> {
  if (!canTransitionChange(manifest.status, status)) {
    throw new ChangeError(
      'invalid_change_transition',
      `Change ${manifest.id} 不允许从 ${manifest.status} 迁移到 ${status}`,
    );
  }
  manifest.status = status;
  await writeChangeManifest(speccraftDir, manifest);
}

/**
 * 查找绑定到同一 base Run 的 active Change（v0.9 §61）。
 * 同一 base Run 同时最多一个 active Change（v0.9 不实现 Change merge）。
 */
export async function findActiveChangeForRun(
  speccraftDir: string,
  baseRunId: string,
): Promise<ChangeSetManifest | null> {
  for (const id of await listChangeIds(speccraftDir)) {
    const manifest = await readChangeManifestOrNull(speccraftDir, id);
    if (manifest && manifest.baseRunId === baseRunId && isActiveChangeStatus(manifest.status)) {
      return manifest;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reject（v0.9 §14）
// ---------------------------------------------------------------------------

/** `.speccraft/changes/<change-id>/rejection.yaml`（v0.9 §14） */
export interface ChangeRejection {
  change_id: string;
  reason: string;
  rejected_at: string;
}

export function rejectionPath(speccraftDir: string, changeId: string): string {
  return path.join(changeDir(speccraftDir, changeId), REJECTION_FILE);
}

export function stringifyChangeRejection(rejection: ChangeRejection): string {
  return yaml.dump(
    {
      change_id: rejection.change_id,
      reason: rejection.reason,
      rejected_at: rejection.rejected_at,
    },
    { indent: 2, lineWidth: -1, noRefs: true },
  );
}

export function parseChangeRejection(source: string): ChangeRejection {
  const loaded = yaml.load(source);
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error('rejection.yaml 顶层必须是对象');
  }
  const obj = loaded as Record<string, unknown>;
  const changeId = readStr(obj.change_id ?? obj.changeId);
  if (!changeId) throw new Error('rejection.yaml 缺少 change_id');
  return {
    change_id: changeId,
    reason: readStr(obj.reason) ?? '',
    rejected_at: readStr(obj.rejected_at ?? obj.rejectedAt) ?? '',
  };
}

export async function readChangeRejectionOrNull(
  speccraftDir: string,
  changeId: string,
): Promise<ChangeRejection | null> {
  const file = rejectionPath(speccraftDir, changeId);
  if (!(await pathExists(file))) return null;
  return parseChangeRejection(await readFile(file, 'utf8'));
}

export interface RejectChangeOptions {
  speccraftDir: string;
  changeId: string;
  /** 拒绝原因（`--reason` 或 `--file`）；必须非空 */
  reason: string;
  now?: Date;
}

/**
 * Owner 拒绝一个 Change（§14）。
 *
 * 只允许 draft / analyzed → rejected；之后 base Run 恢复可执行（计划没有被改变）。
 * 拒绝原因写入 rejection.yaml，Change Evidence（baseline / proposal / analysis）永久保留。
 */
export async function rejectChange(options: RejectChangeOptions): Promise<ChangeSetManifest> {
  const reason = options.reason;
  if (!reason.trim()) {
    throw new Error('changes reject 需要 --reason <text> 或 --file <path>');
  }

  const manifest = await readChangeManifest(options.speccraftDir, options.changeId);
  if (manifest.status !== 'draft' && manifest.status !== 'analyzed') {
    throw new ChangeError(
      manifest.status === 'rejected' ? 'change_rejected' : 'invalid_change_transition',
      `Change ${manifest.id} 当前状态为 ${manifest.status}，只有 draft / analyzed 可以 reject。`,
    );
  }

  await writeChangeRejection(options.speccraftDir, manifest.id, {
    change_id: manifest.id,
    reason,
    rejected_at: (options.now ?? new Date()).toISOString(),
  });
  await updateChangeStatus(options.speccraftDir, manifest, 'rejected');
  return manifest;
}

async function writeChangeRejection(
  speccraftDir: string,
  changeId: string,
  rejection: ChangeRejection,
): Promise<void> {
  await mkdir(changeDir(speccraftDir, changeId), { recursive: true });
  await writeFile(rejectionPath(speccraftDir, changeId), stringifyChangeRejection(rejection), 'utf8');
}

/** 写入 request.md（创建时一次性写入，其后不再改写） */
export async function writeChangeRequest(
  speccraftDir: string,
  changeId: string,
  content: string,
): Promise<void> {
  const dir = changeDir(speccraftDir, changeId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, CHANGE_REQUEST_FILE), content, 'utf8');
}

/** 读取 request.md；不存在时返回 null */
export async function readChangeRequestOrNull(
  speccraftDir: string,
  changeId: string,
): Promise<string | null> {
  const file = path.join(changeDir(speccraftDir, changeId), CHANGE_REQUEST_FILE);
  if (!(await pathExists(file))) return null;
  return readFile(file, 'utf8');
}

/** 判断 change 目录下某个相对路径文件是否存在 */
export async function changeFileExists(
  speccraftDir: string,
  changeId: string,
  relativePath: string,
): Promise<boolean> {
  return pathExists(path.join(changeDir(speccraftDir, changeId), relativePath));
}

/**
 * 列出 proposal/ 下的全部文件（相对 change 目录，`/` 分隔，升序）。
 * proposal 尚未创建时返回 []。
 */
export async function listProposalFiles(
  speccraftDir: string,
  changeId: string,
): Promise<string[]> {
  return listFilesRecursive(
    path.join(changeDir(speccraftDir, changeId), PROPOSAL_DIR),
    `${PROPOSAL_DIR}/`,
  );
}

/** 列出 analysis/attempt-NNN 目录名（升序）；无 attempt 时返回 [] */
export async function listAnalysisAttempts(
  speccraftDir: string,
  changeId: string,
): Promise<string[]> {
  const dir = path.join(changeDir(speccraftDir, changeId), ANALYSIS_DIR);
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && /^attempt-\d+$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

async function listFilesRecursive(dir: string, prefix: string): Promise<string[]> {
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(child, `${prefix}${entry.name}/`)));
    } else {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out.sort();
}

function readStr(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function readNullableStr(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

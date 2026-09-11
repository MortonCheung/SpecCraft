/**
 * Change Proposal Workspace（SpecCraft v0.9 §15–§16、§19–§20、§33–§34，ADR 0010）。
 *
 * Proposal 必须在隔离目录工作：`proposal/` —— 绝不直接修改 canonical artifact。
 * 本模块只负责 staging / retain / 解析身份校验 / proposal digest；
 * 不做 Impact Analysis（impact.ts）。
 */

import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Workflow } from '../types.js';
import { parseArtifact } from '../artifacts/store.js';
import { parseProjectConfig } from '../project.js';
import { changeDir, readChangeManifest } from './store.js';
import { ChangeError } from './types.js';
import type { ChangeSetManifest } from './types.js';
import { bundleDigest, sha256Bytes } from './digest.js';
import type { BundleEntry } from './digest.js';

/** proposal/ 下的 artifact 替换目录 */
export const PROPOSAL_ARTIFACTS_DIR = 'artifacts';
/** proposal/ 下的 project.yaml 替换文件名 */
export const PROPOSAL_CONFIG_FILE = 'project.yaml';
/** resolutions.yaml（retain 决策，proposal 目录下） */
export const RESOLUTIONS_FILE = 'resolutions.yaml';

export function proposalDir(speccraftDir: string, changeId: string): string {
  return path.join(changeDir(speccraftDir, changeId), 'proposal');
}

/** proposal/artifacts/<stage-id>.md 绝对路径 */
export function proposalArtifactPath(
  speccraftDir: string,
  changeId: string,
  stageId: string,
): string {
  return path.join(proposalDir(speccraftDir, changeId), PROPOSAL_ARTIFACTS_DIR, `${stageId}.md`);
}

/** proposal/project.yaml 绝对路径 */
export function proposalConfigPath(speccraftDir: string, changeId: string): string {
  return path.join(proposalDir(speccraftDir, changeId), PROPOSAL_CONFIG_FILE);
}

/** resolutions.yaml 绝对路径 */
export function resolutionsPath(speccraftDir: string, changeId: string): string {
  return path.join(proposalDir(speccraftDir, changeId), RESOLUTIONS_FILE);
}

const STAGE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** approved（及之后）的 Change 禁止任何 Proposal mutation（v0.9 §34） */
export function assertProposalMutable(manifest: ChangeSetManifest): void {
  if (manifest.status === 'approved' || manifest.status === 'materialized' || manifest.status === 'closed') {
    throw new ChangeError(
      'change_already_approved',
      `Change ${manifest.id} 已处于 ${manifest.status}，Proposal 与 Resolution 不可修改。`,
    );
  }
  if (manifest.status === 'rejected') {
    throw new ChangeError(
      'change_rejected',
      `Change ${manifest.id} 已 rejected，不可再修改 Proposal。`,
    );
  }
}

/** 解析并校验目标 stage（必须存在于 Workflow 且产出 canonical artifact） */
function resolveArtifactStage(
  workflow: Workflow,
  stageId: string,
): { stageId: string; artifact: string } {
  if (!STAGE_ID_RE.test(stageId)) {
    throw new Error(`非法 stage id：${stageId}`);
  }
  const stage = workflow.stages.find((s) => s.id === stageId);
  if (!stage) {
    throw new Error(`Workflow 中不存在 stage：${stageId}`);
  }
  const artifact = stage.produces[0];
  if (!artifact) {
    throw new Error(`stage ${stageId} 不产出 canonical artifact，不能 stage 替换版本`);
  }
  return { stageId, artifact };
}

/**
 * stage 一个 artifact replacement（v0.9 §15）。
 *
 * 校验：Change 可变 / stage 存在 / replacement 是合法 artifact /
 * artifact metadata 与目标 stage 匹配 / id 不逃逸路径。
 */
export async function stageProposalArtifact(options: {
  speccraftDir: string;
  changeId: string;
  stageId: string;
  source: string;
  workflow: Workflow;
}): Promise<void> {
  const manifest = await readChangeManifest(options.speccraftDir, options.changeId);
  assertProposalMutable(manifest);

  const target = resolveArtifactStage(options.workflow, options.stageId);

  // replacement 必须是合法 artifact，且身份与目标 stage 严格匹配
  const parsed = parseArtifact(options.source);
  if (parsed.frontmatter.stage !== target.stageId) {
    throw new Error(
      `replacement artifact 的 stage=${parsed.frontmatter.stage} 与目标 stage=${target.stageId} 不匹配`,
    );
  }
  if (parsed.frontmatter.artifact !== target.artifact) {
    throw new Error(
      `replacement artifact 的 artifact=${parsed.frontmatter.artifact} 与目标 ${target.artifact} 不匹配`,
    );
  }

  const file = proposalArtifactPath(options.speccraftDir, options.changeId, target.stageId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, options.source, 'utf8');

  // replace 覆盖同 stage 的 retain 决策，避免歧义
  await removeRetained(options.speccraftDir, options.changeId, target.stageId);
}

/** stage 一个 project.yaml replacement（v0.9 §16；executor / review / execution / hooks 配置） */
export async function stageProposalConfig(options: {
  speccraftDir: string;
  changeId: string;
  source: string;
}): Promise<void> {
  const manifest = await readChangeManifest(options.speccraftDir, options.changeId);
  assertProposalMutable(manifest);

  // 必须是合法 project.yaml（复用既有 parser，不发明第二套规则）
  parseProjectConfig(options.source);

  const file = proposalConfigPath(options.speccraftDir, options.changeId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, options.source, 'utf8');
}

/** 显式 retain 一个受影响 artifact（v0.9 §19） */
export async function retainArtifact(options: {
  speccraftDir: string;
  changeId: string;
  stageId: string;
  workflow: Workflow;
}): Promise<void> {
  const manifest = await readChangeManifest(options.speccraftDir, options.changeId);
  assertProposalMutable(manifest);

  const target = resolveArtifactStage(options.workflow, options.stageId);

  // 同一 stage 不能既 replace 又 retain（避免歧义）
  if (await pathExists(proposalArtifactPath(options.speccraftDir, options.changeId, target.stageId))) {
    throw new ChangeError(
      'change_resolution_conflict',
      `stage ${target.stageId} 已 stage replacement，不能再 retain（请先以 replace 结果为准）。`,
    );
  }

  const retained = await readRetainedStages(options.speccraftDir, options.changeId);
  if (!retained.includes(target.stageId)) {
    retained.push(target.stageId);
    retained.sort();
    await writeRetainedStages(options.speccraftDir, options.changeId, retained);
  }
}

/** 读取 retained stage 列表（升序）；无 resolutions.yaml 时返回 [] */
export async function readRetainedStages(
  speccraftDir: string,
  changeId: string,
): Promise<string[]> {
  const file = resolutionsPath(speccraftDir, changeId);
  if (!(await pathExists(file))) return [];
  const loaded = yaml.load(await readFile(file, 'utf8'));
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error(`resolutions.yaml 顶层必须是对象（change ${changeId}）`);
  }
  const raw = (loaded as Record<string, unknown>).retained;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`resolutions.yaml 的 retained 必须是数组`);
  return raw
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .sort();
}

async function writeRetainedStages(
  speccraftDir: string,
  changeId: string,
  retained: string[],
): Promise<void> {
  const file = resolutionsPath(speccraftDir, changeId);
  await mkdir(path.dirname(file), { recursive: true });
  const dumped = yaml.dump(
    { version: 1, change_id: changeId, retained },
    { indent: 2, lineWidth: -1, noRefs: true },
  );
  await writeFile(file, dumped, 'utf8');
}

async function removeRetained(
  speccraftDir: string,
  changeId: string,
  stageId: string,
): Promise<void> {
  const retained = await readRetainedStages(speccraftDir, changeId);
  if (!retained.includes(stageId)) return;
  await writeRetainedStages(
    speccraftDir,
    changeId,
    retained.filter((s) => s !== stageId),
  );
}

/** 列出已 stage 的 artifact stage id（升序）；proposal 目录缺失时返回 [] */
export async function listStagedStages(speccraftDir: string, changeId: string): Promise<string[]> {
  const dir = path.join(proposalDir(speccraftDir, changeId), PROPOSAL_ARTIFACTS_DIR);
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name.slice(0, -'.md'.length))
    .sort();
}

/** 是否已 stage project.yaml replacement */
export async function hasStagedConfig(speccraftDir: string, changeId: string): Promise<boolean> {
  return pathExists(proposalConfigPath(speccraftDir, changeId));
}

/**
 * Proposal bundle digest（v0.9 §33）：proposal 目录下全部文件的 raw-byte digest。
 *
 * proposal 为空时返回 null。用于判定 Analysis 之后 Proposal 是否被修改。
 */
export async function proposalBundleDigest(
  speccraftDir: string,
  changeId: string,
): Promise<string | null> {
  const dir = proposalDir(speccraftDir, changeId);
  const files = await listFilesRecursive(dir, '');
  if (files.length === 0) return null;
  const entries: BundleEntry[] = [];
  for (const rel of files.sort()) {
    const bytes = await readFile(path.join(dir, rel));
    entries.push({ path: `proposal/${rel}`, sha256: sha256Bytes(bytes) });
  }
  return bundleDigest(entries);
}

async function listFilesRecursive(dir: string, prefix: string): Promise<string[]> {
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(path.join(dir, entry.name), `${prefix}${entry.name}/`)));
    } else if (entry.isFile()) {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

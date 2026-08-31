import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Artifact, ArtifactFrontmatter } from '../types.js';
import { isStageStatus } from '../state/store.js';

/** 约定 Artifact 文件名：`<artifact-id>.md` */
export function artifactFileName(id: string): string {
  return `${id}.md`;
}

/**
 * 解析 Artifact 文本为 frontmatter + body。
 * frontmatter 由开头的 `---` 块界定，格式见 ADR 0002 §6。
 */
export function parseArtifact(source: string): Omit<Artifact, 'filename'> {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    throw new Error('artifact 缺少 YAML frontmatter（文件需以 --- 开头）');
  }
  const fmRaw = yaml.load(match[1]);
  if (typeof fmRaw !== 'object' || fmRaw === null || Array.isArray(fmRaw)) {
    throw new Error('artifact frontmatter 必须是对象');
  }
  const fm = fmRaw as Record<string, unknown>;

  const artifact = typeof fm.artifact === 'string' ? fm.artifact : '';
  if (!artifact) throw new Error('artifact frontmatter 缺少 artifact 字段');
  const stage = typeof fm.stage === 'string' ? fm.stage : '';
  if (!stage) throw new Error(`artifact ${artifact} frontmatter 缺少 stage 字段`);
  if (!isStageStatus(fm.status)) {
    throw new Error(`artifact ${artifact} frontmatter 的 status 非法: ${String(fm.status)}`);
  }
  const version = typeof fm.version === 'number' ? fm.version : 0;
  if (version < 1) {
    throw new Error(`artifact ${artifact} frontmatter 的 version 必须是正整数`);
  }

  const frontmatter: ArtifactFrontmatter = {
    artifact,
    stage,
    status: fm.status,
    version,
  };
  if (typeof fm.id === 'string' && fm.id) frontmatter.id = fm.id;
  const sourceIds = toStrArray(fm.source, `artifact ${artifact} 的 source`);
  if (sourceIds.length) frontmatter.source = sourceIds;
  const requires = toStrArray(fm.requires, `artifact ${artifact} 的 requires`);
  if (requires.length) frontmatter.requires = requires;

  return { frontmatter, body: source.slice(match[0].length) };
}

/** 将 Artifact 序列化为 Markdown + YAML Frontmatter 文本 */
export function stringifyArtifact(artifact: Artifact): string {
  const fm = yaml.dump(artifact.frontmatter, { indent: 2, lineWidth: -1, noRefs: true });
  return `---\n${fm}---\n\n${artifact.body}`;
}

/** 读取一个 Artifact 文件 */
export async function readArtifact(filePath: string): Promise<Artifact> {
  const source = await readFile(filePath, 'utf8');
  const { frontmatter, body } = parseArtifact(source);
  return { filename: path.basename(filePath), frontmatter, body };
}

/** 写入一个 Artifact 文件 */
export async function writeArtifact(filePath: string, artifact: Artifact): Promise<void> {
  await writeFile(filePath, stringifyArtifact(artifact), 'utf8');
}

/** 由 frontmatter + body 构造 Artifact */
export function createArtifact(frontmatter: ArtifactFrontmatter, body: string): Artifact {
  return { filename: artifactFileName(frontmatter.artifact), frontmatter, body };
}

function toStrArray(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  return value.filter((v): v is string => typeof v === 'string');
}

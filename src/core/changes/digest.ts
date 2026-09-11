/**
 * Evidence Digest（SpecCraft v0.9 §11–§12，ADR 0010）。
 *
 * 两条硬规则：
 * 1. 一切 digest 基于 raw file bytes —— 不 trim、不 normalize markdown、
 *    不 normalize line endings、不重新 serialize；
 * 2. bundle digest 不使用 YAML stringify 结果，避免受 key 顺序影响。
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** 对原始字节计算 SHA-256（hex） */
export function sha256Bytes(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 读取文件原始字节并计算 SHA-256 */
export async function sha256File(filePath: string): Promise<string> {
  return sha256Bytes(await readFile(filePath));
}

/** bundle 中的一个文件条目：相对路径 + 该文件 SHA-256 */
export interface BundleEntry {
  /** bundle 内的相对路径（使用 `/` 分隔） */
  path: string;
  /** 该文件原始字节的 SHA-256 */
  sha256: string;
}

/**
 * Bundle Digest 稳定算法（v0.9 §12）：
 * 1. 每个文件已由调用方计算 SHA-256；
 * 2. 相对路径升序排序；
 * 3. 构造 `<path>\0<sha256>\n`；
 * 4. 对整体字符串 SHA-256。
 *
 * 例：
 *   artifacts/design.md\0abc...\n
 *   artifacts/requirement.md\0def...\n
 *   project.yaml\0ghi...\n
 */
export function bundleDigest(entries: readonly BundleEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const payload = sorted.map((e) => `${e.path}\0${e.sha256}\n`).join('');
  return sha256Bytes(payload);
}

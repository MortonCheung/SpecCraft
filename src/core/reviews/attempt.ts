/**
 * Review Attempt Store（ADR 0009 §57-§59）。
 *
 * 读取 Review Attempt Manifest（append-only，attempt-NNN/manifest.yaml）。
 * manifestPath 可以是 manifest.yaml 文件路径，也可以是 attempt-NNN 目录路径。
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ReviewAttemptManifest } from './types.js';

export async function readReviewManifestOrNull(manifestPath: string): Promise<ReviewAttemptManifest | null> {
  let filePath = manifestPath;
  try {
    const s = await stat(manifestPath);
    if (s.isDirectory()) {
      filePath = path.join(manifestPath, 'manifest.yaml');
    }
  } catch {
    return null;
  }
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (parsed.version !== 1) return null;
    if (typeof parsed.gate_id !== 'string') return null;
    if (typeof parsed.decision !== 'string') return null;
    return parsed as ReviewAttemptManifest;
  } catch {
    return null;
  }
}

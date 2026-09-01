/**
 * Review Attempt Store（ADR 0009 §57-§59）。
 *
 * 读取 Review Attempt Manifest（append-only，attempt-NNN/manifest.yaml）。
 */

import { readFile, access } from 'node:fs/promises';
import type { ReviewAttemptManifest } from './types.js';

export async function readReviewManifestOrNull(manifestPath: string): Promise<ReviewAttemptManifest | null> {
  try {
    await access(manifestPath);
  } catch {
    return null;
  }
  try {
    const content = await readFile(manifestPath, 'utf-8');
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

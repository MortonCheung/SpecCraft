/**
 * Structured Review Protocol Parser（ADR 0009 §52-§56）。
 *
 * Reviewer 必须输出唯一 ```speccraft-review YAML block。
 * Runtime 根据 findings 决定 Gate Decision：
 *   - 存在 blocker / major → CHANGES_REQUIRED
 *   - 只有 minor / 无 findings → PASS
 *   - malformed → ERROR
 */

import yaml from 'js-yaml';
import type { ReviewOutput, ReviewFinding, ReviewDecision, FindingSeverity, FindingCategory } from './types.js';
import { isFindingSeverity, isFindingCategory } from './types.js';

/**
 * 从 Reviewer 输出中提取 speccraft-review block。
 *
 * 返回 null 表示未找到 / malformed（调用方应标记为 ERROR）。
 */
export function parseReviewOutput(rawOutput: string): ReviewOutput | null {
  const blockRegex = /```speccraft-review\s+([\s\S]*?)```/;
  const match = rawOutput.match(blockRegex);
  if (!match) return null;

  const yamlText = match[1].trim();
  let parsed: any;
  try {
    parsed = yaml.load(yamlText) as any;
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  if (parsed.version !== 1) return null;
  if (typeof parsed.summary !== 'string') return null;

  const findings: ReviewFinding[] = [];
  if (Array.isArray(parsed.findings)) {
    for (const f of parsed.findings) {
      if (typeof f !== 'object' || f === null) continue;
      if (!isFindingSeverity(f.severity)) return null;
      if (!isFindingCategory(f.category)) return null;
      if (typeof f.message !== 'string' || !f.message) return null;
      findings.push({
        severity: f.severity as FindingSeverity,
        category: f.category as FindingCategory,
        path: typeof f.path === 'string' ? f.path : undefined,
        line: typeof f.line === 'number' ? f.line : undefined,
        message: f.message,
      });
    }
  }

  return {
    version: 1,
    summary: parsed.summary,
    findings,
  };
}

/**
 * 根据 findings 推导 Gate Decision（Runtime 算法，不由 Reviewer 决定）。
 */
export function deriveReviewDecision(findings: ReviewFinding[]): ReviewDecision {
  const hasBlocking = findings.some((f) => f.severity === 'blocker' || f.severity === 'major');
  return hasBlocking ? 'changes_required' : 'pass';
}

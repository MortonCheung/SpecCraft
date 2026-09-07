/**
 * Review Feedback（ADR 0009 §82-§88）。
 *
 * compileLatestReviewFeedback(taskId)：
 *   读取最近一次 CHANGES_REQUIRED gate 的 blocker/major findings，
 *   生成 rework prompt 供 Executor retry 使用。
 *
 * isCurrentReviewSatisfied(task, latestDispatch, latestVerification)：
 *   验证每个 required gate 都存在 decision=pass 且绑定当前施工版本。
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { TaskManifest } from '../tasks/types.js';
import type { ReviewDecision, FindingSeverity } from './types.js';
import { readReviewPlanOrNull } from './store.js';
import { reviewEvidenceDir } from './paths.js';
import { readReviewManifestOrNull } from './attempt.js';

export interface ReviewFeedbackFinding {
  severity: FindingSeverity;
  category: string;
  path?: string;
  line?: number;
  message: string;
  gateId: string;
}

export interface ReviewFeedback {
  taskId: string;
  hasBlockingFeedback: boolean;
  findings: ReviewFeedbackFinding[];
  gateDecisions: Array<{ gateId: string; decision: ReviewDecision; attemptNumber: number }>;
}

/**
 * Compile latest review feedback for a task（§83）。
 *
 * 只读取最近一次 CHANGES_REQUIRED gate 的 blocker/major findings。
 * minor findings 可展示但不作为 rework 核心指令。
 */
export async function compileLatestReviewFeedback(
  speccraftDir: string,
  runId: string,
  taskId: string,
): Promise<ReviewFeedback> {
  const plan = await readReviewPlanOrNull(speccraftDir, runId);
  const gateDecisions: ReviewFeedback['gateDecisions'] = [];
  const findings: ReviewFeedbackFinding[] = [];
  let hasBlockingFeedback = false;

  if (!plan || !plan.enabled) {
    return { taskId, hasBlockingFeedback: false, findings, gateDecisions };
  }

  for (const gate of plan.gates) {
    const evidenceDir = reviewEvidenceDir(speccraftDir, runId, taskId, gate.id);
    const manifest = await readLatestReviewAttemptManifest(evidenceDir);
    if (!manifest) {
      gateDecisions.push({ gateId: gate.id, decision: 'error', attemptNumber: 0 });
      continue;
    }

    gateDecisions.push({
      gateId: gate.id,
      decision: manifest.decision,
      attemptNumber: manifest.attempt,
    });

    if (manifest.decision === 'changes_required' || manifest.decision === 'error') {
      const attemptDir = path.join(evidenceDir, `attempt-${String(manifest.attempt).padStart(3, '0')}`);
      const findingsFile = path.join(attemptDir, 'findings.yaml');
      try {
        const { readFile } = await import('node:fs/promises');
        const content = await readFile(findingsFile, 'utf-8');
        const parsed = JSON.parse(content) as Array<{
          severity: FindingSeverity;
          category: string;
          path?: string;
          line?: number;
          message: string;
        }>;
        for (const f of parsed) {
          findings.push({ ...f, gateId: gate.id });
          if (f.severity === 'blocker' || f.severity === 'major') {
            hasBlockingFeedback = true;
          }
        }
      } catch {
        // findings.yaml may not exist if ERROR (no protocol block parsed)
      }
    }
  }

  return { taskId, hasBlockingFeedback, findings, gateDecisions };
}

/** 单个 Review Gate 的最新 attempt 状态（无 evidence 时 decision 为 'none'） */
export interface ReviewGateLatestState {
  gateId: string;
  decision: ReviewDecision | 'none';
  attempt: number;
  errorCode?: string;
}

/** 单 Task 的最新 Review Gate 决策摘要（供 Aggregate Report 引用；无 evidence 时为空） */
export interface TaskReviewDecisionSummary {
  /** 如 "review [spec_compliance PASS，code_quality PASS]"（含前导逗号），无则空串 */
  inline: string;
  /** 该 Task 是否存在至少一条真实 review evidence（reviews/ 目录） */
  hasEvidence: boolean;
}

/**
 * §18：Aggregate Report 只引用 Evidence，不允许 AI 二次总结。
 *
 * 按 frozen Review Plan gate 顺序汇总各 gate 最新 decision（gate.decision 大写），
 * 只统计存在真实 attempt 的 gate；plan disabled / 无 evidence → inline 空串、hasEvidence false。
 */
export async function summarizeTaskReviews(
  speccraftDir: string,
  runId: string,
  taskId: string,
): Promise<TaskReviewDecisionSummary> {
  const plan = await readReviewPlanOrNull(speccraftDir, runId);
  if (!plan || !plan.enabled || plan.gates.length === 0) {
    return { inline: '', hasEvidence: false };
  }
  const states = await latestReviewGateStates(speccraftDir, runId, taskId);
  const present = states.filter((s) => s.decision !== 'none');
  if (present.length === 0) {
    return { inline: '', hasEvidence: false };
  }
  const parts = present.map((s) => `${s.gateId} ${s.decision.toUpperCase()}`);
  return { inline: `，review [${parts.join('，')}]`, hasEvidence: true };
}

/**
 * 按 frozen Review Plan gate 顺序读取某 Task 各 gate 的最新 review attempt 状态。
 *
 * v0.8 §19/§21：供 status（failed tasks 计数）与 next（review rework / review ERROR
 * 引导）复用；只读最新 attempt manifest，不调用 AI。
 */
export async function latestReviewGateStates(
  speccraftDir: string,
  runId: string,
  taskId: string,
): Promise<ReviewGateLatestState[]> {
  const plan = await readReviewPlanOrNull(speccraftDir, runId);
  if (!plan || !plan.enabled) return [];

  const states: ReviewGateLatestState[] = [];
  for (const gate of plan.gates) {
    const evidenceDir = reviewEvidenceDir(speccraftDir, runId, taskId, gate.id);
    const manifest = await readLatestReviewAttemptManifest(evidenceDir);
    if (!manifest) {
      states.push({ gateId: gate.id, decision: 'none', attempt: 0 });
      continue;
    }
    states.push({
      gateId: gate.id,
      decision: manifest.decision,
      attempt: manifest.attempt,
      ...(manifest.error_code ? { errorCode: manifest.error_code } : {}),
    });
  }
  return states;
}

/**
 * Check if current review plan is satisfied for a task（§72）。
 *
 * Each required gate must have:
 *   - decision = pass
 *   - source_dispatch_attempt == latest dispatch
 *   - source_verification_attempt == latest verification
 */
export async function isCurrentReviewSatisfied(
  speccraftDir: string,
  runId: string,
  taskId: string,
  latestDispatchAttempt: number,
  latestVerificationAttempt: number,
): Promise<{ satisfied: boolean; reason?: string }> {
  const plan = await readReviewPlanOrNull(speccraftDir, runId);
  if (!plan || !plan.enabled) {
    return { satisfied: true };
  }

  for (const gate of plan.gates) {
    const evidenceDir = reviewEvidenceDir(speccraftDir, runId, taskId, gate.id);
    const manifest = await readLatestReviewAttemptManifest(evidenceDir);
    if (!manifest) {
      return { satisfied: false, reason: `gate "${gate.id}" has no review attempt` };
    }

    if (manifest.decision !== 'pass') {
      return { satisfied: false, reason: `gate "${gate.id}" decision is ${manifest.decision}` };
    }

    // §71/§88：source attempts must match current dispatch/verification
    if (manifest.source_dispatch_attempt !== latestDispatchAttempt) {
      return {
        satisfied: false,
        reason: `gate "${gate.id}" source_dispatch_attempt (${manifest.source_dispatch_attempt}) != latest (${latestDispatchAttempt})`,
      };
    }
    if (manifest.source_verification_attempt !== latestVerificationAttempt) {
      return {
        satisfied: false,
        reason: `gate "${gate.id}" source_verification_attempt (${manifest.source_verification_attempt}) != latest (${latestVerificationAttempt})`,
      };
    }
  }

  return { satisfied: true };
}

/**
 * Build rework prompt section from review feedback（§84）。
 */
export function buildReviewFeedbackPrompt(feedback: ReviewFeedback): string {
  if (!feedback.hasBlockingFeedback && feedback.findings.length === 0) {
    return '';
  }

  const lines: string[] = [];
  lines.push('## Previous Review Findings');
  lines.push('');
  lines.push('Review findings are technical evidence,');
  lines.push('not permission to change approved Product/Design/Scope.');
  lines.push('Verify each finding against the actual codebase');
  lines.push('before implementing changes.');
  lines.push('');

  // Blocking findings (blocker/major) — rework core instructions
  const blocking = feedback.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major');
  if (blocking.length > 0) {
    lines.push('### Blocking Findings (must fix)');
    lines.push('');
    for (const f of blocking) {
      const loc = f.path ? (f.line ? `${f.path}:${f.line}` : f.path) : '(no path)';
      lines.push(`- [${f.severity}] (${f.gateId}) ${loc}: ${f.message}`);
    }
    lines.push('');
  }

  // Minor findings — informational
  const minor = feedback.findings.filter((f) => f.severity === 'minor');
  if (minor.length > 0) {
    lines.push('### Suggestions (optional)');
    lines.push('');
    for (const f of minor) {
      const loc = f.path ? (f.line ? `${f.path}:${f.line}` : f.path) : '(no path)';
      lines.push(`- [minor] (${f.gateId}) ${loc}: ${f.message}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Find latest review attempt manifest in evidence dir。
 */
async function readLatestReviewAttemptManifest(evidenceDir: string): Promise<import('./types.js').ReviewAttemptManifest | null> {
  let entries: string[] = [];
  try {
    entries = await readdir(evidenceDir);
  } catch {
    return null;
  }

  const attempts = entries
    .filter((e) => /^attempt-\d+$/.test(e))
    .sort()
    .reverse();

  if (attempts.length === 0) return null;

  return readReviewManifestOrNull(path.join(evidenceDir, attempts[0]));
}

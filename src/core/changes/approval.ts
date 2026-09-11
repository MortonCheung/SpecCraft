/**
 * Owner Approval（SpecCraft v0.9 §31–§33，ADR 0010）。
 *
 *   speccraft changes approve <change-id> --by <owner>
 *
 * Approval 只绑定 **latest complete Analysis Attempt** 的 digest（§32），
 * 一旦写入，Proposal / Resolution / Approved Analysis 全部 immutable（§34 由 proposal.ts 保证）。
 *
 * 两条硬门禁：
 *   §31 no-effect Change 必须拒绝进入 approval → `no_effect`
 *   §33 Analysis 之后 Proposal 被修改（即使文件名相同）→ `proposal_changed_since_analysis`
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { readChangeManifest, updateChangeStatus, changeDir, listAnalysisAttempts } from './store.js';
import { readAnalysisAttemptOrNull } from './analyze.js';
import type { AnalysisAttempt } from './analyze.js';
import { proposalBundleDigest } from './proposal.js';
import { ChangeError } from './types.js';

/** Change 目录下的 approval 文件名 */
export const APPROVAL_FILE = 'approval.yaml';

/** `.speccraft/changes/<change-id>/approval.yaml`（v0.9 §32） */
export interface Approval {
  change_id: string;
  analysis_attempt: string;
  analysis_bundle_sha256: string;
  impact_sha256: string;
  candidate_task_graph_digest: string | null;
  candidate_executor_plan_digest: string | null;
  candidate_review_plan_digest: string | null;
  approved_by: string;
  approved_at: string;
}

export function approvalPath(speccraftDir: string, changeId: string): string {
  return path.join(changeDir(speccraftDir, changeId), APPROVAL_FILE);
}

// ---------------------------------------------------------------------------
// 序列化 / 解析
// ---------------------------------------------------------------------------

export function stringifyApproval(approval: Approval): string {
  return yaml.dump(
    {
      change_id: approval.change_id,
      analysis_attempt: approval.analysis_attempt,
      analysis_bundle_sha256: approval.analysis_bundle_sha256,
      impact_sha256: approval.impact_sha256,
      candidate_task_graph_digest: approval.candidate_task_graph_digest,
      candidate_executor_plan_digest: approval.candidate_executor_plan_digest,
      candidate_review_plan_digest: approval.candidate_review_plan_digest,
      approved_by: approval.approved_by,
      approved_at: approval.approved_at,
    },
    { indent: 2, lineWidth: -1, noRefs: true },
  );
}

export function parseApproval(source: string): Approval {
  const loaded = yaml.load(source);
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error('approval.yaml 顶层必须是对象');
  }
  const obj = loaded as Record<string, unknown>;
  const changeId = readStr(obj.change_id ?? obj.changeId);
  if (!changeId) throw new Error('approval.yaml 缺少 change_id');
  const attempt = readStr(obj.analysis_attempt ?? obj.analysisAttempt);
  if (!attempt) throw new Error('approval.yaml 缺少 analysis_attempt');
  return {
    change_id: changeId,
    analysis_attempt: attempt,
    analysis_bundle_sha256:
      readStr(obj.analysis_bundle_sha256 ?? obj.analysisBundleSha256) ?? '',
    impact_sha256: readStr(obj.impact_sha256 ?? obj.impactSha256) ?? '',
    candidate_task_graph_digest: readStr(
      obj.candidate_task_graph_digest ?? obj.candidateTaskGraphDigest,
    ),
    candidate_executor_plan_digest: readStr(
      obj.candidate_executor_plan_digest ?? obj.candidateExecutorPlanDigest,
    ),
    candidate_review_plan_digest: readStr(
      obj.candidate_review_plan_digest ?? obj.candidateReviewPlanDigest,
    ),
    approved_by: readStr(obj.approved_by ?? obj.approvedBy) ?? '',
    approved_at: readStr(obj.approved_at ?? obj.approvedAt) ?? '',
  };
}

export async function readApprovalOrNull(
  speccraftDir: string,
  changeId: string,
): Promise<Approval | null> {
  const file = approvalPath(speccraftDir, changeId);
  if (!(await pathExists(file))) return null;
  return parseApproval(await readFile(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

export interface ApproveChangeOptions {
  speccraftDir: string;
  changeId: string;
  /** Owner 身份（§32 `--by <owner>`）；必须非空 */
  approvedBy: string;
  now?: Date;
}

export interface ApproveChangeResult {
  changeId: string;
  attempt: string;
  approval: Approval;
}

/**
 * Owner 批准一个 Change（§32）。
 *
 * 只接受 latest complete Analysis Attempt；写入 approval.yaml 并把 Change 迁移到 approved。
 */
export async function approveChange(options: ApproveChangeOptions): Promise<ApproveChangeResult> {
  const { speccraftDir, changeId } = options;
  const approvedBy = options.approvedBy.trim();
  if (!approvedBy) {
    throw new Error('changes approve 需要 --by <owner>（Owner 身份不能为空）');
  }

  const manifest = await readChangeManifest(speccraftDir, changeId);
  assertApprovable(manifest.status, changeId);

  // §32：只允许 latest complete Analysis Attempt
  const attempt = await latestCompleteAttempt(speccraftDir, changeId);

  // §31：no-effect Change 必须拒绝进入 approval
  if (attempt.no_effect) {
    throw new ChangeError(
      'no_effect',
      `Change ${changeId} 的 ${attempt.attempt} 未产生任何变化（no_effect），不可批准。`,
    );
  }

  // §33：Analysis 之后 Proposal 被修改 → 旧 Analysis 不能批准（即使文件名相同）
  const currentProposalDigest = await proposalBundleDigest(speccraftDir, changeId);
  if (currentProposalDigest !== attempt.proposal_digest) {
    throw new ChangeError(
      'proposal_changed_since_analysis',
      `Change ${changeId} 的 Proposal 在 ${attempt.attempt} 之后已被修改，` +
        `必须重新运行 speccraft changes analyze。`,
    );
  }

  const approval: Approval = {
    change_id: changeId,
    analysis_attempt: attempt.attempt,
    analysis_bundle_sha256: attempt.analysis_bundle_sha256 ?? '',
    impact_sha256: attempt.impact_sha256 ?? '',
    candidate_task_graph_digest: attempt.candidate.task_graph_digest,
    candidate_executor_plan_digest: attempt.candidate.executor_plan_digest,
    candidate_review_plan_digest: attempt.candidate.review_plan_digest,
    approved_by: approvedBy,
    approved_at: (options.now ?? new Date()).toISOString(),
  };

  await writeApproval(speccraftDir, changeId, approval);
  await updateChangeStatus(speccraftDir, manifest, 'approved');

  return { changeId, attempt: attempt.attempt, approval };
}

/** 只有 draft / analyzed 可以进入 approval（§32；rejected 与已批准状态直接失败） */
function assertApprovable(status: string, changeId: string): void {
  if (status === 'draft' || status === 'analyzed') return;
  if (status === 'rejected') {
    throw new ChangeError('change_rejected', `Change ${changeId} 已 rejected，不可批准。`);
  }
  throw new ChangeError(
    'change_already_approved',
    `Change ${changeId} 已处于 ${status}，不可重复批准。`,
  );
}

/**
 * 取 latest complete Analysis Attempt（§32）。
 *
 * 从最新 Attempt 向前找第一个 result = complete 的 Attempt；
 * 一个都没有 → `no_complete_analysis`。
 */
async function latestCompleteAttempt(
  speccraftDir: string,
  changeId: string,
): Promise<AnalysisAttempt> {
  const attempts = await listAnalysisAttempts(speccraftDir, changeId);
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i]!;
    const record = await readAnalysisAttemptOrNull(speccraftDir, changeId, attempt);
    if (record && record.result === 'complete') return record;
  }
  throw new ChangeError(
    'no_complete_analysis',
    `Change ${changeId} 没有 complete 的 Analysis Attempt，请先运行 speccraft changes analyze。`,
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function writeApproval(
  speccraftDir: string,
  changeId: string,
  approval: Approval,
): Promise<void> {
  await mkdir(changeDir(speccraftDir, changeId), { recursive: true });
  await writeFile(approvalPath(speccraftDir, changeId), stringifyApproval(approval), 'utf8');
}

function readStr(value: unknown): string | null {
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

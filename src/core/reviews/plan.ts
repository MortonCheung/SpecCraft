/**
 * Frozen Review Plan Builder（ADR 0009 §18）。
 *
 * Task Graph compile 时由 compiler 调用：
 *   buildFrozenReviewPlan({ runId, reviewConfig, projectAdapters, knownAdapters })
 * → ReviewPlan | null
 *
 * review disabled → null。
 * plan 一旦产生即 frozen；后续 dispatch / review evidence 存在时不重建。
 */

import type { ReviewConfig, ReviewPlan, FrozenReviewGate, ReviewerProfileConfig } from './types.js';
import type { ProjectAdapterConfig } from '../project.js';

export interface BuildReviewPlanOptions {
  runId: string;
  reviewConfig: ReviewConfig | null;
  projectAdapters: Record<string, ProjectAdapterConfig>;
  knownAdapters: Set<string>;
}

/**
 * 构建 frozen Review Plan。
 *
 * review disabled → null（不产生 plan）。
 */
export function buildFrozenReviewPlan(options: BuildReviewPlanOptions): ReviewPlan | null {
  const { runId, reviewConfig, projectAdapters, knownAdapters } = options;

  if (!reviewConfig || !reviewConfig.enabled) {
    return null;
  }

  const gates: FrozenReviewGate[] = [];
  for (const g of reviewConfig.gates) {
    const reviewerProfile = reviewConfig.reviewers[g.reviewer];
    if (!reviewerProfile) {
      throw new Error(`Review Plan 构建失败：gate "${g.id}" reviewer "${g.reviewer}" 不存在`);
    }

    const adapterId = reviewerProfile.adapter;
    if (!knownAdapters.has(adapterId)) {
      throw new Error(`Review Plan 构建失败：gate "${g.id}" adapter "${adapterId}" 未知`);
    }

    const resolved = mergeReviewerAdapterConfig(reviewerProfile, projectAdapters[adapterId]);

    gates.push({
      id: g.id,
      kind: g.kind,
      reviewer: g.reviewer,
      adapter: adapterId,
      resolved,
    });
  }

  const now = new Date().toISOString();
  return {
    version: 1,
    run_id: runId,
    enabled: true,
    created_at: now,
    gates,
  };
}

/** Reviewer Profile override → Adapter config → defaults */
function mergeReviewerAdapterConfig(
  profile: ReviewerProfileConfig,
  adapterConfig: ProjectAdapterConfig | undefined,
): FrozenReviewGate['resolved'] {
  const timeout_seconds =
    profile.timeout_seconds ??
    adapterConfig?.timeout_seconds ??
    900;
  const resolved: FrozenReviewGate['resolved'] = { timeout_seconds };
  if (profile.model) resolved.model = profile.model;
  else if (adapterConfig?.model) resolved.model = adapterConfig.model;
  if (profile.extra_args) resolved.extra_args = [...profile.extra_args];
  else if (adapterConfig?.extra_args) resolved.extra_args = [...adapterConfig.extra_args];
  if (profile.sandbox) resolved.sandbox = profile.sandbox;
  else if (adapterConfig?.sandbox) resolved.sandbox = adapterConfig.sandbox;
  return resolved;
}

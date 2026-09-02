/**
 * Review Diagnostics — reviews list / reviews plan / reviews doctor / reviews show（§27-§31）。
 */

import { access, readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { runDir } from '../execution/store.js';
import { tasksDir } from '../tasks/store.js';
import { readReviewPlanOrNull } from './store.js';
import { getAdapter } from '../execution/adapters/registry.js';
import type { ReviewPlan, ReviewAttemptManifest } from './types.js';

export interface ReviewsListResult {
  enabled: boolean;
  gates: { id: string; kind: string; reviewer: string; adapter: string }[];
  reviewerProfiles: Record<string, { adapter: string; timeout?: number }>;
}

export async function reviewsList(speccraftDir: string): Promise<ReviewsListResult | null> {
  const plan = await readReviewPlanOrNull(speccraftDir, '__latest__');
  return null;
}

export function reviewsListFromPlan(plan: ReviewPlan | null): ReviewsListResult {
  if (!plan || !plan.enabled) {
    return { enabled: false, gates: [], reviewerProfiles: {} };
  }
  const profiles: Record<string, { adapter: string; timeout?: number }> = {};
  for (const g of plan.gates) {
    if (!profiles[g.reviewer]) {
      profiles[g.reviewer] = { adapter: g.adapter, timeout: g.resolved.timeout_seconds };
    }
  }
  return {
    enabled: true,
    gates: plan.gates.map((g) => ({ id: g.id, kind: g.kind, reviewer: g.reviewer, adapter: g.adapter })),
    reviewerProfiles: profiles,
  };
}

export interface ReviewsPlanResult {
  runId: string;
  enabled: boolean;
  gates: { id: string; kind: string; reviewer: string; adapter: string; timeout: number }[];
}

export function reviewsPlanFromPlan(plan: ReviewPlan | null): ReviewsPlanResult {
  if (!plan || !plan.enabled) {
    return { runId: '', enabled: false, gates: [] };
  }
  return {
    runId: plan.run_id,
    enabled: true,
    gates: plan.gates.map((g) => ({
      id: g.id, kind: g.kind, reviewer: g.reviewer, adapter: g.adapter, timeout: g.resolved.timeout_seconds,
    })),
  };
}

export interface ReviewDiagnosticItem {
  adapter: string;
  installed: boolean;
  version?: string;
  error?: string;
}

export async function reviewsDoctor(plan: ReviewPlan): Promise<ReviewDiagnosticItem[]> {
  const uniqueAdapters = new Set(plan.gates.map((g) => g.adapter));
  const items: ReviewDiagnosticItem[] = [];

  for (const adapterId of uniqueAdapters) {
    const adapter = getAdapter(adapterId);
    if (!adapter || adapter.kind === 'manual') {
      items.push({ adapter: adapterId, installed: false, error: 'not available for auto-review' });
      continue;
    }
    try {
      const probe = await adapter.probe();
      items.push({
        adapter: adapterId,
        installed: probe.installed,
        version: probe.version,
        error: probe.error,
      });
    } catch (err: any) {
      items.push({ adapter: adapterId, installed: false, error: err.message });
    }
  }
  return items;
}

export interface TaskReviewSummary {
  taskId: string;
  gates: {
    gateId: string;
    attempts: number;
    latestDecision?: string;
    reviewer?: string;
    adapter?: string;
    findingCount?: number;
    blockingFindings?: number;
  }[];
}

export async function reviewsShow(
  speccraftDir: string,
  runId: string,
  taskId: string,
): Promise<TaskReviewSummary> {
  const taskReviewDir = path.join(tasksDir(speccraftDir, runId), taskId, 'reviews');
  const result: TaskReviewSummary = { taskId, gates: [] };

  if (!(await pathExists(taskReviewDir))) return result;

  const gateEntries = await readdir(taskReviewDir, { withFileTypes: true });
  for (const gateEntry of gateEntries) {
    if (!gateEntry.isDirectory()) continue;
    const gateDir = path.join(taskReviewDir, gateEntry.name);
    const attempts = await readdir(gateDir, { withFileTypes: true });
    const attemptDirs = attempts
      .filter((a) => a.isDirectory() && /^attempt-\d+$/.test(a.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    let latestManifest: ReviewAttemptManifest | null = null;
    for (const ad of attemptDirs) {
      const manifestPath = path.join(gateDir, ad.name, 'manifest.yaml');
      if (await pathExists(manifestPath)) {
        try {
          const content = await readFile(manifestPath, 'utf8');
          latestManifest = JSON.parse(content) as ReviewAttemptManifest;
        } catch { /* skip malformed */ }
      }
    }

    result.gates.push({
      gateId: gateEntry.name,
      attempts: attemptDirs.length,
      ...(latestManifest ? {
        latestDecision: latestManifest.decision,
        reviewer: latestManifest.reviewer_profile,
        adapter: latestManifest.adapter,
        findingCount: latestManifest.finding_count,
        blockingFindings: latestManifest.blocking_findings,
      } : {}),
    });
  }

  return result;
}

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

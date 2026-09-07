/**
 * Review Preflight Gate（ADR 0009 §22-§26）。
 *
 * Review enabled 时必须在 implementStart / workspace creation / Task mutation
 * 以前完成 Review Preflight：
 *   load frozen Review Plan → collect unique adapters → probe each adapter ONCE
 *   → capability validation → PASS / FAIL
 *
 * manual reviewer 不能自动执行（§24）。
 * adapter unavailable → preflight FAIL（§25）。
 * capability guard（§26）：model 声明但 adapter 不支持 modelSelection → FAIL。
 */

import { spawnSync } from 'node:child_process';
import { getAdapter } from '../execution/adapters/registry.js';
import type { AdapterProbeResult } from '../execution/adapters/types.js';
import { readReviewPlanOrNull } from './store.js';
import type { ReviewPlan, FrozenReviewGate } from './types.js';

export interface ReviewPreflightResult {
  status: 'pass' | 'blocked';
  reason?: string;
  items: ReviewPreflightItem[];
}

export interface ReviewPreflightItem {
  adapter: string;
  installed: boolean;
  version?: string;
  capabilities?: { invoke: boolean; resume: boolean; structuredOutput: boolean; modelSelection: boolean };
  error?: string;
}

/**
 * Review Preflight Gate。
 * review disabled → pass（无 items）。
 */
export async function preflightReviewPlan(
  speccraftDir: string,
  runId: string,
): Promise<ReviewPreflightResult> {
  const plan = await readReviewPlanOrNull(speccraftDir, runId);
  if (!plan || !plan.enabled) {
    return { status: 'pass', items: [] };
  }
  return preflightReviewPlanWithPlan(plan);
}

export async function preflightReviewPlanWithPlan(plan: ReviewPlan): Promise<ReviewPreflightResult> {
  if (!plan.enabled) return { status: 'pass', items: [] };

  const uniqueAdapters = new Set<string>();
  for (const gate of plan.gates) {
    uniqueAdapters.add(gate.adapter);
  }

  const items: ReviewPreflightItem[] = [];
  let blocked = false;
  let reason: string | undefined;

  for (const adapterId of uniqueAdapters) {
    if (adapterId === 'manual') {
      blocked = true;
      reason = 'manual reviewer cannot run automatic review gates';
      items.push({ adapter: adapterId, installed: false, error: reason });
      continue;
    }

    const adapter = getAdapter(adapterId);
    if (!adapter) {
      blocked = true;
      const msg = `reviewer adapter "${adapterId}" not registered`;
      if (!reason) reason = msg;
      items.push({ adapter: adapterId, installed: false, error: msg });
      continue;
    }

    if (adapter.kind === 'manual') {
      blocked = true;
      const msg = `reviewer adapter "${adapterId}" is manual, cannot auto-execute`;
      if (!reason) reason = msg;
      items.push({ adapter: adapterId, installed: false, error: msg });
      continue;
    }

    let probe: AdapterProbeResult;
    try {
      probe = await adapter.probe();
    } catch (err: any) {
      blocked = true;
      const msg = `reviewer adapter "${adapterId}" probe failed: ${err.message}`;
      if (!reason) reason = msg;
      items.push({ adapter: adapterId, installed: false, error: msg });
      continue;
    }

    if (!probe.installed) {
      blocked = true;
      const msg = probe.error ?? `reviewer adapter "${adapterId}" not installed`;
      if (!reason) reason = msg;
      items.push({ adapter: adapterId, installed: false, error: msg });
      continue;
    }

    const item: ReviewPreflightItem = {
      adapter: adapterId,
      installed: true,
      version: probe.version,
    };
    if (probe.capabilities) {
      item.capabilities = {
        invoke: probe.capabilities.invoke,
        resume: probe.capabilities.resume,
        structuredOutput: probe.capabilities.structuredOutput,
        modelSelection: probe.capabilities.modelSelection,
      };
    }

    if (adapter.kind === 'cli' && !probe.capabilities?.invoke) {
      blocked = true;
      const msg = `reviewer adapter "${adapterId}" does not support invoke`;
      if (!reason) reason = msg;
      item.error = msg;
    }

    items.push(item);
  }

  for (const gate of plan.gates) {
    const gateItems = items.filter((i) => i.adapter === gate.adapter);
    const item = gateItems[0];
    if (!item || !item.installed) continue;

    if (gate.resolved.model && item.capabilities && !item.capabilities.modelSelection) {
      blocked = true;
      const msg = `gate "${gate.id}" declares model but adapter "${gate.adapter}" does not support modelSelection`;
      if (!reason) reason = msg;
      item.error = msg;
    }
  }

  return {
    status: blocked ? 'blocked' : 'pass',
    ...(reason !== undefined ? { reason } : {}),
    items,
  };
}

export function formatReviewPreflightBlocked(result: ReviewPreflightResult): string {
  const lines: string[] = [`Review Preflight BLOCKED：${result.reason ?? 'unknown'}`];
  for (const item of result.items) {
    if (item.error) {
      lines.push(`  - ${item.adapter}: ${item.error}`);
    }
  }
  return lines.join('\n');
}

export interface GitReadinessResult {
  ok: boolean;
  error?: string;
}

/**
 * §8/§8.1：Git Readiness —— v0.8 Review 要求 Git repository + resolvable HEAD。
 *
 * Review enabled 项目在 implementStart / Task status mutation / Dispatch Attempt /
 * Workspace creation / Review workspace creation 之前必须通过本检查；
 * non-Git 项目 → blocked（fail-before-mutation，不产生任何 evidence / 状态变更）。
 *
 * 与 snapshot 需求一致：
 *   git rev-parse --is-inside-work-tree
 *   git rev-parse HEAD（可解析）
 */
export function checkReviewGitReadiness(projectRoot: string): GitReadinessResult {
  const inWorkTree = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (inWorkTree.status !== 0 || String(inWorkTree.stdout ?? '').trim() !== 'true') {
    return { ok: false, error: 'review preflight blocked: project is not inside a Git work tree（v0.8 review requires Git repository）' };
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
  if (head.status !== 0 || String(head.stdout ?? '').trim().length !== 40) {
    return { ok: false, error: 'review preflight blocked: no resolvable HEAD（v0.8 review requires committed baseline）' };
  }
  return { ok: true };
}

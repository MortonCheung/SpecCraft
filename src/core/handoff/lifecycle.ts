/**
 * Handoff 生命周期（ADR 0004 §6）。
 *
 * Handoff Guard：active run 存在 + verification completed + 最新 verification PASS
 * + owner-acceptance completed + 最新 acceptance accepted + run.status accepted。
 *
 * 幂等：同一已 accepted 且无状态变化的 Run 重复 handoff 返回现有包、exit 0。
 * terminal Run 不阻塞未来 prepare（历史 Run 仍可查询、不删除）。
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Workflow, State } from '../types.js';
import { setStageStatus, writeState } from '../state/store.js';
import { writeRun } from '../execution/store.js';
import type { ExecutionRunManifest } from '../execution/types.js';
import { readLatestAcceptance } from '../acceptance/store.js';
import { compileHandoffPackage } from './package.js';

export interface HandoffResult {
  handoffId: string;
  /** 本次是新建还是复用已有包 */
  reused: boolean;
}

/** handoff 是否允许（Guard） */
export async function canHandoff(
  speccraftDir: string,
  state: State,
  run: ExecutionRunManifest | null,
): Promise<{ ok: boolean; reason?: string }> {
  if (!run) return { ok: false, reason: '没有活跃的 Execution Run' };
  if (state.stages['verification']?.status !== 'completed') {
    return { ok: false, reason: 'verification 尚未 completed' };
  }
  if (state.stages['owner-acceptance']?.status !== 'completed') {
    return { ok: false, reason: 'owner-acceptance 尚未 completed' };
  }
  if (run.status !== 'accepted') {
    return { ok: false, reason: `run.status 为 ${run.status}，不是 accepted` };
  }
  const latest = await readLatestAcceptance(speccraftDir, run.id);
  if (!latest || latest.frontmatter.decision !== 'accepted') {
    return { ok: false, reason: '最新 acceptance 不是 accepted' };
  }
  return { ok: true };
}

/** 计算下一个 handoff 序号目录名（handoff-001/002/...） */
export async function nextHandoffId(speccraftDir: string): Promise<string> {
  const dir = path.join(speccraftDir, 'handoffs');
  let existing: string[] = [];
  try {
    existing = (await readdir(dir)).filter((f) => /^handoff-\d+$/.test(f));
  } catch {
    existing = [];
  }
  const nums = existing.map((f) => Number(f.replace('handoff-', ''))).sort((a, b) => a - b);
  const next = nums.length > 0 ? nums[nums.length - 1] + 1 : 1;
  return `handoff-${String(next).padStart(3, '0')}`;
}

/** speccraft handoff：编译 Handoff Package 并推进终态（幂等） */
export async function handoff(
  speccraftDir: string,
  projectRoot: string,
  projectName: string,
  workflow: Workflow,
  state: State,
  run: ExecutionRunManifest,
  now: Date = new Date(),
): Promise<HandoffResult> {
  // 幂等：已 handed_off 且有 handoffId → 返回现有包
  if (run.status === 'handed_off' && run.handoffId) {
    return { handoffId: run.handoffId, reused: true };
  }

  const gate = await canHandoff(speccraftDir, state, run);
  if (!gate.ok) throw new Error(`handoff 被拒绝：${gate.reason}`);

  const handoffId = await nextHandoffId(speccraftDir);
  await compileHandoffPackage({
    speccraftDir,
    projectRoot,
    projectName,
    workflow,
    run,
    handoffId,
    createdAt: now.toISOString(),
  });

  // 终态推进
  setStageStatus(state, 'handoff', 'completed');
  state.current_stage = 'handoff';
  run.status = 'handed_off';
  run.handoffId = handoffId;
  run.handoffAt = now.toISOString();
  await writeRun(speccraftDir, run);
  await writeState(speccraftDir, state);

  return { handoffId, reused: false };
}

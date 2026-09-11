/**
 * Run Mutation Guards（SpecCraft v0.9 §13、§41，ADR 0010）。
 *
 * 两条硬规则：
 *   §13 Active Change Freeze：base Run 存在 active Change（draft/analyzed/approved/materialized）
 *       时，禁止继续产生新的施工 Evidence → `run_change_pending`；
 *   §41 Superseded Run Guard：materialization 成功后的 predecessor Run 永久不可 mutation
 *       → `run_superseded`（并指向 successor_run）。
 *
 * 只读操作（status / show / evidence inspection）不受此模块影响。
 */

import { findActiveChangeForRun } from './store.js';
import { readRunSupersessionOrNull } from './lineage.js';
import { ChangeError } from './types.js';

/**
 * 断言一个 Run 仍可产生 mutation evidence。
 *
 * 顺序：先判 supersession（永久终态），再判 active Change（可用 reject 解除）。
 */
export async function assertRunMutable(speccraftDir: string, runId: string): Promise<void> {
  const supersession = await readRunSupersessionOrNull(speccraftDir, runId);
  if (supersession) {
    throw new ChangeError(
      'run_superseded',
      `Run ${runId} has been superseded by ${supersession.successor_run}.\n` +
        `Run ${supersession.successor_run} is the current execution target.`,
    );
  }

  const active = await findActiveChangeForRun(speccraftDir, runId);
  if (active) {
    throw new ChangeError(
      'run_change_pending',
      `Run ${runId} has active Change Set ${active.id}.\n` +
        `Resolve or reject the Change Set before continuing this Run.`,
    );
  }
}

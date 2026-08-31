/**
 * Parallel Store（ADR 0007 §13.6）。
 *
 * 负责把 planner 结果持久化为 Wave Manifest：
 *   开始前落盘：wave / base commit / maxParallel / tasks / startedAt / scope summary
 *   结束后补写：finishedAt / results / integrationOrder
 *
 * 底层复用 src/core/workspaces/store.ts 的 WaveManifest 读写，
 * 不建立第二套 Wave 存储。
 */

import { nextWave, readWaveManifest, writeWaveManifest } from '../workspaces/store.js';
import type { WaveManifest } from '../workspaces/types.js';
import type { WavePlan } from './types.js';

export interface SaveWaveStartOptions {
  speccraftDir: string;
  runId: string;
  plan: WavePlan;
  /** wave 开始时的 canonical base commit */
  baseCommit: string;
  now?: Date;
}

/**
 * 开始一个 wave：分配递增序号（max(existing) + 1），落盘初始 manifest（append-only 起点）。
 * 返回已落盘的 WaveManifest（wave 已填充真实序号）。
 */
export async function saveWaveStart(options: SaveWaveStartOptions): Promise<WaveManifest> {
  const wave = await nextWave(options.speccraftDir, options.runId);
  const manifest: WaveManifest = {
    wave,
    baseCommit: options.baseCommit,
    maxParallel: options.plan.maxParallel,
    tasks: [...options.plan.tasks],
    startedAt: options.now?.toISOString() ?? new Date().toISOString(),
    // integration order = Task Graph 声明顺序（wave.tasks 本身就是声明顺序）
    integrationOrder: [...options.plan.tasks],
    results: [],
  };
  await writeWaveManifest(options.speccraftDir, options.runId, manifest);
  return manifest;
}

export interface SaveWaveFinishOptions {
  speccraftDir: string;
  runId: string;
  wave: number;
  results: WaveManifest['results'];
  now?: Date;
}

/** 结束一个 wave：补写 finishedAt + results（integrationOrder 在 start 已固定） */
export async function saveWaveFinish(options: SaveWaveFinishOptions): Promise<WaveManifest> {
  const manifest = await readWaveManifest(options.speccraftDir, options.runId, options.wave);
  if (!manifest) {
    throw new Error(`wave manifest 不存在：wave-${options.wave}`);
  }
  manifest.results = [...options.results];
  manifest.finishedAt = options.now?.toISOString() ?? new Date().toISOString();
  await writeWaveManifest(options.speccraftDir, options.runId, manifest);
  return manifest;
}

export { readWaveManifest, nextWave };

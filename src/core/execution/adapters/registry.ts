/**
 * Adapter Registry（ADR 0005 §2）。
 *
 * Runtime 不再 switch(adapter === ...)，统一通过 registry 获取。
 * 显式注册、确定性、无动态 plugin loader、无网络发现。
 */

import type { ExecutionAdapter, AdapterProbeResult } from './types.js';
import { manualAdapter } from './manual.js';
import { codexAdapter } from './codex.js';
import { claudeAdapter } from './claude.js';
import { opencodeAdapter } from './opencode.js';
import { traeAdapter } from './trae.js';

const adapters = new Map<string, ExecutionAdapter>();

/** 注册一个 adapter（幂等：重复注册同名会覆盖） */
export function registerAdapter(adapter: ExecutionAdapter): void {
  adapters.set(adapter.id, adapter);
}

/** 获取 adapter；未知 id 返回 undefined（由调用方决定报错策略） */
export function getAdapter(id: string): ExecutionAdapter | undefined {
  return adapters.get(id);
}

/** 列出全部已注册 adapter id（按注册顺序，确定性） */
export function listAdapterIds(): string[] {
  return [...adapters.keys()];
}

/** 列出全部已注册 adapter */
export function listAdapters(): ExecutionAdapter[] {
  return [...adapters.values()];
}

/** 显式注册内置 adapter（registry 初始化入口） */
export function registerBuiltinAdapters(): void {
  registerAdapter(manualAdapter);
  registerAdapter(codexAdapter);
  registerAdapter(claudeAdapter);
  registerAdapter(opencodeAdapter);
  registerAdapter(traeAdapter);
}

/** 注册表是否已有该 adapter */
export function hasAdapter(id: string): boolean {
  return adapters.has(id);
}

/** 校验 adapter id 合法（避免意外注入） */
export function isValidAdapterId(id: string): boolean {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(id);
}

export type { AdapterProbeResult };

// 模块加载时初始化内置 adapter（幂等）
registerBuiltinAdapters();

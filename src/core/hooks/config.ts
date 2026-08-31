/**
 * Hook 配置解析（ADR 0005 §10）。
 *
 * 从 project.yaml 解析 hooks 配置，只支持 id / command / timeout_seconds。
 */

import type { HookConfig, HookDefinition, HookEvent } from './types.js';
import { isHookEvent } from './types.js';

/** 解析 project.yaml 的 hooks 段；缺省返回空配置 */
export function parseHookConfig(value: unknown): HookConfig {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('project.yaml 的 hooks 必须是对象');
  }
  const obj = value as Record<string, unknown>;
  const config: HookConfig = {};

  for (const [event, rawHooks] of Object.entries(obj)) {
    if (!isHookEvent(event)) {
      throw new Error(`未知 hook 事件：${event}`);
    }
    if (rawHooks === undefined || rawHooks === null) continue;
    if (!Array.isArray(rawHooks)) {
      throw new Error(`hooks.${event} 必须是数组`);
    }
    const defs: HookDefinition[] = [];
    for (const raw of rawHooks) {
      if (typeof raw !== 'object' || raw === null) continue;
      const h = raw as Record<string, unknown>;
      const id = typeof h.id === 'string' && h.id ? h.id : '';
      if (!id) throw new Error(`hooks.${event} 中存在缺少 id 的 hook`);
      const command = typeof h.command === 'string' && h.command.trim() ? h.command.trim() : '';
      if (!command) throw new Error(`hook ${id} 缺少 command`);
      const def: HookDefinition = { id, command };
      if (h.timeout_seconds !== undefined) {
        if (typeof h.timeout_seconds !== 'number' || h.timeout_seconds <= 0) {
          throw new Error(`hook ${id} 的 timeout_seconds 必须是正数`);
        }
        def.timeout_seconds = h.timeout_seconds;
      }
      defs.push(def);
    }
    config[event as HookEvent] = defs;
  }
  return config;
}

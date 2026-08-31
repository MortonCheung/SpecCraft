/**
 * Scope Engine（ADR 0006 §6、ADR 0007 §10）。
 *
 * v0.5 只建立确定性 Scope model；v0.6 起它同时是并行安全边界。
 * 因此去掉「basename 含 . 即文件」的不安全启发式，改为纯路径规则：
 *   - `directory/**`（或 `directory/*`）→ 目录范围；
 *   - 无 glob 后缀 → 精确路径。
 *
 * 保守原则：无法证明两个 scope 不重叠，一律视为冲突。
 */

import type { TaskScope } from './types.js';

/** 归一化 scope path：./foo → foo，\ → /，去除空段与 . 段 */
export function normalizeScopePath(p: string): string {
  const parts = p.trim().split(/[\\/]/).filter((s) => s.length > 0 && s !== '.');
  return parts.join('/');
}

/** 一个 scope 是否覆盖到 repo 内（拒绝绝对路径 / ..） */
export function isValidScopePath(p: string): boolean {
  if (!p.trim()) return false;
  if (p.startsWith('/')) return false;
  const parts = p.split(/[\\/]/);
  return !parts.includes('..');
}

/** 去掉尾部 /* 或 /** glob 后缀，得到目录/精确前缀 */
function stripGlobSuffix(p: string): string {
  return p.replace(/\/\*\*?$/, '');
}

/** 判断 scope path 是否为目录型（尾缀 /* 或 /**） */
function isGlobDirectory(p: string): boolean {
  return /\/\*\*?$/.test(p);
}

/**
 * 两个 scope path 是否可能重叠（保守）。
 * strip glob 后缀后：相等，或互为路径前缀（一方是另一方目录下）→ 视为重叠。
 * 绝不依靠「扩展名」猜测文件/目录。
 */
export function scopesOverlap(a: string, b: string): boolean {
  const na = normalizeScopePath(a);
  const nb = normalizeScopePath(b);
  const da = stripGlobSuffix(na);
  const db = stripGlobSuffix(nb);
  if (da === db) return true;
  if (da.startsWith(db + '/') || db.startsWith(da + '/')) return true;
  return false;
}

/**
 * 两个 Task 的 scope 是否兼容（所有 path pair 都能证明不重叠）。
 * 只要存在一个重叠的 path pair 即返回 false（conflict）。
 */
export function scopesCompatible(a: TaskScope, b: TaskScope): boolean {
  for (const pa of a.paths) {
    for (const pb of b.paths) {
      if (scopesOverlap(pa, pb)) return false;
    }
  }
  return true;
}

/**
 * 单个实际变更路径是否落在单个 declared scope path 内（保守 subset）。
 * - 目录 scope（/* 或 /** 尾缀）：覆盖该目录本身及其下所有路径；
 * - 精确 scope（无 glob）：只覆盖完全相等的路径（不猜测目录）。
 */
export function pathMatchesScope(actualPath: string, scopePath: string): boolean {
  const na = normalizeScopePath(actualPath);
  const ns = normalizeScopePath(scopePath);
  if (!na) return false;
  if (isGlobDirectory(ns)) {
    const dir = stripGlobSuffix(ns);
    return na === dir || na.startsWith(dir + '/');
  }
  return na === ns;
}
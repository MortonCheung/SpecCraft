/**
 * Scope Engine（ADR 0006 §6）。
 *
 * v0.5 不并行，但建立确定性 Scope model 供 v0.6 用。
 * 保守规则：无法证明两个 scope 不重叠就认为冲突，不自动猜。
 */

/** 归一化 scope path：./foo → foo，\ → / */
export function normalizeScopePath(p: string): string {
  const parts = p.trim().split(/[\\/]/).filter((s) => s.length > 0 && s !== '.');
  return parts.join('/');
}

/** 一个 scope 是否覆盖到 repo 内（拒绝绝对路径 / .. 已在 compiler 做，这里防御性再查） */
export function isValidScopePath(p: string): boolean {
  if (!p.trim()) return false;
  if (p.startsWith('/')) return false;
  const parts = p.split(/[\\/]/);
  return !parts.includes('..');
}

/**
 * 两个 scope 是否可能重叠（保守）。
 * - 相同即重叠；
 * - 一个为目录（无扩展名或尾部 /**），另一个在其下 → 重叠；
 * - 一个为文件，另一个为目录包含它 → 重叠；
 * - 无法证明不重叠 → 认为重叠（保守）。
 */
export function scopesOverlap(a: string, b: string): boolean {
  const na = normalizeScopePath(a);
  const nb = normalizeScopePath(b);
  if (na === nb) return true;

  // 目录判定：去掉尾部 /** 或判断是否有扩展名（简单启发式：含 . 视为文件）
  const dirA = stripGlob(na);
  const dirB = stripGlob(nb);
  const isFileA = looksLikeFile(na);
  const isFileB = looksLikeFile(nb);

  // 目录-目录：一方是另一方前缀 → 重叠
  if (!isFileA && !isFileB) {
    return dirA.startsWith(dirB + '/') || dirB.startsWith(dirA + '/');
  }
  // 文件-文件：完全相同才重叠（上面已处理相同）
  if (isFileA && isFileB) return false;
  // 文件-目录：目录是文件的前缀 → 重叠
  const file = isFileA ? dirA : dirB;
  const dir = isFileA ? dirB : dirA;
  return file.startsWith(dir + '/');
}

/** 去掉尾部 /** 与 * 通配 */
function stripGlob(p: string): string {
  return p.replace(/\/\*\*?$/, '').replace(/\/\*$/, '');
}

/** 简单启发式：含扩展名视为文件，否则目录 */
function looksLikeFile(p: string): boolean {
  const base = p.split('/').pop() ?? p;
  return base.includes('.') && !base.endsWith('/**');
}

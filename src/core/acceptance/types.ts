/**
 * Owner Acceptance 领域类型（ADR 0004 §5）。
 *
 * Acceptance 是「人类验收权威」的显式决策链，与机器验证严格区分。
 * decision 只有两种：accepted | rejected（不制造无意义状态）。
 */

/** Owner 决策 */
export type AcceptanceDecision = 'accepted' | 'rejected';

/** Acceptance Record 的 YAML Frontmatter */
export interface AcceptanceFrontmatter {
  kind: 'owner-acceptance';
  run_id: string;
  attempt: number;
  decision: AcceptanceDecision;
  owner: string;
  created_at: string;
  /** 关联的 verification attempt（真实存在的历史事实） */
  verification_attempt: number;
  verification_status: string;
  /** 关联的 Git commit（如存在） */
  git_commit?: string;
}

/** 解析后的 Acceptance Record（frontmatter + 正文） */
export interface AcceptanceRecord {
  frontmatter: AcceptanceFrontmatter;
  body: string;
  /** 相对 run 目录的文件名，如 acceptance/acceptance-001.md */
  filename: string;
}

/** 校验值是否为合法 AcceptanceDecision */
export function isAcceptanceDecision(value: unknown): value is AcceptanceDecision {
  return value === 'accepted' || value === 'rejected';
}

/** attempt 序号 → 三零填充文件名（1 → 001） */
export function acceptanceFileName(attempt: number): string {
  return `acceptance-${String(attempt).padStart(3, '0')}.md`;
}

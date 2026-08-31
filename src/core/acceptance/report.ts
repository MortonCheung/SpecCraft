/**
 * Acceptance Record 渲染（ADR 0004 §5）。
 *
 * Markdown + YAML Frontmatter。只做确定性渲染与解析，不涉及状态机。
 */

import yaml from 'js-yaml';
import type { AcceptanceFrontmatter, AcceptanceRecord } from './types.js';
import { isAcceptanceDecision } from './types.js';

/** 由 frontmatter + body 渲染 Acceptance Record 文本 */
export function stringifyAcceptanceRecord(fm: AcceptanceFrontmatter, body: string): string {
  const dumped = yaml.dump(fm, { indent: 2, lineWidth: -1, noRefs: true });
  return `---\n${dumped}---\n\n${body}`;
}

/** 解析 Acceptance Record 文本（校验 decision / kind） */
export function parseAcceptanceRecord(source: string): AcceptanceRecord {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    throw new Error('acceptance record 缺少 YAML frontmatter（文件需以 --- 开头）');
  }
  const raw = yaml.load(match[1]);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('acceptance record frontmatter 必须是对象');
  }
  const obj = raw as Record<string, unknown>;

  if (obj.kind !== 'owner-acceptance') {
    throw new Error('acceptance record 的 kind 必须为 owner-acceptance');
  }
  const run_id = typeof obj.run_id === 'string' ? obj.run_id : '';
  if (!run_id) throw new Error('acceptance record 缺少 run_id');
  const attempt = typeof obj.attempt === 'number' && obj.attempt >= 1 ? obj.attempt : 0;
  if (attempt < 1) throw new Error('acceptance record 的 attempt 必须是正整数');
  if (!isAcceptanceDecision(obj.decision)) {
    throw new Error(`acceptance record 的 decision 非法: ${String(obj.decision)}`);
  }
  const owner = typeof obj.owner === 'string' && obj.owner ? obj.owner : 'owner';
  const created_at = typeof obj.created_at === 'string' ? obj.created_at : '';
  const verification_attempt =
    typeof obj.verification_attempt === 'number' ? obj.verification_attempt : 0;
  const verification_status =
    typeof obj.verification_status === 'string' ? obj.verification_status : '';

  const frontmatter: AcceptanceFrontmatter = {
    kind: 'owner-acceptance',
    run_id,
    attempt,
    decision: obj.decision,
    owner,
    created_at,
    verification_attempt,
    verification_status,
  };
  if (typeof obj.git_commit === 'string' && obj.git_commit) {
    frontmatter.git_commit = obj.git_commit;
  }

  return { frontmatter, body: source.slice(match[0].length), filename: '' };
}

/** 渲染 Acceptance Record 正文（decision + feedback） */
export function renderAcceptanceBody(decision: string, feedback: string): string {
  return [
    `# Owner Acceptance`,
    '',
    `## Decision`,
    '',
    decision.toUpperCase(),
    '',
    `## Feedback`,
    '',
    feedback.trim() || '（无）',
    '',
  ].join('\n');
}

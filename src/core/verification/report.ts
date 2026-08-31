/**
 * Verification 报告渲染（ADR 0003 §6）。
 *
 * verification.md 只保留摘要与 log 路径，不塞入大型 stdout。
 */

import type { VerificationAttempt } from './types.js';

/** 渲染 verification.md 正文（history 来自全部 attempt 记录） */
export function renderVerificationArtifact(
  runId: string,
  attempt: VerificationAttempt,
  history: { attempt: number; passed: boolean; finishedAt: string }[],
): string {
  const lines: string[] = [];
  lines.push(`# Verification`);
  lines.push('');
  lines.push(`Run: ${runId}`);
  lines.push(`Attempt: ${attempt.attempt}`);
  lines.push(`Verified at: ${attempt.finishedAt}`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`PASS`);
  lines.push('');
  lines.push(`## Commands`);
  lines.push('');
  lines.push('| Command | Exit | Duration | Log |');
  lines.push('| --- | --- | --- | --- |');
  for (const c of attempt.commands) {
    const exit = c.exitCode !== undefined ? String(c.exitCode) : c.reason ?? '-';
    lines.push(`| \`${c.command}\` | ${exit} | ${c.durationMs}ms | ${c.log} |`);
  }
  lines.push('');
  lines.push(`## Result`);
  lines.push('');
  lines.push(`All configured verification commands passed.`);
  lines.push('');

  if (history.length > 0) {
    lines.push(`## History`);
    lines.push('');
    for (const h of history) {
      lines.push(`- attempt ${h.attempt}: ${h.passed ? 'PASS' : 'FAIL'}（${h.finishedAt}）`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

/**
 * CLI Adapter 共享 helper（ADR 0005）。
 *
 * 只做本机能力探测（binary / version），绝不发送 AI 请求、不消耗 Token。
 * 被 codex / claude / opencode / trae adapter 复用，避免重复实现。
 */

import { spawn } from 'node:child_process';

export interface ProbeBinaryResult {
  installed: boolean;
  version?: string;
  error?: string;
}

/** 探测 binary 是否存在并读取 --version（只读，不发 AI 请求） */
export function probeBinary(command: string): Promise<ProbeBinaryResult> {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let spawnError: string | null = null;

    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      spawnError = err.message;
    });
    child.on('close', (code) => {
      if (spawnError) {
        resolve({ installed: false, error: spawnError });
      } else if (code === 0) {
        const version = (stdout + stderr).trim().split('\n')[0] || undefined;
        resolve({ installed: true, ...(version ? { version } : {}) });
      } else {
        // --version 失败但仍可能存在（某些 CLI 不支持 --version）：
        // 视为未安装（诊断信息来自 stderr）
        resolve({ installed: false, error: (stderr || stdout).trim() || `exit ${code}` });
      }
    });
  });
}

/** 由 config.command 或默认名解析实际 binary 名 */
export function resolveCommand(configCommand: string | undefined, fallback: string): string {
  return configCommand?.trim() ? configCommand.trim() : fallback;
}

/** 超时秒数解析（缺省用 fallback） */
export function resolveTimeoutSeconds(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value : fallback;
}

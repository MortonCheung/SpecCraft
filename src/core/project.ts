import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { loadWorkflowFile } from './workflow/loader.js';
import { readState, WORKFLOW_FILE, PROJECT_FILE } from './state/store.js';
import type { Workflow, State } from './types.js';

export interface ProjectContext {
  speccraftDir: string;
  workflow: Workflow;
  state: State;
}

/** 项目验证配置（ADR 0003 §6；目标项目自己的验证命令，SpecCraft 不假设 npm） */
export interface VerificationConfig {
  /** 每条命令超时秒数（默认 300） */
  timeoutSeconds: number;
  /** 按声明顺序执行的全部命令 */
  commands: string[];
}

/** .speccraft/project.yaml 的结构（兼容旧文件：verification 可选） */
export interface ProjectConfig {
  name: string;
  createdAt?: string;
  verification?: VerificationConfig;
}

/** 解析 project.yaml 文本（旧文件无 verification 字段时给出安全默认值） */
export function parseProjectConfig(source: string): ProjectConfig {
  const loaded = yaml.load(source);
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error('project.yaml 顶层必须是对象');
  }
  const obj = loaded as Record<string, unknown>;

  const config: ProjectConfig = {
    name: typeof obj.name === 'string' && obj.name ? obj.name : '',
  };
  const createdAt =
    typeof obj.created_at === 'string'
      ? obj.created_at
      : typeof obj.createdAt === 'string'
        ? obj.createdAt
        : undefined;
  if (createdAt) config.createdAt = createdAt;

  const v = obj.verification;
  if (v !== undefined && v !== null) {
    if (typeof v !== 'object' || Array.isArray(v)) {
      throw new Error('project.yaml 的 verification 必须是对象');
    }
    const vo = v as Record<string, unknown>;

    let timeoutSeconds = 300;
    if (vo.timeout_seconds !== undefined) {
      if (typeof vo.timeout_seconds !== 'number' || vo.timeout_seconds <= 0) {
        throw new Error('verification.timeout_seconds 必须是正数');
      }
      timeoutSeconds = vo.timeout_seconds;
    }
    if (vo.timeoutSeconds !== undefined && typeof vo.timeoutSeconds === 'number' && vo.timeoutSeconds > 0) {
      timeoutSeconds = vo.timeoutSeconds;
    }

    let commands: string[] = [];
    if (vo.commands !== undefined && vo.commands !== null) {
      if (!Array.isArray(vo.commands)) {
        throw new Error('verification.commands 必须是字符串数组');
      }
      commands = vo.commands.filter((c): c is string => typeof c === 'string' && c.trim() !== '');
    }

    config.verification = { timeoutSeconds, commands };
  }

  return config;
}

/** 读取 .speccraft/project.yaml；文件不存在时返回安全默认值 */
export async function loadProjectConfig(speccraftDir: string): Promise<ProjectConfig> {
  const file = path.join(speccraftDir, PROJECT_FILE);
  if (!(await pathExists(file))) {
    return { name: '' };
  }
  return parseProjectConfig(await readFile(file, 'utf8'));
}

/** 加载目标项目的 .speccraft 工作现场（workflow + state） */
export async function loadProject(projectRoot: string): Promise<ProjectContext> {
  const speccraftDir = path.join(path.resolve(projectRoot), '.speccraft');
  if (!(await pathExists(speccraftDir))) {
    throw new Error(`未找到 .speccraft（${speccraftDir}），请先运行 speccraft init`);
  }
  const workflow = await loadWorkflowFile(path.join(speccraftDir, WORKFLOW_FILE));
  const state = await readState(speccraftDir);
  return { speccraftDir, workflow, state };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

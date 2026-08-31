import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { defaultWorkflowPath } from '../utils/paths.js';
import { parseWorkflow } from './workflow/loader.js';
import {
  createInitialState,
  stringifyState,
  PROJECT_FILE,
  STATE_FILE,
  WORKFLOW_FILE,
} from './state/store.js';
import type { State } from './types.js';

export interface InitOptions {
  /** 目标项目根目录 */
  projectRoot: string;
  /** 项目名（缺省取目录名） */
  projectName?: string;
  /** 已存在 .speccraft 时是否重建 */
  force?: boolean;
}

export interface InitResult {
  speccraftDir: string;
  state: State;
}

/** 在目标项目内创建 .speccraft 工作现场 */
export async function initProject(options: InitOptions): Promise<InitResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const speccraftDir = path.join(projectRoot, '.speccraft');

  if ((await pathExists(speccraftDir)) && !options.force) {
    throw new Error(`.speccraft 已存在（${speccraftDir}），如需重建请使用 --force`);
  }

  const workflowSource = await readFile(defaultWorkflowPath, 'utf8');
  const workflow = parseWorkflow(workflowSource);
  const state = createInitialState(workflow);
  const projectName = options.projectName ?? path.basename(projectRoot);

  await mkdir(path.join(speccraftDir, 'artifacts'), { recursive: true });
  await mkdir(path.join(speccraftDir, 'decisions'), { recursive: true });
  await mkdir(path.join(speccraftDir, 'logs'), { recursive: true });

  const projectYaml = yaml.dump(
    { name: projectName, created_at: new Date().toISOString() },
    { indent: 2, lineWidth: -1, noRefs: true },
  );

  await writeFile(path.join(speccraftDir, PROJECT_FILE), projectYaml, 'utf8');
  await writeFile(path.join(speccraftDir, STATE_FILE), stringifyState(state), 'utf8');
  await writeFile(path.join(speccraftDir, WORKFLOW_FILE), workflowSource, 'utf8');
  await writeFile(path.join(speccraftDir, 'logs', 'workflow.log'), '', 'utf8');

  return { speccraftDir, state };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

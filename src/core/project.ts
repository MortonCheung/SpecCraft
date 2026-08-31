import { access } from 'node:fs/promises';
import path from 'node:path';
import { loadWorkflowFile } from './workflow/loader.js';
import { readState, WORKFLOW_FILE } from './state/store.js';
import type { Workflow, State } from './types.js';

export interface ProjectContext {
  speccraftDir: string;
  workflow: Workflow;
  state: State;
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

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/** SpecCraft 包根目录（package.json 所在目录） */
export const packageRoot = path.resolve(currentDir, '..', '..');

/** 内置默认 Workflow 声明文件路径（schemas/default-workflow.yaml） */
export const defaultWorkflowPath = path.join(
  packageRoot,
  'schemas',
  'default-workflow.yaml',
);

/** Artifact 模板目录（templates/） */
export const templatesDir = path.join(packageRoot, 'templates');

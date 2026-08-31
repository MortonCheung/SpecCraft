import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { templatesDir } from '../../utils/paths.js';

/**
 * 解析阶段模板正文。
 * 优先 `templates/<name>.md`，缺失时回退到 `templates/default.md`。
 */
export async function resolveTemplateContent(templateName: string): Promise<string> {
  const specific = path.join(templatesDir, `${templateName}.md`);
  if (await pathExists(specific)) {
    return readFile(specific, 'utf8');
  }
  return readFile(path.join(templatesDir, 'default.md'), 'utf8');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

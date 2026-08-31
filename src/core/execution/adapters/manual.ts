/**
 * manual Adapter（ADR 0003 §5）。
 *
 * 不执行 AI、不调用任何厂商 API。只负责生成 Execution Package：
 *   context.md      — Context Compiler 编译的上游施工上下文
 *   agent-prompt.md — 可直接交给任意 Agent 的施工入口
 *
 * 由此 SpecCraft Runtime 不依赖 Codex / Claude / Trae / OpenCode 中的任何一家。
 */

import type {
  ExecutionAdapter,
  ExecutionAdapterInput,
  PreparedExecution,
} from './types.js';

export const manualAdapter: ExecutionAdapter = {
  id: 'manual',

  async prepare(input: ExecutionAdapterInput): Promise<PreparedExecution> {
    return {
      files: {
        'context.md': renderContextFile(input),
        'agent-prompt.md': renderAgentPrompt(input),
      },
    };
  },
};

function renderContextFile(input: ExecutionAdapterInput): string {
  const header = [
    `# Execution Context`,
    ``,
    `Run: ${input.runId}`,
    `Compiled for stage: implementation`,
    `Generated at: ${new Date().toISOString()}`,
    ``,
  ].join('\n');
  return `${header}${input.compiledContext.trim()}\n`;
}

function renderAgentPrompt(input: ExecutionAdapterInput): string {
  const { manifest, verification } = input;
  const git = input.gitSnapshot;

  const sections: string[] = [];

  // 1. Worker Role
  sections.push(`# 1. Worker Role（你的角色）

你是执行施工的 Agent。

- 你不是产品经理。
- 你不是总体方案设计者。
- 你不得重新定义需求。
- 你不得擅自改变核心架构。

你的唯一职责：按照已批准的 Execution Manual，在真实代码库中最小化地完成施工。`);

  // 2. Real Repository Rule
  sections.push(`# 2. Real Repository Rule（真实仓库优先）

真实仓库永远优先于施工说明。

如果发现 Execution Manual 与真实代码库冲突，必须：

1. 优先以真实代码为事实来源；
2. 选择最小兼容实施方式；
3. 在最终 Execution Report 中记录差异。

不是直接重新设计产品。

事实优先级（从高到低）：

1. 真实项目事实（代码、依赖、平台约束）
2. Owner 已批准的 Execution Manual
3. Compiled Context
4. Skill / Guard
5. Agent 自己的判断

Agent 不得把自己的偏好凌驾于已批准施工方案之上。`);

  // 3. Execution Goal
  sections.push(`# 3. Execution Goal（施工目标）

本次施工对应的 SpecCraft Run：

- Run ID: ${input.runId}
- Workflow 已完成阶段: ${input.readyStages.join(' → ')}
- 当前阶段: implementation（由本 Agent 施工）
- 施工完成后进入: verification

目标：完成 Execution Manual 中声明的全部施工内容，
使其通过项目配置的验证命令（见第 8 节）。`);

  // 4. Execution Manual
  sections.push(`# 4. Execution Manual（施工手册 — 最高施工说明）

以下为当前已批准的 Execution Manual 全文，直接嵌入：

---

${input.executionManual.trim()}

---`);

  // 5. Compiled Context
  sections.push(`# 5. Compiled Context（编译后的上游上下文）

以下为 Context Compiler 按 workflow dependency graph 编译的上游 Artifact，
只包含施工相关信息（requirements / research / approved design / build brief /
site survey / execution manual 的依赖闭包），
完整版本见本 Run 目录的 \`context.md\`：

---

${input.compiledContext.trim()}

---`);

  // 6. Execution Guard
  sections.push(`# 6. Execution Guard（复杂度 / 复用守卫）

以下规则来自 SpecCraft execution-guard skill，施工全程有效：

---

${input.executionGuard.trim()}

---

核心判断顺序（每次新增实现前逐条自检）：

1. 这个东西真的需要新增吗？
2. 项目中已经有了吗？
3. Node / 平台原生能力能解决吗？
4. 当前依赖已经能解决吗？
5. 能否极小实现？
6. 最后才新增抽象 / 依赖 / 模块。

不得为了「架构漂亮」增加：新框架、新 ORM、新数据库、新状态库、
新事件总线、新 DI 框架、新 CLI 框架。`);

  // 7. Scope / Forbidden Changes
  sections.push(`# 7. Scope / Forbidden Changes（允许与禁止的补充）

## 允许补充（无需请示）

- 变量名、函数拆分、局部目录位置
- 边界条件、类型
- 少量 CSS / 代码细节
- 小型兼容处理
- 测试 fixture
- 局部错误处理

## 禁止改动（未经 Planner / Owner）

- 产品目标
- Workflow 阶段
- 核心 UX
- 权限模型 / Approval 模型
- Artifact 架构
- Execution Runtime 语义
- Verification 语义
- 整体技术栈
- 新数据库 / 新 AI Provider
- 大规模重构`);

  // 8. Verification Requirements
  const commandLines =
    verification.commands.length > 0
      ? verification.commands.map((c) => `- \`${c}\``).join('\n')
      : '- （本项目尚未配置 verification.commands；请在 site-survey 确认后写入 .speccraft/project.yaml）';
  sections.push(`# 8. Verification Requirements（验证要求）

施工完成后，SpecCraft 将在项目根目录按声明顺序执行以下命令
（每条超时 ${verification.timeoutSeconds} 秒），全部 exit code = 0 才算通过：

${commandLines}

在提交 Execution Report 前，你应当自己在本地运行过这些命令。`);

  // 9. Git Rules
  const gitInfo = git
    ? [
        `- branch: ${git.branch ?? '（未知）'}`,
        `- commit: ${git.commit ?? '（未知）'}`,
        `- 工作区状态: ${git.dirty ? '有未提交修改' : '干净'}`,
      ].join('\n')
    : '- （目标项目不是 Git 仓库，跳过 Git 规则）';
  sections.push(`# 9. Git Rules（Git 规则）

施工开始时的基线快照：

${gitInfo}

Git 规则：

- 不要 force push、不要重写公共历史；
- 不要删除已有 commit；
- 不要修改 Git 用户身份或认证方式；
- 是否 commit / push 由项目 Owner 决定，你不主动 push。`);

  // 10. Execution Report Contract
  sections.push(`# 10. Execution Report Contract（执行报告契约）

施工完成后，你必须提交一份执行报告（Markdown，只含可验证事实，
不需要思维链）。格式如下：

\`\`\`markdown
# Execution Report

## 实际修改
- 修改了什么
- 为什么修改

## 主要文件
- path
- 责任
- 修改内容

## 与施工手册的差异
- 无 / 有
- 原因

## 验证
- 执行了哪些验证
- 结果

## 已知问题
- 尚未解决的问题
- 风险

## Git
- branch
- base commit
- final commit（如有）
\`\`\`

保存为文件后，由用户运行：

\`\`\`bash
speccraft implement finish --report <报告路径>
\`\`\`

注意：只有显式执行 \`speccraft implement finish\` 才会把 implementation 标记为
completed。Git 有改动、文件存在都不代表施工完成。`);

  const header = [
    `# SpecCraft Execution Package`,
    ``,
    `Run: ${input.runId}`,
    `Adapter: manual`,
    `Manifest: .speccraft/runs/${manifest.id}/manifest.yaml`,
    `Context: .speccraft/runs/${manifest.id}/${manifest.contextFile}`,
    ``,
    `本文档是自包含的施工入口：可直接整体交给任意施工 Agent。`,
    ``,
    `---`,
    ``,
  ].join('\n');

  return `${header}${sections.join('\n\n---\n\n')}\n`;
}

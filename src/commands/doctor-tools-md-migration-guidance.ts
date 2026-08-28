const CURRENT_AGENTS_TOOLS_GUIDANCE =
  "Skills define how tools work. Keep environment-specific local notes in this section.";

const LEGACY_AGENTS_TOOLS_GUIDANCE_REWRITES = [
  [
    "Skills provide your tools. When you need one, check its `SKILL.md`. Keep local notes (camera names, SSH details, voice preferences) in `TOOLS.md`.",
    CURRENT_AGENTS_TOOLS_GUIDANCE,
  ],
  [
    "- Keep environment-specific notes in `TOOLS.md` (notes for skills).",
    "- Keep environment-specific notes in this file's `## Tools` section.",
  ],
  [
    "- Keep environment-specific notes in `TOOLS.md` (Notes for Skills).",
    "- Keep environment-specific notes in this file's `## Tools` section.",
  ],
  [
    "- You learn a lesson -> update `AGENTS.md`, `TOOLS.md`, or the relevant skill.",
    "- You learn a lesson -> update `AGENTS.md` or the relevant skill.",
  ],
  [
    "- When you learn a lesson → update AGENTS.md, TOOLS.md, or the relevant skill",
    "- When you learn a lesson → update AGENTS.md or the relevant skill",
  ],
  [
    "Skills 提供你的工具。当你需要某个工具时，查看它的 `SKILL.md`。在 `TOOLS.md` 中保存本地笔记（摄像头名称、SSH 详情、语音偏好等）。",
    "Skills 定义工具的使用方式。请将环境特定的本地笔记保存在本节中。",
  ],
  [
    "技能提供你的工具。当你需要某个工具时，查看它的 `SKILL.md`。在 `TOOLS.md` 中保存本地笔记（摄像头名称、SSH 详情、语音偏好等）。",
    "技能定义工具的使用方式。请将环境特定的本地笔记保存在本节中。",
  ],
  [
    "- 在 `TOOLS.md` 中保存环境特定的笔记（Skills 注意事项）。",
    "- 将环境特定的笔记保存在本文件的 `## Tools` 部分。",
  ],
  [
    "- 将环境相关的备注保存在 `TOOLS.md`（Skills 备注）中。",
    "- 将环境相关的备注保存在本文件的 `## Tools` 部分。",
  ],
  [
    "- 将环境相关的备注保存在 `TOOLS.md`（技能备注）中。",
    "- 将环境相关的备注保存在本文件的 `## Tools` 部分。",
  ],
  [
    "- 当你学到教训 → 更新 AGENTS.md、TOOLS.md 或相关 Skills 文件",
    "- 当你学到教训 → 更新 AGENTS.md 或相关 Skills 文件",
  ],
  [
    "- 当你学到教训 → 更新 AGENTS.md、TOOLS.md 或相关技能文件",
    "- 当你学到教训 → 更新 AGENTS.md 或相关技能文件",
  ],
] as const;

export function rewriteLegacyAgentsToolsGuidance(content: string): string {
  let rewritten = content;
  for (const [legacy, current] of LEGACY_AGENTS_TOOLS_GUIDANCE_REWRITES) {
    rewritten = rewritten.replaceAll(legacy, current);
  }
  return rewritten;
}

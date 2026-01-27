import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSkillsPromptForRun } from "./skills.js";

async function _writeSkill(params: {
  dir: string;
  name: string;
  description: string;
  metadata?: string;
  body?: string;
}) {
  const { dir, name, description, metadata, body } = params;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${description}${metadata ? `\nmetadata: ${metadata}` : ""}
---

${body ?? `# ${name}\n`}
`,
    "utf-8",
  );
}

describe("resolveSkillsPromptForRun", () => {
  it("prefers snapshot prompt when available", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: { prompt: "SNAPSHOT", skills: [] },
      workspaceDir: "/tmp/clawd",
    });
    expect(prompt).toBe("SNAPSHOT");
  });
  it("builds prompt from entries when snapshot is missing", () => {
    const entry: SkillEntry = {
      skill: {
        name: "demo-skill",
        description: "Demo",
        filePath: "/app/skills/demo-skill/SKILL.md",
        baseDir: "/app/skills/demo-skill",
        source: "moltbot-bundled",
      },
      frontmatter: {},
    };
    const prompt = resolveSkillsPromptForRun({
      entries: [entry],
      workspaceDir: "/tmp/clawd",
    });
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("/app/skills/demo-skill/SKILL.md");
  });
});

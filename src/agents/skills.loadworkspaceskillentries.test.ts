import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkspaceSkillEntries } from "./skills.js";

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

describe("loadWorkspaceSkillEntries", () => {
  it("handles an empty managed skills dir without throwing", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-"));
    const managedDir = path.join(workspaceDir, ".managed");
    await fs.mkdir(managedDir, { recursive: true });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(entries).toEqual([]);
  });

  it("includes plugin-shipped skills when the plugin is enabled", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-"));
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const pluginRoot = path.join(workspaceDir, ".clawdbot", "extensions", "open-prose");

    await fs.mkdir(path.join(pluginRoot, "skills", "prose"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, "moltbot.plugin.json"),
      JSON.stringify(
        {
          id: "open-prose",
          skills: ["./skills"],
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(
      path.join(pluginRoot, "skills", "prose", "SKILL.md"),
      `---\nname: prose\ndescription: test\n---\n`,
      "utf-8",
    );

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        plugins: {
          entries: { "open-prose": { enabled: true } },
        },
      },
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("prose");
  });

  it("excludes plugin-shipped skills when the plugin is not allowed", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-"));
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const pluginRoot = path.join(workspaceDir, ".clawdbot", "extensions", "open-prose");

    await fs.mkdir(path.join(pluginRoot, "skills", "prose"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, "moltbot.plugin.json"),
      JSON.stringify(
        {
          id: "open-prose",
          skills: ["./skills"],
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(
      path.join(pluginRoot, "skills", "prose", "SKILL.md"),
      `---\nname: prose\ndescription: test\n---\n`,
      "utf-8",
    );

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        plugins: {
          allow: ["something-else"],
        },
      },
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).not.toContain("prose");
  });
});

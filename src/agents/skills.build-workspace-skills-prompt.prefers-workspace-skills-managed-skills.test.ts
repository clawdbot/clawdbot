import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillsPrompt } from "./skills.js";

async function writeSkill(params: {
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

describe("buildWorkspaceSkillsPrompt", () => {
  it("prefers workspace skills over managed skills", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-"));
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const managedSkillDir = path.join(managedDir, "demo-skill");
    const bundledSkillDir = path.join(bundledDir, "demo-skill");
    const workspaceSkillDir = path.join(workspaceDir, "skills", "demo-skill");

    await writeSkill({
      dir: bundledSkillDir,
      name: "demo-skill",
      description: "Bundled version",
      body: "# Bundled\n",
    });
    await writeSkill({
      dir: managedSkillDir,
      name: "demo-skill",
      description: "Managed version",
      body: "# Managed\n",
    });
    await writeSkill({
      dir: workspaceSkillDir,
      name: "demo-skill",
      description: "Workspace version",
      body: "# Workspace\n",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(prompt).toContain("Workspace version");
    expect(prompt).toContain(path.join(workspaceSkillDir, "SKILL.md"));
    expect(prompt).not.toContain(path.join(managedSkillDir, "SKILL.md"));
    expect(prompt).not.toContain(path.join(bundledSkillDir, "SKILL.md"));
  });
  it("gates by bins, config, and always", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-"));
    const skillsDir = path.join(workspaceDir, "skills");
    const binDir = path.join(workspaceDir, "bin");
    const originalPath = process.env.PATH;

    await writeSkill({
      dir: path.join(skillsDir, "bin-skill"),
      name: "bin-skill",
      description: "Needs a bin",
      metadata: '{"moltbot":{"requires":{"bins":["fakebin"]}}}',
    });
    await writeSkill({
      dir: path.join(skillsDir, "anybin-skill"),
      name: "anybin-skill",
      description: "Needs any bin",
      metadata: '{"moltbot":{"requires":{"anyBins":["missingbin","fakebin"]}}}',
    });
    await writeSkill({
      dir: path.join(skillsDir, "config-skill"),
      name: "config-skill",
      description: "Needs config",
      metadata: '{"moltbot":{"requires":{"config":["browser.enabled"]}}}',
    });
    await writeSkill({
      dir: path.join(skillsDir, "always-skill"),
      name: "always-skill",
      description: "Always on",
      metadata: '{"moltbot":{"always":true,"requires":{"env":["MISSING"]}}}',
    });
    await writeSkill({
      dir: path.join(skillsDir, "env-skill"),
      name: "env-skill",
      description: "Needs env",
      metadata: '{"moltbot":{"requires":{"env":["ENV_KEY"]},"primaryEnv":"ENV_KEY"}}',
    });

    try {
      const defaultPrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
      });
      expect(defaultPrompt).toContain("always-skill");
      expect(defaultPrompt).toContain("config-skill");
      expect(defaultPrompt).not.toContain("bin-skill");
      expect(defaultPrompt).not.toContain("anybin-skill");
      expect(defaultPrompt).not.toContain("env-skill");

      await fs.mkdir(binDir, { recursive: true });
      const fakebinPath = path.join(binDir, "fakebin");
      await fs.writeFile(fakebinPath, "#!/bin/sh\nexit 0\n", "utf-8");
      await fs.chmod(fakebinPath, 0o755);
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

      const gatedPrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config: {
          browser: { enabled: false },
          skills: { entries: { "env-skill": { apiKey: "ok" } } },
        },
      });
      expect(gatedPrompt).toContain("bin-skill");
      expect(gatedPrompt).toContain("anybin-skill");
      expect(gatedPrompt).toContain("env-skill");
      expect(gatedPrompt).toContain("always-skill");
      expect(gatedPrompt).not.toContain("config-skill");
    } finally {
      process.env.PATH = originalPath;
    }
  });
  it("uses skillKey for config lookups", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-"));
    const skillDir = path.join(workspaceDir, "skills", "alias-skill");
    await writeSkill({
      dir: skillDir,
      name: "alias-skill",
      description: "Uses skillKey",
      metadata: '{"moltbot":{"skillKey":"alias"}}',
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config: { skills: { entries: { alias: { enabled: false } } } },
    });
    expect(prompt).not.toContain("alias-skill");
  });
});

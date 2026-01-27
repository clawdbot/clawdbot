import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillStatus } from "./skills-status.js";

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

describe("buildWorkspaceSkillStatus", () => {
  it("reports missing requirements and install options", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-"));
    const skillDir = path.join(workspaceDir, "skills", "status-skill");

    await writeSkill({
      dir: skillDir,
      name: "status-skill",
      description: "Needs setup",
      metadata:
        '{"moltbot":{"requires":{"bins":["fakebin"],"env":["ENV_KEY"],"config":["browser.enabled"]},"install":[{"id":"brew","kind":"brew","formula":"fakebin","bins":["fakebin"],"label":"Install fakebin"}]}}',
    });

    const report = buildWorkspaceSkillStatus(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config: { browser: { enabled: false } },
    });
    const skill = report.skills.find((entry) => entry.name === "status-skill");

    expect(skill).toBeDefined();
    expect(skill?.eligible).toBe(false);
    expect(skill?.missing.bins).toContain("fakebin");
    expect(skill?.missing.env).toContain("ENV_KEY");
    expect(skill?.missing.config).toContain("browser.enabled");
    expect(skill?.install[0]?.id).toBe("brew");
  });
  it("respects OS-gated skills", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-"));
    const skillDir = path.join(workspaceDir, "skills", "os-skill");

    await writeSkill({
      dir: skillDir,
      name: "os-skill",
      description: "Darwin only",
      metadata: '{"moltbot":{"os":["darwin"]}}',
    });

    const report = buildWorkspaceSkillStatus(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });
    const skill = report.skills.find((entry) => entry.name === "os-skill");

    expect(skill).toBeDefined();
    if (process.platform === "darwin") {
      expect(skill?.eligible).toBe(true);
      expect(skill?.missing.os).toEqual([]);
    } else {
      expect(skill?.eligible).toBe(false);
      expect(skill?.missing.os).toEqual(["darwin"]);
    }
  });
  it("marks bundled skills blocked by allowlist", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-"));
    const bundledDir = path.join(workspaceDir, ".bundled");
    const bundledSkillDir = path.join(bundledDir, "peekaboo");
    const originalBundled = process.env.CLAWDBOT_BUNDLED_SKILLS_DIR;

    await writeSkill({
      dir: bundledSkillDir,
      name: "peekaboo",
      description: "Capture UI",
      body: "# Peekaboo\n",
    });

    try {
      process.env.CLAWDBOT_BUNDLED_SKILLS_DIR = bundledDir;
      const report = buildWorkspaceSkillStatus(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config: { skills: { allowBundled: ["other-skill"] } },
      });
      const skill = report.skills.find((entry) => entry.name === "peekaboo");

      expect(skill).toBeDefined();
      expect(skill?.blockedByAllowlist).toBe(true);
      expect(skill?.eligible).toBe(false);
    } finally {
      if (originalBundled === undefined) {
        delete process.env.CLAWDBOT_BUNDLED_SKILLS_DIR;
      } else {
        process.env.CLAWDBOT_BUNDLED_SKILLS_DIR = originalBundled;
      }
    }
  });

  it("filters install options by OS", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-"));
    const skillDir = path.join(workspaceDir, "skills", "install-skill");

    await writeSkill({
      dir: skillDir,
      name: "install-skill",
      description: "OS-specific installs",
      metadata:
        '{"moltbot":{"requires":{"bins":["missing-bin"]},"install":[{"id":"mac","kind":"download","os":["darwin"],"url":"https://example.com/mac.tar.bz2"},{"id":"linux","kind":"download","os":["linux"],"url":"https://example.com/linux.tar.bz2"},{"id":"win","kind":"download","os":["win32"],"url":"https://example.com/win.tar.bz2"}]}}',
    });

    const report = buildWorkspaceSkillStatus(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });
    const skill = report.skills.find((entry) => entry.name === "install-skill");

    expect(skill).toBeDefined();
    if (process.platform === "darwin") {
      expect(skill?.install.map((opt) => opt.id)).toEqual(["mac"]);
    } else if (process.platform === "linux") {
      expect(skill?.install.map((opt) => opt.id)).toEqual(["linux"]);
    } else if (process.platform === "win32") {
      expect(skill?.install.map((opt) => opt.id)).toEqual(["win"]);
    } else {
      expect(skill?.install).toEqual([]);
    }
  });
});

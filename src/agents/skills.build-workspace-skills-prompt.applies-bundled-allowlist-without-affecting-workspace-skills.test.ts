import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { buildWorkspaceSkillsPrompt } from "./skills/workspace.js";

describe("buildWorkspaceSkillsPrompt", () => {
  it("applies bundled allowlist without affecting workspace skills", async () => {
    const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-"));
    try {
      process.env.HOME = workspaceDir;
      process.env.USERPROFILE = workspaceDir;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_STATE_DIR;
      const bundledDir = path.join(workspaceDir, ".bundled");
      const bundledSkillDir = path.join(bundledDir, "peekaboo");
      const workspaceSkillDir = path.join(workspaceDir, "skills", "demo-skill");

      await writeSkill({
        dir: bundledSkillDir,
        name: "peekaboo",
        description: "Capture UI",
        body: "# Peekaboo\n",
      });
      await writeSkill({
        dir: workspaceSkillDir,
        name: "demo-skill",
        description: "Workspace version",
        body: "# Workspace\n",
      });

      const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
        bundledSkillsDir: bundledDir,
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config: { skills: { allowBundled: ["missing-skill"] } },
      });

      expect(prompt).toContain("Workspace version");
      expect(prompt).not.toContain("peekaboo");
    } finally {
      env.restore();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

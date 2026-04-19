import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSkill } from "./skills.e2e-test-helpers.js";

const tempDirs: string[] = [];

async function withTempSkillDir(
  name: string,
  run: (params: { root: string; skillDir: string }) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-helper-"));
  tempDirs.push(root);
  const skillDir = path.join(root, name);
  await run({ root, skillDir });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("writeSkill", () => {
  it("writes SKILL.md with required fields", async () => {
    await withTempSkillDir("demo-skill", async ({ skillDir }) => {
      await writeSkill({
        dir: skillDir,
        name: "demo-skill",
        description: "Demo",
      });

      const content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8");
      expect(content).toContain("name: demo-skill");
      expect(content).toContain("description: Demo");
      expect(content).toContain("# demo-skill");
    });
  });

  it("includes optional metadata, body, and frontmatterExtra", async () => {
    await withTempSkillDir("custom-skill", async ({ skillDir }) => {
      await writeSkill({
        dir: skillDir,
        name: "custom-skill",
        description: "Custom",
        metadata: '{"openclaw":{"always":true}}',
        frontmatterExtra: "user-invocable: false",
        body: "# Custom Body\n",
      });

      const content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8");
      expect(content).toContain('metadata: {"openclaw":{"always":true}}');
      expect(content).toContain("user-invocable: false");
      expect(content).toContain("# Custom Body");
    });
  });

  it("keeps empty body and trims blank frontmatter extra entries", async () => {
    await withTempSkillDir("empty-body-skill", async ({ skillDir }) => {
      await writeSkill({
        dir: skillDir,
        name: "empty-body-skill",
        description: "Empty body",
        frontmatterExtra: "   ",
        body: "",
      });

      const content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8");
      expect(content).toContain("name: empty-body-skill");
      expect(content).toContain("description: Empty body");
      expect(content).not.toContain("# empty-body-skill");
      expect(content).not.toContain("user-invocable:");
    });
  });
});

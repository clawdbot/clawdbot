import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillsPrompt } from "./skills.js";
import { createCanonicalFixtureSkill } from "./skills.test-helpers.js";

describe("compactSkillPaths", () => {
  it("replaces home directory prefix with ~ in skill locations", () => {
    const home = os.homedir();
    const skillDir = path.join(home, ".openclaw-test-skills", "test-skill");

    const prompt = buildWorkspaceSkillsPrompt(home, {
      entries: [
        {
          skill: createCanonicalFixtureSkill({
            name: "test-skill",
            description: "A test skill for path compaction",
            filePath: path.join(skillDir, "SKILL.md"),
            baseDir: skillDir,
            source: "test",
          }),
          frontmatter: {},
          metadata: undefined,
          invocation: { disableModelInvocation: false, userInvocable: true },
          exposure: {
            includeInRuntimeRegistry: true,
            includeInAvailableSkillsPrompt: true,
            userInvocable: true,
          },
        },
      ],
    });

    expect(prompt).not.toContain(home + path.sep);
    expect(prompt).toContain("~/");
    expect(prompt).toContain("test-skill");
    expect(prompt).toContain("A test skill for path compaction");
  });

  it("preserves paths outside home directory", () => {
    const outsideHome = path.join(path.parse(os.homedir()).root, "openclaw-external-skills");
    const skillDir = path.join(outsideHome, "skills", "ext-skill");

    const prompt = buildWorkspaceSkillsPrompt(outsideHome, {
      entries: [
        {
          skill: createCanonicalFixtureSkill({
            name: "ext-skill",
            description: "External skill",
            filePath: path.join(skillDir, "SKILL.md"),
            baseDir: skillDir,
            source: "test",
          }),
          frontmatter: {},
          metadata: undefined,
          invocation: { disableModelInvocation: false, userInvocable: true },
          exposure: {
            includeInRuntimeRegistry: true,
            includeInAvailableSkillsPrompt: true,
            userInvocable: true,
          },
        },
      ],
    });

    expect(prompt).toMatch(/<location>[^<]+SKILL\.md<\/location>/);
    expect(prompt).toContain(path.join(skillDir, "SKILL.md"));
  });
});

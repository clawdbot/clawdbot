// Compact skill path tests cover short path formatting for skill prompt payloads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import { testing as workspaceSkillsTesting, buildWorkspaceSkillsPrompt } from "./workspace.js";

describe("compactSkillPaths", () => {
  function buildPromptForFixtureSkill(params: {
    workspaceRoot: string;
    skillDir: string;
    name: string;
    description: string;
  }) {
    return buildWorkspaceSkillsPrompt(params.workspaceRoot, {
      entries: [
        {
          skill: createCanonicalFixtureSkill({
            name: params.name,
            description: params.description,
            filePath: path.join(params.skillDir, "SKILL.md"),
            baseDir: params.skillDir,
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
  }

  it("replaces home directory prefix with ~ in skill locations", () => {
    const home = os.homedir();
    const skillDir = path.join(home, ".openclaw-test-skills", "test-skill");

    const prompt = buildPromptForFixtureSkill({
      workspaceRoot: home,
      skillDir,
      name: "test-skill",
      description: "A test skill for path compaction",
    });

    expect(prompt).not.toContain(home + path.sep);
    expect(prompt).toContain("~/");
    expect(prompt).toContain("test-skill");
    expect(prompt).toContain("A test skill for path compaction");
  });

  it("does not compact explicit state-root managed skill paths to OS-home tilde paths", () => {
    const root = path.parse(os.homedir()).root;
    const osHome = path.join(root, "data");
    const stateDir = path.join(osHome, ".openclaw");
    const skillDir = path.join(stateDir, "skills", "world-cup-soccer-openclaw-skill");
    const skillFile = path.join(skillDir, "SKILL.md");

    const prompt = withEnv(
      {
        HOME: osHome,
        OPENCLAW_HOME: osHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      () =>
        buildPromptForFixtureSkill({
          workspaceRoot: path.join(root, "workspace"),
          skillDir,
          name: "world-cup-soccer-openclaw-skill",
          description: "World Cup standings lookup",
        }),
    );

    expect(prompt).toContain(`<location>${skillFile}</location>`);
    expect(prompt).not.toContain("~/.openclaw/skills/world-cup-soccer-openclaw-skill/SKILL.md");
  });

  it("does not compact explicit state-root plugin skill paths to OS-home tilde paths", () => {
    const root = path.parse(os.homedir()).root;
    const osHome = path.join(root, "data");
    const stateDir = path.join(osHome, ".openclaw");
    const skillDir = path.join(stateDir, "plugin-skills", "calendar-plugin-skill");
    const skillFile = path.join(skillDir, "SKILL.md");

    const prompt = withEnv(
      {
        HOME: osHome,
        OPENCLAW_HOME: osHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      () =>
        buildPromptForFixtureSkill({
          workspaceRoot: path.join(root, "workspace"),
          skillDir,
          name: "calendar-plugin-skill",
          description: "Calendar plugin skill",
        }),
    );

    expect(prompt).toContain(`<location>${skillFile}</location>`);
    expect(prompt).not.toContain("~/.openclaw/plugin-skills/calendar-plugin-skill/SKILL.md");
  });

  it("compacts managed skill paths when OS-home tilde reaches the same path", () => {
    const home = os.homedir();
    const stateDir = path.join(home, ".openclaw");
    const skillDir = path.join(stateDir, "skills", "home-managed-skill");

    const prompt = withEnv(
      {
        HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_HOME: undefined,
      },
      () =>
        buildPromptForFixtureSkill({
          workspaceRoot: path.join(home, "workspace"),
          skillDir,
          name: "home-managed-skill",
          description: "Home managed skill",
        }),
    );

    expect(prompt).toContain("<location>~/.openclaw/skills/home-managed-skill/SKILL.md</location>");
    expect(prompt).not.toContain(`<location>${path.join(skillDir, "SKILL.md")}</location>`);
  });

  it("normalizes compacted Windows skill locations to forward slashes", () => {
    const home = "C:\\Users\\alice";
    const skillPath = path.win32.join(home, ".openclaw-test-skills", "win-skill", "SKILL.md");

    const compactedPath = workspaceSkillsTesting.compactHomePath(skillPath, [home]);

    expect(compactedPath).toBe("~/.openclaw-test-skills/win-skill/SKILL.md");
  });

  it("preserves POSIX literal backslashes after home compaction", () => {
    const home = os.homedir();
    const skillDir = path.join(home, ".openclaw-test-skills\\literal-skill");

    const prompt = buildPromptForFixtureSkill({
      workspaceRoot: home,
      skillDir,
      name: "literal-skill",
      description: "POSIX literal backslash skill",
    });

    const locationMatch = prompt.match(/<location>([^<]+)<\/location>/);
    if (!locationMatch) {
      throw new Error("expected prompt location tag");
    }
    expect(locationMatch[1]).toContain("~/");
    expect(locationMatch[1]).toContain("\\literal-skill");
  });

  it("preserves paths outside home directory", () => {
    const outsideHome = path.join(path.parse(os.homedir()).root, "openclaw-external-skills");
    const skillDir = path.join(outsideHome, "skills", "ext-skill");

    const prompt = buildPromptForFixtureSkill({
      workspaceRoot: outsideHome,
      skillDir,
      name: "ext-skill",
      description: "External skill",
    });

    expect(prompt).toMatch(/<location>[^<]+SKILL\.md<\/location>/);
    expect(prompt).toContain(path.join(skillDir, "SKILL.md"));
  });

  it("loads skills when the shared state database is unavailable", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-skill-load-")));
    const blockedParent = path.join(root, "state-blocker");
    fs.writeFileSync(blockedParent, "not a directory", "utf8");
    const skillDir = path.join(root, "workspace", "skills", "available-skill");

    try {
      const prompt = withEnv({ OPENCLAW_STATE_DIR: path.join(blockedParent, "state") }, () =>
        buildPromptForFixtureSkill({
          workspaceRoot: path.join(root, "workspace"),
          skillDir,
          name: "available-skill",
          description: "Available despite missing lifecycle state",
        }),
      );

      expect(prompt).toContain("available-skill");
      expect(prompt).toContain("Available despite missing lifecycle state");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

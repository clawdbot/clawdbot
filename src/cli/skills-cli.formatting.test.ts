// Skills CLI formatting tests cover skill listing and display formatting.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { buildWorkspaceSkillStatus } from "../skills/discovery/status.js";
import { writeWorkspaceSkills } from "../skills/test-support/e2e-test-helpers.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import type { SkillEntry } from "../skills/types.js";
import { captureEnv } from "../test-utils/env.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

describe("skills-cli (e2e)", () => {
  let tempWorkspaceDir = "";
  let tempBundledDir = "";
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeAll(() => {
    envSnapshot = captureEnv(["OPENCLAW_BUNDLED_SKILLS_DIR"]);
    tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-skills-test-"));
    tempBundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-skills-test-"));
    process.env.OPENCLAW_BUNDLED_SKILLS_DIR = tempBundledDir;
  });

  afterAll(() => {
    if (tempWorkspaceDir) {
      fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
    }
    if (tempBundledDir) {
      fs.rmSync(tempBundledDir, { recursive: true, force: true });
    }
    envSnapshot.restore();
  });

  function createEntries(): SkillEntry[] {
    const baseDir = path.join(tempWorkspaceDir, "peekaboo");
    const filePath = path.join(baseDir, "SKILL.md");
    return [
      {
        skill: createFixtureSkill({
          name: "peekaboo",
          description: "Capture UI screenshots",
          filePath,
          baseDir,
          source: "openclaw-bundled",
        }),
        frontmatter: {},
        metadata: { emoji: "📸" },
      },
    ];
  }

  it("loads bundled skills and formats them", () => {
    const entries = createEntries();
    const report = buildWorkspaceSkillStatus(tempWorkspaceDir, {
      managedSkillsDir: "/nonexistent",
      entries,
    });

    expect(report.skills).toHaveLength(1);

    const listOutput = formatSkillsList(report, {});
    expect(listOutput).toContain("Skills");

    const checkOutput = formatSkillsCheck(report, {});
    expect(checkOutput).toContain("Total:");

    const jsonOutput = formatSkillsList(report, { json: true });
    const parsed = JSON.parse(jsonOutput);
    expect(parsed).toEqual({
      workspaceDir: tempWorkspaceDir,
      managedSkillsDir: "/nonexistent",
      skills: [
        {
          name: "peekaboo",
          description: "Capture UI screenshots",
          emoji: "📸",
          eligible: true,
          disabled: false,
          blockedByAllowlist: false,
          blockedByAgentFilter: false,
          modelVisible: true,
          userInvocable: true,
          commandVisible: true,
          source: "openclaw-bundled",
          bundled: true,
          missing: {
            bins: [],
            anyBins: [],
            env: [],
            config: [],
            os: [],
          },
        },
      ],
    });
  });

  it("formats info for a real bundled skill (peekaboo)", () => {
    const entries = createEntries();
    const report = buildWorkspaceSkillStatus(tempWorkspaceDir, {
      managedSkillsDir: "/nonexistent",
      entries,
    });

    const peekaboo = report.skills.find((s) => s.name === "peekaboo");
    if (!peekaboo) {
      throw new Error("peekaboo fixture skill missing");
    }

    const output = formatSkillInfo(report, "peekaboo", {});
    expect(output).toContain("peekaboo");
    expect(output).toContain("Details:");
  });

  it.each([
    ["plain", "left\tright"],
    ["ESC CSI", "left\x1b[31\tmright\x1b[0m"],
    ["C1 CSI", "left\x9b31\tmright\x9b0m"],
  ])(
    "keeps %s tab-separated skill descriptions in their table cell",
    async (_label, description) => {
      const workspaceDir = fs.mkdtempSync(path.join(tempWorkspaceDir, "tab-spacing-"));
      await writeWorkspaceSkills(workspaceDir, [
        {
          name: "tab-spacing",
          description: JSON.stringify(description).replaceAll("\x9b", "\\u009b"),
        },
      ]);
      const report = buildWorkspaceSkillStatus(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, "managed"),
        config: { plugins: { enabled: false } },
      });
      expect(report.skills.find((skill) => skill.name === "tab-spacing")?.description).toBe(
        description,
      );

      const row = stripAnsi(formatSkillsList(report, {}))
        .split("\n")
        .find((line) => line.includes("tab-spacing"));
      expect(row?.split(/[|│]/u)[3]?.trim()).toBe("left right");
    },
  );

  it("preserves description and path whitespace in skills JSON output", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(tempWorkspaceDir, "json-whitespace-"));
    const managedSkillsDir = path.join(workspaceDir, "managed\tlocal");
    const description = "First paragraph.\nSecond\tcolumn.\r\nThird paragraph.";
    await writeWorkspaceSkills(workspaceDir, [
      { name: "json-whitespace", description: JSON.stringify(description) },
    ]);
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      managedSkillsDir,
      config: { plugins: { enabled: false } },
    });
    expect(report.skills[0]?.description).toBe(description);

    const list = JSON.parse(formatSkillsList(report, { json: true }));
    const info = JSON.parse(formatSkillInfo(report, "json-whitespace", { json: true }));
    const check = JSON.parse(formatSkillsCheck(report, { json: true }));
    expect(list.skills[0].description).toBe(description);
    expect(info.description).toBe(description);
    expect(list.managedSkillsDir).toBe(managedSkillsDir);
    expect(check.managedSkillsDir).toBe(managedSkillsDir);
  });

  it("reports missing prerequisites for discovered agent-excluded skills", async () => {
    const missingBin = "qa35-fixture-absent-binary";
    await writeWorkspaceSkills(tempWorkspaceDir, [
      { name: "ready", description: "Allowed ready control" },
      { name: "excluded-ready", description: "Excluded ready control" },
      ...["missing", "excluded-missing"].map((name) => ({
        name,
        description: "Missing prerequisite fixture",
        metadata: JSON.stringify({ openclaw: { requires: { bins: [missingBin] } } }),
      })),
    ]);
    const report = buildWorkspaceSkillStatus(tempWorkspaceDir, {
      managedSkillsDir: path.join(tempWorkspaceDir, "managed"),
      agentId: "qa",
      config: {
        plugins: { enabled: false },
        agents: { entries: { qa: { workspace: tempWorkspaceDir, skills: ["ready", "missing"] } } },
      },
    });
    expect(report.skills).toHaveLength(4);
    expect(report.skills.find((skill) => skill.name === "excluded-missing")).toMatchObject({
      eligible: false,
      disabled: false,
      blockedByAllowlist: false,
      blockedByAgentFilter: true,
      modelVisible: false,
      commandVisible: false,
      missing: { bins: [missingBin] },
    });
    const parsed = JSON.parse(formatSkillsCheck(report, { json: true }));
    expect(parsed.missingRequirements.map((skill: { name: string }) => skill.name)).toEqual([
      "excluded-missing",
      "missing",
    ]);
    expect(parsed.agentFiltered).toEqual(["excluded-missing", "excluded-ready"]);
    expect(parsed.eligible).toEqual(["excluded-ready", "ready"]);
    expect(parsed.modelVisible).toEqual(["ready"]);
    expect(parsed.commandVisible).toEqual(["ready"]);
    const human = formatSkillsCheck(report, {});
    expect(human).toContain(`excluded-missing (bins: ${missingBin})`);
    expect(human).toContain("excluded-ready (loaded, but this agent is not allowed to see/use it)");

    const readyList = JSON.parse(formatSkillsList(report, { eligible: true, json: true }));
    expect(readyList.skills.map((skill: { name: string }) => skill.name)).toEqual(["ready"]);
    const info = formatSkillInfo(report, "excluded-missing", {});
    expect(info).toContain("Excluded by agent allowlist");
    expect(info).toContain(`✗ ${missingBin}`);
  });
});

function createFixtureSkill(params: {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
}): SkillEntry["skill"] {
  return createCanonicalFixtureSkill(params);
}

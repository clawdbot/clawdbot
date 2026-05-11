import { describe, expect, it, vi } from "vitest";
import type { SkillStatusEntry, SkillStatusReport } from "../agents/skills-status.js";
import { createEmptyInstallChecks } from "./requirements-test-fixtures.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

// Unit tests: don't pay the runtime cost of loading/parsing the real skills loader.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  loadSkillsFromDir: () => ({ skills: [] }),
  formatSkillsForPrompt: () => "",
}));

function createMockSkill(overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry {
  const skill: SkillStatusEntry = {
    name: "test-skill",
    description: "A test skill",
    source: "bundled",
    bundled: false,
    filePath: "/path/to/SKILL.md",
    baseDir: "/path/to",
    skillKey: "test-skill",
    emoji: "🧪",
    homepage: "https://example.com",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
    eligible: true,
    modelVisible: true,
    userInvocable: true,
    commandVisible: true,
    ...createEmptyInstallChecks(),
    ...overrides,
  };
  if (overrides.modelVisible === undefined) {
    skill.modelVisible = skill.eligible && !skill.blockedByAgentFilter;
  }
  if (overrides.commandVisible === undefined) {
    skill.commandVisible = skill.eligible && !skill.blockedByAgentFilter && skill.userInvocable;
  }
  return skill;
}

function createMockReport(skills: SkillStatusEntry[]): SkillStatusReport {
  return {
    workspaceDir: "/workspace",
    managedSkillsDir: "/managed",
    skills,
  };
}

describe("skills-cli", () => {
  describe("formatSkillsList", () => {
    it("formats empty skills list", () => {
      const report = createMockReport([]);
      const output = formatSkillsList(report, {});
      expect(output).toContain("No skills found");
      expect(output).toContain("openclaw skills search");
    });

    it("formats skills list with eligible skill", () => {
      const report = createMockReport([
        createMockSkill({
          name: "peekaboo",
          description: "Capture UI screenshots",
          emoji: "📸",
          eligible: true,
        }),
      ]);
      const output = formatSkillsList(report, {});
      expect(output).toContain("peekaboo");
      expect(output).toContain("📸");
      expect(output).toContain("✓");
    });

    it("formats skills list with disabled skill", () => {
      const report = createMockReport([
        createMockSkill({
          name: "disabled-skill",
          disabled: true,
          eligible: false,
        }),
      ]);
      const output = formatSkillsList(report, {});
      expect(output).toContain("disabled-skill");
      expect(output).toContain("disabled");
    });

    it("formats skills list with missing requirements", () => {
      const report = createMockReport([
        createMockSkill({
          name: "needs-stuff",
          eligible: false,
          missing: {
            bins: ["ffmpeg"],
            anyBins: ["rg", "grep"],
            env: ["API_KEY"],
            config: [],
            os: ["darwin"],
          },
        }),
      ]);
      const output = formatSkillsList(report, { verbose: true });
      expect(output).toContain("needs-stuff");
      expect(output).toContain("needs setup");
      expect(output).toContain("anyBins");
      expect(output).toContain("os:");
    });

    it("filters to eligible only with --eligible flag", () => {
      const report = createMockReport([
        createMockSkill({ name: "eligible-one", eligible: true }),
        createMockSkill({
          name: "not-eligible",
          eligible: false,
          disabled: true,
        }),
      ]);
      const output = formatSkillsList(report, { eligible: true });
      expect(output).toContain("eligible-one");
      expect(output).not.toContain("not-eligible");
    });

    it("does not label agent-excluded skills as ready", () => {
      const report = createMockReport([
        createMockSkill({ name: "ready-one", eligible: true }),
        createMockSkill({
          name: "agent-excluded",
          eligible: true,
          blockedByAgentFilter: true,
        }),
      ]);

      const output = formatSkillsList(report, {});
      expect(output).toContain("1/2 ready");
      expect(output).toContain("agent-excluded");
      expect(output).toContain("excluded");

      const eligibleOnly = formatSkillsList(report, { eligible: true });
      expect(eligibleOnly).toContain("ready-one");
      expect(eligibleOnly).not.toContain("agent-excluded");
    });
  });

  describe("formatSkillInfo", () => {
    it("returns not found message for unknown skill", () => {
      const report = createMockReport([]);
      const output = formatSkillInfo(report, "unknown-skill", {});
      expect(output).toContain("not found");
      expect(output).toContain("openclaw skills install");
    });

    it("shows detailed info for a skill", () => {
      const report = createMockReport([
        createMockSkill({
          name: "detailed-skill",
          description: "A detailed description",
          homepage: "https://example.com",
          requirements: {
            bins: ["node"],
            anyBins: ["rg", "grep"],
            env: ["API_KEY"],
            config: [],
            os: [],
          },
          missing: {
            bins: [],
            anyBins: [],
            env: ["API_KEY"],
            config: [],
            os: [],
          },
        }),
      ]);
      const output = formatSkillInfo(report, "detailed-skill", {});
      expect(output).toContain("detailed-skill");
      expect(output).toContain("A detailed description");
      expect(output).toContain("https://example.com");
      expect(output).toContain("node");
      expect(output).toContain("Any binaries");
      expect(output).toContain("API_KEY");
    });

    it("shows API key storage guidance for the active config path", () => {
      const report = createMockReport([
        createMockSkill({
          name: "env-aware-skill",
          skillKey: "env-aware-skill",
          primaryEnv: "API_KEY",
          eligible: false,
          requirements: {
            bins: [],
            anyBins: [],
            env: ["API_KEY"],
            config: [],
            os: [],
          },
          missing: {
            bins: [],
            anyBins: [],
            env: ["API_KEY"],
            config: [],
            os: [],
          },
        }),
      ]);

      const output = formatSkillInfo(report, "env-aware-skill", {});
      expect(output).toContain("OPENCLAW_CONFIG_PATH");
      expect(output).toContain("default: ~/.openclaw/openclaw.json");
      expect(output).toContain("skills.entries.env-aware-skill.apiKey");
    });

    it("normalizes text-presentation emoji selectors in info output", () => {
      const report = createMockReport([
        createMockSkill({
          name: "info-emoji",
          emoji: "🎛\uFE0E",
        }),
      ]);

      const output = formatSkillInfo(report, "info-emoji", {});
      expect(output).toContain("🎛️");
    });

    it("shows agent exclusion and visibility details in skill info", () => {
      const report = createMockReport([
        createMockSkill({
          name: "agent-excluded",
          eligible: true,
          blockedByAgentFilter: true,
        }),
      ]);

      const output = formatSkillInfo(report, "agent-excluded", {});
      expect(output).toContain("Excluded by agent allowlist");
      expect(output).toContain("Visible to model");
      expect(output).toContain("Available as command");
      expect(output).toContain("excludes this skill");
    });
  });

  describe("formatSkillsCheck", () => {
    it("shows summary of skill status", () => {
      const report = createMockReport([
        createMockSkill({ name: "ready-1", eligible: true }),
        createMockSkill({ name: "ready-2", eligible: true }),
        createMockSkill({
          name: "not-ready",
          eligible: false,
          missing: { bins: ["go"], anyBins: [], env: [], config: [], os: [] },
        }),
        createMockSkill({ name: "disabled", eligible: false, disabled: true }),
      ]);
      const output = formatSkillsCheck(report, {});
      expect(output).toContain("2"); // eligible count
      expect(output).toContain("ready-1");
      expect(output).toContain("ready-2");
      expect(output).toContain("not-ready");
      expect(output).toContain("go"); // missing binary
      expect(output).toContain("openclaw skills update");
    });

    it("normalizes text-presentation emoji selectors in check output", () => {
      const report = createMockReport([
        createMockSkill({ name: "ready-emoji", emoji: "🎛\uFE0E", eligible: true }),
        createMockSkill({
          name: "missing-emoji",
          emoji: "🎙\uFE0E",
          eligible: false,
          missing: { bins: ["ffmpeg"], anyBins: [], env: [], config: [], os: [] },
        }),
      ]);

      const output = formatSkillsCheck(report, {});
      expect(output).toContain("🎛️ ready-emoji");
      expect(output).toContain("🎙️ missing-emoji");
    });

    it("shows agent-filtered and loaded-but-not-injected skills", () => {
      const report = {
        ...createMockReport([
          createMockSkill({ name: "visible", eligible: true, modelVisible: true }),
          createMockSkill({
            name: "prompt-hidden",
            eligible: true,
            modelVisible: false,
            commandVisible: true,
          }),
          createMockSkill({
            name: "not-assigned",
            eligible: true,
            blockedByAgentFilter: true,
          }),
        ]),
        agentId: "specialist",
        agentSkillFilter: ["visible", "prompt-hidden"],
      };

      const output = formatSkillsCheck(report, {});
      expect(output).toContain("Agent:");
      expect(output).toContain("specialist");
      expect(output).toContain("Ready and visible to model");
      expect(output).toContain("visible");
      expect(output).toContain("Ready but hidden from model prompt");
      expect(output).toContain("prompt-hidden");
      expect(output).toContain("Excluded by agent allowlist");
      expect(output).toContain("not-assigned");
      expect(output).toContain("What this means");
      expect(output).toContain("the agent may still exclude it");
      expect(output).toContain("people, scripts, or cron jobs can call the skill explicitly");
      expect(output).toContain("kept out of normal chat");
      expect(output).toContain("commands/cron may still use it");
    });

    it("does not imply prompt-hidden non-command skills can be called explicitly", () => {
      const report = createMockReport([
        createMockSkill({
          name: "internal-hidden",
          eligible: true,
          modelVisible: false,
          commandVisible: false,
          userInvocable: false,
        }),
      ]);

      const output = formatSkillsCheck(report, {});
      expect(output).toContain("internal-hidden");
      expect(output).toContain("is not exposed as a command");
      expect(output).not.toContain("commands/cron may still use it");
    });

    it("summarizes a mixed bad skill pack in JSON", () => {
      const output = formatSkillsCheck(
        {
          ...createMockReport([
            createMockSkill({ name: "ready", eligible: true }),
            createMockSkill({
              name: "prompt-hidden",
              eligible: true,
              modelVisible: false,
              commandVisible: true,
            }),
            createMockSkill({
              name: "slash-hidden",
              eligible: true,
              modelVisible: true,
              userInvocable: false,
              commandVisible: false,
            }),
            createMockSkill({
              name: "agent-filtered",
              eligible: true,
              blockedByAgentFilter: true,
            }),
            createMockSkill({
              name: "missing-bin",
              eligible: false,
              missing: { bins: ["missing-tool"], anyBins: [], env: [], config: [], os: [] },
            }),
            createMockSkill({ name: "disabled", eligible: false, disabled: true }),
            createMockSkill({
              name: "blocked-bundled",
              eligible: false,
              blockedByAllowlist: true,
            }),
          ]),
          agentId: "specialist",
          agentSkillFilter: ["ready", "prompt-hidden", "slash-hidden", "missing-bin"],
        },
        { json: true },
      );

      const parsed = JSON.parse(output) as {
        summary: Record<string, number>;
        modelVisible: string[];
        commandVisible: string[];
        agentFiltered: string[];
        notInjected: Array<{ name: string; reason: string }>;
        missingRequirements: Array<{ name: string }>;
      };
      expect(parsed.summary).toMatchObject({
        total: 7,
        eligible: 4,
        modelVisible: 2,
        commandVisible: 2,
        disabled: 1,
        blocked: 1,
        agentFiltered: 1,
        notInjected: 1,
        missingRequirements: 1,
      });
      expect(parsed.modelVisible).toEqual(["ready", "slash-hidden"]);
      expect(parsed.commandVisible).toEqual(["ready", "prompt-hidden"]);
      expect(parsed.agentFiltered).toEqual(["agent-filtered"]);
      expect(parsed.notInjected).toEqual([
        { name: "prompt-hidden", reason: "disable-model-invocation" },
      ]);
      expect(parsed.missingRequirements.map((entry) => entry.name)).toEqual(["missing-bin"]);
    });
  });

  describe("JSON output", () => {
    it.each([
      {
        formatter: "list",
        output: formatSkillsList(createMockReport([createMockSkill({ name: "json-skill" })]), {
          json: true,
        }),
        assert: (parsed: Record<string, unknown>) => {
          const skills = parsed.skills as Array<Record<string, unknown>>;
          expect(skills).toHaveLength(1);
          expect(skills[0]?.name).toBe("json-skill");
        },
      },
      {
        formatter: "info",
        output: formatSkillInfo(
          createMockReport([createMockSkill({ name: "info-skill" })]),
          "info-skill",
          { json: true },
        ),
        assert: (parsed: Record<string, unknown>) => {
          expect(parsed.name).toBe("info-skill");
        },
      },
      {
        formatter: "check",
        output: formatSkillsCheck(
          createMockReport([
            createMockSkill({ name: "skill-1", eligible: true }),
            createMockSkill({ name: "skill-2", eligible: false }),
          ]),
          { json: true },
        ),
        assert: (parsed: Record<string, unknown>) => {
          const summary = parsed.summary as Record<string, unknown>;
          expect(summary.eligible).toBe(1);
          expect(summary.modelVisible).toBe(1);
          expect(summary.total).toBe(2);
        },
      },
    ])("outputs JSON with --json flag for $formatter", ({ output, assert }) => {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      assert(parsed);
    });

    it("sanitizes ANSI and C1 controls in skills list JSON output", () => {
      const report = createMockReport([
        createMockSkill({
          name: "json-skill",
          emoji: "\u001b[31m📧\u001b[0m\u009f",
          description: "desc\u0093\u001b[2J\u001b[33m colored\u001b[0m",
        }),
      ]);

      const output = formatSkillsList(report, { json: true });
      const parsed = JSON.parse(output) as {
        skills: Array<{ emoji: string; description: string }>;
      };

      expect(parsed.skills[0]?.emoji).toBe("📧");
      expect(parsed.skills[0]?.description).toBe("desc colored");
      expect(output).not.toContain("\\u001b");
    });

    it("sanitizes skills info JSON output", () => {
      const report = createMockReport([
        createMockSkill({
          name: "info-json",
          emoji: "\u001b[31m🎙\u001b[0m\u009f",
          description: "hi\u0091",
          homepage: "https://example.com/\u0092docs",
        }),
      ]);

      const output = formatSkillInfo(report, "info-json", { json: true });
      const parsed = JSON.parse(output) as {
        emoji: string;
        description: string;
        homepage: string;
      };

      expect(parsed.emoji).toBe("🎙");
      expect(parsed.description).toBe("hi");
      expect(parsed.homepage).toBe("https://example.com/docs");
    });
  });
});

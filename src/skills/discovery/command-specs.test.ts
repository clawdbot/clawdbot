// Command spec tests cover skill-provided command metadata and filtering.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureSkillEntry } from "../test-support/test-helpers.js";
import type { SkillEntry } from "../types.js";

const bundleCommandState = vi.hoisted(() => ({
  entries: [] as Array<{
    pluginId: string;
    rawName: string;
    description: string;
    promptTemplate: string;
    sourceFilePath: string;
  }>,
}));

const skillsLoggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  trace: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => skillsLoggerMock,
}));

vi.mock("../../plugins/bundle-commands.js", () => ({
  loadEnabledClaudeBundleCommands: () => bundleCommandState.entries,
}));

vi.mock("../loading/workspace.js", () => ({
  filterWorkspaceSkillEntriesWithOptions: (entries: SkillEntry[]) => entries,
  loadVisibleWorkspaceSkillEntries: () => [],
}));

beforeEach(() => {
  vi.resetModules();
  bundleCommandState.entries = [];
  skillsLoggerMock.debug.mockClear();
  skillsLoggerMock.trace.mockClear();
});

afterEach(() => {
  bundleCommandState.entries = [];
});

describe("buildWorkspaceSkillCommandSpecs", () => {
  it("uses shared user-invocable skill exposure policy", async () => {
    const { buildWorkspaceSkillCommandSpecs } = await import("./command-specs.js");
    const specs = buildWorkspaceSkillCommandSpecs("/workspace", {
      entries: [
        createFixtureSkillEntry("visible"),
        createFixtureSkillEntry("hidden-by-exposure", {
          exposure: {
            includeInRuntimeRegistry: true,
            includeInAvailableSkillsPrompt: true,
            userInvocable: false,
          },
        }),
        createFixtureSkillEntry("hidden-by-invocation", {
          invocation: {
            userInvocable: false,
            disableModelInvocation: false,
          },
        }),
      ],
    });

    expect(specs.map((spec) => spec.skillName)).toEqual(["visible"]);
  });

  it("preserves workspace skill descriptions for provider-specific limits", async () => {
    const { buildWorkspaceSkillCommandSpecs } = await import("./command-specs.js");
    const prefix = "a".repeat(98);
    const entry = createFixtureSkillEntry("emoji-skill");
    entry.skill.description = `${prefix}😀 extra text beyond the limit`;

    const specs = buildWorkspaceSkillCommandSpecs("/workspace", {
      entries: [entry],
    });

    expect(specs[0]?.description).toBe(entry.skill.description);
    expect(specs[0]?.skillFile).toBe(entry.skill.filePath);
  });

  it("preserves bundle command descriptions for provider-specific limits", async () => {
    const { buildWorkspaceSkillCommandSpecs } = await import("./command-specs.js");
    const prefix = "a".repeat(98);
    const description = `${prefix}😀 extra text beyond the limit`;
    bundleCommandState.entries = [
      {
        pluginId: "bundle-plugin",
        rawName: "bundle-emoji",
        description,
        promptTemplate: "Run the bundled command.",
        sourceFilePath: "/plugins/bundle-plugin/commands/bundle-emoji.md",
      },
    ];

    const specs = buildWorkspaceSkillCommandSpecs("/workspace", {
      entries: [],
    });

    expect(specs[0]).toMatchObject({
      skillName: "bundle-emoji",
      description,
      promptTemplate: "Run the bundled command.",
    });
  });

  it("bounds the skill command debug cache and re-logs evicted keys", async () => {
    const { buildWorkspaceSkillCommandSpecs } = await import("./command-specs.js");
    const entries = [];
    for (let index = 0; index < 1025; index += 1) {
      entries.push({
        pluginId: "bundle-plugin",
        rawName: `raw ${index}`,
        description: "Run the bundled command.",
        promptTemplate: "Run the bundled command.",
        sourceFilePath: `/plugins/bundle-plugin/commands/raw-${index}.md`,
      });
    }

    bundleCommandState.entries = entries;
    buildWorkspaceSkillCommandSpecs("/workspace", { entries: [] });
    expect(skillsLoggerMock.debug).toHaveBeenCalledTimes(1025);

    bundleCommandState.entries = [entries[0]!];
    buildWorkspaceSkillCommandSpecs("/workspace", { entries: [] });
    expect(skillsLoggerMock.debug).toHaveBeenCalledTimes(1026);
  });
});

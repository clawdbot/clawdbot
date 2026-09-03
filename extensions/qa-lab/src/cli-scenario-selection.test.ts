import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runQaProfileCommand, runQaSuiteCommand } = vi.hoisted(() => ({
  runQaProfileCommand: vi.fn(),
  runQaSuiteCommand: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/qa-runner-runtime", () => ({
  listQaRunnerCliContributions: () => [],
}));

vi.mock("./cli.runtime.js", () => ({
  runQaProfileCommand,
  runQaSuiteCommand,
}));

import { registerQaLabCli } from "./cli.js";
import { resolveQaRunProfileMembership } from "./profile-planning.js";
import type { QaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";
import { selectQaFlowSuiteScenarios } from "./suite-planning.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

describe.each(["suite", "profile"] as const)("%s scenario selection", (lane) => {
  let program: Command;
  let selectedScenarioIds: string[];
  let excludedScenarioIds: string[];
  const runCommand = lane === "suite" ? runQaSuiteCommand : runQaProfileCommand;

  beforeEach(() => {
    program = new Command();
    runQaSuiteCommand.mockReset();
    runQaProfileCommand.mockReset();
    registerQaLabCli(program);
    selectedScenarioIds = [];
    excludedScenarioIds = [];
    const scenarios = [
      makeQaSuiteTestScenario("selected-scenario"),
      makeQaSuiteTestScenario("unrequested-scenario"),
    ].map((scenario) => {
      scenario.coverage = { primary: ["test.selection"], secondary: [] };
      return scenario;
    });
    // Keep parsing and selection real; stop before any provider or Gateway execution.
    runCommand.mockImplementation(
      async (opts: {
        profile?: string;
        scenarioIds?: string[];
        providerMode?: string;
        primaryModel?: string;
      }) => {
        if (opts.providerMode !== "mock-openai" || !opts.primaryModel) {
          throw new Error("expected explicit fixture provider and model");
        }
        if (lane === "profile") {
          if (opts.profile !== "selection-profile") {
            throw new Error("expected explicit fixture profile");
          }
          const scenarioRefs = scenarios.map((scenario) => scenario.sourcePath);
          const scorecardReport = {
            taxonomyPath: "taxonomy.yaml",
            title: "Selection fixture",
            taxonomy: { sourcePath: "taxonomy.yaml" },
            profileCount: 1,
            profiles: [
              {
                id: "selection-profile",
                evidenceMode: "full",
                channelDriver: "qa-channel",
                categoryIds: ["test.selection"],
                coverageIds: ["test.selection"],
                scenarioRefs,
              },
            ],
            categoryCount: 1,
            requiredCategoryCount: 1,
            inventoriedCategoryCount: 1,
            categoryInventoryPercent: 100,
            requiredCoverageIdCount: 1,
            inventoriedCoverageIdCount: 1,
            coverageIdInventoryPercent: 100,
            inventoryRefCount: 1,
            scenarioCoverageIdCount: 1,
            unknownCoverageIdCount: 0,
            unknownCoverageIds: [],
            validationIssueCount: 0,
            validationIssues: [],
            categories: [
              {
                id: "test.selection",
                taxonomySurfaceId: "test",
                taxonomyCategoryName: "selection",
                inventoryStatus: "complete",
                profiles: ["selection-profile"],
                features: [{ name: "Selection", coverageIds: ["test.selection"] }],
                coverageIds: ["test.selection"],
                inventoriedCoverageIds: ["test.selection"],
                inventoryRefs: [
                  {
                    coverageId: "test.selection",
                    kind: "qa-scenario",
                    path: null,
                    role: "primary",
                    scenarioRefs,
                  },
                ],
                scenarioRefs,
                missingCoverageIds: [],
                missingInventoryRefs: [],
              },
            ],
          } satisfies QaScorecardTaxonomyReport;
          const membership = resolveQaRunProfileMembership(
            { profile: opts.profile, scenarioIds: opts.scenarioIds },
            { scenarios, scorecardReport },
          );
          selectedScenarioIds = membership.selectedScenarios.map((scenario) => scenario.id);
          excludedScenarioIds = membership.excludedScenarioIds;
          return;
        }
        selectedScenarioIds = selectQaFlowSuiteScenarios({
          scenarios,
          scenarioIds: opts.scenarioIds,
          providerMode: opts.providerMode,
          primaryModel: opts.primaryModel,
        }).map((scenario) => scenario.id);
      },
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const suiteArgs = [
    "node",
    "openclaw",
    "qa",
    ...(lane === "suite" ? ["suite"] : ["run", "--qa-profile", "selection-profile"]),
    "--provider-mode",
    "mock-openai",
    "--model",
    "mock-openai/gpt-5.6-luna",
  ];

  it.each([
    { name: "empty value", args: ["--scenario", ""] },
    { name: "whitespace value", args: ["--scenario", " \t "] },
    { name: "empty assignment", args: ["--scenario="] },
    { name: "repeated blanks", args: ["--scenario", "", "--scenario", "  "] },
  ])("rejects an explicit all-blank selection: $name", async ({ args }) => {
    const error = await program.parseAsync([...suiteArgs, ...args]).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect({ error, selectedScenarioIds }).toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining("--scenario") }),
      selectedScenarioIds: [],
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "omitted selection",
      args: [],
      expected: ["selected-scenario", "unrequested-scenario"],
    },
    {
      name: "named scenario",
      args: ["--scenario", "selected-scenario"],
      expected: ["selected-scenario"],
    },
    {
      name: "trimmed scenario",
      args: ["--scenario", " selected-scenario "],
      expected: ["selected-scenario"],
    },
    {
      name: "valid scenario surrounded by blank values",
      args: ["--scenario", "", "--scenario", "selected-scenario", "--scenario", "  "],
      expected: ["selected-scenario"],
    },
  ])("preserves $name", async ({ args, expected }) => {
    await program.parseAsync([...suiteArgs, ...args]);

    expect(runCommand).toHaveBeenCalledOnce();
    expect(selectedScenarioIds).toEqual(expected);
  });

  it("keeps unknown non-empty ids out of the selection", async () => {
    const parsed = program.parseAsync([...suiteArgs, "--scenario", "unknown-scenario"]);
    if (lane === "suite") {
      await expect(parsed).rejects.toThrow("unknown QA scenario id(s): unknown-scenario");
    } else {
      await parsed;
      expect(excludedScenarioIds).toEqual(["unknown-scenario"]);
    }

    expect(runCommand).toHaveBeenCalledOnce();
    expect(selectedScenarioIds).toEqual([]);
  });

  it("keeps missing option values rejected by Commander before dispatch", async () => {
    const qa = program.commands.find((command) => command.name() === "qa");
    const suite = qa?.commands.find(
      (command) => command.name() === (lane === "suite" ? "suite" : "run"),
    );
    if (!suite) {
      throw new Error("expected QA scenario command");
    }
    suite.exitOverride().configureOutput({ writeErr: () => {} });

    await expect(program.parseAsync([...suiteArgs, "--scenario"])).rejects.toThrow("--scenario");

    expect(runCommand).not.toHaveBeenCalled();
    expect(selectedScenarioIds).toEqual([]);
  });
});

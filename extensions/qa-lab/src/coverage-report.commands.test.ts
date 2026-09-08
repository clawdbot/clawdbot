import { execFileSync } from "node:child_process";
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerQaLabCli } from "./cli.js";
import { findQaScenarioMatches, renderQaScenarioMatchesMarkdownReport } from "./coverage-report.js";
import { defaultQaModelForMode, type QaProviderMode } from "./model-selection.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "./providers/index.js";
import { readQaScenarioById, type QaSeedScenarioWithSource } from "./scenario-catalog.js";
import type { QaScorecardChannelDriver } from "./scorecard-taxonomy.js";
import { selectQaFlowSuiteScenarios } from "./suite-planning.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

vi.mock("openclaw/plugin-sdk/qa-runner-runtime", () => ({
  listQaRunnerCliContributions: () => [],
}));

function captureReportedArgv(command: string): string[] {
  // Previews use POSIX quoting; Windows test hosts need Git Bash's sh on PATH.
  // Capture the shell-expanded arguments without starting pnpm or a QA provider.
  const argv = execFileSync("sh", ["-c", `pnpm() { printf '%s\\0' pnpm "$@"; }\n${command}`], {
    encoding: "utf8",
    timeout: 5_000,
  }).split("\0");
  expect(argv.pop()).toBe("");
  return argv;
}

function selectReportedCommands(scenarios: QaSeedScenarioWithSource[]) {
  const matches = scenarios.flatMap((scenario) => findQaScenarioMatches([scenario], scenario.id));
  const report = renderQaScenarioMatchesMarkdownReport({ query: "selected scenarios", matches });
  const commands = [...report.matchAll(/`(pnpm openclaw qa suite[^`]+)`/gu)];
  expect(commands.length).toBeGreaterThan(0);
  return commands.map(([, command]) => {
    const argv = captureReportedArgv(command!);
    expect(argv.slice(0, 4)).toEqual(["pnpm", "openclaw", "qa", "suite"]);
    const program = new Command();
    registerQaLabCli(program);
    const qa = expectDefined(
      program.commands.find((entry) => entry.name() === "qa"),
      "qa",
    );
    const suite = expectDefined(
      qa.commands.find((entry) => entry.name() === "suite"),
      "suite",
    );
    // Parse the real options without running the suite action or starting a provider.
    expect(suite.parseOptions(argv.slice(4))).toEqual({ operands: [], unknown: [] });
    const opts = suite.opts<{
      scenario: string[];
      channelDriver?: QaScorecardChannelDriver;
      channel?: string;
      providerMode?: QaProviderMode;
    }>();
    expect(opts.scenario.length).toBeGreaterThan(0);
    const providerMode = opts.providerMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE;
    const selected = selectQaFlowSuiteScenarios({
      scenarios,
      scenarioIds: opts.scenario,
      channelDriver: opts.channelDriver,
      channel: opts.channel,
      providerMode,
      primaryModel: defaultQaModelForMode(providerMode),
    });
    expect(
      selected.map(({ id }) => id),
      command,
    ).toEqual(opts.scenario);
    return {
      driver: opts.channelDriver ?? "qa-channel",
      ids: selected.map(({ id }) => id),
    };
  });
}

describe("QA coverage command selection", () => {
  it.each([
    ["telegram-assistant-transcript-role-boundary", "crabline"],
    ["native-command-session-target", "crabline"],
    ["matrix-room-generated-image-delivery", "live"],
    ["remember-across-conversations", "qa-channel"],
    ["whatsapp-access-control-group-disabled", "live"],
    ["instruction-followthrough-repo-contract", "qa-channel"],
    ["agent-startup-instruction-first-action", "qa-channel"],
    ["channel-canary", "qa-channel"],
  ])("selects exactly %s from its generated command", (id, driver) => {
    expect(selectReportedCommands([readQaScenarioById(id)])).toEqual([{ driver, ids: [id] }]);
  });

  it("separates conflicting drivers on the same channel and groups compatible scenarios", () => {
    const scenarios = [
      ...["crabline", "live"].flatMap((requiredChannelDriver) =>
        ["first", "second"].map((suffix) =>
          makeQaSuiteTestScenario(`${requiredChannelDriver}-${suffix}`, {
            channel: "telegram",
            config: { requiredChannelDriver, requiredProviderMode: "mock-openai" },
          }),
        ),
      ),
      makeQaSuiteTestScenario("unconstrained", { channel: "telegram" }),
    ];

    expect(selectReportedCommands(scenarios)).toEqual([
      { driver: "crabline", ids: ["crabline-first", "crabline-second"] },
      { driver: "live", ids: ["live-first", "live-second"] },
      { driver: "live", ids: ["unconstrained"] },
    ]);
  });

  it("preserves a driver requirement without a pinned channel", () => {
    const scenario = makeQaSuiteTestScenario("driver-only", {
      config: { requiredChannelDriver: "crabline" },
    });

    expect(selectReportedCommands([scenario])).toEqual([
      { driver: "crabline", ids: [scenario.id] },
    ]);
  });

  it("keeps a declared driver as one shell argument", () => {
    const requiredChannelDriver = "crabline' ; printf unexpected #";
    const scenario = makeQaSuiteTestScenario("quoted-driver", {
      config: { requiredChannelDriver },
    });
    const report = renderQaScenarioMatchesMarkdownReport({
      query: scenario.id,
      matches: findQaScenarioMatches([scenario], scenario.id),
    });
    const command = expectDefined(report.match(/`(pnpm openclaw qa suite[^`]+)`/u)?.[1], "command");

    expect(captureReportedArgv(command)).toEqual([
      "pnpm",
      "openclaw",
      "qa",
      "suite",
      "--channel-driver",
      requiredChannelDriver,
      "--scenario",
      scenario.id,
    ]);
  });
});

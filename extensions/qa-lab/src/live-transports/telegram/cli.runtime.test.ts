import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTelegramQaTransportAdapter: vi.fn(),
  listTelegramQaScenarios: vi.fn(),
  printLiveTransportQaArtifacts: vi.fn(),
  resolveTelegramQaRunOptions: vi.fn(
    (options: {
      allowFailures?: boolean;
      listScenarios?: boolean;
      primaryModel?: string;
      providerMode?: string;
      repoRoot: string;
    }) => ({
      ...options,
      allowFailures: options.allowFailures ?? false,
      listScenarios: false,
    }),
  ),
  resolveTelegramQaScenarioIds: vi.fn(),
  runQaFlowSuiteFromRuntime: vi.fn(),
}));

vi.mock("../../suite-launch.runtime.js", () => ({
  runQaFlowSuiteFromRuntime: mocks.runQaFlowSuiteFromRuntime,
}));

vi.mock("../shared/live-artifacts.js", () => ({
  printLiveTransportQaArtifacts: mocks.printLiveTransportQaArtifacts,
}));

vi.mock("./adapter.runtime.js", () => ({
  createTelegramQaTransportAdapter: mocks.createTelegramQaTransportAdapter,
}));

vi.mock("./run-options.runtime.js", () => ({
  resolveTelegramQaRunOptions: mocks.resolveTelegramQaRunOptions,
}));

vi.mock("./scenario-selection.js", () => ({
  listTelegramQaScenarios: mocks.listTelegramQaScenarios,
  resolveTelegramQaScenarioIds: mocks.resolveTelegramQaScenarioIds,
}));

import { runQaTelegramCommand, runQaTelegramSuite } from "./cli.runtime.js";

const SUT_COMMAND_ENV = "OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND";

describe("Telegram live QA scenario gate", () => {
  const originalSutCommand = process.env[SUT_COMMAND_ENV];
  let previousExitCode: typeof process.exitCode;
  let tempRoot: string;
  let summaryPath: string;

  function writeSummary(status: string) {
    writeFileSync(
      summaryPath,
      JSON.stringify({
        counts: {
          total: 1,
          passed: status === "pass" ? 1 : 0,
          failed: status === "fail" ? 1 : 0,
          skipped: status === "skip" || status === "skipped" ? 1 : 0,
        },
        scenarios: [{ name: "channel-canary", status }],
      }),
      "utf8",
    );
  }

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();
    delete process.env[SUT_COMMAND_ENV];
    tempRoot = mkdtempSync(path.join(tmpdir(), "openclaw-qa-telegram-gate-"));
    summaryPath = path.join(tempRoot, "qa-suite-summary.json");
    writeSummary("pass");
    mocks.resolveTelegramQaScenarioIds.mockReturnValue(["channel-canary"]);
    mocks.runQaFlowSuiteFromRuntime.mockResolvedValue({
      reportPath: ".artifacts/qa-e2e/telegram/qa-suite-report.md",
      summaryPath,
    });
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    rmSync(tempRoot, { force: true, recursive: true });
  });

  afterAll(() => {
    if (originalSutCommand === undefined) {
      delete process.env[SUT_COMMAND_ENV];
    } else {
      process.env[SUT_COMMAND_ENV] = originalSutCommand;
    }
  });

  it.each(["fail", "skip", "skipped", "timeout"])(
    "fails the live Telegram lane on %s scenarios",
    async (status) => {
      writeSummary(status);

      await runQaTelegramSuite({
        repoRoot: "/repo",
        providerMode: "mock-openai",
      });

      expect(process.exitCode).toBe(1);
    },
  );

  it("leaves the exit code clear when every Telegram scenario passes", async () => {
    writeSummary("pass");

    await runQaTelegramSuite({
      repoRoot: "/repo",
      providerMode: "mock-openai",
    });

    expect(process.exitCode).toBeUndefined();
  });

  it("permits genuinely executed failed scenarios when failures are explicitly allowed", async () => {
    writeSummary("fail");
    await runQaTelegramSuite({
      repoRoot: "/repo",
      providerMode: "mock-openai",
      allowFailures: true,
    });

    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    { summary: "missing", expected: "Could not read QA summary" },
    { summary: "malformed", expected: "Could not parse QA summary" },
    { summary: "zero-work", expected: "did not include any executed scenarios" },
    { summary: "required-skip", expected: "did not include any executed scenarios" },
    { summary: "blocked", expected: "did not include any executed scenarios" },
  ])(
    "rejects $summary Telegram summaries even with --allow-failures",
    async ({ summary, expected }) => {
      if (summary === "missing") {
        rmSync(summaryPath);
      } else if (summary === "malformed") {
        writeFileSync(summaryPath, "{not-json", "utf8");
      } else if (summary === "zero-work") {
        writeFileSync(
          summaryPath,
          JSON.stringify({
            counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
            scenarios: [],
          }),
          "utf8",
        );
      } else {
        writeSummary(summary === "required-skip" ? "skip" : "blocked");
      }

      await expect(
        runQaTelegramSuite({
          repoRoot: "/repo",
          providerMode: "mock-openai",
          allowFailures: true,
        }),
      ).rejects.toThrow(expected);
      expect(process.exitCode).toBeUndefined();
    },
  );

  it("lists only scenarios accepted by its flow runner", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.listTelegramQaScenarios.mockReturnValue([
      {
        id: "channel-message-flows",
        defaultEnabled: true,
        title: "Message flows",
        rationale: "Exercise Telegram message flows",
        regressionRefs: [],
      },
    ]);
    mocks.resolveTelegramQaRunOptions.mockReturnValueOnce({
      allowFailures: false,
      listScenarios: true,
      providerMode: "mock-openai",
      repoRoot: process.cwd(),
    });

    await runQaTelegramSuite({
      listScenarios: true,
      providerMode: "mock-openai",
      repoRoot: process.cwd(),
    });

    const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("channel-message-flows\tdefault\t");
    expect(output).not.toContain("telegram-startup-getme-live");
    expect(mocks.runQaFlowSuiteFromRuntime).not.toHaveBeenCalled();
  });

  it("keeps script scenarios out of the default flow-suite invocation", async () => {
    writeSummary("pass");
    mocks.resolveTelegramQaScenarioIds.mockReturnValue([
      "channel-message-flows",
      "telegram-help-command",
    ]);

    await runQaTelegramSuite({
      allowFailures: true,
      providerMode: "mock-openai",
      repoRoot: process.cwd(),
    });

    expect(mocks.runQaFlowSuiteFromRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioIds: expect.not.arrayContaining(["telegram-startup-getme-live"]),
      }),
    );
  });

  it("lists scenarios against the exact requested model", async () => {
    mocks.resolveTelegramQaRunOptions.mockReturnValueOnce({
      allowFailures: false,
      listScenarios: true,
      primaryModel: "openai/custom-list-model",
      providerMode: "live-frontier",
      repoRoot: process.cwd(),
    });
    mocks.listTelegramQaScenarios.mockReturnValue([]);

    await runQaTelegramSuite({
      listScenarios: true,
      primaryModel: "openai/custom-list-model",
      providerMode: "live-frontier",
      repoRoot: process.cwd(),
    });

    expect(mocks.listTelegramQaScenarios).toHaveBeenCalledWith({
      primaryModel: "openai/custom-list-model",
      providerMode: "live-frontier",
    });
  });

  it("selects scenarios against the exact requested model before suite startup", async () => {
    await runQaTelegramCommand({
      allowFailures: true,
      primaryModel: "openai/custom-selection-model",
      providerMode: "live-frontier",
      repoRoot: process.cwd(),
    });

    expect(mocks.resolveTelegramQaScenarioIds).toHaveBeenCalledWith({
      profile: undefined,
      primaryModel: "openai/custom-selection-model",
      providerMode: "live-frontier",
      scenarioIds: undefined,
    });
    expect(mocks.runQaFlowSuiteFromRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ primaryModel: "openai/custom-selection-model" }),
    );
  });
});

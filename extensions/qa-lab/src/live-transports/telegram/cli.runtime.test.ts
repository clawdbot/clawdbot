import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTelegramQaTransportAdapter: vi.fn(),
  listTelegramQaScenarios: vi.fn(),
  printLiveTransportQaArtifacts: vi.fn(),
  resolveTelegramQaRunOptions: vi.fn(
    (options: { allowFailures?: boolean; providerMode?: string; repoRoot: string }) => ({
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

import { runQaTelegramSuite } from "./cli.runtime.js";

describe("Telegram live QA scenario gate", () => {
  let previousExitCode: typeof process.exitCode;
  let tempRoot: string;
  let summaryPath: string;

  function writeSummary(status: string) {
    writeFileSync(
      summaryPath,
      JSON.stringify({
        counts: {
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
    tempRoot = mkdtempSync(path.join(tmpdir(), "openclaw-qa-telegram-gate-"));
    summaryPath = path.join(tempRoot, "qa-suite-summary.json");
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

  it("does not read the summary when failures are explicitly allowed", async () => {
    await runQaTelegramSuite({
      repoRoot: "/repo",
      providerMode: "mock-openai",
      allowFailures: true,
    });

    expect(process.exitCode).toBeUndefined();
  });

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
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTelegramQaTransportAdapter: vi.fn(),
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
  listTelegramQaScenarios: vi.fn(),
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
});

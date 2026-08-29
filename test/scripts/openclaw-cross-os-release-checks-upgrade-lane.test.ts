import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const mocks = vi.hoisted(() => ({
  ensureLocalNpmShim: vi.fn(),
  installPackageSpec: vi.fn(),
  installTarballPackage: vi.fn(),
  readInstalledMetadata: vi.fn(),
  readInstalledVersion: vi.fn(),
  runAgentTurn: vi.fn(),
  runBundledPluginPostinstall: vi.fn(),
  runDashboardSmoke: vi.fn(),
  runModelsSet: vi.fn(),
  runOnboard: vi.fn(),
  runOpenClaw: vi.fn(),
  startGateway: vi.fn(),
  stopGateway: vi.fn(),
  waitForGateway: vi.fn(),
}));

vi.mock("../../scripts/lib/cross-os-release-checks/install.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../scripts/lib/cross-os-release-checks/install.ts")
  >()),
  ensureLocalNpmShim: mocks.ensureLocalNpmShim,
  installPackageSpec: mocks.installPackageSpec,
  installTarballPackage: mocks.installTarballPackage,
  readInstalledMetadata: mocks.readInstalledMetadata,
  readInstalledVersion: mocks.readInstalledVersion,
  runBundledPluginPostinstall: mocks.runBundledPluginPostinstall,
}));

vi.mock("../../scripts/lib/cross-os-release-checks/runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../scripts/lib/cross-os-release-checks/runtime.ts")
  >()),
  runAgentTurn: mocks.runAgentTurn,
  runDashboardSmoke: mocks.runDashboardSmoke,
  runModelsSet: mocks.runModelsSet,
  runOnboard: mocks.runOnboard,
  runOpenClaw: mocks.runOpenClaw,
  startGateway: mocks.startGateway,
  waitForGateway: mocks.waitForGateway,
}));

vi.mock("../../scripts/lib/cross-os-release-checks/process.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../scripts/lib/cross-os-release-checks/process.ts")
  >()),
  stopGateway: mocks.stopGateway,
}));

import { runUpgradeLane } from "../../scripts/lib/cross-os-release-checks/lanes.ts";

const { createTempDir } = createScriptTestHarness();

const candidate = {
  candidateTgz: "/tmp/openclaw-candidate.tgz",
  candidateVersion: "2026.8.28-beta.1",
  candidateFileName: "openclaw-candidate.tgz",
  sourceDir: "/tmp/source",
  sourceSha: "abc123",
};

let logsDir: string;

function upgradeParams() {
  return {
    baselineSpec: "openclaw@2026.7.1",
    baselineTgz: "",
    build: candidate,
    candidateUrl: "http://127.0.0.1:49951/openclaw-candidate.tgz",
    companions: [],
    logsDir,
    providerConfig: {
      extensionId: "openai",
      secretEnv: "OPENAI_API_KEY",
      authChoice: "openai-api-key",
      model: "openai/gpt-5.6-luna",
      requiredCompanionPackages: [],
    },
    providerSecretValue: "secret",
  };
}

function arrangeSuccessfulLane() {
  mocks.installPackageSpec.mockResolvedValue(undefined);
  mocks.installTarballPackage.mockResolvedValue(undefined);
  mocks.readInstalledVersion
    .mockReturnValueOnce("2026.7.1")
    .mockReturnValue(candidate.candidateVersion);
  mocks.readInstalledMetadata.mockReturnValue({
    version: candidate.candidateVersion,
    commit: candidate.sourceSha,
  });
  mocks.runBundledPluginPostinstall.mockResolvedValue(undefined);
  mocks.runOnboard.mockResolvedValue(undefined);
  mocks.runModelsSet.mockResolvedValue(undefined);
  mocks.startGateway.mockResolvedValue({
    child: {},
    closeLog: vi.fn(),
    launchLogOffset: 0,
    logPath: "/tmp/upgrade-gateway.log",
    waitForClose: vi.fn(),
  });
  mocks.waitForGateway.mockResolvedValue(undefined);
  mocks.runDashboardSmoke.mockResolvedValue(undefined);
  mocks.runAgentTurn.mockResolvedValue({ exitCode: 0, stdout: "OK", stderr: "" });
}

describe("cross-OS packaged upgrade lane evidence", () => {
  beforeEach(() => {
    logsDir = createTempDir("openclaw-upgrade-lane-test-");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
  });

  it("records bounded evidence when the supported Windows timeout fallback succeeds", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    arrangeSuccessfulLane();
    let npmLogPath = "";
    let capturedBeforeFallback = false;
    mocks.runOpenClaw.mockImplementationOnce(async ({ env }) => {
      const npmLogsDir = join(env.LOCALAPPDATA, "npm-cache", "_logs");
      mkdirSync(npmLogsDir, { recursive: true });
      npmLogPath = join(npmLogsDir, "2026-08-29T00_00_00_000Z-debug-0.log");
      writeFileSync(npmLogPath, "0 error code ETIMEDOUT\n1 error token=updater-secret\n");
      throw new Error(
        "Command timed out: C:\\prefix\\node_modules\\openclaw\\openclaw.mjs update --tag http://127.0.0.1:49951/openclaw-candidate.tgz --yes --json --no-restart --timeout 600",
      );
    });
    mocks.installPackageSpec
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        capturedBeforeFallback = readFileSync(join(logsDir, "upgrade-update.log"), "utf8").includes(
          '"errorCodes":["ETIMEDOUT"]',
        );
        writeFileSync(npmLogPath, "0 verbose exit 0\n");
      });

    const result = await runUpgradeLane(upgradeParams());

    expect(result).toMatchObject({
      status: "pass",
      updateFallback: {
        reason: "timeout",
        action: "direct-candidate-install",
      },
      updateTimings: [],
    });
    expect(result.phaseTimings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "update", status: "pass" }),
        expect.objectContaining({ name: "update-fallback-install", status: "pass" }),
      ]),
    );
    expect(capturedBeforeFallback).toBe(true);
    expect(readFileSync(join(logsDir, "upgrade-update.log"), "utf8")).not.toContain(
      "updater-secret",
    );
  });

  it("retains sanitized updater timings when a later upgrade phase fails", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    arrangeSuccessfulLane();
    mocks.runOpenClaw.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        durationMs: 622_000,
        root: String.raw`C:\npm-updater-private-fixture\openclaw`,
        steps: [
          {
            name: "global update",
            command: "npm install --global secret-package",
            durationMs: 461_000,
          },
        ],
      }),
      stderr: "",
    });
    mocks.runBundledPluginPostinstall
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("post-update plugin failure"));

    const result = await runUpgradeLane(upgradeParams());

    expect(result).toMatchObject({
      status: "fail",
      updateTimings: [
        { name: "total", durationMs: 622_000 },
        { name: "package-install", durationMs: 461_000 },
      ],
    });
    expect(result.error).toContain("post-update plugin failure");
    expect(result).not.toHaveProperty("updateFallback");
    expect(result.phaseTimings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "update", status: "pass" }),
        expect.objectContaining({ name: "run-bundled-plugin-postinstall", status: "fail" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("npm-updater-private-fixture");
    expect(JSON.stringify(result)).not.toContain("npm install");
  });
});

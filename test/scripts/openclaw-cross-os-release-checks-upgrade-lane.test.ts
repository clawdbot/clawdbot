import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const mocks = vi.hoisted(() => ({
  ensureLocalNpmShim: vi.fn(),
  ensureDevUpdateGitInstall: vi.fn(),
  installPackageSpec: vi.fn(),
  installTarballPackage: vi.fn(),
  readInstalledMetadata: vi.fn(),
  readInstalledVersion: vi.fn(),
  runAgentTurn: vi.fn(),
  runBundledPluginPostinstall: vi.fn(),
  runDashboardSmoke: vi.fn(),
  runModelsSet: vi.fn(),
  runInstalledModelsSet: vi.fn(),
  runInstallerSmoke: vi.fn(),
  resolveInstallerTargetVersion: vi.fn(),
  runCommand: vi.fn(),
  runOpenClaw: vi.fn(),
  startGateway: vi.fn(),
  stopGateway: vi.fn(),
  waitForGateway: vi.fn(),
  verifyFreshShellCommand: vi.fn(),
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
  runOpenClaw: mocks.runOpenClaw,
  startGateway: mocks.startGateway,
  waitForGateway: mocks.waitForGateway,
}));

vi.mock("../../scripts/lib/cross-os-release-checks/process.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../scripts/lib/cross-os-release-checks/process.ts")
  >()),
  stopGateway: mocks.stopGateway,
  runCommand: mocks.runCommand,
  runCommandInvocation: (invocation: { command: string; args: string[] }, options: unknown) =>
    mocks.runCommand(invocation.command, invocation.args, options),
}));

vi.mock("../../scripts/lib/cross-os-release-checks/installed.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../scripts/lib/cross-os-release-checks/installed.ts")
  >()),
  ensureDevUpdateGitInstall: mocks.ensureDevUpdateGitInstall,
  resolveInstallerTargetVersion: mocks.resolveInstallerTargetVersion,
  runInstalledAgentTurn: mocks.runAgentTurn,
  runInstalledCli: mocks.runOpenClaw,
  runInstalledModelsSet: mocks.runInstalledModelsSet,
  runInstallerSmoke: mocks.runInstallerSmoke,
  startManualGatewayFromInstalledCli: mocks.startGateway,
  verifyFreshShellCommand: mocks.verifyFreshShellCommand,
  waitForInstalledGateway: mocks.waitForGateway,
}));

import {
  runDevUpdateSuite,
  runFreshLane,
  runUpgradeLane,
} from "../../scripts/lib/cross-os-release-checks/lanes.ts";

const { createTempDir, trackTempDir } = createScriptTestHarness();

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
    ref: "main",
    sourceSha: candidate.sourceSha,
    runDiscordRoundtrip: false,
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
  mocks.runCommand.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  mocks.runOpenClaw.mockResolvedValue({ exitCode: 0, stdout: "{}", stderr: "" });
  mocks.resolveInstallerTargetVersion.mockResolvedValue("2026.7.1");
  mocks.runInstallerSmoke.mockImplementation(async ({ lane }) => trackTempDir(lane.rootDir));
  mocks.verifyFreshShellCommand.mockResolvedValue({ cliPath: join(logsDir, "openclaw") });
  mocks.ensureDevUpdateGitInstall.mockResolvedValue({ cliPath: join(logsDir, "openclaw") });
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

describe("cross-OS manual gateway lane evidence", () => {
  beforeEach(() => {
    logsDir = createTempDir("openclaw-upgrade-lane-test-");
    mocks.ensureLocalNpmShim.mockImplementation(({ rootDir }) => trackTempDir(rootDir));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
  });

  describe.each([
    ["fresh", runFreshLane],
    ["upgrade", runUpgradeLane],
    ["dev-update", runDevUpdateSuite],
  ] as const)("%s gateway port ownership", (_name, runLane) => {
    it.each(["success", "onboard", "models-set"] as const)(
      "holds the configured port through setup and releases it after %s",
      async (outcome) => {
        arrangeSuccessfulLane();
        let port = 0;
        const phases: string[] = [];
        mocks.runCommand.mockImplementation(async (_command, args: string[]) => {
          if (args.includes("onboard")) {
            port = Number(args[args.indexOf("--gateway-port") + 1]);
            phases.push("onboard");
            expect(await probeBind(port)).toBe("EADDRINUSE");
            if (outcome === "onboard") {
              throw new Error("injected onboard failure");
            }
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        });
        mocks.runModelsSet.mockImplementation(async ({ lane }) => {
          expect(lane.gatewayPort).toBe(port);
          phases.push("models-set");
          expect(await probeBind(port)).toBe("EADDRINUSE");
          if (outcome === "models-set") {
            throw new Error("injected models-set failure");
          }
        });
        mocks.runInstalledModelsSet.mockImplementation(() =>
          mocks.runModelsSet({ lane: { gatewayPort: port } }),
        );
        mocks.startGateway.mockImplementation(async ({ lane }) => {
          expect(lane.gatewayPort).toBe(port);
          phases.push("start-gateway");
          expect(await probeBind(port)).toBe("available");
          return {
            child: {},
            closeLog: vi.fn(),
            launchLogOffset: 0,
            logPath: join(logsDir, "gateway.log"),
            waitForClose: vi.fn(),
          };
        });

        const result = await runLane(upgradeParams()).catch((error: unknown) => ({
          status: "fail",
          error: String(error),
        }));

        if (outcome === "success") {
          expect(result, JSON.stringify(result)).toMatchObject({ status: "pass" });
          expect(phases).toEqual(["onboard", "models-set", "start-gateway"]);
        } else {
          expect(result).toMatchObject({ status: "fail" });
          expect(result, JSON.stringify(result)).toHaveProperty(
            "error",
            expect.stringContaining(`injected ${outcome} failure`),
          );
          expect(mocks.startGateway).not.toHaveBeenCalled();
        }
        // Failure cleanup and the spawn boundary both relinquish the same port.
        expect(port).toBeGreaterThan(0);
        expect(await probeBind(port)).toBe("available");
      },
    );
  });

  it.each([
    ["pass", 15],
    ["pass", 16],
    ["update refused", 15],
    ["skipped", 15],
  ] as const)(
    "proves stateful 9.2 packaged self-update without direct-install fallback: %s, publication %i",
    async (outcome, publishedVersion) => {
      arrangeSuccessfulLane();
      mocks.readInstalledVersion.mockReset().mockReturnValue("2026.9.2");
      mocks.readInstalledMetadata.mockReturnValue({
        version: "2026.9.3",
        commit: candidate.sourceSha,
      });
      mocks.stopGateway.mockImplementation(async (gateway) => {
        if (gateway) {
          gateway.child.exitCode = 0;
        }
      });
      mocks.runCommand.mockImplementation(async (_command, args: string[]) => {
        const schemaIndex = args.indexOf("schema");
        if (schemaIndex !== -1) {
          const contentVersion = Number(args[schemaIndex + 1]);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              publishedVersion: contentVersion === 15 ? 15 : publishedVersion,
              contentVersion,
            }),
            stderr: "",
          };
        }
        if (args.includes("refusal") || args.includes("receipt")) {
          throw new Error("obsolete external transition assertion");
        }
        return {
          exitCode: 0,
          stdout: args.includes("session-key") ? "agent:main:retained" : "{}",
          stderr: "",
        };
      });
      mocks.runOpenClaw.mockImplementation(async ({ args }: { args: string[] }) => {
        if (args[0] === "update") {
          return {
            exitCode: outcome === "update refused" ? 1 : 0,
            stdout: JSON.stringify({
              status: outcome === "pass" ? "ok" : outcome === "skipped" ? "skipped" : "error",
            }),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: args.includes("system-presence")
            ? JSON.stringify([{ mode: "gateway", reason: "self", version: "2026.9.3" }])
            : "{}",
          stderr: "",
        };
      });
      const result = await runUpgradeLane({
        ...upgradeParams(),
        build: { ...candidate, candidateVersion: "2026.9.3" },
      });
      if (outcome === "pass") {
        expect(result).toMatchObject({
          status: "pass",
          method: "packaged-self-update",
          selfUpdatePassed: true,
          retainedSessionPassed: true,
          persistedCandidateTurnPassed: true,
          schemaAfterUpdate: { publishedVersion, contentVersion: 16 },
          schemaAfterServing: { publishedVersion, contentVersion: 16 },
        });
        expect(mocks.startGateway).toHaveBeenCalledTimes(2);
        expect(
          mocks.runOpenClaw.mock.calls.filter(([call]) => call.args[0] === "agent"),
        ).toHaveLength(2);
      } else {
        expect(result).toMatchObject({
          status: "fail",
          error: expect.stringContaining("packaged self-update"),
        });
      }
      expect(
        mocks.runOpenClaw.mock.calls.filter(([call]) => call.args[0] === "update"),
      ).toHaveLength(1);
      expect(mocks.runOpenClaw.mock.calls.some(([call]) => call.args[0] === "doctor")).toBe(false);
      expect(mocks.installTarballPackage).not.toHaveBeenCalled();
    },
  );

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

async function probeBind(port: number): Promise<string> {
  const server = createServer();
  return await new Promise((resolve) => {
    server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve("available")));
  });
}

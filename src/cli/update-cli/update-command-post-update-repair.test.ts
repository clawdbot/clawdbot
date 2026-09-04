import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import { GATEWAY_SERVICE_SELECTOR_ENV_KEYS } from "../../daemon/constants.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import type { UpdateRepairParams } from "../../infra/update-repair-agent.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
} from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  repair:
    vi.fn<typeof import("../../infra/update-repair-agent.js").prepareUnattendedUpdateRepair>(),
  rollback: vi.fn<typeof import("./update-command-rollback.js").rollbackFailedUpdate>(),
  restart: vi.fn<typeof import("./update-command-service.js").maybeRestartService>(),
  restartCommand:
    vi.fn<typeof import("./update-command-service-command.js").runUpdatedInstallGatewayCommand>(),
  healthy: false,
  version: "2026.9.3",
  stop: vi.fn<
    typeof import("./update-command-service.js").maybeStopManagedServiceBeforeMutableUpdate
  >(),
  readyz: vi.fn(),
  print: vi.fn(),
  revalidate: vi.fn(),
  converge: vi.fn(),
  readService: vi.fn<typeof import("../../daemon/service.js").readGatewayServiceState>(),
  execSchtasks: vi.fn<typeof import("../../daemon/schtasks-exec.js").execSchtasks>(),
}));
vi.mock("../../daemon/schtasks-exec.js", () => ({ execSchtasks: mocks.execSchtasks }));
vi.mock("../../infra/update-repair-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-repair-agent.js")>()),
  prepareUnattendedUpdateRepair: mocks.repair,
}));
vi.mock("./update-command-rollback.js", () => ({ rollbackFailedUpdate: mocks.rollback }));
vi.mock("./progress.js", () => ({ printResult: mocks.print }));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  tryWriteCompletionCache: async () => {},
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: async () => ({ valid: true, config: {} }),
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  readGatewayServiceState: mocks.readService,
}));
vi.mock("../daemon-cli/restart-health-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon-cli/restart-health-probe.js")>()),
  resolveGatewayRestartProbeContext: async () => ({ config: {} }),
  confirmGatewayReachable: async () => ({ reachable: false }),
}));
vi.mock("../daemon-cli/restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: async ({ expectedVersion }: { expectedVersion?: string }) => ({
    healthy: mocks.healthy && mocks.version === expectedVersion,
    runtime: { status: mocks.healthy ? "running" : "stopped", pid: 4321 },
    gatewayVersion: mocks.version,
    expectedVersion,
    versionMismatch: mocks.version !== expectedVersion,
    portUsage: { status: "free", listeners: [] },
    staleGatewayPids: [],
  }),
  waitForGatewayHttpReadiness: mocks.readyz,
}));
vi.mock("./update-command-service-recovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-recovery.js")>()),
  hasLoadedLaunchdKeepAliveSupervisor: async () => false,
}));
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  maybeRestartService: mocks.restart,
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stop,
  revalidateManagedGatewayServiceAfterUpdate: mocks.revalidate,
  resolveUpdatedGatewayRestartPort: async () => 19101,
  tryInstallShellCompletion: async () => {},
}));
vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: mocks.restartCommand,
}));
vi.mock("./update-command-convergence.js", () => ({
  convergeUpdatePlugins: mocks.converge,
}));
vi.mock("./update-command-inference.js", () => ({ runUpdateInferenceProbe: async () => true }));
vi.mock("./update-command-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-result.js")>()),
  writeControlPlaneUpdateRestartSentinelBestEffort: async () => {},
  markControlPlaneUpdateRestartSentinelFailureBestEffort: async () => {},
}));
import { finishUpdate, type FinishUpdateParams } from "./update-command-post-update.js";
import { repairUpdateService } from "./update-command-repair-service.js";
import { revalidateManagedGatewayServiceAfterUpdate } from "./update-command-service-maintenance.js";
import { createWindowsTaskAutoStartRecovery } from "./update-command-windows-task.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture(): FinishUpdateParams {
  const home = dirs.make("post-update-repair-");
  for (const key of [
    "OPENCLAW_HOME",
    "OPENCLAW_SUPERVISOR_MODE",
    ...GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: home });
  const stateDir = path.join(home, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  const env = { ...process.env };
  const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
  return {
    result: {
      status: "ok",
      mode: "npm",
      root: "/candidate",
      steps: [],
      durationMs: 1,
      before: { version: "2026.9.1" },
      after: { version: "2026.9.3" },
    },
    root: "/candidate",
    installKindChanged: false,
    configSnapshot: {
      path: configPath,
      exists: false,
      raw: null,
      parsed: {},
      sourceConfig: asResolvedSourceConfig({}),
      resolved: asResolvedSourceConfig({}),
      valid: true,
      runtimeConfig: asRuntimeConfig({}),
      config: asRuntimeConfig({}),
      issues: [],
      warnings: [],
      legacyIssues: [],
    },
    requestedChannel: null,
    storedChannel: "stable",
    channel: "stable",
    downgradeRisk: false,
    shouldRestart: true,
    opts: { json: true, run },
    ownedManagedUpdateEnv: env,
    preManagedServiceStop: {
      stopped: true,
      running: true,
      inspected: true,
      runtimeInspected: true,
      serviceEnv: env,
      serviceUpdateVerdict: {
        kind: "owned",
        root: "/candidate",
        fingerprint: "fixture",
        refreshDefinition: false,
      },
    },
    controlPlaneUpdateSentinelMeta: null,
    preUpdatePluginInstallRecords: {},
    startedAt: Date.now(),
    updateStepTimeoutMs: 1_000,
    rollbackBlockedReason: "state-migrated-no-rollback",
  };
}

describe("post-activation repair after rollback refusal or failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.healthy = false;
    mocks.version = "2026.9.3";
    mocks.readService.mockResolvedValue({
      installed: true,
      loadState: { status: "loaded" },
      running: false,
      runtime: { status: "stopped" },
      env: process.env,
      command: { programArguments: ["node", "/candidate/dist/entry.js", "gateway"] },
    });
    mocks.converge.mockImplementation(async (params: { result: unknown }) => ({
      resultWithPostUpdate: params.result,
    }));
    mocks.revalidate.mockResolvedValue({
      kind: "owned",
      root: "/candidate",
      fingerprint: "fixture",
      refreshDefinition: false,
    });
    mocks.readyz.mockImplementation(async () => ({ readyz: mocks.healthy ? 200 : 503 }));
    mocks.rollback.mockImplementation(async ({ result, rollbackBlockedReason }) => ({
      result: { ...result, reason: rollbackBlockedReason ?? "source-rollback-failed" },
      rolledBack: false,
    }));
    mocks.restart.mockImplementation(async (params) => {
      if (!mocks.restart.mock.calls.slice(0, -1).length) {
        if (params.opts.run) {
          recordUpdateRunPhase(params.opts.run.runId, "verifying", undefined, {
            env: params.opts.run.env,
          });
        }
        params.onVerificationFailure?.("readyz-unhealthy");
        return false;
      }
      return mocks.healthy;
    });
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  });

  it.each([
    { rollback: "blocked", repaired: true },
    { rollback: "blocked", repaired: false },
    { rollback: "failed", repaired: true },
    { rollback: "failed", repaired: false },
    { rollback: "unavailable", repaired: true },
    { rollback: "unavailable", repaired: false },
    { rollback: "restored", repaired: true },
    { rollback: "restored", repaired: false },
  ])("$rollback rollback with repaired=$repaired", async ({ rollback, repaired }) => {
    const params = fixture();
    if (rollback === "unavailable") {
      params.result.mode = "git";
      params.rollbackBlockedReason = undefined;
      params.schemaVersions = [];
    }
    if (rollback === "failed") {
      params.rollbackBlockedReason = undefined;
      params.packageTransaction = {
        backupRoot: "/backup",
        rollback: vi.fn(),
        complete: vi.fn(async () => {}),
      };
    }
    const run = params.opts.run!;
    const completeRecovery = vi.fn(async () => {});
    if (rollback === "restored") {
      const actual = await vi.importActual<typeof import("./update-command-rollback.js")>(
        "./update-command-rollback.js",
      );
      mocks.rollback.mockImplementation(actual.rollbackFailedUpdate);
      mocks.stop.mockResolvedValue({
        ...params.preManagedServiceStop!,
        windowsTaskAutoStartRecovery: {
          suspended: Promise.resolve(true),
          beginMutation: () => {},
          restore: vi.fn(async () => {}),
          handoff: () => {},
          complete: completeRecovery,
          interrupted: () => false,
        },
      });
      params.root = "/previous";
      params.rollbackBlockedReason = undefined;
      params.previousVerified = true;
      params.schemaVersions = await readUpdateStateSchemaVersions({
        stateDir: run.env.OPENCLAW_STATE_DIR!,
        config: {},
        env: run.env,
      });
      params.packageTransaction = {
        backupRoot: "/backup",
        complete: vi.fn(async () => {}),
        rollback: async () => {
          mocks.version = "2026.9.1";
          return {
            name: "package rollback",
            command: "restore",
            cwd: "/previous",
            exitCode: 0,
            durationMs: 1,
          };
        },
      };
    }
    const activeRoot = rollback === "restored" ? "/previous" : "/candidate";
    mocks.repair.mockImplementation(async (repair: UpdateRepairParams) => {
      expect(repair.context.phase).toBe("verifying");
      expect(repair.target).toMatchObject({
        installRoot: activeRoot,
        stateDir: run.env.OPENCLAW_STATE_DIR,
        configPath: run.env.OPENCLAW_CONFIG_PATH,
      });
      expect(repair.target.candidateRoot).toBeUndefined();
      expect(getUpdateRun(run.runId, { env: run.env })?.phase).toBe("repairing");
      const signal = new AbortController().signal;
      expect((await repair.validate(signal)).ok).toBe(false);
      expect(mocks.restart).toHaveBeenCalledTimes(rollback === "restored" ? 2 : 1);
      repair.onEvent?.({
        type: "turn-started",
        turn: 1,
        model: "gpt-5.6-luna",
        provider: "openai",
      });
      mocks.restartCommand.mockImplementationOnce(async () => {
        mocks.healthy = repaired;
        return repaired;
      });
      const validation = await repair.validate(signal);
      const attempt = {
        turn: 1,
        model: "gpt-5.6-luna",
        provider: "openai",
        durationMs: 20,
        toolCalls: 1,
        summary: "Repaired startup configuration.",
        validation,
      };
      repair.onEvent?.({ type: "turn-finished", ...attempt });
      repair.onEvent?.({ type: "stopped", status: validation.ok ? "repaired" : "unrepaired" });
      return {
        status: validation.ok ? "repaired" : "unrepaired",
        finalValidation: validation,
        attempts: [attempt],
      };
    });
    if (repaired && rollback !== "restored") {
      await expect(finishUpdate(params)).resolves.toMatchObject({ status: "ok" });
    } else {
      await expect(finishUpdate(params)).rejects.toMatchObject({
        exitCode: 1,
        result: {
          status: "error",
          reason: "readyz-unhealthy",
          root: activeRoot,
          after: { version: rollback === "restored" ? "2026.9.1" : "2026.9.3" },
        },
      });
    }
    expect(mocks.converge).toHaveBeenCalledOnce();
    expect(mocks.repair).toHaveBeenCalledOnce();
    if (rollback === "restored") {
      expect(completeRecovery).toHaveBeenCalled();
      if (repaired) {
        expect(completeRecovery).not.toHaveBeenCalledWith(false);
      } else {
        expect(completeRecovery).toHaveBeenCalledWith(false);
      }
    }
    expect(mocks.rollback).toHaveBeenCalledTimes(rollback === "unavailable" ? 0 : 1);
    if (rollback === "unavailable") {
      expect(getUpdateRun(run.runId, { env: run.env })?.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ step: "package rollback", status: "skipped" }),
        ]),
      );
    }
    expect(mocks.restart).toHaveBeenCalledTimes(rollback === "restored" ? 2 : 1);
    expect(mocks.restartCommand).toHaveBeenCalledOnce();
    expect(mocks.restartCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ root: activeRoot }),
        signal: expect.any(AbortSignal),
      }),
      "restart",
      true,
    );
    expect(getUpdateRun(run.runId, { env: run.env })).toMatchObject({
      status: repaired ? (rollback === "restored" ? "rolled-back" : "succeeded") : "failed",
      after: { version: rollback === "restored" ? "2026.9.1" : "2026.9.3" },
      ...(rollback === "restored" ? { reason: "readyz-unhealthy" } : {}),
      repair: [expect.objectContaining({ attempt: 1 })],
      ...(repaired
        ? {
            verification: {
              serviceRunning: true,
              versionMatch: true,
              readyz: true,
              inferenceProbe: "passed",
            },
          }
        : {}),
    });
  });

  it.each(["owner-changed", "aborted"] as const)(
    "does not restart after repair is %s",
    async (fence) => {
      const params = fixture();
      mocks.repair.mockImplementation(async (repair) => {
        const controller = new AbortController();
        const initial = await repair.validate(controller.signal);
        repair.onEvent?.({
          type: "turn-started",
          turn: 1,
          provider: "openai",
          model: "gpt-5.6-luna",
        });
        if (fence === "owner-changed") {
          mocks.revalidate.mockRejectedValueOnce(new Error("Gateway owner changed"));
        } else {
          controller.abort(new Error("repair-budget"));
        }
        await expect(async () => repair.validate(controller.signal)).rejects.toThrow(
          fence === "owner-changed" ? "Gateway owner changed" : "repair-budget",
        );
        repair.onEvent?.({ type: "stopped", status: "aborted", reason: fence });
        return { status: "aborted", attempts: [], finalValidation: initial, reason: fence };
      });
      await expect(finishUpdate(params)).rejects.toMatchObject({
        result: { status: "error", reason: "readyz-unhealthy" },
      });
      expect(mocks.restartCommand).not.toHaveBeenCalled();
      expect(mocks.restart).toHaveBeenCalledOnce();
      const run = params.opts.run!;
      expect(getUpdateRun(run.runId, { env: run.env })).toMatchObject({
        status: "failed",
        repair: [expect.objectContaining({ summary: fence })],
      });
    },
  );

  it.each(["ownership-inspection", "after-enable"] as const)(
    "settles Windows task state when repair aborts during %s",
    async (abortAt) => {
      const params = fixture();
      const env = params.opts.run!.env;
      const root = dirs.make("repair-windows-candidate-");
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
      const state: GatewayServiceState = {
        installed: true,
        loadState: { status: "loaded" },
        running: false,
        runtime: { status: "stopped" },
        env,
        command: { programArguments: ["node", path.join(root, "dist/entry.js"), "gateway"] },
      };
      mocks.readService.mockResolvedValue(state);
      mocks.revalidate.mockImplementation(revalidateManagedGatewayServiceAfterUpdate);
      const expectedService = {
        serviceEnv: env,
        serviceUpdateVerdict: await revalidateManagedGatewayServiceAfterUpdate({ state, root }),
      };
      const controller = new AbortController();
      const inspected = createDeferred();
      const finishInspection = createDeferred();
      const actions: string[] = [];
      let enabled = false;
      mocks.execSchtasks.mockImplementation(async (args) => {
        if (args[0] === "/Query") {
          return {
            code: 0,
            stdout: `<Task><Settings><Enabled>${enabled}</Enabled></Settings></Task>`,
            stderr: "",
          };
        }
        const action = args.at(-1)!;
        actions.push(action);
        enabled = action === "/ENABLE";
        if (enabled && abortAt === "after-enable") {
          controller.abort(new Error("repair-budget"));
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const recovery = createWindowsTaskAutoStartRecovery({
        serviceEnv: env,
        alreadySuspended: true,
      });
      mocks.repair.mockImplementation(async (repair) => {
        const initial = await repair.validate(controller.signal);
        repair.onEvent?.({
          type: "turn-started",
          turn: 1,
          provider: "openai",
          model: "gpt-5.6-luna",
        });
        if (abortAt === "ownership-inspection") {
          mocks.readService.mockResolvedValueOnce(state).mockImplementationOnce(async () => {
            inspected.resolve();
            await finishInspection.promise;
            return state;
          });
        }
        const validation = expect(repair.validate(controller.signal)).rejects.toThrow(
          "repair-budget",
        );
        if (abortAt === "ownership-inspection") {
          await inspected.promise;
          controller.abort(new Error("repair-budget"));
          finishInspection.resolve();
        }
        await validation;
        repair.onEvent?.({ type: "stopped", status: "aborted", reason: "repair-budget" });
        return { status: "aborted", attempts: [], finalValidation: initial };
      });
      try {
        const result = await repairUpdateService({
          result: { ...params.result, root, status: "error", reason: "readyz-unhealthy" },
          root,
          env,
          opts: params.opts,
          gatewayPort: 19101,
          timeoutMs: 1_000,
          expectedService,
          recoveryStop: {
            ...expectedService,
            stopped: true,
            inspected: true,
            runtimeInspected: true,
            running: false,
            windowsTaskAutoStartRecovery: recovery,
          },
        });
        expect(result).toMatchObject({ status: "error", reason: "readyz-unhealthy" });
        expect(actions).toEqual(abortAt === "after-enable" ? ["/ENABLE"] : []);
        await recovery.complete(false);
        expect(enabled).toBe(false);
        expect(actions).toEqual(abortAt === "after-enable" ? ["/ENABLE", "/DISABLE"] : []);
        expect(mocks.restartCommand).not.toHaveBeenCalled();
      } finally {
        finishInspection.resolve();
        await recovery.complete(false);
      }
    },
  );
});

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import { ScheduledTaskAutoStartRecoveryError } from "../../daemon/schtasks-update-recovery.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createRetainedPackageSwap } from "../../infra/package-update-swap.test-support.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  printResult: vi.fn(),
  restartCandidate: vi.fn<typeof import("./update-command-service.js").maybeRestartService>(
    async () => "ok",
  ),
  stopCandidate: vi.fn(),
  restart:
    vi.fn<
      typeof import("./update-command-service.js").maybeRestartServiceAfterFailedMutableUpdate
    >(),
  restoreWindowsAutoStart: vi.fn(async () => true),
  freshProcess: vi.fn(),
  writeSentinel: vi.fn<
    typeof import("./update-command-result.js").writeControlPlaneUpdateRestartSentinelBestEffort
  >(async () => undefined),
}));

vi.mock("./progress.js", () => ({ printResult: mocks.printResult }));
vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: async () => "accepted",
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: async () => ({
    valid: true,
    config: {},
    sourceConfig: {},
    parsed: {},
    warnings: [],
    issues: [],
    legacyIssues: [],
  }),
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  readGatewayServiceState: async () => ({
    installed: true,
    loadState: { status: "loaded" },
    env: {},
    command: { programArguments: ["node", "/repo/dist/entry.js", "gateway"] },
  }),
}));
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  maybeRestartServiceAfterFailedMutableUpdate: mocks.restart,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate: mocks.restoreWindowsAutoStart,
  maybeRestartService: mocks.restartCandidate,
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stopCandidate,
  resolveUpdatedGatewayRestartPort: async () => 19101,
  revalidateManagedGatewayServiceAfterUpdate: async () => ({
    kind: "owned",
    root: "/repo",
    fingerprint: "fixture",
    refreshDefinition: false,
  }),
}));
vi.mock("./update-command-post-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-post-core.js")>()),
  continuePostCoreUpdateInFreshProcess: mocks.freshProcess,
}));
vi.mock("./update-command-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-result.js")>()),
  writeControlPlaneUpdateRestartSentinelBestEffort: mocks.writeSentinel,
}));

import { UpdatePreMutationError } from "./shared.js";
import { finishUpdate } from "./update-command-post-update.js";
import { UpdateCommandFailure } from "./update-command-result.js";

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function failedResult(recovery: UpdateRunResult["recovery"]): UpdateRunResult {
  return {
    status: "error",
    mode: "git",
    reason: "doctor-failed",
    root: "/repo",
    recovery,
    steps: [],
    durationMs: 1,
  };
}

async function finishFailedUpdate(
  result: UpdateRunResult,
  options: {
    failure?: { cause: unknown; detail: string };
    json?: boolean;
    stopped?: boolean;
    run?: FinishUpdateParams["opts"]["run"];
    originalRoot?: string;
    previousInstallRoot?: string;
    packageTransaction?: FinishUpdateParams["packageTransaction"];
    schemaVersions?: FinishUpdateParams["schemaVersions"];
    previousVerified?: boolean;
    windowsTaskAutoStartRecovery?: NonNullable<
      FinishUpdateParams["preManagedServiceStop"]
    >["windowsTaskAutoStartRecovery"];
  } = {},
): Promise<UpdateCommandFailure> {
  return await finishUpdate({
    result,
    ...(options.failure ? { failure: options.failure } : {}),
    root: options.originalRoot ?? result.root ?? "/repo",
    previousInstallRoot: options.previousInstallRoot,
    packageTransaction: options.packageTransaction,
    schemaVersions: options.schemaVersions,
    previousVerified: options.previousVerified,
    installKindChanged: false,
    configSnapshot: {
      path: "/fixture/openclaw.json",
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
    preUpdatePluginInstallRecords: {},
    updateStepTimeoutMs: 1000,
    opts: { json: options.json, run: options.run },
    startedAt: Date.now(),
    preManagedServiceStop: {
      stopped: options.stopped ?? true,
      inspected: true,
      runtimeInspected: true,
      running: true,
      serviceEnv: options.run?.env ?? {},
      windowsTaskAutoStartRecovery: options.windowsTaskAutoStartRecovery,
    },
    controlPlaneUpdateSentinelMeta: null,
  }).then(
    () => {
      throw new Error("Expected failed update finalization to reject");
    },
    (error: unknown) => {
      if (!(error instanceof UpdateCommandFailure)) {
        throw error;
      }
      expect(error.result).toEqual(mocks.printResult.mock.lastCall?.[0]);
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      return error;
    },
  );
}

async function finishSkippedUpdate(reason: string): Promise<UpdateCommandFailure> {
  return await finishFailedUpdate(
    {
      status: "skipped",
      mode: reason === "dirty" || reason === "no-upstream" ? "git" : "unknown",
      reason,
      steps: [],
      durationMs: 1,
    },
    { stopped: false },
  );
}

describe("skipped update exit status", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  });

  it.each([
    ["dirty", 1],
    ["no-upstream", 1],
    ["not-git-install", 1],
    ["already-current", 0],
  ] as const)("handles %s with exit %i", async (reason, exitCode) => {
    const failure = await finishSkippedUpdate(reason);
    expect(failure.exitCode).toBe(exitCode);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });
});

describe("failed update recovery restart", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  });

  it.each(["error", "skipped"] as const)(
    "records the %s outcome before recovery starts the Gateway",
    async (status) => {
      let now = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: tempDirs.make("update-report-before-boot-"),
      };
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      mocks.restart.mockImplementationOnce(async () => {
        expect(mocks.writeSentinel.mock.lastCall?.[0].result).toMatchObject({ status });
        expect(mocks.writeSentinel.mock.lastCall?.[0].result.durationMs).toBe(0);
        expect(mocks.printResult).not.toHaveBeenCalled();
        if (status === "error") {
          expect(getUpdateRun(run.runId, { env })?.origin.nextAction).toContain("triage");
        }
        now += 200;
      });

      await finishFailedUpdate(
        { ...failedResult({ serviceRestartSafe: true, version: "1.0.0" }), status },
        { run },
      );

      expect(mocks.restart).toHaveBeenCalledOnce();
      expect(mocks.writeSentinel).toHaveBeenCalledOnce();
      expect(mocks.writeSentinel.mock.lastCall?.[0].result.durationMs).toBe(0);
      expect(mocks.printResult).toHaveBeenCalledOnce();
      expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({ status, durationMs: 200 });
    },
  );

  it.each(
    (
      [
        { mode: "git", status: "error", reason: "doctor-failed" },
        { mode: "git", status: "skipped", reason: "dirty" },
        { mode: "pnpm", status: "error", reason: "global install swap" },
      ] as const
    ).flatMap(({ mode, status, reason }) =>
      (["healthy", "failed"] as const).map((service) => ({ mode, status, reason, service })),
    ),
  )(
    "reports the terminal $service recovery for a $mode $status update",
    async ({ mode, status, reason, service }) => {
      mocks.restart.mockResolvedValueOnce(service);
      const failure = await finishFailedUpdate(
        {
          ...failedResult({ serviceRestartSafe: true, version: "1.0.0" }),
          mode,
          status,
          reason,
          steps: [
            {
              name: reason,
              command: "update",
              cwd: "/repo",
              durationMs: 1,
              exitCode: status === "skipped" ? null : 1,
            },
          ],
        },
        { json: true },
      );
      expect(mocks.restart).toHaveBeenCalledOnce();
      expect(mocks.restart).toHaveBeenCalledWith(
        expect.objectContaining({
          recovery: { serviceRestartSafe: true, version: "1.0.0" },
        }),
      );
      expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({
        status: service === "failed" ? "error" : status,
        recovery: { serviceRestartSafe: true, version: "1.0.0", service },
      });
      expect(failure.exitCode).toBe(1);
    },
  );

  it("does not turn missing producer safety into restart permission", async () => {
    await finishFailedUpdate(failedResult(undefined));
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it("retains structured mutation errors without authorizing service recovery", async () => {
    const restoreError = new Error("task enable denied");
    const original = new ScheduledTaskAutoStartRecoveryError(
      [new Error("service stop failed"), restoreError],
      "Native preparation and compensation failed",
      { OPENCLAW_STATE_DIR: "/fixture/state" },
    );
    const detail = formatErrorMessage(original);
    const failure = await finishFailedUpdate(
      {
        ...failedResult({ serviceRestartSafe: false, reason: "runtime-verification-failed" }),
        reason: "update-failed",
        steps: [
          {
            name: "update",
            command: "openclaw update",
            cwd: "/repo",
            durationMs: 1,
            exitCode: 1,
            stderrTail: detail,
          },
        ],
      },
      { failure: { cause: original, detail } },
    );
    expect(failure.cause).toBe(original);
    expect(original.cause).toBe(restoreError);
    expect(failure.detail).toContain(restoreError.message);
    expect(failure.detail).toBe(detail);
    expect(failure.exitCode).toBe(1);
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it.each([
    { status: "error", recovery: undefined },
    { status: "skipped", recovery: undefined },
    {
      status: "error",
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    },
    {
      status: "skipped",
      recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
    },
  ] as const)(
    "does not re-enable Windows autostart without verified safety ($status, $recovery)",
    async ({ status, recovery }) => {
      const complete = vi.fn(async () => {});
      const restore = vi.fn();
      await finishFailedUpdate(
        {
          ...failedResult(recovery),
          status,
        },
        {
          windowsTaskAutoStartRecovery: {
            suspended: Promise.resolve(true),
            beginMutation: () => {},
            restore,
            handoff: () => {},
            complete,
            interrupted: () => false,
          },
        },
      );
      expect(restore).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledWith(false);
    },
  );

  it("leaves a managed Gateway stopped after unverified rollback recovery", async () => {
    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "runtime-verification-failed" }),
    );

    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it("does not restart when the mutation owner returned no recovery verdict", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
    const failure = await finishFailedUpdate(failedResult(undefined), {
      json: true,
      stopped: false,
    });
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(failure.exitCode).toBe(79);
  });

  it.each([
    { handoff: false, restoreFails: false, safe: false, stopped: true, expected: 1 },
    { handoff: true, restoreFails: false, safe: false, stopped: true, expected: 79 },
    { handoff: true, restoreFails: false, safe: false, stopped: false, expected: 79 },
    { handoff: true, restoreFails: true, safe: false, stopped: true, expected: 79 },
    {
      handoff: true,
      restoreFails: true,
      safe: true,
      stopped: true,
      expected: 79,
      mutationFailed: true,
    },
    { handoff: true, restoreFails: false, safe: true, stopped: true, expected: 1 },
    { handoff: true, restoreFails: false, safe: true, stopped: false, expected: 1 },
    { handoff: true, restoreFails: true, safe: true, stopped: false, expected: 79 },
  ])(
    "preserves the final restart verdict ($handoff, $restoreFails, $safe, $stopped)",
    async ({ handoff, restoreFails, safe, stopped, expected, mutationFailed }) => {
      vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", handoff ? "1" : undefined);
      const restoreError = new Error("restore failed");
      if (restoreFails) {
        mocks.restoreWindowsAutoStart.mockRejectedValueOnce(restoreError);
      }
      const original = mutationFailed
        ? new UpdatePreMutationError("database-schema-preflight", "target schema is incompatible")
        : undefined;
      const result = failedResult(
        safe
          ? { serviceRestartSafe: true, version: "1.0.0" }
          : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      );
      if (original) {
        result.reason = original.reason;
      }
      const failure = await finishFailedUpdate(result, {
        json: true,
        stopped,
        ...(original ? { failure: { cause: original, detail: formatErrorMessage(original) } } : {}),
      });
      expect(failure.exitCode).toBe(expected);
      expect(mocks.restart).toHaveBeenCalledTimes(safe && !restoreFails ? 1 : 0);
      expect(mocks.writeSentinel.mock.lastCall?.[0].result.recovery?.serviceRestartSafe).toBe(
        safe && !restoreFails,
      );
      expect(mocks.restoreWindowsAutoStart).toHaveBeenCalledTimes(safe ? 1 : 0);
      expect(mocks.printResult).toHaveBeenCalledOnce();
      expect(mocks.writeSentinel).toHaveBeenCalledOnce();
      if (safe && restoreFails) {
        expect(failure.detail).toContain(restoreError.message);
        expect(failure.detail).toContain(result.reason);
        if (original) {
          const combined = failure.cause;
          expect(combined).toBeInstanceOf(AggregateError);
          if (!(combined instanceof AggregateError)) {
            throw new Error("Expected both original and restoration failures");
          }
          expect(combined.errors).toEqual([original, restoreError]);
          expect(combined.cause).toBe(restoreError);
          expect(failure.detail).toContain(original.message);
        } else {
          expect(failure.cause).toBe(restoreError);
        }
      }
    },
  );

  it.each([79, 80])(
    "does not restart again after post-activation convergence exits %s",
    async (childExitCode) => {
      mocks.restartCandidate.mockResolvedValueOnce("ok");
      vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
      const detail = "Fresh Doctor could not persist the migrated config.";
      mocks.freshProcess.mockResolvedValueOnce({
        resumed: false,
        exitCode: childExitCode,
        error: detail,
      });
      const failure = await finishFailedUpdate(
        { status: "ok", mode: "npm", root: "/repo", steps: [], durationMs: 1 },
        { json: true },
      );
      expect(failure.exitCode).toBe(79);
      expect(failure.detail).toBe(detail);
      expect(failure.result).toMatchObject({
        status: "error",
        reason: "post-core-update-failed",
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      });
      expect(mocks.restartCandidate).toHaveBeenCalledOnce();
      expect(mocks.restoreWindowsAutoStart).toHaveBeenCalledOnce();
      expect(mocks.restart).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "persists the owned profile and observed service stop in recovery guidance (stopped=%s)",
    async (stopped) => {
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: tempDirs.make("update-report-recovery-"),
        OPENCLAW_PROFILE: "work",
      };
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      await finishFailedUpdate(
        failedResult({ serviceRestartSafe: false, reason: "rollback-checkout-dirty" }),
        { stopped, run },
      );

      const nextAction = getUpdateRun(run.runId, { env })?.origin.nextAction;
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(nextAction).toContain("Run `openclaw --profile work triage`");
      expect(nextAction?.includes("Keep the gateway stopped")).toBe(stopped);
      expect(mocks.printResult.mock.lastCall?.[2]).toEqual({ nextAction });
    },
  );

  it("keeps structured JSON recovery free of prose guidance", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    const result = failedResult({
      serviceRestartSafe: false,
      reason: "rollback-checkout-dirty",
    });

    await finishFailedUpdate(result, { json: true });

    expect(mocks.printResult).toHaveBeenCalledWith(
      expect.objectContaining({ ...result, durationMs: expect.any(Number) }),
      expect.objectContaining({ json: true }),
      expect.objectContaining({ nextAction: expect.any(String) }),
    );
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("failed package update recovery safety", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  });

  it("retains and reports the recovery backup after an older-target backup move partially fails", async () => {
    const base = tempDirs.make("update-older-target-backup-");
    const { result, transaction, packageRoot } = await createRetainedPackageSwap(base, true);
    const backupRuntime = path.join(transaction.backupRoot, "dist", "index.js");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(base, "state") };
    const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    expect(result.activePackageRoot).toBeNull();
    await expect(fs.readFile(backupRuntime, "utf8")).resolves.toBe("export {};\n");

    const failure = await finishFailedUpdate(
      {
        status: "error",
        mode: "npm",
        reason: result.step.name,
        root: result.activePackageRoot ?? undefined,
        before: { version: "1.0.0" },
        steps: [result.step],
        durationMs: 1,
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      },
      {
        run,
        originalRoot: packageRoot,
        packageTransaction: transaction,
        schemaVersions: undefined,
        stopped: false,
      },
    );

    await expect(fs.readFile(backupRuntime, "utf8")).resolves.toBe("export {};\n");
    expect(failure.result.root).toBeUndefined();
    expect(failure.result.recovery?.serviceRestartSafe).toBe(false);
    expect(getUpdateRun(run.runId, { env })?.status).toBe("failed");
    expect(failure.result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stderrTail: expect.stringContaining(transaction.backupRoot) }),
      ]),
    );
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.restartCandidate).not.toHaveBeenCalled();
  });

  it("restores the managed install root and keeps its backup until rolled-back is durable", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("update-managed-rollback-") };
    const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    const schemaVersions = await readUpdateStateSchemaVersions({
      stateDir: env.OPENCLAW_STATE_DIR,
      config: {},
      env,
    });
    const originalRoot = "/managed/previous";
    mocks.stopCandidate.mockResolvedValueOnce({
      stopped: true,
      inspected: true,
      runtimeInspected: true,
      running: true,
      serviceEnv: env,
      serviceUpdateVerdict: {
        kind: "owned",
        root: process.cwd(),
        fingerprint: "fixture",
        refreshDefinition: true,
      },
    });
    mocks.restartCandidate.mockResolvedValueOnce("ok");
    const rollback = vi.fn(async () => ({
      name: "package rollback",
      activePackageRoot: originalRoot,
      command: "restore",
      cwd: originalRoot,
      exitCode: 0,
      durationMs: 1,
    }));
    let cleanupStatus: string | undefined;
    const complete = vi.fn(async () => {
      cleanupStatus = getUpdateRun(run.runId, { env })?.status;
    });
    const failure = await finishFailedUpdate(
      {
        status: "error",
        mode: "pnpm",
        root: process.cwd(),
        before: { version: "2026.9.1" },
        after: { version: "2026.9.3" },
        reason: "version-mismatch",
        steps: [],
        durationMs: 1,
      },
      {
        run,
        originalRoot,
        previousInstallRoot: "/shell/unrelated",
        schemaVersions,
        previousVerified: true,
        packageTransaction: { backupRoot: "/managed/backup", rollback, complete },
      },
    );
    expect(failure.result).toMatchObject({ root: originalRoot, after: { version: "2026.9.1" } });
    expect(mocks.restartCandidate.mock.lastCall?.[0]).toMatchObject({
      result: { root: originalRoot, after: { version: "2026.9.1" } },
    });
    expect(rollback).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(cleanupStatus).toBe("rolled-back");
  });

  it.each([
    "global install verify",
    "global install swap",
    "pnpm package lifecycle marker",
    "pnpm package preinstall",
    "pnpm package postinstall",
    "pnpm package lifecycle finalize",
  ])("keeps the replaced package stopped after %s fails", async (name) => {
    const failure = await finishFailedUpdate({
      status: "error",
      mode: name.startsWith("pnpm ") ? "pnpm" : "npm",
      reason: "global-install-failed",
      steps: [
        { name: "global update", command: "npm", cwd: "/", durationMs: 1, exitCode: 0 },
        {
          name,
          command: "verify",
          cwd: "/",
          durationMs: 1,
          exitCode: 1,
        },
      ],
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      durationMs: 1,
    });
    expect(failure.exitCode).toBe(1);

    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.restartCandidate).not.toHaveBeenCalled();
  });

  it("does not start a Doctor-rejected candidate even after a verified swap", async () => {
    const failure = await finishFailedUpdate({
      status: "error",
      mode: "npm",
      reason: "doctor-failed",
      steps: [
        { name: "global update", command: "npm", cwd: "/", durationMs: 1, exitCode: 0 },
        { name: "openclaw doctor", command: "doctor", cwd: "/", durationMs: 1, exitCode: 1 },
      ],
      recovery: {
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
        packageRollbackVerified: true,
      },
      durationMs: 1,
    });
    expect(failure.exitCode).toBe(1);

    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.writeSentinel.mock.lastCall?.[0].result.recovery).toEqual({
      serviceRestartSafe: false,
      reason: "runtime-verification-failed",
      packageRollbackVerified: true,
    });
  });
});

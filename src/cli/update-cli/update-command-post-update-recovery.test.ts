import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  printResult: vi.fn(),
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
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  maybeRestartServiceAfterFailedMutableUpdate: mocks.restart,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate: mocks.restoreWindowsAutoStart,
}));
vi.mock("./update-command-post-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-post-core.js")>()),
  continuePostCoreUpdateInFreshProcess: mocks.freshProcess,
}));
vi.mock("./update-command-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-result.js")>()),
  writeControlPlaneUpdateRestartSentinelBestEffort: mocks.writeSentinel,
}));

import { finishUpdate, type UpdateCommandOutcome } from "./update-command-post-update.js";

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];

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
    json?: boolean;
    stopped?: boolean;
    windowsTaskAutoStartRecovery?: NonNullable<
      FinishUpdateParams["preManagedServiceStop"]
    >["windowsTaskAutoStartRecovery"];
  } = {},
): Promise<UpdateCommandOutcome> {
  return await finishUpdate({
    result,
    root: result.root ?? "/repo",
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
    opts: { json: options.json },
    showProgress: false,
    startedAt: Date.now(),
    preManagedServiceStop: {
      stopped: options.stopped ?? true,
      inspected: true,
      runtimeInspected: true,
      running: true,
      serviceEnv: {},
      windowsTaskAutoStartRecovery: options.windowsTaskAutoStartRecovery,
    },
    controlPlaneUpdateSentinelMeta: null,
  });
}

async function finishSkippedUpdate(reason: string): Promise<UpdateCommandOutcome> {
  return await finishFailedUpdate(
    {
      status: "skipped",
      mode: reason === "dirty" ? "git" : "unknown",
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
    ["not-git-install", 0],
  ] as const)("handles %s with exit %i", async (reason, exitCode) => {
    const outcome = await finishSkippedUpdate(reason);
    if (reason === "dirty") {
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("Update blocked: local files are edited"),
      );
    }
    expect(outcome.exitCode).toBe(exitCode);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });
});

describe("failed Git update recovery restart", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  });

  it.each(["error", "skipped"] as const)(
    "records the %s outcome before recovery starts the Gateway",
    async (status) => {
      let now = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      mocks.restart.mockImplementationOnce(async () => {
        expect(mocks.writeSentinel.mock.lastCall?.[0].result).toMatchObject({ status });
        expect(mocks.writeSentinel.mock.lastCall?.[0].result.durationMs).toBe(0);
        expect(mocks.printResult).not.toHaveBeenCalled();
        now += 200;
      });

      await finishFailedUpdate({
        ...failedResult({ serviceRestartSafe: true, version: "1.0.0" }),
        status,
      });

      expect(mocks.restart).toHaveBeenCalledOnce();
      expect(mocks.writeSentinel).toHaveBeenCalledOnce();
      expect(mocks.writeSentinel.mock.lastCall?.[0].result.durationMs).toBe(0);
      expect(mocks.printResult).toHaveBeenCalledOnce();
      expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({ status, durationMs: 200 });
    },
  );

  it.each(
    (["error", "skipped"] as const).flatMap((status) =>
      (["healthy", "failed"] as const).map((service) => ({ status, service })),
    ),
  )("reports the terminal $service recovery for a $status update", async ({ status, service }) => {
    mocks.restart.mockResolvedValueOnce(service);
    const outcome = await finishFailedUpdate(
      {
        ...failedResult({ serviceRestartSafe: true, version: "1.0.0" }),
        status,
      },
      { json: true },
    );
    expect(mocks.restart).toHaveBeenCalledOnce();
    expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({
      status: service === "failed" ? "error" : status,
      recovery: { serviceRestartSafe: true, version: "1.0.0", service },
    });
    expect(outcome.exitCode).toBe(status === "skipped" && service === "healthy" ? 0 : 1);
  });

  it("does not turn missing producer safety into restart permission", async () => {
    await finishFailedUpdate(failedResult(undefined));
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
      const complete = vi.fn();
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
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "runtime-verification-failed" }),
    );

    expect(mocks.restart).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Managed gateway remains stopped"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Run `openclaw triage`"));
  });

  it("does not restart when the mutation owner returned no recovery verdict", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
    const outcome = await finishFailedUpdate(failedResult(undefined), {
      json: true,
      stopped: false,
    });
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(outcome.exitCode).toBe(79);
  });

  it.each([
    { handoff: false, restoreFails: false, safe: false, expected: 1 },
    { handoff: true, restoreFails: false, safe: false, expected: 79 },
    { handoff: true, restoreFails: true, safe: true, expected: 79 },
    { handoff: true, restoreFails: false, safe: true, expected: 1 },
  ])(
    "delegates only verified, unhandled recovery ($handoff, $restoreFails, $safe, $stopped)",
    async ({ handoff, restoreFails, safe, expected }) => {
      vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", handoff ? "1" : undefined);
      if (restoreFails) {
        mocks.restoreWindowsAutoStart.mockRejectedValueOnce(new Error("restore failed"));
      }
      const outcome = await finishFailedUpdate(
        failedResult(
          safe
            ? { serviceRestartSafe: true, version: "1.0.0" }
            : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        ),
        { json: true, stopped: true },
      );
      expect(outcome.exitCode).toBe(expected);
      expect(mocks.restart).toHaveBeenCalledTimes(safe && !restoreFails ? 1 : 0);
      expect(mocks.writeSentinel.mock.lastCall?.[0].result.recovery?.serviceRestartSafe).toBe(
        safe && !restoreFails,
      );
    },
  );

  it("preserves a fresh child's unsafe exit without re-enabling Windows autostart", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
    mocks.freshProcess.mockResolvedValueOnce({ resumed: false, exitCode: 79 });
    const outcome = await finishUpdate({
      result: { status: "ok", mode: "npm", root: "/repo", steps: [], durationMs: 1 },
      root: "/repo",
      configSnapshot: { valid: false },
      opts: { json: true },
      showProgress: false,
      startedAt: Date.now(),
      controlPlaneUpdateSentinelMeta: undefined,
    } as unknown as FinishUpdateParams);
    expect(outcome.exitCode).toBe(79);
    expect(mocks.restoreWindowsAutoStart).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it("routes a dirty rollback checkout into triage", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "rollback-checkout-dirty" }),
    );

    const output = log.mock.calls.flat().map(String).join("\n");
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(output).toContain("Run `openclaw triage`");
    expect(output).toContain("diagnose and repair the installation");
    expect(output).toContain("Keep the gateway stopped until the update succeeds");
  });

  it("preserves the active profile in unsafe recovery guidance", async () => {
    vi.stubEnv("OPENCLAW_PROFILE", "work");
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "rollback-checkout-dirty" }),
    );

    const output = log.mock.calls.flat().map(String).join("\n");
    expect(output).toContain("Run `openclaw --profile work triage`");
    expect(output).not.toContain("Run `openclaw triage`");
  });

  it("does not claim an unsafe recovery stopped a service that was already down", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "rollback-checkout-dirty" }),
      { stopped: false },
    );

    const output = log.mock.calls.flat().map(String).join("\n");
    expect(output).toContain("Update recovery could not prove a runnable installation");
    expect(output).toContain("Run `openclaw triage`");
    expect(output).not.toContain("remains stopped");
    expect(output).not.toContain("Keep the gateway stopped");
  });

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

  it.each([
    "global install verify",
    "pnpm package lifecycle marker",
    "pnpm package preinstall",
    "pnpm package postinstall",
    "pnpm package lifecycle finalize",
  ])("keeps the replaced package stopped after %s fails", async (name) => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishUpdate({
      result: {
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
      },
      opts: {},
      showProgress: false,
      startedAt: Date.now(),
      preManagedServiceStop: { stopped: true, serviceEnv: {} },
      controlPlaneUpdateSentinelMeta: undefined,
    } as unknown as FinishUpdateParams);

    expect(mocks.restart).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Managed gateway remains stopped"));
  });

  it("does not start a Doctor-rejected candidate even after a verified swap", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishUpdate({
      result: {
        status: "error",
        mode: "npm",
        reason: "doctor-failed",
        steps: [
          { name: "global update", command: "npm", cwd: "/", durationMs: 1, exitCode: 0 },
          { name: "openclaw doctor", command: "doctor", cwd: "/", durationMs: 1, exitCode: 1 },
        ],
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        durationMs: 1,
      },
      opts: {},
      showProgress: false,
      startedAt: Date.now(),
      preManagedServiceStop: { stopped: true, serviceEnv: {} },
      controlPlaneUpdateSentinelMeta: undefined,
    } as unknown as FinishUpdateParams);

    expect(mocks.restart).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Managed gateway remains stopped"));
  });
});

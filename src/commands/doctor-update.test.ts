// Doctor update tests cover pre-doctor update prompts, state files, and declined update flows.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-maintenance.js";
import { mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import type { UpdateRecovery } from "../infra/update-recovery.js";
import { defaultRuntime, ExitError, type RuntimeEnv } from "../runtime.js";
import { EXTERNAL_SERVICE_REPAIR_NOTE } from "./doctor-service-repair-policy.js";
import { maybeOfferUpdateBeforeDoctor } from "./doctor-update.js";

const originalStdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalStdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const originalServiceRepairPolicy = process.env.OPENCLAW_SERVICE_REPAIR_POLICY;

const mocks = vi.hoisted(() => ({
  createUpdateProgress: vi.fn(),
  gitMutationPolicy: vi.fn(),
  maybeRestartServiceAfterFailedMutableUpdate: vi.fn(),
  maybeStopManagedServiceBeforeMutableUpdate: vi.fn(),
  note: vi.fn(),
  readGatewayServiceState: vi.fn(),
  revalidateManagedGatewayServiceAfterUpdate: vi.fn(),
  restartUpdatedGateway: vi.fn(),
  stopGatewayService: vi.fn(),
  waitForHealthyRestart: vi.fn(),
  doctorCommand: vi.fn(),
  createUpdateConfigSnapshot: vi.fn(),
  createServiceConfigIO: vi.fn(),
  resolveGatewayService: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  runGatewayUpdate: vi.fn(),
  triageCommand: vi.fn<typeof import("./triage.js").triageCommand>(),
}));

vi.mock("../cli/update-cli/progress.js", () => ({
  createUpdateProgress: mocks.createUpdateProgress,
}));

vi.mock("../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: async (root: string) => `${root}/dist/index.js`,
}));
vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate: mocks.runGatewayUpdate,
}));

vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  createConfigIO: mocks.createServiceConfigIO,
}));

vi.mock("../cli/update-cli/managed-gateway-update.runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../cli/update-cli/update-command-service.js")>(
    "../cli/update-cli/update-command-service.js",
  )),
  maybeRestartServiceAfterFailedMutableUpdate: mocks.maybeRestartServiceAfterFailedMutableUpdate,
  maybeStopManagedServiceBeforeMutableUpdate: mocks.maybeStopManagedServiceBeforeMutableUpdate,
  revalidateManagedGatewayServiceAfterUpdate: mocks.revalidateManagedGatewayServiceAfterUpdate,
}));

vi.mock("./doctor.js", () => ({ doctorCommand: mocks.doctorCommand }));
vi.mock("./triage.js", () => ({ triageCommand: mocks.triageCommand }));
vi.mock("../cli/daemon-cli.js", () => ({
  runDaemonInstall: vi.fn(),
  runDaemonRestart: vi.fn(),
}));
vi.mock("../cli/update-cli/update-command-config.js", () => ({
  createUpdateConfigSnapshot: mocks.createUpdateConfigSnapshot,
}));
vi.mock("../cli/daemon-cli/restart-health.js", () => ({
  waitForGatewayHealthyRestart: mocks.waitForHealthyRestart,
  renderRestartDiagnostics: () => ["gateway not ready"],
  terminateStaleGatewayPids: vi.fn(),
}));
vi.mock("../cli/update-cli/update-command-launch-agent-recovery.js", () => ({
  recoverInstalledLaunchAgentAfterUpdate: async () => ({ attempted: false, recovered: false }),
}));

vi.mock("../daemon/service.js", () => ({
  readGatewayServiceState: mocks.readGatewayServiceState,
  resolveGatewayService: mocks.resolveGatewayService,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: mocks.note,
}));

function createManagedDoctorEnvironment(): NodeJS.ProcessEnv {
  const stateDir = path.join(os.homedir(), ".openclaw-work");
  return {
    OPENCLAW_PROFILE: "work",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  };
}

async function runOffer(params?: {
  root?: string;
  confirm?: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
  runtime?: RuntimeEnv;
}): Promise<Awaited<ReturnType<typeof maybeOfferUpdateBeforeDoctor>>> {
  const confirm = params?.confirm ?? vi.fn().mockResolvedValue(false);
  return await maybeOfferUpdateBeforeDoctor({
    runtime: params?.runtime ?? {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    },
    options: {},
    root: params?.root ?? "/repo/link",
    confirm,
    outro: vi.fn(),
  });
}

beforeEach(async () => {
  mocks.createUpdateProgress.mockReset();
  mocks.createUpdateProgress.mockReturnValue({ progress: {}, stop: vi.fn() });
  mocks.gitMutationPolicy.mockReset();
  mockSystemAccountHome();
  mocks.maybeRestartServiceAfterFailedMutableUpdate.mockReset();
  mocks.maybeStopManagedServiceBeforeMutableUpdate.mockReset();
  mocks.note.mockReset();
  mocks.readGatewayServiceState.mockReset();
  mocks.revalidateManagedGatewayServiceAfterUpdate.mockReset();
  mocks.restartUpdatedGateway.mockReset();
  mocks.stopGatewayService.mockReset();
  mocks.resolveGatewayService.mockReset();
  mocks.runCommandWithTimeout.mockReset();
  mocks.runGatewayUpdate.mockReset();
  mocks.triageCommand.mockReset().mockResolvedValue(undefined);
  mocks.resolveGatewayService.mockReturnValue({
    restart: vi.fn(),
    start: vi.fn(),
    isLoaded: async () => false,
  });
  mocks.readGatewayServiceState.mockResolvedValue({ env: createManagedDoctorEnvironment() });
  mocks.revalidateManagedGatewayServiceAfterUpdate.mockImplementation(
    async ({ preManagedServiceStop }) => preManagedServiceStop.serviceUpdateVerdict,
  );
  mocks.waitForHealthyRestart.mockReset().mockResolvedValue({
    healthy: true,
    runtime: { status: "running" },
    staleGatewayPids: [],
    gatewayVersion: "2026.4.24",
  });
  mocks.doctorCommand.mockReset();
  mocks.createUpdateConfigSnapshot.mockReset().mockResolvedValue(undefined);
  mocks.createServiceConfigIO
    .mockReset()
    .mockReturnValue({ readBestEffortConfig: async () => ({}) });
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  mocks.maybeStopManagedServiceBeforeMutableUpdate.mockResolvedValue({
    stopped: false,
    inspected: true,
    runtimeInspected: true,
    running: false,
    serviceUpdateVerdict: { kind: "absent" },
  });
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (originalStdinIsTtyDescriptor) {
    Object.defineProperty(process.stdin, "isTTY", originalStdinIsTtyDescriptor);
  } else {
    delete (process.stdin as Partial<typeof process.stdin>).isTTY;
  }
  if (originalStdoutIsTtyDescriptor) {
    Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTtyDescriptor);
  } else {
    delete (process.stdout as Partial<typeof process.stdout>).isTTY;
  }
  if (originalServiceRepairPolicy === undefined) {
    delete process.env.OPENCLAW_SERVICE_REPAIR_POLICY;
  } else {
    process.env.OPENCLAW_SERVICE_REPAIR_POLICY = originalServiceRepairPolicy;
  }
});

describe("maybeOfferUpdateBeforeDoctor", () => {
  function mockGitCheckout() {
    vi.spyOn(fs, "realpath").mockImplementation(async (candidate) => String(candidate));
    mocks.runCommandWithTimeout.mockImplementation(async (argv, options) => {
      if (argv[2] === "gateway" && argv[3] === "restart") {
        await mocks.restartUpdatedGateway(options.env);
      }
      return {
        stdout: "/repo/link\n",
        stderr: "",
        code: 0,
        killed: false,
        signal: null,
        termination: "exit",
        noOutputTimedOut: false,
      };
    });
  }

  function mockManagedService(params: {
    verdict:
      | { kind: "owned"; refreshDefinition: boolean; fingerprint: string }
      | { kind: "unresolved"; fingerprint: string }
      | { kind: "foreign" }
      | { kind: "unavailable"; message: string };
    running?: boolean;
    env?: NodeJS.ProcessEnv;
    stopUnresolved?: boolean;
    autoStartRecovery?: PreManagedServiceStop["windowsTaskAutoStartRecovery"];
  }) {
    const running = params.running ?? true;
    const owned = params.verdict.kind === "owned";
    const serviceEnv = params.env ?? createManagedDoctorEnvironment();
    mocks.maybeStopManagedServiceBeforeMutableUpdate.mockImplementation(
      async ({ phase }: { phase: "inspect" | "prepare" }) => {
        const stopped = phase === "prepare" && running && (owned || params.stopUnresolved === true);
        if (stopped) {
          await mocks.stopGatewayService({ env: serviceEnv, stdout: process.stdout });
        }
        return {
          stopped,
          inspected: true,
          runtimeInspected: true,
          running,
          serviceEnv,
          serviceUpdateVerdict: params.verdict,
          ...(phase === "prepare"
            ? { windowsTaskAutoStartRecovery: params.autoStartRecovery }
            : {}),
          ...(params.verdict.kind === "unavailable"
            ? { serviceMutationAllowed: false, serviceMutationSkipMessage: params.verdict.message }
            : {}),
        };
      },
    );
  }

  function mockUpdateResult(result: {
    status: "ok" | "error" | "skipped";
    mode: "git";
    root: string;
    after?: { version: string; buildId?: string };
    recovery?: UpdateRecovery;
  }) {
    mocks.runGatewayUpdate.mockImplementation(
      async ({
        beforeGitMutation,
      }: {
        beforeGitMutation?: (target: object) => Promise<unknown>;
      }) => {
        mocks.gitMutationPolicy(await beforeGitMutation?.({}));
        return result;
      },
    );
  }

  it("treats a linked package root as a git checkout when realpaths match", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    vi.spyOn(fs, "realpath").mockImplementation(async (candidate) => {
      const value = String(candidate);
      if (value === "/repo/link" || value === "/repo/real") {
        return "/repo/real";
      }
      return value;
    });
    mocks.runCommandWithTimeout.mockResolvedValue({
      stdout: "/repo/real\n",
      stderr: "",
      code: 0,
      killed: false,
      signal: null,
      termination: "exit",
      noOutputTimedOut: false,
    });

    await expect(runOffer({ root: "/repo/link", confirm })).resolves.toEqual({ updated: false });

    expect(confirm).toHaveBeenCalledWith({
      message: "Update OpenClaw from git before running doctor?",
      initialValue: true,
    });
    expect(mocks.note).not.toHaveBeenCalledWith(
      expect.stringContaining("This install is not a git checkout."),
      "Update",
    );
  });

  it.each([
    "ok",
    "safe-error",
    "safe-recovery-fails",
    "unsafe-error",
    "unsafe-ok",
    "mutation-throws",
    "stopped-mutation-throws",
    "restore-fails",
    "restart-fails",
  ] as const)("finishes Windows task recovery after a Doctor update: %s", async (outcome) => {
    mockGitCheckout();
    let taskEnabled = false;
    let recoveryClosed = false;
    const failure = new Error(outcome);
    const mutationThrows = outcome.endsWith("mutation-throws");
    const safeRecoveryFails = outcome === "safe-recovery-fails";
    const recovery = {
      suspended: Promise.resolve(true),
      interrupted: () => false,
      beginMutation: vi.fn(),
      restore: vi.fn(async (safe?: boolean) => {
        expect(safe).toBe(true);
        if (outcome === "restore-fails") {
          throw failure;
        }
        taskEnabled = true;
      }),
      complete: vi.fn(() => {
        recoveryClosed = true;
      }),
    };
    mockManagedService({
      verdict: { kind: "owned", refreshDefinition: false, fingerprint: "opaque" },
      running: outcome !== "stopped-mutation-throws",
      autoStartRecovery: recovery,
    });
    const unsafe = outcome === "unsafe-error" || outcome === "unsafe-ok";
    mocks.runGatewayUpdate.mockImplementation(async ({ beforeGitMutation }) => {
      await beforeGitMutation({});
      if (mutationThrows) {
        throw failure;
      }
      return {
        status:
          outcome === "safe-error" || safeRecoveryFails || outcome === "unsafe-error"
            ? "error"
            : "ok",
        mode: "git",
        root: "/repo/link",
        after: { version: "2026.4.24" },
        recovery: unsafe
          ? { serviceRestartSafe: false, reason: "state-migration-started" }
          : { serviceRestartSafe: true, version: "2026.4.24" },
      };
    });
    mocks.maybeRestartServiceAfterFailedMutableUpdate.mockImplementation(async () => {
      expect(taskEnabled).toBe(true);
      return safeRecoveryFails ? "failed" : "healthy";
    });
    mocks.restartUpdatedGateway.mockImplementation(async () => {
      expect(taskEnabled).toBe(true);
      if (outcome === "restart-fails") {
        throw failure;
      }
    });
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        expect(recoveryClosed).toBe(true);
      }),
    };
    mocks.triageCommand.mockImplementation(async () => {
      expect(recoveryClosed).toBe(true);
    });
    const offer = runOffer({ confirm: vi.fn().mockResolvedValue(true), runtime });
    const terminalFailure =
      unsafe ||
      mutationThrows ||
      outcome === "safe-error" ||
      safeRecoveryFails ||
      outcome === "restore-fails" ||
      outcome === "restart-fails";
    if (terminalFailure) {
      await expect(offer).rejects.toEqual(new ExitError(1));
    } else {
      await expect(offer).resolves.toEqual({
        updated: true,
        handled: true,
      });
    }
    expect(recoveryClosed).toBe(true);
    expect(recovery.complete).toHaveBeenCalledOnce();
    expect(recovery.beginMutation).toHaveBeenCalledOnce();
    const restoreAttempted = !unsafe && !mutationThrows;
    const restoreVerified = restoreAttempted && outcome !== "restore-fails";
    expect(taskEnabled).toBe(restoreVerified);
    expect(recovery.complete).toHaveBeenCalledWith(restoreVerified);
    if (!restoreAttempted) {
      expect(recovery.restore).not.toHaveBeenCalled();
    }
    if (!restoreVerified) {
      expect(mocks.restartUpdatedGateway).not.toHaveBeenCalled();
      expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).not.toHaveBeenCalled();
    }
    expect(runtime.exit).toHaveBeenCalledTimes(terminalFailure ? 1 : 0);
    expect(mocks.triageCommand).toHaveBeenCalledTimes(terminalFailure ? 1 : 0);
    if (terminalFailure) {
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(mocks.triageCommand.mock.invocationCallOrder[0]).toBeLessThan(
        runtime.exit.mock.invocationCallOrder[0]!,
      );
    }
    if (outcome === "safe-error" || safeRecoveryFails) {
      expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).toHaveBeenCalledOnce();
      expect(
        mocks.maybeRestartServiceAfterFailedMutableUpdate.mock.invocationCallOrder[0],
      ).toBeLessThan(mocks.triageCommand.mock.invocationCallOrder[0]!);
      expect(mocks.triageCommand.mock.calls[0]?.[1]?.recovery?.update).toMatchObject({
        status: "error",
        recovery: { serviceRestartSafe: true },
      });
    }
    if (safeRecoveryFails) {
      const triageRecovery = mocks.triageCommand.mock.calls[0]?.[1]?.recovery?.update.recovery;
      expect(triageRecovery).toMatchObject({ serviceRestartSafe: true, service: "failed" });
    }
  });

  it("passes step progress to the updater and stops the spinner when the update throws", async () => {
    const stop = vi.fn();
    const progress = {};
    mocks.createUpdateProgress.mockReturnValue({ progress, stop });
    mockGitCheckout();
    mocks.runGatewayUpdate.mockRejectedValue(new Error("update exploded"));

    const confirm = vi.fn().mockResolvedValue(true);
    await expect(runOffer({ root: "/repo/link", confirm })).rejects.toThrow("update exploded");

    expect(mocks.runGatewayUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        progress,
        allowGatewayServiceRepair: false,
        allowGatewayActivation: false,
      }),
    );
    expect(mocks.createUpdateProgress).toHaveBeenCalledWith(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalledWith(
      expect.stringContaining("source checkout may be partially mutated"),
      "Update",
    );
  });

  it.each([false, true])(
    "disables update progress for a skipped update without a TTY (verified recovery: %s)",
    async (safe) => {
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: false,
      });
      mockGitCheckout();
      mocks.runGatewayUpdate.mockResolvedValue({
        status: "skipped",
        mode: "git",
        root: "/repo/link",
        recovery: safe ? { serviceRestartSafe: true, version: "2026.4.24" } : undefined,
        steps: [],
        durationMs: 0,
      });

      const confirm = vi.fn().mockResolvedValue(true);
      await expect(runOffer({ root: "/repo/link", confirm })).resolves.toEqual({
        updated: true,
        handled: false,
      });

      expect(mocks.createUpdateProgress).toHaveBeenCalledWith(false);
      expect(mocks.triageCommand).not.toHaveBeenCalled();
    },
  );

  it("keeps package-manager guidance when git reports a different checkout", async () => {
    const confirm = vi.fn();
    vi.spyOn(fs, "realpath").mockImplementation(async (candidate) => String(candidate));
    mocks.runCommandWithTimeout.mockResolvedValue({
      stdout: "/repo/other\n",
      stderr: "",
      code: 0,
      killed: false,
      signal: null,
      termination: "exit",
      noOutputTimedOut: false,
    });

    await expect(runOffer({ root: "/repo/link", confirm })).resolves.toEqual({ updated: false });

    expect(confirm).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("This install is not a git checkout."),
      "Update",
    );
  });

  it.each([
    { definition: "writable", refreshDefinition: true },
    { definition: "sealed", refreshDefinition: false },
  ])(
    "restarts an owned $definition gateway using its current environment",
    async ({ refreshDefinition }) => {
      mockGitCheckout();
      const verdict = { kind: "owned" as const, refreshDefinition, fingerprint: "opaque" };
      mockManagedService({ verdict });
      mockUpdateResult({ status: "ok", mode: "git", root: "/repo/link" });
      const currentEnv = {
        ...createManagedDoctorEnvironment(),
        ...(refreshDefinition ? { CURRENT_MANAGED_VALUE: "validated" } : {}),
      };
      mocks.readGatewayServiceState.mockResolvedValueOnce({ env: currentEnv });

      await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).resolves.toEqual({
        updated: true,
        handled: true,
      });
      expect(mocks.maybeStopManagedServiceBeforeMutableUpdate.mock.calls).toEqual([
        [expect.objectContaining({ phase: "inspect", root: "/repo/link" })],
        [expect.objectContaining({ phase: "prepare", root: "/repo/link" })],
      ]);
      expect(mocks.stopGatewayService).toHaveBeenCalledOnce();
      expect(mocks.restartUpdatedGateway).toHaveBeenCalledOnce();
      expect(
        mocks.runCommandWithTimeout.mock.calls.some(([args]) =>
          args.includes("--preserve-definition"),
        ),
      ).toBe(true);
      expect(mocks.restartUpdatedGateway.mock.calls[0]?.[0]).toMatchObject(currentEnv);
      const policy = { allowGatewayServiceRepair: refreshDefinition, allowGatewayActivation: true };
      expect(mocks.runGatewayUpdate).toHaveBeenCalledWith(expect.objectContaining(policy));
      expect(mocks.gitMutationPolicy).toHaveBeenCalledWith(policy);
      expect(mocks.revalidateManagedGatewayServiceAfterUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          root: "/repo/link",
          preManagedServiceStop: expect.objectContaining({ serviceUpdateVerdict: verdict }),
        }),
      );
      expect(mocks.note).toHaveBeenCalledWith(
        "Restarted the running gateway service after updating OpenClaw.",
        "Update",
      );
    },
  );

  it.each(["healthy", "exited", "old-version"] as const)(
    "verifies doctor update restart readiness: %s",
    async (outcome) => {
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      mockGitCheckout();
      mockManagedService({
        verdict: { kind: "owned", refreshDefinition: false, fingerprint: "opaque" },
      });
      mockUpdateResult({
        status: "ok",
        mode: "git",
        root: "/repo/link",
        after: { version: "2026.4.24", buildId: "new-build" },
      });
      mocks.waitForHealthyRestart.mockResolvedValue({
        healthy: outcome === "healthy",
        runtime: { status: outcome === "exited" ? "stopped" : "running" },
        gatewayVersion: outcome === "old-version" ? "2026.4.23" : "2026.4.24",
        versionMismatch: outcome === "old-version",
        staleGatewayPids: [],
      });

      const offer = runOffer({ confirm: vi.fn().mockResolvedValue(true), runtime });
      if (outcome === "healthy") {
        await expect(offer).resolves.toEqual({ updated: true, handled: true });
      } else {
        await expect(offer).rejects.toEqual(new ExitError(1));
      }

      expect(mocks.runGatewayUpdate).toHaveBeenCalledOnce();
      expect(mocks.waitForHealthyRestart).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedVersion: "2026.4.24",
          expectedBuildId: "new-build",
          env: createManagedDoctorEnvironment(),
          requireRunningService: true,
        }),
      );
      expect(mocks.doctorCommand).not.toHaveBeenCalled();
      if (outcome === "healthy") {
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(mocks.note).toHaveBeenCalledWith(
          "Restarted the running gateway service after updating OpenClaw.",
          "Update",
        );
        expect(mocks.waitForHealthyRestart.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.note.mock.invocationCallOrder.at(-1)!,
        );
      } else {
        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(mocks.triageCommand).toHaveBeenCalledOnce();
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("Update completed, but gateway service restart failed"),
        );
        expect(mocks.note).not.toHaveBeenCalledWith(
          "Restarted the running gateway service after updating OpenClaw.",
          "Update",
        );
      }
    },
  );

  it.each([
    { source: "ExecStart", args: ["--port=19201"], envPort: "19202", expected: 19201 },
    { source: "service environment", args: [], envPort: "19202", expected: 19202 },
    { source: "service config", args: [], envPort: undefined, expected: 19203 },
  ])(
    "verifies the preserved doctor service port from $source",
    async ({ args, envPort, expected }) => {
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const serviceEnv = { ...createManagedDoctorEnvironment(), OPENCLAW_GATEWAY_PORT: envPort };
      mockGitCheckout();
      mockManagedService({
        verdict: { kind: "owned", refreshDefinition: false, fingerprint: "opaque" },
        env: serviceEnv,
      });
      mockUpdateResult({
        status: "ok",
        mode: "git",
        root: "/repo/link",
        after: { version: "2026.4.24" },
      });
      mocks.readGatewayServiceState.mockResolvedValue({
        env: serviceEnv,
        command: {
          programArguments: ["/usr/bin/node", "/repo/link/dist/index.js", "gateway", ...args],
        },
      });
      mocks.createServiceConfigIO.mockReturnValue({
        readBestEffortConfig: async () => ({ gateway: { port: 19203 } }),
      });

      await expect(
        runOffer({ confirm: vi.fn().mockResolvedValue(true), runtime }),
      ).resolves.toEqual({ updated: true, handled: true });

      expect(mocks.waitForHealthyRestart).toHaveBeenCalledWith(
        expect.objectContaining({ port: expected, expectedVersion: "2026.4.24", env: serviceEnv }),
      );
      if (envPort === undefined) {
        expect(mocks.createServiceConfigIO).toHaveBeenCalledWith(
          expect.objectContaining({ env: serviceEnv, observe: false }),
        );
      }
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(mocks.doctorCommand).not.toHaveBeenCalled();
    },
  );

  it.each([
    { definition: "preserved", refreshDefinition: false, failure: "ownership revalidation" },
    { definition: "writable", refreshDefinition: true, failure: "ownership revalidation" },
    { definition: "writable", refreshDefinition: true, failure: "service inspection" },
  ])(
    "leaves a stopped $definition gateway down after failed $failure",
    async ({ refreshDefinition, failure }) => {
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      mockGitCheckout();
      mockManagedService({ verdict: { kind: "owned", refreshDefinition, fingerprint: "opaque" } });
      mockUpdateResult({ status: "ok", mode: "git", root: "/repo/link" });
      const inspectionError = new Error(`${failure} unavailable`);
      if (failure === "service inspection") {
        mocks.readGatewayServiceState.mockRejectedValueOnce(inspectionError);
      } else {
        mocks.revalidateManagedGatewayServiceAfterUpdate.mockRejectedValueOnce(inspectionError);
      }

      await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true), runtime })).rejects.toEqual(
        new ExitError(1),
      );
      expect(mocks.stopGatewayService).toHaveBeenCalledOnce();
      expect(mocks.restartUpdatedGateway).not.toHaveBeenCalled();
      expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).not.toHaveBeenCalled();
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(inspectionError.message));
      expect(runtime.error.mock.invocationCallOrder[0]).toBeLessThan(
        runtime.exit.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(mocks.triageCommand).toHaveBeenCalledOnce();
    },
  );

  const nonActivatingServices: Array<
    Parameters<typeof mockManagedService>[0] & {
      name: string;
      policy: { allowGatewayServiceRepair: boolean; allowGatewayActivation: boolean };
    }
  > = [
    {
      name: "foreign service",
      verdict: { kind: "foreign" },
      running: true,
      policy: { allowGatewayServiceRepair: false, allowGatewayActivation: false },
    },
    {
      name: "unresolved service",
      verdict: { kind: "unresolved", fingerprint: "opaque" },
      running: true,
      policy: { allowGatewayServiceRepair: false, allowGatewayActivation: false },
    },
    {
      name: "stopped owned service permitting definition repair",
      verdict: { kind: "owned", refreshDefinition: true, fingerprint: "opaque" },
      running: false,
      policy: { allowGatewayServiceRepair: true, allowGatewayActivation: false },
    },
    {
      name: "unavailable inspection with a visible skip",
      verdict: {
        kind: "unavailable",
        message:
          "Gateway service management skipped; inspect service access before restarting manually.",
      },
      running: true,
      policy: { allowGatewayServiceRepair: false, allowGatewayActivation: false },
    },
  ];
  it.each(nonActivatingServices)(
    "updates without stopping or activating a $name",
    async ({ verdict, running, policy }) => {
      mockGitCheckout();
      mockManagedService({ verdict, running });
      mockUpdateResult({ status: "ok", mode: "git", root: "/repo/link" });

      await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).resolves.toEqual({
        updated: true,
        handled: true,
      });
      expect(mocks.runGatewayUpdate).toHaveBeenCalledOnce();
      expect(mocks.runGatewayUpdate).toHaveBeenCalledWith(expect.objectContaining(policy));
      expect(mocks.gitMutationPolicy).toHaveBeenCalledWith(policy);
      expect(mocks.stopGatewayService).not.toHaveBeenCalled();
      expect(mocks.restartUpdatedGateway).not.toHaveBeenCalled();
      if (verdict.kind === "unavailable") {
        expect(mocks.note).toHaveBeenCalledWith(verdict.message, "Update");
      }
    },
  );

  it.each([false, true])(
    "restores a stopped unresolved gateway only when its identity survives the doctor update (changed: %s)",
    async (identityChanged) => {
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const serviceEnv = {
        ...createManagedDoctorEnvironment(),
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-work.service",
      };
      mockGitCheckout();
      mockManagedService({
        verdict: { kind: "unresolved", fingerprint: "opaque" },
        env: serviceEnv,
        stopUnresolved: true,
      });
      mockUpdateResult({ status: "ok", mode: "git", root: "/repo/link" });
      mocks.readGatewayServiceState.mockResolvedValueOnce({ env: serviceEnv });
      if (identityChanged) {
        mocks.revalidateManagedGatewayServiceAfterUpdate.mockRejectedValueOnce(
          new Error("The stopped gateway service-manager identity changed."),
        );
      }

      const offer = runOffer({ confirm: vi.fn().mockResolvedValue(true), runtime });
      if (identityChanged) {
        await expect(offer).rejects.toEqual(new ExitError(1));
      } else {
        await expect(offer).resolves.toEqual({ updated: true, handled: true });
      }

      expect(mocks.stopGatewayService).toHaveBeenCalledOnce();
      expect(mocks.gitMutationPolicy).toHaveBeenCalledWith({
        allowGatewayServiceRepair: false,
        allowGatewayActivation: false,
      });
      expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).not.toHaveBeenCalled();
      if (identityChanged) {
        expect(mocks.restartUpdatedGateway).not.toHaveBeenCalled();
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("service-manager identity changed"),
        );
        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(mocks.triageCommand).toHaveBeenCalledOnce();
      } else {
        expect(mocks.restartUpdatedGateway.mock.calls[0]?.[0]).toMatchObject({
          ...serviceEnv,
        });
        expect(runtime.exit).not.toHaveBeenCalled();
      }
    },
  );

  it("leaves the stopped gateway down when a git mutation throws without recovery proof", async () => {
    mockGitCheckout();
    mockManagedService({
      verdict: { kind: "owned", refreshDefinition: false, fingerprint: "opaque" },
    });
    mocks.runGatewayUpdate.mockImplementation(
      async ({
        beforeGitMutation,
      }: {
        beforeGitMutation: (target: object) => Promise<unknown>;
      }) => {
        await beforeGitMutation({});
        throw new Error("checkout mutation failed");
      },
    );

    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).rejects.toEqual(
      new ExitError(1),
    );

    expect(mocks.stopGatewayService).toHaveBeenCalledOnce();
    expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).not.toHaveBeenCalled();
    expect(mocks.restartUpdatedGateway).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("source checkout may be partially mutated"),
      "Update",
    );
    expect(mocks.note).toHaveBeenCalledWith(expect.stringContaining("openclaw triage"), "Update");
    expect(mocks.triageCommand).toHaveBeenCalledOnce();
  });

  it("preserves an ordinary preparation rejection before source mutation", async () => {
    mockGitCheckout();
    const failure = new Error("Gateway service identity changed during preparation");
    mocks.maybeStopManagedServiceBeforeMutableUpdate.mockImplementationOnce(async () => ({
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: true,
      serviceEnv: createManagedDoctorEnvironment(),
      serviceUpdateVerdict: { kind: "owned", refreshDefinition: false, fingerprint: "opaque" },
    }));
    mocks.maybeStopManagedServiceBeforeMutableUpdate.mockRejectedValueOnce(failure);
    mocks.runGatewayUpdate.mockImplementation(
      async ({ beforeGitMutation }: { beforeGitMutation: (target: object) => Promise<unknown> }) =>
        await beforeGitMutation({}),
    );

    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).rejects.toBe(failure);

    expect(mocks.runGatewayUpdate).toHaveBeenCalledOnce();
    expect(mocks.stopGatewayService).not.toHaveBeenCalled();
    expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).not.toHaveBeenCalled();
    expect(mocks.restartUpdatedGateway).not.toHaveBeenCalled();
    expect(mocks.triageCommand).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalledWith(
      expect.stringContaining("source checkout may be partially mutated"),
      "Update",
    );
  });

  it.each([true, undefined])(
    "recovers the previously stopped service only with verified recovery (%s)",
    async (safe) => {
      mockGitCheckout();
      mockManagedService({
        verdict: { kind: "owned", refreshDefinition: true, fingerprint: "opaque" },
      });
      mockUpdateResult({
        status: "error",
        mode: "git",
        root: "/repo/link",
        recovery: safe
          ? { serviceRestartSafe: true, version: "2026.4.24", buildId: "synthetic-build" }
          : undefined,
      });
      mocks.maybeRestartServiceAfterFailedMutableUpdate.mockResolvedValue("healthy");

      const offer = runOffer({ confirm: vi.fn().mockResolvedValue(true) });
      await expect(offer).rejects.toEqual(new ExitError(1));
      expect(mocks.triageCommand).toHaveBeenCalledOnce();

      if (safe) {
        expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).toHaveBeenCalledWith({
          recovery: { serviceRestartSafe: true, version: "2026.4.24", buildId: "synthetic-build" },
          preManagedServiceStop: expect.objectContaining({ stopped: true }),
          jsonMode: false,
          timeoutMs: 1_200_000,
          invocationCwd: "/repo/link",
        });
        expect(mocks.triageCommand.mock.calls[0]?.[1]?.recovery?.update).toMatchObject({
          status: "error",
          recovery: { serviceRestartSafe: true, version: "2026.4.24", buildId: "synthetic-build" },
        });
      } else {
        expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).not.toHaveBeenCalled();
        const triageRecovery = mocks.triageCommand.mock.calls[0]?.[1]?.recovery?.update.recovery;
        expect(triageRecovery).toEqual({
          serviceRestartSafe: false,
          reason: "runtime-verification-failed",
        });
      }
    },
  );

  it.each([
    "source-rollback-failed",
    "rollback-checkout-dirty",
    "state-migration-started",
  ] as const)("does not restart a stopped service after %s", async (reason) => {
    mockGitCheckout();
    mockManagedService({
      verdict: { kind: "owned", refreshDefinition: true, fingerprint: "opaque" },
    });
    mockUpdateResult({
      status: "error",
      mode: "git",
      root: "/repo/link",
      recovery: { serviceRestartSafe: false, reason },
    });

    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).rejects.toEqual(
      new ExitError(1),
    );

    expect(mocks.stopGatewayService).toHaveBeenCalledOnce();
    expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).not.toHaveBeenCalled();
    expect(mocks.restartUpdatedGateway).not.toHaveBeenCalled();
    expect(mocks.triageCommand).toHaveBeenCalledOnce();
    expect(mocks.note).toHaveBeenCalledWith(expect.stringContaining(`(${reason})`), "Update");
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Run `openclaw triage` on this machine"),
      "Update",
    );
    if (reason === "state-migration-started") {
      expect(mocks.note).toHaveBeenCalledWith(
        expect.stringContaining("keep the candidate installed and do not roll back code alone"),
        "Update",
      );
    }
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Keep the gateway stopped until the update succeeds"),
      "Update",
    );
  });

  it("reports unsafe recovery with redirected output and preserves the stopped service", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    mockGitCheckout();
    mockManagedService({
      verdict: { kind: "owned", refreshDefinition: true, fingerprint: "opaque" },
      running: false,
    });
    mockUpdateResult({
      status: "error",
      mode: "git",
      root: "/repo/link",
      recovery: { serviceRestartSafe: false, reason: "rollback-checkout-dirty" },
    });

    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).rejects.toEqual(
      new ExitError(1),
    );
    expect(mocks.triageCommand).not.toHaveBeenCalled();

    const recoveryNote = mocks.note.mock.calls.find((call) =>
      String(call[0]).includes("rollback-checkout-dirty"),
    )?.[0];
    expect(recoveryNote).toContain("Run `openclaw triage` on this machine");
    expect(recoveryNote).not.toContain("remains stopped");
    expect(recoveryNote).not.toContain("Keep the gateway stopped");
  });

  it("preserves the active profile in unsafe recovery guidance", async () => {
    vi.stubEnv("OPENCLAW_PROFILE", "work");
    mockGitCheckout();
    mockManagedService({
      verdict: { kind: "owned", refreshDefinition: true, fingerprint: "opaque" },
    });
    mockUpdateResult({
      status: "error",
      mode: "git",
      root: "/repo/link",
      recovery: { serviceRestartSafe: false, reason: "rollback-checkout-dirty" },
    });

    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).rejects.toEqual(
      new ExitError(1),
    );

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Run `openclaw --profile work triage`"),
      "Update",
    );
  });

  it("leaves a running gateway alone when service repair is externally managed", async () => {
    mockGitCheckout();
    process.env.OPENCLAW_SERVICE_REPAIR_POLICY = "external";
    mocks.runGatewayUpdate.mockResolvedValue({
      status: "ok",
      mode: "git",
      root: "/repo/link",
    });

    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).resolves.toEqual({
      updated: true,
      handled: true,
    });

    expect(mocks.resolveGatewayService).not.toHaveBeenCalled();
    expect(mocks.maybeStopManagedServiceBeforeMutableUpdate).not.toHaveBeenCalled();
    expect(mocks.restartUpdatedGateway).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(EXTERNAL_SERVICE_REPAIR_NOTE, "Update");
  });

  it("stops the parent doctor when the post-update gateway restart fails", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    mockGitCheckout();
    mockManagedService({
      verdict: { kind: "owned", refreshDefinition: true, fingerprint: "opaque" },
    });
    mockUpdateResult({ status: "ok", mode: "git", root: "/repo/link" });
    mocks.restartUpdatedGateway.mockRejectedValue(new Error("schtasks failed"));

    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true), runtime })).rejects.toEqual(
      new ExitError(1),
    );

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Update completed, but gateway service restart failed"),
    );
    expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining("schtasks failed"));
    expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.triageCommand).toHaveBeenCalledOnce();
  });
});

// Doctor update tests cover pre-doctor update prompts, state files, and declined update flows.
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { EXTERNAL_SERVICE_REPAIR_NOTE } from "./doctor-service-repair-policy.js";
import { maybeOfferUpdateBeforeDoctor } from "./doctor-update.js";

const originalStdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalStdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const originalServiceRepairPolicy = process.env.OPENCLAW_SERVICE_REPAIR_POLICY;

const mocks = vi.hoisted(() => ({
  createUpdateProgress: vi.fn(),
  gitMutationPolicy: vi.fn(),
  isDefaultInstallIdentity: vi.fn(() => true),
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
}));

vi.mock("../cli/update-cli/progress.js", () => ({
  createUpdateProgress: mocks.createUpdateProgress,
}));

vi.mock("../config/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../config/paths.js")>("../config/paths.js");
  return { ...actual, isDefaultInstallIdentity: mocks.isDefaultInstallIdentity };
});

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
  mocks.isDefaultInstallIdentity.mockReturnValue(true);
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
  mocks.resolveGatewayService.mockReturnValue({
    restart: vi.fn(),
    start: vi.fn(),
    isLoaded: async () => false,
  });
  mocks.readGatewayServiceState.mockResolvedValue({ env: { OPENCLAW_PROFILE: "work" } });
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
  }) {
    const running = params.running ?? true;
    const owned = params.verdict.kind === "owned";
    const serviceEnv = params.env ?? { OPENCLAW_PROFILE: "work" };
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
    recovery?: { serviceRestartSafe: false; reason: "source-rollback-failed" };
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

  it("disables update progress when stdout is not a TTY", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    mockGitCheckout();
    mocks.runGatewayUpdate.mockResolvedValue({
      status: "skipped",
      mode: "git",
      root: "/repo/link",
      steps: [],
      durationMs: 0,
    });

    const confirm = vi.fn().mockResolvedValue(true);
    await expect(runOffer({ root: "/repo/link", confirm })).resolves.toEqual({
      updated: true,
      handled: false,
    });

    expect(mocks.createUpdateProgress).toHaveBeenCalledWith(false);
  });

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
        OPENCLAW_PROFILE: "work",
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

      await expect(
        runOffer({ confirm: vi.fn().mockResolvedValue(true), runtime }),
      ).resolves.toEqual({ updated: true, handled: true });

      expect(mocks.runGatewayUpdate).toHaveBeenCalledOnce();
      expect(mocks.waitForHealthyRestart).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedVersion: "2026.4.24",
          expectedBuildId: "new-build",
          env: { OPENCLAW_PROFILE: "work" },
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
      const serviceEnv = { OPENCLAW_PROFILE: "work", OPENCLAW_GATEWAY_PORT: envPort };
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

      await expect(
        runOffer({ confirm: vi.fn().mockResolvedValue(true), runtime }),
      ).resolves.toEqual({
        updated: true,
        handled: true,
      });
      expect(mocks.stopGatewayService).toHaveBeenCalledOnce();
      expect(mocks.restartUpdatedGateway).not.toHaveBeenCalled();
      expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).not.toHaveBeenCalled();
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(inspectionError.message));
      expect(runtime.error.mock.invocationCallOrder[0]).toBeLessThan(
        runtime.exit.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
    },
  );

  it.each([{ kind: "foreign" as const }, { kind: "unresolved" as const, fingerprint: "opaque" }])(
    "does not stop, repair or activate a $kind service",
    async (verdict) => {
      mockGitCheckout();
      mockManagedService({ verdict });
      mockUpdateResult({ status: "ok", mode: "git", root: "/repo/link" });

      await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).resolves.toEqual({
        updated: true,
        handled: true,
      });
      expect(mocks.runGatewayUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          allowGatewayServiceRepair: false,
          allowGatewayActivation: false,
        }),
      );
      expect(mocks.stopGatewayService).not.toHaveBeenCalled();
      expect(mocks.restartUpdatedGateway).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "restores a stopped unresolved gateway only when its identity survives the doctor update (changed: %s)",
    async (identityChanged) => {
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const serviceEnv = {
        OPENCLAW_PROFILE: "work",
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

      await expect(
        runOffer({ confirm: vi.fn().mockResolvedValue(true), runtime }),
      ).resolves.toEqual({
        updated: true,
        handled: true,
      });

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
      } else {
        expect(mocks.restartUpdatedGateway.mock.calls[0]?.[0]).toMatchObject({
          ...serviceEnv,
        });
        expect(runtime.exit).not.toHaveBeenCalled();
      }
    },
  );

  it("repairs without activating a stopped gateway owned by this checkout", async () => {
    mockGitCheckout();
    mockManagedService({
      verdict: { kind: "owned", refreshDefinition: true, fingerprint: "opaque" },
      running: false,
    });
    mockUpdateResult({ status: "ok", mode: "git", root: "/repo/link" });

    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).resolves.toEqual({
      updated: true,
      handled: true,
    });

    expect(mocks.runGatewayUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        allowGatewayServiceRepair: true,
        allowGatewayActivation: false,
      }),
    );
    expect(mocks.restartUpdatedGateway).not.toHaveBeenCalled();
  });

  it("updates with a visible skip when service inspection is unavailable", async () => {
    const message =
      "Gateway service management skipped; inspect service access before restarting manually.";
    mockGitCheckout();
    mockManagedService({ verdict: { kind: "unavailable", message } });
    mockUpdateResult({ status: "ok", mode: "git", root: "/repo/link" });

    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).resolves.toEqual({
      updated: true,
      handled: true,
    });

    expect(mocks.note).toHaveBeenCalledWith(message, "Update");
    expect(mocks.runGatewayUpdate).toHaveBeenCalledOnce();
    expect(mocks.gitMutationPolicy).toHaveBeenCalledWith({
      allowGatewayServiceRepair: false,
      allowGatewayActivation: false,
    });
    expect(mocks.stopGatewayService).not.toHaveBeenCalled();
    expect(mocks.restartUpdatedGateway).not.toHaveBeenCalled();
  });

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

    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).rejects.toThrow(
      "checkout mutation failed",
    );

    expect(mocks.stopGatewayService).toHaveBeenCalledOnce();
    expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).not.toHaveBeenCalled();
    expect(mocks.restartUpdatedGateway).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("source checkout may be partially mutated"),
      "Update",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("restart the gateway manually"),
      "Update",
    );
  });

  it("recovers a stopped gateway when mutation preparation itself fails before authorization", async () => {
    mockGitCheckout();
    mockManagedService({
      verdict: { kind: "owned", refreshDefinition: false, fingerprint: "opaque" },
    });
    mocks.maybeStopManagedServiceBeforeMutableUpdate.mockImplementationOnce(async () => ({
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: true,
      serviceEnv: { OPENCLAW_PROFILE: "work" },
      serviceUpdateVerdict: { kind: "owned", refreshDefinition: false, fingerprint: "opaque" },
    }));
    mocks.maybeStopManagedServiceBeforeMutableUpdate.mockImplementationOnce(async () => {
      await mocks.stopGatewayService({
        env: { OPENCLAW_PROFILE: "work" },
        stdout: process.stdout,
      });
      return {
        stopped: true,
        inspected: true,
        runtimeInspected: true,
        running: true,
        serviceEnv: { OPENCLAW_PROFILE: "work" },
        serviceUpdateVerdict: { kind: "owned", refreshDefinition: false, fingerprint: "opaque" },
        blockMessage: "mutation preparation blocked",
      };
    });
    mocks.runGatewayUpdate.mockImplementation(
      async ({ beforeGitMutation }: { beforeGitMutation: (target: object) => Promise<unknown> }) =>
        await beforeGitMutation({}),
    );

    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).rejects.toThrow(
      "mutation preparation blocked",
    );

    expect(mocks.stopGatewayService).toHaveBeenCalledOnce();
    expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).toHaveBeenCalledWith({
      preManagedServiceStop: expect.objectContaining({ stopped: true }),
      jsonMode: false,
    });
    expect(mocks.note).not.toHaveBeenCalledWith(
      expect.stringContaining("source checkout may be partially mutated"),
      "Update",
    );
  });

  it("recovers the previously stopped service when the update returns an error", async () => {
    mockGitCheckout();
    mockManagedService({
      verdict: { kind: "owned", refreshDefinition: true, fingerprint: "opaque" },
    });
    mockUpdateResult({ status: "error", mode: "git", root: "/repo/link" });

    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).resolves.toEqual({
      updated: true,
      handled: false,
    });

    expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).toHaveBeenCalledWith({
      root: "/repo/link",
      preManagedServiceStop: expect.objectContaining({ stopped: true }),
      jsonMode: false,
    });
  });

  it("does not restart a stopped service when source rollback could not be verified", async () => {
    mockGitCheckout();
    mockManagedService({
      verdict: { kind: "owned", refreshDefinition: true, fingerprint: "opaque" },
    });
    mockUpdateResult({
      status: "error",
      mode: "git",
      root: "/repo/link",
      recovery: { serviceRestartSafe: false, reason: "source-rollback-failed" },
    });

    await runOffer({ confirm: vi.fn().mockResolvedValue(true) });

    expect(mocks.stopGatewayService).toHaveBeenCalledOnce();
    expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).not.toHaveBeenCalled();
    expect(mocks.restartUpdatedGateway).not.toHaveBeenCalled();
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

    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true), runtime })).resolves.toEqual({
      updated: true,
      handled: true,
    });

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Update completed, but gateway service restart failed"),
    );
    expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining("schtasks failed"));
    expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});

// Doctor update tests cover pre-doctor update prompts and managed-service outcomes.
import "./doctor-update.test-support.js";
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import { EXTERNAL_SERVICE_REPAIR_NOTE } from "./doctor-service-repair-policy.js";

const {
  createManagedDoctorEnvironment,
  installDoctorUpdateTestHooks,
  mocks,
  mockGitCheckout,
  mockManagedService,
  mockUpdateResult,
  runOffer,
} = await import("./doctor-update.test-support.js");

installDoctorUpdateTestHooks();

describe("maybeOfferUpdateBeforeDoctor", () => {
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
    const progress = { onStepStart: vi.fn(), onStepComplete: vi.fn() };
    mocks.createUpdateProgress.mockReturnValue({ progress, stop });
    mockGitCheckout();
    const step = { name: "fetch", command: "git fetch", index: 1, total: 1 };
    mocks.runGatewayUpdate.mockImplementation(async ({ progress: forwarded }) => {
      forwarded?.onStepStart?.(step);
      forwarded?.onStepComplete?.({ ...step, durationMs: 1, exitCode: 0 });
      throw new Error("update exploded");
    });

    const confirm = vi.fn().mockResolvedValue(true);
    await expect(runOffer({ root: "/repo/link", confirm })).rejects.toThrow("update exploded");

    expect(mocks.runGatewayUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        allowGatewayServiceRepair: false,
        allowGatewayActivation: false,
      }),
    );
    expect(progress.onStepStart).toHaveBeenCalledWith(step);
    expect(progress.onStepComplete).toHaveBeenCalledWith({ ...step, durationMs: 1, exitCode: 0 });
    expect(mocks.createUpdateProgress).toHaveBeenCalledWith(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalledWith(
      expect.stringContaining("source checkout may be partially mutated"),
      "Update",
    );
  });

  it.each([
    { reason: "no-upstream", failed: true, safe: false },
    { reason: "no-upstream", failed: true, safe: true },
    { reason: "already-current", failed: false, safe: false },
    { reason: "already-current", failed: false, safe: true },
  ])(
    "handles $reason without a TTY (verified recovery: $safe)",
    async ({ reason, failed, safe }) => {
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: false,
      });
      mockGitCheckout();
      mocks.runGatewayUpdate.mockResolvedValue({
        status: "skipped",
        mode: "git",
        root: "/repo/link",
        reason,
        recovery: safe ? { serviceRestartSafe: true, version: "2026.4.24" } : undefined,
        steps: [],
        durationMs: 0,
      } satisfies UpdateRunResult);

      const confirm = vi.fn().mockResolvedValue(true);
      const offer = runOffer({ root: "/repo/link", confirm });
      if (failed) {
        await expect(offer).rejects.toEqual(new ExitError(1));
      } else {
        await expect(offer).resolves.toEqual({ updated: true, handled: false });
      }

      expect(mocks.createUpdateProgress).toHaveBeenCalledWith(false);
      expect(mocks.triageCommand).not.toHaveBeenCalled();
      const diagnosticCall = mocks.runCommandWithTimeout.mock.calls.find(
        ([argv]) => argv[2] === "triage",
      );
      if (failed) {
        expect(diagnosticCall?.[0]).toEqual([
          process.execPath,
          "/repo/link/dist/index.js",
          "triage",
          "--update-result",
          expect.any(String),
          "--non-interactive",
        ]);
        expect(diagnosticCall?.[1]).toMatchObject({ input: "" });
      } else {
        expect(diagnosticCall).toBeUndefined();
      }
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

  it.each(["healthy", "exited", "old-version", "http-unready", "missing-boot"] as const)(
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
        healthy: outcome === "healthy" || outcome === "http-unready" || outcome === "missing-boot",
        runtime: { status: outcome === "exited" ? "stopped" : "running" },
        gatewayVersion: outcome === "old-version" ? "2026.4.23" : "2026.4.24",
        gatewayBootId: outcome === "missing-boot" ? undefined : "doctor-boot",
        versionMismatch: outcome === "old-version",
        staleGatewayPids: [],
      });
      mocks.waitForHttpReadiness.mockResolvedValue({
        healthz: 200,
        readyz: outcome === "http-unready" ? 503 : 200,
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
      expect(mocks.waitForHttpReadiness).toHaveBeenCalledWith(
        expect.objectContaining({
          port: mocks.waitForHealthyRestart.mock.calls[0]?.[0]?.port,
          config: {},
        }),
      );
      expect(mocks.verifyUpdateServing).toHaveBeenCalledTimes(outcome === "healthy" ? 1 : 0);
      expect(mocks.doctorCommand).not.toHaveBeenCalled();
      if (outcome === "healthy") {
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(mocks.note).toHaveBeenCalledWith(
          "Restarted the running gateway service after updating OpenClaw.",
          "Update",
        );
        expect(mocks.waitForHealthyRestart.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.waitForHttpReadiness.mock.invocationCallOrder[0]!,
        );
        expect(mocks.waitForHttpReadiness.mock.invocationCallOrder[0]).toBeLessThan(
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
      expect(mocks.waitForHttpReadiness).toHaveBeenCalledWith(
        expect.objectContaining({ port: expected, config: { gateway: { port: 19203 } } }),
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

      const invocationCwd = process.cwd();
      const offer = runOffer({ confirm: vi.fn().mockResolvedValue(true) });
      await expect(offer).rejects.toEqual(new ExitError(1));
      expect(mocks.triageCommand).toHaveBeenCalledOnce();
      expect(mocks.triageCommand.mock.calls[0]?.[1]?.recovery?.cwd).toBe(invocationCwd);

      if (safe) {
        expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).toHaveBeenCalledWith({
          recovery: { serviceRestartSafe: true, version: "2026.4.24", buildId: "synthetic-build" },
          preManagedServiceStop: expect.objectContaining({ stopped: true }),
          jsonMode: false,
          timeoutMs: 1_200_000,
          invocationCwd,
        });
        expect(mocks.triageCommand.mock.calls[0]?.[1]?.recovery?.updateFailure).toMatchObject({
          result: {
            status: "error",
            recovery: {
              serviceRestartSafe: true,
              version: "2026.4.24",
              buildId: "synthetic-build",
            },
          },
        });
      } else {
        expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).not.toHaveBeenCalled();
        const updateFailure = mocks.triageCommand.mock.calls[0]?.[1]?.recovery?.updateFailure;
        expect(
          updateFailure && "result" in updateFailure ? updateFailure.result.recovery : undefined,
        ).toEqual({
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
      steps: [],
      durationMs: 0,
    } satisfies UpdateRunResult);

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

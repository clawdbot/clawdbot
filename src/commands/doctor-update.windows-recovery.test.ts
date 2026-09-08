import "./doctor-update.test-support.js";
import { describe, expect, it, vi } from "vitest";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { ExitError } from "../runtime.js";

const { installDoctorUpdateTestHooks, mocks, mockGitCheckout, mockManagedService, runOffer } =
  await import("./doctor-update.test-support.js");

installDoctorUpdateTestHooks();

describe("maybeOfferUpdateBeforeDoctor", () => {
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
    "verify-fails",
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
      handoff: vi.fn(),
      beginMutation: vi.fn(),
      restore: vi.fn(async (safe?: boolean) => {
        expect(safe).toBe(true);
        if (outcome === "restore-fails") {
          throw failure;
        }
        taskEnabled = true;
      }),
      complete: vi.fn(async (safe?: boolean) => {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        if (safe === false) {
          taskEnabled = false;
        }
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
        steps: [],
        durationMs: 0,
      } satisfies UpdateRunResult;
    });
    mocks.maybeRestartServiceAfterFailedMutableUpdate.mockImplementation(async () => {
      expect(taskEnabled).toBe(true);
      expect(recovery.complete).not.toHaveBeenCalled();
      return safeRecoveryFails ? "failed" : "healthy";
    });
    mocks.restartUpdatedGateway.mockImplementation(async () => {
      expect(taskEnabled).toBe(true);
      expect(recovery.complete).not.toHaveBeenCalled();
      if (outcome === "restart-fails") {
        throw failure;
      }
    });
    if (outcome === "verify-fails") {
      mocks.waitForHealthyRestart.mockResolvedValue({
        healthy: false,
        runtime: { status: "stopped" },
        staleGatewayPids: [],
      });
    }
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
      outcome === "restart-fails" ||
      outcome === "verify-fails";
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
    const restartVerified =
      restoreVerified &&
      !safeRecoveryFails &&
      outcome !== "restart-fails" &&
      outcome !== "verify-fails";
    expect(taskEnabled).toBe(restartVerified);
    expect(recovery.complete).toHaveBeenCalledWith(restartVerified);
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
      expect(mocks.triageCommand.mock.calls[0]?.[1]?.recovery?.updateFailure).toMatchObject({
        result: {
          status: "error",
          recovery: { serviceRestartSafe: true },
        },
      });
    }
    if (safeRecoveryFails) {
      expect(mocks.triageCommand.mock.calls[0]?.[1]?.recovery?.updateFailure).toMatchObject({
        result: { recovery: { serviceRestartSafe: true, service: "failed" } },
      });
    }
  });
});

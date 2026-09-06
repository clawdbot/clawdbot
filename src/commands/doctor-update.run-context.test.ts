import "./doctor-update.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { ExitError } from "../runtime.js";

const {
  installDoctorUpdateTestHooks,
  mocks,
  mockGitCheckout,
  mockManagedService,
  mockUpdateResult,
  runOffer,
} = await import("./doctor-update.test-support.js");
installDoctorUpdateTestHooks();

describe("Doctor update run lifecycle", () => {
  it.each(["verified", "unavailable"] as const)(
    "settles the admitted run after serving proof: %s",
    async (proof) => {
      mockGitCheckout();
      mockManagedService({
        verdict: { kind: "owned", refreshDefinition: false, fingerprint: "opaque" },
      });
      mockUpdateResult({
        status: "ok",
        mode: "git",
        root: "/repo/link",
        after: { version: "2026.4.24", buildId: "candidate-build" },
      });
      if (proof === "unavailable") {
        mocks.verifyUpdateServing.mockResolvedValue({
          status: "unavailable",
          reason: "persistence-unavailable",
        });
      }
      const offer = runOffer({ confirm: vi.fn().mockResolvedValue(true) });
      if (proof === "verified") {
        await expect(offer).resolves.toEqual({ updated: true, handled: true });
      } else {
        await expect(offer).rejects.toEqual(new ExitError(1));
      }
      expect(mocks.admitUpdateCommandRun).toHaveBeenCalledOnce();
      const run = await mocks.admitUpdateCommandRun.mock.results[0]!.value;
      expect(mocks.admitUpdateCommandRun.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.runGatewayUpdate.mock.invocationCallOrder[0]!,
      );
      expect(mocks.runGatewayUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ runId: run.runId }),
      );
      expect(mocks.verifyUpdateServing).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: run.runId,
          env: run.env,
          expectedVersion: "2026.4.24",
          expectedBuildId: "candidate-build",
          expectedBootId: "doctor-boot",
        }),
      );
      expect(mocks.completeUpdateCommandRun).toHaveBeenCalledWith(
        expect.objectContaining({ status: proof === "verified" ? "ok" : "error" }),
        run,
      );
      expect(mocks.verifyUpdateServing.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.completeUpdateCommandRun.mock.invocationCallOrder[0]!,
      );
    },
  );

  it("does not begin mutable work when canonical admission refuses", async () => {
    mockGitCheckout();
    const error = new Error("state admission refused");
    mocks.admitUpdateCommandRun.mockRejectedValue(error);
    mockUpdateResult({ status: "ok", mode: "git", root: "/repo/link" });
    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).rejects.toBe(error);
    expect(mocks.runGatewayUpdate).not.toHaveBeenCalled();
    expect(mocks.stopGatewayService).not.toHaveBeenCalled();
    expect(mocks.completeUpdateCommandRun).not.toHaveBeenCalled();
  });

  it("settles a pre-mutation throw through the admitted run owner", async () => {
    mockGitCheckout();
    const error = new Error("candidate preparation failed");
    mocks.runGatewayUpdate.mockRejectedValue(error);
    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).rejects.toBe(error);
    const run = await mocks.admitUpdateCommandRun.mock.results[0]?.value;
    expect(mocks.failUpdateCommandRun).toHaveBeenCalledWith(error, run);
    expect(mocks.completeUpdateCommandRun).not.toHaveBeenCalled();
    expect(mocks.stopGatewayService).not.toHaveBeenCalled();
  });

  it.each(["terminal", "lost-response"] as const)(
    "leaves migrated terminal ownership with the installed runtime: %s",
    async (outcome) => {
      mockGitCheckout();
      mockManagedService({
        verdict: { kind: "owned", refreshDefinition: false, fingerprint: "opaque" },
      });
      mockUpdateResult({ status: "ok", mode: "git", root: "/repo/link" });
      mocks.inspectActivatedUpdateState.mockResolvedValue("state-migrated-no-rollback");
      const failure = new Error("candidate finalization response lost");
      if (outcome === "lost-response") {
        mocks.continueMigratedUpdateInFreshProcess.mockRejectedValue(failure);
      }
      const offer = runOffer({ confirm: vi.fn().mockResolvedValue(true) });
      if (outcome === "lost-response") {
        await expect(offer).rejects.toBe(failure);
      } else {
        await expect(offer).resolves.toEqual({ updated: true, handled: true });
      }
      const run = await mocks.admitUpdateCommandRun.mock.results[0]!.value;
      expect(mocks.continueMigratedUpdateInFreshProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          opts: { run },
          ownedManagedUpdateEnv: run.env,
          rollbackBlockedReason: "state-migrated-no-rollback",
        }),
        expect.any(Array),
      );
      expect(mocks.completeUpdateCommandRun).not.toHaveBeenCalled();
      expect(mocks.failUpdateCommandRun).not.toHaveBeenCalled();
      expect(mocks.verifyUpdateServing).not.toHaveBeenCalled();
      expect(mocks.restartUpdatedGateway).not.toHaveBeenCalled();
      expect(mocks.triageCommand).not.toHaveBeenCalled();
    },
  );

  it("executes the update under the admitted service environment and restores the caller", async () => {
    mockGitCheckout();
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    mocks.runGatewayUpdate.mockImplementation(async () => {
      const run = await mocks.admitUpdateCommandRun.mock.results[0]!.value;
      expect(process.env.OPENCLAW_STATE_DIR).toBe(run.env.OPENCLAW_STATE_DIR);
      return { status: "ok", mode: "git", root: "/repo/link", steps: [], durationMs: 0 };
    });
    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).resolves.toEqual({
      updated: true,
      handled: true,
    });
    expect(process.env.OPENCLAW_STATE_DIR).toBe(originalStateDir);
  });

  it("does not admit a declined update", async () => {
    mockGitCheckout();
    await expect(runOffer()).resolves.toEqual({ updated: false });
    expect(mocks.admitUpdateCommandRun).not.toHaveBeenCalled();
    expect(mocks.runGatewayUpdate).not.toHaveBeenCalled();
  });
});

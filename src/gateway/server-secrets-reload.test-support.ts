// Additional credential-owner lifecycle cases registered in the existing auxiliary-handler suite.
import { expect, it, vi } from "vitest";
import {
  listActiveDegradedSecretOwners,
  SecretSurfaceUnavailableError,
  type DegradedSecretOwner,
} from "../secrets/runtime-degraded-state.js";

export type CredentialReloadHarnessOptions = {
  ownerAccountId?: string;
  runtimeAccountId?: string;
  manualStop?: boolean;
  createFailure?: (owner: DegradedSecretOwner) => Error;
};

type CredentialReloadHarness = {
  owner: DegradedSecretOwner;
  reload: () => Promise<void>;
  respond: ReturnType<typeof vi.fn>;
  startChannel: ReturnType<typeof vi.fn>;
  stopChannel: ReturnType<typeof vi.fn>;
  isManuallyStopped: ReturnType<typeof vi.fn>;
};

/** Registers focused account recovery cases against the existing RPC owner and shared fixture. */
export function registerGatewaySecretCredentialReloadCases(
  createHarness: (options?: CredentialReloadHarnessOptions) => CredentialReloadHarness,
): void {
  it("reinspects a previously degraded account without stopping healthy siblings when config is unchanged", async () => {
    const { reload, respond, startChannel, stopChannel } = createHarness();

    await reload();

    expect(stopChannel).not.toHaveBeenCalled();
    expect(startChannel.mock.calls).toEqual([["slack", "ops", { preserveManualStop: true }]]);
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 0 });
  });

  it("accepts only the same trusted credential owner remaining degraded after reinspection", async () => {
    const { owner, reload, respond, startChannel, stopChannel } = createHarness({
      createFailure: (degradedOwner) => new SecretSurfaceUnavailableError(degradedOwner),
    });

    await reload();

    expect(stopChannel).not.toHaveBeenCalled();
    expect(startChannel.mock.calls).toEqual([["slack", "ops", { preserveManualStop: true }]]);
    expect(listActiveDegradedSecretOwners()).toContainEqual(expect.objectContaining(owner));
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 0 });
  });

  it.each(["forged", "different-owner"] as const)(
    "rejects a %s unavailable error instead of treating account recovery as degraded success",
    async (failureKind) => {
      const { owner, reload, respond, stopChannel } = createHarness({
        createFailure: (degradedOwner) =>
          failureKind === "different-owner"
            ? new SecretSurfaceUnavailableError({ ...degradedOwner, ownerId: "slack:other" })
            : Object.setPrototypeOf(
                Object.assign(new Error("forged unavailable error"), {
                  name: "SecretSurfaceUnavailableError",
                  code: "SECRET_SURFACE_UNAVAILABLE",
                  ownerKind: "account",
                  ownerId: degradedOwner.ownerId,
                }),
                SecretSurfaceUnavailableError.prototype,
              ),
      });

      await reload();

      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(stopChannel.mock.calls).toEqual([["slack", "ops", { manual: false }]]);
      expect(listActiveDegradedSecretOwners()).toContainEqual(expect.objectContaining(owner));
    },
  );

  it("does not reinspect a degraded account that an operator manually stopped", async () => {
    const { reload, respond, startChannel, stopChannel } = createHarness({ manualStop: true });

    await reload();

    expect(stopChannel).not.toHaveBeenCalled();
    expect(startChannel).not.toHaveBeenCalled();
    expect(listActiveDegradedSecretOwners()).toContainEqual(
      expect.objectContaining({ ownerId: "slack:ops" }),
    );
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 0 });
  });

  it("recovers the authoritative raw account identity instead of its normalized owner suffix", async () => {
    const { reload, startChannel, stopChannel, isManuallyStopped } = createHarness({
      ownerAccountId: "ops-team",
      runtimeAccountId: "Ops Team",
    });

    await reload();

    expect(isManuallyStopped).toHaveBeenCalledWith("slack", "Ops Team");
    expect(stopChannel).not.toHaveBeenCalled();
    expect(startChannel.mock.calls).toEqual([["slack", "Ops Team", { preserveManualStop: true }]]);
  });
}

import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { approveBootstrapDevicePairing, approveDevicePairing } from "./device-pairing-approval.js";
import { withDevicePairingLock } from "./device-pairing-state.js";
import { ensureDeviceToken } from "./device-pairing-tokens.js";
import { getPairedDevice, listDevicePairing, requestDevicePairing } from "./device-pairing.js";

const roots = createSuiteTempRootTracker({ prefix: "openclaw-pairing-approval-policy-" });

beforeAll(async () => {
  await roots.setup();
});
afterAll(async () => {
  closeOpenClawStateDatabaseForTest();
  await roots.cleanup();
});

describe("automatic pairing policy at commit", () => {
  it("preserves the current token when a stale handshake waits for the issuance lock", async () => {
    const baseDir = await roots.make();
    const pending = await requestDevicePairing(
      {
        deviceId: "browser",
        publicKey: "browser-key",
        role: "operator",
        scopes: ["operator.read"],
      },
      baseDir,
    );
    await approveDevicePairing(
      pending.request.requestId,
      { callerScopes: ["operator.read"] },
      baseDir,
    );
    const original = await ensureDeviceToken({
      deviceId: "browser",
      role: "operator",
      scopes: ["operator.read"],
      issuer: { kind: "shared-gateway-auth", generation: "current" },
      baseDir,
    });
    assert(original);
    let allowed = true;
    const locked = createDeferredCore();
    const release = createDeferredCore();
    const holding = withDevicePairingLock(async () => {
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    try {
      const issuing = ensureDeviceToken({
        deviceId: "browser",
        role: "operator",
        scopes: ["operator.read"],
        issuer: { kind: "shared-gateway-auth", generation: "stale" },
        isIssuanceCurrent: () => allowed,
        baseDir,
      });
      allowed = false;
      release.resolve();
      await holding;
      expect(Boolean(await issuing)).toBe(false);
      const current = await getPairedDevice("browser", baseDir);
      const currentToken = current?.tokens?.operator;
      assert(currentToken);
      expect(currentToken.token === original.token).toBe(true);
      expect(currentToken.issuer?.generation).toBe("current");
    } finally {
      release.resolve();
      await holding;
    }
  });

  it.each(["owner", "bootstrap"] as const)(
    "keeps %s approval pending when its policy is revoked while waiting for the lock",
    async (lane) => {
      const baseDir = await roots.make();
      const pending = await requestDevicePairing(
        {
          deviceId: "browser",
          publicKey: "browser-key",
          role: "operator",
          scopes: ["operator.read"],
        },
        baseDir,
      );
      let allowed = true;
      const options = { isApprovalCurrent: () => allowed };
      const locked = createDeferredCore();
      const release = createDeferredCore();
      const holding = withDevicePairingLock(async () => {
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const approve = () =>
        lane === "bootstrap"
          ? approveBootstrapDevicePairing(
              pending.request.requestId,
              { roles: ["operator"], scopes: ["operator.read"] },
              options,
              baseDir,
            )
          : approveDevicePairing(
              pending.request.requestId,
              { ...options, callerScopes: ["operator.read"] },
              baseDir,
            );
      try {
        const approval = approve();
        allowed = false;
        release.resolve();
        await holding;

        await expect(approval).resolves.toEqual({
          status: "forbidden",
          reason: "approval-policy-changed",
        });
        await expect(getPairedDevice("browser", baseDir)).resolves.toBeNull();
        expect((await listDevicePairing(baseDir)).pending.map((entry) => entry.requestId)).toEqual([
          pending.request.requestId,
        ]);

        allowed = true;
        await expect(approve()).resolves.toMatchObject({ status: "approved" });
      } finally {
        release.resolve();
        await holding;
      }
    },
  );
});

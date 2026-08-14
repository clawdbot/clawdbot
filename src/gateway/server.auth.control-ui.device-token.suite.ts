import { expect, test } from "vitest";
import { startControlUiServerWithClient } from "./server.auth.control-ui.fixtures.test-support.js";
import {
  connectReq,
  ConnectErrorDetailCodes,
  ensurePairedDeviceTokenForCurrentIdentity,
  openWs,
  restoreGatewayToken,
  startRateLimitedTokenServerWithPairedDeviceToken,
} from "./server.auth.test-helpers.js";

export function registerControlUiDeviceTokenSuite(): void {
  test("device token auth matrix", async () => {
    const { server, ws, port, prevToken } = await startControlUiServerWithClient("secret");
    const { identity, deviceToken, deviceIdentityPath } =
      await ensurePairedDeviceTokenForCurrentIdentity(ws);
    const { getPairedDevice } = await import("../infra/device-pairing.js");
    ws.close();

    const scenarios: Array<{
      name: string;
      opts: Parameters<typeof connectReq>[1];
      assert: (res: Awaited<ReturnType<typeof connectReq>>) => void;
    }> = [
      {
        name: "accepts device token auth for paired device",
        opts: { token: deviceToken },
        assert: (res) => {
          expect(res.ok).toBe(true);
        },
      },
      {
        name: "accepts explicit auth.deviceToken when shared token is omitted",
        opts: {
          skipDefaultAuth: true,
          deviceToken,
        },
        assert: (res) => {
          expect(res.ok).toBe(true);
        },
      },
      {
        name: "uses explicit auth.deviceToken fallback when shared token is wrong",
        opts: {
          token: "wrong",
          deviceToken,
        },
        assert: (res) => {
          expect(res.ok).toBe(true);
        },
      },
      {
        name: "keeps shared token mismatch reason when fallback device-token check fails",
        opts: { token: "wrong" },
        assert: (res) => {
          expect(res.ok).toBe(false);
          expect(res.error?.message ?? "").toContain("gateway token mismatch");
          expect(res.error?.message ?? "").not.toContain("device token mismatch");
          const details = res.error?.details as
            | {
                code?: string;
                canRetryWithDeviceToken?: boolean;
                recommendedNextStep?: string;
              }
            | undefined;
          expect(details?.code).toBe(ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH);
          expect(details?.canRetryWithDeviceToken).toBe(true);
          expect(details?.recommendedNextStep).toBe("retry_with_device_token");
        },
      },
      {
        name: "reports device token mismatch when explicit auth.deviceToken is wrong",
        opts: {
          skipDefaultAuth: true,
          deviceToken: "not-a-valid-device-token",
        },
        assert: (res) => {
          expect(res.ok).toBe(false);
          expect(res.error?.message ?? "").toContain("device token mismatch");
          expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
            ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH,
          );
        },
      },
    ];

    try {
      for (const scenario of scenarios) {
        const ws2 = await openWs(port);
        try {
          const res = await connectReq(ws2, {
            ...scenario.opts,
            deviceIdentityPath,
          });
          scenario.assert(res);
        } finally {
          ws2.close();
        }
      }
      const paired = await getPairedDevice(identity.deviceId);
      expect(paired?.lastSeenReason).toBe("connect");
      expect(typeof paired?.lastSeenAtMs).toBe("number");
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("keeps shared-secret lockout separate from device-token auth", async () => {
    const { server, port, prevToken, deviceToken, deviceIdentityPath } =
      await startRateLimitedTokenServerWithPairedDeviceToken();
    try {
      const wsBadShared = await openWs(port);
      const badShared = await connectReq(wsBadShared, { token: "wrong", device: null });
      expect(badShared.ok).toBe(false);
      wsBadShared.close();

      const wsSharedLocked = await openWs(port);
      const sharedLocked = await connectReq(wsSharedLocked, { token: "secret", device: null });
      expect(sharedLocked.ok).toBe(false);
      expect(sharedLocked.error?.message ?? "").toContain("retry later");
      wsSharedLocked.close();

      const wsDevice = await openWs(port);
      const deviceOk = await connectReq(wsDevice, { token: deviceToken, deviceIdentityPath });
      expect(deviceOk.ok).toBe(true);
      wsDevice.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("keeps device-token lockout separate from shared-secret auth", async () => {
    const { server, port, prevToken, deviceToken, deviceIdentityPath } =
      await startRateLimitedTokenServerWithPairedDeviceToken();
    try {
      const wsBadDevice = await openWs(port);
      const badDevice = await connectReq(wsBadDevice, {
        skipDefaultAuth: true,
        deviceToken: "wrong",
        deviceIdentityPath,
      });
      expect(badDevice.ok).toBe(false);
      wsBadDevice.close();

      const wsDeviceLocked = await openWs(port);
      const deviceLocked = await connectReq(wsDeviceLocked, {
        skipDefaultAuth: true,
        deviceToken: "wrong",
        deviceIdentityPath,
      });
      expect(deviceLocked.ok).toBe(false);
      expect(deviceLocked.error?.message ?? "").toContain("retry later");
      wsDeviceLocked.close();

      const wsShared = await openWs(port);
      const sharedOk = await connectReq(wsShared, { token: "secret", device: null });
      expect(sharedOk.ok).toBe(true);
      wsShared.close();

      const wsDeviceReal = await openWs(port);
      const deviceStillLocked = await connectReq(wsDeviceReal, {
        token: deviceToken,
        deviceIdentityPath,
      });
      expect(deviceStillLocked.ok).toBe(false);
      expect(deviceStillLocked.error?.message ?? "").toContain("retry later");
      wsDeviceReal.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("rejects revoked device token", async () => {
    const { revokeDeviceToken } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startControlUiServerWithClient("secret");
    const { identity, deviceToken, deviceIdentityPath } =
      await ensurePairedDeviceTokenForCurrentIdentity(ws);

    await revokeDeviceToken({ deviceId: identity.deviceId, role: "operator" });

    ws.close();

    const ws2 = await openWs(port);
    const res2 = await connectReq(ws2, { token: deviceToken, deviceIdentityPath });
    expect(res2.ok).toBe(false);

    ws2.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
    }
  });
}

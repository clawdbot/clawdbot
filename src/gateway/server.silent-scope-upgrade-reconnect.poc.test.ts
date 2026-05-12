import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import * as devicePairingModule from "../infra/device-pairing.js";
import {
  approveDevicePairing,
  getPairedDevice,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { callGateway } from "./call.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
} from "./device-authz.test-helpers.js";
import { withOperatorApprovalsGatewayClient } from "./operator-approvals-client.js";
import {
  connectOk,
  connectReq,
  installGatewayTestHooks,
  onceMessage,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function expectRejectedScopeUpgradeAttempt({
  attempt,
  requestedEvent,
  deviceId,
  token,
}: {
  attempt: { error?: { details?: unknown } };
  requestedEvent: Promise<unknown>;
  deviceId: string;
  token: string;
}) {
  const pending = await devicePairingModule.listDevicePairing();
  expect(pending.pending).toHaveLength(1);
  expect(
    (
      (attempt.error?.details ?? {}) as {
        requestId?: unknown;
        reason?: unknown;
        remediationHint?: unknown;
        requestedRole?: unknown;
        requestedScopes?: unknown;
        approvedScopes?: unknown;
      }
    ).requestId,
  ).toBe(pending.pending[0]?.requestId);
  expect(
    (
      (attempt.error?.details ?? {}) as {
        requestId?: unknown;
        reason?: unknown;
        requestedRole?: unknown;
        requestedScopes?: unknown;
        approvedScopes?: unknown;
      }
    ).reason,
  ).toBe("scope-upgrade");
  expect(
    (
      (attempt.error?.details ?? {}) as {
        requestId?: unknown;
        reason?: unknown;
        requestedRole?: unknown;
        requestedScopes?: unknown;
        approvedScopes?: unknown;
      }
    ).requestedRole,
  ).toBe("operator");
  expect(
    (
      (attempt.error?.details ?? {}) as {
        requestId?: unknown;
        reason?: unknown;
        requestedRole?: unknown;
        requestedScopes?: unknown;
        approvedScopes?: unknown;
      }
    ).requestedScopes,
  ).toEqual(["operator.admin"]);
  expect(
    (
      (attempt.error?.details ?? {}) as {
        requestId?: unknown;
        reason?: unknown;
        requestedRole?: unknown;
        requestedScopes?: unknown;
        approvedScopes?: unknown;
      }
    ).approvedScopes,
  ).toEqual(["operator.read"]);
  expect(
    (
      (attempt.error?.details ?? {}) as {
        requestId?: unknown;
        reason?: unknown;
        remediationHint?: unknown;
        requestedRole?: unknown;
        requestedScopes?: unknown;
        approvedScopes?: unknown;
      }
    ).remediationHint,
  ).toBe("Review the requested scopes, then approve the pending upgrade.");

  const requested = (await requestedEvent) as {
    payload?: { requestId?: string; deviceId?: string; scopes?: string[] };
  };
  expect(requested.payload?.requestId).toBe(pending.pending[0]?.requestId);
  expect(requested.payload?.deviceId).toBe(deviceId);
  expect(requested.payload?.scopes).toEqual(["operator.admin"]);

  const paired = await getPairedDevice(deviceId);
  expect(paired?.approvedScopes).toEqual(["operator.read"]);
  expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
  expect(paired?.tokens?.operator?.token).toBe(token);
}

describe("gateway silent scope-upgrade reconnect", () => {
  test("does not silently widen a read-scoped paired device to admin on shared-auth reconnect", async () => {
    const started = await startServerWithClient("secret");
    const paired = await issueOperatorToken({
      name: "silent-scope-upgrade-reconnect-poc",
      approvedScopes: ["operator.read"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });

    let watcherWs: WebSocket | undefined;
    let sharedAuthReconnectWs: WebSocket | undefined;
    let postAttemptDeviceTokenWs: WebSocket | undefined;

    try {
      watcherWs = await openTrackedWs(started.port);
      await connectOk(watcherWs, { scopes: ["operator.admin"] });
      const requestedEvent = onceMessage(
        watcherWs,
        (obj) => obj.type === "event" && obj.event === "device.pair.requested",
      );
      sharedAuthReconnectWs = await openTrackedWs(started.port);
      const sharedAuthUpgradeAttempt = await connectReq(sharedAuthReconnectWs, {
        token: "secret",
        deviceIdentityPath: paired.identityPath,
        scopes: ["operator.admin"],
      });
      expect(sharedAuthUpgradeAttempt.ok).toBe(false);
      expect(sharedAuthUpgradeAttempt.error?.message).toBe(
        "pairing required: device is asking for more scopes than currently approved",
      );

      await expectRejectedScopeUpgradeAttempt({
        attempt: sharedAuthUpgradeAttempt,
        requestedEvent,
        deviceId: paired.deviceId,
        token: paired.token,
      });

      postAttemptDeviceTokenWs = await openTrackedWs(started.port);
      const afterUpgrade = await connectReq(postAttemptDeviceTokenWs, {
        skipDefaultAuth: true,
        deviceToken: paired.token,
        deviceIdentityPath: paired.identityPath,
        scopes: ["operator.admin"],
      });
      expect(afterUpgrade.ok).toBe(false);
    } finally {
      watcherWs?.close();
      sharedAuthReconnectWs?.close();
      postAttemptDeviceTokenWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("does not let backend reconnect bypass the paired scope baseline", async () => {
    const started = await startServerWithClient("secret");
    const paired = await issueOperatorToken({
      name: "backend-scope-upgrade-reconnect-poc",
      approvedScopes: ["operator.read"],
      clientId: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientMode: GATEWAY_CLIENT_MODES.BACKEND,
    });

    let watcherWs: WebSocket | undefined;
    let backendReconnectWs: WebSocket | undefined;

    try {
      watcherWs = await openTrackedWs(started.port);
      await connectOk(watcherWs, { scopes: ["operator.admin"] });
      const requestedEvent = onceMessage(
        watcherWs,
        (obj) => obj.type === "event" && obj.event === "device.pair.requested",
      );

      backendReconnectWs = await openTrackedWs(started.port);
      const reconnectAttempt = await connectReq(backendReconnectWs, {
        token: "secret",
        deviceIdentityPath: paired.identityPath,
        client: {
          id: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          version: "1.0.0",
          platform: "node",
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
        role: "operator",
        scopes: ["operator.admin"],
      });
      expect(reconnectAttempt.ok).toBe(false);
      expect(reconnectAttempt.error?.message).toBe(
        "pairing required: device is asking for more scopes than currently approved",
      );

      await expectRejectedScopeUpgradeAttempt({
        attempt: reconnectAttempt,
        requestedEvent,
        deviceId: paired.deviceId,
        token: paired.token,
      });
    } finally {
      watcherWs?.close();
      backendReconnectWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("keeps direct-local backend callGateway scoped calls off stale paired CLI baseline", async () => {
    const started = await startServerWithClient("secret");
    const identity = loadOrCreateDeviceIdentity();
    const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
    const request = await requestDevicePairing({
      deviceId: identity.deviceId,
      publicKey,
      role: "operator",
      scopes: ["operator.read"],
      clientId: GATEWAY_CLIENT_NAMES.CLI,
      clientMode: GATEWAY_CLIENT_MODES.CLI,
    });
    await approveDevicePairing(request.request.requestId, {
      callerScopes: ["operator.read"],
    });

    try {
      const health = await callGateway({
        url: `ws://127.0.0.1:${started.port}`,
        token: "secret",
        method: "health",
        scopes: ["operator.admin"],
        timeoutMs: 2_000,
      });
      expect(health.ok).toBe(true);

      const paired = await getPairedDevice(identity.deviceId);
      expect(paired?.approvedScopes).toEqual(["operator.read"]);
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("keeps local native approval clients off stale paired gateway-client baseline", async () => {
    const started = await startServerWithClient("secret");
    const identity = loadOrCreateDeviceIdentity();
    const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
    const request = await requestDevicePairing({
      deviceId: identity.deviceId,
      publicKey,
      role: "operator",
      scopes: ["operator.read"],
      clientId: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientMode: GATEWAY_CLIENT_MODES.BACKEND,
    });
    await approveDevicePairing(request.request.requestId, {
      callerScopes: ["operator.read"],
    });

    try {
      await expect(
        withOperatorApprovalsGatewayClient(
          {
            config: {
              gateway: { port: started.port, auth: { mode: "token", token: "secret" } },
            } as never,
            clientDisplayName: "test native approvals",
          },
          async () => undefined,
        ),
      ).resolves.toBeUndefined();

      const pending = await devicePairingModule.listDevicePairing();
      expect(pending.pending).toHaveLength(0);
      const paired = await getPairedDevice(identity.deviceId);
      expect(paired?.approvedScopes).toEqual(["operator.read"]);
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("accepts local silent reconnect when pairing was concurrently approved", async () => {
    const started = await startServerWithClient("secret");
    const loaded = loadDeviceIdentity("silent-reconnect-race");
    let ws: WebSocket | undefined;

    const approveOriginal = devicePairingModule.approveDevicePairing;
    let simulatedRace = false;
    const forwardApprove = async (requestId: string, optionsOrBaseDir?: unknown) => {
      if (optionsOrBaseDir && typeof optionsOrBaseDir === "object") {
        return await approveOriginal(
          requestId,
          optionsOrBaseDir as { callerScopes?: readonly string[] },
        );
      }
      return await approveOriginal(requestId);
    };
    const approveSpy = vi
      .spyOn(devicePairingModule, "approveDevicePairing")
      .mockImplementation(async (requestId: string, optionsOrBaseDir?: unknown) => {
        if (simulatedRace) {
          return await forwardApprove(requestId, optionsOrBaseDir);
        }
        simulatedRace = true;
        await forwardApprove(requestId, optionsOrBaseDir);
        return null;
      });

    try {
      ws = await openTrackedWs(started.port);
      const res = await connectReq(ws, {
        token: "secret",
        deviceIdentityPath: loaded.identityPath,
      });
      expect(res.ok).toBe(true);

      const paired = await getPairedDevice(loaded.identity.deviceId);
      expect(paired?.publicKey).toBe(loaded.publicKey);
      const operatorToken = paired?.tokens?.operator?.token;
      if (typeof operatorToken !== "string") {
        throw new Error("expected approved device operator token");
      }
      expect(operatorToken.length).toBeGreaterThan(0);
    } finally {
      approveSpy.mockRestore();
      ws?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("does not rebroadcast a deleted silent pairing request after a concurrent rejection", async () => {
    const started = await startServerWithClient("secret");
    const loaded = loadDeviceIdentity("silent-reconnect-reject-race");
    let ws: WebSocket | undefined;

    const approveSpy = vi
      .spyOn(devicePairingModule, "approveDevicePairing")
      .mockImplementation(async (requestId: string) => {
        await devicePairingModule.rejectDevicePairing(requestId);
        return null;
      });

    try {
      await connectOk(started.ws, { scopes: ["operator.pairing"], device: null });
      const requestedEvent = onceMessage(
        started.ws,
        (obj) => obj.type === "event" && obj.event === "device.pair.requested",
        300,
      )
        .then((event) => ({ ok: true as const, event }))
        .catch((error: unknown) => ({ ok: false as const, error }));

      ws = await openTrackedWs(started.port);
      const res = await connectReq(ws, {
        token: "secret",
        deviceIdentityPath: loaded.identityPath,
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message).toBe("pairing required: device is not approved yet");
      expect(
        (res.error?.details as { requestId?: unknown; code?: string } | undefined)?.requestId,
      ).toBeUndefined();
      const requested = await requestedEvent;
      expect(requested.ok).toBe(false);
      if (requested.ok) {
        throw new Error("expected pairing request watcher to time out");
      }
      expect(requested.error).toBeInstanceOf(Error);
      expect((requested.error as Error).message).toContain("timeout");

      const pending = await devicePairingModule.listDevicePairing();
      expect(pending.pending).toStrictEqual([]);
    } finally {
      approveSpy.mockRestore();
      ws?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("returns the replacement pending request id when a silent request is superseded", async () => {
    const started = await startServerWithClient("secret");
    const loaded = loadDeviceIdentity("silent-reconnect-supersede-race");
    let ws: WebSocket | undefined;
    let replacementRequestId = "";

    const approveSpy = vi
      .spyOn(devicePairingModule, "approveDevicePairing")
      .mockImplementation(async (_requestId: string) => {
        const replacement = await devicePairingModule.requestDevicePairing({
          deviceId: loaded.identity.deviceId,
          publicKey: loaded.publicKey,
          role: "operator",
          scopes: ["operator.read"],
          clientId: GATEWAY_CLIENT_NAMES.TEST,
          clientMode: GATEWAY_CLIENT_MODES.TEST,
          silent: false,
        });
        replacementRequestId = replacement.request.requestId;
        return null;
      });

    try {
      ws = await openTrackedWs(started.port);
      const res = await connectReq(ws, {
        token: "secret",
        deviceIdentityPath: loaded.identityPath,
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message).toBe("pairing required: device is not approved yet");
      expect(replacementRequestId).toBeTypeOf("string");
      expect(replacementRequestId.length).toBeGreaterThan(0);
      expect(
        (res.error?.details as { requestId?: unknown; code?: string } | undefined)?.requestId,
      ).toBe(replacementRequestId);

      const pending = await devicePairingModule.listDevicePairing();
      expect(pending.pending.map((entry) => entry.requestId)).toContain(replacementRequestId);
    } finally {
      approveSpy.mockRestore();
      ws?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});

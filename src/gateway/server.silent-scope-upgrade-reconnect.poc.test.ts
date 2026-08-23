// Silent scope-upgrade reconnect tests document pairing-request notifications,
// approval flow details, and operator reconnect behavior after scope expansion.
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

await import("./server.js");

type ScopeUpgradeAttempt = {
  ok?: unknown;
  error?: { message?: unknown; details?: unknown };
};

type ScopeUpgradeDetails = {
  requestId?: unknown;
  reason?: unknown;
  remediationHint?: unknown;
  requestedRole?: unknown;
  requestedScopes?: unknown;
  approvedScopes?: unknown;
};

function scopeUpgradeDetails(attempt: ScopeUpgradeAttempt) {
  return (attempt.error?.details ?? {}) as ScopeUpgradeDetails;
}

async function watchScopeUpgradeRequests(port: number) {
  const ws = await openTrackedWs(port);
  await connectOk(ws, { scopes: ["operator.admin"] });
  const requestedEvent = onceMessage(
    ws,
    (obj) => obj.type === "event" && obj.event === "device.pair.requested",
  );
  return { ws, requestedEvent };
}

async function issueReadScopedOperatorToken(params: {
  name: string;
  clientId: string;
  clientMode: string;
}) {
  return await issueOperatorToken({
    ...params,
    approvedScopes: ["operator.read"],
  });
}

async function approveReadScopedDevice(params: { clientId: string; clientMode: string }) {
  const identity = loadOrCreateDeviceIdentity();
  const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
  const request = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey,
    role: "operator",
    scopes: ["operator.read"],
    clientId: params.clientId,
    clientMode: params.clientMode,
  });
  await approveDevicePairing(request.request.requestId, {
    callerScopes: ["operator.read"],
  });
  return identity;
}

async function connectWithLoadedIdentity(
  port: number,
  loaded: ReturnType<typeof loadDeviceIdentity>,
) {
  const ws = await openTrackedWs(port);
  const res = await connectReq(ws, {
    token: "secret",
    deviceIdentityPath: loaded.identityPath,
  });
  return { ws, res };
}

function responseRequestId(response: ScopeUpgradeAttempt) {
  return (response.error?.details as { requestId?: unknown; code?: string } | undefined)?.requestId;
}

async function expectReadScopedPairing(deviceId: string) {
  const paired = await getPairedDevice(deviceId);
  expect(paired?.approvedScopes).toEqual(["operator.read"]);
  return paired;
}

async function closeStartedGateway(started: Awaited<ReturnType<typeof startServerWithClient>>) {
  started.ws.close();
  await started.server.close();
  started.envSnapshot.restore();
}

async function expectRejectedScopeUpgradeAttempt({
  attempt,
  requestedEvent,
  deviceId,
  token,
}: {
  attempt: ScopeUpgradeAttempt;
  requestedEvent: Promise<unknown>;
  deviceId: string;
  token: string;
}) {
  const pending = await devicePairingModule.listDevicePairing();
  expect(pending.pending).toHaveLength(1);
  const details = scopeUpgradeDetails(attempt);
  expect(details.requestId).toBe(pending.pending[0]?.requestId);
  expect(details.reason).toBe("scope-upgrade");
  expect(details.requestedRole).toBe("operator");
  expect(details.requestedScopes).toEqual(["operator.admin"]);
  expect(details.approvedScopes).toEqual(["operator.read"]);
  expect(details.remediationHint).toBe(
    "Review the requested scopes, then approve the pending upgrade.",
  );

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
    const paired = await issueReadScopedOperatorToken({
      name: "silent-scope-upgrade-reconnect-poc",
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });

    let watcherWs: WebSocket | undefined;
    let sharedAuthReconnectWs: WebSocket | undefined;
    let postAttemptDeviceTokenWs: WebSocket | undefined;
    let requestedEvent: Promise<unknown>;

    try {
      ({ ws: watcherWs, requestedEvent } = await watchScopeUpgradeRequests(started.port));
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
      await closeStartedGateway(started);
    }
  });

  test("does not let backend reconnect bypass the paired scope baseline", async () => {
    const started = await startServerWithClient("secret");
    const paired = await issueReadScopedOperatorToken({
      name: "backend-scope-upgrade-reconnect-poc",
      clientId: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientMode: GATEWAY_CLIENT_MODES.BACKEND,
    });

    let watcherWs: WebSocket | undefined;
    let backendReconnectWs: WebSocket | undefined;
    let requestedEvent: Promise<unknown>;

    try {
      ({ ws: watcherWs, requestedEvent } = await watchScopeUpgradeRequests(started.port));

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
      await closeStartedGateway(started);
    }
  });

  test("keeps direct-local backend callGateway scoped calls off stale paired CLI baseline", async () => {
    const started = await startServerWithClient("secret");
    const identity = await approveReadScopedDevice({
      clientId: GATEWAY_CLIENT_NAMES.CLI,
      clientMode: GATEWAY_CLIENT_MODES.CLI,
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

      await expectReadScopedPairing(identity.deviceId);
    } finally {
      await closeStartedGateway(started);
    }
  });

  test("keeps direct-local CLI shared-token calls off stale paired CLI baseline", async () => {
    const started = await startServerWithClient("secret");
    const identity = await approveReadScopedDevice({
      clientId: GATEWAY_CLIENT_NAMES.CLI,
      clientMode: GATEWAY_CLIENT_MODES.CLI,
    });

    try {
      const health = await callGateway({
        url: `ws://127.0.0.1:${started.port}`,
        token: "secret",
        method: "health",
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
        timeoutMs: 2_000,
      });
      expect(health.ok).toBe(true);

      const admin = await callGateway({
        url: `ws://127.0.0.1:${started.port}`,
        token: "secret",
        method: "set-heartbeats",
        params: { enabled: false },
        scopes: ["operator.admin"],
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
        timeoutMs: 2_000,
      });
      expect(admin.ok).toBe(true);

      const pending = await devicePairingModule.listDevicePairing();
      expect(pending.pending).toHaveLength(0);
      await expectReadScopedPairing(identity.deviceId);
    } finally {
      await closeStartedGateway(started);
    }
  });

  test("keeps local native approval clients off stale paired gateway-client baseline", async () => {
    const started = await startServerWithClient("secret");
    const identity = await approveReadScopedDevice({
      clientId: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientMode: GATEWAY_CLIENT_MODES.BACKEND,
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
      await expectReadScopedPairing(identity.deviceId);
    } finally {
      await closeStartedGateway(started);
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
      const connection = await connectWithLoadedIdentity(started.port, loaded);
      ws = connection.ws;
      const res = connection.res;
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
      await closeStartedGateway(started);
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

      const connection = await connectWithLoadedIdentity(started.port, loaded);
      ws = connection.ws;
      const res = connection.res;

      expect(res.ok).toBe(false);
      expect(res.error?.message).toBe("pairing required: device is not approved yet");
      expect(responseRequestId(res)).toBeUndefined();
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
      await closeStartedGateway(started);
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
      const connection = await connectWithLoadedIdentity(started.port, loaded);
      ws = connection.ws;
      const res = connection.res;

      expect(res.ok).toBe(false);
      expect(res.error?.message).toBe("pairing required: device is not approved yet");
      expect(replacementRequestId).toBeTypeOf("string");
      expect(replacementRequestId.length).toBeGreaterThan(0);
      expect(responseRequestId(res)).toBe(replacementRequestId);

      const pending = await devicePairingModule.listDevicePairing();
      expect(pending.pending.map((entry) => entry.requestId)).toContain(replacementRequestId);
    } finally {
      approveSpy.mockRestore();
      ws?.close();
      await closeStartedGateway(started);
    }
  });
});

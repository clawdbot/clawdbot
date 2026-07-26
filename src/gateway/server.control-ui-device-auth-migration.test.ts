// Upgrade regression: retired Control UI bypass users can explicitly pair without host-shell recovery.
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import { CONTROL_UI_CLIENT } from "./server.auth.test-helpers.js";
import { shouldRetainControlUiDeviceAuthMigrationSession } from "./server.impl.js";
import {
  connectReq,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  readConnectChallengeNonce,
  rpcReq,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const BROWSER_ORIGIN = "https://control.example.com";
const SCOPES = ["operator.admin", "operator.pairing"];

async function signedDevice(ws: WebSocket, identityPath: string, scopes: string[] = SCOPES) {
  const nonce = await readConnectChallengeNonce(ws);
  const identity = loadOrCreateDeviceIdentity({ path: identityPath });
  const signedAt = Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId: CONTROL_UI_CLIENT.id,
    clientMode: CONTROL_UI_CLIENT.mode,
    role: "operator",
    scopes,
    signedAtMs: signedAt,
    token: "secret",
    nonce: nonce ?? "",
  });
  return {
    identity,
    device: {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      signature: signDevicePayload(identity.privateKeyPem, payload),
      signedAt,
      nonce: nonce ?? "",
    },
  };
}

describe("Control UI device-auth upgrade migration", () => {
  it("retains only the migration session bound to the approved public key", () => {
    const approvedIdentity = loadOrCreateDeviceIdentity({
      path: path.join(os.tmpdir(), `openclaw-device-auth-approved-${randomUUID()}.sqlite`),
    });
    const otherIdentity = loadOrCreateDeviceIdentity({
      path: path.join(os.tmpdir(), `openclaw-device-auth-other-${randomUUID()}.sqlite`),
    });
    const approvedPublicKey = publicKeyRawBase64UrlFromPem(approvedIdentity.publicKeyPem);
    const otherPublicKey = publicKeyRawBase64UrlFromPem(otherIdentity.publicKeyPem);
    const approvedDevice = {
      deviceId: approvedIdentity.deviceId,
      publicKey: approvedPublicKey,
      scopes: SCOPES,
    };

    expect(
      shouldRetainControlUiDeviceAuthMigrationSession({
        sessionDevice: { id: approvedIdentity.deviceId, publicKey: approvedPublicKey },
        approvedDevice,
      }),
    ).toBe(true);
    expect(
      shouldRetainControlUiDeviceAuthMigrationSession({
        sessionDevice: { id: approvedIdentity.deviceId, publicKey: otherPublicKey },
        approvedDevice,
      }),
    ).toBe(false);
    expect(
      shouldRetainControlUiDeviceAuthMigrationSession({
        sessionDevice: { id: otherIdentity.deviceId, publicKey: approvedPublicKey },
        approvedDevice,
      }),
    ).toBe(false);
  });

  it("keeps a device-less legacy browser online with secure-context remediation", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      meta: { lastTouchedVersion: "2026.7.1" },
      gateway: {
        trustedProxies: ["127.0.0.1"],
        controlUi: {
          allowedOrigins: [BROWSER_ORIGIN],
          dangerouslyDisableDeviceAuth: true,
        },
      },
    });
    testState.gatewayAuth = { mode: "token", token: "secret" };
    const harness = await createGatewaySuiteHarness();
    const headers = {
      origin: BROWSER_ORIGIN,
      "x-forwarded-for": "203.0.113.50",
    };
    let ws: WebSocket | undefined;
    try {
      ws = await harness.openWs(headers);
      const connected = await connectReq(ws, {
        token: "secret",
        scopes: SCOPES,
        client: CONTROL_UI_CLIENT,
        device: null,
      });
      expect(connected.ok).toBe(true);
      expect(connected.payload).toMatchObject({
        deviceAuthMigration: { pending: true },
        auth: { role: "operator", scopes: ["operator.pairing"] },
      });
      expect(
        (connected.payload as { auth?: { deviceToken?: string } } | undefined)?.auth?.deviceToken,
      ).toBeUndefined();

      const { requestDevicePairing } = await import("../infra/device-pairing.js");
      const otherIdentityPath = path.join(
        os.tmpdir(),
        `openclaw-device-auth-migration-device-less-target-${randomUUID()}.sqlite`,
      );
      const otherIdentity = loadOrCreateDeviceIdentity({ path: otherIdentityPath });
      const otherRequest = await requestDevicePairing({
        deviceId: otherIdentity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(otherIdentity.publicKeyPem),
        role: "operator",
        scopes: SCOPES,
      });
      const crossDeviceApproval = await rpcReq(ws, "device.pair.approve", {
        requestId: otherRequest.request.requestId,
      });
      expect(crossDeviceApproval.ok).toBe(false);

      const config = await rpcReq(ws, "config.get", {});
      expect(config.ok).toBe(false);
      expect(config.error?.message).toContain("missing scope");
    } finally {
      ws?.close();
      await harness.close();
    }
  });

  it("preserves trusted-proxy migration access", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      meta: { lastTouchedVersion: "2026.7.1" },
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-proto"],
            allowLoopback: true,
          },
        },
        trustedProxies: ["127.0.0.1"],
        controlUi: {
          allowedOrigins: [BROWSER_ORIGIN],
          dangerouslyDisableDeviceAuth: true,
        },
      },
    });
    testState.gatewayAuth = undefined;
    const harness = await createGatewaySuiteHarness();
    let ws: WebSocket | undefined;
    try {
      ws = await harness.openWs({
        origin: BROWSER_ORIGIN,
        "x-forwarded-for": "203.0.113.50",
        "x-forwarded-proto": "https",
        "x-forwarded-user": "operator@example.com",
      });
      const connected = await connectReq(ws, {
        skipDefaultAuth: true,
        scopes: SCOPES,
        client: CONTROL_UI_CLIENT,
        device: null,
      });
      expect(connected.ok).toBe(true);
      expect(connected.payload).toMatchObject({
        deviceAuthMigration: { pending: true },
        auth: { role: "operator", scopes: ["operator.pairing"] },
      });
      const config = await rpcReq(ws, "config.get", {});
      expect(config.ok).toBe(false);
      expect(config.error?.message).toContain("missing scope");
    } finally {
      ws?.close();
      await harness.close();
    }
  });

  it("preserves trusted-proxy scope caps during migration", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      meta: { lastTouchedVersion: "2026.7.1" },
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-proto"],
            allowLoopback: true,
          },
        },
        trustedProxies: ["127.0.0.1"],
        controlUi: {
          allowedOrigins: [BROWSER_ORIGIN],
          dangerouslyDisableDeviceAuth: true,
        },
      },
    });
    testState.gatewayAuth = undefined;
    const harness = await createGatewaySuiteHarness();
    let ws: WebSocket | undefined;
    try {
      ws = await harness.openWs({
        origin: BROWSER_ORIGIN,
        "x-forwarded-for": "203.0.113.50",
        "x-forwarded-proto": "https",
        "x-forwarded-user": "reader@example.com",
        "x-openclaw-scopes": "operator.read",
      });
      const connected = await connectReq(ws, {
        skipDefaultAuth: true,
        scopes: SCOPES,
        client: CONTROL_UI_CLIENT,
        device: null,
      });
      expect(connected.ok).toBe(true);
      expect(connected.payload).toMatchObject({
        auth: { role: "operator", scopes: [] },
      });
      expect(connected.payload).not.toHaveProperty("deviceAuthMigration");
      const pairings = await rpcReq(ws, "device.pair.list", {});
      expect(pairings.ok).toBe(false);
      expect(pairings.error?.message).toContain("missing scope");
    } finally {
      ws?.close();
      await harness.close();
    }
  });

  it("completes imported migration state when an effective operator already exists", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      meta: { lastTouchedVersion: "2026.7.1" },
      gateway: {
        controlUi: {
          dangerouslyDisableDeviceAuth: true,
        },
      },
    });
    const { approveDevicePairing, requestDevicePairing } =
      await import("../infra/device-pairing.js");
    const ownerIdentity = loadOrCreateDeviceIdentity({
      path: path.join(os.tmpdir(), `openclaw-migration-existing-owner-${randomUUID()}.sqlite`),
    });
    const ownerRequest = await requestDevicePairing({
      deviceId: ownerIdentity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(ownerIdentity.publicKeyPem),
      role: "operator",
      scopes: SCOPES,
    });
    await expect(
      approveDevicePairing(ownerRequest.request.requestId, { callerScopes: SCOPES }),
    ).resolves.toMatchObject({ status: "approved" });

    const harness = await createGatewaySuiteHarness();
    try {
      const { readControlUiDeviceAuthMigrationState } =
        await import("../state/control-ui-device-auth-migration.js");
      expect(readControlUiDeviceAuthMigrationState({ env: process.env })).toMatchObject({
        status: "completed",
        deviceId: ownerIdentity.deviceId,
      });
    } finally {
      await harness.close();
    }
  });

  it("keeps migration pending when existing operators cannot manage pairings", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      meta: { lastTouchedVersion: "2026.7.1" },
      gateway: {
        controlUi: {
          dangerouslyDisableDeviceAuth: true,
        },
      },
    });
    const { approveDevicePairing, requestDevicePairing } =
      await import("../infra/device-pairing.js");
    const ownerIdentity = loadOrCreateDeviceIdentity({
      path: path.join(os.tmpdir(), `openclaw-migration-read-only-owner-${randomUUID()}.sqlite`),
    });
    const ownerRequest = await requestDevicePairing({
      deviceId: ownerIdentity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(ownerIdentity.publicKeyPem),
      role: "operator",
      scopes: ["operator.read"],
    });
    await expect(
      approveDevicePairing(ownerRequest.request.requestId, {
        callerScopes: ["operator.read"],
      }),
    ).resolves.toMatchObject({ status: "approved" });

    const harness = await createGatewaySuiteHarness();
    try {
      const { readControlUiDeviceAuthMigrationState } =
        await import("../state/control-ui-device-auth-migration.js");
      expect(readControlUiDeviceAuthMigrationState({ env: process.env })).toMatchObject({
        status: "pending",
      });
    } finally {
      await harness.close();
    }
  });

  it("rejects an in-flight migration handshake completed before registration", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      meta: { lastTouchedVersion: "2026.7.1" },
      gateway: {
        trustedProxies: ["127.0.0.1"],
        controlUi: {
          allowedOrigins: [BROWSER_ORIGIN],
          dangerouslyDisableDeviceAuth: true,
        },
      },
    });
    testState.gatewayAuth = { mode: "token", token: "secret" };
    const harness = await createGatewaySuiteHarness();
    const connectNodeSession = await import("./server/ws-connection/connect-node-session.js");
    const originalPrepare = connectNodeSession.prepareGatewayNodeConnect;
    let releasePrepare: () => void = () => {};
    const prepareReleased = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    let markPrepareEntered: () => void = () => {};
    const prepareEntered = new Promise<void>((resolve) => {
      markPrepareEntered = resolve;
    });
    const prepareSpy = vi
      .spyOn(connectNodeSession, "prepareGatewayNodeConnect")
      .mockImplementationOnce(async (context, state) => {
        markPrepareEntered();
        await prepareReleased;
        return await originalPrepare(context, state);
      });
    let ws: WebSocket | undefined;
    try {
      ws = await harness.openWs({
        origin: BROWSER_ORIGIN,
        "x-forwarded-for": "203.0.113.50",
      });
      const connected = connectReq(ws, {
        token: "secret",
        scopes: SCOPES,
        client: CONTROL_UI_CLIENT,
        device: null,
      });
      await prepareEntered;

      const { approveDevicePairing, requestDevicePairing } =
        await import("../infra/device-pairing.js");
      const ownerIdentity = loadOrCreateDeviceIdentity({
        path: path.join(os.tmpdir(), `openclaw-migration-race-owner-${randomUUID()}.sqlite`),
      });
      const ownerRequest = await requestDevicePairing({
        deviceId: ownerIdentity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(ownerIdentity.publicKeyPem),
        role: "operator",
        scopes: SCOPES,
      });
      await expect(
        approveDevicePairing(ownerRequest.request.requestId, { callerScopes: SCOPES }),
      ).resolves.toMatchObject({ status: "approved" });
      releasePrepare();

      const result = await connected;
      expect(result.ok).toBe(false);
      expect((result.error?.details as { code?: string } | undefined)?.code).toBe(
        ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
      );
    } finally {
      releasePrepare();
      prepareSpy.mockRestore();
      ws?.close();
      await harness.close();
    }
  });

  it("keeps only the signed legacy browser online until it explicitly pairs", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      meta: { lastTouchedVersion: "2026.7.1" },
      gateway: {
        trustedProxies: ["127.0.0.1"],
        controlUi: {
          allowedOrigins: [BROWSER_ORIGIN],
          dangerouslyDisableDeviceAuth: true,
        },
      },
    });
    testState.gatewayAuth = { mode: "token", token: "secret" };
    const harness = await createGatewaySuiteHarness();
    const { requestDevicePairing } = await import("../infra/device-pairing.js");
    const otherIdentityPath = path.join(
      os.tmpdir(),
      `openclaw-other-pending-${randomUUID()}.sqlite`,
    );
    const otherIdentity = loadOrCreateDeviceIdentity({ path: otherIdentityPath });
    await requestDevicePairing({
      deviceId: otherIdentity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(otherIdentity.publicKeyPem),
      role: "operator",
      scopes: SCOPES,
    });
    const identityPath = path.join(
      os.tmpdir(),
      `openclaw-device-auth-migration-${randomUUID()}.sqlite`,
    );
    const headers = {
      origin: BROWSER_ORIGIN,
      "x-forwarded-for": "203.0.113.50",
    };
    let firstWs: WebSocket | undefined;
    let competingWs: WebSocket | undefined;
    let secondWs: WebSocket | undefined;
    try {
      firstWs = await harness.openWs(headers);
      const first = await signedDevice(firstWs, identityPath);
      const firstConnect = await connectReq(firstWs, {
        token: "secret",
        scopes: SCOPES,
        client: CONTROL_UI_CLIENT,
        device: first.device,
      });
      expect(firstConnect.ok).toBe(true);
      expect(firstConnect.payload).toMatchObject({
        deviceAuthMigration: { pending: true },
        auth: { role: "operator", scopes: ["operator.pairing"] },
      });
      expect(
        (firstConnect.payload as { auth?: { deviceToken?: string } } | undefined)?.auth
          ?.deviceToken,
      ).toBeUndefined();
      const unrelatedAdminCall = await rpcReq(firstWs, "config.get", {});
      expect(unrelatedAdminCall.ok).toBe(false);
      expect(unrelatedAdminCall.error?.message).toContain("missing scope");

      competingWs = await harness.openWs(headers);
      const competing = await signedDevice(competingWs, otherIdentityPath);
      const competingConnect = await connectReq(competingWs, {
        token: "secret",
        scopes: SCOPES,
        client: CONTROL_UI_CLIENT,
        device: competing.device,
      });
      expect(competingConnect.ok).toBe(true);
      expect(competingConnect.payload).toMatchObject({
        auth: { scopes: ["operator.pairing"] },
      });
      const firstClosed = new Promise<number>((resolve) => {
        firstWs!.once("close", resolve);
      });
      const competingClosed = new Promise<number>((resolve) => {
        competingWs!.once("close", resolve);
      });

      const list = await rpcReq<{
        pending: Array<{ requestId: string; deviceId: string }>;
      }>(firstWs, "device.pair.list", {});
      expect(list.ok).toBe(true);
      expect(list.payload?.pending).toHaveLength(1);
      const pending = list.payload?.pending[0];
      expect(pending?.deviceId).toBe(first.identity.deviceId);
      const competingList = await rpcReq<{
        pending: Array<{ requestId: string; deviceId: string }>;
      }>(competingWs, "device.pair.list", {});
      const competingPending = competingList.payload?.pending[0];
      expect(competingPending?.deviceId).toBe(competing.identity.deviceId);

      const [firstApproval, competingApproval] = await Promise.allSettled([
        rpcReq(firstWs, "device.pair.approve", { requestId: pending?.requestId }),
        rpcReq(competingWs, "device.pair.approve", {
          requestId: competingPending?.requestId,
        }),
      ]);
      const firstWon = firstApproval.status === "fulfilled" && firstApproval.value.ok;
      const competingWon = competingApproval.status === "fulfilled" && competingApproval.value.ok;
      expect([firstWon, competingWon].filter(Boolean)).toHaveLength(1);
      if (firstWon) {
        await expect(competingClosed).resolves.toBe(4001);
        competingWs = undefined;
      } else {
        await expect(firstClosed).resolves.toBe(4001);
        firstWs = undefined;
      }

      firstWs?.close();
      firstWs = undefined;
      competingWs?.close();
      competingWs = undefined;
      secondWs = await harness.openWs(headers);
      const second = await signedDevice(secondWs, firstWon ? identityPath : otherIdentityPath);
      const secondConnect = await connectReq(secondWs, {
        token: "secret",
        scopes: SCOPES,
        client: CONTROL_UI_CLIENT,
        device: second.device,
      });
      expect(secondConnect.ok).toBe(true);
      expect(
        (secondConnect.payload as { deviceAuthMigration?: unknown } | undefined)
          ?.deviceAuthMigration,
      ).toBeUndefined();
      expect(
        (secondConnect.payload as { auth?: { deviceToken?: string } } | undefined)?.auth
          ?.deviceToken,
      ).toEqual(expect.any(String));
      expect(
        (secondConnect.payload as { auth?: { scopes?: string[] } } | undefined)?.auth?.scopes,
      ).toEqual(expect.arrayContaining(SCOPES));
    } finally {
      firstWs?.close();
      competingWs?.close();
      secondWs?.close();
      await harness.close();
    }
  });

  it("does not silently auto-approve a local signed migration browser", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      meta: { lastTouchedVersion: "2026.7.1" },
      gateway: {
        controlUi: {
          allowedOrigins: [BROWSER_ORIGIN],
          dangerouslyDisableDeviceAuth: true,
        },
      },
    });
    testState.gatewayAuth = { mode: "token", token: "secret" };
    const harness = await createGatewaySuiteHarness();
    const identityPath = path.join(
      os.tmpdir(),
      `openclaw-device-auth-migration-local-explicit-${randomUUID()}.sqlite`,
    );
    let ws: WebSocket | undefined;
    try {
      ws = await harness.openWs({ origin: BROWSER_ORIGIN });
      const signed = await signedDevice(ws, identityPath);
      const connected = await connectReq(ws, {
        token: "secret",
        scopes: SCOPES,
        client: CONTROL_UI_CLIENT,
        device: signed.device,
      });
      expect(connected.ok).toBe(true);
      expect(connected.payload).toMatchObject({
        deviceAuthMigration: { pending: true },
        auth: { role: "operator", scopes: ["operator.pairing"] },
      });
      expect(
        (connected.payload as { auth?: { deviceToken?: string } } | undefined)?.auth?.deviceToken,
      ).toBeUndefined();

      const list = await rpcReq<{
        pending: Array<{ requestId: string; deviceId: string }>;
      }>(ws, "device.pair.list", {});
      expect(list.payload?.pending).toContainEqual(
        expect.objectContaining({ deviceId: signed.identity.deviceId }),
      );
    } finally {
      ws?.close();
      await harness.close();
    }
  });

  it("adds pairing capability when a migrating browser requested read-only access", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      meta: { lastTouchedVersion: "2026.7.1" },
      gateway: {
        controlUi: {
          allowedOrigins: [BROWSER_ORIGIN],
          dangerouslyDisableDeviceAuth: true,
        },
      },
    });
    testState.gatewayAuth = { mode: "token", token: "secret" };
    const harness = await createGatewaySuiteHarness();
    const identityPath = path.join(
      os.tmpdir(),
      `openclaw-device-auth-migration-read-only-${randomUUID()}.sqlite`,
    );
    let ws: WebSocket | undefined;
    try {
      ws = await harness.openWs({ origin: BROWSER_ORIGIN });
      const signed = await signedDevice(ws, identityPath, ["operator.read"]);
      const connected = await connectReq(ws, {
        token: "secret",
        scopes: ["operator.read"],
        client: CONTROL_UI_CLIENT,
        device: signed.device,
      });
      expect(connected.ok).toBe(true);
      expect(connected.payload).toMatchObject({
        deviceAuthMigration: { pending: true },
        auth: { role: "operator", scopes: ["operator.pairing"] },
      });

      const list = await rpcReq<{
        pending: Array<{ requestId: string; deviceId: string; scopes?: string[] }>;
      }>(ws, "device.pair.list", {});
      const ownRequest = list.payload?.pending.find(
        (request) => request.deviceId === signed.identity.deviceId,
      );
      expect(ownRequest?.scopes).toEqual(
        expect.arrayContaining(["operator.read", "operator.pairing"]),
      );
      const approved = await rpcReq(ws, "device.pair.approve", {
        requestId: ownRequest?.requestId,
      });
      expect(approved.ok).toBe(true);

      const { listDevicePairing } = await import("../infra/device-pairing.js");
      const paired = (await listDevicePairing()).paired.find(
        (device) => device.deviceId === signed.identity.deviceId,
      );
      expect(paired?.tokens?.operator?.scopes).toEqual(
        expect.arrayContaining(["operator.read", "operator.pairing"]),
      );
      const { readControlUiDeviceAuthMigrationState } =
        await import("../state/control-ui-device-auth-migration.js");
      expect(readControlUiDeviceAuthMigrationState({ env: process.env })).toMatchObject({
        status: "completed",
        deviceId: signed.identity.deviceId,
      });
    } finally {
      ws?.close();
      await harness.close();
    }
  });

  it("rejects a device-less migration handshake when an operator is already paired", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      meta: { lastTouchedVersion: "2026.7.1" },
      gateway: {
        trustedProxies: ["127.0.0.1"],
        controlUi: {
          allowedOrigins: [BROWSER_ORIGIN],
          dangerouslyDisableDeviceAuth: true,
        },
      },
    });
    testState.gatewayAuth = { mode: "token", token: "secret" };
    const harness = await createGatewaySuiteHarness();
    const { approveDevicePairing, requestDevicePairing } =
      await import("../infra/device-pairing.js");
    const ownerIdentityPath = path.join(
      os.tmpdir(),
      `openclaw-device-auth-migration-existing-owner-${randomUUID()}.sqlite`,
    );
    const ownerIdentity = loadOrCreateDeviceIdentity({ path: ownerIdentityPath });
    const ownerRequest = await requestDevicePairing({
      deviceId: ownerIdentity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(ownerIdentity.publicKeyPem),
      role: "operator",
      scopes: SCOPES,
    });
    await expect(
      approveDevicePairing(ownerRequest.request.requestId, { callerScopes: SCOPES }),
    ).resolves.toMatchObject({ status: "approved" });

    let ws: WebSocket | undefined;
    try {
      ws = await harness.openWs({
        origin: BROWSER_ORIGIN,
        "x-forwarded-for": "203.0.113.50",
      });
      const connected = await connectReq(ws, {
        token: "secret",
        scopes: SCOPES,
        client: CONTROL_UI_CLIENT,
        device: null,
      });
      expect(connected.ok).toBe(false);
      expect(connected.error?.message).toContain("requires device identity");
    } finally {
      ws?.close();
      await harness.close();
    }
  });

  it("closes competing migration sessions and keeps the winner self-only until reconnect", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      meta: { lastTouchedVersion: "2026.7.1" },
      gateway: {
        trustedProxies: ["127.0.0.1"],
        controlUi: {
          allowedOrigins: [BROWSER_ORIGIN],
          dangerouslyDisableDeviceAuth: true,
        },
      },
    });
    testState.gatewayAuth = { mode: "token", token: "secret" };
    const harness = await createGatewaySuiteHarness();
    const headers = {
      origin: BROWSER_ORIGIN,
      "x-forwarded-for": "203.0.113.50",
    };
    const identityPath = path.join(
      os.tmpdir(),
      `openclaw-device-auth-migration-secure-completion-${randomUUID()}.sqlite`,
    );
    let deviceLessWs: WebSocket | undefined;
    let signedWs: WebSocket | undefined;
    try {
      deviceLessWs = await harness.openWs(headers);
      const deviceLessConnect = await connectReq(deviceLessWs, {
        token: "secret",
        scopes: SCOPES,
        client: CONTROL_UI_CLIENT,
        device: null,
      });
      expect(deviceLessConnect.ok).toBe(true);
      const deviceLessClosed = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("device-less migration session remained open after completion"));
        }, 5_000);
        deviceLessWs!.once("close", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      signedWs = await harness.openWs(headers);
      const signed = await signedDevice(signedWs, identityPath);
      const signedConnect = await connectReq(signedWs, {
        token: "secret",
        scopes: SCOPES,
        client: CONTROL_UI_CLIENT,
        device: signed.device,
      });
      expect(signedConnect.ok).toBe(true);
      const { requestDevicePairing } = await import("../infra/device-pairing.js");
      const otherIdentity = loadOrCreateDeviceIdentity({
        path: path.join(
          os.tmpdir(),
          `openclaw-device-auth-migration-other-pending-${randomUUID()}.sqlite`,
        ),
      });
      const otherRequest = await requestDevicePairing({
        deviceId: otherIdentity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(otherIdentity.publicKeyPem),
        role: "operator",
        scopes: SCOPES,
      });
      const list = await rpcReq<{
        pending: Array<{ requestId: string; deviceId: string }>;
      }>(signedWs, "device.pair.list", {});
      const pending = list.payload?.pending.find(
        (request) => request.deviceId === signed.identity.deviceId,
      );
      expect(pending).toBeDefined();
      const approval = await rpcReq(signedWs, "device.pair.approve", {
        requestId: pending?.requestId,
      });
      expect(approval.ok).toBe(true);
      await expect(deviceLessClosed).resolves.toBe(4001);
      deviceLessWs = undefined;

      const postApprovalList = await rpcReq<{
        pending: Array<{ requestId: string; deviceId: string }>;
        paired: Array<{ deviceId: string }>;
      }>(signedWs, "device.pair.list", {});
      expect(postApprovalList.ok).toBe(true);
      expect(postApprovalList.payload?.pending).toEqual([]);
      expect(postApprovalList.payload?.paired.map((device) => device.deviceId)).toEqual([
        signed.identity.deviceId,
      ]);
      const crossDeviceRejection = await rpcReq(signedWs, "device.pair.reject", {
        requestId: otherRequest.request.requestId,
      });
      expect(crossDeviceRejection.ok).toBe(false);
    } finally {
      deviceLessWs?.close();
      signedWs?.close();
      await harness.close();
    }
  });

  it("denies a stale migration session after another operator is paired", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      meta: { lastTouchedVersion: "2026.7.1" },
      gateway: {
        trustedProxies: ["127.0.0.1"],
        controlUi: {
          allowedOrigins: [BROWSER_ORIGIN],
          dangerouslyDisableDeviceAuth: true,
        },
      },
    });
    testState.gatewayAuth = { mode: "token", token: "secret" };
    const harness = await createGatewaySuiteHarness();
    const headers = {
      origin: BROWSER_ORIGIN,
      "x-forwarded-for": "203.0.113.50",
    };
    const migrationIdentityPath = path.join(
      os.tmpdir(),
      `openclaw-device-auth-migration-stale-${randomUUID()}.sqlite`,
    );
    let migrationWs: WebSocket | undefined;
    try {
      migrationWs = await harness.openWs(headers);
      const migration = await signedDevice(migrationWs, migrationIdentityPath);
      const migrationConnect = await connectReq(migrationWs, {
        token: "secret",
        scopes: SCOPES,
        client: CONTROL_UI_CLIENT,
        device: migration.device,
      });
      expect(migrationConnect.ok).toBe(true);
      expect(migrationConnect.payload).toMatchObject({
        deviceAuthMigration: { pending: true },
        auth: { role: "operator", scopes: ["operator.pairing"] },
      });
      const migrationClosed = new Promise<number>((resolve) => {
        migrationWs!.once("close", resolve);
      });

      const { approveDevicePairing, listDevicePairing, requestDevicePairing } =
        await import("../infra/device-pairing.js");
      const ownerIdentityPath = path.join(
        os.tmpdir(),
        `openclaw-device-auth-migration-owner-${randomUUID()}.sqlite`,
      );
      const ownerIdentity = loadOrCreateDeviceIdentity({ path: ownerIdentityPath });
      const ownerRequest = await requestDevicePairing({
        deviceId: ownerIdentity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(ownerIdentity.publicKeyPem),
        role: "operator",
        scopes: SCOPES,
      });
      await expect(
        approveDevicePairing(ownerRequest.request.requestId, { callerScopes: SCOPES }),
      ).resolves.toMatchObject({ status: "approved" });
      await expect(migrationClosed).resolves.toBe(4001);
      migrationWs = undefined;

      const paired = (await listDevicePairing()).paired;
      expect(paired.some((device) => device.deviceId === ownerIdentity.deviceId)).toBe(true);
      expect(paired.some((device) => device.deviceId === migration.identity.deviceId)).toBe(false);
    } finally {
      migrationWs?.close();
      await harness.close();
    }
  });
});

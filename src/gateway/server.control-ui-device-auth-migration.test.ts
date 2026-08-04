// Upgrade regression: retired Control UI bypass users can explicitly pair without host-shell recovery.
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
const REMOTE_HEADERS = {
  origin: BROWSER_ORIGIN,
  "x-forwarded-for": "203.0.113.50",
};
const REMOTE_MIGRATION_GATEWAY = {
  trustedProxies: ["127.0.0.1"],
  controlUi: {
    allowedOrigins: [BROWSER_ORIGIN],
    dangerouslyDisableDeviceAuth: true,
  },
} satisfies NonNullable<OpenClawConfig["gateway"]>;
const LOCAL_MIGRATION_GATEWAY = {
  controlUi: {
    allowedOrigins: [BROWSER_ORIGIN],
    dangerouslyDisableDeviceAuth: true,
  },
} satisfies NonNullable<OpenClawConfig["gateway"]>;
const TRUSTED_PROXY_MIGRATION_GATEWAY = {
  auth: {
    mode: "trusted-proxy",
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
  },
  ...REMOTE_MIGRATION_GATEWAY,
} satisfies NonNullable<OpenClawConfig["gateway"]>;
const STATE_ONLY_MIGRATION_GATEWAY = {
  controlUi: { dangerouslyDisableDeviceAuth: true },
} satisfies NonNullable<OpenClawConfig["gateway"]>;
const TOKEN_AUTH = { mode: "token", token: "secret" };

type MigrationHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type TrackedMigrationHarness = Omit<MigrationHarness, "openWs"> & {
  openWs: MigrationHarness["openWs"];
};

function identityPath(label: string): string {
  return path.join(os.tmpdir(), `openclaw-${label}-${randomUUID()}.sqlite`);
}

function createIdentity(label: string) {
  return loadOrCreateDeviceIdentity({ path: identityPath(label) });
}

async function requestOperatorPairing(label: string, scopes: string[] = SCOPES) {
  const { requestDevicePairing } = await import("../infra/device-pairing.js");
  const identityFile = identityPath(label);
  const identity = loadOrCreateDeviceIdentity({ path: identityFile });
  const request = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    role: "operator",
    scopes,
  });
  return { identity, path: identityFile, request };
}

async function approveOperatorPairing(requestId: string, callerScopes: string[] = SCOPES) {
  const { approveDevicePairing } = await import("../infra/device-pairing.js");
  return await approveDevicePairing(requestId, { callerScopes });
}

async function listPairings() {
  const { listDevicePairing } = await import("../infra/device-pairing.js");
  return await listDevicePairing();
}

async function readMigrationState() {
  const { readControlUiDeviceAuthMigrationState } =
    await import("../state/control-ui-device-auth-migration.js");
  return readControlUiDeviceAuthMigrationState({ env: process.env });
}

async function withMigrationHarness<T, Prepared = void>(
  run: (harness: TrackedMigrationHarness, prepared: Prepared) => Promise<T>,
  options: {
    gateway?: NonNullable<OpenClawConfig["gateway"]>;
    auth?: Record<string, unknown> | null;
    prepare?: () => Promise<Prepared>;
  } = {},
): Promise<T> {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile({
    meta: { lastTouchedVersion: "2026.7.1" },
    gateway: options.gateway ?? REMOTE_MIGRATION_GATEWAY,
  });
  testState.gatewayAuth = options.auth === null ? undefined : (options.auth ?? TOKEN_AUTH);
  const prepared = options.prepare ? await options.prepare() : (undefined as Prepared);
  const harness = await createGatewaySuiteHarness();
  const sockets = new Set<WebSocket>();
  try {
    return await run(
      {
        ...harness,
        openWs: async (headers) => {
          const socket = await harness.openWs(headers);
          sockets.add(socket);
          return socket;
        },
      },
      prepared,
    );
  } finally {
    for (const socket of sockets) {
      socket.close();
    }
    await harness.close();
  }
}

async function signedDevice(ws: WebSocket, identityFile: string, scopes: string[] = SCOPES) {
  const nonce = await readConnectChallengeNonce(ws);
  const identity = loadOrCreateDeviceIdentity({ path: identityFile });
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

async function connectMigration(
  ws: WebSocket,
  params: {
    device: Awaited<ReturnType<typeof signedDevice>>["device"] | null;
    scopes?: string[];
    trustedProxy?: boolean;
  },
) {
  return await connectReq(ws, {
    ...(params.trustedProxy ? { skipDefaultAuth: true } : { token: "secret" }),
    scopes: params.scopes ?? SCOPES,
    client: CONTROL_UI_CLIENT,
    device: params.device,
  });
}

describe("Control UI device-auth upgrade migration", () => {
  it("retains only the migration session bound to the approved public key", () => {
    const approvedIdentity = createIdentity("device-auth-approved");
    const otherIdentity = createIdentity("device-auth-other");
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
    await withMigrationHarness(async (harness) => {
      const ws = await harness.openWs(REMOTE_HEADERS);
      const connected = await connectMigration(ws, { device: null });
      expect(connected.ok).toBe(true);
      expect(connected.payload).toMatchObject({
        deviceAuthMigration: { pending: true },
        auth: { role: "operator", scopes: ["operator.pairing"] },
      });
      expect(
        (connected.payload as { auth?: { deviceToken?: string } } | undefined)?.auth?.deviceToken,
      ).toBeUndefined();

      const { request: otherRequest } = await requestOperatorPairing(
        "device-auth-migration-device-less-target",
      );
      const crossDeviceApproval = await rpcReq(ws, "device.pair.approve", {
        requestId: otherRequest.request.requestId,
      });
      expect(crossDeviceApproval.ok).toBe(false);

      const config = await rpcReq(ws, "config.get", {});
      expect(config.ok).toBe(false);
      expect(config.error?.message).toContain("missing scope");
    });
  });

  it("preserves trusted-proxy migration access", async () => {
    await withMigrationHarness(
      async (harness) => {
        const ws = await harness.openWs({
          ...REMOTE_HEADERS,
          "x-forwarded-proto": "https",
          "x-forwarded-user": "operator@example.com",
        });
        const connected = await connectMigration(ws, { device: null, trustedProxy: true });
        expect(connected.ok).toBe(true);
        expect(connected.payload).toMatchObject({
          deviceAuthMigration: { pending: true },
          auth: { role: "operator", scopes: ["operator.pairing"] },
        });
        const config = await rpcReq(ws, "config.get", {});
        expect(config.ok).toBe(false);
        expect(config.error?.message).toContain("missing scope");
      },
      { gateway: TRUSTED_PROXY_MIGRATION_GATEWAY, auth: null },
    );
  });

  it("preserves trusted-proxy scope caps during migration", async () => {
    await withMigrationHarness(
      async (harness) => {
        const ws = await harness.openWs({
          ...REMOTE_HEADERS,
          "x-forwarded-proto": "https",
          "x-forwarded-user": "reader@example.com",
          "x-openclaw-scopes": "operator.read",
        });
        const connected = await connectMigration(ws, { device: null, trustedProxy: true });
        expect(connected.ok).toBe(true);
        expect(connected.payload).toMatchObject({
          auth: { role: "operator", scopes: [] },
        });
        expect(connected.payload).not.toHaveProperty("deviceAuthMigration");
        const pairings = await rpcReq(ws, "device.pair.list", {});
        expect(pairings.ok).toBe(false);
        expect(pairings.error?.message).toContain("missing scope");
      },
      { gateway: TRUSTED_PROXY_MIGRATION_GATEWAY, auth: null },
    );
  });

  it("completes imported migration state when an effective operator already exists", async () => {
    await withMigrationHarness(
      async (_harness, ownerIdentity) => {
        expect(await readMigrationState()).toMatchObject({
          status: "completed",
          deviceId: ownerIdentity.deviceId,
        });
      },
      {
        gateway: STATE_ONLY_MIGRATION_GATEWAY,
        auth: testState.gatewayAuth,
        prepare: async () => {
          const { identity, request } = await requestOperatorPairing("migration-existing-owner");
          await expect(approveOperatorPairing(request.request.requestId)).resolves.toMatchObject({
            status: "approved",
          });
          return identity;
        },
      },
    );
  });

  it("keeps migration pending when existing operators cannot manage pairings", async () => {
    await withMigrationHarness(
      async () => {
        expect(await readMigrationState()).toMatchObject({
          status: "pending",
        });
      },
      {
        gateway: STATE_ONLY_MIGRATION_GATEWAY,
        auth: testState.gatewayAuth,
        prepare: async () => {
          const { request } = await requestOperatorPairing("migration-read-only-owner", [
            "operator.read",
          ]);
          await expect(
            approveOperatorPairing(request.request.requestId, ["operator.read"]),
          ).resolves.toMatchObject({ status: "approved" });
        },
      },
    );
  });

  it("rejects an in-flight migration handshake completed before registration", async () => {
    await withMigrationHarness(async (harness) => {
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
      try {
        const ws = await harness.openWs(REMOTE_HEADERS);
        const connected = connectMigration(ws, { device: null });
        await prepareEntered;
        const { request } = await requestOperatorPairing("migration-race-owner");
        await expect(approveOperatorPairing(request.request.requestId)).resolves.toMatchObject({
          status: "approved",
        });
        releasePrepare();

        const result = await connected;
        expect(result.ok).toBe(false);
        expect((result.error?.details as { code?: string } | undefined)?.code).toBe(
          ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
        );
      } finally {
        releasePrepare();
        prepareSpy.mockRestore();
      }
    });
  });

  it("keeps only the signed legacy browser online until it explicitly pairs", async () => {
    await withMigrationHarness(async (harness) => {
      const other = await requestOperatorPairing("other-pending");
      const firstIdentityPath = identityPath("device-auth-migration");
      const firstWs = await harness.openWs(REMOTE_HEADERS);
      const first = await signedDevice(firstWs, firstIdentityPath);
      const firstConnect = await connectMigration(firstWs, { device: first.device });
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

      const competingWs = await harness.openWs(REMOTE_HEADERS);
      const competing = await signedDevice(competingWs, other.path);
      const competingConnect = await connectMigration(competingWs, { device: competing.device });
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
      } else {
        await expect(firstClosed).resolves.toBe(4001);
      }

      firstWs.close();
      competingWs.close();
      const secondWs = await harness.openWs(REMOTE_HEADERS);
      const second = await signedDevice(secondWs, firstWon ? firstIdentityPath : other.path);
      const secondConnect = await connectMigration(secondWs, { device: second.device });
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
    });
  });

  it("does not silently auto-approve a local signed migration browser", async () => {
    await withMigrationHarness(
      async (harness) => {
        const ws = await harness.openWs({ origin: BROWSER_ORIGIN });
        const signed = await signedDevice(ws, identityPath("device-auth-migration-local-explicit"));
        const connected = await connectMigration(ws, { device: signed.device });
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
      },
      { gateway: LOCAL_MIGRATION_GATEWAY },
    );
  });

  it("adds pairing capability when a migrating browser requested read-only access", async () => {
    await withMigrationHarness(
      async (harness) => {
        const ws = await harness.openWs({ origin: BROWSER_ORIGIN });
        const signed = await signedDevice(ws, identityPath("device-auth-migration-read-only"), [
          "operator.read",
        ]);
        const connected = await connectMigration(ws, {
          device: signed.device,
          scopes: ["operator.read"],
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

        const paired = (await listPairings()).paired.find(
          (device) => device.deviceId === signed.identity.deviceId,
        );
        expect(paired?.tokens?.operator?.scopes).toEqual(
          expect.arrayContaining(["operator.read", "operator.pairing"]),
        );
        expect(await readMigrationState()).toMatchObject({
          status: "completed",
          deviceId: signed.identity.deviceId,
        });
      },
      { gateway: LOCAL_MIGRATION_GATEWAY },
    );
  });

  it("rejects a device-less migration handshake when an operator is already paired", async () => {
    await withMigrationHarness(async (harness) => {
      const { request } = await requestOperatorPairing("device-auth-migration-existing-owner");
      await expect(approveOperatorPairing(request.request.requestId)).resolves.toMatchObject({
        status: "approved",
      });
      const ws = await harness.openWs(REMOTE_HEADERS);
      const connected = await connectMigration(ws, { device: null });
      expect(connected.ok).toBe(false);
      expect(connected.error?.message).toContain("requires device identity");
    });
  });

  it("closes competing migration sessions and keeps the winner self-only until reconnect", async () => {
    await withMigrationHarness(async (harness) => {
      const deviceLessWs = await harness.openWs(REMOTE_HEADERS);
      const deviceLessConnect = await connectMigration(deviceLessWs, { device: null });
      expect(deviceLessConnect.ok).toBe(true);
      const deviceLessClosed = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("device-less migration session remained open after completion"));
        }, 5_000);
        deviceLessWs.once("close", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      const signedWs = await harness.openWs(REMOTE_HEADERS);
      const signed = await signedDevice(
        signedWs,
        identityPath("device-auth-migration-secure-completion"),
      );
      const signedConnect = await connectMigration(signedWs, { device: signed.device });
      expect(signedConnect.ok).toBe(true);
      const { request: otherRequest } = await requestOperatorPairing(
        "device-auth-migration-other-pending",
      );
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
    });
  });

  it("denies a stale migration session after another operator is paired", async () => {
    await withMigrationHarness(async (harness) => {
      const migrationWs = await harness.openWs(REMOTE_HEADERS);
      const migration = await signedDevice(
        migrationWs,
        identityPath("device-auth-migration-stale"),
      );
      const migrationConnect = await connectMigration(migrationWs, { device: migration.device });
      expect(migrationConnect.ok).toBe(true);
      expect(migrationConnect.payload).toMatchObject({
        deviceAuthMigration: { pending: true },
        auth: { role: "operator", scopes: ["operator.pairing"] },
      });
      const migrationClosed = new Promise<number>((resolve) => {
        migrationWs.once("close", resolve);
      });

      const { identity: ownerIdentity, request: ownerRequest } = await requestOperatorPairing(
        "device-auth-migration-owner",
      );
      await expect(approveOperatorPairing(ownerRequest.request.requestId)).resolves.toMatchObject({
        status: "approved",
      });
      await expect(migrationClosed).resolves.toBe(4001);

      const paired = (await listPairings()).paired;
      expect(paired.some((device) => device.deviceId === ownerIdentity.deviceId)).toBe(true);
      expect(paired.some((device) => device.deviceId === migration.identity.deviceId)).toBe(false);
    });
  });
});

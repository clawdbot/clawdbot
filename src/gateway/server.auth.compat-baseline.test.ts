import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BACKEND_GATEWAY_CLIENT,
  connectReq,
  CONTROL_UI_CLIENT,
  ConnectErrorDetailCodes,
  createSignedDevice,
  getFreePort,
  readConnectChallengeNonce,
  openWs,
  originForPort,
  rpcReq,
  restoreGatewayToken,
  startGatewayServer,
  testState,
  installGatewayTestHooks,
} from "./server.auth.shared.js";

installGatewayTestHooks({ scope: "suite" });

function expectAuthErrorDetails(params: {
  details: unknown;
  expectedCode: string;
  canRetryWithDeviceToken?: boolean;
  recommendedNextStep?: string;
}) {
  const details = params.details as
    | {
        code?: string;
        canRetryWithDeviceToken?: boolean;
        recommendedNextStep?: string;
      }
    | undefined;
  expect(details?.code).toBe(params.expectedCode);
  if (params.canRetryWithDeviceToken !== undefined) {
    expect(details?.canRetryWithDeviceToken).toBe(params.canRetryWithDeviceToken);
  }
  if (params.recommendedNextStep !== undefined) {
    expect(details?.recommendedNextStep).toBe(params.recommendedNextStep);
  }
}

async function expectSharedOperatorScopesCleared(
  port: number,
  auth: { token?: string; password?: string },
) {
  const ws = await openWs(port);
  try {
    const res = await connectReq(ws, {
      ...auth,
      scopes: ["operator.admin"],
      device: null,
    });
    expect(res.ok).toBe(true);

    const adminRes = await rpcReq(ws, "set-heartbeats", { enabled: false });
    expect(adminRes.ok).toBe(false);
    expect(adminRes.error?.message ?? "").toContain("missing scope");
  } finally {
    ws.close();
  }
}

async function expectLocalBackendGatewayClientScopesPreserved(
  port: number,
  auth: { token?: string; password?: string },
) {
  const ws = await openWs(port);
  try {
    const res = await connectReq(ws, {
      ...auth,
      client: { ...BACKEND_GATEWAY_CLIENT },
      scopes: ["operator.admin"],
      device: null,
    });
    expect(res.ok).toBe(true);

    const helloOk = res.payload as
      | {
          auth?: {
            scopes?: unknown;
          };
        }
      | undefined;
    expect(helloOk?.auth?.scopes).toEqual(["operator.admin"]);

    const adminRes = await rpcReq(ws, "set-heartbeats", { enabled: false });
    expect(adminRes.ok).toBe(true);
  } finally {
    ws.close();
  }
}

describe("gateway auth compatibility baseline", () => {
  describe("token mode", () => {
    let server: Awaited<ReturnType<typeof startGatewayServer>>;
    let port = 0;
    let prevToken: string | undefined;

    beforeAll(async () => {
      prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      testState.gatewayAuth = { mode: "token", token: "secret" };
      process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
      port = await getFreePort();
      server = await startGatewayServer(port);
    });

    afterAll(async () => {
      await server.close();
      restoreGatewayToken(prevToken);
    });

    test("keeps valid shared-token connect behavior unchanged", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, { token: "secret" });
        expect(res.ok).toBe(true);
      } finally {
        ws.close();
      }
    });

    test("clears requested scopes for shared-token operator connects without device identity", async () => {
      await expectSharedOperatorScopesCleared(port, { token: "secret" });
    });

    test("preserves scopes for direct-local backend shared-token connects without device identity", async () => {
      await expectLocalBackendGatewayClientScopesPreserved(port, { token: "secret" });
    });

    test("returns stable token-missing details for control ui without token", async () => {
      const ws = await openWs(port, { origin: originForPort(port) });
      try {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          client: { ...CONTROL_UI_CLIENT },
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("Control UI settings");
        expectAuthErrorDetails({
          details: res.error?.details,
          expectedCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
          canRetryWithDeviceToken: false,
          recommendedNextStep: "update_auth_configuration",
        });
      } finally {
        ws.close();
      }
    });

    test("provides one-time retry hint for shared token mismatches", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, { token: "wrong" });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("gateway token mismatch");
        expectAuthErrorDetails({
          details: res.error?.details,
          expectedCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
          canRetryWithDeviceToken: true,
          recommendedNextStep: "retry_with_device_token",
        });
      } finally {
        ws.close();
      }
    });

    test("keeps explicit device token mismatch semantics stable", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          deviceToken: "not-a-valid-device-token",
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("device token mismatch");
        expectAuthErrorDetails({
          details: res.error?.details,
          expectedCode: ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH,
          canRetryWithDeviceToken: false,
          recommendedNextStep: "update_auth_credentials",
        });
      } finally {
        ws.close();
      }
    });

    test("keeps local backend device-token reconnects out of pairing", async () => {
      const identityPath = path.join(
        os.tmpdir(),
        `openclaw-backend-device-${process.pid}-${port}.json`,
      );
      const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } =
        await import("../infra/device-identity.js");
      const { approveDevicePairing, requestDevicePairing, rotateDeviceToken } =
        await import("../infra/device-pairing.js");

      const identity = loadOrCreateDeviceIdentity(identityPath);
      const pending = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        clientId: BACKEND_GATEWAY_CLIENT.id,
        clientMode: BACKEND_GATEWAY_CLIENT.mode,
        role: "operator",
        scopes: ["operator.admin"],
      });
      await approveDevicePairing(pending.request.requestId, {
        callerScopes: ["operator.admin"],
      });

      const rotated = await rotateDeviceToken({
        deviceId: identity.deviceId,
        role: "operator",
        scopes: ["operator.admin"],
      });
      expect(rotated.ok).toBe(true);
      const rotatedToken = rotated.ok ? rotated.entry.token : "";
      expect(rotatedToken).toBeTypeOf("string");
      expect(rotatedToken.length).toBeGreaterThan(0);

      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          client: { ...BACKEND_GATEWAY_CLIENT },
          deviceIdentityPath: identityPath,
          deviceToken: rotatedToken,
          scopes: ["operator.admin"],
        });
        expect(res.ok).toBe(true);
        const payload = res.payload as
          | {
              type?: string;
              snapshot?: {
                configPath?: string;
                stateDir?: string;
                authMode?: string;
              };
            }
          | undefined;
        expect(payload?.type).toBe("hello-ok");
        expect(typeof payload?.snapshot?.configPath).toBe("string");
        expect((payload?.snapshot?.configPath ?? "").length).toBeGreaterThan(0);
        expect(typeof payload?.snapshot?.stateDir).toBe("string");
        expect((payload?.snapshot?.stateDir ?? "").length).toBeGreaterThan(0);
        expect(payload?.snapshot?.authMode).toBe("token");
      } finally {
        ws.close();
      }
    });
  });

  describe("password mode", () => {
    let server: Awaited<ReturnType<typeof startGatewayServer>>;
    let port = 0;
    let prevToken: string | undefined;

    beforeAll(async () => {
      prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      testState.gatewayAuth = { mode: "password", password: "secret" };
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
      port = await getFreePort();
      server = await startGatewayServer(port);
    });

    afterAll(async () => {
      await server.close();
      restoreGatewayToken(prevToken);
    });

    test("keeps valid shared-password connect behavior unchanged", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, { password: "secret" });
        expect(res.ok).toBe(true);
      } finally {
        ws.close();
      }
    });

    test("returns stable password mismatch details", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, { password: "wrong" });
        expect(res.ok).toBe(false);
        expectAuthErrorDetails({
          details: res.error?.details,
          expectedCode: ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH,
          canRetryWithDeviceToken: false,
          recommendedNextStep: "update_auth_credentials",
        });
      } finally {
        ws.close();
      }
    });

    test("clears requested scopes for shared-password operator connects without device identity", async () => {
      await expectSharedOperatorScopesCleared(port, { password: "secret" });
    });

    test("preserves scopes for direct-local backend shared-password connects without device identity", async () => {
      await expectLocalBackendGatewayClientScopesPreserved(port, { password: "secret" });
    });
  });

  describe("none mode", () => {
    let server: Awaited<ReturnType<typeof startGatewayServer>>;
    let port = 0;
    let prevToken: string | undefined;

    beforeAll(async () => {
      prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      testState.gatewayAuth = { mode: "none" };
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
      port = await getFreePort();
      server = await startGatewayServer(port, { controlUiEnabled: true });
    });

    afterAll(async () => {
      await server.close();
      restoreGatewayToken(prevToken);
    });

    test("keeps auth-none loopback behavior unchanged", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, { skipDefaultAuth: true });
        expect(res.ok).toBe(true);
      } finally {
        ws.close();
      }
    });

    test("allows auth-none local backend connects without device identity", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          client: { ...BACKEND_GATEWAY_CLIENT },
          scopes: ["operator.admin"],
          device: null,
        });
        expect(res.ok, JSON.stringify(res)).toBe(true);

        const helloOk = res.payload as
          | {
              auth?: {
                scopes?: unknown;
              };
            }
          | undefined;
        expect(helloOk?.auth?.scopes).toEqual(["operator.admin"]);

        const adminRes = await rpcReq(ws, "set-heartbeats", { enabled: false });
        expect(adminRes.ok).toBe(true);
      } finally {
        ws.close();
      }
    });

    test("rejects auth-none browser-origin backend connects without device identity", async () => {
      const ws = await openWs(port, { origin: originForPort(port) });
      try {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          client: { ...BACKEND_GATEWAY_CLIENT },
          scopes: ["operator.admin"],
          device: null,
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("device identity required");
        expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
          ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED,
        );
      } finally {
        ws.close();
      }
    });

    test("keeps auth-none control ui first-connect token absence unchanged", async () => {
      const ws = await openWs(port, { origin: originForPort(port) });
      try {
        const deviceIdentityPath = path.join(
          os.tmpdir(),
          `openclaw-auth-none-control-ui-first-${process.pid}-${port}.json`,
        );
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          client: { ...CONTROL_UI_CLIENT },
          scopes: ["operator.read"],
          deviceIdentityPath,
        });
        expect(res.ok).toBe(true);
        const helloOk = res.payload as
          | {
              auth?: {
                deviceToken?: unknown;
              };
            }
          | undefined;
        expect(helloOk?.auth?.deviceToken).toBeUndefined();
      } finally {
        ws.close();
      }
    });

    test("keeps auth-none control ui stale-key token handoff unchanged", async () => {
      const ws = await openWs(port, { origin: originForPort(port) });
      try {
        const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } =
          await import("../infra/device-identity.js");
        const { approveDevicePairing, requestDevicePairing } =
          await import("../infra/device-pairing.js");
        const nonce = await readConnectChallengeNonce(ws);
        const identityPath = path.join(
          os.tmpdir(),
          `openclaw-auth-none-control-ui-${process.pid}-${port}.json`,
        );
        const staleIdentityPath = path.join(
          os.tmpdir(),
          `openclaw-auth-none-control-ui-stale-${process.pid}-${port}.json`,
        );
        const { identity, device } = await createSignedDevice({
          token: null,
          scopes: ["operator.read"],
          clientId: CONTROL_UI_CLIENT.id,
          clientMode: CONTROL_UI_CLIENT.mode,
          identityPath,
          nonce,
        });
        const staleIdentity = loadOrCreateDeviceIdentity(staleIdentityPath);
        const pending = await requestDevicePairing({
          deviceId: identity.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(staleIdentity.publicKeyPem),
          clientId: CONTROL_UI_CLIENT.id,
          clientMode: CONTROL_UI_CLIENT.mode,
          role: "operator",
          scopes: ["operator.read"],
        });
        await approveDevicePairing(pending.request.requestId, {
          callerScopes: ["operator.admin"],
        });

        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          client: { ...CONTROL_UI_CLIENT },
          scopes: ["operator.read"],
          device,
        });
        expect(res.ok).toBe(true);
        const helloOk = res.payload as
          | {
              auth?: {
                deviceToken?: unknown;
              };
            }
          | undefined;
        expect(typeof helloOk?.auth?.deviceToken).toBe("string");
      } finally {
        ws.close();
      }
    });
  });
});

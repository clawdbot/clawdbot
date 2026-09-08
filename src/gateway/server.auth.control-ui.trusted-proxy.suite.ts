import { beforeAll, expect, test } from "vitest";
import {
  createOperatorIdentityFixture,
  seedApprovedOperatorReadPairing,
  withControlUiGatewayServer,
} from "./server.auth.control-ui.fixtures.test-support.js";
import {
  connectReq,
  configureTrustedProxyControlUiAuth,
  CONTROL_UI_CLIENT,
  ConnectErrorDetailCodes,
  createSignedDevice,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  openWs,
  readConnectChallengeNonce,
  rpcReq,
  testState,
  TRUSTED_PROXY_CONTROL_UI_HEADERS,
} from "./server.auth.test-helpers.js";

export function registerControlUiTrustedProxySuite(): void {
  const trustedProxyControlUiCases: Array<{
    name: string;
    role: "operator" | "node";
    withUnpairedNodeDevice: boolean;
    expectedOk: boolean;
    expectedErrorSubstring?: string;
    expectedErrorCode?: string;
  }> = [
    {
      name: "rejects loopback trusted-proxy control ui operator without device identity",
      role: "operator",
      withUnpairedNodeDevice: false,
      expectedOk: false,
      expectedErrorSubstring: "control ui requires device identity",
      expectedErrorCode: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
    },
    {
      name: "rejects trusted-proxy control ui node role without device identity",
      role: "node",
      withUnpairedNodeDevice: false,
      expectedOk: false,
      expectedErrorSubstring: "control ui requires device identity",
      expectedErrorCode: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
    },
    {
      name: "rejects loopback trusted-proxy control ui node role before pairing",
      role: "node",
      withUnpairedNodeDevice: true,
      expectedOk: false,
      expectedErrorSubstring: "unauthorized",
    },
  ];
  const trustedProxyControlUiResults = new Map<string, Awaited<ReturnType<typeof connectReq>>>();

  const withTrustedProxyControlUiServer = async (
    run: (port: number) => Promise<void>,
  ): Promise<void> => {
    const { replaceConfigFile } = await import("../config/config.js");
    testState.gatewayAuth = undefined;
    testState.gatewayControlUi = {
      ...testState.gatewayControlUi,
      allowedOrigins: ["https://localhost"],
    };
    await replaceConfigFile({
      nextConfig: {
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
          controlUi: { allowedOrigins: ["https://localhost"] },
        },
      },
      afterWrite: { mode: "auto" },
    });
    await withControlUiGatewayServer(async ({ port }) => await run(port));
  };

  beforeAll(async () => {
    await configureTrustedProxyControlUiAuth();
    await withControlUiGatewayServer(async ({ port }) => {
      for (const tc of trustedProxyControlUiCases) {
        const ws = await openWs(port, TRUSTED_PROXY_CONTROL_UI_HEADERS);
        try {
          const scopes = tc.withUnpairedNodeDevice ? [] : undefined;
          let device: Awaited<ReturnType<typeof createSignedDevice>>["device"] | null = null;
          if (tc.withUnpairedNodeDevice) {
            const challengeNonce = await readConnectChallengeNonce(ws);
            if (!challengeNonce) {
              throw new Error(`expected connect challenge nonce for ${tc.name}`);
            }
            ({ device } = await createSignedDevice({
              token: null,
              role: "node",
              scopes: [],
              clientId: GATEWAY_CLIENT_NAMES.CONTROL_UI,
              clientMode: GATEWAY_CLIENT_MODES.WEBCHAT,
              nonce: challengeNonce,
            }));
          }
          trustedProxyControlUiResults.set(
            tc.name,
            await connectReq(ws, {
              skipDefaultAuth: true,
              role: tc.role,
              scopes,
              device,
              client: { ...CONTROL_UI_CLIENT },
            }),
          );
        } finally {
          ws.close();
        }
      }
    });
  });

  test.each(trustedProxyControlUiCases)("$name", (tc) => {
    const res = trustedProxyControlUiResults.get(tc.name);
    if (!res) {
      throw new Error(`missing trusted-proxy result for ${tc.name}`);
    }
    expect(res.ok, tc.name).toBe(tc.expectedOk);
    if (!tc.expectedOk) {
      if (tc.expectedErrorSubstring) {
        expect(res.error?.message ?? "", tc.name).toContain(tc.expectedErrorSubstring);
      }
      if (tc.expectedErrorCode) {
        expect((res.error?.details as { code?: string } | undefined)?.code, tc.name).toBe(
          tc.expectedErrorCode,
        );
      }
    }
  });

  test("rejects trusted-proxy control ui without device identity even with self-declared scopes", async () => {
    await configureTrustedProxyControlUiAuth();
    const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
    const { rejectDevicePairing, requestDevicePairing } =
      await import("../infra/device-pairing.js");
    const { identity } = await createOperatorIdentityFixture("openclaw-control-ui-trusted-proxy-");
    const pendingRequest = await requestDevicePairing({
      deviceId: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      role: "operator",
      scopes: ["operator.admin"],
      clientId: CONTROL_UI_CLIENT.id,
      clientMode: CONTROL_UI_CLIENT.mode,
    });
    await withControlUiGatewayServer(async ({ port }) => {
      const ws = await openWs(port, TRUSTED_PROXY_CONTROL_UI_HEADERS);
      try {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          scopes: ["operator.admin"],
          device: null,
          client: { ...CONTROL_UI_CLIENT },
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("control ui requires device identity");
        expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
          ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
        );
      } finally {
        ws.close();
        await rejectDevicePairing(pendingRequest.request.requestId);
      }
    });
  });

  test("requires pairing for trusted-proxy control ui device identity", async () => {
    await withTrustedProxyControlUiServer(async (port) => {
      const ws = await openWs(port, TRUSTED_PROXY_CONTROL_UI_HEADERS);
      try {
        const challengeNonce = await readConnectChallengeNonce(ws);
        const { device } = await createSignedDevice({
          token: null,
          role: "operator",
          scopes: ["operator.admin", "operator.read"],
          clientId: CONTROL_UI_CLIENT.id,
          clientMode: CONTROL_UI_CLIENT.mode,
          nonce: challengeNonce,
        });
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          scopes: ["operator.admin", "operator.read"],
          device,
          client: { ...CONTROL_UI_CLIENT },
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("pairing required");
        expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
          ConnectErrorDetailCodes.PAIRING_REQUIRED,
        );
      } finally {
        ws.close();
      }
    });
  });

  test("clears trusted-proxy control ui scopes without device identity", async () => {
    await withTrustedProxyControlUiServer(async (port) => {
      const ws = await openWs(port, TRUSTED_PROXY_CONTROL_UI_HEADERS);
      try {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          scopes: ["operator.admin", "operator.read"],
          device: null,
          client: { ...CONTROL_UI_CLIENT },
        });
        expect(res.ok).toBe(true);
        expect(res.payload).toMatchObject({ auth: { method: "trusted-proxy" } });
        const payload = res.payload as
          | {
              auth?: { scopes?: string[]; deviceToken?: string };
            }
          | undefined;
        expect(payload?.auth?.scopes).toEqual([]);
        expect(payload?.auth?.deviceToken).toBeUndefined();

        const admin = await rpcReq(ws, "set-heartbeats", { enabled: false });
        expect(admin.ok).toBe(false);
        expect(admin.error?.message ?? "").toContain("missing scope");
      } finally {
        ws.close();
      }
    });
  });

  test("bounds trusted-proxy control ui scopes to proxy-declared scope header", async () => {
    await withTrustedProxyControlUiServer(async (port) => {
      const seeded = await seedApprovedOperatorReadPairing({
        identityPrefix: "openclaw-control-ui-trusted-proxy-bounded-",
        clientId: CONTROL_UI_CLIENT.id,
        clientMode: CONTROL_UI_CLIENT.mode,
        displayName: "Control UI",
        platform: "web",
        scopes: ["operator.admin", "operator.read"],
      });
      const ws = await openWs(port, {
        ...TRUSTED_PROXY_CONTROL_UI_HEADERS,
        "x-openclaw-scopes": "operator.read",
      });
      try {
        const challengeNonce = await readConnectChallengeNonce(ws);
        const { device } = await createSignedDevice({
          token: null,
          role: "operator",
          scopes: ["operator.admin", "operator.read"],
          clientId: CONTROL_UI_CLIENT.id,
          clientMode: CONTROL_UI_CLIENT.mode,
          identityPath: seeded.identityPath,
          nonce: challengeNonce,
        });
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          scopes: ["operator.admin", "operator.read"],
          device,
          client: { ...CONTROL_UI_CLIENT },
        });
        expect(res.ok).toBe(true);
        const payload = res.payload as
          | {
              auth?: { scopes?: string[]; deviceToken?: string };
            }
          | undefined;
        expect(payload?.auth?.scopes).toEqual(["operator.read"]);
        expect(payload?.auth?.deviceToken).toBeUndefined();

        const admin = await rpcReq(ws, "set-heartbeats", { enabled: false });
        expect(admin.ok).toBe(false);
        expect(admin.error?.message ?? "").toContain("missing scope");

        const health = await rpcReq(ws, "health");
        expect(health.ok).toBe(true);
      } finally {
        ws.close();
      }
    });
  });
}

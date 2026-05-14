import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { ConnectErrorDetailCodes } from "../gateway/protocol/connect-error-details.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import {
  connectReq,
  connectOk,
  installGatewayTestHooks,
  readConnectChallengeNonce,
  rpcReq,
  testState,
  trackConnectChallengeNonce,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const TEST_OPERATOR_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.TEST,
  version: "1.0.0",
  platform: "test",
  mode: GATEWAY_CLIENT_MODES.TEST,
};
const CONTROL_UI_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
  version: "1.0.0",
  platform: "web",
  mode: GATEWAY_CLIENT_MODES.WEBCHAT,
};
const ALLOWED_BROWSER_ORIGIN = "https://control.example.com";
const TRUSTED_PROXY_BROWSER_HEADERS = {
  "x-forwarded-for": "203.0.113.50",
  "x-forwarded-proto": "https",
  "x-forwarded-user": "operator@example.com",
};

const originForPort = (port: number) => `http://127.0.0.1:${port}`;

const openWs = async (port: number, headers?: Record<string, string>) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, headers ? { headers } : undefined);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  return ws;
};

async function createSignedDevice(params: {
  token: string;
  scopes: string[];
  clientId: string;
  clientMode: string;
  identityPath?: string;
  nonce: string;
  signedAtMs?: number;
}) {
  const identity = params.identityPath
    ? loadOrCreateDeviceIdentity(params.identityPath)
    : loadOrCreateDeviceIdentity();
  const signedAtMs = params.signedAtMs ?? Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId: params.clientId,
    clientMode: params.clientMode,
    role: "operator",
    scopes: params.scopes,
    signedAtMs,
    token: params.token,
    nonce: params.nonce,
  });
  return {
    identity,
    device: {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      signature: signDevicePayload(identity.privateKeyPem, payload),
      signedAt: signedAtMs,
      nonce: params.nonce,
    },
  };
}

async function writeTrustedProxyBrowserAuthConfig() {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile({
    gateway: {
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
        },
      },
      trustedProxies: ["127.0.0.1"],
      controlUi: {
        allowedOrigins: [ALLOWED_BROWSER_ORIGIN],
      },
    },
  });
}

async function withTrustedProxyBrowserWs(origin: string, run: (ws: WebSocket) => Promise<void>) {
  await writeTrustedProxyBrowserAuthConfig();
  await withGatewayServer(async ({ port }) => {
    const ws = await openWs(port, {
      origin,
      ...TRUSTED_PROXY_BROWSER_HEADERS,
    });
    try {
      await run(ws);
    } finally {
      ws.close();
    }
  });
}

async function expectBrowserOriginConnectRejected(params: {
  client?: {
    id: string;
    version: string;
    platform: string;
    mode: string;
  };
}) {
  testState.gatewayAuth = { mode: "token", token: "secret" };
  await withGatewayServer(async ({ port }) => {
    const ws = await openWs(port, { origin: "https://attacker.example" });
    try {
      const res = await connectReq(ws, {
        token: "secret",
        client: params.client ?? TEST_OPERATOR_CLIENT,
        ...(params.client ? { device: null } : {}),
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("origin not allowed");
      expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
        ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED,
      );
    } finally {
      ws.close();
    }
  });
}

describe("gateway auth browser hardening", () => {
  test("rejects trusted-proxy browser connects from origins outside the allowlist", async () => {
    await withTrustedProxyBrowserWs("https://evil.example", async (ws) => {
      const res = await connectReq(ws, {
        client: TEST_OPERATOR_CLIENT,
        device: null,
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("origin not allowed");
      expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
        ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED,
      );
    });
  });

  test("accepts trusted-proxy browser connects from allowed origins", async () => {
    await withTrustedProxyBrowserWs(ALLOWED_BROWSER_ORIGIN, async (ws) => {
      const payload = await connectOk(ws, {
        client: TEST_OPERATOR_CLIENT,
        device: null,
      });
      expect(payload.type).toBe("hello-ok");
    });
  });

  test("clears scopes for trusted-proxy non-control-ui browser sessions", async () => {
    await withTrustedProxyBrowserWs(ALLOWED_BROWSER_ORIGIN, async (ws) => {
      const payload = await connectOk(ws, {
        client: TEST_OPERATOR_CLIENT,
        device: null,
        scopes: ["operator.read"],
      });
      expect(payload.type).toBe("hello-ok");

      const status = await rpcReq(ws, "status");
      expect(status.ok).toBe(false);
      expect(status.error?.message ?? "").toContain("missing scope");
    });
  });

  test.each([
    {
      name: "rejects disallowed origins",
      origin: "https://evil.example",
      ok: false,
      expectedMessage: "origin not allowed",
    },
    {
      name: "accepts allowed origins",
      origin: ALLOWED_BROWSER_ORIGIN,
      ok: true,
    },
  ])(
    "keeps non-proxy browser-origin behavior unchanged: $name",
    async ({ origin, ok, expectedMessage }) => {
      const { writeConfigFile } = await import("../config/config.js");
      testState.gatewayAuth = { mode: "token", token: "secret" };
      await writeConfigFile({
        gateway: {
          controlUi: {
            allowedOrigins: [ALLOWED_BROWSER_ORIGIN],
          },
        },
      });

      await withGatewayServer(async ({ port }) => {
        const ws = await openWs(port, { origin });
        try {
          const res = await connectReq(ws, {
            token: "secret",
            client: TEST_OPERATOR_CLIENT,
            device: null,
          });
          expect(res.ok).toBe(ok);
          if (ok) {
            expect((res.payload as { type?: string } | undefined)?.type).toBe("hello-ok");
          } else {
            expect(res.error?.message ?? "").toContain(expectedMessage ?? "");
            expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
              ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED,
            );
          }
        } finally {
          ws.close();
        }
      });
    },
  );

  test("rejects non-local browser origins for non-control-ui clients", async () => {
    await expectBrowserOriginConnectRejected({});
  });

  test("rejects browser-origin connects that claim to be tui clients", async () => {
    await expectBrowserOriginConnectRejected({
      client: {
        id: GATEWAY_CLIENT_NAMES.TUI,
        version: "1.0.0",
        platform: "darwin",
        mode: GATEWAY_CLIENT_MODES.UI,
      },
    });
  });

  test("rate-limits browser-origin auth failures on loopback even when loopback exemption is enabled", async () => {
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: { maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000, exemptLoopback: true },
    };
    await withGatewayServer(async ({ port }) => {
      const firstWs = await openWs(port, { origin: originForPort(port) });
      try {
        const first = await connectReq(firstWs, { token: "wrong" });
        expect(first.ok).toBe(false);
        expect(first.error?.message ?? "").not.toContain("retry later");
      } finally {
        firstWs.close();
      }

      const secondWs = await openWs(port, { origin: originForPort(port) });
      try {
        const second = await connectReq(secondWs, { token: "wrong" });
        expect(second.ok).toBe(false);
        expect(second.error?.message ?? "").toContain("retry later");
      } finally {
        secondWs.close();
      }
    });
  });

  test("isolates loopback browser-origin auth lockouts per origin", async () => {
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: { maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000, exemptLoopback: true },
    };
    await withGatewayServer(async ({ port }) => {
      const firstOrigin = originForPort(port);
      const secondOrigin = "http://localhost:5173";

      const firstWs = await openWs(port, { origin: firstOrigin });
      try {
        const first = await connectReq(firstWs, { token: "wrong" });
        expect(first.ok).toBe(false);
        expect(first.error?.message ?? "").not.toContain("retry later");
      } finally {
        firstWs.close();
      }

      const secondWs = await openWs(port, { origin: secondOrigin });
      try {
        const second = await connectReq(secondWs, { token: "wrong" });
        expect(second.ok).toBe(false);
        expect(second.error?.message ?? "").not.toContain("retry later");
      } finally {
        secondWs.close();
      }

      const thirdWs = await openWs(port, { origin: firstOrigin });
      try {
        const third = await connectReq(thirdWs, { token: "wrong" });
        expect(third.ok).toBe(false);
        expect(third.error?.message ?? "").toContain("retry later");
      } finally {
        thirdWs.close();
      }
    });
  });

  test("omits sensitive gateway paths from low-privilege hello-ok snapshots", async () => {
    testState.gatewayAuth = { mode: "token", token: "secret" };
    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, { origin: originForPort(port) });
      try {
        const payload = (await connectOk(ws, {
          token: "secret",
          scopes: ["operator.read"],
          device: null,
        })) as {
          type: "hello-ok";
          snapshot?: {
            configPath?: unknown;
            stateDir?: unknown;
            authMode?: unknown;
          };
        };
        // connectReq scopes are evaluated after auth and unbound-scope clearing, so this assertion
        // verifies the effective low-privilege session view rather than self-declared client scopes.
        const snapshot = payload.snapshot as
          | { configPath?: unknown; stateDir?: unknown; authMode?: unknown }
          | undefined;
        if (!snapshot) {
          throw new Error("expected hello-ok snapshot for low-privilege browser session");
        }
        expect(snapshot.configPath).toBeUndefined();
        expect(snapshot.stateDir).toBeUndefined();
        expect(snapshot.authMode).toBeUndefined();
      } finally {
        ws.close();
      }
    });
  });

  test("does not silently auto-pair non-control-ui browser clients on loopback", async () => {
    const { listDevicePairing } = await import("../infra/device-pairing.js");
    testState.gatewayAuth = { mode: "token", token: "secret" };

    await withGatewayServer(async ({ port }) => {
      const browserWs = await openWs(port, { origin: originForPort(port) });
      try {
        const nonce = await readConnectChallengeNonce(browserWs);
        expect(typeof nonce).toBe("string");
        const { identity, device } = await createSignedDevice({
          token: "secret",
          scopes: ["operator.admin"],
          clientId: TEST_OPERATOR_CLIENT.id,
          clientMode: TEST_OPERATOR_CLIENT.mode,
          identityPath: path.join(os.tmpdir(), `openclaw-browser-device-${randomUUID()}.json`),
          nonce: nonce ?? "",
        });
        const res = await connectReq(browserWs, {
          token: "secret",
          scopes: ["operator.admin"],
          client: TEST_OPERATOR_CLIENT,
          device,
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("pairing required");

        const pairing = await listDevicePairing();
        const pending = pairing.pending.find((entry) => entry.deviceId === identity.deviceId);
        if (!pending) {
          throw new Error("expected non-control browser client to create pending pairing request");
        }
        expect(pending.silent).toBe(false);
      } finally {
        browserWs.close();
      }
    });
  });

  test("does not silently auto-pair control-ui browser clients on loopback", async () => {
    const { listDevicePairing } = await import("../infra/device-pairing.js");
    testState.gatewayAuth = { mode: "token", token: "secret" };

    await withGatewayServer(async ({ port }) => {
      const browserWs = await openWs(port, { origin: originForPort(port) });
      try {
        const nonce = await readConnectChallengeNonce(browserWs);
        expect(typeof nonce).toBe("string");
        const { identity, device } = await createSignedDevice({
          token: "secret",
          scopes: ["operator.admin"],
          clientId: CONTROL_UI_CLIENT.id,
          clientMode: CONTROL_UI_CLIENT.mode,
          identityPath: path.join(os.tmpdir(), `openclaw-control-ui-device-${randomUUID()}.json`),
          nonce: nonce ?? "",
        });
        const res = await connectReq(browserWs, {
          token: "secret",
          scopes: ["operator.admin"],
          client: CONTROL_UI_CLIENT,
          device,
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("pairing required");

        const pairing = await listDevicePairing();
        const pending = pairing.pending.find((entry) => entry.deviceId === identity.deviceId);
        if (!pending) {
          throw new Error("expected control ui browser client to create pending pairing request");
        }
        expect(pending.silent).toBe(false);
      } finally {
        browserWs.close();
      }
    });
  });

  test("rejects forged loopback origin for control-ui when proxy headers make client non-local", async () => {
    testState.gatewayAuth = { mode: "token", token: "secret" };
    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, {
        origin: originForPort(port),
        "x-forwarded-for": "203.0.113.50",
      });
      try {
        const res = await connectReq(ws, {
          token: "secret",
          client: {
            ...TEST_OPERATOR_CLIENT,
            id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
            mode: GATEWAY_CLIENT_MODES.UI,
          },
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("origin not allowed");
      } finally {
        ws.close();
      }
    });
  });
});

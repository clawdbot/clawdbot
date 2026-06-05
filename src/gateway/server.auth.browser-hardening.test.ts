// Browser auth hardening tests cover origin, trusted-proxy, signed-device,
// bootstrap-token, and scope checks for control UI WebSocket clients.
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import { CONTROL_UI_CLIENT, TEST_OPERATOR_CLIENT } from "./server.auth.shared.js";
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

const ALLOWED_BROWSER_ORIGIN = "https://control.example.com";
const TRUSTED_PROXY_BROWSER_HEADERS = {
  "x-forwarded-for": "203.0.113.50",
  "x-forwarded-proto": "https",
  "x-forwarded-user": "operator@example.com",
};

const originForPort = (port: number) => `http://127.0.0.1:${port}`;

type GatewayConnectResponse = Awaited<ReturnType<typeof connectReq>>;
type GatewayTestClient = {
  id: string;
  version: string;
  platform: string;
  mode: string;
};
type SignedBrowserDevice = Awaited<ReturnType<typeof createSignedDevice>>;

const openWs = async (port: number, headers?: Record<string, string>) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, headers ? { headers } : undefined);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => {
    ws.once("open", resolve);
  });
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

function expectOriginNotAllowed(res: GatewayConnectResponse) {
  expect(res.ok).toBe(false);
  expect(res.error?.message ?? "").toContain("origin not allowed");
  expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
    ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED,
  );
}

function expectRetryLater(res: GatewayConnectResponse, retryLater: boolean) {
  expect(res.ok).toBe(false);
  const expectation = expect(res.error?.message ?? "");
  if (retryLater) {
    expectation.toContain("retry later");
  } else {
    expectation.not.toContain("retry later");
  }
}

async function expectWrongTokenRejected(params: {
  port: number;
  headers?: Record<string, string>;
  retryLater: boolean;
  device?: null;
}) {
  const ws = await openWs(params.port, params.headers);
  try {
    const request = params.device === null ? { token: "wrong", device: null } : { token: "wrong" };
    const res = await connectReq(ws, request);
    expectRetryLater(res, params.retryLater);
  } finally {
    ws.close();
  }
}

async function createSignedBrowserDevice(
  browserWs: WebSocket,
  client: GatewayTestClient,
  identityName: string,
) {
  const nonce = await readConnectChallengeNonce(browserWs);
  expect(typeof nonce).toBe("string");
  return createSignedDevice({
    token: "secret",
    scopes: ["operator.admin"],
    clientId: client.id,
    clientMode: client.mode,
    identityPath: path.join(os.tmpdir(), `openclaw-${identityName}-device-${randomUUID()}.json`),
    nonce: nonce ?? "",
  });
}

function enableSingleAttemptLoopbackTokenAuth() {
  testState.gatewayAuth = {
    mode: "token",
    token: "secret",
    rateLimit: { maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000, exemptLoopback: true },
  };
}

async function withSignedBrowserConnect(
  port: number,
  client: GatewayTestClient,
  identityName: string,
  run: (session: {
    identity: SignedBrowserDevice["identity"];
    res: GatewayConnectResponse;
  }) => void | Promise<void>,
) {
  const browserWs = await openWs(port, { origin: originForPort(port) });
  try {
    const { identity, device } = await createSignedBrowserDevice(browserWs, client, identityName);
    const res = await connectReq(browserWs, {
      token: "secret",
      scopes: ["operator.admin"],
      client,
      device,
    });
    await run({ identity, res });
  } finally {
    browserWs.close();
  }
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
      expectOriginNotAllowed(res);
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
      expectOriginNotAllowed(res);
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
    },
    {
      name: "accepts allowed origins",
      origin: ALLOWED_BROWSER_ORIGIN,
      ok: true,
    },
  ])("keeps non-proxy browser-origin behavior unchanged: $name", async ({ origin, ok }) => {
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
          expectOriginNotAllowed(res);
        }
      } finally {
        ws.close();
      }
    });
  });

  test("rejects non-local browser origins for non-control-ui clients", async () => {
    await expectBrowserOriginConnectRejected({});
  });

  test("rejects browser-origin connects that claim to be tui clients", async () => {
    await expectBrowserOriginConnectRejected({
      client: {
        id: GATEWAY_CLIENT_NAMES.TUI,
        version: "1.0.0",
        platform: "macos",
        mode: GATEWAY_CLIENT_MODES.UI,
      },
    });
  });

  test("rate-limits browser-origin auth failures on loopback even when loopback exemption is enabled", async () => {
    enableSingleAttemptLoopbackTokenAuth();
    await withGatewayServer(async ({ port }) => {
      const loopbackOrigin = { origin: originForPort(port) };
      await expectWrongTokenRejected({ port, headers: loopbackOrigin, retryLater: false });
      await expectWrongTokenRejected({ port, headers: loopbackOrigin, retryLater: true });
    });
  });

  test("rate-limits non-browser remote auth failures by default", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    testState.gatewayAuth = { mode: "token", token: "secret" };
    await writeConfigFile({
      gateway: {
        trustedProxies: ["127.0.0.1"],
      },
    });

    await withGatewayServer(async ({ port }) => {
      const remoteHeaders = { "x-forwarded-for": "203.0.113.50" };
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        await expectWrongTokenRejected({
          port,
          headers: remoteHeaders,
          retryLater: false,
          device: null,
        });
      }

      await expectWrongTokenRejected({
        port,
        headers: remoteHeaders,
        retryLater: true,
        device: null,
      });
    });
  });

  test("isolates loopback browser-origin auth lockouts per origin", async () => {
    enableSingleAttemptLoopbackTokenAuth();
    await withGatewayServer(async ({ port }) => {
      const firstOrigin = originForPort(port);
      const secondOrigin = "http://localhost:5173";

      await expectWrongTokenRejected({ port, headers: { origin: firstOrigin }, retryLater: false });
      await expectWrongTokenRejected({
        port,
        headers: { origin: secondOrigin },
        retryLater: false,
      });
      await expectWrongTokenRejected({ port, headers: { origin: firstOrigin }, retryLater: true });
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
      await withSignedBrowserConnect(
        port,
        TEST_OPERATOR_CLIENT,
        "browser",
        async ({ identity, res }) => {
          expect(res.ok).toBe(false);
          expect(res.error?.message ?? "").toContain("pairing required");

          const pairing = await listDevicePairing();
          const pending = pairing.pending.find((entry) => entry.deviceId === identity.deviceId);
          if (!pending) {
            throw new Error(
              "expected non-control browser client to create pending pairing request",
            );
          }
          expect(pending.silent).toBe(false);
        },
      );
    });
  });

  test("silently auto-pairs control-ui browser clients on loopback with a valid gateway token", async () => {
    const { listDevicePairing } = await import("../infra/device-pairing.js");
    testState.gatewayAuth = { mode: "token", token: "secret" };

    await withGatewayServer(async ({ port }) => {
      await withSignedBrowserConnect(
        port,
        CONTROL_UI_CLIENT,
        "control-ui",
        async ({ identity, res }) => {
          expect(res.ok).toBe(true);

          const pairing = await listDevicePairing();
          expect(pairing.pending.some((entry) => entry.deviceId === identity.deviceId)).toBe(false);
          expect(pairing.paired.some((entry) => entry.deviceId === identity.deviceId)).toBe(true);
        },
      );
    });
  });

  test("rejects forged loopback origin for control-ui when proxy headers make client non-local", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      gateway: {
        trustedProxies: ["127.0.0.1"],
        controlUi: {
          allowedOrigins: [],
        },
      },
    });
    testState.gatewayAuth = { mode: "token", token: "secret" };
    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, {
        origin: "http://localhost:5173",
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
          device: null,
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("origin not allowed");
      } finally {
        ws.close();
      }
    });
  });
});

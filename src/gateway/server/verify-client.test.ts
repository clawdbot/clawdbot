/**
 * Pre-handshake WebSocket origin gate tests.
 */
import http from "node:http";
import { describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.js";
import { testState } from "../test-helpers.runtime-state.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
} from "../test-helpers.server.js";
import { createGatewayVerifyClient } from "./verify-client.js";

installGatewayTestHooks({ scope: "suite" });

const ALLOWED_BROWSER_ORIGIN = "https://app.example.com";

function makeReq(opts: { origin?: string; host?: string; remoteAddress?: string } = {}) {
  return {
    socket: { remoteAddress: opts.remoteAddress ?? "127.0.0.1" },
    headers: {
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.host ? { host: opts.host } : {}),
    },
  } as unknown as import("node:http").IncomingMessage;
}

function makeClient(cfg: Partial<OpenClawConfig> = {}) {
  return createGatewayVerifyClient({
    log: { info: () => {}, warn: () => {} },
    getConfigSnapshot: () => cfg as OpenClawConfig,
  });
}

function verify(
  vc: ReturnType<typeof createGatewayVerifyClient>,
  req: import("node:http").IncomingMessage,
  origin: string,
) {
  return new Promise<boolean>((resolve) => {
    vc({ origin, req }, (ok) => resolve(ok));
  });
}

// Raw HTTP upgrade through the real WebSocketServer seam. A rejected
// `verifyClient` writes an HTTP 403 (no 101) and never opens a socket, so
// `upgraded` stays false and no post-handshake close can occur.
async function requestUpgrade(
  port: number,
  origin?: string,
): Promise<{ status: number; upgraded: boolean }> {
  return await new Promise<{ status: number; upgraded: boolean }>((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGVzdC1rZXktMDEyMzQ1Ng==",
        "Sec-WebSocket-Version": "13",
        ...(origin ? { origin } : {}),
      },
    });
    let upgraded = false;
    req.once("upgrade", (_res, socket) => {
      upgraded = true;
      socket.destroy();
      resolve({ status: 101, upgraded });
    });
    req.once("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, upgraded });
    });
    req.once("error", reject);
    req.end();
  });
}

describe("createGatewayVerifyClient", () => {
  it("passes clients with no Origin (CLI, native apps)", async () => {
    const ok = await verify(makeClient(), makeReq({}), "");
    expect(ok).toBe(true);
  });

  it("accepts an allowed browser Origin", async () => {
    const vc = makeClient({
      gateway: { controlUi: { allowedOrigins: ["https://app.example.com"] } },
    });
    const ok = await verify(
      vc,
      makeReq({ origin: "https://app.example.com", host: "127.0.0.1:18789" }),
      "https://app.example.com",
    );
    expect(ok).toBe(true);
  });

  it("rejects a disallowed browser Origin", async () => {
    const vc = makeClient({
      gateway: { controlUi: { allowedOrigins: ["https://app.example.com"] } },
    });
    const ok = await verify(
      vc,
      makeReq({ origin: "https://evil.example.com", host: "127.0.0.1:18789" }),
      "https://evil.example.com",
    );
    expect(ok).toBe(false);
  });

  it("rejects a literal null opaque Origin", async () => {
    const ok = await verify(
      makeClient(),
      makeReq({ origin: "null", host: "127.0.0.1:18789", remoteAddress: "127.0.0.1" }),
      "null",
    );
    expect(ok).toBe(false);
  });

  it("passes canonical Chrome extension (browser copilot) origins for post-handshake validation", async () => {
    const copilotOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const ok = await verify(
      makeClient(),
      makeReq({ origin: copilotOrigin, host: "127.0.0.1:18789" }),
      copilotOrigin,
    );
    expect(ok).toBe(true);
  });

  it("treats loopback with forwarded headers as non-local (no local-loopback fallback)", async () => {
    const vc = makeClient({});
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: {
        host: "127.0.0.1:18789",
        "x-forwarded-for": "198.51.100.7",
      },
    } as unknown as import("node:http").IncomingMessage;
    const ok = await verify(vc, req, "http://127.0.0.1:18789");
    expect(ok).toBe(false);
  });

  it("still accepts an allowlisted Origin for a proxied loopback client", async () => {
    const vc = makeClient({
      gateway: { controlUi: { allowedOrigins: ["http://127.0.0.1:18789"] } },
    });
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: {
        host: "127.0.0.1:18789",
        "x-forwarded-for": "198.51.100.7",
      },
    } as unknown as import("node:http").IncomingMessage;
    const ok = await verify(vc, req, "http://127.0.0.1:18789");
    expect(ok).toBe(true);
  });
});

describe("createGatewayVerifyClient upgrade seam", () => {
  it("rejects a disallowed browser Origin before HTTP 101 (403, no socket opened, no post-handshake close)", async () => {
    testState.gatewayControlUi = { allowedOrigins: [ALLOWED_BROWSER_ORIGIN] };
    const harness = await createGatewaySuiteHarness();
    try {
      const res = await requestUpgrade(harness.port, "https://evil.example.com");
      expect(res.status).toBe(403);
      expect(res.upgraded).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("passes a no-Origin CLI client through the upgrade and authenticates post-handshake", async () => {
    testState.gatewayControlUi = { allowedOrigins: [ALLOWED_BROWSER_ORIGIN] };
    const harness = await createGatewaySuiteHarness();
    try {
      const ws = await harness.openWs();
      try {
        await connectOk(ws);
      } finally {
        ws.close();
      }
    } finally {
      await harness.close();
    }
  });

  it("re-evaluates the origin gate after a runtime config change (both admission stages read the runtime getter)", async () => {
    testState.gatewayControlUi = { allowedOrigins: [] };
    setRuntimeConfigSnapshot({
      gateway: { controlUi: { allowedOrigins: [] } },
    } as OpenClawConfig);
    const harness = await createGatewaySuiteHarness();
    try {
      // Startup runtime config denies every browser origin.
      expect(await requestUpgrade(harness.port, ALLOWED_BROWSER_ORIGIN)).toEqual({
        status: 403,
        upgraded: false,
      });

      // Simulate a live config write that allows the origin. Publishing a new
      // runtime snapshot is the same mechanism the post-handshake admission
      // path reads, so both gates now decide under the same policy.
      setRuntimeConfigSnapshot({
        gateway: { controlUi: { allowedOrigins: [ALLOWED_BROWSER_ORIGIN] } },
      } as OpenClawConfig);

      expect(await requestUpgrade(harness.port, ALLOWED_BROWSER_ORIGIN)).toEqual({
        status: 101,
        upgraded: true,
      });

      // Removing the allowlist entry re-tightens pre-handshake admission.
      setRuntimeConfigSnapshot({
        gateway: { controlUi: { allowedOrigins: [] } },
      } as OpenClawConfig);

      expect(await requestUpgrade(harness.port, ALLOWED_BROWSER_ORIGIN)).toEqual({
        status: 403,
        upgraded: false,
      });
    } finally {
      await harness.close();
    }
  });
});

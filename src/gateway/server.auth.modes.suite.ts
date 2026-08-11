// Auth modes suite covers password, token, none, Tailscale, and control-UI
// origin behavior across gateway WebSocket authentication modes.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  ConnectErrorDetailCodes,
  getGatewayTestPort,
  openTailscaleWs,
  openWs,
  originForPort,
  rpcReq,
  restoreGatewayToken,
  startTestGatewayServer,
  testState,
  testTailscaleWhois,
} from "./server.auth.test-helpers.js";

async function requestModels(port: number, secret: string): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}/v1/models`, {
    headers: {
      authorization: `Bearer ${secret}`,
    },
  });
}

export function registerAuthModesSuite(): void {
  describe("password auth", () => {
    let server: Awaited<ReturnType<typeof startTestGatewayServer>>;
    let port: number;

    beforeAll(async () => {
      testState.gatewayAuth = { mode: "password", password: "secret" }; // pragma: allowlist secret
      port = await getGatewayTestPort();
      server = await startTestGatewayServer(port, { openAiChatCompletionsEnabled: true });
    });

    beforeEach(() => {
      testState.gatewayAuth = { mode: "password", password: "secret" }; // pragma: allowlist secret
    });

    afterAll(async () => {
      await server.close();
    });

    test("accepts password auth when configured", async () => {
      const ws = await openWs(port);
      const res = await connectReq(ws, { password: "secret" }); // pragma: allowlist secret
      expect(res.ok).toBe(true);
      ws.close();
    });

    test("rejects invalid password", async () => {
      const ws = await openWs(port);
      const res = await connectReq(ws, { password: "wrong" }); // pragma: allowlist secret
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("unauthorized");
      ws.close();
    });

    test("rejects token credentials in password mode", async () => {
      const ws = await openWs(port);
      const res = await connectReq(ws, {
        skipDefaultAuth: true,
        token: "secret",
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("unauthorized");
      ws.close();
    });

    test("authorizes the models HTTP endpoint with only the configured password", async () => {
      const authorized = await requestModels(port, "secret");
      expect(authorized.status).toBe(200);
      await authorized.body?.cancel();

      const unauthorized = await requestModels(port, "wrong");
      expect(unauthorized.status).toBe(401);
      await unauthorized.body?.cancel();
    });
  });

  describe("token auth", () => {
    let server: Awaited<ReturnType<typeof startTestGatewayServer>>;
    let port: number;
    let prevToken: string | undefined;

    beforeAll(async () => {
      prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
      testState.gatewayAuth = { mode: "token", token: "secret" };
      port = await getGatewayTestPort();
      server = await startTestGatewayServer(port, { openAiChatCompletionsEnabled: true });
    });

    beforeEach(() => {
      process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
      testState.gatewayAuth = { mode: "token", token: "secret" };
    });

    afterAll(async () => {
      await server.close();
      restoreGatewayToken(prevToken);
    });

    test("accepts token auth when configured", async () => {
      const ws = await openWs(port);
      const res = await connectReq(ws, { token: "secret" });
      expect(res.ok).toBe(true);
      ws.close();
    });

    test("rejects invalid token", async () => {
      const ws = await openWs(port);
      const res = await connectReq(ws, { token: "wrong" });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("unauthorized");
      ws.close();
    });

    test("rejects password credentials in token mode", async () => {
      const ws = await openWs(port);
      const res = await connectReq(ws, {
        skipDefaultAuth: true,
        password: "secret", // pragma: allowlist secret
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("unauthorized");
      ws.close();
    });

    test("authorizes the models HTTP endpoint with only the configured token", async () => {
      const authorized = await requestModels(port, "secret");
      expect(authorized.status).toBe(200);
      await authorized.body?.cancel();

      const unauthorized = await requestModels(port, "wrong");
      expect(unauthorized.status).toBe(401);
      await unauthorized.body?.cancel();
    });

    test("returns control ui hint when token is missing", async () => {
      const ws = await openWs(port, { origin: originForPort(port) });
      const res = await connectReq(ws, {
        skipDefaultAuth: true,
        client: {
          ...CONTROL_UI_CLIENT,
        },
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("Control UI settings");
      ws.close();
    });

    test("rejects control ui without device identity by default", async () => {
      const ws = await openWs(port, { origin: originForPort(port) });
      const res = await connectReq(ws, {
        token: "secret",
        device: null,
        client: {
          ...CONTROL_UI_CLIENT,
        },
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("secure context");
      expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
        ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
      );
      ws.close();
    });
  });

  describe("explicit none auth", () => {
    let server: Awaited<ReturnType<typeof startTestGatewayServer>>;
    let port: number;
    let prevToken: string | undefined;

    beforeAll(async () => {
      prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
      testState.gatewayAuth = { mode: "none" };
      port = await getGatewayTestPort();
      server = await startTestGatewayServer(port);
    });

    beforeEach(() => {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
      testState.gatewayAuth = { mode: "none" };
    });

    afterAll(async () => {
      await server.close();
      restoreGatewayToken(prevToken);
    });

    test("allows loopback connect without shared secret when mode is none", async () => {
      const ws = await openWs(port);
      const res = await connectReq(ws, { skipDefaultAuth: true });
      expect(res.ok).toBe(true);
      ws.close();
    });
  });

  describe("startup auth validation", () => {
    test.each([
      {
        mode: "token" as const,
        envKey: "OPENCLAW_GATEWAY_TOKEN" as const,
        expected:
          "gateway auth mode is token, but no token was configured (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN)",
      },
      {
        mode: "password" as const,
        envKey: "OPENCLAW_GATEWAY_PASSWORD" as const,
        expected: "gateway auth mode is password, but no password was configured",
      },
    ])("rejects $mode mode before startup when its credential is missing", async (testCase) => {
      const previous = process.env[testCase.envKey];
      delete process.env[testCase.envKey];
      // Use an explicit empty override so suite-level credentials cannot satisfy
      // the mode under test before runtime validation runs.
      const auth =
        testCase.mode === "token"
          ? { mode: "token" as const, token: "", allowTailscale: false }
          : { mode: "password" as const, password: "", allowTailscale: false };
      testState.gatewayAuth = auth;
      const port = await getGatewayTestPort();

      try {
        await expect(startTestGatewayServer(port, { auth })).rejects.toThrow(testCase.expected);
      } finally {
        if (previous === undefined) {
          delete process.env[testCase.envKey];
        } else {
          process.env[testCase.envKey] = previous;
        }
      }
    });

    test("rejects non-loopback exposure without effective auth before listening", async () => {
      testState.gatewayAuth = { mode: "none" };
      const port = await getGatewayTestPort();

      await expect(
        startTestGatewayServer(port, {
          bind: "lan",
          host: "0.0.0.0",
          auth: { mode: "none" },
          controlUiEnabled: false,
        }),
      ).rejects.toThrow(
        "without auth (set gateway.auth.token/password, or set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD",
      );
    });
  });

  describe("tailscale auth", () => {
    let server: Awaited<ReturnType<typeof startTestGatewayServer>>;
    let port: number;
    const tailscaleOrigin = "https://gateway.tailnet.ts.net";

    beforeAll(async () => {
      testState.gatewayAuth = { mode: "token", token: "secret", allowTailscale: true };
      testState.gatewayControlUi = { allowedOrigins: [tailscaleOrigin] };
      const { replaceConfigFile } = await import("../config/config.js");
      await replaceConfigFile({
        nextConfig: {
          gateway: {
            auth: testState.gatewayAuth,
            tailscale: { mode: "serve" },
            controlUi: testState.gatewayControlUi,
          },
        },
        afterWrite: { mode: "auto" },
      });
      port = await getGatewayTestPort();
      server = await startTestGatewayServer(port);
      const tailscaleEndpoint = server.getTailscaleIngressEndpoint();
      if (!tailscaleEndpoint) {
        throw new Error("expected managed Tailscale listener");
      }
      port = tailscaleEndpoint.port;
    });

    afterAll(async () => {
      await server.close();
    });

    beforeEach(() => {
      testState.gatewayAuth = { mode: "token", token: "secret", allowTailscale: true };
      testState.gatewayControlUi = { allowedOrigins: [tailscaleOrigin] };
      testTailscaleWhois.value = { login: "peter", name: "Peter" };
    });

    afterEach(() => {
      testTailscaleWhois.value = null;
    });

    test("requires device identity when only tailscale auth is available", async () => {
      const ws = await openTailscaleWs(port);
      const res = await connectReq(ws, { skipDefaultAuth: true, device: null });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("device identity required");
      ws.close();
    });

    test("skips pairing for tailscale-authenticated control ui with device identity", async () => {
      const ws = await openTailscaleWs(port, { origin: tailscaleOrigin });
      const res = await connectReq(ws, {
        skipDefaultAuth: true,
        client: {
          ...CONTROL_UI_CLIENT,
        },
      });
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const status = await rpcReq(ws, "status");
      expect(status.ok).toBe(true);
      ws.close();
    });

    test("connects with shared token but clears scopes when tailscale auth skips device", async () => {
      const ws = await openTailscaleWs(port);
      const res = await connectReq(ws, { token: "secret", device: null });
      expect(res.ok).toBe(true);
      const status = await rpcReq(ws, "status");
      expect(status.ok).toBe(false);
      expect(status.error?.message ?? "").toContain("missing scope");
      const health = await rpcReq(ws, "health");
      expect(health.ok).toBe(true);
      ws.close();
    });
  });
}

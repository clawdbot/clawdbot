import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  ConnectErrorDetailCodes,
  getFreePort,
  openTailscaleWs,
  openWs,
  originForPort,
  rpcReq,
  restoreGatewayToken,
  startGatewayServer,
  testState,
  testTailscaleWhois,
} from "./server.auth.shared.js";

export function registerAuthModesSuite(): void {
  describe("password auth", () => {
    let server: Awaited<ReturnType<typeof startGatewayServer>>;
    let port: number;

    beforeAll(async () => {
      testState.gatewayAuth = { mode: "password", password: "secret" }; // pragma: allowlist secret
      port = await getFreePort();
      server = await startGatewayServer(port);
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
  });

  describe("token auth", () => {
    let server: Awaited<ReturnType<typeof startGatewayServer>>;
    let port: number;
    let prevToken: string | undefined;

    beforeAll(async () => {
      prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
      testState.gatewayAuth = { mode: "token", token: "secret" };
      port = await getFreePort();
      server = await startGatewayServer(port);
    });

    beforeEach(() => {
      process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
      testState.gatewayAuth = { mode: "token", token: "secret" };
    });

    afterAll(async () => {
      await server.close();
      restoreGatewayToken(prevToken);
    });

    test("rejects invalid token", async () => {
      const ws = await openWs(port);
      const res = await connectReq(ws, { token: "wrong" });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("unauthorized");
      ws.close();
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
    let server: Awaited<ReturnType<typeof startGatewayServer>>;
    let port: number;
    let prevToken: string | undefined;

    beforeAll(async () => {
      prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
      testState.gatewayAuth = { mode: "none" };
      port = await getFreePort();
      server = await startGatewayServer(port);
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

  describe("tailscale auth", () => {
    let server: Awaited<ReturnType<typeof startGatewayServer>>;
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
            controlUi: testState.gatewayControlUi,
          },
        },
        afterWrite: { mode: "auto" },
      });
      port = await getFreePort();
      server = await startGatewayServer(port);
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

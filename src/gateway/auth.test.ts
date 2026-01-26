import { describe, expect, it } from "vitest";

import { authorizeGatewayConnect } from "./auth.js";

describe("gateway auth", () => {
  it("does not throw when req is missing socket", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "none", allowTailscale: false },
      connectAuth: null,
      // Regression: avoid crashing on req.socket.remoteAddress when callers pass a non-IncomingMessage.
      req: {} as never,
    });
    expect(res.ok).toBe(true);
  });

  it("reports missing and mismatched token reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("token_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("token_mismatch");
  });

  it("reports missing token config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", allowTailscale: false },
      connectAuth: { token: "anything" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_missing_config");
  });

  it("reports missing and mismatched password reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("password_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: { password: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("password_mismatch");
  });

  it("reports missing password config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "password", allowTailscale: false },
      connectAuth: { password: "secret" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("password_missing_config");
  });

  it("reports tailscale auth reasons when required", async () => {
    const reqBase = {
      socket: { remoteAddress: "100.100.100.100" },
      headers: { host: "gateway.local" },
    };

    const missingUser = await authorizeGatewayConnect({
      auth: { mode: "none", allowTailscale: true },
      connectAuth: null,
      req: reqBase as never,
    });
    expect(missingUser.ok).toBe(false);
    expect(missingUser.reason).toBe("tailscale_user_missing");

    const missingProxy = await authorizeGatewayConnect({
      auth: { mode: "none", allowTailscale: true },
      connectAuth: null,
      req: {
        ...reqBase,
        headers: {
          host: "gateway.local",
          "tailscale-user-login": "peter",
          "tailscale-user-name": "Peter",
        },
      } as never,
    });
    expect(missingProxy.ok).toBe(false);
    expect(missingProxy.reason).toBe("tailscale_proxy_missing");
  });

  it("treats local tailscale serve hostnames as direct", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "none", allowTailscale: true },
      connectAuth: null,
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "gateway.tailnet-1234.ts.net:443" },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("none");
  });

  it("does not treat tailscale clients as direct", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "none", allowTailscale: true },
      connectAuth: null,
      req: {
        socket: { remoteAddress: "100.64.0.42" },
        headers: { host: "gateway.tailnet-1234.ts.net" },
      } as never,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("tailscale_user_missing");
  });

  it("allows tailscale identity to satisfy token mode auth", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-for": "100.64.0.1",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "ai-hub.bone-egret.ts.net",
          "tailscale-user-login": "peter",
          "tailscale-user-name": "Peter",
        },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("tailscale");
    expect(res.user).toBe("peter");
  });

  it("treats trusted proxy loopback clients as direct", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "none", allowTailscale: true },
      connectAuth: null,
      trustedProxies: ["10.0.0.2"],
      req: {
        socket: { remoteAddress: "10.0.0.2" },
        headers: { host: "localhost", "x-forwarded-for": "127.0.0.1" },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("none");
  });
});

// Device-join ingress tests prove the public exchange consumes the Gateway's
// prepared attribution instead of rediscovering a loopback proxy socket.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import { AUTH_NONE, createTestGatewayServer, sendRequest } from "./server-http.test-harness.js";

const mocks = vi.hoisted(() => ({
  redeemDevicePairingJoinCode: vi.fn(({ shortcode }: { shortcode: string }) =>
    shortcode === "vvvvvvvvvvvvvvvvvvvvvv" ? { token: "joined" } : null,
  ),
}));

vi.mock("../infra/device-pairing-join-code.js", () => ({
  redeemDevicePairingJoinCode: mocks.redeemDevicePairingJoinCode,
}));

const INVALID_CODE = "zzzzzzzzzzzzzzzzzzzzzz";
const VALID_CODE = "vvvvvvvvvvvvvvvvvvvvvv";
const PROXY_HEADERS = {
  "x-forwarded-proto": "https",
  "x-forwarded-host": "gateway.example",
};
const limiters: AuthRateLimiter[] = [];

function createStrictLimiter(maxAttempts = 2): AuthRateLimiter {
  const limiter = createAuthRateLimiter({
    maxAttempts,
    windowMs: 60_000,
    lockoutMs: 60_000,
    exemptLoopback: false,
    pruneIntervalMs: 0,
  });
  limiters.push(limiter);
  return limiter;
}

afterEach(() => {
  mocks.redeemDevicePairingJoinCode.mockClear();
  for (const limiter of limiters.splice(0)) {
    limiter.dispose();
  }
});

describe("Gateway device-join ingress attribution", () => {
  it("rejects unattributable proxy traffic before join-code redemption", async () => {
    const server = createTestGatewayServer({
      resolvedAuth: AUTH_NONE,
      overrides: {
        joinRateLimiter: createStrictLimiter(),
        getRuntimeConfig: () => ({ gateway: { trustedProxies: [] } }),
      },
    });

    const response = await sendRequest(server, {
      path: `/j/${INVALID_CODE}`,
      headers: { ...PROXY_HEADERS, "x-forwarded-for": "203.0.113.10" },
    });

    expect(response.res.statusCode).toBe(403);
    expect(response.getBody()).toContain("proxy_attribution_required");
    expect(mocks.redeemDevicePairingJoinCode).not.toHaveBeenCalled();
  });

  it("keeps trusted-proxy join budgets per client and resets only the successful subject", async () => {
    const server = createTestGatewayServer({
      resolvedAuth: AUTH_NONE,
      overrides: {
        joinRateLimiter: createStrictLimiter(),
        getRuntimeConfig: () => ({ gateway: { trustedProxies: ["127.0.0.1"] } }),
      },
    });
    const requestFrom = (clientIp: string, shortcode: string) =>
      sendRequest(server, {
        path: `/j/${shortcode}`,
        headers: { ...PROXY_HEADERS, "x-forwarded-for": clientIp },
      });

    expect((await requestFrom("203.0.113.10", INVALID_CODE)).res.statusCode).toBe(404);
    expect((await requestFrom("203.0.113.11", VALID_CODE)).res.statusCode).toBe(200);
    expect((await requestFrom("203.0.113.10", INVALID_CODE)).res.statusCode).toBe(404);
    expect((await requestFrom("203.0.113.10", VALID_CODE)).res.statusCode).toBe(429);
  });

  it.each([
    { mode: "serve" as const, marker: undefined },
    { mode: "funnel" as const, marker: "?1" },
  ])(
    "keys managed Tailscale $mode join attempts by attributed source",
    async ({ mode, marker }) => {
      const server = createTestGatewayServer({
        resolvedAuth: AUTH_NONE,
        overrides: {
          ingressTransport: { kind: "managed-tailscale", mode },
          joinRateLimiter: createStrictLimiter(1),
          getRuntimeConfig: () => ({ gateway: { trustedProxies: [] } }),
        },
      });
      const requestFrom = (clientIp: string) =>
        sendRequest(server, {
          path: `/j/${INVALID_CODE}`,
          headers: {
            ...PROXY_HEADERS,
            ...(marker ? { "tailscale-funnel-request": marker } : {}),
            "x-forwarded-for": clientIp,
          },
        });

      expect((await requestFrom("100.64.0.10")).res.statusCode).toBe(404);
      expect((await requestFrom("100.64.0.10")).res.statusCode).toBe(429);
      expect((await requestFrom("100.64.0.11")).res.statusCode).toBe(404);
    },
  );
});

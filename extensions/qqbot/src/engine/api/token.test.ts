import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenManager } from "./token.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

function mockGuardedTokenResponse(body: BodyInit, init?: ResponseInit): ReturnType<typeof vi.fn> {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: new Response(body, init),
    release,
  });
  return release;
}

describe("QQBot token manager", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("wraps malformed access token JSON", async () => {
    const release = mockGuardedTokenResponse("{not json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(new TokenManager().getAccessToken("app-id", "secret")).rejects.toThrow(
      "QQBot access_token response was malformed JSON",
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "https://bots.qq.com/app/getAppAccessToken",
      auditContext: "qqbot-token",
      capture: false,
      policy: {
        hostnameAllowlist: ["bots.qq.com"],
        allowRfc2544BenchmarkRange: true,
      },
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "QQBotPlugin/unknown",
        },
        body: JSON.stringify({ appId: "app-id", clientSecret: "secret" }),
      },
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("passes the RFC2544 SSRF allowance to the token fetch (regression for #88984)", async () => {
    mockGuardedTokenResponse('{"access_token":"token-1","expires_in":7200}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(new TokenManager().getAccessToken("app-id", "secret")).resolves.toBe("token-1");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://bots.qq.com/app/getAppAccessToken",
        auditContext: "qqbot-token",
        policy: {
          hostnameAllowlist: ["bots.qq.com"],
          allowRfc2544BenchmarkRange: true,
        },
      }),
    );
  });

  it("does not cache access tokens forever when expires_in is unsafe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00.000Z"));
    mockGuardedTokenResponse('{"access_token":"token-1","expires_in":1e309}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const manager = new TokenManager();
    await expect(manager.getAccessToken("app-id", "secret")).resolves.toBe("token-1");

    const status = manager.getStatus("app-id");
    expect(status.status).toBe("valid");
    expect(status.expiresAt).toBe(Date.now() + 7200 * 1000);
  });

  it("does not extend explicit non-positive token lifetimes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00.000Z"));
    mockGuardedTokenResponse('{"access_token":"token-1","expires_in":0}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const manager = new TokenManager();
    await expect(manager.getAccessToken("app-id", "secret")).resolves.toBe("token-1");

    expect(manager.getStatus("app-id")).toEqual({
      status: "expired",
      expiresAt: Date.now(),
    });
  });

  it("does not cache fetched tokens when the process clock is outside the Date range", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    mockGuardedTokenResponse('{"access_token":"token-1","expires_in":7200}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const manager = new TokenManager({ logger });
    try {
      await expect(manager.getAccessToken("app-id", "secret")).resolves.toBe("token-1");
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(manager.getStatus("app-id")).toEqual({ status: "none", expiresAt: null });
    expect(logger.debug).toHaveBeenCalledWith(
      "[qqbot:token:app-id] Not cached: invalid process clock",
    );
  });
});

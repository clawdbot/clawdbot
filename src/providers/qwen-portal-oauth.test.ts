import { describe, expect, it, vi, afterEach } from "vitest";

import { refreshQwenPortalCredentials } from "./qwen-portal-oauth.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

describe("refreshQwenPortalCredentials", () => {
  it("refreshes tokens with a new access token", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await refreshQwenPortalCredentials({
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() - 1000,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://chat.qwen.ai/api/v1/oauth2/token",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(result.access).toBe("new-access");
    expect(result.refresh).toBe("new-refresh");
    expect(result.expires).toBeGreaterThan(Date.now());
  });

  it("keeps refresh token when refresh response omits it", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        expires_in: 1800,
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await refreshQwenPortalCredentials({
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() - 1000,
    });

    expect(result.refresh).toBe("old-refresh");
  });

  it("errors when refresh token is invalid", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "invalid_grant",
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      refreshQwenPortalCredentials({
        access: "old-access",
        refresh: "old-refresh",
        expires: Date.now() - 1000,
      }),
    ).rejects.toThrow("Qwen OAuth refresh token expired or invalid");
  });
});

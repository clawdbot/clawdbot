import { describe, expect, it, vi } from "vitest";
import { OAuthProviderRegistry } from "./index.js";
import type { OAuthProviderInterface } from "./types.js";

function createProvider(overrides: Partial<OAuthProviderInterface> = {}): OAuthProviderInterface {
  return {
    id: "test-oauth",
    name: "Test OAuth",
    async login() {
      throw new Error("not used");
    },
    async refreshToken(credentials) {
      return { ...credentials, access: "refreshed-access", expires: Date.now() + 60_000 };
    },
    getApiKey(credentials) {
      return credentials.access;
    },
    ...overrides,
  };
}

describe("OAuthProviderRegistry refresh preparation", () => {
  it("keeps legacy one-argument refresh providers working", async () => {
    const registry = new OAuthProviderRegistry();
    registry.register(createProvider());

    await expect(
      registry.getApiKey("test-oauth", {
        "test-oauth": { access: "expired", refresh: "refresh", expires: 1 },
      }),
    ).resolves.toMatchObject({ apiKey: "refreshed-access" });
  });

  it("prepares once and forwards the exact refresh context", async () => {
    const controller = new AbortController();
    const refresh = vi.fn(async (credentials) => ({
      ...credentials,
      access: "prepared-access",
      expires: Date.now() + 60_000,
    }));
    const prepareRefreshToken = vi.fn(() => refresh);
    const registry = new OAuthProviderRegistry();
    registry.register(createProvider({ prepareRefreshToken }));

    const resolveApiKey = registry.prepareApiKey("test-oauth");
    await expect(
      resolveApiKey?.(
        { access: "expired", refresh: "refresh", expires: 1 },
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({ apiKey: "prepared-access" });

    expect(prepareRefreshToken).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(expect.any(Object), {
      signal: controller.signal,
    });
  });
});

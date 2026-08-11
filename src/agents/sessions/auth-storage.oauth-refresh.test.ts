import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";

const providerOAuthMocks = vi.hoisted(() => ({
  resolveCredential: vi.fn(),
  resolveHandle: vi.fn(),
}));

vi.mock("../../plugins/provider-runtime.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/provider-runtime.runtime.js")>(
    "../../plugins/provider-runtime.runtime.js",
  );
  return {
    ...actual,
    resolveProviderOAuthCredentialWithPlugin: providerOAuthMocks.resolveCredential,
    resolveProviderRuntimePluginHandle: providerOAuthMocks.resolveHandle,
  };
});

vi.mock("../auth-profiles/constants.js", async () => {
  const actual = await vi.importActual<typeof import("../auth-profiles/constants.js")>(
    "../auth-profiles/constants.js",
  );
  return { ...actual, OAUTH_REFRESH_CALL_TIMEOUT_MS: 10 };
});

import { getAuthStorageOAuthProviderRegistry } from "./auth-storage-oauth-registry.js";
import { AuthStorage } from "./auth-storage.js";

function registerRaceProvider(
  storage: AuthStorage,
  refreshToken: (
    credentials: { access: string; refresh: string; expires: number },
    context?: { signal?: AbortSignal },
  ) => Promise<{ access: string; refresh: string; expires: number }>,
) {
  const prepareRefreshToken = vi.fn(() => refreshToken);
  getAuthStorageOAuthProviderRegistry(storage).register({
    id: "test-oauth",
    name: "Test OAuth",
    async login() {
      throw new Error("not used");
    },
    async refreshToken(credentials, context) {
      return await refreshToken(credentials, context);
    },
    prepareRefreshToken,
    getApiKey(credentials) {
      return credentials.access;
    },
  });
  return prepareRefreshToken;
}

describe("AuthStorage OAuth refresh deadline", () => {
  it("bounds the caller, aborts the prepared plugin refresh, and persists late success", async () => {
    const storage = AuthStorage.inMemory({
      "plugin-oauth": {
        type: "oauth",
        access: "fake-expired-access",
        refresh: "fake-refresh",
        expires: 1,
      },
    });
    const stalled = createDeferred<{
      access: string;
      refresh: string;
      expires: number;
    }>();
    const aborted = vi.fn();
    const plugin = { refreshOAuth: vi.fn() };
    providerOAuthMocks.resolveHandle.mockResolvedValue({
      provider: "plugin-oauth",
      plugin,
    });
    providerOAuthMocks.resolveCredential.mockImplementation(async (params) => {
      params.signal?.addEventListener("abort", aborted, { once: true });
      const credential = {
        type: "oauth" as const,
        provider: "plugin-oauth",
        ...(await stalled.promise),
      };
      return { status: "available" as const, credential, apiKey: credential.access };
    });

    await expect(storage.getApiKey("plugin-oauth")).resolves.toBeUndefined();
    expect(aborted).toHaveBeenCalledOnce();
    expect(storage.drainErrors()[0]?.message).toContain("exceeded caller deadline");
    expect(providerOAuthMocks.resolveHandle).toHaveBeenCalledOnce();

    stalled.resolve({
      access: "fake-late-access",
      refresh: "fake-late-refresh",
      expires: Date.now() + 60_000,
    });
    await vi.waitFor(() => {
      expect(storage.get("plugin-oauth")).toMatchObject({
        access: "fake-late-access",
        refresh: "fake-late-refresh",
      });
    });
    expect(providerOAuthMocks.resolveHandle).toHaveBeenCalledOnce();
  });
});

describe("AuthStorage OAuth refresh conflicts", () => {
  it("rejects an expired rotated credential from a registered provider", async () => {
    const original = {
      type: "oauth" as const,
      access: "expired-access",
      refresh: "expired-refresh",
      expires: 1,
    };
    const storage = AuthStorage.inMemory({ "test-oauth": original });
    registerRaceProvider(storage, async () => ({
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: Date.now(),
    }));

    await expect(storage.getApiKey("test-oauth")).resolves.toBeUndefined();
    expect(storage.get("test-oauth")).toEqual(original);
    expect(JSON.stringify(storage.getAll())).not.toContain("rotated-access");
    expect(JSON.stringify(storage.getAll())).not.toContain("rotated-refresh");
    expect(storage.drainErrors().map((error) => error.message)).toEqual([
      "OAuth provider returned an expired credential",
    ]);
  });

  it("rejects an expired rotated credential from a provider plugin", async () => {
    const original = {
      type: "oauth" as const,
      access: "expired-access",
      refresh: "expired-refresh",
      expires: 1,
    };
    const storage = AuthStorage.inMemory({ "plugin-oauth": original });
    providerOAuthMocks.resolveHandle.mockResolvedValue({
      provider: "plugin-oauth",
      plugin: { refreshOAuth: vi.fn() },
    });
    providerOAuthMocks.resolveCredential.mockResolvedValue({
      status: "available",
      credential: {
        type: "oauth",
        provider: "plugin-oauth",
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now(),
      },
      apiKey: "rotated-access",
    });

    await expect(storage.getApiKey("plugin-oauth")).resolves.toBeUndefined();
    expect(storage.get("plugin-oauth")).toEqual(original);
    expect(JSON.stringify(storage.getAll())).not.toContain("rotated-access");
    expect(JSON.stringify(storage.getAll())).not.toContain("rotated-refresh");
    expect(storage.drainErrors().map((error) => error.message)).toEqual([
      "OAuth provider returned an expired credential",
    ]);
  });

  it("persists a same-identity rotation and preserves attempted metadata", async () => {
    const storage = AuthStorage.inMemory({
      "test-oauth": {
        type: "oauth",
        access: "expired-access",
        refresh: "expired-refresh",
        expires: 1,
        accountId: "account-1",
      },
    });
    const refreshToken = vi.fn(async (_credentials, context) => {
      expect(context?.signal).toBeInstanceOf(AbortSignal);
      storage.set("test-oauth", {
        type: "oauth",
        access: "racing-access",
        refresh: "racing-refresh",
        expires: Date.now() + 30_000,
        accountId: "account-1",
      });
      return {
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 60_000,
      };
    });
    const prepareRefreshToken = registerRaceProvider(storage, refreshToken);

    await expect(storage.getApiKey("test-oauth")).resolves.toBe("rotated-access");
    expect(storage.get("test-oauth")).toMatchObject({
      type: "oauth",
      provider: "test-oauth",
      access: "rotated-access",
      refresh: "rotated-refresh",
      accountId: "account-1",
    });
    expect(prepareRefreshToken).toHaveBeenCalledOnce();
  });

  it("adopts a usable different identity without overwriting it", async () => {
    const storage = AuthStorage.inMemory({
      "test-oauth": {
        type: "oauth",
        access: "expired-access",
        refresh: "expired-refresh",
        expires: 1,
        accountId: "account-1",
      },
    });
    registerRaceProvider(storage, async () => {
      storage.set("test-oauth", {
        type: "oauth",
        access: "relogged-access",
        refresh: "relogged-refresh",
        expires: Date.now() + 10 * 60_000,
        accountId: "account-2",
      });
      return {
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 60_000,
      };
    });

    await expect(storage.getApiKey("test-oauth")).resolves.toBe("relogged-access");
    expect(storage.get("test-oauth")).toMatchObject({
      access: "relogged-access",
      refresh: "relogged-refresh",
      accountId: "account-2",
    });
  });

  it.each([
    {
      name: "removed authority",
      mutate: (storage: AuthStorage) => {
        storage.logout("test-oauth");
      },
      expected: undefined,
    },
    {
      name: "non-OAuth authority",
      mutate: (storage: AuthStorage) => {
        storage.set("test-oauth", { type: "api_key", key: "replacement-key" });
      },
      expected: { type: "api_key", key: "replacement-key" },
    },
    {
      name: "expired different identity",
      mutate: (storage: AuthStorage) => {
        storage.set("test-oauth", {
          type: "oauth",
          access: "other-expired-access",
          refresh: "other-expired-refresh",
          expires: 1,
          accountId: "account-2",
        });
      },
      expected: { type: "oauth", access: "other-expired-access", accountId: "account-2" },
    },
  ])("does not resurrect refreshed credentials over $name", async ({ mutate, expected }) => {
    const storage = AuthStorage.inMemory({
      "test-oauth": {
        type: "oauth",
        access: "expired-access",
        refresh: "expired-refresh",
        expires: 1,
        accountId: "account-1",
      },
    });
    registerRaceProvider(storage, async () => {
      mutate(storage);
      return {
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 60_000,
      };
    });

    await expect(storage.getApiKey("test-oauth")).resolves.toBeUndefined();
    if (expected) {
      expect(storage.get("test-oauth")).toEqual(expect.objectContaining(expected));
    } else {
      expect(storage.get("test-oauth")).toBeUndefined();
    }
  });
});

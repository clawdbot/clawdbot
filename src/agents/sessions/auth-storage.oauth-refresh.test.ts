import { describe, expect, it, vi } from "vitest";
import { getAuthStorageOAuthProviderRegistry } from "./auth-storage-oauth-registry.js";
import { AuthStorage, type AuthStorageBackend } from "./auth-storage.js";

describe("AuthStorage OAuth refresh ownership", () => {
  it("runs provider I/O outside custom backend locks and fences peer retries", async () => {
    const providerId = "test-oauth";
    let persisted = JSON.stringify({
      [providerId]: {
        type: "oauth",
        provider: providerId,
        access: "claimed-access",
        refresh: "claimed-refresh",
        expires: 1,
        accountId: "acct-123",
      },
    });
    let lockDepth = 0;
    const backend: AuthStorageBackend = {
      withLock: (fn) => {
        expect(lockDepth).toBe(0);
        lockDepth += 1;
        try {
          const update = fn(persisted);
          if (update.next !== undefined) {
            persisted = update.next;
          }
          return update.result;
        } finally {
          lockDepth -= 1;
        }
      },
      withLockAsync: async () => {
        throw new Error("refresh must not use withLockAsync");
      },
    };
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finishRefresh:
      | ((credentials: { access: string; refresh: string; expires: number }) => void)
      | undefined;
    const refreshToken = vi.fn(
      () =>
        new Promise<{ access: string; refresh: string; expires: number }>((resolve) => {
          expect(lockDepth).toBe(0);
          finishRefresh = resolve;
          markStarted?.();
        }),
    );
    const provider = {
      id: providerId,
      name: "Test OAuth",
      async login() {
        throw new Error("not used");
      },
      refreshToken,
      getApiKey(credentials: { access: string }) {
        return credentials.access;
      },
    };
    const storage = AuthStorage.fromStorage(backend);
    getAuthStorageOAuthProviderRegistry(storage).register(provider);

    const first = storage.getApiKey(providerId);
    await started;

    expect(persisted).toContain("openclaw-oauth-refresh-fence:v1:");
    expect(persisted).not.toContain("claimed-access");
    expect(persisted).not.toContain("claimed-refresh");
    expect(storage.get(providerId)).toBeUndefined();
    expect(storage.has(providerId)).toBe(false);
    expect(storage.list()).not.toContain(providerId);
    expect(storage.getAll()).toEqual({});
    expect(storage.getAuthStatus(providerId)).toEqual({ configured: false });
    const peer = AuthStorage.fromStorage(backend);
    getAuthStorageOAuthProviderRegistry(peer).register(provider);
    const peerResult = peer.getApiKey(providerId);
    expect(refreshToken).toHaveBeenCalledTimes(1);

    finishRefresh?.({
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: Date.now() + 60_000,
    });
    await expect(first).resolves.toBe("rotated-access");
    await expect(peerResult).resolves.toBe("rotated-access");
    expect(JSON.parse(persisted)).toMatchObject({
      [providerId]: {
        access: "rotated-access",
        refresh: "rotated-refresh",
        accountId: "acct-123",
      },
    });
  });

  it("preserves an expired credential when no refresh owner exists", async () => {
    const providerId = "unowned-oauth";
    const original = {
      type: "oauth",
      provider: providerId,
      access: "unowned-access",
      refresh: "unowned-refresh",
      expires: 1,
    } as const;
    let persisted = JSON.stringify({ [providerId]: original });
    const backend: AuthStorageBackend = {
      withLock: (fn) => {
        const update = fn(persisted);
        if (update.next !== undefined) {
          persisted = update.next;
        }
        return update.result;
      },
      withLockAsync: async () => {
        throw new Error("refresh must not use withLockAsync");
      },
    };
    const storage = AuthStorage.fromStorage(backend);

    await expect(storage.getApiKey(providerId)).resolves.toBeUndefined();
    expect(JSON.parse(persisted)[providerId]).toEqual(original);
  });

  it("does not replay a failed generation and allows environment fallback after restart", async () => {
    const providerId = "xai";
    let persisted = JSON.stringify({
      [providerId]: {
        type: "oauth",
        provider: providerId,
        access: "failed-access",
        refresh: "failed-refresh",
        expires: 1,
      },
    });
    const backend: AuthStorageBackend = {
      withLock: (fn) => {
        const update = fn(persisted);
        if (update.next !== undefined) {
          persisted = update.next;
        }
        return update.result;
      },
      withLockAsync: async () => {
        throw new Error("refresh must not use withLockAsync");
      },
    };
    const refreshToken = vi.fn(async () => {
      throw new Error("simulated provider rejection");
    });
    const provider = {
      id: providerId,
      name: "Failed OAuth",
      async login() {
        throw new Error("not used");
      },
      refreshToken,
      getApiKey(credentials: { access: string }) {
        return credentials.access;
      },
    };
    const first = AuthStorage.fromStorage(backend);
    getAuthStorageOAuthProviderRegistry(first).register(provider);
    await expect(first.getApiKey(providerId)).resolves.toBeUndefined();

    vi.stubEnv("XAI_API_KEY", "environment-fallback");
    try {
      const restarted = AuthStorage.fromStorage(backend);
      getAuthStorageOAuthProviderRegistry(restarted).register(provider);
      await expect(restarted.getApiKey(providerId)).resolves.toBe("environment-fallback");
      expect(refreshToken).toHaveBeenCalledTimes(1);
      expect(persisted).toContain("openclaw-oauth-refresh-fence:v1:");
      expect(persisted).not.toContain("failed-access");
      expect(persisted).not.toContain("failed-refresh");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

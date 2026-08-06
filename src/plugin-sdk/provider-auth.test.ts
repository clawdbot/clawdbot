// Provider auth tests cover credential resolution, setup state, and auth method contracts.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";

type FallbackStoreCaseResult = {
  profileIds: string[];
  resolvedKey: string | undefined;
  resolveApiKeyCalls: unknown[][];
};

async function runFallbackStoreCase(): Promise<FallbackStoreCaseResult> {
  vi.resetModules();

  const primaryStore: AuthProfileStore = {
    version: 1,
    profiles: {},
  };
  const fallbackStore: AuthProfileStore = {
    version: 1,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: "fallback-key",
      },
    },
  };
  const resolveApiKeyForProfile = vi.fn(
    async (params: { store: AuthProfileStore; profileId: string }) => {
      const profile = params.store.profiles[params.profileId];
      return profile?.type === "api_key" && profile.key
        ? {
            apiKey: profile.key,
            provider: profile.provider,
            profileId: params.profileId,
            profileType: profile.type,
          }
        : null;
    },
  );

  vi.doMock("../agents/agent-scope-config.js", () => ({
    resolveDefaultAgentDir: () => "/tmp/openclaw-agent",
  }));
  vi.doMock("../agents/auth-profiles/oauth.js", () => ({
    resolveApiKeyForProfile,
  }));
  vi.doMock("../agents/auth-profiles/order.js", () => ({
    resolveAuthProfileOrder: ({ provider, store }: { provider: string; store: AuthProfileStore }) =>
      Object.entries(store.profiles)
        .filter(([, profile]) => profile.provider === provider)
        .map(([profileId]) => profileId),
  }));
  vi.doMock("../agents/auth-profiles/store.js", () => ({
    ensureAuthProfileStore: vi.fn(() => primaryStore),
    ensureAuthProfileStoreForLocalUpdate: vi.fn(() => primaryStore),
    loadAuthProfileStoreForSecretsRuntime: vi.fn(() => primaryStore),
    loadAuthProfileStoreWithoutExternalProfiles: vi.fn(() => fallbackStore),
    updateAuthProfileStoreWithLock: vi.fn(),
  }));

  const { listUsableProviderAuthProfileIds, resolveProviderAuthProfileApiKey } =
    await import("./provider-auth.js");

  return {
    profileIds: listUsableProviderAuthProfileIds({ provider: "openai" }).profileIds,
    resolvedKey: await resolveProviderAuthProfileApiKey({ provider: "openai" }),
    resolveApiKeyCalls: resolveApiKeyForProfile.mock.calls,
  };
}

describe("provider auth profile helpers", () => {
  let fallbackStoreCase: FallbackStoreCaseResult;

  beforeAll(async () => {
    fallbackStoreCase = await runFallbackStoreCase();
  });

  afterEach(() => {
    vi.doUnmock("../agents/agent-scope-config.js");
    vi.doUnmock("../agents/auth-profiles/external-cli-discovery.js");
    vi.doUnmock("../agents/auth-profiles/oauth.js");
    vi.doUnmock("../agents/auth-profiles/order.js");
    vi.doUnmock("../agents/auth-profiles/store.js");
    vi.resetModules();
  });

  it("resolves API keys from the fallback store that supplied usable profile ids", () => {
    expect(fallbackStoreCase.profileIds).toEqual(["openai:default"]);
    expect(fallbackStoreCase.resolvedKey).toBe("fallback-key");
    expect(fallbackStoreCase.resolveApiKeyCalls).toContainEqual([
      expect.objectContaining({
        agentDir: "/tmp/openclaw-agent",
        profileId: "openai:default",
        store: expect.objectContaining({
          profiles: expect.objectContaining({
            "openai:default": expect.objectContaining({ key: "fallback-key" }),
          }),
        }),
      }),
    ]);
  });

  it("filters auth profile API-key resolution by credential type", async () => {
    vi.resetModules();

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:oauth": {
          type: "oauth",
          provider: "openai",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
        "openai:key": {
          type: "api_key",
          provider: "openai",
          key: "sk-profile",
        },
      },
    };
    const resolveApiKeyForProfile = vi.fn(
      async (params: { store: AuthProfileStore; profileId: string }) => {
        const profile = params.store.profiles[params.profileId];
        if (profile?.type === "oauth") {
          return {
            apiKey: profile.access,
            provider: profile.provider,
            profileId: params.profileId,
            profileType: profile.type,
          };
        }
        if (profile?.type === "api_key" && profile.key) {
          return {
            apiKey: profile.key,
            provider: profile.provider,
            profileId: params.profileId,
            profileType: profile.type,
          };
        }
        return null;
      },
    );

    vi.doMock("../agents/agent-scope-config.js", () => ({
      resolveDefaultAgentDir: () => "/tmp/openclaw-agent",
    }));
    vi.doMock("../agents/auth-profiles/oauth.js", () => ({
      resolveApiKeyForProfile,
    }));
    vi.doMock("../agents/auth-profiles/order.js", () => ({
      resolveAuthProfileOrder: ({
        provider,
        store: profileStore,
      }: {
        provider: string;
        store: AuthProfileStore;
      }) =>
        Object.entries(profileStore.profiles)
          .filter(([, profile]) => profile.provider === provider)
          .map(([profileId]) => profileId),
    }));
    vi.doMock("../agents/auth-profiles/store.js", () => ({
      ensureAuthProfileStore: vi.fn(() => store),
      ensureAuthProfileStoreForLocalUpdate: vi.fn(() => store),
      loadAuthProfileStoreForSecretsRuntime: vi.fn(() => store),
      loadAuthProfileStoreWithoutExternalProfiles: vi.fn(() => ({ version: 1, profiles: {} })),
      updateAuthProfileStoreWithLock: vi.fn(),
    }));

    const { resolveProviderAuthProfileApiKey } = await import("./provider-auth.js");

    await expect(
      resolveProviderAuthProfileApiKey({
        provider: "openai",
        profileTypes: ["api_key"],
      }),
    ).resolves.toBe("sk-profile");
    expect(resolveApiKeyForProfile).toHaveBeenCalledTimes(1);
    expect(resolveApiKeyForProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "openai:key" }),
    );
  });

  it("only discovers external CLI auth when provider resolution opts in", async () => {
    vi.resetModules();

    const primaryStore: AuthProfileStore = {
      version: 1,
      profiles: {},
    };
    const externalStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    const externalCli = { mode: "scoped", providerIds: ["openai"] };
    const loadAuthProfileStoreForSecretsRuntime = vi.fn(
      (_agentDir?: string, options?: { externalCli?: unknown }) =>
        options?.externalCli ? externalStore : primaryStore,
    );

    vi.doMock("../agents/agent-scope-config.js", () => ({
      resolveDefaultAgentDir: () => "/tmp/openclaw-agent",
    }));
    vi.doMock("../agents/auth-profiles/external-cli-discovery.js", () => ({
      externalCliDiscoveryForProviderAuth: vi.fn(() => externalCli),
    }));
    vi.doMock("../agents/auth-profiles/oauth.js", () => ({
      resolveApiKeyForProfile: vi.fn(),
    }));
    vi.doMock("../agents/auth-profiles/order.js", () => ({
      resolveAuthProfileOrder: ({
        provider,
        store,
      }: {
        provider: string;
        store: AuthProfileStore;
      }) =>
        Object.entries(store.profiles)
          .filter(([, profile]) => profile.provider === provider)
          .map(([profileId]) => profileId),
    }));
    vi.doMock("../agents/auth-profiles/store.js", () => ({
      ensureAuthProfileStore: vi.fn(() => primaryStore),
      ensureAuthProfileStoreForLocalUpdate: vi.fn(() => primaryStore),
      loadAuthProfileStoreForSecretsRuntime,
      loadAuthProfileStoreWithoutExternalProfiles: vi.fn(() => ({ version: 1, profiles: {} })),
      updateAuthProfileStoreWithLock: vi.fn(),
    }));

    const { isProviderAuthProfileConfigured } = await import("./provider-auth.js");

    expect(isProviderAuthProfileConfigured({ provider: "openai" })).toBe(false);
    expect(
      isProviderAuthProfileConfigured({
        provider: "openai",
        includeExternalCliAuth: true,
      }),
    ).toBe(true);
    expect(loadAuthProfileStoreForSecretsRuntime).toHaveBeenNthCalledWith(1, "/tmp/openclaw-agent");
    expect(loadAuthProfileStoreForSecretsRuntime).toHaveBeenNthCalledWith(
      2,
      "/tmp/openclaw-agent",
      { externalCli },
    );
  });

  it("accepts plus-signed Copilot token expiry strings", async () => {
    vi.resetModules();

    const saved: unknown[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: "token;proxy-ep=proxy.individual.githubcopilot.com",
            expires_at: "+2000000000",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const { resolveCopilotApiToken } = await import("./provider-auth.js");

    const result = await resolveCopilotApiToken({
      githubToken: "github-token",
      fetchImpl,
      cachePath: "/tmp/copilot-token.json",
      loadJsonFileImpl: () => undefined,
      saveJsonFileImpl: (_path, value) => saved.push(value),
    });

    expect(result.expiresAt).toBe(2_000_000_000_000);
    expect(saved).toEqual([
      expect.objectContaining({
        expiresAt: 2_000_000_000_000,
        token: "token;proxy-ep=proxy.individual.githubcopilot.com",
      }),
    ]);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toEqual(
      expect.objectContaining({
        Accept: "application/json",
        Authorization: "Bearer github-token",
        "Copilot-Integration-Id": "vscode-chat",
      }),
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects malformed Copilot proxy hints", async () => {
    vi.resetModules();

    const { deriveCopilotApiBaseUrlFromToken } = await import("./provider-auth.js");

    expect(
      deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=javascript:alert(1);"),
    ).toBeNull();
    expect(deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=://bad;")).toBeNull();
  });

  it("rejects Copilot token expiry values outside the supported date range", async () => {
    vi.resetModules();

    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: "token;proxy-ep=proxy.individual.githubcopilot.com",
            expires_at: Number.MAX_SAFE_INTEGER,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const { resolveCopilotApiToken } = await import("./provider-auth.js");

    await expect(
      resolveCopilotApiToken({
        githubToken: "github-token",
        fetchImpl,
        cachePath: "/tmp/copilot-token.json",
        loadJsonFileImpl: () => undefined,
        saveJsonFileImpl: () => {
          throw new Error("should not save invalid token");
        },
      }),
    ).rejects.toThrow("Copilot token response has invalid expires_at");
  });

  it("cancels Copilot token exchange error bodies", async () => {
    vi.resetModules();

    const response = new Response("bad credentials", { status: 401 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const fetchImpl = vi.fn(async () => response);

    const { resolveCopilotApiToken } = await import("./provider-auth.js");

    await expect(
      resolveCopilotApiToken({
        githubToken: "github-token",
        fetchImpl,
        cachePath: "/tmp/copilot-token.json",
        loadJsonFileImpl: () => undefined,
        saveJsonFileImpl: () => {
          throw new Error("should not save failed token");
        },
      }),
    ).rejects.toThrow("Copilot token exchange failed: HTTP 401");

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds oversized Copilot token success body and cancels the stream", async () => {
    vi.resetModules();

    const chunk = new Uint8Array(1024 * 1024); // 1 MiB chunk
    let readCount = 0;
    let canceled = false;
    // 64 chunks × 1 MiB = 64 MiB — far exceeds the 16 MiB cap
    const oversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (readCount >= 64) {
          controller.close();
          return;
        }
        readCount += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    });
    const response = new Response(oversizedBody, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const fetchImpl = vi.fn(async () => response);

    const { resolveCopilotApiToken } = await import("./provider-auth.js");

    await expect(
      resolveCopilotApiToken({
        githubToken: "github-token",
        fetchImpl,
        cachePath: "/tmp/copilot-token.json",
        loadJsonFileImpl: () => undefined,
        saveJsonFileImpl: () => {
          throw new Error("should not save oversized token");
        },
      }),
    ).rejects.toThrow("github-copilot.token");

    // Stream must be cancelled before all 64 chunks are consumed
    expect(readCount).toBeLessThan(64);
    expect(canceled).toBe(true);
  });

  it("bounds oversized Copilot token success body over HTTP transport", async () => {
    vi.resetModules();

    const http = await import("node:http");
    const { once } = await import("node:events");
    const MiB = 1024 * 1024;
    let bytesWritten = 0;

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const chunk = Buffer.alloc(MiB, 120);
      const header = Buffer.from('{"token":"');
      res.write(header);
      bytesWritten += header.length;
      let chunksSent = 0;
      const writeNext = () => {
        if (chunksSent >= 18) {
          const tail = Buffer.from('","expires_at":9999999999}');
          res.write(tail);
          bytesWritten += tail.length;
          res.end();
          return;
        }
        const ok = res.write(chunk);
        bytesWritten += chunk.length;
        chunksSent += 1;
        if (ok) {
          setImmediate(writeNext);
        } else {
          res.once("drain", writeNext);
        }
      };
      writeNext();
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected server address");
    }

    try {
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
        fetch(`http://127.0.0.1:${address.port}/token`, init),
      );
      const { resolveCopilotApiToken } = await import("./provider-auth.js");

      await expect(
        resolveCopilotApiToken({
          githubToken: "github-token",
          fetchImpl: fetchImpl as typeof fetch,
          cachePath: "/tmp/copilot-token-http-proof.json",
          loadJsonFileImpl: () => undefined,
          saveJsonFileImpl: () => {
            throw new Error("should not save oversized token");
          },
        }),
      ).rejects.toThrow("github-copilot.token");

      expect(bytesWritten).toBeGreaterThan(17 * MiB);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("accepts a normal Copilot token success body over HTTP transport", async () => {
    vi.resetModules();

    const http = await import("node:http");
    const { once } = await import("node:events");
    const body = JSON.stringify({
      token: "gho_abc;proxy-ep=proxy.individual.githubcopilot.com",
      expires_at: "+2000000000",
    });

    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      });
      res.end(body);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected server address");
    }

    try {
      const saved: unknown[] = [];
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
        fetch(`http://127.0.0.1:${address.port}/token`, init),
      );
      const { resolveCopilotApiToken } = await import("./provider-auth.js");

      const result = await resolveCopilotApiToken({
        githubToken: "github-token",
        fetchImpl: fetchImpl as typeof fetch,
        cachePath: "/tmp/copilot-token-http-happy.json",
        loadJsonFileImpl: () => undefined,
        saveJsonFileImpl: (path, value) => {
          saved.push({ path, value });
        },
      });

      expect(result.token).toContain("proxy-ep=proxy.individual.githubcopilot.com");
      expect(saved).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("refreshes cached Copilot tokens with out-of-range expiry values", async () => {
    vi.resetModules();

    const saved: unknown[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: "fresh;proxy-ep=proxy.individual.githubcopilot.com",
            expires_at: "+2000000000",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const { COPILOT_INTEGRATION_ID, resolveCopilotApiToken } = await import("./provider-auth.js");

    const result = await resolveCopilotApiToken({
      githubToken: "github-token",
      fetchImpl,
      cachePath: "/tmp/copilot-token.json",
      loadJsonFileImpl: () => ({
        token: "cached;proxy-ep=proxy.individual.githubcopilot.com",
        expiresAt: Number.MAX_SAFE_INTEGER,
        updatedAt: Date.now(),
        integrationId: COPILOT_INTEGRATION_ID,
      }),
      saveJsonFileImpl: (_path, value) => saved.push(value),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("fetched:https://api.github.com/copilot_internal/v2/token");
    expect(result.token).toBe("fresh;proxy-ep=proxy.individual.githubcopilot.com");
    expect(saved).toEqual([
      expect.objectContaining({
        expiresAt: 2_000_000_000_000,
        token: "fresh;proxy-ep=proxy.individual.githubcopilot.com",
      }),
    ]);
  });
});

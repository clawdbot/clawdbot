// Provider auth tests cover credential resolution, setup state, and auth method contracts.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";

const TEST_GITHUB_TOKEN = ["github", "token"].join("-");
const TEST_CACHED_COPILOT_TOKEN = [
  "cached",
  ["proxy-ep", "proxy.individual.githubcopilot.com"].join("="),
].join(";");
const TEST_GITHUB_TOKEN_FINGERPRINT = createHash("sha256").update(TEST_GITHUB_TOKEN).digest("hex");

async function withPartialCopilotResponse(run: (port: number) => Promise<void>): Promise<void> {
  const { once } = await import("node:events");
  const http = await import("node:http");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"token":"partial');
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected server address");
  }

  try {
    await run(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
}

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
    vi.restoreAllMocks();
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
        sourceCredentialFingerprint: createHash("sha256").update("github-token").digest("hex"),
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
    expect(
      deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=proxy.attacker.example;"),
    ).toBeNull();
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
        saveJsonFileImpl: (cachePath, value) => {
          saved.push({ path: cachePath, value });
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
        sourceCredentialFingerprint: TEST_GITHUB_TOKEN_FINGERPRINT,
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

  it("aborts hung Copilot token exchange instead of waiting forever", async () => {
    vi.resetModules();

    vi.spyOn(AbortSignal, "timeout").mockImplementation((timeoutMs) => {
      expect(timeoutMs).toBe(30_000);
      const controller = new AbortController();
      queueMicrotask(() => {
        controller.abort(new DOMException("timed out", "TimeoutError"));
      });
      return controller.signal;
    });

    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing abort signal"));
          return;
        }
        const abort = () => {
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("aborted", "AbortError"),
          );
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
      });
    });

    const { resolveCopilotApiToken } = await import("./provider-auth.js");

    await expect(
      resolveCopilotApiToken({
        githubToken: "github-token",
        fetchImpl: fetchImpl as typeof fetch,
        cachePath: "/tmp/copilot-token-hang.json",
        loadJsonFileImpl: () => undefined,
        saveJsonFileImpl: () => {
          throw new Error("should not save timed-out token");
        },
      }),
    ).rejects.toThrow("Copilot token exchange failed: timed out after 30000ms");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves the owned timeout reason as the normalized error cause", async () => {
    vi.resetModules();

    const ownedReason = new DOMException("owned deadline", "TimeoutError");
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(ownedReason));
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      throw init?.signal?.reason;
    });
    const { resolveCopilotApiToken } = await import("./provider-auth.js");

    await expect(
      resolveCopilotApiToken({
        githubToken: TEST_GITHUB_TOKEN,
        fetchImpl: fetchImpl as typeof fetch,
        cachePath: "/tmp/copilot-token-owned-timeout.json",
        loadJsonFileImpl: () => undefined,
        saveJsonFileImpl: () => {},
      }),
    ).rejects.toMatchObject({
      message: "Copilot token exchange failed: timed out after 30000ms",
      cause: ownedReason,
    });
  });

  it("aborts hung Copilot token exchange over HTTP transport", async () => {
    vi.resetModules();

    const http = await import("node:http");
    const { once } = await import("node:events");
    let connections = 0;

    const server = http.createServer((_req, _res) => {
      connections += 1;
      // Intentionally never write headers/body so fetch stays pending until abort.
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected server address");
    }

    try {
      // Keep the real fetch/undici abort path while shortening the production
      // deadline for this loopback transport test.
      const realTimeout = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, "timeout").mockImplementation((timeoutMs) => {
        expect(timeoutMs).toBe(30_000);
        return realTimeout(250);
      });
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return await fetch(`http://127.0.0.1:${address.port}/token`, init);
      });
      const { resolveCopilotApiToken } = await import("./provider-auth.js");
      const startedAt = Date.now();

      await expect(
        resolveCopilotApiToken({
          githubToken: "github-token",
          fetchImpl: fetchImpl as typeof fetch,
          cachePath: "/tmp/copilot-token-http-hang.json",
          loadJsonFileImpl: () => undefined,
          saveJsonFileImpl: () => {
            throw new Error("should not save timed-out token");
          },
        }),
      ).rejects.toThrow("Copilot token exchange failed: timed out after 30000ms");

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(connections).toBe(1);
      expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });

  for (const errorName of ["AbortError", "TimeoutError"] as const) {
    it(`preserves a foreign ${errorName} by identity`, async () => {
      vi.resetModules();

      const ownedReason = new DOMException("owned deadline", "TimeoutError");
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(ownedReason));
      const foreignError = new DOMException("foreign failure", errorName);
      const fetchImpl = vi.fn(async () => {
        throw foreignError;
      });
      const { resolveCopilotApiToken } = await import("./provider-auth.js");

      await expect(
        resolveCopilotApiToken({
          githubToken: TEST_GITHUB_TOKEN,
          fetchImpl,
          cachePath: "/tmp/copilot-token-foreign-error.json",
          loadJsonFileImpl: () => undefined,
          saveJsonFileImpl: () => {},
        }),
      ).rejects.toBe(foreignError);
    });
  }

  it("returns a valid cached token without creating a deadline or fetching", async () => {
    vi.resetModules();

    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn();
    const { COPILOT_INTEGRATION_ID, resolveCopilotApiToken } = await import("./provider-auth.js");
    const cachedValue = TEST_CACHED_COPILOT_TOKEN;

    const result = await resolveCopilotApiToken({
      githubToken: TEST_GITHUB_TOKEN,
      fetchImpl: fetchImpl as typeof fetch,
      cachePath: "/tmp/copilot-token-cache-hit.json",
      loadJsonFileImpl: () => ({
        token: cachedValue,
        expiresAt: Date.now() + 60 * 60 * 1000,
        updatedAt: Date.now(),
        integrationId: COPILOT_INTEGRATION_ID,
        sourceCredentialFingerprint: TEST_GITHUB_TOKEN_FINGERPRINT,
      }),
      saveJsonFileImpl: () => {},
    });

    expect(result.source).toBe("cache:/tmp/copilot-token-cache-hit.json");
    expect(timeout).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not reuse a cached Copilot token from another GitHub credential", async () => {
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
      githubToken: TEST_GITHUB_TOKEN,
      fetchImpl: fetchImpl as typeof fetch,
      cachePath: "/tmp/copilot-token-cache-profile-mismatch.json",
      loadJsonFileImpl: () => ({
        token: TEST_CACHED_COPILOT_TOKEN,
        expiresAt: Date.now() + 60 * 60 * 1000,
        updatedAt: Date.now(),
        integrationId: COPILOT_INTEGRATION_ID,
        sourceCredentialFingerprint: createHash("sha256").update("different-token").digest("hex"),
      }),
      saveJsonFileImpl: (_path, value) => saved.push(value),
    });

    expect(result.source).toContain("fetched:");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([
      expect.objectContaining({
        sourceCredentialFingerprint: TEST_GITHUB_TOKEN_FINGERPRINT,
        token: "fresh;proxy-ep=proxy.individual.githubcopilot.com",
      }),
    ]);
  });

  it("retains valid Copilot exchanges across A to B to A profile rotation", async () => {
    vi.resetModules();

    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-cache-"));
    try {
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get("authorization");
        const sourceFixture = authorization?.replace(/^Bearer\s+/u, "") ?? "";
        let exchangeFixture = "test-token-placeholder";
        if (sourceFixture === "test-auth-token") {
          exchangeFixture = "test-auth-token";
        }
        return new Response(
          JSON.stringify(
            Object.fromEntries([
              ["token", exchangeFixture],
              ["expires_at", Date.now() + 60 * 60 * 1000],
            ]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      const { resolveCopilotApiToken } = await import("./provider-auth.js");
      const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;

      const firstA = await resolveCopilotApiToken({
        githubToken: "test-auth-token",
        env,
        fetchImpl: fetchImpl as typeof fetch,
      });
      const firstB = await resolveCopilotApiToken({
        githubToken: "test-token-placeholder",
        env,
        fetchImpl: fetchImpl as typeof fetch,
      });
      const secondA = await resolveCopilotApiToken({
        githubToken: "test-auth-token",
        env,
        fetchImpl: fetchImpl as typeof fetch,
      });

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(firstA.token).toBe("test-auth-token");
      expect(firstB.token).toBe("test-token-placeholder");
      expect(secondA.token).toBe(firstA.token);
      expect(secondA.source).toBe("cache:plugin-state");
    } finally {
      const { resetPluginStateStoreForTests } =
        await import("../plugin-state/plugin-state-store.js");
      resetPluginStateStoreForTests();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("times out while reading a stalled HTTP response body", async () => {
    vi.resetModules();

    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((timeoutMs) => {
      expect(timeoutMs).toBe(30_000);
      return realTimeout(250);
    });

    await withPartialCopilotResponse(async (port) => {
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        return await fetch(`http://127.0.0.1:${port}/token`, init);
      });
      const { resolveCopilotApiToken } = await import("./provider-auth.js");
      let rejection: unknown;

      try {
        await resolveCopilotApiToken({
          githubToken: TEST_GITHUB_TOKEN,
          fetchImpl: fetchImpl as typeof fetch,
          cachePath: "/tmp/copilot-token-partial-body.json",
          loadJsonFileImpl: () => undefined,
          saveJsonFileImpl: () => {
            throw new Error("should not save timed-out token");
          },
        });
      } catch (error) {
        rejection = error;
      }

      const signal = fetchImpl.mock.calls[0]?.[1]?.signal;
      expect(rejection).toMatchObject({
        message: "Copilot token exchange failed: timed out after 30000ms",
      });
      expect((rejection as Error & { cause?: unknown }).cause).toBe(signal?.reason);
      expect(signal?.aborted).toBe(true);
    });
  });
});

describe("Copilot data-residency domain resolution", () => {
  afterEach(() => {
    delete process.env.COPILOT_GITHUB_DOMAIN;
  });

  it("warns once when a configured domain is rejected during token resolution", async () => {
    vi.resetModules();
    const logWarn = vi.fn();
    vi.doMock("../logger.js", async () => {
      const actual = await vi.importActual<typeof import("../logger.js")>("../logger.js");
      return { ...actual, logWarn };
    });
    const { resolveCopilotApiToken } = await import("./provider-auth.js");

    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "tok", expires_at: "+2000000000" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const withDomain = (githubDomain: string) =>
      ({
        models: { providers: { "github-copilot": { params: { githubDomain } } } },
      }) as never;
    const resolveWithConfigDomain = (githubDomain: string) =>
      resolveCopilotApiToken({
        githubToken: "github-token",
        env: {},
        config: withDomain(githubDomain),
        fetchImpl,
        cachePath: "/tmp/copilot-token-warn.json",
        loadJsonFileImpl: () => undefined,
        saveJsonFileImpl: () => {},
      });

    // Valid tenant + explicit public host never warn.
    await resolveWithConfigDomain("acme.ghe.com");
    await resolveWithConfigDomain("github.com");
    expect(logWarn).not.toHaveBeenCalled();

    // Typo (`.co`) fails the allowlist -> silent fallback -> warn once, not twice.
    await resolveWithConfigDomain("acme.ghe.co");
    await resolveWithConfigDomain("acme.ghe.co");
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("acme.ghe.co"));

    vi.doUnmock("../logger.js");
  });

  it("rejects unsafe hostnames and falls back to github.com", async () => {
    vi.resetModules();
    const { normalizeGithubCopilotDomain } = await import("./provider-auth.js");

    expect(normalizeGithubCopilotDomain("https://evil.com/login")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("user@host")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("acme.ghe.com")).toBe("acme.ghe.com");
    expect(normalizeGithubCopilotDomain("  ACME.GHE.COM  ")).toBe("acme.ghe.com");
  });

  it("locks the host allowlist to github.com and single-label *.ghe.com tenant roots", async () => {
    vi.resetModules();
    const { normalizeGithubCopilotDomain } = await import("./provider-auth.js");

    // Allowed: public host and single-label data-residency tenant roots.
    expect(normalizeGithubCopilotDomain("github.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("acme.ghe.com")).toBe("acme.ghe.com");

    // Rejected: derived service hosts under a tenant. GitHub documents these as
    // `*.SUBDOMAIN.ghe.com` endpoints; storing one would template broken hosts
    // like `api.api.acme.ghe.com` for the token exchange.
    expect(normalizeGithubCopilotDomain("api.acme.ghe.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("copilot-api.acme.ghe.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("a.b.ghe.com")).toBe("github.com");

    // Rejected: arbitrary hosts, look-alikes, and the bare non-tenant apex.
    expect(normalizeGithubCopilotDomain("evil.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("ghe.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("github.com.evil.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("evilghe.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("acme.ghe.com.evil.com")).toBe("github.com");
  });

  it("targets the tenant token endpoint and copilot-api fallback for a GHE domain", async () => {
    vi.resetModules();

    const fetchImpl = vi.fn(
      async () =>
        // GHE data-residency tokens carry a stamp but no proxy-ep hint.
        new Response(JSON.stringify({ token: "ghe;st=prod-sdc-01", expires_at: "+2000000000" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const { resolveCopilotApiToken } = await import("./provider-auth.js");

    const result = await resolveCopilotApiToken({
      githubToken: "github-token",
      env: {},
      githubDomain: "acme.ghe.com",
      fetchImpl,
      cachePath: "/tmp/copilot-token-ghe.json",
      loadJsonFileImpl: () => undefined,
      saveJsonFileImpl: () => {},
    });

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.acme.ghe.com/copilot_internal/v2/token");
    expect(result.source).toBe("fetched:https://api.acme.ghe.com/copilot_internal/v2/token");
    expect(result.baseUrl).toBe("https://copilot-api.acme.ghe.com");
  });

  it("lets COPILOT_GITHUB_DOMAIN override the caller-provided domain", async () => {
    vi.resetModules();

    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "ghe;st=prod-sdc-01", expires_at: "+2000000000" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const { resolveCopilotApiToken } = await import("./provider-auth.js");

    const result = await resolveCopilotApiToken({
      githubToken: "github-token",
      env: { COPILOT_GITHUB_DOMAIN: "env.ghe.com" },
      githubDomain: "config.ghe.com",
      fetchImpl,
      cachePath: "/tmp/copilot-token-env.json",
      loadJsonFileImpl: () => undefined,
      saveJsonFileImpl: () => {},
    });

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.env.ghe.com/copilot_internal/v2/token");
    expect(result.baseUrl).toBe("https://copilot-api.env.ghe.com");
  });

  it("does not reuse a cached token minted for a different domain", async () => {
    vi.resetModules();

    const saved: unknown[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "ghe;st=prod-sdc-01", expires_at: "+2000000000" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const { COPILOT_INTEGRATION_ID, resolveCopilotApiToken } = await import("./provider-auth.js");

    // A valid, unexpired public-github.com token sits in the cache, but the
    // request targets a GHE tenant, so it must be re-exchanged rather than
    // sending a github.com token to api.acme.ghe.com.
    const result = await resolveCopilotApiToken({
      githubToken: "github-token",
      env: {},
      githubDomain: "acme.ghe.com",
      fetchImpl,
      cachePath: "/tmp/copilot-token-cross.json",
      loadJsonFileImpl: () => ({
        token: "public;proxy-ep=proxy.individual.githubcopilot.com",
        expiresAt: Number.MAX_SAFE_INTEGER - 1,
        updatedAt: Date.now(),
        integrationId: COPILOT_INTEGRATION_ID,
        domain: "github.com",
      }),
      saveJsonFileImpl: (_path, value) => saved.push(value),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("fetched:https://api.acme.ghe.com/copilot_internal/v2/token");
    expect(saved).toEqual([expect.objectContaining({ domain: "acme.ghe.com" })]);
  });

  it("re-exchanges legacy cache entries without a source credential fingerprint", async () => {
    vi.resetModules();

    const saved: unknown[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: "fresh-public;proxy-ep=proxy.individual.githubcopilot.com",
            expires_at: "+2000000000",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const { COPILOT_INTEGRATION_ID, resolveCopilotApiToken } = await import("./provider-auth.js");

    const result = await resolveCopilotApiToken({
      githubToken: "github-token",
      env: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cachePath: "/tmp/copilot-token-legacy.json",
      loadJsonFileImpl: () => ({
        token: "legacy-public;proxy-ep=proxy.individual.githubcopilot.com",
        expiresAt: Date.now() + 60 * 60 * 1000,
        updatedAt: Date.now(),
        integrationId: COPILOT_INTEGRATION_ID,
        // no domain or source credential fingerprint
      }),
      saveJsonFileImpl: (_path, value) => saved.push(value),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("fetched:https://api.github.com/copilot_internal/v2/token");
    expect(saved).toEqual([
      expect.objectContaining({
        domain: "github.com",
        sourceCredentialFingerprint: TEST_GITHUB_TOKEN_FINGERPRINT,
      }),
    ]);
  });

  it("does not reuse a legacy pre-domain cache entry for a tenant domain", async () => {
    vi.resetModules();

    const saved: unknown[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "ghe;st=prod-sdc-01", expires_at: "+2000000000" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const { COPILOT_INTEGRATION_ID, resolveCopilotApiToken } = await import("./provider-auth.js");

    const result = await resolveCopilotApiToken({
      githubToken: "github-token",
      env: {},
      githubDomain: "acme.ghe.com",
      fetchImpl,
      cachePath: "/tmp/copilot-token-legacy-tenant.json",
      loadJsonFileImpl: () => ({
        token: "legacy-public;proxy-ep=proxy.individual.githubcopilot.com",
        expiresAt: Date.now() + 60 * 60 * 1000,
        updatedAt: Date.now(),
        integrationId: COPILOT_INTEGRATION_ID,
        // no domain field — implies github.com, so a tenant request must miss
      }),
      saveJsonFileImpl: (_path, value) => saved.push(value),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("fetched:https://api.acme.ghe.com/copilot_internal/v2/token");
    expect(saved).toEqual([expect.objectContaining({ domain: "acme.ghe.com" })]);
  });

  it("reuses a cached token minted for the same domain", async () => {
    vi.resetModules();

    const fetchImpl = vi.fn();
    const { COPILOT_INTEGRATION_ID, resolveCopilotApiToken } = await import("./provider-auth.js");

    const result = await resolveCopilotApiToken({
      githubToken: "github-token",
      env: {},
      githubDomain: "acme.ghe.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cachePath: "/tmp/copilot-token-same.json",
      loadJsonFileImpl: () => ({
        token: "tenant-cached;st=prod-sdc-01",
        expiresAt: Date.now() + 60 * 60 * 1000,
        updatedAt: Date.now(),
        integrationId: COPILOT_INTEGRATION_ID,
        sourceCredentialFingerprint: TEST_GITHUB_TOKEN_FINGERPRINT,
        domain: "acme.ghe.com",
      }),
      saveJsonFileImpl: () => {},
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.source).toBe("cache:/tmp/copilot-token-same.json");
    expect(result.baseUrl).toBe("https://copilot-api.acme.ghe.com");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

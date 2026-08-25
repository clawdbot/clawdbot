// Provider auth tests cover credential resolution, setup state, and auth method contracts.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "../agents/auth-profiles.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  COPILOT_INTEGRATION_ID,
  deriveCopilotApiBaseUrlFromToken,
  isProviderApiKeyConfigured,
  normalizeGithubCopilotDomain,
  readClaudeCliCredentialsCached,
  removeProviderAuthProfilesWithLock,
  resolveCopilotApiToken,
} from "./provider-auth.js";

const TEST_GITHUB_TOKEN = ["github", "token"].join("-");
const TEST_CACHED_COPILOT_TOKEN = [
  "cached",
  ["proxy-ep", "proxy.individual.githubcopilot.com"].join("="),
].join(";");
const TEST_GITHUB_TOKEN_FINGERPRINT = createHash("sha256").update(TEST_GITHUB_TOKEN).digest("hex");

describe("provider auth public SDK", () => {
  it("retains provider-scoped profile removal", () => {
    expect(removeProviderAuthProfilesWithLock).toBeTypeOf("function");
  });

  it("keeps the retired Claude credential reader as a null-only compatibility export", () => {
    const onStoredCredentialUnreadable = vi.fn();

    expect(readClaudeCliCredentialsCached({ onStoredCredentialUnreadable })).toBeNull();
    expect(onStoredCredentialUnreadable).not.toHaveBeenCalled();
  });
});

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

describe("provider API-key readiness", () => {
  const provider = "media-readiness-provider";

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearRuntimeAuthProfileStoreSnapshots();
    vi.unstubAllEnvs();
  });

  function configuredProvider(apiKey: unknown, providerId = provider): OpenClawConfig {
    return {
      models: {
        providers: {
          [providerId]: {
            apiKey,
            baseUrl: "https://media.example.test/v1",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
  }

  it.each([provider, ` ${provider.toUpperCase()} `])(
    "recognizes usable config-only API keys for normalized provider entry %s",
    (providerId) => {
      expect(
        isProviderApiKeyConfigured({
          provider,
          cfg: configuredProvider("media-secret", providerId),
        }),
      ).toBe(true);
    },
  );

  it.each([
    "",
    "   ",
    "oauth:media-readiness-provider",
    "custom-local",
    "gcp-vertex-credentials",
    "secretref-managed",
    "GOOGLE_API_KEY",
  ])("does not mistake non-secret marker %j for a usable configured API key", (apiKey) => {
    vi.stubEnv("GOOGLE_API_KEY", "");
    expect(isProviderApiKeyConfigured({ provider, cfg: configuredProvider(apiKey) })).toBe(false);
  });

  it("recognizes allowed env SecretRefs through their configured provider alias", () => {
    vi.stubEnv("MEDIA_READINESS_TEST_KEY", "resolved-media-secret");
    const cfg = configuredProvider({
      source: "env",
      provider: "team-env",
      id: "MEDIA_READINESS_TEST_KEY",
    });
    cfg.secrets = {
      defaults: { env: "team-env" },
      providers: {
        "team-env": { source: "env", allowlist: ["MEDIA_READINESS_TEST_KEY"] },
      },
    };

    expect(isProviderApiKeyConfigured({ provider, cfg })).toBe(true);
  });

  it.each(["file", "exec"] as const)(
    "keeps an unresolved %s SecretRef unavailable until its managed runtime snapshot resolves it",
    (source) => {
      const sourceConfig = configuredProvider({ source, provider: "managed", id: "media-key" });
      expect(isProviderApiKeyConfigured({ provider, cfg: sourceConfig })).toBe(false);

      const runtimeConfig = configuredProvider("resolved-managed-media-secret");
      setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

      expect(isProviderApiKeyConfigured({ provider, cfg: sourceConfig })).toBe(true);
    },
  );

  it("does not advertise missing or provider-disallowed env SecretRefs", () => {
    vi.stubEnv("MEDIA_READINESS_TEST_KEY", "resolved-media-secret");
    const cfg = configuredProvider({
      source: "env",
      provider: "team-env",
      id: "MEDIA_READINESS_TEST_KEY",
    });
    cfg.secrets = {
      providers: { "team-env": { source: "env", allowlist: ["OTHER_MEDIA_KEY"] } },
    };

    expect(isProviderApiKeyConfigured({ provider, cfg })).toBe(false);
    vi.stubEnv("MEDIA_READINESS_TEST_KEY", "");
    cfg.secrets.providers!["team-env"] = { source: "env" };
    expect(isProviderApiKeyConfigured({ provider, cfg })).toBe(false);
  });

  it("preserves existing behavior when callers omit runtime configuration", () => {
    expect(isProviderApiKeyConfigured({ provider })).toBe(false);
  });

  it("applies provider-owned credential acceptance only when explicitly requested", () => {
    const cfg = configuredProvider("blocked-provider-key");

    expect(isProviderApiKeyConfigured({ provider, cfg })).toBe(true);
    expect(
      isProviderApiKeyConfigured({
        provider,
        cfg,
        acceptsApiKey: (apiKey) => !apiKey.startsWith("blocked-"),
      }),
    ).toBe(false);
    expect(
      isProviderApiKeyConfigured({
        provider,
        cfg: configuredProvider("allowed-provider-key"),
        acceptsApiKey: (apiKey) => !apiKey.startsWith("blocked-"),
      }),
    ).toBe(true);
  });

  it.each([
    ["allowed-profile-key", "blocked-environment-key", true],
    ["blocked-profile-key", "allowed-environment-key", false],
  ])(
    "applies credential acceptance to the higher-priority auth profile %s",
    async (profileKey, envKey, expected) => {
      vi.stubEnv("GOOGLE_API_KEY", envKey);
      const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-key-policy-"));

      try {
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              "google:selected": {
                type: "api_key",
                provider: "google",
                key: profileKey,
              },
            },
          },
          agentDir,
          { filterExternalAuthProfiles: false, syncExternalCli: false },
        );

        expect(
          isProviderApiKeyConfigured({
            provider: "google",
            agentDir,
            profileTypes: ["api_key"],
            acceptsApiKey: (apiKey) => !apiKey.startsWith("blocked-"),
          }),
        ).toBe(expected);
      } finally {
        clearRuntimeAuthProfileStoreSnapshots();
        await fs.rm(agentDir, { force: true, recursive: true });
      }
    },
  );

  it("keeps an explicit config credential above rejected environment credentials", () => {
    vi.stubEnv("GOOGLE_API_KEY", "blocked-environment-key");
    const cfg = configuredProvider("allowed-config-key", "google");
    const google = cfg.models?.providers?.google;
    if (!google) {
      throw new Error("missing configured Google provider");
    }
    google.auth = "api-key";

    expect(
      isProviderApiKeyConfigured({
        provider: "google",
        cfg,
        acceptsApiKey: (apiKey) => !apiKey.startsWith("blocked-"),
      }),
    ).toBe(true);
  });

  it.each([
    ["oauth", ["api_key"], false],
    ["token", ["api_key"], false],
    ["oauth", ["oauth"], true],
    ["token", ["token"], true],
    ["api-key", ["api_key"], true],
  ] as const)(
    "honors configured %s credential mode for allowed profile types %j",
    (auth, profileTypes, expected) => {
      const cfg = configuredProvider("media-api-key");
      const entry = cfg.models?.providers?.[provider];
      if (!entry) {
        throw new Error("missing configured media provider");
      }
      entry.auth = auth;

      expect(isProviderApiKeyConfigured({ provider, cfg, profileTypes })).toBe(expected);
    },
  );

  it("honors hydrated managed-SecretRef credential modes for API-key-only consumers", () => {
    const sourceConfig = configuredProvider({
      source: "file",
      provider: "managed",
      id: "media-key",
    });
    const runtimeConfig = configuredProvider("resolved-managed-media-secret");
    const sourceProvider = sourceConfig.models?.providers?.[provider];
    const runtimeProvider = runtimeConfig.models?.providers?.[provider];
    if (!sourceProvider || !runtimeProvider) {
      throw new Error("missing managed media provider configuration");
    }
    sourceProvider.auth = "oauth";
    runtimeProvider.auth = "oauth";
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    expect(
      isProviderApiKeyConfigured({ provider, cfg: sourceConfig, profileTypes: ["api_key"] }),
    ).toBe(false);
    expect(
      isProviderApiKeyConfigured({ provider, cfg: sourceConfig, profileTypes: ["oauth"] }),
    ).toBe(true);
  });

  it.each([
    {
      label: "compatible API-key profile",
      credential: { type: "api_key", provider, key: "profile-api-key" },
      profileTypes: ["api_key"],
      expected: true,
    },
    {
      label: "OAuth profile rejected by provider-entry credential policy",
      credential: {
        type: "oauth",
        provider,
        access: "oauth-access",
        refresh: "oauth-refresh",
        expires: Date.now() + 60_000,
      },
      profileTypes: ["api_key"],
      expected: false,
    },
    {
      label: "token profile rejected by an API-key-only consumer",
      credential: { type: "token", provider, token: "profile-token" },
      profileTypes: ["api_key"],
      expected: false,
    },
    {
      label: "token profile accepted by a token consumer",
      credential: { type: "token", provider, token: "profile-token" },
      profileTypes: ["token"],
      expected: true,
    },
    {
      label: "API-key profile owned by a different provider",
      credential: { type: "api_key", provider: "unrelated-provider", key: "wrong-provider-key" },
      profileTypes: ["api_key"],
      expected: false,
    },
    {
      label: "API-key profile with missing credential material",
      credential: { type: "api_key", provider },
      profileTypes: ["api_key"],
      expected: false,
    },
    {
      label: "API-key profile with an unresolved env SecretRef",
      credential: {
        type: "api_key",
        provider,
        keyRef: { source: "env", provider: "default", id: "MEDIA_PROFILE_MISSING_SECRET" },
      },
      profileTypes: ["api_key"],
      expected: false,
    },
  ] satisfies Array<{
    label: string;
    credential: AuthProfileCredential;
    profileTypes: AuthProfileCredential["type"][];
    expected: boolean;
  }>)(
    "classifies configured profile references: $label",
    async ({ credential, expected, profileTypes }) => {
      vi.stubEnv("MEDIA_PROFILE_MISSING_SECRET", "");
      const profileId = `${provider}:selected`;
      const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-profile-binding-"));
      try {
        saveAuthProfileStore({ version: 1, profiles: { [profileId]: credential } }, agentDir, {
          filterExternalAuthProfiles: false,
          syncExternalCli: false,
        });

        expect(
          isProviderApiKeyConfigured({
            provider,
            agentDir,
            cfg: configuredProvider(profileId),
            profileTypes,
          }),
        ).toBe(expected);
      } finally {
        clearRuntimeAuthProfileStoreSnapshots();
        await fs.rm(agentDir, { force: true, recursive: true });
      }
    },
  );

  it("preserves API-key-only profile filters while accepting actual config API keys", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-auth-readiness-"));
    try {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [`${provider}:oauth`]: {
              type: "oauth",
              provider,
              access: "oauth-access",
              refresh: "oauth-refresh",
              expires: Date.now() + 60_000,
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false, syncExternalCli: false },
      );

      expect(isProviderApiKeyConfigured({ provider, agentDir })).toBe(true);
      expect(
        isProviderApiKeyConfigured({
          provider,
          agentDir,
          cfg: configuredProvider(`oauth:${provider}`),
          profileTypes: ["api_key"],
        }),
      ).toBe(false);
      expect(
        isProviderApiKeyConfigured({
          provider,
          agentDir,
          cfg: configuredProvider("media-api-key"),
          profileTypes: ["api_key"],
        }),
      ).toBe(true);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { force: true, recursive: true });
    }
  });
});

describe("provider auth profile helpers", () => {
  let fallbackStoreCase: FallbackStoreCaseResult;

  beforeAll(async () => {
    fallbackStoreCase = await runFallbackStoreCase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
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

  it("rejects malformed Copilot proxy hints", () => {
    expect(
      deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=javascript:alert(1);"),
    ).toBeNull();
    expect(deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=://bad;")).toBeNull();
    expect(
      deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=proxy.attacker.example;"),
    ).toBeNull();
  });

  it("rejects Copilot token expiry values outside the supported date range", async () => {
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
    const response = new Response("bad credentials", { status: 401 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const fetchImpl = vi.fn(async () => response);

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
    const ownedReason = new DOMException("owned deadline", "TimeoutError");
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(ownedReason));
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      throw init?.signal?.reason;
    });
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
      const ownedReason = new DOMException("owned deadline", "TimeoutError");
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(ownedReason));
      const foreignError = new DOMException("foreign failure", errorName);
      const fetchImpl = vi.fn(async () => {
        throw foreignError;
      });
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
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn();
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
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((timeoutMs) => {
      expect(timeoutMs).toBe(30_000);
      return realTimeout(250);
    });

    await withPartialCopilotResponse(async (port) => {
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        return await fetch(`http://127.0.0.1:${port}/token`, init);
      });
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
    const { resolveCopilotApiToken: resolveCopilotApiTokenWithLoggerMock } =
      await import("./provider-auth.js");

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
      resolveCopilotApiTokenWithLoggerMock({
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

  it("rejects unsafe hostnames and falls back to github.com", () => {
    expect(normalizeGithubCopilotDomain("https://evil.com/login")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("user@host")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("acme.ghe.com")).toBe("acme.ghe.com");
    expect(normalizeGithubCopilotDomain("  ACME.GHE.COM  ")).toBe("acme.ghe.com");
  });

  it("locks the host allowlist to github.com and single-label *.ghe.com tenant roots", () => {
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
    const fetchImpl = vi.fn(
      async () =>
        // GHE data-residency tokens carry a stamp but no proxy-ep hint.
        new Response(JSON.stringify({ token: "ghe;st=prod-sdc-01", expires_at: "+2000000000" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

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
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "ghe;st=prod-sdc-01", expires_at: "+2000000000" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

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
    const saved: unknown[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "ghe;st=prod-sdc-01", expires_at: "+2000000000" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

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
    const saved: unknown[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "ghe;st=prod-sdc-01", expires_at: "+2000000000" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

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
    const fetchImpl = vi.fn();
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

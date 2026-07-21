// Model auth status tests cover profile health summaries, provider usage,
// credential cleanup, secret refresh, and provider run abort side effects.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthHealthSummary } from "../../agents/auth-health.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import { NON_ENV_SECRETREF_MARKER } from "../../agents/model-auth-markers.js";
import type { UsageSummary } from "../../infra/provider-usage.types.js";
import { MAX_DATE_TIMESTAMP_MS } from "../../shared/number-coercion.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type BuildAuthHealthSummary = typeof import("../../agents/auth-health.js").buildAuthHealthSummary;

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

const emptyUsageSummary = (): UsageSummary => ({ updatedAt: 0, providers: [] });

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  listAgentIds: vi.fn(() => ["main"]),
  resolveAgentDir: vi.fn((_cfg: unknown, agentId: string) =>
    agentId === "main" ? "/tmp/agent" : `/tmp/agent-${agentId}`,
  ),
  resolveDefaultAgentId: vi.fn(() => "main"),
  ensureAuthProfileStore: vi.fn((agentDir?: string, options?: unknown): AuthProfileStore => {
    void agentDir;
    void options;
    return { version: 1, profiles: {} };
  }),
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn((agentDir?: string): AuthProfileStore => {
    void agentDir;
    return { version: 1, profiles: {} };
  }),
  listProfilesForProvider: vi.fn((): string[] => []),
  removeAuthProfilesWithLock: vi.fn(
    async (): Promise<AuthProfileStore | null> => ({ version: 1, profiles: {} }),
  ),
  removeProviderAuthProfilesWithLock: vi.fn(
    async (): Promise<AuthProfileStore | null> => ({ version: 1, profiles: {} }),
  ),
  resolvePersistedAuthProfileOwnerAgentDir: vi.fn(
    (params: { agentDir?: string }) => params.agentDir,
  ),
  clearRuntimeAuthProfileStoreSnapshots: vi.fn(),
  refreshActiveProviderAuthRuntimeSnapshot: vi.fn(async () => false),
  clearCurrentProviderAuthState: vi.fn(),
  warmCurrentProviderAuthStateOffMainThread: vi.fn(async (_cfg: unknown) => {}),
  buildAuthHealthSummary: vi.fn<BuildAuthHealthSummary>(
    (): AuthHealthSummary => ({ now: 0, warnAfterMs: 0, profiles: [], providers: [] }),
  ),
  loadProviderUsageSummary: vi.fn(async (): Promise<UsageSummary> => emptyUsageSummary()),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: mocks.listAgentIds,
  resolveAgentDir: mocks.resolveAgentDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

vi.mock("../../agents/auth-profiles.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/auth-profiles.js")>(
    "../../agents/auth-profiles.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore: mocks.ensureAuthProfileStore,
    ensureAuthProfileStoreWithoutExternalProfiles:
      mocks.ensureAuthProfileStoreWithoutExternalProfiles,
    listProfilesForProvider: mocks.listProfilesForProvider,
    removeAuthProfilesWithLock: mocks.removeAuthProfilesWithLock,
    removeProviderAuthProfilesWithLock: mocks.removeProviderAuthProfilesWithLock,
    resolvePersistedAuthProfileOwnerAgentDir: mocks.resolvePersistedAuthProfileOwnerAgentDir,
    clearRuntimeAuthProfileStoreSnapshots: mocks.clearRuntimeAuthProfileStoreSnapshots,
  };
});

vi.mock("../../agents/auth-health.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/auth-health.js")>(
    "../../agents/auth-health.js",
  );
  return {
    ...actual,
    buildAuthHealthSummary: mocks.buildAuthHealthSummary,
  };
});

vi.mock("../../infra/provider-usage.load.js", () => ({
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));

vi.mock("../../secrets/runtime.js", () => ({
  refreshActiveProviderAuthRuntimeSnapshot: mocks.refreshActiveProviderAuthRuntimeSnapshot,
}));

vi.mock("../../agents/model-provider-auth.js", () => ({
  clearCurrentProviderAuthState: mocks.clearCurrentProviderAuthState,
  warmCurrentProviderAuthStateOffMainThread: mocks.warmCurrentProviderAuthStateOffMainThread,
}));

import {
  aggregateRefreshableAuthStatus,
  invalidateModelAuthStatusCache,
  modelsAuthStatusHandlers,
  type ModelAuthLogoutResult,
  type ModelAuthStatusResult,
} from "./models-auth-status.js";

function createOptions(
  params: Record<string, unknown> = {},
): GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> } {
  const respond = vi.fn();
  return {
    req: { type: "req", id: "req-1", method: "models.authStatus", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: { getRuntimeConfig: mocks.getRuntimeConfig } as unknown,
  } as unknown as GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> };
}

const handler = expectDefined(
  modelsAuthStatusHandlers["models.authStatus"],
  'modelsAuthStatusHandlers["models.authStatus"] test invariant',
);
const logoutHandler = expectDefined(
  modelsAuthStatusHandlers["models.authLogout"],
  'modelsAuthStatusHandlers["models.authLogout"] test invariant',
);

function createActiveRun(providerId: string, authProviderId?: string, agentId = "main") {
  return {
    controller: new AbortController(),
    sessionId: `session-${providerId}`,
    sessionKey: `agent:${agentId}:${providerId}`,
    agentId,
    startedAtMs: 1,
    expiresAtMs: 60_000,
    providerId,
    authProviderId,
  };
}

function createApiKeyProfile(provider: string) {
  return {
    profileId: `${provider}:default`,
    provider,
    type: "api_key",
    status: "static",
    source: "store",
    label: `${provider}:default`,
  } satisfies AuthHealthSummary["profiles"][number];
}

function createStaticApiKeyProvider(provider: string) {
  return {
    provider,
    status: "static",
    profiles: [createApiKeyProfile(provider)],
  } satisfies AuthHealthSummary["providers"][number];
}

function createLogoutOptions(
  params: Record<string, unknown> = {},
): GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> } {
  const respond = vi.fn();
  const context = {
    getRuntimeConfig: mocks.getRuntimeConfig,
    chatAbortControllers: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    chatDeltaLastBroadcastText: new Map(),
    agentDeltaSentAt: new Map(),
    bufferedAgentEvents: new Map(),
    chatAbortedRuns: new Map(),
    clearChatRunState: vi.fn(),
    removeChatRun: vi.fn(),
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
  };
  return {
    req: { type: "req", id: "req-logout", method: "models.authLogout", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context,
  } as unknown as GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function firstRespondCall(
  opts: GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> },
) {
  return opts.respond.mock.calls[0];
}

function firstEnsureAuthProfileStoreCall() {
  return mocks.ensureAuthProfileStore.mock.calls[0];
}

function firstBuildAuthHealthSummaryCall() {
  return mocks.buildAuthHealthSummary.mock.calls[0] as unknown as
    | [{ providers?: string[]; allowKeychainPrompt?: boolean }]
    | undefined;
}

async function firstAuthStatusProvider() {
  const opts = createOptions();
  await handler(opts);
  const [ok, payload, error] = firstRespondCall(opts) ?? [];
  expect(ok, JSON.stringify(error)).toBe(true);
  return (payload as ModelAuthStatusResult).providers[0];
}

function resetAuthStatusMocks(): void {
  vi.clearAllMocks();
  invalidateModelAuthStatusCache();
  mocks.getRuntimeConfig.mockReturnValue({});
  mocks.listAgentIds.mockReturnValue(["main"]);
  mocks.resolveAgentDir.mockImplementation((_cfg: unknown, agentId: string) =>
    agentId === "main" ? "/tmp/agent" : `/tmp/agent-${agentId}`,
  );
  mocks.resolveDefaultAgentId.mockReturnValue("main");
  mocks.ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
  mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
    version: 1,
    profiles: {},
  });
  mocks.listProfilesForProvider.mockReturnValue([]);
  mocks.removeAuthProfilesWithLock.mockResolvedValue({ version: 1, profiles: {} });
  mocks.removeProviderAuthProfilesWithLock.mockResolvedValue({ version: 1, profiles: {} });
  mocks.resolvePersistedAuthProfileOwnerAgentDir.mockImplementation(
    (params: { agentDir?: string }) => params.agentDir,
  );
  mocks.buildAuthHealthSummary.mockReturnValue({
    now: 0,
    warnAfterMs: 0,
    profiles: [],
    providers: [],
  });
  mocks.loadProviderUsageSummary.mockResolvedValue(emptyUsageSummary());
  mocks.refreshActiveProviderAuthRuntimeSnapshot.mockResolvedValue(false);
}

function firstExternalCliAuthOption() {
  expect(mocks.ensureAuthProfileStore).toHaveBeenCalledTimes(1);
  expect(firstEnsureAuthProfileStoreCall()?.[0]).toBe("/tmp/agent");
  const [, options] = firstEnsureAuthProfileStoreCall() ?? [];
  return requireRecord(requireRecord(options).externalCli);
}

function expectLogoutFailurePreservesRun(params: {
  opts: ReturnType<typeof createLogoutOptions>;
  runId: string;
  run: ReturnType<typeof createActiveRun>;
  message: string;
}): void {
  expect(params.run.controller.signal.aborted).toBe(false);
  expect(params.opts.context.chatAbortControllers.has(params.runId)).toBe(true);
  const [ok, payload, error] = firstRespondCall(params.opts) ?? [];
  expect(ok).toBe(false);
  expect(payload).toBeUndefined();
  expect(error?.message).toContain(params.message);
}

async function expectLogoutFailureDoesNotAbortRun(params: {
  arrangeFailure: () => void;
  message: string;
}): Promise<void> {
  params.arrangeFailure();
  const opts = createLogoutOptions({ provider: "openrouter" });
  const activeRun = createActiveRun("openrouter");
  opts.context.chatAbortControllers.set("run-openrouter", activeRun);

  await logoutHandler(opts);

  expectLogoutFailurePreservesRun({
    opts,
    runId: "run-openrouter",
    run: activeRun,
    message: params.message,
  });
}

function createOpenAiCodexOauthHealthSummary(): AuthHealthSummary {
  const profile = {
    profileId: "openai:default",
    provider: "openai",
    type: "oauth",
    status: "ok",
    expiresAt: 1_000_000,
    remainingMs: 60_000,
    source: "store",
    label: "openai:default",
  } satisfies AuthHealthSummary["profiles"][number];
  return {
    now: 0,
    warnAfterMs: 0,
    profiles: [profile],
    providers: [
      {
        provider: "openai",
        status: "ok",
        expiresAt: 1_000_000,
        remainingMs: 60_000,
        profiles: [profile],
      },
    ],
  };
}

describe("models.authStatus", () => {
  beforeEach(() => {
    resetAuthStatusMocks();
  });

  it.each([
    { name: "omitted", params: {}, expectedAgentId: "main" },
    { name: "empty", params: { agentId: "" }, expectedAgentId: "main" },
    { name: "valid", params: { agentId: "Writer" }, expectedAgentId: "writer" },
  ])(
    "resolves an $name agentId against the configured roster",
    async ({ params, expectedAgentId }) => {
      const cfg = { agents: { list: [{ id: "main", default: true }, { id: "writer" }] } };
      mocks.getRuntimeConfig.mockReturnValue(cfg);
      mocks.listAgentIds.mockReturnValue(["main", "writer"]);

      const opts = createOptions(params);
      await handler(opts);

      expect(mocks.resolveAgentDir).toHaveBeenCalledWith(cfg, expectedAgentId);
      expect(mocks.ensureAuthProfileStore).toHaveBeenCalledWith(
        expectedAgentId === "main" ? "/tmp/agent" : "/tmp/agent-writer",
        expect.any(Object),
      );
    },
  );

  it("rejects an explicit unknown agentId before reading auth state", async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }, { id: "writer" }] } };
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    mocks.listAgentIds.mockReturnValue(["main", "writer"]);
    const opts = createOptions({ agentId: "retired", refresh: true });

    await handler(opts);

    expect(mocks.resolveAgentDir).not.toHaveBeenCalled();
    expect(mocks.ensureAuthProfileStore).not.toHaveBeenCalled();
    expect(mocks.refreshActiveProviderAuthRuntimeSnapshot).not.toHaveBeenCalled();
    const [ok, payload, error] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toEqual({
      code: "INVALID_REQUEST",
      message: 'unknown agent id "retired"',
      details: { code: "UNKNOWN_AGENT_ID", agentId: "retired" },
    });
  });

  it("accepts an explicitly configured normalized roster id", async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }, { id: "_writer" }] } };
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    mocks.listAgentIds.mockReturnValue(["main", "_writer"]);
    const opts = createOptions({ agentId: "_writer" });

    await handler(opts);

    expect(mocks.resolveAgentDir).toHaveBeenCalledWith(cfg, "_writer");
    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledWith(
      "/tmp/agent-_writer",
      expect.any(Object),
    );
    expect(firstRespondCall(opts)?.[0]).toBe(true);
  });

  it.each(["???", "ſ", "   ", "\t"])(
    "rejects explicit id %j when it collapses to the normalization fallback",
    async (agentId) => {
      const cfg = { agents: { list: [{ id: "main", default: true }] } };
      mocks.getRuntimeConfig.mockReturnValue(cfg);
      mocks.listAgentIds.mockReturnValue(["main"]);
      const opts = createOptions({ agentId });

      await handler(opts);

      expect(mocks.resolveAgentDir).not.toHaveBeenCalled();
      expect(mocks.ensureAuthProfileStore).not.toHaveBeenCalled();
      expect(firstRespondCall(opts)?.[2]).toEqual({
        code: "INVALID_REQUEST",
        message: `unknown agent id "${agentId}"`,
        details: { code: "UNKNOWN_AGENT_ID", agentId },
      });
    },
  );

  it("keeps cached auth snapshots isolated by agent", async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }, { id: "writer" }] } };
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    mocks.listAgentIds.mockReturnValue(["main", "writer"]);

    await handler(createOptions({ agentId: "main" }));
    await handler(createOptions({ agentId: "writer" }));
    const cachedMain = createOptions({ agentId: "main" });
    await handler(cachedMain);

    expect(mocks.ensureAuthProfileStore).toHaveBeenNthCalledWith(
      1,
      "/tmp/agent",
      expect.any(Object),
    );
    expect(mocks.ensureAuthProfileStore).toHaveBeenNthCalledWith(
      2,
      "/tmp/agent-writer",
      expect.any(Object),
    );
    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledTimes(2);
    expect(firstRespondCall(cachedMain)?.[3]).toEqual({ cached: true });
  });

  it("re-reads runtime config after an explicit auth refresh", async () => {
    const before = { agents: { list: [{ id: "main", default: true }] } };
    const after = {
      ...before,
      models: { providers: { openai: { auth: "oauth" } } },
    };
    mocks.getRuntimeConfig.mockReturnValueOnce(before).mockReturnValue(after);

    await handler(createOptions({ refresh: true }));

    expect(mocks.getRuntimeConfig).toHaveBeenCalledTimes(2);
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: after }),
    );
  });

  it("returns a serialisable snapshot on first call", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "access",
          refresh: "refresh",
          expires: 1_000_000,
        },
      },
    });
    mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());

    const opts = createOptions();
    await handler(opts);

    expect(opts.respond).toHaveBeenCalledTimes(1);
    const [ok, payload, error] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    const result = payload as ModelAuthStatusResult;
    expect(result.providers).toHaveLength(1);
    expect(expectDefined(result.providers[0], "result.providers[0] test invariant").provider).toBe(
      "openai",
    );
    expect(expectDefined(result.providers[0], "result.providers[0] test invariant").status).toBe(
      "ok",
    );
    expect(
      expectDefined(result.providers[0], "result.providers[0] test invariant").expiry?.at,
    ).toBe(1_000_000);
    expect(
      expectDefined(
        expectDefined(result.providers[0], "result.providers[0] test invariant").profiles[0],
        'expectDefined(result.providers[0], "result.providers[0] test invarian... test invariant',
      ).type,
    ).toBe("oauth");
    expect(result.providers[0]?.profiles[0]?.logoutSupported).toBe(true);
  });

  it("does not offer logout for runtime external CLI profiles", async () => {
    const health = createOpenAiCodexOauthHealthSummary();
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
      runtimeExternalProfileIds: ["openai:default"],
    });
    mocks.buildAuthHealthSummary.mockReturnValue(health);

    const provider = await firstAuthStatusProvider();

    expect(provider?.profiles[0]?.logoutSupported).toBeUndefined();
  });

  it("does not offer logout for config-bound token profiles", async () => {
    const profileId = "openrouter:token";
    const profile = {
      profileId,
      provider: "openrouter",
      type: "token",
      status: "static",
      source: "store",
      label: profileId,
    } satisfies AuthHealthSummary["profiles"][number];
    mocks.getRuntimeConfig.mockReturnValue({
      models: {
        providers: {
          openrouter: Object.fromEntries([["apiKey", profileId]]),
        },
      },
    });
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        [profileId]: { type: "token", provider: "openrouter", token: "placeholder" },
      },
    });
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [profile],
      providers: [{ provider: "openrouter", status: "static", profiles: [profile] }],
    });

    const provider = await firstAuthStatusProvider();
    expect(provider?.profiles[0]?.logoutSupported).toBeUndefined();
  });

  it("reports config API key provenance without returning the value", async () => {
    const configValue = ["test", "only", "value"].join("-");
    mocks.getRuntimeConfig.mockReturnValue({
      models: { providers: { openai: { apiKey: configValue } } },
    });
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [createApiKeyProfile("openai")],
      providers: [createStaticApiKeyProvider("openai")],
    });

    const provider = await firstAuthStatusProvider();
    expect(provider?.apiKey).toEqual({ source: "config" });
    expect(JSON.stringify(provider)).not.toContain(configValue);
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledWith(
      expect.objectContaining({ providers: ["openai"] }),
    );
  });

  it("reports an environment SecretRef by variable name only", async () => {
    process.env.MODELS_AUTH_STATUS_PROVENANCE_KEY = "test-only-value";
    mocks.getRuntimeConfig.mockReturnValue({
      models: {
        providers: {
          openai: {
            apiKey: {
              source: "env",
              provider: "default",
              id: "MODELS_AUTH_STATUS_PROVENANCE_KEY",
            },
          },
        },
      },
    });
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [createApiKeyProfile("openai")],
      providers: [createStaticApiKeyProvider("openai")],
    });

    try {
      const provider = await firstAuthStatusProvider();
      expect(provider?.apiKey).toEqual({
        source: "env",
        envVar: "MODELS_AUTH_STATUS_PROVENANCE_KEY",
      });
    } finally {
      delete process.env.MODELS_AUTH_STATUS_PROVENANCE_KEY;
    }
  });

  it("reports non-env SecretRefs as presence-only config auth", async () => {
    mocks.getRuntimeConfig.mockReturnValue({
      models: {
        providers: {
          openai: Object.fromEntries([
            ["apiKey", { source: "file", provider: "mounted-json", id: "model-provider-key" }],
          ]),
        },
      },
    });
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [],
      providers: [{ provider: "openai", status: "missing", profiles: [] }],
    });

    const provider = await firstAuthStatusProvider();
    expect(provider?.apiKey).toEqual({ source: "config" });
    expect(provider?.status).toBe("static");
  });

  it("reports an available persisted env marker as environment auth", async () => {
    const value = ["test", "only", "value"].join("-");
    await withEnvAsync(Object.fromEntries([["ANTHROPIC_API_KEY", value]]), async () => {
      mocks.getRuntimeConfig.mockReturnValue({
        models: {
          providers: {
            anthropic: Object.fromEntries([["apiKey", "ANTHROPIC_API_KEY"]]),
          },
        },
      });
      mocks.buildAuthHealthSummary.mockReturnValue({
        now: 0,
        warnAfterMs: 0,
        profiles: [createApiKeyProfile("anthropic")],
        providers: [createStaticApiKeyProvider("anthropic")],
      });

      const provider = await firstAuthStatusProvider();
      expect(provider?.apiKey).toEqual({ source: "env", envVar: "ANTHROPIC_API_KEY" });
      expect(JSON.stringify(provider)).not.toContain(value);
    });
  });

  it("does not report unresolved persisted markers as API keys", async () => {
    await withEnvAsync(Object.fromEntries([["ANTHROPIC_API_KEY", undefined]]), async () => {
      const actualAuthHealth = await vi.importActual<typeof import("../../agents/auth-health.js")>(
        "../../agents/auth-health.js",
      );
      mocks.getRuntimeConfig.mockReturnValue({
        models: {
          providers: {
            anthropic: Object.fromEntries([["apiKey", "ANTHROPIC_API_KEY"]]),
          },
        },
      });
      mocks.buildAuthHealthSummary.mockImplementationOnce(actualAuthHealth.buildAuthHealthSummary);

      const provider = await firstAuthStatusProvider();
      expect(provider?.provider).toBe("anthropic");
      expect(provider?.apiKey).toBeUndefined();
      expect(provider?.status).toBe("missing");
    });
  });

  it("does not report a local no-auth marker as a configured API key", async () => {
    const actualAuthHealth = await vi.importActual<typeof import("../../agents/auth-health.js")>(
      "../../agents/auth-health.js",
    );
    mocks.getRuntimeConfig.mockReturnValue({
      models: {
        providers: {
          ollama: Object.fromEntries([["apiKey", "ollama-local"]]),
        },
      },
    });
    mocks.buildAuthHealthSummary.mockImplementationOnce(actualAuthHealth.buildAuthHealthSummary);

    const provider = await firstAuthStatusProvider();
    expect(provider).toBeUndefined();
  });

  it("does not report an AWS SDK marker as a configured API key", async () => {
    const actualAuthHealth = await vi.importActual<typeof import("../../agents/auth-health.js")>(
      "../../agents/auth-health.js",
    );
    mocks.getRuntimeConfig.mockReturnValue({
      models: {
        providers: {
          "amazon-bedrock": Object.fromEntries([["apiKey", "AWS_PROFILE"]]),
        },
      },
    });
    mocks.buildAuthHealthSummary.mockImplementationOnce(actualAuthHealth.buildAuthHealthSummary);

    const provider = await firstAuthStatusProvider();
    expect(provider).toBeUndefined();
  });

  it("keeps unresolved managed SecretRef markers visible as missing", async () => {
    const actualAuthHealth = await vi.importActual<typeof import("../../agents/auth-health.js")>(
      "../../agents/auth-health.js",
    );
    mocks.getRuntimeConfig.mockReturnValue({
      models: {
        providers: {
          openai: Object.fromEntries([["apiKey", NON_ENV_SECRETREF_MARKER]]),
        },
      },
    });
    mocks.buildAuthHealthSummary.mockImplementationOnce(actualAuthHealth.buildAuthHealthSummary);

    const provider = await firstAuthStatusProvider();
    expect(provider?.provider).toBe("openai");
    expect(provider?.apiKey).toBeUndefined();
    expect(provider?.status).toBe("missing");
  });

  it("does not duplicate profile references as config API keys", async () => {
    const profileId = "anthropic:saved";
    mocks.getRuntimeConfig.mockReturnValue({
      models: {
        providers: { anthropic: Object.fromEntries([["apiKey", profileId]]) },
      },
    });
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        [profileId]: {
          type: "api_key",
          provider: "anthropic",
          key: "placeholder",
        },
      },
    });
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [createApiKeyProfile("anthropic")],
      providers: [createStaticApiKeyProvider("anthropic")],
    });

    const provider = await firstAuthStatusProvider();
    expect(provider?.apiKey).toBeUndefined();
    expect(provider?.profiles).toHaveLength(1);
  });

  it("forwards unresolved auth reason codes to status clients", async () => {
    const profile = {
      profileId: "openai-codex:default",
      provider: "openai-codex",
      type: "oauth",
      status: "missing",
      reasonCode: "unresolved_ref",
      source: "store",
      label: "openai-codex:default",
    } satisfies AuthHealthSummary["profiles"][number];
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [profile],
      providers: [
        {
          provider: "openai-codex",
          status: "missing",
          profiles: [profile],
        },
      ],
    });

    const opts = createOptions();
    await handler(opts);

    const [, payload] = firstRespondCall(opts) ?? [];
    const result = payload as ModelAuthStatusResult;
    expect(result.providers[0]?.status).toBe("missing");
    expect(result.providers[0]?.profiles[0]?.reasonCode).toBe("unresolved_ref");
  });

  it("serves cached response within TTL and marks it as cached", async () => {
    const opts1 = createOptions();
    await handler(opts1);
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(1);

    const opts2 = createOptions();
    await handler(opts2);

    // Auth health should NOT be re-queried on the cached call.
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(1);

    const lastCall = opts2.respond.mock.calls.at(-1);
    expect(requireRecord(lastCall?.[3]).cached).toBe(true);
  });

  it("bypasses cache when params.refresh is set", async () => {
    await handler(createOptions());
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(1);

    await handler(createOptions({ refresh: true }));
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(2);
    expect(mocks.refreshActiveProviderAuthRuntimeSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.clearRuntimeAuthProfileStoreSnapshots).toHaveBeenCalledTimes(1);
    const clearOrder = mocks.clearRuntimeAuthProfileStoreSnapshots.mock.invocationCallOrder[0];
    const refreshReadOrder = mocks.ensureAuthProfileStore.mock.invocationCallOrder.at(-1);
    expect(clearOrder).toBeLessThan(refreshReadOrder ?? 0);
  });

  it("keeps refreshed secrets runtime snapshots on explicit refresh", async () => {
    mocks.refreshActiveProviderAuthRuntimeSnapshot.mockResolvedValueOnce(true);

    await handler(createOptions({ refresh: true }));

    expect(mocks.refreshActiveProviderAuthRuntimeSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.clearRuntimeAuthProfileStoreSnapshots).not.toHaveBeenCalled();
    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledTimes(1);
  });

  it("keeps last-good secrets runtime snapshots when explicit refresh fails", async () => {
    mocks.refreshActiveProviderAuthRuntimeSnapshot.mockRejectedValueOnce(
      new Error("refresh failed"),
    );

    await handler(createOptions({ refresh: true }));

    expect(mocks.refreshActiveProviderAuthRuntimeSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.clearRuntimeAuthProfileStoreSnapshots).not.toHaveBeenCalled();
    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledTimes(1);
  });

  it("invalidateModelAuthStatusCache() clears the cached response", async () => {
    await handler(createOptions());
    invalidateModelAuthStatusCache();
    await handler(createOptions());
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(2);
  });

  it("does not cache status captured before a concurrent logout", async () => {
    let releaseUsage: (() => void) | undefined;
    const usageBlocked = new Promise<void>((resolve) => {
      releaseUsage = resolve;
    });
    const oauthProfile = {
      profileId: "openrouter:default",
      provider: "openrouter",
      type: "oauth",
      status: "ok",
      source: "store",
      label: "openrouter:default",
    } satisfies AuthHealthSummary["profiles"][number];
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [oauthProfile],
      providers: [{ provider: "openrouter", status: "ok", profiles: [oauthProfile] }],
    });
    mocks.loadProviderUsageSummary.mockImplementationOnce(async () => {
      await usageBlocked;
      return emptyUsageSummary();
    });

    const inFlightStatus = handler(createOptions());
    await waitForFast(() => expect(mocks.loadProviderUsageSummary).toHaveBeenCalledOnce());
    await logoutHandler(createLogoutOptions({ provider: "openrouter" }));
    releaseUsage?.();
    await inFlightStatus;

    await handler(createOptions());
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(2);
  });

  it("does not query usage for api-key-only providers", async () => {
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [createApiKeyProfile("anthropic")],
      providers: [createStaticApiKeyProvider("anthropic")],
    });

    await handler(createOptions());
    expect(mocks.loadProviderUsageSummary).not.toHaveBeenCalled();
  });

  it("routes claude-cli OAuth profiles to Anthropic usage with plan and billing", async () => {
    const profile = {
      profileId: "claude-cli",
      provider: "claude-cli",
      type: "oauth",
      status: "ok",
      source: "store",
      label: "claude-cli",
    } satisfies AuthHealthSummary["profiles"][number];
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [profile],
      providers: [{ provider: "claude-cli", status: "ok", profiles: [profile] }],
    });
    mocks.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: 0,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          plan: "Max (20x)",
          accountEmail: "clawd@example.com",
          windows: [{ label: "5h", usedPercent: 22 }],
          billing: [{ type: "budget", used: 157.85, limit: 400, unit: "USD", period: "month" }],
        },
      ],
    });

    const opts = createOptions();
    await handler(opts);

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith({
      providers: ["anthropic"],
      agentDir: "/tmp/agent",
      timeoutMs: 3500,
    });
    const [, payload] = firstRespondCall(opts) ?? [];
    const result = payload as ModelAuthStatusResult;
    expect(result.providers[0]?.displayName).toBe("Claude");
    expect(result.providers[0]?.usage).toEqual({
      providerId: "anthropic",
      windows: [{ label: "5h", usedPercent: 22 }],
      plan: "Max (20x)",
      billing: [{ type: "budget", used: 157.85, limit: 400, unit: "USD", period: "month" }],
      accountEmail: "clawd@example.com",
    });
  });

  it("adds DeepSeek API-key balance summaries to auth status usage", async () => {
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [createApiKeyProfile("deepseek")],
      providers: [createStaticApiKeyProvider("deepseek")],
    });
    mocks.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: 0,
      providers: [
        {
          provider: "deepseek",
          displayName: "DeepSeek",
          windows: [],
          summary: "Balance ¥42.50",
        },
      ],
    });

    const opts = createOptions();
    await handler(opts);

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith({
      providers: ["deepseek"],
      agentDir: "/tmp/agent",
      timeoutMs: 3500,
    });
    const [, payload] = firstRespondCall(opts) ?? [];
    const result = payload as ModelAuthStatusResult;
    expect(result.providers[0]?.usage).toEqual({
      providerId: "deepseek",
      windows: [],
      summary: "Balance ¥42.50",
    });
  });

  it("scopes external CLI auth overlays to configured providers", async () => {
    mocks.getRuntimeConfig.mockReturnValue({
      auth: {
        profiles: {
          "opencode-go:default": { provider: "opencode-go", mode: "api_key" },
        },
      },
      agents: {
        defaults: {
          model: { primary: "opencode-go/kimi-k2.6" },
        },
      },
      models: {
        providers: {
          "opencode-go": {
            baseUrl: "https://example.test/v1",
            auth: "api-key",
            models: [],
          },
        },
      },
    });

    await handler(createOptions());

    const externalCli = firstExternalCliAuthOption();
    expect(externalCli.mode).toBe("scoped");
    expect(externalCli.allowKeychainPrompt).toBe(false);
    requireRecord(externalCli.config);
    expect(externalCli.providerIds).toContain("opencode-go");
    expect(externalCli.providerIds).not.toContain("claude-cli");
    expect(externalCli.profileIds).toEqual(["opencode-go:default"]);
  });

  it("disables external CLI auth overlays when config has no provider signal", async () => {
    await handler(createOptions());

    const externalCli = firstExternalCliAuthOption();
    expect(externalCli.mode).toBe("none");
    expect(externalCli.allowKeychainPrompt).toBe(false);
    requireRecord(externalCli.config);
  });

  it("still returns providers when usage fetch fails", async () => {
    mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());
    mocks.loadProviderUsageSummary.mockRejectedValue(new Error("timeout"));

    const opts = createOptions();
    await handler(opts);

    const [ok, payload] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(true);
    const result = payload as ModelAuthStatusResult;
    expect(result.providers).toHaveLength(1);
    expect(
      expectDefined(result.providers[0], "result.providers[0] test invariant").usage,
    ).toBeUndefined();
  });

  it("does not leak secret-looking fields from upstream profile data", async () => {
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [
        {
          profileId: "openai:default",
          provider: "openai",
          type: "oauth",
          status: "ok",
          expiresAt: 1,
          remainingMs: 1,
          source: "store",
          label: "openai:default",
          // Simulate a future profile shape that includes an access token —
          // the handler must NOT forward this, since it field-maps explicitly.
          access: "sk-SECRET-TOKEN",
          refresh: "rt-SECRET-REFRESH",
        } as never,
      ],
      providers: [
        {
          provider: "openai",
          status: "ok",
          expiresAt: 1,
          remainingMs: 1,
          profiles: [
            {
              profileId: "openai:default",
              provider: "openai",
              type: "oauth",
              status: "ok",
              expiresAt: 1,
              remainingMs: 1,
              source: "store",
              label: "openai:default",
              access: "sk-SECRET-TOKEN",
              refresh: "rt-SECRET-REFRESH",
            } as never,
          ],
        },
      ],
    });

    const opts = createOptions();
    await handler(opts);
    const [, payload] = firstRespondCall(opts) ?? [];
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain("sk-SECRET-TOKEN");
    expect(serialised).not.toContain("rt-SECRET-REFRESH");
  });

  it("includes config-key-backed OAuth providers for static synthesis", async () => {
    // The provider filter now creates a row that mapProvider can mark static
    // while preserving the API-key provenance needed by the Control UI.
    mocks.getRuntimeConfig.mockReturnValue({
      models: {
        providers: {
          openai: { auth: "oauth", apiKey: "sk-xxxxx" },
        },
      },
    });
    await handler(createOptions());
    const call = firstBuildAuthHealthSummaryCall();
    expect(call?.[0]?.providers).toEqual(["openai"]);
  });

  it("builds status health without allowing keychain prompts", async () => {
    await handler(createOptions());
    const call = firstBuildAuthHealthSummaryCall();
    expect(call?.[0]?.allowKeychainPrompt).toBe(false);
  });

  it("still flags provider as missing when apiKey env SecretRef points at an unset env var", async () => {
    // Config declares an env SecretRef but the referenced env var isn't
    // set. We read process.env directly for env-source SecretRefs and fall
    // through to the normal missing synthesis so the dashboard surfaces
    // the broken config instead of masking it.
    delete process.env.MODELS_AUTH_STATUS_TEST_MISSING_KEY;
    mocks.getRuntimeConfig.mockReturnValue({
      models: {
        providers: {
          openai: {
            auth: "oauth",
            apiKey: {
              source: "env",
              provider: "default",
              id: "MODELS_AUTH_STATUS_TEST_MISSING_KEY",
            },
          },
        },
      },
    });
    await handler(createOptions());
    const call = firstBuildAuthHealthSummaryCall();
    expect(call?.[0]?.providers).toEqual(["openai"]);
  });

  it("includes a resolved env SecretRef provider for static synthesis", async () => {
    process.env.MODELS_AUTH_STATUS_TEST_SET_KEY = "sk-real-value";
    mocks.getRuntimeConfig.mockReturnValue({
      models: {
        providers: {
          openai: {
            auth: "oauth",
            apiKey: {
              source: "env",
              provider: "default",
              id: "MODELS_AUTH_STATUS_TEST_SET_KEY",
            },
          },
        },
      },
    });
    try {
      await handler(createOptions());
      const call = firstBuildAuthHealthSummaryCall();
      expect(call?.[0]?.providers).toEqual(["openai"]);
    } finally {
      delete process.env.MODELS_AUTH_STATUS_TEST_SET_KEY;
    }
  });

  it("deduplicates API-key and auth.profile provider synthesis", async () => {
    mocks.getRuntimeConfig.mockReturnValue({
      models: {
        providers: {
          openai: { auth: "oauth", apiKey: "sk-xxxxx" },
        },
      },
      auth: {
        profiles: {
          "openai:default": { provider: "openai", mode: "oauth" },
        },
      },
    });
    await handler(createOptions());
    const call = firstBuildAuthHealthSummaryCall();
    expect(call?.[0]?.providers).toEqual(["openai"]);
  });

  it("does not map expectsOAuth provider ids across provider id variants", async () => {
    mocks.getRuntimeConfig.mockReturnValue({
      models: { providers: { "z.ai": { auth: "oauth" } } },
    });
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [],
      providers: [createStaticApiKeyProvider("zai")],
    });
    const provider = await firstAuthStatusProvider();
    expect(provider?.status).toBe("static");
  });

  it("flags provider configured auth:oauth but with only api_key profile as missing", async () => {
    // Config says provider should use OAuth; store has only an api_key
    // credential (e.g. operator switched modes but forgot to login).
    mocks.getRuntimeConfig.mockReturnValue({
      models: { providers: { anthropic: { auth: "oauth" } } },
    });
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [],
      providers: [createStaticApiKeyProvider("anthropic")],
    });

    const provider = await firstAuthStatusProvider();
    expect(provider?.status).toBe("missing");
  });

  it("reports setup-token health after an OAuth credential migration", async () => {
    const profile = {
      profileId: "claude-cli:setup-token",
      provider: "claude-cli",
      type: "token",
      status: "static",
      source: "store",
      label: "claude-cli:setup-token",
    } satisfies AuthHealthSummary["profiles"][number];
    mocks.getRuntimeConfig.mockReturnValue({
      auth: {
        profiles: {
          "claude-cli:setup-token": { provider: "claude-cli", mode: "oauth" },
        },
        order: { "claude-cli": ["claude-cli:setup-token"] },
      },
    });
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [profile],
      providers: [
        {
          provider: "claude-cli",
          status: "static",
          effectiveProfiles: [profile],
          profiles: [profile],
        },
      ],
    });

    const provider = await firstAuthStatusProvider();
    expect(provider?.status).toBe("static");
  });

  it("responds with UNAVAILABLE when buildAuthHealthSummary throws", async () => {
    mocks.buildAuthHealthSummary.mockImplementation(() => {
      throw new Error("boom");
    });

    const opts = createOptions();
    await handler(opts);
    const [ok, payload, error] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(String(requireRecord(error).code)).toMatch(/unavailable/i);
  });
});

describe("models.authLogout", () => {
  beforeEach(() => {
    resetAuthStatusMocks();
  });

  it.each([
    { name: "omitted", agentId: undefined, expectedAgentId: "main" },
    { name: "empty", agentId: "", expectedAgentId: "main" },
    { name: "valid", agentId: "Writer", expectedAgentId: "writer" },
  ])("targets the $name agentId auth store", async ({ agentId, expectedAgentId }) => {
    const cfg = { agents: { list: [{ id: "main", default: true }, { id: "writer" }] } };
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    mocks.listAgentIds.mockReturnValue(["main", "writer"]);
    const opts = createLogoutOptions({
      provider: "openrouter",
      ...(agentId !== undefined ? { agentId } : {}),
    });

    await logoutHandler(opts);

    const expectedDir = expectedAgentId === "main" ? "/tmp/agent" : "/tmp/agent-writer";
    expect(mocks.resolveAgentDir).toHaveBeenCalledWith(cfg, expectedAgentId);
    expect(mocks.ensureAuthProfileStoreWithoutExternalProfiles).toHaveBeenCalledWith(expectedDir);
    expect(mocks.removeProviderAuthProfilesWithLock).toHaveBeenCalledWith({
      provider: "openrouter",
      agentDir: expectedDir,
    });
  });

  it("rejects an explicit unknown agentId without touching the default auth store", async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }, { id: "writer" }] } };
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    mocks.listAgentIds.mockReturnValue(["main", "writer"]);
    const opts = createLogoutOptions({ provider: "openrouter", agentId: "retired" });

    await logoutHandler(opts);

    expect(mocks.resolveAgentDir).not.toHaveBeenCalled();
    expect(mocks.ensureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    expect(mocks.removeProviderAuthProfilesWithLock).not.toHaveBeenCalled();
    expect(mocks.removeAuthProfilesWithLock).not.toHaveBeenCalled();
    const [ok, payload, error] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toEqual({
      code: "INVALID_REQUEST",
      message: 'unknown agent id "retired"',
      details: { code: "UNKNOWN_AGENT_ID", agentId: "retired" },
    });
  });

  it("removes provider auth profiles and invalidates the status cache", async () => {
    mocks.listProfilesForProvider.mockReturnValue(["openrouter:default"]);
    await handler(createOptions());
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(1);

    const opts = createLogoutOptions({ provider: "OpenRouter" });
    await logoutHandler(opts);

    expect(mocks.removeProviderAuthProfilesWithLock).toHaveBeenCalledWith({
      provider: "openrouter",
      agentDir: "/tmp/agent",
    });
    expect(mocks.refreshActiveProviderAuthRuntimeSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.clearCurrentProviderAuthState).toHaveBeenCalled();
    expect(mocks.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledWith({});
    const [ok, payload] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(true);
    expect((payload as ModelAuthLogoutResult).removedProfiles).toEqual(["openrouter:default"]);

    await handler(createOptions());
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(2);
  });

  it("removes only requested saved OAuth or token profiles", async () => {
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      version: 1,
      profiles: {
        "openrouter:oauth": {
          type: "oauth",
          provider: "openrouter",
          access: "access",
          refresh: "refresh",
          expires: 1_000_000,
        },
        "openrouter:api-key": {
          type: "api_key",
          provider: "openrouter",
          key: "key",
        },
      },
    });
    mocks.listProfilesForProvider.mockReturnValue(["openrouter:oauth", "openrouter:api-key"]);
    const opts = createLogoutOptions({
      provider: "openrouter",
      profileIds: ["openrouter:oauth"],
    });

    await logoutHandler(opts);

    expect(mocks.removeAuthProfilesWithLock).toHaveBeenCalledWith({
      profileIds: ["openrouter:oauth"],
      agentDir: "/tmp/agent",
    });
    expect(mocks.removeProviderAuthProfilesWithLock).not.toHaveBeenCalled();
    const [ok, payload] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(true);
    expect((payload as ModelAuthLogoutResult).removedProfiles).toEqual(["openrouter:oauth"]);
  });

  it("rejects targeted logout for config-bound token profiles", async () => {
    const profileId = "openrouter:token";
    mocks.getRuntimeConfig.mockReturnValue({
      models: {
        providers: {
          openrouter: Object.fromEntries([["apiKey", profileId]]),
        },
      },
    });
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      version: 1,
      profiles: {
        [profileId]: { type: "token", provider: "openrouter", token: "placeholder" },
      },
    });
    mocks.listProfilesForProvider.mockReturnValue([profileId]);
    const opts = createLogoutOptions({ provider: "openrouter", profileIds: [profileId] });

    await logoutHandler(opts);

    expect(mocks.removeAuthProfilesWithLock).not.toHaveBeenCalled();
    expect(mocks.removeProviderAuthProfilesWithLock).not.toHaveBeenCalled();
    const [ok, , error] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(false);
    expect(error?.message).toContain("config-bound auth profiles");
  });

  it("rejects unavailable or external targeted profiles without aborting runs", async () => {
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      version: 1,
      profiles: {
        "openrouter:saved": {
          type: "oauth",
          provider: "openrouter",
          access: "access",
          refresh: "refresh",
          expires: 1_000_000,
        },
      },
    });
    mocks.listProfilesForProvider.mockReturnValue(["openrouter:saved"]);
    const opts = createLogoutOptions({
      provider: "openrouter",
      profileIds: ["openrouter:external"],
    });
    const activeRun = createActiveRun("openrouter");
    opts.context.chatAbortControllers.set("run-openrouter", activeRun);

    await logoutHandler(opts);

    expect(mocks.removeAuthProfilesWithLock).not.toHaveBeenCalled();
    expect(mocks.removeProviderAuthProfilesWithLock).not.toHaveBeenCalled();
    expect(activeRun.controller.signal.aborted).toBe(false);
    const [ok, , error] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(false);
    expect(error?.message).toContain("unavailable auth profiles");
  });

  it("validates targeted profile ids", async () => {
    const opts = createLogoutOptions({ provider: "openrouter", profileIds: [] });

    await logoutHandler(opts);

    const [ok, , error] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(false);
    expect(error?.message).toContain("non-empty string array");
  });

  it("aborts active runs for the removed provider only", async () => {
    const opts = createLogoutOptions({ provider: "openrouter" });
    const openrouterRun = createActiveRun("openrouter");
    const openaiRun = createActiveRun("openai");
    opts.context.chatAbortControllers.set("run-openrouter", openrouterRun);
    opts.context.chatAbortControllers.set("run-openai", openaiRun);

    await logoutHandler(opts);

    expect(openrouterRun.controller.signal.aborted).toBe(true);
    expect(openaiRun.controller.signal.aborted).toBe(false);
    expect(opts.context.chatAbortControllers.has("run-openrouter")).toBe(false);
    expect(opts.context.chatAbortControllers.has("run-openai")).toBe(true);
    expect(opts.context.removeChatRun).toHaveBeenCalledWith(
      "run-openrouter",
      "run-openrouter",
      openrouterRun.sessionKey,
    );
    expect(opts.context.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: "run-openrouter",
        state: "aborted",
        stopReason: "auth-revoked",
      }),
      { sessionKeys: [openrouterRun.sessionKey] },
    );
    const [, payload] = firstRespondCall(opts) ?? [];
    expect((payload as ModelAuthLogoutResult).abortedRunIds).toEqual(["run-openrouter"]);
  });

  it("aborts provider runs only for the logged-out agent", async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }, { id: "writer" }] } };
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    mocks.listAgentIds.mockReturnValue(["main", "writer"]);
    const opts = createLogoutOptions({ provider: "openrouter", agentId: "writer" });
    const mainRun = createActiveRun("openrouter", undefined, "main");
    const writerRun = createActiveRun("openrouter", undefined, "writer");
    opts.context.chatAbortControllers.set("run-main", mainRun);
    opts.context.chatAbortControllers.set("run-writer", writerRun);

    await logoutHandler(opts);

    expect(mainRun.controller.signal.aborted).toBe(false);
    expect(writerRun.controller.signal.aborted).toBe(true);
    expect(opts.context.chatAbortControllers.has("run-main")).toBe(true);
    expect(opts.context.chatAbortControllers.has("run-writer")).toBe(false);
    const [, payload] = firstRespondCall(opts) ?? [];
    expect((payload as ModelAuthLogoutResult).abortedRunIds).toEqual(["run-writer"]);
  });

  it("aborts provider runs but preserves config SecretRef auth", async () => {
    const cfg = {
      models: {
        providers: {
          openrouter: {
            auth: "api-key",
            apiKey: {
              source: "env",
              provider: "default",
              id: "OPENROUTER_API_KEY",
            },
          },
        },
      },
    };
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    mocks.listProfilesForProvider.mockReturnValue([]);
    const opts = createLogoutOptions({ provider: "openrouter" });
    const activeRun = createActiveRun("openrouter");
    opts.context.chatAbortControllers.set("run-openrouter", activeRun);

    await logoutHandler(opts);

    expect(mocks.removeProviderAuthProfilesWithLock).toHaveBeenCalledWith({
      provider: "openrouter",
      agentDir: "/tmp/agent",
    });
    expect(cfg.models.providers.openrouter.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "OPENROUTER_API_KEY",
    });
    expect(activeRun.controller.signal.aborted).toBe(true);
    const [ok, payload] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(true);
    expect((payload as ModelAuthLogoutResult).removedProfiles).toEqual([]);
    expect((payload as ModelAuthLogoutResult).abortedRunIds).toEqual(["run-openrouter"]);
  });

  it("removes inherited main-store auth profiles", async () => {
    mocks.listProfilesForProvider.mockReturnValue(["openrouter:main"]);
    mocks.resolvePersistedAuthProfileOwnerAgentDir.mockReturnValue(undefined);
    const opts = createLogoutOptions({ provider: "openrouter" });

    await logoutHandler(opts);

    expect(mocks.removeProviderAuthProfilesWithLock).toHaveBeenCalledWith({
      provider: "openrouter",
      agentDir: "/tmp/agent",
    });
    expect(mocks.removeProviderAuthProfilesWithLock).toHaveBeenCalledWith({
      provider: "openrouter",
      agentDir: undefined,
    });
    const [ok] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(true);
  });

  it("cleans requester references when targeted auth is inherited", async () => {
    const profileId = "openrouter:main";
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "openrouter",
          access: "access",
          refresh: "refresh",
          expires: 1_000_000,
        },
      },
    });
    mocks.listProfilesForProvider.mockReturnValue([profileId]);
    mocks.resolvePersistedAuthProfileOwnerAgentDir.mockReturnValue(undefined);
    const opts = createLogoutOptions({ provider: "openrouter", profileIds: [profileId] });

    await logoutHandler(opts);

    expect(mocks.removeAuthProfilesWithLock).toHaveBeenCalledWith({
      profileIds: [profileId],
      agentDir: "/tmp/agent",
    });
    expect(mocks.removeAuthProfilesWithLock).toHaveBeenCalledWith({
      profileIds: [profileId],
      agentDir: undefined,
    });
    const [ok] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(true);
  });

  it("preserves active provider runs on a targeted logout", async () => {
    const profileId = "openrouter:saved";
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "openrouter",
          access: "access",
          refresh: "refresh",
          expires: 1_000_000,
        },
      },
    });
    mocks.listProfilesForProvider.mockReturnValue([profileId]);
    const opts = createLogoutOptions({ provider: "openrouter", profileIds: [profileId] });
    const activeRun = createActiveRun("openrouter");
    opts.context.chatAbortControllers.set("run-openrouter", activeRun);

    await logoutHandler(opts);

    // Targeted logout removes one credential but must not terminate runs that
    // may be using other preserved credentials for the same provider.
    expect(activeRun.controller.signal.aborted).toBe(false);
    const [ok, payload] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(true);
    expect((payload as ModelAuthLogoutResult).abortedRunIds).toEqual([]);
  });

  it("aborts active runs that share a provider auth alias", async () => {
    const opts = createLogoutOptions({ provider: "byteplus" });
    const aliasedRun = createActiveRun("byteplus-plan", "byteplus");
    opts.context.chatAbortControllers.set("run-byteplus-plan", aliasedRun);

    await logoutHandler(opts);

    expect(aliasedRun.controller.signal.aborted).toBe(true);
    const [, payload] = firstRespondCall(opts) ?? [];
    expect((payload as ModelAuthLogoutResult).abortedRunIds).toEqual(["run-byteplus-plan"]);
  });

  it("does not abort runs when auth profile removal fails", async () => {
    await expectLogoutFailureDoesNotAbortRun({
      arrangeFailure: () => {
        mocks.removeProviderAuthProfilesWithLock.mockResolvedValue(null);
      },
      message: "failed to remove saved auth profiles",
    });
  });

  it("does not abort runs when runtime auth snapshot refresh fails", async () => {
    await expectLogoutFailureDoesNotAbortRun({
      arrangeFailure: () => {
        mocks.refreshActiveProviderAuthRuntimeSnapshot.mockRejectedValue(
          new Error("refresh failed"),
        );
      },
      message: "refresh failed",
    });
  });

  it("rejects missing provider", async () => {
    const opts = createLogoutOptions();
    await logoutHandler(opts);
    const [ok, , error] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(false);
    expect(error?.message).toBe("provider is required");
  });
});

// Direct unit tests for aggregateRefreshableAuthStatus — this helper was introduced to
// prevent a specific regression (mixed OAuth+token rollup mis-reporting
// providers). Pinning its behavior here so refactors can't silently re-break
// the same bug.
describe("aggregateRefreshableAuthStatus", () => {
  const NOW = 1_000_000;
  const expiring = NOW + 60_000; // 1 min in future

  function oauth(status: "ok" | "expiring" | "expired" | "missing", expiresAt?: number) {
    return {
      profileId: `p-${status}`,
      provider: "openai",
      type: "oauth" as const,
      status,
      expiresAt,
      remainingMs: expiresAt !== undefined ? expiresAt - NOW : undefined,
      source: "store" as const,
      label: `p-${status}`,
    };
  }

  function token(status: "ok" | "expiring" | "expired" | "missing" | "static", expiresAt?: number) {
    return {
      profileId: `t-${status}`,
      provider: "openai",
      type: "token" as const,
      status,
      expiresAt,
      remainingMs: expiresAt !== undefined ? expiresAt - NOW : undefined,
      source: "store" as const,
      label: `t-${status}`,
    };
  }

  it("ignores token profiles — healthy OAuth + expired token stays ok", () => {
    const result = aggregateRefreshableAuthStatus(
      {
        provider: "openai",
        status: "expired",
        profiles: [oauth("ok", expiring + 10_000_000), token("expired")],
      },
      NOW,
    );
    expect(result.status).toBe("ok");
  });

  it("uses effective OAuth profiles while keeping stale inventory visible", () => {
    const healthy = oauth("ok", expiring + 10_000_000);
    const stale = oauth("expired", NOW - 1);
    const result = aggregateRefreshableAuthStatus(
      {
        provider: "openai",
        status: "ok",
        effectiveProfiles: [healthy],
        profiles: [stale, healthy],
      },
      NOW,
    );
    expect(result.status).toBe("ok");
    expect(result.expiresAt).toBe(healthy.expiresAt);
  });

  it("falls back to prov.status when no OAuth profiles exist", () => {
    const result = aggregateRefreshableAuthStatus(
      {
        provider: "anthropic",
        status: "static",
        profiles: [
          {
            profileId: "anthropic:default",
            provider: "anthropic",
            type: "api_key",
            status: "static",
            source: "store",
            label: "anthropic:default",
          },
        ],
      },
      NOW,
    );
    expect(result.status).toBe("static");
  });

  it("keeps missing distinct from expired", () => {
    const expiredResult = aggregateRefreshableAuthStatus(
      {
        provider: "openai",
        status: "expired",
        profiles: [oauth("expired", NOW - 1)],
      },
      NOW,
    );
    expect(expiredResult.status).toBe("expired");

    const missingResult = aggregateRefreshableAuthStatus(
      {
        provider: "openai",
        status: "missing",
        profiles: [oauth("missing")],
      },
      NOW,
    );
    expect(missingResult.status).toBe("missing");
  });

  it("precedence: expired/missing > expiring > ok > static", () => {
    // expiring + ok → expiring (expired-marker absent)
    const res1 = aggregateRefreshableAuthStatus(
      {
        provider: "openai",
        status: "expiring",
        profiles: [oauth("expiring", expiring), oauth("ok", expiring + 10_000_000)],
      },
      NOW,
    );
    expect(res1.status).toBe("expiring");

    // expired beats expiring
    const res2 = aggregateRefreshableAuthStatus(
      {
        provider: "openai",
        status: "expired",
        profiles: [oauth("expired", NOW - 1), oauth("expiring", expiring)],
      },
      NOW,
    );
    expect(res2.status).toBe("expired");
  });

  it("picks the earliest expiresAt across OAuth profiles", () => {
    const earlier = NOW + 1_000;
    const later = NOW + 99_999;
    const result = aggregateRefreshableAuthStatus(
      {
        provider: "openai",
        status: "ok",
        profiles: [oauth("ok", later), oauth("ok", earlier)],
      },
      NOW,
    );
    expect(result.expiresAt).toBe(earlier);
    expect(result.remainingMs).toBe(1_000);
  });

  it.each([
    ["ok", undefined],
    ["expiring", expiring],
    ["expired", NOW - 1],
    ["missing", undefined],
    ["static", undefined],
  ] as const)(
    "uses token status %s when no effective OAuth profile exists",
    (status, expiresAt) => {
      const result = aggregateRefreshableAuthStatus(
        {
          provider: "claude-cli",
          status,
          profiles: [token(status, expiresAt)],
        },
        NOW,
        true,
      );
      expect(result).toEqual({
        status,
        ...(expiresAt === undefined ? {} : { expiresAt, remainingMs: expiresAt - NOW }),
      });
    },
  );

  it("keeps an empty effective profile selection missing", () => {
    const result = aggregateRefreshableAuthStatus(
      {
        provider: "claude-cli",
        status: "missing",
        effectiveProfiles: [],
        profiles: [token("ok")],
      },
      NOW,
      true,
    );
    expect(result).toEqual({ status: "missing" });
  });

  it("ignores out-of-range OAuth expiry timestamps", () => {
    const valid = NOW + 5_000;
    const result = aggregateRefreshableAuthStatus(
      {
        provider: "openai-codex",
        status: "ok",
        profiles: [oauth("ok", MAX_DATE_TIMESTAMP_MS + 1), oauth("ok", valid)],
      },
      NOW,
    );
    expect(result.expiresAt).toBe(valid);
    expect(result.remainingMs).toBe(5_000);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

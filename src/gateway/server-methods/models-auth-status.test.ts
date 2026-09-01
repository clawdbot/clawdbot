// Model auth status tests cover profile health summaries, provider usage,
// credential cleanup, secret refresh, and provider run abort side effects.

import { expectDefined } from "@openclaw/normalization-core";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthHealthSummary } from "../../agents/auth-health.js";
import {
  replaceRuntimeAuthProfileStoreSnapshots,
  type AuthProfileStore,
} from "../../agents/auth-profiles.js";
import { NON_ENV_SECRETREF_MARKER } from "../../agents/model-auth-markers.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { UsageSummary } from "../../infra/provider-usage.types.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../plugins/installed-plugin-index-policy.js";
import { resolveProviderAuthLookupMaps } from "../../secrets/provider-env-vars.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createChatRunState } from "../server-chat-state.js";
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
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn((agentDir?: string): AuthProfileStore => {
    void agentDir;
    return { version: 1, profiles: {} };
  }),
  listProfilesForProvider: vi.fn((): string[] => []),
  removeAuthProfilesAcrossOwnerStores: vi.fn(async (): Promise<boolean> => true),
  removeProviderAuthProfilesWithLock: vi.fn(
    async (): Promise<AuthProfileStore | null> => ({ version: 1, profiles: {} }),
  ),
  resolvePersistedAuthProfileOwnerAgentDir: vi.fn(
    (params: { agentDir?: string }) => params.agentDir,
  ),
  refreshActiveProviderAuthRuntimeSnapshot: vi.fn(async () => false),
  clearCurrentProviderAuthState: vi.fn(),
  warmCurrentProviderAuthStateOffMainThread: vi.fn(async (_cfg: unknown) => {}),
  loadDeferredCatalog: vi.fn(),
  readPreparedCatalog: vi.fn(),
  buildAuthHealthSummary: vi.fn<BuildAuthHealthSummary>(
    (): AuthHealthSummary => ({ now: 0, warnAfterMs: 0, profiles: [], providers: [] }),
  ),
  loadProviderUsageSummary: vi.fn(async (): Promise<UsageSummary> => emptyUsageSummary()),
  listProviderUsagePluginDescriptors: vi.fn(() => [
    { provider: "anthropic", displayName: "Claude" },
    { provider: "deepseek", displayName: "DeepSeek" },
    { provider: "openai", displayName: "OpenAI" },
  ]),
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
    ensureAuthProfileStoreWithoutExternalProfiles:
      mocks.ensureAuthProfileStoreWithoutExternalProfiles,
    listProfilesForProvider: mocks.listProfilesForProvider,
    removeAuthProfilesAcrossOwnerStores: mocks.removeAuthProfilesAcrossOwnerStores,
    removeProviderAuthProfilesWithLock: mocks.removeProviderAuthProfilesWithLock,
    resolvePersistedAuthProfileOwnerAgentDir: mocks.resolvePersistedAuthProfileOwnerAgentDir,
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

vi.mock("../../plugins/provider-runtime.js", () => ({
  listProviderUsagePluginDescriptors: mocks.listProviderUsagePluginDescriptors,
}));

vi.mock("../../secrets/runtime.js", () => ({
  refreshActiveProviderAuthRuntimeSnapshot: mocks.refreshActiveProviderAuthRuntimeSnapshot,
}));

vi.mock("../../agents/model-provider-auth.js", () => ({
  clearCurrentProviderAuthState: mocks.clearCurrentProviderAuthState,
  warmCurrentProviderAuthStateOffMainThread: mocks.warmCurrentProviderAuthStateOffMainThread,
}));

vi.mock("../server-model-catalog-auth.js", () => ({
  loadDeferredCatalog: mocks.loadDeferredCatalog,
  readPreparedCatalog: mocks.readPreparedCatalog,
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
    chatRunState: createChatRunState(),
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

const requireRecord = createRequireRecord("record", "expected-non-array-record");
let preparedAuthStore: AuthProfileStore = { version: 1, profiles: {} };
let preparedMetadataSnapshot: unknown;

function setPreparedAuthStore(store: AuthProfileStore): void {
  preparedAuthStore = store;
  replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: "/tmp/agent", store }]);
}

function setPreparedMetadataSnapshot(snapshot: unknown): void {
  preparedMetadataSnapshot = snapshot;
}

function createPreparedOwnerSnapshot(agentId: string) {
  const config = mocks.getRuntimeConfig.mock.results.at(-1)?.value ?? {};
  const agentDir =
    mocks.resolveAgentDir.mock.results.at(-1)?.value ??
    (agentId === "main" ? "/tmp/agent" : `/tmp/agent-${agentId}`);
  return {
    agentId,
    agentDir,
    workspaceDir: "/tmp/workspace",
    config,
    entries: [],
    routeVariants: [],
    authModes: {},
    authStore: preparedAuthStore,
    authMaterializations: [],
    metadataSnapshot: preparedMetadataSnapshot as never,
  };
}

function firstRespondCall(
  opts: GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> },
) {
  return opts.respond.mock.calls[0];
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

async function readAuthStatus(params: Record<string, unknown> = {}) {
  const opts = createOptions(params);
  await handler(opts);
  const [ok, payload, error] = firstRespondCall(opts) ?? [];
  expect(ok, JSON.stringify(error)).toBe(true);
  return payload as ModelAuthStatusResult;
}

function resetAuthStatusMocks(): void {
  for (const envVarNames of Object.values(
    resolveProviderAuthLookupMaps({ env: {} }).envCandidateMap,
  )) {
    for (const envVarName of envVarNames) {
      vi.stubEnv(envVarName, "");
    }
  }
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.clearAllMocks();
  invalidateModelAuthStatusCache();
  mocks.getRuntimeConfig.mockReturnValue({});
  mocks.listAgentIds.mockReturnValue(["main"]);
  mocks.resolveAgentDir.mockImplementation((_cfg: unknown, agentId: string) =>
    agentId === "main" ? "/tmp/agent" : `/tmp/agent-${agentId}`,
  );
  mocks.resolveDefaultAgentId.mockReturnValue("main");
  setPreparedAuthStore({ version: 1, profiles: {} });
  setPreparedMetadataSnapshot({
    index: { plugins: [] },
    manifestRegistry: { plugins: [] },
    plugins: [],
  });
  mocks.readPreparedCatalog.mockImplementation(async (_context, agentId: string) =>
    createPreparedOwnerSnapshot(agentId),
  );
  mocks.loadDeferredCatalog.mockImplementation(async (_context, agentId: string) =>
    createPreparedOwnerSnapshot(agentId),
  );
  mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
    version: 1,
    profiles: {},
  });
  mocks.listProfilesForProvider.mockReturnValue([]);
  mocks.removeAuthProfilesAcrossOwnerStores.mockResolvedValue(true);
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

function firstDeferredAuthScope() {
  expect(mocks.loadDeferredCatalog).toHaveBeenCalledTimes(1);
  const [, agentId, options] = mocks.loadDeferredCatalog.mock.calls[0] ?? [];
  expect(agentId).toBe("main");
  const deferredOptions = requireRecord(options);
  expect(deferredOptions.readOnly).toBe(true);
  expect(deferredOptions.refreshAuth).toBe(true);
  return requireRecord(deferredOptions.authScope);
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
});

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
      const cfg = {
        agents: {
          defaults: { systemAgent: { agentId: "main" } },
          list: [{ id: "main" }, { id: "writer" }],
        },
      };
      mocks.getRuntimeConfig.mockReturnValue(cfg);
      mocks.listAgentIds.mockReturnValue(["main", "writer"]);

      const opts = createOptions(params);
      await handler(opts);

      expect(mocks.resolveAgentDir).toHaveBeenCalledWith(cfg, expectedAgentId);
      expect(mocks.readPreparedCatalog).toHaveBeenCalledWith(expect.anything(), expectedAgentId);
    },
  );

  it("rejects an explicit unknown agentId before reading auth state", async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }, { id: "writer" }] } };
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    mocks.listAgentIds.mockReturnValue(["main", "writer"]);
    const opts = createOptions({ agentId: "retired", refresh: true });

    await handler(opts);

    expect(mocks.resolveAgentDir).not.toHaveBeenCalled();
    expect(mocks.readPreparedCatalog).not.toHaveBeenCalled();
    expect(mocks.loadDeferredCatalog).not.toHaveBeenCalled();
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
    expect(mocks.readPreparedCatalog).toHaveBeenCalledWith(expect.anything(), "_writer");
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
      expect(mocks.readPreparedCatalog).not.toHaveBeenCalled();
      expect(firstRespondCall(opts)?.[2]).toEqual({
        code: "INVALID_REQUEST",
        message: `unknown agent id "${agentId}"`,
        details: { code: "UNKNOWN_AGENT_ID", agentId },
      });
    },
  );

  it("reads the published auth owner for each requested agent", async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }, { id: "writer" }] } };
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    mocks.listAgentIds.mockReturnValue(["main", "writer"]);

    await handler(createOptions({ agentId: "main" }));
    await handler(createOptions({ agentId: "writer" }));
    const freshMain = createOptions({ agentId: "main" });
    await handler(freshMain);

    expect(mocks.readPreparedCatalog).toHaveBeenNthCalledWith(1, expect.anything(), "main");
    expect(mocks.readPreparedCatalog).toHaveBeenNthCalledWith(2, expect.anything(), "writer");
    expect(mocks.readPreparedCatalog).toHaveBeenNthCalledWith(3, expect.anything(), "main");
    expect(mocks.readPreparedCatalog).toHaveBeenCalledTimes(3);
    expect(mocks.loadDeferredCatalog).not.toHaveBeenCalled();
    expect(firstRespondCall(freshMain)?.[3]).toBeUndefined();
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
    expect(mocks.readPreparedCatalog).not.toHaveBeenCalled();
    expect(mocks.loadDeferredCatalog).toHaveBeenCalledOnce();
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: after }),
    );
  });

  it("does not wait for full catalog discovery during auth status refresh", async () => {
    let releaseDiscovery!: () => void;
    const discovery = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    mocks.loadDeferredCatalog.mockImplementation(async (_context, agentId, options) => {
      const deferredOptions = requireRecord(options);
      if (deferredOptions.refreshFullCatalog !== false) {
        await discovery;
      }
      return createPreparedOwnerSnapshot(agentId);
    });

    const request = handler(createOptions({ refresh: true }));
    try {
      await expect(
        Promise.race([
          Promise.resolve(request).then(() => "replied" as const),
          new Promise<"timed-out">((resolve) => {
            setTimeout(() => resolve("timed-out"), 25);
          }),
        ]),
      ).resolves.toBe("replied");
    } finally {
      releaseDiscovery();
    }
    await request;
  });

  it("reports an unavailable prepared owner without failing the RPC or discovering credentials", async () => {
    mocks.readPreparedCatalog.mockResolvedValueOnce(undefined);

    const unavailable = await readAuthStatus();

    expect(unavailable).toEqual({
      ts: expect.any(Number),
      providers: [],
      unavailable: {
        code: "PREPARED_MODEL_AUTH_UNAVAILABLE",
        message: expect.stringContaining("Refresh Models"),
      },
    });
    expect(mocks.loadDeferredCatalog).not.toHaveBeenCalled();
    expect(mocks.ensureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    expect(mocks.buildAuthHealthSummary).not.toHaveBeenCalled();
    expect(mocks.loadProviderUsageSummary).not.toHaveBeenCalled();

    const recovered = await readAuthStatus();
    expect(recovered).not.toHaveProperty("unavailable");
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledOnce();
  });

  it("returns a serialisable snapshot on first call", async () => {
    setPreparedAuthStore({
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

  it("projects provider capabilities from the published lifecycle metadata", async () => {
    const plugins = [
      {
        id: "provider-auth",
        origin: "bundled",
        providerAuthAliases: { "openai-legacy": "openai" },
        providerAuthChoices: [
          {
            provider: "openai-legacy",
            method: "api-key",
            choiceId: "openai-api-key",
            choiceLabel: "OpenAI API key",
            appGuidedSecret: true,
          },
          {
            provider: "openai",
            method: "oauth",
            choiceId: "openai-oauth",
            choiceLabel: "OpenAI OAuth",
          },
          {
            provider: "github-copilot",
            method: "oauth",
            choiceId: "github-copilot-oauth",
            choiceLabel: "GitHub Copilot OAuth",
          },
        ],
      },
    ];
    setPreparedMetadataSnapshot({
      index: { plugins: [] },
      manifestRegistry: { plugins },
      plugins,
    });

    const result = await readAuthStatus();

    expect(result.providerCapabilities).toEqual([
      { provider: "github-copilot", apiKeySupported: false, quickApiKeySetup: false },
      { provider: "openai", apiKeySupported: true, quickApiKeySetup: true },
    ]);
  });

  it("uses the published metadata owner for provider env auth and aliases", async () => {
    const cfg = {};
    const policyHash = resolveInstalledPluginIndexPolicyHash(cfg);
    const plugins = [
      {
        id: "prepared-auth",
        origin: "bundled",
        setup: {
          providers: [{ id: "prepared-owner", envVars: ["PREPARED_OWNER_API_KEY"] }],
        },
        providerAuthAliases: { "prepared-owner-alias": "prepared-owner" },
      },
    ];
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    setPreparedMetadataSnapshot({
      policyHash,
      index: {
        version: 1,
        hostContractVersion: "test",
        compatRegistryVersion: "test",
        migrationVersion: 1,
        policyHash,
        generatedAtMs: 1,
        installRecords: {},
        plugins: [],
        diagnostics: [],
      },
      manifestRegistry: { plugins },
      plugins,
    });
    vi.stubEnv("PREPARED_OWNER_API_KEY", "prepared-owner-secret");

    await handler(createOptions());

    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.arrayContaining(["prepared-owner", "prepared-owner-alias"]),
      }),
    );
  });

  it("does not offer logout for runtime external CLI profiles", async () => {
    const health = createOpenAiCodexOauthHealthSummary();
    setPreparedAuthStore({
      version: 1,
      profiles: {},
      runtimeExternalProfileIds: ["openai:default"],
    });
    mocks.buildAuthHealthSummary.mockReturnValue(health);

    const provider = await firstAuthStatusProvider();

    expect(provider?.profiles[0]?.logoutSupported).toBeUndefined();
  });

  it("reports external CLI-managed OAuth as signed in across access-token expiry", async () => {
    const profileId = "anthropic:claude-cli";
    const profile = {
      profileId,
      provider: "claude-cli",
      type: "oauth",
      status: "expired",
      expiresAt: 1,
      remainingMs: -1,
      source: "store",
      label: profileId,
    } satisfies AuthHealthSummary["profiles"][number];
    setPreparedAuthStore(
      Object.assign(
        {
          version: 1,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "claude-cli",
              access: "expired-access",
              refresh: "cli-owned-refresh",
              expires: 1,
            } satisfies AuthProfileStore["profiles"][string],
          },
        },
        { runtimeExternalCliProfileIds: [profileId] },
      ),
    );
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 2,
      warnAfterMs: 0,
      profiles: [profile],
      providers: [
        {
          provider: "claude-cli",
          status: "expired",
          expiresAt: 1,
          remainingMs: -1,
          profiles: [profile],
        },
      ],
    });

    const provider = await firstAuthStatusProvider();

    expect(provider).toMatchObject({
      provider: "claude-cli",
      status: "ok",
      profiles: [{ profileId, status: "expired" }],
    });
    expect(provider?.expiry).toBeUndefined();
  });

  it("keeps an unrelated effective token expiry visible beside owned CLI OAuth", async () => {
    const profileId = "anthropic:claude-cli";
    const ownedProfile = {
      profileId,
      provider: "claude-cli",
      type: "oauth",
      status: "expired",
      expiresAt: 1,
      remainingMs: -1,
      source: "store",
      label: profileId,
    } satisfies AuthHealthSummary["profiles"][number];
    const manualToken = {
      profileId: "anthropic:manual-token",
      provider: "claude-cli",
      type: "token",
      status: "expired",
      expiresAt: 1,
      remainingMs: -1,
      source: "store",
      label: "anthropic:manual-token",
    } satisfies AuthHealthSummary["profiles"][number];
    setPreparedAuthStore(
      Object.assign(
        {
          version: 1,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "claude-cli",
              access: "expired-access",
              refresh: "cli-owned-refresh",
              expires: 1,
            } satisfies AuthProfileStore["profiles"][string],
          },
        },
        { runtimeExternalCliProfileIds: [profileId] },
      ),
    );
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 2,
      warnAfterMs: 0,
      profiles: [ownedProfile, manualToken],
      providers: [
        {
          provider: "claude-cli",
          status: "expired",
          expiresAt: 1,
          remainingMs: -1,
          profiles: [ownedProfile, manualToken],
        },
      ],
    });

    const provider = await firstAuthStatusProvider();

    expect(provider).toMatchObject({ provider: "claude-cli", status: "expired" });
  });

  it("keeps persisted MiniMax CLI OAuth expiry visible", async () => {
    const profileId = "minimax-portal:minimax-cli";
    const profile = {
      profileId,
      provider: "minimax-portal",
      type: "oauth",
      status: "expired",
      expiresAt: 1,
      remainingMs: -1,
      source: "store",
      label: profileId,
    } satisfies AuthHealthSummary["profiles"][number];
    setPreparedAuthStore({
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "minimax-portal",
          access: "expired-access",
          refresh: "persisted-refresh",
          expires: 1,
        },
      },
    });
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 2,
      warnAfterMs: 0,
      profiles: [profile],
      providers: [
        {
          provider: "minimax-portal",
          status: "expired",
          expiresAt: 1,
          remainingMs: -1,
          profiles: [profile],
        },
      ],
    });

    const provider = await firstAuthStatusProvider();

    expect(provider).toMatchObject({ provider: "minimax-portal", status: "expired" });
  });

  it("keeps a missing Anthropic row when its model route has independent auth config", async () => {
    const profileId = "anthropic:claude-cli";
    mocks.getRuntimeConfig.mockReturnValue({
      auth: { profiles: { [profileId]: { provider: "anthropic", mode: "token" } } },
      models: { providers: { anthropic: { auth: "oauth" } } },
    });
    const profile = {
      profileId,
      provider: "claude-cli",
      type: "oauth",
      status: "expired",
      expiresAt: 1,
      remainingMs: -1,
      source: "store",
      label: profileId,
    } satisfies AuthHealthSummary["profiles"][number];
    setPreparedAuthStore(
      Object.assign(
        {
          version: 1,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "claude-cli",
              access: "expired-access",
              refresh: "cli-owned-refresh",
              expires: 1,
            } satisfies AuthProfileStore["profiles"][string],
          },
        },
        { runtimeExternalCliProfileIds: [profileId] },
      ),
    );
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 2,
      warnAfterMs: 0,
      profiles: [profile],
      providers: [
        { provider: "anthropic", status: "missing", profiles: [] },
        {
          provider: "claude-cli",
          status: "expired",
          expiresAt: 1,
          remainingMs: -1,
          profiles: [profile],
        },
      ],
    });

    const result = await readAuthStatus();

    expect(result.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "anthropic", status: "missing" }),
      ]),
    );
  });

  it("keeps a missing Anthropic row when another Anthropic auth profile is configured", async () => {
    const profileId = "anthropic:claude-cli";
    mocks.getRuntimeConfig.mockReturnValue({
      auth: {
        profiles: {
          [profileId]: { provider: "anthropic", mode: "token" },
          "anthropic:manual": { provider: "anthropic", mode: "oauth" },
        },
      },
    });
    const profile = {
      profileId,
      provider: "claude-cli",
      type: "oauth",
      status: "expired",
      expiresAt: 1,
      remainingMs: -1,
      source: "store",
      label: profileId,
    } satisfies AuthHealthSummary["profiles"][number];
    setPreparedAuthStore(
      Object.assign(
        {
          version: 1,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "claude-cli",
              access: "expired-access",
              refresh: "cli-owned-refresh",
              expires: 1,
            } satisfies AuthProfileStore["profiles"][string],
          },
        },
        { runtimeExternalCliProfileIds: [profileId] },
      ),
    );
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 2,
      warnAfterMs: 0,
      profiles: [profile],
      providers: [
        { provider: "anthropic", status: "missing", profiles: [] },
        {
          provider: "claude-cli",
          status: "expired",
          expiresAt: 1,
          remainingMs: -1,
          profiles: [profile],
        },
      ],
    });

    const result = await readAuthStatus();

    expect(result.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "anthropic", status: "missing" }),
      ]),
    );
  });

  it("preserves expiry when an effective OAuth sibling is not CLI-owned", async () => {
    const cliProfileId = "anthropic:claude-cli";
    const manualProfileId = "anthropic:manual";
    const profiles = [cliProfileId, manualProfileId].map(
      (profileId) =>
        ({
          profileId,
          provider: "claude-cli",
          type: "oauth",
          status: "expired",
          expiresAt: 1,
          remainingMs: -1,
          source: "store",
          label: profileId,
        }) satisfies AuthHealthSummary["profiles"][number],
    );
    setPreparedAuthStore(
      Object.assign(
        {
          version: 1,
          profiles: Object.fromEntries(
            profiles.map((profile) => [
              profile.profileId,
              {
                type: "oauth",
                provider: "claude-cli",
                access: "expired-access",
                refresh: "stored-refresh",
                expires: 1,
              } satisfies AuthProfileStore["profiles"][string],
            ]),
          ),
        },
        { runtimeExternalCliProfileIds: [cliProfileId] },
      ),
    );
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 2,
      warnAfterMs: 0,
      profiles,
      providers: [
        {
          provider: "claude-cli",
          status: "expired",
          expiresAt: 1,
          remainingMs: -1,
          profiles,
        },
      ],
    });

    const provider = await firstAuthStatusProvider();

    expect(provider).toMatchObject({ provider: "claude-cli", status: "expired" });
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
    setPreparedAuthStore({
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

  it("reports runtime-resolved non-env SecretRefs as presence-only config auth", async () => {
    const sourceProvider: ModelProviderConfig = {
      baseUrl: "https://example.test/v1",
      models: [],
      apiKey: { source: "file", provider: "mounted-json", id: "model-provider-key" },
    };
    const runtimeProvider: ModelProviderConfig = {
      baseUrl: sourceProvider.baseUrl,
      models: sourceProvider.models,
      apiKey: "runtime-secret-value",
    };
    const sourceConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: sourceProvider,
        },
      },
    };
    const runtimeConfig: OpenClawConfig = { models: { providers: { openai: runtimeProvider } } };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    mocks.getRuntimeConfig.mockReturnValue(runtimeConfig);
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
    setPreparedAuthStore({
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

  it("keeps auth health fresh while usage caching stays auxiliary", async () => {
    const opts1 = createOptions();
    await handler(opts1);
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(1);

    const opts2 = createOptions();
    await handler(opts2);

    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(2);
    expect(opts2.respond.mock.calls.at(-1)?.[3]).toBeUndefined();
  });

  it("bypasses cache when params.refresh is set", async () => {
    await handler(createOptions());
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(1);
    mocks.clearCurrentProviderAuthState.mockClear();

    await handler(createOptions({ refresh: true }));
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(2);
    expect(mocks.refreshActiveProviderAuthRuntimeSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.loadDeferredCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.clearCurrentProviderAuthState).not.toHaveBeenCalled();
  });

  it("refreshes the transient owner after secrets runtime refresh", async () => {
    mocks.refreshActiveProviderAuthRuntimeSnapshot.mockResolvedValueOnce(true);

    await handler(createOptions({ refresh: true }));

    expect(mocks.refreshActiveProviderAuthRuntimeSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.loadDeferredCatalog).toHaveBeenCalledTimes(1);
  });

  it("keeps last-good secrets runtime snapshots when explicit refresh fails", async () => {
    mocks.refreshActiveProviderAuthRuntimeSnapshot.mockRejectedValueOnce(
      new Error("refresh failed"),
    );

    await handler(createOptions({ refresh: true }));

    expect(mocks.refreshActiveProviderAuthRuntimeSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.loadDeferredCatalog).toHaveBeenCalledTimes(1);
  });

  it("invalidateModelAuthStatusCache() preserves fresh auth reads", async () => {
    await handler(createOptions());
    invalidateModelAuthStatusCache();
    await handler(createOptions());
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(2);
  });

  it("does not publish usage captured before a concurrent logout", async () => {
    let releaseUsage: (() => void) | undefined;
    let usageFinished = false;
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
      usageFinished = true;
      return {
        updatedAt: 0,
        providers: [
          {
            provider: "openrouter",
            displayName: "OpenRouter",
            windows: [{ label: "day", usedPercent: 99 }],
          },
        ],
      };
    });

    const first = await readAuthStatus();
    expect(first.providers[0]?.usage).toBeUndefined();
    await waitForFast(() => expect(mocks.loadProviderUsageSummary).toHaveBeenCalledOnce());
    await logoutHandler(createLogoutOptions({ provider: "openrouter" }));
    releaseUsage?.();
    await waitForFast(() => expect(usageFinished).toBe(true));

    const afterLogout = await readAuthStatus();
    expect(afterLogout.providers[0]?.usage).toBeUndefined();
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
    const runtimeConfig = {};
    mocks.getRuntimeConfig.mockReturnValue(runtimeConfig);
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

    const first = await readAuthStatus();
    expect(first.providers[0]?.usage).toBeUndefined();

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith({
      providers: ["anthropic"],
      agentDir: "/tmp/agent",
      authStore: preparedAuthStore,
      config: runtimeConfig,
      timeoutMs: 5_000,
    });
    let result: ModelAuthStatusResult | undefined;
    await waitForFast(async () => {
      result = await readAuthStatus();
      expect(result.providers[0]?.usage).toBeDefined();
    });
    const refreshed = expectDefined(result, "refreshed auth status");
    expect(refreshed.providers[0]?.displayName).toBe("Claude");
    expect(refreshed.providers[0]?.usage).toEqual({
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

    const first = await readAuthStatus();
    expect(first.providers[0]?.usage).toBeUndefined();

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith({
      providers: ["deepseek"],
      agentDir: "/tmp/agent",
      authStore: preparedAuthStore,
      config: expect.any(Object),
      timeoutMs: 5_000,
    });
    let result: ModelAuthStatusResult | undefined;
    await waitForFast(async () => {
      result = await readAuthStatus();
      expect(result.providers[0]?.usage).toBeDefined();
    });
    const refreshed = expectDefined(result, "refreshed auth status");
    expect(refreshed.providers[0]?.usage).toEqual({
      providerId: "deepseek",
      windows: [],
      summary: "Balance ¥42.50",
    });
  });

  it("serves stale usage immediately while one background refresh replaces it", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const profile = {
      profileId: "openai:default",
      provider: "openai",
      type: "oauth",
      status: "ok",
      source: "store",
      label: "openai:default",
    } satisfies AuthHealthSummary["profiles"][number];
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: [profile],
      providers: [{ provider: "openai", status: "ok", profiles: [profile] }],
    });
    mocks.loadProviderUsageSummary.mockResolvedValueOnce({
      updatedAt: 1_000,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 10 }],
        },
      ],
    });

    await readAuthStatus();
    await waitForFast(async () => {
      const warmed = await readAuthStatus();
      expect(warmed.providers[0]?.usage?.windows[0]?.usedPercent).toBe(10);
    });

    let releaseRefresh: (() => void) | undefined;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    now.mockReturnValue(61_000);
    mocks.loadProviderUsageSummary.mockImplementationOnce(async () => {
      await refreshBlocked;
      return {
        updatedAt: 61_000,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            windows: [{ label: "5h", usedPercent: 20 }],
          },
        ],
      };
    });

    const stale = await readAuthStatus();
    expect(stale.providers[0]?.usage?.windows[0]?.usedPercent).toBe(10);
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);

    releaseRefresh?.();
    await waitForFast(async () => {
      const refreshed = await readAuthStatus();
      expect(refreshed.providers[0]?.usage?.windows[0]?.usedPercent).toBe(20);
    });
    now.mockRestore();
  });

  it("keeps same-account stale usage visible during an explicit refresh", async () => {
    mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());
    mocks.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: 0,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 10 }],
        },
      ],
    });

    await readAuthStatus();
    await waitForFast(async () => {
      const warmed = await readAuthStatus();
      expect(warmed.providers[0]?.usage?.windows[0]?.usedPercent).toBe(10);
    });

    let releaseRefresh: (() => void) | undefined;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    mocks.loadProviderUsageSummary.mockImplementationOnce(async () => {
      await refreshBlocked;
      return emptyUsageSummary();
    });

    const refreshing = await readAuthStatus({ refresh: true });
    expect(refreshing.providers[0]?.usage?.windows[0]?.usedPercent).toBe(10);
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
    releaseRefresh?.();
  });

  it("does not reuse usage after the same agent moves to another agent directory", async () => {
    mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());
    mocks.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: 0,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 10 }],
        },
      ],
    });

    await readAuthStatus();
    await waitForFast(async () => {
      const warmed = await readAuthStatus();
      expect(warmed.providers[0]?.usage?.windows[0]?.usedPercent).toBe(10);
    });

    mocks.resolveAgentDir.mockReturnValue("/tmp/rebound-agent");
    const rebound = await readAuthStatus();
    expect(rebound.providers[0]?.usage).toBeUndefined();
    expect(mocks.loadProviderUsageSummary).toHaveBeenLastCalledWith({
      providers: ["openai"],
      agentDir: "/tmp/rebound-agent",
      authStore: preparedAuthStore,
      config: expect.any(Object),
      timeoutMs: 5_000,
    });
  });

  it("does not reuse usage after credentials rotate within the same provider", async () => {
    mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());
    setPreparedAuthStore({
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "first-access",
          refresh: "first-refresh",
          expires: 1_000_000,
        },
      },
    });
    mocks.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: 0,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 10 }],
        },
      ],
    });

    await readAuthStatus();
    await waitForFast(async () => {
      const warmed = await readAuthStatus();
      expect(warmed.providers[0]?.usage?.windows[0]?.usedPercent).toBe(10);
    });

    const rotatedStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "second-access",
          refresh: "second-refresh",
          expires: 1_000_000,
        },
      },
    };
    // Prepared catalog refresh can replace its owner before the ambient snapshot revision advances.
    preparedAuthStore = rotatedStore;
    const rotated = await readAuthStatus();
    expect(mocks.buildAuthHealthSummary.mock.calls.at(-1)?.[0].store).toBe(rotatedStore);
    expect(rotated.providers[0]?.usage).toBeUndefined();
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
    expect(mocks.loadProviderUsageSummary).toHaveBeenLastCalledWith(
      expect.objectContaining({ authStore: rotatedStore }),
    );
  });

  it("does not reuse usage after a direct provider key rotates", async () => {
    let cfg = {
      models: { providers: { deepseek: { apiKey: "first-direct-value" } } },
    };
    mocks.getRuntimeConfig.mockReturnValue(cfg);
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
          summary: "Balance 10",
        },
      ],
    });

    await readAuthStatus();
    await waitForFast(async () => {
      const warmed = await readAuthStatus();
      expect(warmed.providers[0]?.usage?.summary).toBe("Balance 10");
    });

    cfg = {
      models: { providers: { deepseek: { apiKey: "second-direct-value" } } },
    };
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    const rotated = await readAuthStatus();
    expect(rotated.providers[0]?.usage).toBeUndefined();
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
  });

  it("does not reuse usage after profile selection state switches accounts", async () => {
    mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());
    const profiles = {
      "openai:first": {
        type: "oauth" as const,
        provider: "openai",
        access: "first-access",
        refresh: "first-refresh",
        expires: 1_000_000,
      },
      "openai:second": {
        type: "oauth" as const,
        provider: "openai",
        access: "second-access",
        refresh: "second-refresh",
        expires: 1_000_000,
      },
    };
    setPreparedAuthStore({
      version: 1,
      profiles,
      lastGood: { openai: "openai:first" },
    });
    mocks.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: 0,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 10 }],
        },
      ],
    });

    await readAuthStatus();
    await waitForFast(async () => {
      const warmed = await readAuthStatus();
      expect(warmed.providers[0]?.usage?.windows[0]?.usedPercent).toBe(10);
    });

    setPreparedAuthStore({
      version: 1,
      profiles,
      lastGood: { openai: "openai:second" },
    });
    const switched = await readAuthStatus();
    expect(switched.providers[0]?.usage).toBeUndefined();
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
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

    await handler(createOptions({ refresh: true }));

    const authScope = firstDeferredAuthScope();
    expect(authScope.providerIds).toContain("opencode-go");
    expect(authScope.providerIds).not.toContain("claude-cli");
    expect(authScope.profileIds).toEqual(["opencode-go:default"]);
  });

  it("disables external CLI auth overlays when config has no provider signal", async () => {
    await handler(createOptions({ refresh: true }));

    const authScope = firstDeferredAuthScope();
    expect(authScope).toEqual({ providerIds: [] });
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
    expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
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

    expect(mocks.removeAuthProfilesAcrossOwnerStores).toHaveBeenCalledWith({
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

    expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
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

    expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
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

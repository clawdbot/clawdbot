import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import chutesPlugin from "../extensions/chutes/index.js";
import { buildOpenAIProvider } from "../extensions/openai/api.js";
import xaiPlugin from "../extensions/xai/index.js";
import {
  createExpiredOauthStore,
  readAuthProfileStoreForTest,
} from "../src/agents/auth-profiles/oauth-test-utils.js";
import type { AuthProfileStore, OAuthCredential } from "../src/agents/auth-profiles/types.js";
import { planOpenClawModelsJson } from "../src/agents/models-config.plan.js";
import * as catalogContext from "../src/agents/models-config.providers.catalog-context.js";
import { prepareModelCatalogPublication } from "../src/agents/prepared-model-runtime.full-catalog.js";
import type { ModelProviderConfig } from "../src/config/types.models.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createTestPluginApi } from "../src/plugin-sdk/plugin-test-api.js";
import type { ProviderCatalogOutcome } from "../src/plugins/provider-catalog.types.js";
import * as providerDiscovery from "../src/plugins/provider-discovery.js";
import * as providerRuntime from "../src/plugins/provider-runtime.runtime.js";
import type { ProviderPlugin } from "../src/plugins/types.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../src/test-utils/openclaw-test-state.js";

const discovery = vi.hoisted(() => ({
  providers: new Array<ProviderPlugin>(),
}));

vi.mock("../src/plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => discovery.providers,
}));

describe("Provider model discovery auth preparation", () => {
  let state: OpenClawTestState;
  let agentDir: string;

  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "catalog-auth-order-", agentEnv: "main" });
    agentDir = state.agentDir();
    discovery.providers = [buildOpenAIProvider()];
    vi.spyOn(providerRuntime, "formatProviderAuthProfileApiKeyWithPlugin").mockImplementation(
      async ({ provider, context }) =>
        discovery.providers.find((candidate) => candidate.id === provider)?.formatApiKey?.(context),
    );
  });

  afterEach(async () => {
    clearLiveCatalogCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    discovery.providers = [];
    await state?.cleanup();
  });

  function planCatalog(
    config: OpenClawConfig,
    store: AuthProfileStore,
    options: {
      providerId?: string;
      outcomes?: ProviderCatalogOutcome[];
      timeoutMs?: number;
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {
    return planOpenClawModelsJson({
      context: {
        cfg: config,
        discoveryAuthConfig: config,
        sourceConfigForSecrets: config,
        agentDir,
        env: options.env ?? {},
        envFingerprint: {},
        providerDiscoveryProviderIds: [options.providerId ?? "openai"],
        providerDiscoveryTimeoutMs: options.timeoutMs,
        onProviderCatalogOutcome: (outcome) => options.outcomes?.push(outcome),
      },
      authStore: store,
      existingRaw: "",
      existingParsed: null,
    });
  }

  async function createChutesCatalogFixture() {
    chutesPlugin.register(
      createTestPluginApi({
        registerProvider: (provider) => {
          discovery.providers = [provider];
        },
      }),
    );
    const profileId = "chutes:oauth";
    const config: OpenClawConfig = { auth: { order: { chutes: [profileId] } } };
    const store = createExpiredOauthStore({
      profileId,
      provider: "chutes",
      access: "expired-chutes-access",
      refresh: "chutes-refresh-token",
    });
    const capturedCredential = structuredClone(store.profiles[profileId]);
    await state.writeAuthProfiles(store);
    const refreshedCredential: OAuthCredential = {
      type: "oauth",
      provider: "chutes",
      access: "refreshed-chutes-access",
      refresh: "rotated-chutes-refresh-token",
      expires: Date.now() + 3_600_000,
    };
    return { profileId, config, store, capturedCredential, refreshedCredential };
  }

  function readPlannedProvider(
    plan: Awaited<ReturnType<typeof planOpenClawModelsJson>>,
    providerId: string,
  ): ModelProviderConfig | undefined {
    expect(plan.action).toBe("write");
    return plan.action === "write"
      ? (JSON.parse(plan.contents) as { providers?: Record<string, ModelProviderConfig> })
          .providers?.[providerId]
      : undefined;
  }

  it("publishes only the configured first profile's account catalog", async () => {
    const profileA = "openai:profile-a";
    const profileB = "openai:profile-b";
    const keyA = "rejected-profile-a";
    const keyB = "selected-profile-b";
    const config: OpenClawConfig = {
      auth: {
        order: {
          openai: [profileB, profileA],
        },
      },
    };
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileA]: { type: "api_key", provider: "openai", key: keyA },
        [profileB]: { type: "api_key", provider: "openai", key: keyB },
      },
    };
    await state.writeAuthProfiles(store);
    const requests: string[] = [];
    const outcomes: ProviderCatalogOutcome[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      requests.push(authorization);
      if (authorization === `Bearer ${keyA}`) {
        return new Response("unauthorized", { status: 401 });
      }
      if (authorization === `Bearer ${keyB}`) {
        return Response.json({ data: [{ id: "gpt-5.5", object: "model" }] });
      }
      throw new Error("unexpected OpenAI catalog authorization");
    });

    const plan = await planCatalog(config, store, { outcomes });

    expect(requests).toEqual([`Bearer ${keyB}`]);
    expect(outcomes).toEqual([{ provider: "openai", profileId: profileB, status: "ready" }]);
    expect(readPlannedProvider(plan, "openai")?.models.map((model) => model.id)).toContain(
      "gpt-5.5",
    );
    expect(plan.action === "write" ? plan.contents : "").not.toContain(keyA);
  });

  it.each([
    { providerId: "openai", source: "profile", modelId: "gpt-5.5" },
    { providerId: "xai", source: "profile", modelId: "grok-4.3" },
    { providerId: "xai", source: "config", modelId: "grok-4.3" },
    { providerId: "xai", source: "env", modelId: "grok-4.3" },
  ])(
    "continues from failed $providerId OAuth to $source API-key auth without repeating refresh",
    async ({ providerId, source, modelId }) => {
      if (providerId === "xai") {
        xaiPlugin.register(
          createTestPluginApi({
            registerProvider: (provider) => {
              discovery.providers = [provider];
            },
          }),
        );
      }
      const profileA = `${providerId}:oauth-a`;
      const profileB = `${providerId}:api-key-b`;
      const keyB = "selected-profile-b";
      const config: OpenClawConfig = {
        auth: {
          order: {
            [providerId]: [profileA, profileB],
          },
        },
      };
      const store = createExpiredOauthStore({
        profileId: profileA,
        provider: providerId,
        access: "rejected-oauth-a",
        refresh: "refresh-a",
      });
      if (source === "profile") {
        store.profiles[profileB] = { type: "api_key", provider: providerId, key: keyB };
      } else if (source === "config") {
        config.models = {
          providers: {
            [providerId]: {
              baseUrl: "https://api.x.ai/v1",
              api: "openai-responses",
              apiKey: keyB,
              models: [],
            },
          },
        };
      } else {
        vi.stubEnv("XAI_API_KEY", keyB);
      }
      await state.writeAuthProfiles(store);
      const events: string[] = [];
      // Diagnostic copy is independent of refresh selection and loads the full plugin runtime.
      vi.spyOn(providerRuntime, "buildProviderAuthDoctorHintWithPlugin").mockResolvedValue(
        undefined,
      );
      const refresh = vi
        .spyOn(providerRuntime, "resolveProviderOAuthCredentialWithPlugin")
        .mockImplementation(async ({ credential }) => {
          events.push(`refresh:${credential.access}`);
          throw new Error("synthetic OAuth refresh failure");
        });
      const { resolveApiKeyForProvider } = providerAuthRuntime;
      const runtimeAuth = vi
        .spyOn(providerAuthRuntime, "resolveApiKeyForProvider")
        .mockImplementation(async (params) => {
          events.push(`resolve:${params.profileId}`);
          return resolveApiKeyForProvider(params);
        });
      const requests: string[] = [];
      const outcomes: ProviderCatalogOutcome[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        events.push("catalog");
        requests.push(new Headers(init?.headers).get("authorization") ?? "");
        return Response.json({ data: [{ id: modelId, object: "model" }] });
      });

      const plan = await planCatalog(config, store, {
        providerId,
        outcomes,
        ...(source === "env" ? { env: { XAI_API_KEY: keyB } } : {}),
      });

      expect(refresh).toHaveBeenCalledOnce();
      expect(refresh).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: providerId,
          refresh: true,
          credential: expect.objectContaining({
            type: "oauth",
            provider: providerId,
            access: "rejected-oauth-a",
            refresh: "refresh-a",
          }),
        }),
      );
      const resolvedProfile = source === "profile" ? profileB : undefined;
      expect(events).toEqual(["refresh:rejected-oauth-a", `resolve:${resolvedProfile}`, "catalog"]);
      expect({
        runtimeProfiles: runtimeAuth.mock.calls.map(([params]) => ({
          profileId: params.profileId,
          lockedProfile: params.lockedProfile,
        })),
        requests,
        outcomes,
        action: plan.action,
      }).toEqual({
        runtimeProfiles: [
          { profileId: resolvedProfile, lockedProfile: resolvedProfile ? true : undefined },
        ],
        requests: [`Bearer ${keyB}`],
        outcomes: [
          {
            provider: providerId,
            ...(resolvedProfile ? { profileId: resolvedProfile } : {}),
            status: "ready",
          },
        ],
        action: "write",
      });
      expect(plan.action === "write" ? plan.contents : "").not.toContain("rejected-oauth-a");
    },
  );

  it.each(["oauth", "token"] as const)(
    "uses subscription discovery for configured literal %s credentials without a profile",
    async (auth) => {
      const accessToken = `configured-${auth}-access`;
      const config: OpenClawConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://chatgpt.com/backend-api/codex",
              api: "openai-chatgpt-responses",
              auth,
              apiKey: accessToken,
              models: [],
            },
          },
        },
      };
      const store: AuthProfileStore = { version: 1, profiles: {} };
      await state.writeAuthProfiles(store);
      const requests: Array<{
        origin: string;
        pathname: string;
        authorization: string;
        version: string | null;
      }> = [];
      const outcomes: ProviderCatalogOutcome[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        requests.push({
          origin: url.origin,
          pathname: url.pathname,
          authorization: new Headers(init?.headers).get("authorization") ?? "",
          version: url.searchParams.get("client_version"),
        });
        return Response.json({
          models: [{ slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" }],
        });
      });

      const plan = await planCatalog(config, store, { outcomes });

      expect(requests).toEqual([
        {
          origin: "https://chatgpt.com",
          pathname: "/backend-api/codex/models",
          authorization: `Bearer ${accessToken}`,
          version: expect.any(String),
        },
      ]);
      expect(outcomes).toEqual([{ provider: "openai", status: "ready" }]);
      const provider = readPlannedProvider(plan, "openai");
      expect(provider).toMatchObject({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      });
      expect(provider?.models.map((model) => model.id)).toContain("gpt-5.5");
      expect(store.profiles).toEqual({});
    },
  );

  it("passes refreshed OAuth material to Chutes discovery without mutating the captured store", async () => {
    const { profileId, config, store, capturedCredential, refreshedCredential } =
      await createChutesCatalogFixture();
    const refresh = vi
      .spyOn(providerRuntime, "resolveProviderOAuthCredentialWithPlugin")
      .mockResolvedValue({
        status: "available",
        credential: refreshedCredential,
        apiKey: refreshedCredential.access,
      });
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      requests.push(authorization);
      return authorization === `Bearer ${refreshedCredential.access}`
        ? Response.json({ data: [{ id: "refreshed-account-model" }] })
        : new Response("unauthorized", { status: 401 });
    });

    const plan = await planCatalog(config, store, { providerId: "chutes" });

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "chutes",
        refresh: true,
        credential: expect.objectContaining({
          type: "oauth",
          provider: "chutes",
          access: "expired-chutes-access",
          refresh: "chutes-refresh-token",
        }),
      }),
    );
    expect(store.profiles[profileId]).toEqual(capturedCredential);
    expect(readAuthProfileStoreForTest(agentDir).profiles[profileId]).toMatchObject(
      refreshedCredential,
    );
    expect(requests).toEqual([`Bearer ${refreshedCredential.access}`]);
    const provider = readPlannedProvider(plan, "chutes");
    expect(provider?.models.map((model) => model.id)).toContain("refreshed-account-model");
    expect(provider?.apiKey).toBe("oauth:chutes");
    for (const secret of [
      "expired-chutes-access",
      "chutes-refresh-token",
      refreshedCredential.access,
      refreshedCredential.refresh,
    ]) {
      expect(plan.action === "write" ? plan.contents : "").not.toContain(secret);
    }
  });

  it.each([
    { providerId: "chutes", profileCount: 1, plugin: chutesPlugin },
    { providerId: "chutes", profileCount: 2, plugin: chutesPlugin },
    { providerId: "openai", profileCount: 1, plugin: null },
    { providerId: "xai", profileCount: 1, plugin: xaiPlugin },
    { providerId: "xai", profileCount: 2, plugin: xaiPlugin },
  ])(
    "retains the $providerId catalog when all $profileCount OAuth profiles fail preparation",
    async ({ providerId, profileCount, plugin }) => {
      if (plugin) {
        plugin.register(
          createTestPluginApi({
            registerProvider: (provider) => {
              discovery.providers = [provider];
            },
          }),
        );
      }
      const profileIds = Array.from(
        { length: profileCount },
        (_, index) => `${providerId}:oauth-${index}`,
      );
      const profiles = Object.fromEntries(
        profileIds.map((profileId) => [
          profileId,
          {
            type: "oauth" as const,
            provider: providerId,
            access: `expired-${profileId}`,
            refresh: `refresh-${profileId}`,
            expires: Date.now() - 60_000,
          },
        ]),
      );
      const store: AuthProfileStore = { version: 1, profiles };
      const config: OpenClawConfig = { auth: { order: { [providerId]: profileIds } } };
      await state.writeAuthProfiles(store);
      vi.spyOn(providerRuntime, "buildProviderAuthDoctorHintWithPlugin").mockResolvedValue(
        undefined,
      );
      const refresh = vi
        .spyOn(providerRuntime, "resolveProviderOAuthCredentialWithPlugin")
        .mockRejectedValue(new Error("synthetic OAuth refresh failure"));
      const runtimeAuth = vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider");
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected HTTP"));
      const outcomes: ProviderCatalogOutcome[] = [];
      const previousProfileId = profileIds[profileIds.length - 1];
      const previousCredential = previousProfileId && profiles[previousProfileId];
      if (!previousProfileId || !previousCredential) {
        throw new Error("OAuth fixture requires a previous profile");
      }
      const auth = {
        authStore: store,
        authModes: { [providerId]: "oauth" as const },
        credentials: { [providerId]: previousCredential },
      };
      const priorModel = {
        id: "prior-account-only-model",
        name: "Prior Account Model",
        provider: providerId,
      };
      const previous = prepareModelCatalogPublication(
        {
          entries: [priorModel],
          routeVariants: [],
          providerOutcomes: [
            { provider: providerId, profileId: previousProfileId, status: "ready" },
          ],
        },
        undefined,
        auth,
        (provider) => provider,
      );

      const plan = await planCatalog(config, store, { providerId, outcomes });
      const published = prepareModelCatalogPublication(
        {
          entries: [],
          routeVariants: [],
          staticEntries: readPlannedProvider(plan, providerId)?.models.map((model) =>
            Object.assign(model, { provider: providerId }),
          ),
          providerOutcomes: outcomes,
        },
        { ...previous, key: "same-config", pluginFingerprint: "same-plugins" },
        auth,
        (provider) => provider,
      );

      expect(published.catalog.entries).toContainEqual(priorModel);
      expect(published.discoveryOrigins).toEqual(previous.discoveryOrigins);
      expect(outcomes).toEqual(
        profileIds.map((profileId) => ({ provider: providerId, profileId, status: "unavailable" })),
      );
      expect(refresh).toHaveBeenCalledTimes(profileCount);
      expect(runtimeAuth).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { completion: "success", timedOut: true },
    { completion: "failure", timedOut: true },
    { completion: "failure", timedOut: false },
  ] as const)(
    "keeps OAuth preparation bounded after $completion (timeout: $timedOut)",
    async ({ completion, timedOut }) => {
      const { profileId, config, store, capturedCredential, refreshedCredential } =
        await createChutesCatalogFixture();
      const fallbackProfileId = "chutes:fallback";
      const fallbackCredential: OAuthCredential = {
        type: "oauth",
        provider: "chutes",
        access: "expired-fallback-access",
        refresh: "fallback-refresh-token",
        expires: Date.now() - 60_000,
      };
      const refreshedFallback: OAuthCredential = {
        ...fallbackCredential,
        access: "refreshed-fallback-access",
        refresh: "rotated-fallback-refresh-token",
        expires: Date.now() + 3_600_000,
      };
      config.auth = { order: { chutes: [profileId, fallbackProfileId] } };
      store.profiles[fallbackProfileId] = fallbackCredential;
      await state.writeAuthProfiles(store);
      const persistedBefore = readAuthProfileStoreForTest(agentDir);
      const persistedFirstProfile = persistedBefore.profiles[profileId];
      if (!persistedFirstProfile) {
        throw new Error("missing persisted first-profile fixture");
      }
      const refreshStarted = createDeferredCore();
      const refreshResult =
        createDeferredCore<
          Awaited<ReturnType<typeof providerRuntime.resolveProviderOAuthCredentialWithPlugin>>
        >();
      vi.spyOn(providerRuntime, "buildProviderAuthDoctorHintWithPlugin").mockResolvedValue(
        undefined,
      );
      const refresh = vi
        .spyOn(providerRuntime, "resolveProviderOAuthCredentialWithPlugin")
        .mockImplementation(async ({ credential }) => {
          if (credential.access !== fallbackCredential.access) {
            refreshStarted.resolve();
            return refreshResult.promise;
          }
          return {
            status: "available",
            credential: refreshedFallback,
            apiKey: refreshedFallback.access,
          };
        });
      const preparation = vi.spyOn(catalogContext, "prepareProviderCatalogRun");
      const catalog = vi.spyOn(providerDiscovery, "runProviderCatalog");
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json({ data: [{ id: "late-account-model" }] }));
      const outcomes: ProviderCatalogOutcome[] = [];
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const planning = planCatalog(config, store, {
        providerId: "chutes",
        timeoutMs: timedOut ? 25 : undefined,
        outcomes,
      });

      try {
        await refreshStarted.promise;
        if (timedOut) {
          await vi.advanceTimersByTimeAsync(25);
          const plan = await planning;
          expect(outcomes).toEqual([{ provider: "chutes", status: "unavailable" }]);
          expect(readPlannedProvider(plan, "chutes")?.models.length).toBeGreaterThan(0);
        }
        expect(refresh).toHaveBeenCalledOnce();
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        try {
          if (completion === "success") {
            refreshResult.resolve({
              status: "available",
              credential: refreshedCredential,
              apiKey: refreshedCredential.access,
            });
          } else {
            refreshResult.reject(new Error("synthetic OAuth refresh failure"));
          }
          // Join the real refresh owner so late credential persistence and I/O are observable.
          const completedPreparation = await Promise.allSettled(
            preparation.mock.results.map((result) => result.value),
          );
          await Promise.allSettled(catalog.mock.results.map((result) => result.value));
          expect(completedPreparation).toEqual([expect.objectContaining({ status: "fulfilled" })]);
        } finally {
          vi.useRealTimers();
        }
      }

      const plan = await planning;
      expect(refresh.mock.calls.map(([params]) => params.credential)).toEqual(
        timedOut ? [capturedCredential] : [capturedCredential, fallbackCredential],
      );
      const persisted = readAuthProfileStoreForTest(agentDir);
      expect(persisted.profiles[profileId]).toMatchObject(
        completion === "success" ? refreshedCredential : persistedFirstProfile,
      );
      expect(persisted.profiles[fallbackProfileId]).toMatchObject(
        timedOut ? fallbackCredential : refreshedFallback,
      );
      expect(store.profiles[profileId]).toEqual(capturedCredential);
      expect(store.profiles[fallbackProfileId]).toEqual(fallbackCredential);
      expect(preparation).toHaveBeenCalledOnce();
      if (timedOut) {
        expect(catalog).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        expect(outcomes).toEqual([{ provider: "chutes", status: "unavailable" }]);
      } else {
        expect(catalog).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledOnce();
        expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
          `Bearer ${refreshedFallback.access}`,
        );
        expect(outcomes).toEqual([
          { provider: "chutes", profileId: fallbackProfileId, status: "ready" },
        ]);
        expect(readPlannedProvider(plan, "chutes")?.models.map((model) => model.id)).toContain(
          "late-account-model",
        );
      }
    },
  );

  it.each(["outcome", "provider"] as const)(
    "preserves a plugin-owned %s after probing exhausted OAuth",
    async (resultKind) => {
      const { config, store } = await createChutesCatalogFixture();
      const otherProfileId = "openai:other-source";
      store.profiles[otherProfileId] = {
        type: "api_key",
        provider: "openai",
        key: "independent-source-key",
      };
      await state.writeAuthProfiles(store);
      vi.spyOn(providerRuntime, "buildProviderAuthDoctorHintWithPlugin").mockResolvedValue(
        undefined,
      );
      vi.spyOn(providerRuntime, "resolveProviderOAuthCredentialWithPlugin").mockRejectedValue(
        new Error("synthetic OAuth refresh failure"),
      );
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected HTTP"));
      const provider = discovery.providers[0];
      if (!provider) {
        throw new Error("Chutes fixture did not register a provider");
      }
      const independentModel = {
        id: "independent-source-model",
        name: "Independent Source Model",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_768,
        maxTokens: 8_192,
      };
      const explicitOutcome: ProviderCatalogOutcome = {
        provider: "chutes",
        profileId: otherProfileId,
        status: "unavailable",
      };
      let reads = 0;
      provider.catalog = {
        order: "profile",
        run: async (ctx) => {
          ctx.resolveProviderAuth("CHUTES");
          const other = ctx.resolveProviderAuth("openai");
          expect(other.profileId).toBe(otherProfileId);
          expect(other.preparationFailed).not.toBe(true);
          if (resultKind === "outcome") {
            return {
              providers: {},
              get outcomes() {
                return reads++ === 0 ? [explicitOutcome] : [];
              },
            };
          }
          return {
            get provider() {
              return {
                baseUrl: "https://api.chutes.ai/v1",
                apiKey: other.apiKey,
                models: reads++ === 0 ? [independentModel] : [],
              };
            },
          };
        },
      };
      const outcomes: ProviderCatalogOutcome[] = [];

      const plan = await planCatalog(config, store, { providerId: "chutes", outcomes });

      if (resultKind === "outcome") {
        expect(outcomes).toEqual([explicitOutcome]);
      } else {
        expect(outcomes).toEqual([]);
        expect(readPlannedProvider(plan, "chutes")?.models.map((model) => model.id)).toContain(
          independentModel.id,
        );
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

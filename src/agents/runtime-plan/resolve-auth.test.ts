import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../auth-profiles.js";
import {
  resolvePreparedRuntimeAuthAttempts,
  resolvePreparedRuntimeModelAuth,
  scopeAuthProfileStoreToPreparedPlan,
} from "./resolve-auth.js";

vi.mock("../model-auth-env-vars.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model-auth-env-vars.js")>()),
  resolveProviderEnvAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: { openai: ["OPENAI_API_KEY", "OPENAI_OAUTH_TOKEN"] },
    authEvidenceMap: {},
    setupProviderFallbackRefs: [],
  }),
}));

const platformModel = {
  id: "gpt-5.5",
  name: "gpt-5.5",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  input: ["text"],
  reasoning: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_000,
} as Model;

const subscriptionModel = {
  ...platformModel,
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
} as Model;

function authStore(profiles: AuthProfileStore["profiles"]): AuthProfileStore {
  return { version: 1, profiles };
}

describe("resolvePreparedRuntimeModelAuth", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_MISSING_PREPARED_AUTH", "");
    vi.stubEnv("OPENCLAW_TEST_MISSING_BOUND_AUTH", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("removes profile and selection state after a Platform key is resolved", () => {
    const store = {
      ...authStore({
        "openai:subscription": {
          type: "token",
          provider: "openai",
          token: "subscription-token",
          expires: Date.now() + 60_000,
        },
        "openai:platform": {
          type: "api_key",
          provider: "openai",
          key: "platform-key",
        },
      }),
      order: { openai: ["openai:subscription", "openai:platform"] },
      lastGood: { openai: "openai:subscription" },
      usageStats: { "openai:subscription": { lastUsed: 1 } },
      runtimePersistedProfileIds: ["openai:subscription"],
      runtimeExternalProfileIds: ["openai:subscription"],
      runtimeExternalProfileIdsAuthoritative: true,
    } satisfies AuthProfileStore;

    expect(
      scopeAuthProfileStoreToPreparedPlan(store, {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        forwardedAuthProfileId: "openai:platform",
        forwardedAuthProfileCandidateIds: ["openai:platform"],
        selectedAuthMode: "api-key",
        modelRoute: {
          provider: "openai",
          modelId: "gpt-5.6",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
          requestTransportOverrides: "none",
        },
      }),
    ).toMatchObject({
      profiles: {},
      order: { openai: [] },
      lastGood: {},
      usageStats: {},
      runtimePersistedProfileIds: [],
      runtimeExternalProfileIds: [],
      runtimeExternalProfileIdsAuthoritative: true,
    });
  });

  it("resolves a later same-route profile when the first SecretRef is unavailable", async () => {
    const store = authStore({
      "openai:missing": {
        type: "api_key",
        provider: "openai",
        keyRef: {
          source: "env",
          provider: "default",
          id: "OPENCLAW_TEST_MISSING_PREPARED_AUTH",
        },
      },
      "openai:backup": {
        type: "api_key",
        provider: "openai",
        key: "backup-key",
      },
    });

    await expect(
      resolvePreparedRuntimeModelAuth({
        plan: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
          forwardedAuthProfileId: "openai:missing",
          forwardedAuthProfileSource: "auto",
          forwardedAuthProfileCandidateIds: ["openai:missing", "openai:backup"],
          selectedAuthMode: "api_key",
          modelRoute: {
            provider: "openai",
            modelId: "gpt-5.5",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            authRequirement: "api-key",
            requestTransportOverrides: "none",
          },
        },
        model: platformModel,
        cfg: {},
        store,
        secretSentinels: true,
      }),
    ).resolves.toMatchObject({
      auth: {
        profileId: "openai:backup",
        mode: "api-key",
      },
      plan: {
        forwardedAuthProfileId: "openai:backup",
        forwardedAuthProfileSource: "auto",
        forwardedAuthProfileCandidateIds: ["openai:backup"],
        selectedAuthMode: "api-key",
      },
    });
  });

  it(
    "does not borrow an unprepared API-key profile for direct subscription auth",
    { timeout: 1_000 },
    async () => {
      vi.stubEnv("OPENAI_API_KEY", "");
      const store = authStore({
        "openai:platform": {
          type: "api_key",
          provider: "openai",
          key: "platform-key",
        },
      });

      await expect(
        resolvePreparedRuntimeModelAuth({
          plan: {
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            selectedAuthMode: "token",
            modelRoute: {
              provider: "openai",
              modelId: "gpt-5.5",
              api: "openai-chatgpt-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              authRequirement: "subscription",
              requestTransportOverrides: "none",
            },
          },
          model: subscriptionModel,
          cfg: {},
          store,
          secretSentinels: true,
        }),
      ).rejects.toThrow('No API key found for provider "openai"');
    },
  );

  it("resolves an ambient Platform key without borrowing the OAuth-only full store", async () => {
    vi.stubEnv("OPENAI_API_KEY", "ambient-platform-key");
    const store = authStore({
      "openai:chatgpt": {
        type: "oauth",
        provider: "openai",
        access: "subscription-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    });

    const resolved = await resolvePreparedRuntimeModelAuth({
      plan: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        selectedAuthMode: "api-key",
        modelRoute: {
          provider: "openai",
          modelId: "gpt-5.5",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
          requestTransportOverrides: "none",
        },
      },
      model: platformModel,
      cfg: {},
      store,
      secretSentinels: true,
    });

    expect(resolved).toMatchObject({
      auth: {
        apiKey: "ambient-platform-key",
        mode: "api-key",
      },
      plan: {
        forwardedAuthProfileId: undefined,
        selectedAuthMode: "api-key",
      },
    });
    expect(resolved.auth.source).toContain("OPENAI_API_KEY");
  });

  it("keeps authored unpinned provider auth ahead of an opposite-route store", async () => {
    const store = authStore({
      "openai:chatgpt": {
        type: "token",
        provider: "openai",
        token: "subscription-token",
      },
    });

    await expect(
      resolvePreparedRuntimeModelAuth({
        plan: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
          selectedAuthMode: "api-key",
          modelRoute: {
            provider: "openai",
            modelId: "gpt-5.5",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            authRequirement: "api-key",
            requestTransportOverrides: "none",
          },
        },
        model: platformModel,
        cfg: {
          models: {
            providers: {
              openai: {
                apiKey: "configured-platform-key",
                baseUrl: "https://api.openai.com/v1",
                models: [],
              },
            },
          },
        },
        store,
        secretSentinels: true,
      }),
    ).resolves.toMatchObject({ auth: { mode: "api-key" } });
  });

  it("materializes authored OpenAI oauth without borrowing the API-only full store", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const store = authStore({
      "openai:platform": {
        type: "api_key",
        provider: "openai",
        key: "platform-key",
      },
    });
    await expect(
      resolvePreparedRuntimeModelAuth({
        plan: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
          selectedAuthMode: "oauth",
          modelRoute: {
            provider: "openai",
            modelId: "gpt-5.5",
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authRequirement: "subscription",
            requestTransportOverrides: "none",
          },
        },
        model: subscriptionModel,
        cfg: {
          models: {
            providers: {
              openai: {
                auth: "oauth",
                apiKey: "configured-subscription-credential",
                baseUrl: "https://chatgpt.com/backend-api/codex",
                models: [],
              },
            },
          },
        },
        store,
        secretSentinels: true,
      }),
    ).resolves.toMatchObject({
      auth: {
        apiKey: "configured-subscription-credential",
        source: "models.json",
        mode: "oauth",
      },
      plan: {
        selectedAuthMode: "oauth",
        modelRoute: { authRequirement: "subscription" },
      },
    });
  });

  it("skips a prepared candidate whose stored credential class changed", async () => {
    const store = authStore({
      "openai:changed": {
        type: "api_key",
        provider: "openai",
        key: "platform-key",
      },
      "openai:backup": {
        type: "token",
        provider: "openai",
        token: "subscription-token",
        expires: Date.now() + 60_000,
      },
    });

    await expect(
      resolvePreparedRuntimeModelAuth({
        plan: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
          forwardedAuthProfileId: "openai:changed",
          forwardedAuthProfileSource: "auto",
          forwardedAuthProfileCandidateIds: ["openai:changed", "openai:backup"],
          selectedAuthMode: "token",
          modelRoute: {
            provider: "openai",
            modelId: "gpt-5.5",
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authRequirement: "subscription",
            requestTransportOverrides: "none",
          },
        },
        model: subscriptionModel,
        cfg: {},
        store,
        secretSentinels: true,
      }),
    ).resolves.toMatchObject({
      auth: { profileId: "openai:backup", mode: "token" },
      plan: {
        forwardedAuthProfileId: "openai:backup",
        forwardedAuthProfileCandidateIds: ["openai:backup"],
        selectedAuthMode: "token",
      },
    });
  });

  it("skips an automatic candidate that cooled down after plan preparation", async () => {
    const store = authStore({
      "openai:first": {
        type: "api_key",
        provider: "openai",
        key: "first-key",
      },
      "openai:backup": {
        type: "api_key",
        provider: "openai",
        key: "backup-key",
      },
    });
    const plan = {
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
      forwardedAuthProfileId: "openai:first",
      forwardedAuthProfileSource: "auto" as const,
      forwardedAuthProfileCandidateIds: ["openai:first", "openai:backup"],
      selectedAuthMode: "api_key",
      modelRoute: {
        provider: "openai",
        modelId: "gpt-5.5",
        api: "openai-responses" as const,
        baseUrl: "https://api.openai.com/v1",
        authRequirement: "api-key" as const,
        requestTransportOverrides: "none" as const,
      },
    };
    store.usageStats = {
      "openai:first": {
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "rate_limit",
        cooldownModel: "gpt-5.5",
      },
    };

    await expect(
      resolvePreparedRuntimeModelAuth({
        plan,
        model: platformModel,
        cfg: {},
        store,
        secretSentinels: true,
      }),
    ).resolves.toMatchObject({
      auth: { profileId: "openai:backup" },
      plan: {
        forwardedAuthProfileId: "openai:backup",
        forwardedAuthProfileCandidateIds: ["openai:backup"],
      },
    });
  });

  it("fails closed when every prepared automatic candidate is in cooldown", async () => {
    const store = authStore({
      "openai:first": { type: "api_key", provider: "openai", key: "first-key" },
      "openai:backup": { type: "api_key", provider: "openai", key: "backup-key" },
    });
    store.usageStats = Object.fromEntries(
      ["openai:first", "openai:backup"].map((profileId) => [
        profileId,
        {
          cooldownUntil: Date.now() + 60_000,
          cooldownReason: "rate_limit" as const,
          cooldownModel: "gpt-5.5",
        },
      ]),
    );

    await expect(
      resolvePreparedRuntimeModelAuth({
        plan: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
          forwardedAuthProfileId: "openai:first",
          forwardedAuthProfileSource: "auto",
          forwardedAuthProfileCandidateIds: ["openai:first", "openai:backup"],
        },
        model: platformModel,
        cfg: {},
        store,
        secretSentinels: true,
      }),
    ).rejects.toThrow("temporarily unavailable");
  });

  it("does not unlock direct fallback when a profile cools during materialization", async () => {
    const store = authStore({
      "openai:first": { type: "api_key", provider: "openai", key: "first-key" },
    });
    const profilePlan = {
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
      forwardedAuthProfileId: "openai:first",
      forwardedAuthProfileSource: "auto" as const,
      forwardedAuthProfileCandidateIds: ["openai:first"],
    };
    const directPlan = {
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
    };
    const resolveAuth = vi.fn(async () => ({ plan: directPlan, auth: "unused" }));
    const materializeModel = vi.fn(async () => {
      store.usageStats = {
        "openai:first": { cooldownUntil: Date.now() + 60_000 },
      };
      return platformModel;
    });

    await expect(
      resolvePreparedRuntimeAuthAttempts({
        attempts: [
          { kind: "profile", plan: profilePlan, profileId: "openai:first" },
          {
            kind: "direct",
            plan: directPlan,
            allowAuthProfileFallback: false,
            requiresPriorProfileAttempt: true,
          },
        ],
        store,
        modelId: "gpt-5.5",
        model: platformModel,
        materializeModel,
        resolveAuth,
        errorMessage: "prepared auth failed",
      }),
    ).rejects.toThrow("temporarily unavailable");
    expect(materializeModel).toHaveBeenCalledOnce();
    expect(resolveAuth).not.toHaveBeenCalled();
  });

  it("keeps a single bound prepared profile terminal", async () => {
    const store = authStore({
      "openai:bound": {
        type: "api_key",
        provider: "openai",
        keyRef: {
          source: "env",
          provider: "default",
          id: "OPENCLAW_TEST_MISSING_BOUND_AUTH",
        },
      },
      "openai:unbound": {
        type: "api_key",
        provider: "openai",
        key: "must-not-be-borrowed",
      },
    });

    await expect(
      resolvePreparedRuntimeModelAuth({
        plan: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
          forwardedAuthProfileId: "openai:bound",
          forwardedAuthProfileSource: "auto",
          forwardedAuthProfileCandidateIds: ["openai:bound"],
        },
        model: platformModel,
        cfg: {
          auth: { order: { openai: ["openai:bound", "openai:unbound"] } },
        },
        store,
        secretSentinels: true,
      }),
    ).rejects.toThrow();
  });

  it("keeps a user-locked profile terminal when environment auth is also present", async () => {
    vi.stubEnv("OPENAI_API_KEY", "ambient-key");
    const store = authStore({
      "openai:locked": {
        type: "api_key",
        provider: "openai",
        key: "codex-app-server",
      },
    });

    await expect(
      resolvePreparedRuntimeModelAuth({
        plan: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
          forwardedAuthProfileId: "openai:locked",
          forwardedAuthProfileSource: "user",
          forwardedAuthProfileCandidateIds: ["openai:locked"],
        },
        model: platformModel,
        cfg: {},
        store,
        secretSentinels: true,
      }),
    ).resolves.toMatchObject({
      auth: { profileId: "openai:locked" },
      plan: {
        forwardedAuthProfileId: "openai:locked",
        forwardedAuthProfileSource: "user",
        forwardedAuthProfileCandidateIds: ["openai:locked"],
      },
    });
  });
});

// Coverage for embedded run auth initialization and runtime credential refresh.
import type { Model } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { isSecretValueRegisteredForRedaction } from "../../../logging/secret-redaction-registry.js";
import {
  looksLikeSecretSentinel,
  mintSecretSentinel,
  resolveSecretSentinel,
} from "../../../secrets/sentinel.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import { FailoverError } from "../../failover-error.js";
import type { RuntimeAuthState } from "./helpers.js";

const mocks = vi.hoisted(() => ({
  prepareProviderRuntimeAuth: vi.fn(),
  getApiKeyForModel: vi.fn(),
}));

vi.mock("../../../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../../plugins/provider-runtime.js")>(
    "../../../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    prepareProviderRuntimeAuth: mocks.prepareProviderRuntimeAuth,
  };
});

vi.mock("../../model-auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../model-auth.js")>("../../model-auth.js");
  return {
    ...actual,
    getApiKeyForModel: mocks.getApiKeyForModel,
  };
});

import {
  createEmbeddedRunAuthController,
  resolveEmbeddedAuthCooldownProbePolicy,
} from "./auth-controller.js";

function createDeferred<T>() {
  // Manual deferreds let refresh tests prove in-flight auth state and ordering.
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected auth controller deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

function createTestModel(): Model {
  return {
    id: "test-model",
    name: "test-model",
    provider: "custom-openai",
    api: "openai-responses",
    baseUrl: "https://old.example.com/v1",
    headers: {
      Authorization: "Bearer stale-token",
    },
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 4_000,
  } as Model;
}

function getRuntimeAuthSnapshot(
  state: RuntimeAuthState | null,
): Pick<RuntimeAuthState, "profileId" | "refreshInFlight"> | null {
  return state ? { profileId: state.profileId, refreshInFlight: state.refreshInFlight } : null;
}

type MutableAuthControllerHarness = {
  runtimeModel: Model;
  effectiveModel: Model;
  apiKeyInfo: unknown;
  lastProfileId?: string;
  runtimeAuthState: RuntimeAuthState | null;
  profileIndex: number;
};

type RuntimeApiKeySetter = Mock<(provider: string, apiKey: string) => void>;

function expectProtectedRuntimeValue(value: string | undefined, plaintext: string): void {
  expect(value).not.toBe(plaintext);
  expect(looksLikeSecretSentinel(value ?? "")).toBe(true);
  expect(resolveSecretSentinel(value ?? "")).toBe(plaintext);
}

function createMutableAuthControllerHarness(): MutableAuthControllerHarness {
  // Mutable harness mirrors the runner fields the auth controller updates
  // through injected getters/setters.
  return {
    runtimeModel: createTestModel(),
    effectiveModel: createTestModel(),
    apiKeyInfo: null,
    lastProfileId: undefined,
    runtimeAuthState: null,
    profileIndex: 0,
  };
}

function createMutableEmbeddedRunAuthController(params: {
  harness: MutableAuthControllerHarness;
  setRuntimeApiKey: RuntimeApiKeySetter;
  profileCandidates?: string[];
  authStore?: AuthProfileStore;
  fallbackConfigured?: boolean;
  warn?: (message: string) => void;
  prepareModelForAuthProfile?: Parameters<
    typeof createEmbeddedRunAuthController
  >[0]["prepareModelForAuthProfile"];
}) {
  return createEmbeddedRunAuthController({
    config: undefined,
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    authStore:
      params.authStore ??
      ({
        version: 1,
        profiles: {},
      } as AuthProfileStore),
    authStorage: { setRuntimeApiKey: params.setRuntimeApiKey },
    profileCandidates: params.profileCandidates ?? ["default"],
    initialThinkLevel: "medium",
    attemptedThinking: new Set(),
    fallbackConfigured: params.fallbackConfigured ?? false,
    allowTransientCooldownProbe: false,
    getProvider: () => "custom-openai",
    getModelId: () => "test-model",
    getRuntimeModel: () => params.harness.runtimeModel,
    setRuntimeModel: (next) => {
      params.harness.runtimeModel = next;
    },
    getEffectiveModel: () => params.harness.effectiveModel,
    setEffectiveModel: (next) => {
      params.harness.effectiveModel = next;
    },
    getApiKeyInfo: () => params.harness.apiKeyInfo as never,
    setApiKeyInfo: (next) => {
      params.harness.apiKeyInfo = next;
    },
    getLastProfileId: () => params.harness.lastProfileId,
    setLastProfileId: (next) => {
      params.harness.lastProfileId = next;
    },
    getRuntimeAuthState: () => params.harness.runtimeAuthState as never,
    setRuntimeAuthState: (next) => {
      params.harness.runtimeAuthState = next;
    },
    getRuntimeAuthRefreshCancelled: () => false,
    setRuntimeAuthRefreshCancelled: () => undefined,
    getProfileIndex: () => params.harness.profileIndex,
    setProfileIndex: (next) => {
      params.harness.profileIndex = next;
    },
    ...(params.prepareModelForAuthProfile
      ? { prepareModelForAuthProfile: params.prepareModelForAuthProfile }
      : {}),
    setThinkLevel: () => undefined,
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: params.warn ?? (() => undefined),
    },
  });
}

describe("createEmbeddedRunAuthController", () => {
  beforeEach(() => {
    mocks.prepareProviderRuntimeAuth.mockReset();
    mocks.getApiKeyForModel.mockReset();
  });

  it("commits a prepared route only after its credential resolves", async () => {
    const harness = createMutableAuthControllerHarness();
    const selectedModel = {
      ...createTestModel(),
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
      contextWindow: 272_000,
    };
    mocks.getApiKeyForModel.mockImplementation(async ({ model }) => {
      expect(model).toBe(selectedModel);
      expect(harness.runtimeModel).not.toBe(selectedModel);
      return {
        apiKey: "subscription-token",
        mode: "oauth" as const,
        profileId: "openai:chatgpt",
        source: "profile",
      };
    });
    mocks.prepareProviderRuntimeAuth.mockResolvedValue(undefined);

    const controller = createMutableEmbeddedRunAuthController({
      harness,
      setRuntimeApiKey: vi.fn(),
      profileCandidates: ["openai:chatgpt"],
      prepareModelForAuthProfile: async () => ({
        runtimeModel: selectedModel,
        authRequirement: "subscription",
        commit: () => {
          harness.runtimeModel = selectedModel;
          harness.effectiveModel = selectedModel;
        },
      }),
    });

    await controller.initializeAuthProfile();
    expect(harness.runtimeModel).toBe(selectedModel);
    expect(harness.lastProfileId).toBe("openai:chatgpt");
  });

  it("rejects credentials whose class does not match the prepared route", async () => {
    const harness = createMutableAuthControllerHarness();
    const commit = vi.fn();
    mocks.getApiKeyForModel.mockResolvedValue({
      apiKey: "platform-key",
      mode: "api-key",
      source: "config",
    });

    const controller = createMutableEmbeddedRunAuthController({
      harness,
      setRuntimeApiKey: vi.fn(),
      profileCandidates: ["default"],
      prepareModelForAuthProfile: async () => ({
        runtimeModel: {
          ...createTestModel(),
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
        authRequirement: "subscription",
        commit,
      }),
    });

    await expect(controller.initializeAuthProfile()).rejects.toThrow(
      "api-key credentials are incompatible with the selected subscription route",
    );
    expect(commit).not.toHaveBeenCalled();
  });

  it("applies runtime request overrides on the first auth exchange", async () => {
    // Provider runtime auth can replace baseUrl, headers, and runtime API key in
    // one exchange; both runtime and effective models must see the override.
    const harness = createMutableAuthControllerHarness();
    const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();

    mocks.getApiKeyForModel.mockResolvedValue({
      apiKey: "source-api-key",
      mode: "api-key",
      profileId: "default",
      source: "env",
    });
    mocks.prepareProviderRuntimeAuth.mockResolvedValue({
      apiKey: "runtime-api-key",
      baseUrl: "https://runtime.example.com/v1",
      request: {
        auth: {
          mode: "header",
          headerName: "api-key",
          value: "runtime-header-token",
        },
      },
    });

    const controller = createMutableEmbeddedRunAuthController({
      harness,
      setRuntimeApiKey,
    });

    await controller.initializeAuthProfile();

    const apiKeyParams = mocks.getApiKeyForModel.mock.calls.at(0)?.[0] as
      | { agentDir?: string; workspaceDir?: string }
      | undefined;
    expect(apiKeyParams?.agentDir).toBe("/tmp/agent");
    expect(apiKeyParams?.workspaceDir).toBe("/tmp/workspace");
    expect(harness.runtimeModel.baseUrl).toBe("https://runtime.example.com/v1");
    expectProtectedRuntimeValue(harness.runtimeModel.headers?.["api-key"], "runtime-header-token");
    expect(harness.effectiveModel.baseUrl).toBe("https://runtime.example.com/v1");
    expectProtectedRuntimeValue(
      harness.effectiveModel.headers?.["api-key"],
      "runtime-header-token",
    );
    const storedApiKey = setRuntimeApiKey.mock.calls[0]?.[1];
    expectProtectedRuntimeValue(storedApiKey, "runtime-api-key");
    expect(harness.runtimeAuthState?.sourceApiKey).toBe("source-api-key");
    expect(harness.runtimeAuthState?.authMode).toBe("api-key");
    expect(harness.runtimeAuthState?.profileId).toBe("default");
  });

  it("clears prior runtime-auth transport overrides when rotating profiles", async () => {
    const harness = createMutableAuthControllerHarness();
    const baseModel = {
      ...createTestModel(),
      headers: { "x-base": "base" },
    };
    harness.runtimeModel = baseModel;
    harness.effectiveModel = baseModel;
    const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();

    mocks.getApiKeyForModel.mockImplementation(async ({ profileId }) => ({
      apiKey: `${String(profileId)}-source-key`,
      mode: "api-key" as const,
      profileId,
      source: `profile:${String(profileId)}`,
    }));
    mocks.prepareProviderRuntimeAuth.mockImplementation(async ({ context }) =>
      context.profileId === "default"
        ? {
            apiKey: "default-runtime-key",
            baseUrl: "https://default-runtime.example.com/v1",
            request: {
              auth: {
                mode: "header" as const,
                headerName: "x-profile-token",
                value: "default-profile-token",
              },
            },
          }
        : undefined,
    );

    const controller = createMutableEmbeddedRunAuthController({
      harness,
      setRuntimeApiKey,
      profileCandidates: ["default", "backup"],
    });

    await controller.initializeAuthProfile();
    expect(harness.runtimeModel.baseUrl).toBe("https://default-runtime.example.com/v1");
    expect(harness.runtimeModel.headers?.["x-base"]).toBe("base");
    expectProtectedRuntimeValue(
      harness.runtimeModel.headers?.["x-profile-token"],
      "default-profile-token",
    );

    await controller.advanceAuthProfile();

    expect(harness.runtimeModel.baseUrl).toBe("https://old.example.com/v1");
    expect(harness.runtimeModel.headers).toEqual({ "x-base": "base" });
    expect(setRuntimeApiKey).toHaveBeenLastCalledWith("custom-openai", "backup-source-key");
  });

  it("unwraps a sentinel for runtime auth exchange but keeps auth storage opaque", async () => {
    const harness = createMutableAuthControllerHarness();
    const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();
    const secret = "runtime-exchange-source-secret";
    const sentinel = mintSecretSentinel(secret, { label: "model-auth:custom-openai" });
    mocks.getApiKeyForModel.mockResolvedValue({
      apiKey: sentinel,
      mode: "api-key",
      source: "profile:custom-openai:default",
    });
    mocks.prepareProviderRuntimeAuth.mockResolvedValue({
      apiKey: "runtime-exchange-token",
      request: {
        auth: {
          mode: "header",
          headerName: "api-key",
          value: "runtime-header-token",
        },
      },
    });

    const controller = createMutableEmbeddedRunAuthController({ harness, setRuntimeApiKey });
    await controller.initializeAuthProfile();

    expect(mocks.getApiKeyForModel).toHaveBeenCalledWith(
      expect.objectContaining({ secretSentinels: true }),
    );
    expect(mocks.prepareProviderRuntimeAuth).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ apiKey: secret }) }),
    );
    const storedApiKey = setRuntimeApiKey.mock.calls[0]?.[1];
    expect(storedApiKey && looksLikeSecretSentinel(storedApiKey)).toBe(true);
    expect(storedApiKey && resolveSecretSentinel(storedApiKey)).toBe("runtime-exchange-token");
    const storedHeader = harness.runtimeModel.headers?.["api-key"];
    expect(storedHeader && looksLikeSecretSentinel(storedHeader)).toBe(true);
    expect(storedHeader && resolveSecretSentinel(storedHeader)).toBe("runtime-header-token");
  });

  it("preserves an empty runtime-auth result for fallback validation", async () => {
    const harness = createMutableAuthControllerHarness();
    const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();
    const sentinel = mintSecretSentinel("runtime-source-secret", {
      label: "model-auth:custom-openai",
    });
    mocks.getApiKeyForModel.mockResolvedValue({
      apiKey: sentinel,
      mode: "api-key",
      source: "profile:custom-openai:default",
    });
    mocks.prepareProviderRuntimeAuth.mockResolvedValue({ apiKey: "" });

    const controller = createMutableEmbeddedRunAuthController({ harness, setRuntimeApiKey });
    await controller.initializeAuthProfile();

    expect(setRuntimeApiKey).toHaveBeenCalledWith("custom-openai", sentinel);
  });

  it("registers exchanged credentials when sentinels are disabled", async () => {
    vi.stubEnv("OPENCLAW_SECRET_SENTINELS", "off");
    const harness = createMutableAuthControllerHarness();
    const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();
    const source = mintSecretSentinel("kill-switch-source-secret", {
      label: "model-auth:custom-openai",
    });
    mocks.getApiKeyForModel.mockResolvedValue({
      apiKey: source,
      mode: "api-key",
      source: "profile:custom-openai:default",
    });
    mocks.prepareProviderRuntimeAuth.mockResolvedValue({ apiKey: "kill-switch-runtime-token" });

    try {
      const controller = createMutableEmbeddedRunAuthController({ harness, setRuntimeApiKey });
      await controller.initializeAuthProfile();
      expect(setRuntimeApiKey).toHaveBeenCalledWith("custom-openai", "kill-switch-runtime-token");
      expect(isSecretValueRegisteredForRedaction("kill-switch-runtime-token")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("includes the checked credential source when an api key is missing", async () => {
    const harness = createMutableAuthControllerHarness();
    const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();

    mocks.getApiKeyForModel.mockResolvedValue({
      mode: "api-key",
      source: "models.providers.custom-openai",
    });

    const controller = createMutableEmbeddedRunAuthController({
      harness,
      setRuntimeApiKey,
    });

    await expect(controller.initializeAuthProfile()).rejects.toThrow(
      'No API key resolved for provider "custom-openai" (auth mode: api-key, checked: models.providers.custom-openai).',
    );
    expect(setRuntimeApiKey).not.toHaveBeenCalled();
    expect(harness.apiKeyInfo).toMatchObject({
      mode: "api-key",
      source: "models.providers.custom-openai",
    });
  });

  it("preserves OAuth mode when billing-disabled profiles are all unavailable", async () => {
    const harness = createMutableAuthControllerHarness();
    const profileId = "custom-openai:oauth";
    const controller = createMutableEmbeddedRunAuthController({
      harness,
      setRuntimeApiKey: vi.fn(),
      profileCandidates: [profileId],
      fallbackConfigured: true,
      authStore: {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "custom-openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
        usageStats: {
          [profileId]: {
            disabledUntil: Date.now() + 60_000,
            disabledReason: "billing",
          },
        },
      },
    });

    const error = await controller.initializeAuthProfile().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(FailoverError);
    expect(error).toMatchObject({
      reason: "billing",
      authMode: "oauth",
    });
  });

  it("only enables transient cooldown probing when every automatic profile is transiently cooled", () => {
    const now = Date.now();
    const createStore = (
      usageStats: NonNullable<AuthProfileStore["usageStats"]>,
    ): AuthProfileStore => ({
      version: 1,
      profiles: {
        first: { type: "api_key", provider: "custom-openai", key: "first-key" },
        second: { type: "api_key", provider: "custom-openai", key: "second-key" },
      },
      usageStats,
    });
    const resolve = (authStore: AuthProfileStore) =>
      resolveEmbeddedAuthCooldownProbePolicy({
        authStore,
        profileCandidates: ["first", "second"],
        modelId: "test-model",
        allowTransientCooldownProbe: true,
      });

    expect(
      resolve(
        createStore({
          first: { disabledUntil: now + 60_000, disabledReason: "rate_limit" },
        }),
      ),
    ).toEqual({ allowProbe: false, unavailableReason: null });
    expect(
      resolve(
        createStore({
          first: { disabledUntil: now + 60_000, disabledReason: "billing" },
          second: { disabledUntil: now + 60_000, disabledReason: "billing" },
        }),
      ),
    ).toEqual({ allowProbe: false, unavailableReason: "billing" });
    expect(
      resolve(
        createStore({
          first: { disabledUntil: now + 60_000, disabledReason: "rate_limit" },
          second: { disabledUntil: now + 60_000, disabledReason: "rate_limit" },
        }),
      ),
    ).toEqual({ allowProbe: true, unavailableReason: "rate_limit" });
  });

  it("rejects privileged runtime transport overrides on the first auth exchange", async () => {
    let runtimeModel = createTestModel();

    mocks.getApiKeyForModel.mockResolvedValue({
      apiKey: "source-api-key",
      mode: "api-key",
      profileId: "default",
      source: "env",
    });
    mocks.prepareProviderRuntimeAuth.mockResolvedValue({
      apiKey: "runtime-api-key",
      request: {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    });

    const controller = createEmbeddedRunAuthController({
      config: undefined,
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      authStore: {
        version: 1,
        profiles: {},
      } as AuthProfileStore,
      authStorage: {
        setRuntimeApiKey: vi.fn<(provider: string, apiKey: string) => void>(),
      },
      profileCandidates: ["default"],
      initialThinkLevel: "medium",
      attemptedThinking: new Set(),
      fallbackConfigured: false,
      allowTransientCooldownProbe: false,
      getProvider: () => "custom-openai",
      getModelId: () => "test-model",
      getRuntimeModel: () => runtimeModel,
      setRuntimeModel: (next) => {
        runtimeModel = next;
      },
      getEffectiveModel: () => runtimeModel,
      setEffectiveModel: () => undefined,
      getApiKeyInfo: () => null as never,
      setApiKeyInfo: () => undefined,
      getLastProfileId: () => undefined,
      setLastProfileId: () => undefined,
      getRuntimeAuthState: () => null,
      setRuntimeAuthState: () => undefined,
      getRuntimeAuthRefreshCancelled: () => false,
      setRuntimeAuthRefreshCancelled: () => undefined,
      getProfileIndex: () => 0,
      setProfileIndex: () => undefined,
      setThinkLevel: () => undefined,
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
      },
    });

    await expect(controller.initializeAuthProfile()).rejects.toThrow(
      /runtime auth request overrides do not allow proxy or tls/i,
    );
  });

  it("ignores stale scheduled refresh results after auth profile rotation", async () => {
    vi.useFakeTimers();
    try {
      const harness = createMutableAuthControllerHarness();
      const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();
      const staleRefresh = createDeferred<{
        apiKey: string;
        baseUrl: string;
        request: {
          auth: {
            mode: "header";
            headerName: string;
            value: string;
          };
        };
        expiresAt: number;
      }>();

      mocks.getApiKeyForModel.mockImplementation(async ({ profileId }) => {
        if (profileId === "backup") {
          return {
            apiKey: "backup-source-api-key",
            mode: "api-key",
            profileId: "backup",
            source: "env",
          };
        }
        return {
          apiKey: "default-source-api-key",
          mode: "api-key",
          profileId: "default",
          source: "env",
        };
      });
      mocks.prepareProviderRuntimeAuth.mockImplementation(async ({ context }) => {
        if (context.apiKey === "default-source-api-key" && context.profileId === "default") {
          if (harness.runtimeAuthState?.refreshInFlight) {
            return staleRefresh.promise;
          }
          return {
            apiKey: "default-runtime-api-key",
            baseUrl: "https://default-runtime.example.com/v1",
            request: {
              auth: {
                mode: "header",
                headerName: "api-key",
                value: "default-runtime-header-token",
              },
            },
            expiresAt: Date.now() + 60_000,
          };
        }
        if (context.apiKey === "backup-source-api-key" && context.profileId === "backup") {
          return {
            apiKey: "backup-runtime-api-key",
            baseUrl: "https://backup-runtime.example.com/v1",
            request: {
              auth: {
                mode: "header",
                headerName: "api-key",
                value: "backup-runtime-header-token",
              },
            },
            expiresAt: Date.now() + 120_000,
          };
        }
        throw new Error(`Unexpected runtime auth request for ${String(context.profileId)}`);
      });

      const controller = createMutableEmbeddedRunAuthController({
        harness,
        setRuntimeApiKey,
        profileCandidates: ["default", "backup"],
      });

      await controller.initializeAuthProfile();
      expect(getRuntimeAuthSnapshot(harness.runtimeAuthState)?.profileId).toBe("default");

      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      const refreshInFlight = getRuntimeAuthSnapshot(harness.runtimeAuthState)?.refreshInFlight;
      expect(typeof refreshInFlight?.then).toBe("function");

      await controller.advanceAuthProfile();
      expect(getRuntimeAuthSnapshot(harness.runtimeAuthState)?.profileId).toBe("backup");
      expect(harness.runtimeModel.baseUrl).toBe("https://backup-runtime.example.com/v1");
      const backupHeader = harness.runtimeModel.headers?.["api-key"];
      expectProtectedRuntimeValue(backupHeader, "backup-runtime-header-token");

      staleRefresh.resolve({
        apiKey: "default-runtime-api-key-refreshed",
        baseUrl: "https://default-refresh.example.com/v1",
        request: {
          auth: {
            mode: "header",
            headerName: "api-key",
            value: "default-refresh-header-token",
          },
        },
        expiresAt: Date.now() + 30_000,
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(getRuntimeAuthSnapshot(harness.runtimeAuthState)?.profileId).toBe("backup");
      expect(harness.runtimeModel.baseUrl).toBe("https://backup-runtime.example.com/v1");
      expect(harness.runtimeModel.headers?.["api-key"]).toBe(backupHeader);
      const storedBackupApiKey = setRuntimeApiKey.mock.calls.at(-1)?.[1];
      expectProtectedRuntimeValue(storedBackupApiKey, "backup-runtime-api-key");
      controller.stopRuntimeAuthRefreshTimer();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("aws-sdk auth without explicit API key (IMDS / instance role)", () => {
    it("injects runtime auth when prepareProviderRuntimeAuth resolves credentials", async () => {
      const harness = createMutableAuthControllerHarness();
      const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();

      mocks.getApiKeyForModel.mockResolvedValue({
        apiKey: undefined,
        mode: "aws-sdk",
        source: "aws-sdk default chain",
      });
      mocks.prepareProviderRuntimeAuth.mockResolvedValue({
        apiKey: "imds-runtime-token",
        expiresAt: Date.now() + 3600_000,
      });

      const controller = createMutableEmbeddedRunAuthController({
        harness,
        setRuntimeApiKey,
        profileCandidates: [undefined as unknown as string],
      });

      await controller.initializeAuthProfile();

      expect(setRuntimeApiKey.mock.calls[0]?.[0]).toBe("custom-openai");
      expectProtectedRuntimeValue(setRuntimeApiKey.mock.calls[0]?.[1], "imds-runtime-token");
      expect(harness.runtimeAuthState?.sourceApiKey).toBe("__aws_sdk_auth__");
      expect(harness.runtimeAuthState?.authMode).toBe("aws-sdk");
      expect(harness.runtimeAuthState?.expiresAt).toBeGreaterThan(Date.now());
      controller.stopRuntimeAuthRefreshTimer();
    });

    it("injects sentinel when prepareProviderRuntimeAuth returns no apiKey", async () => {
      const harness = createMutableAuthControllerHarness();
      const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();

      mocks.getApiKeyForModel.mockResolvedValue({
        apiKey: undefined,
        mode: "aws-sdk",
        source: "aws-sdk default chain",
      });
      mocks.prepareProviderRuntimeAuth.mockResolvedValue(null);

      const controller = createMutableEmbeddedRunAuthController({
        harness,
        setRuntimeApiKey,
        profileCandidates: [undefined as unknown as string],
      });

      await controller.initializeAuthProfile();

      expect(setRuntimeApiKey).toHaveBeenCalledWith("custom-openai", "__aws_sdk_auth__");
      expect(harness.runtimeAuthState).toBeNull();
    });

    it("clears any stale refresh timer before sentinel injection", async () => {
      vi.useFakeTimers();
      try {
        const harness = createMutableAuthControllerHarness();
        const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();

        harness.runtimeAuthState = {
          generation: 1,
          sourceApiKey: "__aws_sdk_auth__",
          authMode: "aws-sdk",
          refreshTimer: setTimeout(() => undefined, 60_000),
        };

        mocks.getApiKeyForModel.mockResolvedValue({
          apiKey: undefined,
          mode: "aws-sdk",
          source: "aws-sdk default chain",
        });
        mocks.prepareProviderRuntimeAuth.mockResolvedValue(null);

        const controller = createMutableEmbeddedRunAuthController({
          harness,
          setRuntimeApiKey,
          profileCandidates: [undefined as unknown as string],
        });

        await controller.initializeAuthProfile();

        expect(setRuntimeApiKey).toHaveBeenCalledWith("custom-openai", "__aws_sdk_auth__");
        expect(harness.runtimeAuthState).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("injects sentinel when prepareProviderRuntimeAuth throws", async () => {
      const harness = createMutableAuthControllerHarness();
      const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();
      const warn = vi.fn<(message: string) => void>();

      mocks.getApiKeyForModel.mockResolvedValue({
        apiKey: undefined,
        mode: "aws-sdk",
        source: "aws-sdk default chain",
      });
      mocks.prepareProviderRuntimeAuth.mockRejectedValue(new Error("No runtime auth plugin"));

      const controller = createMutableEmbeddedRunAuthController({
        harness,
        setRuntimeApiKey,
        profileCandidates: [undefined as unknown as string],
        warn,
      });

      await controller.initializeAuthProfile();

      expect(setRuntimeApiKey).toHaveBeenCalledWith("custom-openai", "__aws_sdk_auth__");
      expect(harness.runtimeAuthState).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        "prepareProviderRuntimeAuth failed for custom-openai, falling back to sentinel: No runtime auth plugin",
      );
    });
  });
});

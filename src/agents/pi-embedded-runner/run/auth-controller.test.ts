import type { Api, Model } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../auth-profiles.js";
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

import { createEmbeddedRunAuthController } from "./auth-controller.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createTestModel(): Model<Api> {
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
  } as Model<Api>;
}

function getRuntimeAuthSnapshot(
  state: RuntimeAuthState | null,
): Pick<RuntimeAuthState, "profileId" | "refreshInFlight"> | null {
  return state ? { profileId: state.profileId, refreshInFlight: state.refreshInFlight } : null;
}

describe("createEmbeddedRunAuthController", () => {
  beforeEach(() => {
    mocks.prepareProviderRuntimeAuth.mockReset();
    mocks.getApiKeyForModel.mockReset();
  });

  it("applies runtime request overrides on the first auth exchange", async () => {
    let runtimeModel = createTestModel();
    let effectiveModel = createTestModel();
    let runtimeAuthState: {
      sourceApiKey: string;
      authMode: string;
      profileId?: string;
      expiresAt?: number;
    } | null = null;
    let apiKeyInfo: unknown = null;
    let lastProfileId: string | undefined;
    const setRuntimeApiKey = vi.fn();

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

    const controller = createEmbeddedRunAuthController({
      config: undefined,
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      authStore: {
        version: 1,
        profiles: {},
      } as AuthProfileStore,
      authStorage: { setRuntimeApiKey },
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
      getEffectiveModel: () => effectiveModel,
      setEffectiveModel: (next) => {
        effectiveModel = next;
      },
      getApiKeyInfo: () => apiKeyInfo as never,
      setApiKeyInfo: (next) => {
        apiKeyInfo = next;
      },
      getLastProfileId: () => lastProfileId,
      setLastProfileId: (next) => {
        lastProfileId = next;
      },
      getRuntimeAuthState: () => runtimeAuthState as never,
      setRuntimeAuthState: (next) => {
        runtimeAuthState = next;
      },
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

    await controller.initializeAuthProfile();

    expect(runtimeModel.baseUrl).toBe("https://runtime.example.com/v1");
    expect(runtimeModel.headers).toEqual({
      "api-key": "runtime-header-token",
    });
    expect(effectiveModel.baseUrl).toBe("https://runtime.example.com/v1");
    expect(effectiveModel.headers).toEqual({
      "api-key": "runtime-header-token",
    });
    expect(setRuntimeApiKey).toHaveBeenCalledWith("custom-openai", "runtime-api-key");
    expect(runtimeAuthState).toMatchObject({
      sourceApiKey: "source-api-key",
      authMode: "api-key",
      profileId: "default",
    });
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
      authStorage: { setRuntimeApiKey: vi.fn() },
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
      let runtimeModel = createTestModel();
      let effectiveModel = createTestModel();
      let runtimeAuthState: RuntimeAuthState | null = null;
      let apiKeyInfo: unknown = null;
      let lastProfileId: string | undefined;
      let profileIndex = 0;
      const setRuntimeApiKey = vi.fn();
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
          if (runtimeAuthState?.refreshInFlight) {
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

      const controller = createEmbeddedRunAuthController({
        config: undefined,
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        authStore: {
          version: 1,
          profiles: {},
        } as AuthProfileStore,
        authStorage: { setRuntimeApiKey },
        profileCandidates: ["default", "backup"],
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
        getEffectiveModel: () => effectiveModel,
        setEffectiveModel: (next) => {
          effectiveModel = next;
        },
        getApiKeyInfo: () => apiKeyInfo as never,
        setApiKeyInfo: (next) => {
          apiKeyInfo = next;
        },
        getLastProfileId: () => lastProfileId,
        setLastProfileId: (next) => {
          lastProfileId = next;
        },
        getRuntimeAuthState: () => runtimeAuthState as never,
        setRuntimeAuthState: (next) => {
          runtimeAuthState = next;
        },
        getRuntimeAuthRefreshCancelled: () => false,
        setRuntimeAuthRefreshCancelled: () => undefined,
        getProfileIndex: () => profileIndex,
        setProfileIndex: (next) => {
          profileIndex = next;
        },
        setThinkLevel: () => undefined,
        log: {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
        },
      });

      await controller.initializeAuthProfile();
      expect(getRuntimeAuthSnapshot(runtimeAuthState)?.profileId).toBe("default");

      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      expect(getRuntimeAuthSnapshot(runtimeAuthState)?.refreshInFlight).toBeTruthy();

      await controller.advanceAuthProfile();
      expect(getRuntimeAuthSnapshot(runtimeAuthState)?.profileId).toBe("backup");
      expect(runtimeModel.baseUrl).toBe("https://backup-runtime.example.com/v1");
      expect(runtimeModel.headers).toEqual({
        "api-key": "backup-runtime-header-token",
      });

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

      expect(getRuntimeAuthSnapshot(runtimeAuthState)?.profileId).toBe("backup");
      expect(runtimeModel.baseUrl).toBe("https://backup-runtime.example.com/v1");
      expect(runtimeModel.headers).toEqual({
        "api-key": "backup-runtime-header-token",
      });
      expect(setRuntimeApiKey).toHaveBeenLastCalledWith("custom-openai", "backup-runtime-api-key");
      controller.stopRuntimeAuthRefreshTimer();
    } finally {
      vi.useRealTimers();
    }
  });
});

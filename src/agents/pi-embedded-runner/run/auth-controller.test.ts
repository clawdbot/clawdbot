import type { Api, Model } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
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

type MutableAuthControllerHarness = {
  runtimeModel: Model<Api>;
  effectiveModel: Model<Api>;
  apiKeyInfo: unknown;
  lastProfileId?: string;
  runtimeAuthState: RuntimeAuthState | null;
  profileIndex: number;
};

type RuntimeApiKeySetter = Mock<(provider: string, apiKey: string) => void>;

function createMutableAuthControllerHarness(): MutableAuthControllerHarness {
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
  warn?: (message: string) => void;
}) {
  return createEmbeddedRunAuthController({
    config: undefined,
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    authStore: {
      version: 1,
      profiles: {},
    } as AuthProfileStore,
    authStorage: { setRuntimeApiKey: params.setRuntimeApiKey },
    profileCandidates: params.profileCandidates ?? ["default"],
    initialThinkLevel: "medium",
    attemptedThinking: new Set(),
    fallbackConfigured: false,
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

  it("applies runtime request overrides on the first auth exchange", async () => {
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

    expect(harness.runtimeModel.baseUrl).toBe("https://runtime.example.com/v1");
    expect(harness.runtimeModel.headers).toEqual({
      "api-key": "runtime-header-token",
    });
    expect(harness.effectiveModel.baseUrl).toBe("https://runtime.example.com/v1");
    expect(harness.effectiveModel.headers).toEqual({
      "api-key": "runtime-header-token",
    });
    expect(setRuntimeApiKey).toHaveBeenCalledWith("custom-openai", "runtime-api-key");
    expect(harness.runtimeAuthState).toMatchObject({
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
      expect(getRuntimeAuthSnapshot(harness.runtimeAuthState)?.refreshInFlight).toBeTruthy();

      await controller.advanceAuthProfile();
      expect(getRuntimeAuthSnapshot(harness.runtimeAuthState)?.profileId).toBe("backup");
      expect(harness.runtimeModel.baseUrl).toBe("https://backup-runtime.example.com/v1");
      expect(harness.runtimeModel.headers).toEqual({
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

      expect(getRuntimeAuthSnapshot(harness.runtimeAuthState)?.profileId).toBe("backup");
      expect(harness.runtimeModel.baseUrl).toBe("https://backup-runtime.example.com/v1");
      expect(harness.runtimeModel.headers).toEqual({
        "api-key": "backup-runtime-header-token",
      });
      expect(setRuntimeApiKey).toHaveBeenLastCalledWith("custom-openai", "backup-runtime-api-key");
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

      expect(setRuntimeApiKey).toHaveBeenCalledWith("custom-openai", "imds-runtime-token");
      expect(harness.runtimeAuthState).toMatchObject({
        sourceApiKey: "__aws_sdk_auth__",
        authMode: "aws-sdk",
      });
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
        expect.stringContaining(
          "prepareProviderRuntimeAuth failed for custom-openai, falling back to sentinel: No runtime auth plugin",
        ),
      );
    });
  });
});

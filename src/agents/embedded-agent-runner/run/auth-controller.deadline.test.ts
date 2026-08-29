import type { Model } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { looksLikeSecretSentinel, resolveSecretSentinel } from "../../../secrets/sentinel.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import type { ResolvedProviderAuth } from "../../model-auth.js";
import { RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS } from "../../runtime-auth-refresh.js";
import { RUNTIME_AUTH_REFRESH_RETRY_MS, type RuntimeAuthState } from "./helpers.js";

const mocks = vi.hoisted(() => ({
  prepareProviderRuntimeAuth: vi.fn(),
  getApiKeyForModelCore: vi.fn(),
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
    getApiKeyForModelCore: mocks.getApiKeyForModelCore,
  };
});

import { createEmbeddedRunAuthController } from "./auth-controller.js";

type MutableAuthControllerHarness = {
  runtimeModel: Model;
  effectiveModel: Model;
  apiKeyInfo: ResolvedProviderAuth | null;
  lastProfileId?: string;
  runtimeAuthState: RuntimeAuthState | null;
  profileIndex: number;
};

function createTestModel(): Model {
  return {
    id: "test-model",
    name: "test-model",
    provider: "custom-openai",
    api: "openai-responses",
    baseUrl: "https://old.example.com/v1",
    headers: { Authorization: "Bearer stale-token" },
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 4_000,
  };
}

function createHarness(): MutableAuthControllerHarness {
  return {
    runtimeModel: createTestModel(),
    effectiveModel: createTestModel(),
    apiKeyInfo: null,
    runtimeAuthState: null,
    profileIndex: 0,
  };
}

function createController(params: {
  harness: MutableAuthControllerHarness;
  setRuntimeApiKey(provider: string, apiKey: string): void;
  profileCandidates?: string[];
}) {
  const authStore: AuthProfileStore = { version: 1, profiles: {} };
  return createEmbeddedRunAuthController({
    config: undefined,
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    authStore,
    authStorage: {
      setRuntimeApiKey: (provider, apiKey) => params.setRuntimeApiKey(provider, apiKey),
    },
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
    getApiKeyInfo: () => params.harness.apiKeyInfo,
    setApiKeyInfo: (next) => {
      params.harness.apiKeyInfo = next;
    },
    getLastProfileId: () => params.harness.lastProfileId,
    setLastProfileId: (next) => {
      params.harness.lastProfileId = next;
    },
    getRuntimeAuthState: () => params.harness.runtimeAuthState,
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
      warn: () => undefined,
    },
  });
}

function expectProtectedRuntimeValue(value: string | undefined, plaintext: string): void {
  expect(value).not.toBe(plaintext);
  expect(looksLikeSecretSentinel(value ?? "")).toBe(true);
  expect(resolveSecretSentinel(value ?? "")).toBe(plaintext);
}

describe("createEmbeddedRunAuthController refresh deadlines", () => {
  beforeEach(() => {
    mocks.prepareProviderRuntimeAuth.mockReset();
    mocks.getApiKeyForModelCore.mockReset();
  });

  it("releases the in-flight refresh handle when a refresh hangs past the hard deadline", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();
      mocks.getApiKeyForModelCore.mockResolvedValue({
        apiKey: "source-api-key",
        mode: "api-key",
        profileId: "default",
        source: "env",
      });
      let call = 0;
      mocks.prepareProviderRuntimeAuth.mockImplementation(async () => {
        call += 1;
        if (call === 1) {
          return {
            apiKey: "runtime-api-key",
            baseUrl: "https://runtime.example.com/v1",
            request: { auth: { mode: "header", headerName: "api-key", value: "runtime-token" } },
            expiresAt: Date.now() + 60_000,
          };
        }
        return new Promise(() => {});
      });
      const controller = createController({ harness, setRuntimeApiKey });

      await controller.initializeAuthProfile();
      await vi.advanceTimersByTimeAsync(5_000);
      const inflight = harness.runtimeAuthState?.refreshInFlight;
      expect(typeof inflight?.then).toBe("function");

      const rejection = expect(inflight).rejects.toThrow(/exceeded hard deadline/);
      await vi.advanceTimersByTimeAsync(RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS);
      await rejection;
      expect(harness.runtimeAuthState?.refreshInFlight).not.toBe(inflight);
      controller.stopRuntimeAuthRefreshTimer();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a deadline-abandoned refresh completion after a successful retry", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();
      const staleRefresh = createDeferred<{ apiKey: string; expiresAt: number }>();
      mocks.getApiKeyForModelCore.mockResolvedValue({
        apiKey: "source-api-key",
        mode: "api-key",
        profileId: "default",
        source: "env",
      });
      let call = 0;
      mocks.prepareProviderRuntimeAuth.mockImplementation(async () => {
        call += 1;
        if (call === 1) {
          return { apiKey: "runtime-api-key", expiresAt: Date.now() + 60_000 };
        }
        if (call === 2) {
          return staleRefresh.promise;
        }
        return { apiKey: "retry-runtime-api-key", expiresAt: Date.now() + 60_000 };
      });
      const controller = createController({ harness, setRuntimeApiKey });

      await controller.initializeAuthProfile();
      await vi.advanceTimersByTimeAsync(5_000);
      const inflight = harness.runtimeAuthState?.refreshInFlight;
      const rejection = expect(inflight).rejects.toThrow(/exceeded hard deadline/);
      await vi.advanceTimersByTimeAsync(RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS);
      await rejection;

      await vi.advanceTimersByTimeAsync(RUNTIME_AUTH_REFRESH_RETRY_MS);
      expectProtectedRuntimeValue(setRuntimeApiKey.mock.calls.at(-1)?.[1], "retry-runtime-api-key");

      staleRefresh.resolve({ apiKey: "stale-runtime-api-key", expiresAt: Date.now() + 5_000 });
      await vi.advanceTimersByTimeAsync(0);

      expectProtectedRuntimeValue(setRuntimeApiKey.mock.calls.at(-1)?.[1], "retry-runtime-api-key");
      const staleWrites = setRuntimeApiKey.mock.calls.filter(
        ([, apiKey]) => resolveSecretSentinel(apiKey) === "stale-runtime-api-key",
      );
      expect(staleWrites).toHaveLength(0);
      controller.stopRuntimeAuthRefreshTimer();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails over instead of hanging when cold-start auth prep exceeds the hard deadline", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();
      mocks.getApiKeyForModelCore.mockResolvedValue({
        apiKey: "source-api-key",
        mode: "api-key",
        profileId: "default",
        source: "env",
      });
      mocks.prepareProviderRuntimeAuth.mockImplementation(() => new Promise(() => {}));
      const controller = createController({ harness, setRuntimeApiKey });

      const init = controller.initializeAuthProfile();
      const rejection = expect(init).rejects.toBeTruthy();
      await vi.advanceTimersByTimeAsync(RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the selected fallback after the timed-out credential read settles", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();
      const staleCredential = createDeferred<ResolvedProviderAuth>();
      mocks.getApiKeyForModelCore.mockImplementation(async ({ profileId }) => {
        if (profileId === "first") {
          return await staleCredential.promise;
        }
        return {
          apiKey: "backup-source-key",
          mode: "api-key",
          profileId: "backup",
          source: "profile:backup",
        };
      });
      mocks.prepareProviderRuntimeAuth.mockResolvedValue({
        apiKey: "backup-runtime-key",
        baseUrl: "https://backup.example.com/v1",
        request: {
          auth: { mode: "header", headerName: "x-profile-token", value: "backup-token" },
        },
      });
      const controller = createController({
        harness,
        setRuntimeApiKey,
        profileCandidates: ["first", "backup"],
      });

      const init = controller.initializeAuthProfile();
      await vi.advanceTimersByTimeAsync(RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS);
      await init;
      expect(harness.lastProfileId).toBe("backup");
      expect(harness.apiKeyInfo?.profileId).toBe("backup");
      expect(harness.runtimeAuthState?.profileId).toBe("backup");
      expect(harness.runtimeModel.baseUrl).toBe("https://backup.example.com/v1");
      expectProtectedRuntimeValue(
        harness.runtimeModel.headers?.["x-profile-token"],
        "backup-token",
      );
      expectProtectedRuntimeValue(setRuntimeApiKey.mock.calls.at(-1)?.[1], "backup-runtime-key");

      staleCredential.resolve({
        apiKey: "stale-source-key",
        mode: "api-key",
        profileId: "first",
        source: "profile:first",
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(harness.lastProfileId).toBe("backup");
      expect(harness.apiKeyInfo?.profileId).toBe("backup");
      expect(harness.runtimeAuthState?.profileId).toBe("backup");
      expect(harness.runtimeModel.baseUrl).toBe("https://backup.example.com/v1");
      expectProtectedRuntimeValue(
        harness.runtimeModel.headers?.["x-profile-token"],
        "backup-token",
      );
      expectProtectedRuntimeValue(setRuntimeApiKey.mock.calls.at(-1)?.[1], "backup-runtime-key");
      expect(setRuntimeApiKey).toHaveBeenCalledTimes(1);
      controller.stopRuntimeAuthRefreshTimer();
    } finally {
      vi.useRealTimers();
    }
  });
});

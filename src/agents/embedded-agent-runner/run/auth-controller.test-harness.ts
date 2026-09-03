import type { Model } from "openclaw/plugin-sdk/llm";
import type { AuthProfileStore } from "../../auth-profiles.js";
import { createEmbeddedRunAuthController } from "./auth-controller.js";
import type { RuntimeAuthState } from "./helpers.js";

export function createTestModel(): Model {
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

export function getRuntimeAuthSnapshot(
  state: RuntimeAuthState | null,
): Pick<RuntimeAuthState, "profileId" | "refreshInFlight"> | null {
  return state ? { profileId: state.profileId, refreshInFlight: state.refreshInFlight } : null;
}

export type MutableAuthControllerHarness = {
  runtimeModel: Model;
  effectiveModel: Model;
  apiKeyInfo: unknown;
  lastProfileId?: string;
  runtimeAuthState: RuntimeAuthState | null;
  profileIndex: number;
};

export type RuntimeApiKeySetter = (provider: string, apiKey: string) => void;

export function createMutableAuthControllerHarness(): MutableAuthControllerHarness {
  return {
    runtimeModel: createTestModel(),
    effectiveModel: createTestModel(),
    apiKeyInfo: null,
    lastProfileId: undefined,
    runtimeAuthState: null,
    profileIndex: 0,
  };
}

export function createMutableEmbeddedRunAuthController(params: {
  harness: MutableAuthControllerHarness;
  setRuntimeApiKey: RuntimeApiKeySetter;
  profileCandidates?: string[];
  authStore?: AuthProfileStore;
  fallbackConfigured?: boolean;
  lockedProfileId?: string;
  allowTransientCooldownProbe?: boolean;
  warn?: (message: string) => void;
  agentDir?: string;
  prepareModelForAuthProfile?: Parameters<
    typeof createEmbeddedRunAuthController
  >[0]["prepareModelForAuthProfile"];
}) {
  return createEmbeddedRunAuthController({
    config: undefined,
    agentDir: params.agentDir ?? "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    authStore:
      params.authStore ??
      ({
        version: 1,
        profiles: {},
      } as AuthProfileStore),
    authStorage: { setRuntimeApiKey: params.setRuntimeApiKey },
    profileCandidates: params.profileCandidates ?? ["default"],
    lockedProfileId: params.lockedProfileId,
    initialThinkLevel: "medium",
    attemptedThinking: new Set(),
    fallbackConfigured: params.fallbackConfigured ?? false,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe ?? false,
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

/**
 * Test harness mocks for embedded-run overflow compaction coverage.
 */
import { matchesContextOverflowMessage } from "@openclaw/ai/internal/runtime";
import { type Mock, vi } from "vitest";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { ContextEngineSessionTarget } from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  PluginHookBeforeAgentFinalizeEvent,
  PluginHookBeforeAgentFinalizeResult,
} from "../../plugins/hook-types.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentReplyResult,
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildResult,
} from "../../plugins/types.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { extractObservedOverflowTokenCount } from "../embedded-agent-helpers/context-overflow-observation.js";
import type { FailoverReason } from "../failover/signal.js";
import { clearAgentHarnesses, registerAgentHarness } from "../harness/registry.js";
import type { AgentHarnessAttemptParams } from "../harness/types.js";
import type { ResolvedProviderAuth } from "../model-auth-runtime-shared.js";
import type { AgentRuntimePlan } from "../runtime-plan/types.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import type { RunEmbeddedAgentInternalParams } from "./run/internal-params.js";
import type { buildEmbeddedRunPayloads } from "./run/payloads.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

type ProductionRunEmbeddedAgent = typeof import("./run.js").runEmbeddedAgent;
export type TestRunEmbeddedAgent = (
  params: RunEmbeddedAgentInternalParams,
) => ReturnType<ProductionRunEmbeddedAgent>;

// Shared Vitest harness for overflow, compaction, failover, and hook tests.
// Tests import these mocks directly so each scenario can override one seam.
type MockCompactionResult =
  | {
      ok: true;
      compacted: true;
      result: {
        summary: string;
        firstKeptEntryId?: string;
        tokensBefore?: number;
        tokensAfter?: number;
        sessionId?: string;
        sessionFile?: string;
        sessionTarget?: ContextEngineSessionTarget;
      };
      reason?: string;
    }
  | {
      ok: false;
      compacted: false;
      reason: string;
      result?: undefined;
    }
  | {
      ok: true;
      compacted: false;
      reason: string;
      result?: undefined;
    };

type MockResolvedModel = {
  id: string;
  provider: string;
  contextWindow: number;
  api: string;
  baseUrl?: string;
  reasoning?: boolean;
};

const emptyPluginIndex: PluginMetadataSnapshot["index"] = {
  version: 1,
  hostContractVersion: "test",
  compatRegistryVersion: "test",
  migrationVersion: 1,
  policyHash: "",
  generatedAtMs: 1,
  installRecords: {},
  plugins: [],
  diagnostics: [],
};
const emptyPluginMetadataSnapshot: PluginMetadataSnapshot = {
  policyHash: "",
  index: emptyPluginIndex,
  registryIndex: emptyPluginIndex,
  registryDiagnostics: [],
  manifestRegistry: { plugins: [], diagnostics: [] },
  plugins: [],
  diagnostics: [],
  byPluginId: new Map(),
  normalizePluginId: (pluginId: string) => pluginId,
  owners: {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map(),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
  },
  metrics: {
    registrySnapshotMs: 0,
    manifestRegistryMs: 0,
    ownerMapsMs: 0,
    totalMs: 0,
    indexPluginCount: 0,
    manifestPluginCount: 0,
  },
};

type MockAgentDiscoveryStores = {
  authStorage: {
    setRuntimeApiKey: ReturnType<typeof vi.fn>;
  };
  modelRegistry: Record<string, never>;
};

type MockResolveModelResult = MockAgentDiscoveryStores & {
  model: MockResolvedModel;
  error: null;
};

export const mockedGlobalHookRunner = {
  hasHooks: vi.fn((_hookName: string) => false),
  runBeforeAgentReply: vi.fn(
    async (
      _eventValue: { cleanedBody: string },
      _ctx: PluginHookAgentContext,
    ): Promise<PluginHookBeforeAgentReplyResult | undefined> => undefined,
  ),
  runBeforeAgentFinalize: vi.fn(
    async (
      _eventValue: PluginHookBeforeAgentFinalizeEvent,
      _ctx: PluginHookAgentContext,
    ): Promise<PluginHookBeforeAgentFinalizeResult | undefined> => undefined,
  ),
  runBeforePromptBuild: vi.fn(
    async (
      _eventValue: { prompt: string; messages: unknown[] },
      _ctx: PluginHookAgentContext,
    ): Promise<PluginHookBeforePromptBuildResult | undefined> => undefined,
  ),
  runBeforeModelResolve: vi.fn(
    async (
      _eventValue: { prompt: string },
      _ctx: PluginHookAgentContext,
    ): Promise<PluginHookBeforeModelResolveResult | undefined> => undefined,
  ),
  runBeforeCompaction: vi.fn(async () => undefined),
  runAfterCompaction: vi.fn(async () => undefined),
};

const mockedContextEngine = {
  info: { ownsCompaction: false as boolean },
  compact: vi.fn<(params: unknown) => Promise<MockCompactionResult>>(async () => ({
    ok: false as const,
    compacted: false as const,
    reason: "nothing to compact",
  })),
};

type MockRuntimePlan = Pick<AgentRuntimePlan, "auth"> & {
  observability: Pick<AgentRuntimePlan["observability"], "harnessId">;
};

function makeMockRuntimePlan(): MockRuntimePlan {
  return {
    auth: {
      authProfileProviderForAuth: "openai",
      providerForAuth: "openai",
    },
    observability: {
      harnessId: "codex",
    },
  };
}

export const mockedCompactDirect = mockedContextEngine.compact;
const mockedResolveContextEngine = vi.fn(async () => mockedContextEngine);
const mockedResolveContextEngineOwnerPluginId = vi.fn(() => undefined);
const buildMockAgentRuntimePlan = () => makeMockRuntimePlan() as AgentRuntimePlan;
export const mockedBuildAgentRuntimePlan = vi.fn<() => AgentRuntimePlan>(buildMockAgentRuntimePlan);
export const mockedAcquireAgentRunPreparedModelRuntime = vi.fn(
  async (input: Record<string, unknown>) => {
    const pluginRegistry = getActivePluginRegistry();
    return {
      snapshot: {
        agentId: input.agentId,
        agentDir: input.agentDir,
        config: input.config,
        workspaceDir: input.workspaceDir,
        pluginRegistry: pluginRegistry
          ? {
              ...pluginRegistry,
              agentHarnesses: [...pluginRegistry.agentHarnesses],
            }
          : undefined,
        metadataSnapshot: { ...emptyPluginMetadataSnapshot, workspaceDir: input.workspaceDir },
        createStores: () => ({ authStorage: {}, modelRegistry: {} }),
      },
      release: vi.fn(),
    };
  },
);
const mockedRunPostCompactionSideEffects = vi.fn(async () => {});
const mockedSleepWithAbort = vi.fn(async (_ms: number, _abortSignal?: AbortSignal) => undefined);
function createMockAgentDiscoveryStores(): MockAgentDiscoveryStores {
  return {
    authStorage: {
      setRuntimeApiKey: vi.fn(),
    },
    modelRegistry: {},
  };
}

const mockedCreateEmptyAgentDiscoveryStores = vi.fn(createMockAgentDiscoveryStores);
function createMockResolvedModel(
  provider = "anthropic",
  modelId = "test-model",
  cfg?: unknown,
): MockResolveModelResult {
  const providerConfig = (
    cfg as {
      models?: { providers?: Record<string, { api?: string; baseUrl?: string }> };
    }
  )?.models?.providers?.[provider];
  const usesOpenAITransport = provider === "openai" || provider === "codex";
  return {
    model: {
      id: modelId,
      provider,
      contextWindow: 200000,
      api: providerConfig?.api ?? (usesOpenAITransport ? "openai-responses" : "messages"),
      ...(providerConfig?.baseUrl
        ? { baseUrl: providerConfig.baseUrl }
        : usesOpenAITransport
          ? { baseUrl: "https://api.openai.com/v1" }
          : {}),
    },
    error: null,
    ...createMockAgentDiscoveryStores(),
  };
}
export const mockedResolveModelAsync = vi.fn(
  async (provider?: string, modelId?: string, _agentDir?: string, cfg?: unknown) =>
    createMockResolvedModel(provider, modelId, cfg),
);
const mockedPrepareProviderRuntimeAuth = vi.fn<
  (params?: { context?: { apiKey?: string } }) => Promise<{ apiKey: string } | undefined>
>(async () => undefined);
export const mockedRunEmbeddedAttempt =
  vi.fn<(params: AgentHarnessAttemptParams) => Promise<EmbeddedRunAttemptResult>>();
export const mockedBuildEmbeddedRunPayloads = vi.fn<
  (
    ...args: Parameters<typeof buildEmbeddedRunPayloads>
  ) => ReturnType<typeof buildEmbeddedRunPayloads>
>(() => []);
const mockedRunContextEngineMaintenance = vi.fn(async () => undefined);
const mockedWaitForDeferredTurnMaintenanceForSession = vi.fn(
  async (_sessionKey?: string) => undefined,
);
const mockedSessionLikelyHasOversizedToolResults = vi.fn(() => false);
const mockedResolveLiveToolResultMaxChars = vi.fn(() => 32_000);
type MockTruncateOversizedToolResultsResult = {
  truncated: boolean;
  truncatedCount: number;
  reason?: string;
};
const mockedTruncateOversizedToolResultsInSession = vi.fn<
  () => MockTruncateOversizedToolResultsResult
>(() => ({
  truncated: false,
  truncatedCount: 0,
  reason: "no oversized tool results",
}));

type MockFailoverErrorDescription = {
  message: string;
  reason: string | undefined;
  status: number | undefined;
  code: string | undefined;
};

type MockCoerceToFailoverError = (
  err: unknown,
  params?: { provider?: string; model?: string; profileId?: string },
) => unknown;
type MockDescribeFailoverError = (err: unknown) => MockFailoverErrorDescription;
type MockResolveFailoverStatus = (reason: string) => number | undefined;
type MockAssistantErrorProbe = (assistant?: { errorMessage?: string }) => boolean;
export class MockedFailoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FailoverError";
  }
}

const mockedCoerceToFailoverError = vi.fn<MockCoerceToFailoverError>();
const mockedDescribeFailoverError = vi.fn<MockDescribeFailoverError>(
  (err: unknown): MockFailoverErrorDescription => ({
    message: formatErrorMessage(err),
    reason: undefined,
    status: undefined,
    code: undefined,
  }),
);
const mockedResolveFailoverStatus = vi.fn<MockResolveFailoverStatus>();

const mockedLog: {
  debug: Mock<(...args: unknown[]) => void>;
  info: Mock<(...args: unknown[]) => void>;
  warn: Mock<(...args: unknown[]) => void>;
  error: Mock<(...args: unknown[]) => void>;
  isEnabled: Mock<(level?: string) => boolean>;
} = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  isEnabled: vi.fn(() => false),
};

const mockedFormatBillingErrorMessage = vi.fn(() => "");
export const mockedClassifyFailoverReason = vi.fn<(raw: string) => FailoverReason | null>(
  () => null,
);
export const mockedClassifyAssistantFailoverReason = vi.fn(
  (assistant?: { errorMessage?: string | null }): FailoverReason | null =>
    mockedClassifyFailoverReason(assistant?.errorMessage ?? ""),
);
const mockedExtractObservedOverflowTokenCount = vi.fn(extractObservedOverflowTokenCount);
export const mockedFormatAssistantErrorText = vi.fn(() => "");
const mockedIsAuthAssistantError = vi.fn(() => false);
const mockedIsBillingAssistantError = vi.fn(() => false);
export const mockedIsCompactionFailureError = vi.fn(() => false);
export const mockedIsFailoverAssistantError = vi.fn<MockAssistantErrorProbe>(() => false);
const mockedIsFailoverErrorMessage = vi.fn(() => false);
const mockedIsGenericUnknownStreamErrorMessage = vi.fn((raw: string) =>
  /^\s*an unknown error occurred\.?\s*$/i.test(raw),
);
function matchesCanonicalOverflowFixture(msg?: string): boolean {
  const raw = msg ?? "";
  return (
    matchesContextOverflowMessage(raw, "failover-explicit") ||
    matchesContextOverflowMessage(raw, "provider-fallback") ||
    matchesContextOverflowMessage(raw, "failover-hint")
  );
}
export const mockedIsLikelyContextOverflowError = vi.fn(matchesCanonicalOverflowFixture);
const mockedParseImageSizeError = vi.fn(() => null);
const mockedParseImageDimensionError = vi.fn(() => null);
export const mockedIsRateLimitAssistantError = vi.fn<MockAssistantErrorProbe>(() => false);
const mockedIsTimeoutErrorMessage = vi.fn(() => false);
const mockedPickFallbackThinkingLevel = vi.fn<(params?: unknown) => ThinkLevel | null>(() => null);
const mockedEvaluateContextWindowGuard = vi.fn(() => ({
  shouldWarn: false,
  shouldBlock: false,
  tokens: 200000,
  source: "model",
  hardMinTokens: 1000,
  warnBelowTokens: 5000,
}));
const mockedResolveContextWindowInfo = vi.fn(() => ({
  tokens: 200000,
  source: "model",
}));
const mockedFormatContextWindowWarningMessage = vi.fn(
  (params: { provider: string; modelId: string; guard: { tokens: number; source: string } }) =>
    `low context window: ${params.provider}/${params.modelId} ctx=${params.guard.tokens} source=${params.guard.source}`,
);
const mockedFormatContextWindowBlockMessage = vi.fn(
  (params: { guard: { tokens: number; source: string } }) =>
    `Model context window too small (${params.guard.tokens} tokens; source=${params.guard.source}). Minimum is 1000.`,
);
type MockGetApiKeyForModelParams = {
  profileId?: string;
  model?: { api?: string };
};
export const mockedGetApiKeyForModel = vi.fn<
  (params?: MockGetApiKeyForModelParams) => Promise<ResolvedProviderAuth>
>(async ({ profileId }: MockGetApiKeyForModelParams = {}) => ({
  apiKey: "test-key",
  profileId: profileId ?? "test-profile",
  source: "test",
  mode: "api-key",
}));
const mockedIsProfileInCooldown = vi.fn(
  (_store: unknown, _profileId: string, _now?: number, _modelId?: string) => false,
);
export const mockedMarkAuthProfileFailure = vi.fn(async () => {});
export const mockedEnsureAuthProfileStore = vi.fn<() => AuthProfileStore>(() => ({
  version: 1,
  profiles: {},
}));
export const mockedEnsureAuthProfileStoreWithoutExternalProfiles = vi.fn<
  (_agentDir?: string, _options?: { allowKeychainPrompt?: boolean }) => AuthProfileStore
>((_agentDir?: string, _options?: { allowKeychainPrompt?: boolean }) => ({
  version: 1,
  profiles: {},
}));

export function useOpenAIPlatformAuthFixture(): void {
  const profileId = "openai:test";
  mockedEnsureAuthProfileStore.mockReturnValue({
    version: 1,
    profiles: {
      [profileId]: {
        type: "api_key",
        provider: "openai",
        key: "test-key",
      },
    },
    order: { openai: [profileId] },
  });
  mockedResolveAuthProfileOrder.mockReturnValue([profileId]);
}
export const mockedResolveAuthProfileOrder = vi.fn<(_params?: unknown) => string[]>(
  (_params?: unknown) => [],
);
type AuthProfileOrderResolution = ReturnType<
  typeof import("../model-auth.js").resolveAuthProfileOrderWithMetadata
>;
const mockedResolveAuthProfileOrderWithMetadata = vi.fn<
  (_params?: unknown) => AuthProfileOrderResolution
>((params?: unknown) => ({
  profileIds: mockedResolveAuthProfileOrder(params),
  hasExplicitOrder: false,
}));
const mockedResolveProviderEntryApiKeyProfileReference = vi.fn<(_params?: unknown) => unknown>(
  () => ({ kind: "none" }),
);
const mockedHasUsableCustomProviderApiKey = vi.fn(() => false);
const mockedMarkAuthProfileSuccess = vi.fn(async () => {});
const mockedShouldPreferExplicitConfigApiKeyAuth = vi.fn(() => false);

// No provider here means model resolution defaults to anthropic/test-model, which
// the mocked codex harness does not claim: such runs select the built-in openclaw
// host harness and pay its one-time source-compile cost. Suites proving plugin
// harness behavior must pin provider "openai" (see run.session-permissions.test.ts).
export function createOverflowRunParams(state: Pick<OpenClawTestState, "workspaceDir">) {
  return {
    agentId: "main",
    sessionId: "test-session",
    sessionKey: "agent:main:test-key",
    workspaceDir: state.workspaceDir,
    prompt: "hello",
    timeoutMs: 30000,
    runId: "run-1",
  } as const;
}

function resetMockAgentHarness(): void {
  clearAgentHarnesses();
  registerAgentHarness({
    id: "codex",
    label: "Codex",
    supports: (ctx) =>
      ctx.provider === "codex" || ctx.provider === "openai"
        ? { supported: true, priority: 100 }
        : { supported: false },
    runAttempt: async (params) => await mockedRunEmbeddedAttempt(params),
    finalizeSettledTurn: async ({ attempt }) => {
      const result = await mockedRunEmbeddedAttempt({ ...attempt, disableTools: true });
      const assistant =
        result.currentAttemptCompletedAssistant ??
        result.currentAttemptAssistant ??
        result.lastAssistant;
      if (!assistant) {
        throw new Error("mocked settled-turn finalization returned no assistant message");
      }
      return { assistant, ...(result.attemptUsage ? { usage: result.attemptUsage } : {}) };
    },
  });
}

/** Reset every mocked runner dependency to the default successful no-op state. */
function resetRunOverflowCompactionHarnessMocks(): void {
  // Loading and warmup can run inside an already-owned environment. Only the
  // per-test reset restores stubbed env, before the next fixture applies it.
  resetCommandQueueStateForTest();
  resetMockAgentHarness();
  mockedGlobalHookRunner.hasHooks.mockReset();
  mockedGlobalHookRunner.hasHooks.mockReturnValue(false);
  mockedGlobalHookRunner.runBeforeAgentReply.mockReset();
  mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue(undefined);
  mockedGlobalHookRunner.runBeforeAgentFinalize.mockReset();
  mockedGlobalHookRunner.runBeforeAgentFinalize.mockResolvedValue(undefined);
  mockedGlobalHookRunner.runBeforePromptBuild.mockReset();
  mockedGlobalHookRunner.runBeforePromptBuild.mockResolvedValue(undefined);
  mockedGlobalHookRunner.runBeforeModelResolve.mockReset();
  mockedGlobalHookRunner.runBeforeModelResolve.mockResolvedValue(undefined);
  mockedGlobalHookRunner.runBeforeCompaction.mockReset();
  mockedGlobalHookRunner.runBeforeCompaction.mockResolvedValue(undefined);
  mockedGlobalHookRunner.runAfterCompaction.mockReset();
  mockedGlobalHookRunner.runAfterCompaction.mockResolvedValue(undefined);

  mockedContextEngine.info.ownsCompaction = false;
  mockedResolveContextEngine.mockReset();
  mockedResolveContextEngine.mockResolvedValue(mockedContextEngine);
  mockedBuildAgentRuntimePlan.mockReset();
  mockedAcquireAgentRunPreparedModelRuntime.mockClear();
  mockedBuildAgentRuntimePlan.mockImplementation(buildMockAgentRuntimePlan);
  mockedCompactDirect.mockReset();
  mockedCompactDirect.mockResolvedValue({
    ok: false,
    compacted: false,
    reason: "nothing to compact",
  });

  mockedCreateEmptyAgentDiscoveryStores.mockReset();
  mockedCreateEmptyAgentDiscoveryStores.mockImplementation(createMockAgentDiscoveryStores);
  mockedResolveModelAsync.mockReset();
  mockedResolveModelAsync.mockImplementation(
    async (provider?: string, modelId?: string, _agentDir?: string, cfg?: unknown) =>
      createMockResolvedModel(provider, modelId, cfg),
  );
  mockedPrepareProviderRuntimeAuth.mockReset();
  mockedPrepareProviderRuntimeAuth.mockResolvedValue(undefined);
  mockedRunEmbeddedAttempt.mockReset();
  mockedBuildEmbeddedRunPayloads.mockReset();
  mockedBuildEmbeddedRunPayloads.mockReturnValue([]);
  mockedRunContextEngineMaintenance.mockReset();
  mockedRunContextEngineMaintenance.mockResolvedValue(undefined);
  mockedWaitForDeferredTurnMaintenanceForSession.mockReset();
  mockedWaitForDeferredTurnMaintenanceForSession.mockResolvedValue(undefined);
  mockedSessionLikelyHasOversizedToolResults.mockReset();
  mockedSessionLikelyHasOversizedToolResults.mockReturnValue(false);
  mockedResolveLiveToolResultMaxChars.mockReset();
  mockedResolveLiveToolResultMaxChars.mockReturnValue(32_000);
  mockedTruncateOversizedToolResultsInSession.mockReset();
  mockedTruncateOversizedToolResultsInSession.mockReturnValue({
    truncated: false,
    truncatedCount: 0,
    reason: "no oversized tool results",
  });

  mockedCoerceToFailoverError.mockReset();
  mockedCoerceToFailoverError.mockReturnValue(null);
  mockedDescribeFailoverError.mockReset();
  mockedDescribeFailoverError.mockImplementation(
    (err: unknown): MockFailoverErrorDescription => ({
      message: formatErrorMessage(err),
      reason: undefined,
      status: undefined,
      code: undefined,
    }),
  );
  mockedResolveFailoverStatus.mockReset();
  mockedResolveFailoverStatus.mockReturnValue(undefined);

  mockedLog.debug.mockReset();
  mockedLog.info.mockReset();
  mockedLog.warn.mockReset();
  mockedLog.error.mockReset();
  mockedLog.isEnabled.mockReset();
  mockedLog.isEnabled.mockReturnValue(false);

  mockedClassifyFailoverReason.mockReset();
  mockedClassifyFailoverReason.mockReturnValue(null);
  mockedClassifyAssistantFailoverReason.mockReset();
  mockedClassifyAssistantFailoverReason.mockImplementation(
    (assistant?: { errorMessage?: string | null }): FailoverReason | null =>
      mockedClassifyFailoverReason(assistant?.errorMessage ?? ""),
  );
  mockedFormatBillingErrorMessage.mockReset();
  mockedFormatBillingErrorMessage.mockReturnValue("");
  mockedFormatAssistantErrorText.mockReset();
  mockedFormatAssistantErrorText.mockReturnValue("");
  mockedIsAuthAssistantError.mockReset();
  mockedIsAuthAssistantError.mockReturnValue(false);
  mockedIsBillingAssistantError.mockReset();
  mockedIsBillingAssistantError.mockReturnValue(false);
  mockedExtractObservedOverflowTokenCount.mockReset();
  mockedExtractObservedOverflowTokenCount.mockImplementation(extractObservedOverflowTokenCount);
  mockedIsCompactionFailureError.mockReset();
  mockedIsCompactionFailureError.mockReturnValue(false);
  mockedIsFailoverAssistantError.mockReset();
  mockedIsFailoverAssistantError.mockReturnValue(false);
  mockedIsFailoverErrorMessage.mockReset();
  mockedIsFailoverErrorMessage.mockReturnValue(false);
  mockedIsGenericUnknownStreamErrorMessage.mockReset();
  mockedIsGenericUnknownStreamErrorMessage.mockImplementation((raw: string) =>
    /^\s*an unknown error occurred\.?\s*$/i.test(raw),
  );
  mockedIsLikelyContextOverflowError.mockReset();
  mockedIsLikelyContextOverflowError.mockImplementation(matchesCanonicalOverflowFixture);
  mockedParseImageSizeError.mockReset();
  mockedParseImageSizeError.mockReturnValue(null);
  mockedParseImageDimensionError.mockReset();
  mockedParseImageDimensionError.mockReturnValue(null);
  mockedIsRateLimitAssistantError.mockReset();
  mockedIsRateLimitAssistantError.mockReturnValue(false);
  mockedIsTimeoutErrorMessage.mockReset();
  mockedIsTimeoutErrorMessage.mockReturnValue(false);
  mockedPickFallbackThinkingLevel.mockReset();
  mockedPickFallbackThinkingLevel.mockReturnValue(null);
  mockedEvaluateContextWindowGuard.mockReset();
  mockedEvaluateContextWindowGuard.mockReturnValue({
    shouldWarn: false,
    shouldBlock: false,
    tokens: 200000,
    source: "model",
    hardMinTokens: 1000,
    warnBelowTokens: 5000,
  });
  mockedResolveContextWindowInfo.mockReset();
  mockedResolveContextWindowInfo.mockReturnValue({
    tokens: 200000,
    source: "model",
  });
  mockedFormatContextWindowWarningMessage.mockReset();
  mockedFormatContextWindowWarningMessage.mockImplementation(
    (params: { provider: string; modelId: string; guard: { tokens: number; source: string } }) =>
      `low context window: ${params.provider}/${params.modelId} ctx=${params.guard.tokens} source=${params.guard.source}`,
  );
  mockedFormatContextWindowBlockMessage.mockReset();
  mockedFormatContextWindowBlockMessage.mockImplementation(
    (params: { guard: { tokens: number; source: string } }) =>
      `Model context window too small (${params.guard.tokens} tokens; source=${params.guard.source}). Minimum is 1000.`,
  );
  mockedGetApiKeyForModel.mockReset();
  mockedGetApiKeyForModel.mockImplementation(
    async ({ profileId }: MockGetApiKeyForModelParams = {}) => ({
      apiKey: "test-key",
      profileId: profileId ?? "test-profile",
      source: "test",
      mode: "api-key",
    }),
  );
  mockedIsProfileInCooldown.mockReset();
  mockedIsProfileInCooldown.mockReturnValue(false);
  mockedMarkAuthProfileFailure.mockReset();
  mockedMarkAuthProfileFailure.mockResolvedValue(undefined);
  mockedEnsureAuthProfileStore.mockReset();
  mockedEnsureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
  mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReset();
  mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
    version: 1,
    profiles: {},
  });
  mockedResolveAuthProfileOrder.mockReset();
  mockedResolveAuthProfileOrder.mockReturnValue([]);
  mockedResolveAuthProfileOrderWithMetadata.mockReset();
  mockedResolveAuthProfileOrderWithMetadata.mockImplementation((params?: unknown) => ({
    profileIds: mockedResolveAuthProfileOrder(params),
    hasExplicitOrder: false,
  }));
  mockedResolveProviderEntryApiKeyProfileReference.mockReset();
  mockedResolveProviderEntryApiKeyProfileReference.mockReturnValue({ kind: "none" });
  mockedHasUsableCustomProviderApiKey.mockReset();
  mockedHasUsableCustomProviderApiKey.mockReturnValue(false);
  mockedMarkAuthProfileSuccess.mockReset();
  mockedMarkAuthProfileSuccess.mockResolvedValue(undefined);
  mockedShouldPreferExplicitConfigApiKeyAuth.mockReset();
  mockedShouldPreferExplicitConfigApiKeyAuth.mockReturnValue(false);
  mockedRunPostCompactionSideEffects.mockReset();
  mockedRunPostCompactionSideEffects.mockResolvedValue(undefined);
  mockedSleepWithAbort.mockReset();
  mockedSleepWithAbort.mockResolvedValue(undefined);
}

/** Reset only the seams mutated by the shared public-entry integration suites. */
export function resetSharedRunIntegrationHarnessMocks(): void {
  vi.unstubAllEnvs();
  resetCommandQueueStateForTest();
  resetMockAgentHarness();

  mockedBuildAgentRuntimePlan.mockReset();
  mockedBuildAgentRuntimePlan.mockImplementation(buildMockAgentRuntimePlan);

  mockedBuildEmbeddedRunPayloads.mockReset();
  mockedBuildEmbeddedRunPayloads.mockReturnValue([]);
  mockedClassifyFailoverReason.mockReset();
  mockedClassifyFailoverReason.mockReturnValue(null);
  mockedClassifyAssistantFailoverReason.mockReset();
  mockedClassifyAssistantFailoverReason.mockImplementation(
    (assistant?: { errorMessage?: string | null }): FailoverReason | null =>
      mockedClassifyFailoverReason(assistant?.errorMessage ?? ""),
  );
  mockedCompactDirect.mockReset();
  mockedCompactDirect.mockResolvedValue({
    ok: false,
    compacted: false,
    reason: "nothing to compact",
  });
  mockedEnsureAuthProfileStore.mockReset();
  mockedEnsureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
  mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReset();
  mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
    version: 1,
    profiles: {},
  });
  mockedFormatAssistantErrorText.mockReset();
  mockedFormatAssistantErrorText.mockReturnValue("");
  mockedGetApiKeyForModel.mockReset();
  mockedGetApiKeyForModel.mockImplementation(
    async ({ profileId }: MockGetApiKeyForModelParams = {}) => ({
      apiKey: "test-key",
      profileId: profileId ?? "test-profile",
      source: "test",
      mode: "api-key",
    }),
  );
  mockedGlobalHookRunner.hasHooks.mockReset();
  mockedGlobalHookRunner.hasHooks.mockReturnValue(false);
  mockedGlobalHookRunner.runBeforeAgentReply.mockReset();
  mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue(undefined);
  mockedIsCompactionFailureError.mockReset();
  mockedIsCompactionFailureError.mockReturnValue(false);
  mockedIsFailoverAssistantError.mockReset();
  mockedIsFailoverAssistantError.mockReturnValue(false);
  mockedIsLikelyContextOverflowError.mockReset();
  mockedIsLikelyContextOverflowError.mockImplementation(matchesCanonicalOverflowFixture);
  mockedIsRateLimitAssistantError.mockReset();
  mockedIsRateLimitAssistantError.mockReturnValue(false);
  mockedResolveAuthProfileOrder.mockReset();
  mockedResolveAuthProfileOrder.mockReturnValue([]);
  mockedResolveModelAsync.mockReset();
  mockedResolveModelAsync.mockImplementation(
    async (provider?: string, modelId?: string, _agentDir?: string, cfg?: unknown) =>
      createMockResolvedModel(provider, modelId, cfg),
  );
  mockedRunEmbeddedAttempt.mockReset();

  mockedAcquireAgentRunPreparedModelRuntime.mockClear();
  mockedLog.warn.mockClear();
  mockedMarkAuthProfileFailure.mockClear();
  mockedSleepWithAbort.mockClear();
}

/** Install module mocks, import the runner, and return the mocked entrypoint. */
export async function loadRunOverflowCompactionHarness(): Promise<{
  registerPreparedAgentHarness: typeof import("../harness/registry.js").registerAgentHarness;
  runEmbeddedAgent: TestRunEmbeddedAgent;
}> {
  resetRunOverflowCompactionHarnessMocks();
  vi.resetModules();

  vi.doMock("../../plugins/hook-runner-global.js", () => ({
    getGlobalHookRunner: vi.fn(() => mockedGlobalHookRunner),
    initializeGlobalHookRunner: vi.fn(),
  }));

  vi.doMock("../../context-engine/init.js", () => ({
    ensureContextEnginesInitialized: vi.fn(),
  }));
  vi.doMock("../../infra/backoff.js", () => ({
    sleepWithAbort: mockedSleepWithAbort,
  }));
  vi.doMock("../../context-engine/registry.js", () => ({
    resolveContextEngine: mockedResolveContextEngine,
    resolveContextEngineOwnerPluginId: mockedResolveContextEngineOwnerPluginId,
    resolveLogicalTurnContextEngines: async () => {
      const engine = await mockedResolveContextEngine();
      const ref = { engine, registeredId: "legacy" };
      return { configured: ref, configuredId: "legacy", fallback: ref };
    },
  }));

  vi.doMock("../harness/runtime-plugin.js", () => ({
    ensureSelectedAgentHarnessPlugin: vi.fn(async () => {}),
  }));

  vi.doMock("../runtime-plan/build.js", () => ({
    buildAgentRuntimePlan: mockedBuildAgentRuntimePlan,
  }));

  vi.doMock("../model-runtime-aliases.js", () => ({
    isCliRuntimeAliasForProvider: ({
      runtime,
      provider,
    }: {
      runtime?: string;
      provider?: string;
    }) =>
      (provider?.trim().toLowerCase() === "anthropic" &&
        runtime?.trim().toLowerCase() === "claude-cli") ||
      (provider?.trim().toLowerCase() === "openai" &&
        runtime?.trim().toLowerCase() === "codex-cli"),
    resolveCliRuntimeExecutionProvider: ({
      provider,
      cfg,
      modelId,
    }: {
      provider?: string;
      cfg?: {
        agents?: {
          defaults?: {
            models?: Record<string, { agentRuntime?: { id?: string } }>;
          };
        };
      };
      modelId?: string;
    }) => {
      const key = provider && modelId ? `${provider}/${modelId}` : undefined;
      const runtime = key
        ? cfg?.agents?.defaults?.models?.[key]?.agentRuntime?.id?.trim()
        : undefined;
      return runtime || undefined;
    },
  }));

  vi.doMock("../../plugins/provider-runtime.js", () => ({
    prepareProviderRuntimeAuth: mockedPrepareProviderRuntimeAuth,
    resolveProviderCapabilitiesWithPlugin: vi.fn(() => ({})),
    resolveProviderAuthProfileId: vi.fn(() => undefined),
    resolveProviderReasoningOutputModeWithPlugin: vi.fn(() => undefined),
    shouldPreferProviderRuntimeResolvedModel: vi.fn(() => false),
    prepareProviderExtraParams: vi.fn(async () => ({})),
    wrapProviderStreamFn: vi.fn((_cfg: unknown, _model: unknown, fn: unknown) => fn),
  }));
  // Runtime preparation already carries the fixture's provider facts. Keep the
  // real handle shape without rediscovering every bundled provider plugin.
  vi.doMock("../../plugins/provider-hook-runtime.js", () => ({
    attachModelProviderRuntimePluginHandle: (model: object) => model,
    resolveProviderRuntimePluginHandle: vi.fn((params: Record<string, unknown>) => params),
  }));
  vi.doMock("../auth-profiles.js", () => ({
    isProfileInCooldown: mockedIsProfileInCooldown,
    markAuthProfileFailure: mockedMarkAuthProfileFailure,
    markAuthProfileSuccess: mockedMarkAuthProfileSuccess,
    resolveAuthProfileEligibility: vi.fn(() => ({ eligible: true, reasonCode: "ok" })),
    resolveProfilesUnavailableReason: vi.fn(() => undefined),
  }));

  vi.doMock("../auth-profiles/order.js", async () => {
    const actual = await vi.importActual<typeof import("../auth-profiles/order.js")>(
      "../auth-profiles/order.js",
    );
    return {
      ...actual,
      resolveAuthProfileOrderWithMetadata: mockedResolveAuthProfileOrderWithMetadata,
    };
  });

  vi.doMock("../cli-backends.js", async () => {
    const actual = await vi.importActual<typeof import("../cli-backends.js")>("../cli-backends.js");
    type ResolveBindingParams = Parameters<typeof actual.resolveCliRuntimeModelBackendBinding>[0];
    type ProviderCheckParams = Parameters<typeof actual.isCliRuntimeModelBackendForProvider>[0];
    const claudeBinding = {
      provider: "anthropic",
      runtime: "claude-cli",
      pluginId: "anthropic",
    };
    return {
      ...actual,
      listCliRuntimeModelBackendBindings: vi.fn((params?: unknown) => [
        claudeBinding,
        ...actual
          .listCliRuntimeModelBackendBindings(
            params as Parameters<typeof actual.listCliRuntimeModelBackendBindings>[0],
          )
          .filter(
            (binding) =>
              binding.provider !== claudeBinding.provider ||
              binding.runtime !== claudeBinding.runtime,
          ),
      ]),
      listCliRuntimeProviderIds: vi.fn(() => ["claude-cli"]),
      resolveCliRuntimeModelBackendBinding: vi.fn((params: ResolveBindingParams) =>
        params.provider === claudeBinding.provider && params.runtime === claudeBinding.runtime
          ? claudeBinding
          : actual.resolveCliRuntimeModelBackendBinding(params),
      ),
      isCliRuntimeModelBackendForProvider: vi.fn((params: ProviderCheckParams) =>
        params.provider === claudeBinding.provider && params.runtime === claudeBinding.runtime
          ? true
          : actual.isCliRuntimeModelBackendForProvider(params),
      ),
    };
  });

  vi.doMock("../workspace-run.js", () => ({
    resolveRunWorkspaceDir: vi.fn((params: { workspaceDir: string; agentId?: string }) => ({
      workspaceDir: params.workspaceDir,
      usedFallback: false,
      isCanonicalWorkspace: false,
      fallbackReason: undefined,
      agentId: params.agentId ?? "main",
    })),
    redactRunIdentifier: vi.fn((value?: string) => value ?? ""),
  }));

  vi.doMock("../embedded-agent-helpers.js", async () => ({
    ...(await vi.importActual<typeof import("../embedded-agent-helpers.js")>(
      "../embedded-agent-helpers.js",
    )),
    formatBillingErrorMessage: mockedFormatBillingErrorMessage,
    classifyFailoverReason: mockedClassifyFailoverReason,
    classifyAssistantFailoverReason: mockedClassifyAssistantFailoverReason,
    extractObservedOverflowTokenCount: mockedExtractObservedOverflowTokenCount,
    formatAssistantErrorText: mockedFormatAssistantErrorText,
    isAuthAssistantError: mockedIsAuthAssistantError,
    isBillingAssistantError: mockedIsBillingAssistantError,
    isCompactionFailureError: mockedIsCompactionFailureError,
    isLikelyContextOverflowError: mockedIsLikelyContextOverflowError,
    isFailoverAssistantError: mockedIsFailoverAssistantError,
    isFailoverErrorMessage: mockedIsFailoverErrorMessage,
    isGenericUnknownStreamErrorMessage: mockedIsGenericUnknownStreamErrorMessage,
    parseImageSizeError: mockedParseImageSizeError,
    parseImageDimensionError: mockedParseImageDimensionError,
    isRateLimitAssistantError: mockedIsRateLimitAssistantError,
    isTimeoutErrorMessage: mockedIsTimeoutErrorMessage,
    pickFallbackThinkingLevel: mockedPickFallbackThinkingLevel,
    sanitizeUserFacingText: vi.fn((text: unknown) => (typeof text === "string" ? text : "")),
  }));

  vi.doMock("./run/attempt.js", () => ({
    runEmbeddedAttempt: mockedRunEmbeddedAttempt,
  }));

  vi.doMock("./tool-result-truncation.js", () => ({
    resolveLiveToolResultMaxChars: mockedResolveLiveToolResultMaxChars,
    sessionLikelyHasOversizedToolResults: mockedSessionLikelyHasOversizedToolResults,
    truncateOversizedToolResultsInSessionManager: mockedTruncateOversizedToolResultsInSession,
  }));

  vi.doMock("./context-engine-maintenance.js", () => ({
    runContextEngineMaintenance: mockedRunContextEngineMaintenance,
    waitForDeferredTurnMaintenanceForSession: mockedWaitForDeferredTurnMaintenanceForSession,
  }));

  vi.doMock("./model.js", () => ({
    createEmptyAgentDiscoveryStores: mockedCreateEmptyAgentDiscoveryStores,
    resolveModelAsync: mockedResolveModelAsync,
  }));

  vi.doMock("../model-auth.js", () => ({
    applyAuthHeaderOverride: vi.fn((model: unknown) => model),
    applyLocalNoAuthHeaderOverride: vi.fn((model: unknown) => model),
    ensureAuthProfileStore: mockedEnsureAuthProfileStore,
    ensureAuthProfileStoreWithoutExternalProfiles:
      mockedEnsureAuthProfileStoreWithoutExternalProfiles,
    getApiKeyForModelCore: mockedGetApiKeyForModel,
    hasUsableCustomProviderApiKey: mockedHasUsableCustomProviderApiKey,
    resolveAuthProfileOrder: mockedResolveAuthProfileOrder,
    resolveAuthProfileOrderWithMetadata: mockedResolveAuthProfileOrderWithMetadata,
    resolveProviderEntryApiKeyProfileReference: mockedResolveProviderEntryApiKeyProfileReference,
    shouldPreferExplicitConfigApiKeyAuth: mockedShouldPreferExplicitConfigApiKeyAuth,
  }));

  // Auth policy remains real; only manifest-derived discovery facts are
  // prepared here so the shared runner does not rescan all bundled plugins.
  vi.doMock("../model-auth-env-vars.js", () => ({
    listKnownProviderEnvApiKeyNames: vi.fn(() => ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]),
    listProviderEnvAuthLookupKeys: vi.fn(() => ["anthropic"]),
    resolveProviderEnvAuthLookupMaps: vi.fn(() => ({
      aliasMap: {},
      envCandidateMap: {
        anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
      },
      authEvidenceMap: {},
      setupProviderFallbackRefs: ["anthropic"],
    })),
  }));

  vi.doMock("../models-config.js", () => ({
    ensureOpenClawModelsJson: vi.fn(async () => {}),
  }));

  vi.doMock("../prepared-model-runtime.js", () => ({
    activateStandalonePreparedModelRuntime: vi.fn(async () => {}),
    acquireAgentRunPreparedModelRuntime: mockedAcquireAgentRunPreparedModelRuntime,
    acquireReadOnlyPreparedModelRuntime: mockedAcquireAgentRunPreparedModelRuntime,
    prepareModelRuntimeSnapshot: vi.fn(async () => ({
      createStores: () => ({ authStorage: {}, modelRegistry: {} }),
    })),
  }));

  vi.doMock("../context-window-guard.js", () => ({
    CONTEXT_WINDOW_HARD_MIN_TOKENS: 1000,
    evaluateContextWindowGuard: mockedEvaluateContextWindowGuard,
    formatContextWindowBlockMessage: mockedFormatContextWindowBlockMessage,
    formatContextWindowWarningMessage: mockedFormatContextWindowWarningMessage,
    resolveContextWindowInfo: mockedResolveContextWindowInfo,
  }));

  vi.doMock("../../utils/message-channel.js", async () => {
    const actual = await vi.importActual<typeof import("../../utils/message-channel.js")>(
      "../../utils/message-channel.js",
    );
    return {
      ...actual,
      isMarkdownCapableMessageChannel: vi.fn(() => true),
    };
  });

  vi.doMock("../defaults.js", () => ({
    DEFAULT_CONTEXT_TOKENS: 200000,
    DEFAULT_MODEL: "test-model",
    DEFAULT_PROVIDER: "anthropic",
  }));

  vi.doMock("../failover-error.js", async () => ({
    ...(await vi.importActual<typeof import("../failover-error.js")>("../failover-error.js")),
    FailoverError: MockedFailoverError,
    coerceToFailoverError: mockedCoerceToFailoverError,
    describeFailoverError: mockedDescribeFailoverError,
    isFailoverError: (error: unknown) => error instanceof MockedFailoverError,
    resolveFailoverStatus: mockedResolveFailoverStatus,
  }));

  vi.doMock("./lanes.js", () => ({
    resolveSessionLane: vi.fn((key: string) => `session:${key}`),
    resolveEmbeddedSessionLane: vi.fn((key: string) => `session:${key}`),
    resolveGlobalLane: vi.fn(() => "global-lane"),
  }));

  vi.doMock("./logger.js", () => ({
    log: mockedLog,
  }));

  vi.doMock("./run/payloads.js", () => ({
    buildEmbeddedRunPayloads: mockedBuildEmbeddedRunPayloads,
  }));

  vi.doMock("./compaction-hooks.js", () => ({
    runPostCompactionSideEffects: mockedRunPostCompactionSideEffects,
  }));

  vi.doMock("./utils.js", async () => {
    const actual = await vi.importActual<typeof import("./utils.js")>("./utils.js");
    return {
      ...actual,
      describeUnknownError: vi.fn((err: unknown) => {
        if (err instanceof Error) {
          return err.message;
        }
        return String(err);
      }),
    };
  });

  const { createOperationalRunInstanceRef, prepareAgentRunAdmission } =
    await import("../admitted-run-context.js");
  const { runEmbeddedAgent } = await import("./run.js");
  const preparedRegistry = await import("../harness/registry.js");
  return {
    runEmbeddedAgent: async (params) => {
      const agentId = params.agentId ?? "main";
      const preparedRunAdmission =
        params.preparedRunAdmission ??
        prepareAgentRunAdmission({
          cfg: params.config ?? {},
          operationalRunInstance: createOperationalRunInstanceRef(params.runId),
          facts: {
            runId: params.runId,
            agentId,
            ingress: {
              kind: "system",
              boundary: "run-overflow-compaction-harness",
              state: "present",
            },
          },
        });
      try {
        return await runEmbeddedAgent({
          ...params,
          preparedRunAdmission,
          agentId,
        });
      } finally {
        preparedRunAdmission.close();
      }
    },
    registerPreparedAgentHarness: preparedRegistry.registerAgentHarness,
  };
}

/** Move one-time runner compilation out of individual behavior timings. */
export async function warmRunOverflowCompactionHarness(
  runEmbeddedAgent: TestRunEmbeddedAgent,
  state: Pick<OpenClawTestState, "workspaceDir">,
  params?: Partial<Parameters<typeof runEmbeddedAgent>[0]>,
): Promise<void> {
  resetRunOverflowCompactionHarnessMocks();
  mockedGlobalHookRunner.hasHooks.mockReturnValue(false);
  mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "warmup" }]);
  mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["warmup"] }));
  await runEmbeddedAgent({
    ...createOverflowRunParams(state),
    ...params,
    runId: params?.runId ?? "run-overflow-compaction-harness-warmup",
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

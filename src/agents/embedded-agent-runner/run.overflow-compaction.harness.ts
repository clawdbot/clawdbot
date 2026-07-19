/**
 * Test harness mocks for embedded-run overflow compaction coverage.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { type Mock, vi } from "vitest";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { ContextEngineSessionTarget } from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  PluginHookBeforeAgentFinalizeEvent,
  PluginHookBeforeAgentFinalizeResult,
} from "../../plugins/hook-types.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentReplyResult,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildResult,
} from "../../plugins/types.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import type { FailoverReason } from "../embedded-agent-helpers/types.js";
import { clearAgentHarnesses, registerAgentHarness } from "../harness/registry.js";
import type { ResolvedProviderAuth } from "../model-auth-runtime-shared.js";
import type { AgentRuntimePlan } from "../runtime-plan/types.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import type { buildEmbeddedRunPayloads } from "./run/payloads.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

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
  runBeforeAgentStart: vi.fn(
    async (
      _eventValue: { prompt: string; messages?: unknown[] },
      _ctx: PluginHookAgentContext,
    ): Promise<PluginHookBeforeAgentStartResult | undefined> => undefined,
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

export const mockedContextEngine = {
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
export const mockedBuildAgentRuntimePlan = vi.fn<() => AgentRuntimePlan>(
  () => makeMockRuntimePlan() as AgentRuntimePlan,
);
export const mockedRunPostCompactionSideEffects = vi.fn(async () => {});
export const mockedSleepWithAbort = vi.fn(
  async (_ms: number, _abortSignal?: AbortSignal) => undefined,
);
export const mockedEnsureRuntimePluginsLoaded = vi.fn<(params?: unknown) => void>();
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
const mockedPrepareProviderRuntimeAuth = vi.fn(async () => undefined);
export const mockedRunEmbeddedAttempt =
  vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();
export const mockedBuildEmbeddedRunPayloads = vi.fn<
  (
    ...args: Parameters<typeof buildEmbeddedRunPayloads>
  ) => ReturnType<typeof buildEmbeddedRunPayloads>
>(() => []);
export const mockedRunContextEngineMaintenance = vi.fn(async () => undefined);
export const mockedWaitForDeferredTurnMaintenanceForSession = vi.fn(
  async (_sessionKey?: string) => undefined,
);
export const mockedSessionLikelyHasOversizedToolResults = vi.fn(() => false);
const mockedResolveLiveToolResultMaxChars = vi.fn(() => 32_000);
type MockTruncateOversizedToolResultsResult = {
  truncated: boolean;
  truncatedCount: number;
  reason?: string;
};
export const mockedTruncateOversizedToolResultsInSession = vi.fn<
  () => Promise<MockTruncateOversizedToolResultsResult>
>(async () => ({
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

export const mockedCoerceToFailoverError = vi.fn<MockCoerceToFailoverError>();
export const mockedDescribeFailoverError = vi.fn<MockDescribeFailoverError>(
  (err: unknown): MockFailoverErrorDescription => ({
    message: formatErrorMessage(err),
    reason: undefined,
    status: undefined,
    code: undefined,
  }),
);
export const mockedResolveFailoverStatus = vi.fn<MockResolveFailoverStatus>();

export const mockedLog: {
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
export const mockedExtractObservedOverflowTokenCount = vi.fn((msg?: string) => {
  const match = msg?.match(/prompt is too long:\s*([\d,]+)\s+tokens\s*>\s*[\d,]+\s+maximum/i);
  return match?.[1] ? Number(match[1].replaceAll(",", "")) : undefined;
});
export const mockedFormatAssistantErrorText = vi.fn(() => "");
const mockedIsAuthAssistantError = vi.fn(() => false);
const mockedIsBillingAssistantError = vi.fn(() => false);
export const mockedIsCompactionFailureError = vi.fn(() => false);
export const mockedIsFailoverAssistantError = vi.fn<MockAssistantErrorProbe>(() => false);
const mockedIsFailoverErrorMessage = vi.fn(() => false);
const mockedIsGenericUnknownStreamErrorMessage = vi.fn((raw: string) =>
  /^\s*an unknown error occurred\.?\s*$/i.test(raw),
);
export const mockedIsLikelyContextOverflowError = vi.fn((msg?: string) => {
  const lower = normalizeLowercaseStringOrEmpty(msg ?? "");
  return (
    lower.includes("request_too_large") ||
    lower.includes("context window exceeded") ||
    (lower.includes("context window") && lower.includes("ran out of room")) ||
    lower.includes("prompt is too long")
  );
});
const mockedParseImageSizeError = vi.fn(() => null);
const mockedParseImageDimensionError = vi.fn(() => null);
export const mockedIsRateLimitAssistantError = vi.fn<MockAssistantErrorProbe>(() => false);
const mockedIsTimeoutErrorMessage = vi.fn(() => false);
export const mockedPickFallbackThinkingLevel = vi.fn<(params?: unknown) => ThinkLevel | null>(
  () => null,
);
export const mockedEvaluateContextWindowGuard = vi.fn(() => ({
  shouldWarn: false,
  shouldBlock: false,
  tokens: 200000,
  source: "model",
  hardMinTokens: 1000,
  warnBelowTokens: 5000,
}));
export const mockedResolveContextWindowInfo = vi.fn(() => ({
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
export const mockedIsProfileInCooldown = vi.fn(
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
export const mockedResolveProviderEntryApiKeyProfileReference = vi.fn<
  (_params?: unknown) => unknown
>(() => ({ kind: "none" }));
const mockedHasUsableCustomProviderApiKey = vi.fn(() => false);
export const mockedMarkAuthProfileSuccess = vi.fn(async () => {});
const mockedShouldPreferExplicitConfigApiKeyAuth = vi.fn(() => false);

export const overflowBaseRunParams = {
  sessionId: "test-session",
  sessionKey: "test-key",
  sessionFile: "/tmp/session.json",
  workspaceDir: "/tmp/workspace",
  prompt: "hello",
  timeoutMs: 30000,
  runId: "run-1",
} as const;

/** Reset every mocked runner dependency to the default successful no-op state. */
export function resetRunOverflowCompactionHarnessMocks(): void {
  vi.unstubAllEnvs();
  resetCommandQueueStateForTest();
  clearAgentHarnesses();
  registerAgentHarness({
    id: "codex",
    label: "Codex",
    supports: (ctx) =>
      ctx.provider === "codex" || ctx.provider === "openai" || ctx.provider === "openai"
        ? { supported: true, priority: 100 }
        : { supported: false },
    runAttempt: async (params) => await mockedRunEmbeddedAttempt(params),
  });

  mockedGlobalHookRunner.hasHooks.mockReset();
  mockedGlobalHookRunner.hasHooks.mockReturnValue(false);
  mockedGlobalHookRunner.runBeforeAgentReply.mockReset();
  mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue(undefined);
  mockedGlobalHookRunner.runBeforeAgentStart.mockReset();
  mockedGlobalHookRunner.runBeforeAgentStart.mockResolvedValue(undefined);
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
  mockedBuildAgentRuntimePlan.mockImplementation(() => makeMockRuntimePlan() as AgentRuntimePlan);
  mockedCompactDirect.mockReset();
  mockedCompactDirect.mockResolvedValue({
    ok: false,
    compacted: false,
    reason: "nothing to compact",
  });

  mockedEnsureRuntimePluginsLoaded.mockReset();
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
  mockedTruncateOversizedToolResultsInSession.mockResolvedValue({
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
  mockedExtractObservedOverflowTokenCount.mockImplementation((msg?: string) => {
    const match = msg?.match(/prompt is too long:\s*([\d,]+)\s+tokens\s*>\s*[\d,]+\s+maximum/i);
    return match?.[1] ? Number(match[1].replaceAll(",", "")) : undefined;
  });
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
  mockedIsLikelyContextOverflowError.mockImplementation((msg?: string) => {
    const lower = normalizeLowercaseStringOrEmpty(msg ?? "");
    return (
      lower.includes("request_too_large") ||
      lower.includes("context window exceeded") ||
      (lower.includes("context window") && lower.includes("ran out of room")) ||
      lower.includes("prompt is too long")
    );
  });
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

/** Install module mocks, import the runner, and return the mocked entrypoint. */
export async function loadRunOverflowCompactionHarness(): Promise<{
  runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;
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
  }));

  vi.doMock("../runtime-plugins.js", () => ({
    ensureRuntimePluginsLoaded: mockedEnsureRuntimePluginsLoaded,
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
    shouldPreferProviderRuntimeResolvedModel: vi.fn(() => false),
    prepareProviderExtraParams: vi.fn(async () => ({})),
    wrapProviderStreamFn: vi.fn((_cfg: unknown, _model: unknown, fn: unknown) => fn),
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

  vi.doMock("../usage.js", () => ({
    normalizeUsage: vi.fn((usage?: unknown) =>
      usage && typeof usage === "object" ? usage : undefined,
    ),
    hasNonzeroUsage: vi.fn(
      (usage?: {
        total?: number;
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        reasoningTokens?: number;
      }) =>
        [
          usage?.total,
          usage?.input,
          usage?.output,
          usage?.cacheRead,
          usage?.cacheWrite,
          usage?.reasoningTokens,
        ].some((value) => (value ?? 0) > 0),
    ),
    derivePromptTokens: vi.fn(
      (usage?: { input?: number; cacheRead?: number; cacheWrite?: number }) =>
        usage
          ? (() => {
              const sum = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
              return sum > 0 ? sum : undefined;
            })()
          : undefined,
    ),
    deriveContextPromptTokens: vi.fn(
      (params: {
        lastCallUsage?: {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          contextUsage?:
            | { state: "available"; promptTokens: number; totalTokens: number }
            | { state: "unavailable" };
          total?: number;
        };
        promptTokens?: number;
        usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
      }) => {
        if (
          typeof params.promptTokens === "number" &&
          Number.isFinite(params.promptTokens) &&
          params.promptTokens > 0
        ) {
          return params.promptTokens;
        }
        const lastCall = params.lastCallUsage;
        if (lastCall?.contextUsage?.state === "available") {
          return lastCall.contextUsage.promptTokens;
        }
        if (lastCall?.contextUsage?.state === "unavailable") {
          return undefined;
        }
        for (const usage of [lastCall, params.usage]) {
          const promptTokens =
            (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
          if (promptTokens > 0) {
            return promptTokens;
          }
        }
        return undefined;
      },
    ),
  }));

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

  vi.doMock("../embedded-agent-helpers.js", () => ({
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
    truncateOversizedToolResultsInActiveTarget: mockedTruncateOversizedToolResultsInSession,
    truncateOversizedToolResultsInSession: mockedTruncateOversizedToolResultsInSession,
    truncateOversizedToolResultsInRuntimeTranscript: mockedTruncateOversizedToolResultsInSession,
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
    getApiKeyForModel: mockedGetApiKeyForModel,
    hasUsableCustomProviderApiKey: mockedHasUsableCustomProviderApiKey,
    resolveAuthProfileOrder: mockedResolveAuthProfileOrder,
    resolveAuthProfileOrderWithMetadata: mockedResolveAuthProfileOrderWithMetadata,
    resolveProviderEntryApiKeyProfileReference: mockedResolveProviderEntryApiKeyProfileReference,
    shouldPreferExplicitConfigApiKeyAuth: mockedShouldPreferExplicitConfigApiKeyAuth,
  }));

  vi.doMock("../models-config.js", () => ({
    ensureOpenClawModelsJson: vi.fn(async () => {}),
  }));

  vi.doMock("../prepared-model-runtime.js", () => ({
    activateStandalonePreparedModelRuntime: vi.fn(async () => {}),
    acquireAgentRunPreparedModelRuntime: vi.fn(async (input: Record<string, unknown>) => ({
      snapshot: {
        agentId: input.agentId,
        agentDir: input.agentDir,
        config: input.config,
        workspaceDir: input.workspaceDir,
        createStores: () => ({ authStorage: {}, modelRegistry: {} }),
      },
      release: vi.fn(),
    })),
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

  vi.doMock("../../utils/message-channel.js", () => ({
    isMarkdownCapableMessageChannel: vi.fn(() => true),
  }));

  vi.doMock("../defaults.js", () => ({
    DEFAULT_CONTEXT_TOKENS: 200000,
    DEFAULT_MODEL: "test-model",
    DEFAULT_PROVIDER: "anthropic",
  }));

  vi.doMock("../failover-error.js", () => ({
    FailoverError: MockedFailoverError,
    coerceToFailoverError: mockedCoerceToFailoverError,
    describeFailoverError: mockedDescribeFailoverError,
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

  const { runEmbeddedAgent } = await import("./run.js");
  return { runEmbeddedAgent };
}

/** Move one-time runner compilation out of individual behavior timings. */
export async function warmRunOverflowCompactionHarness(
  runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent,
  params?: Partial<Parameters<typeof runEmbeddedAgent>[0]>,
): Promise<void> {
  resetRunOverflowCompactionHarnessMocks();
  mockedGlobalHookRunner.hasHooks.mockReturnValue(false);
  mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "warmup" }]);
  mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["warmup"] }));
  await runEmbeddedAgent({
    ...overflowBaseRunParams,
    ...params,
    runId: params?.runId ?? "run-overflow-compaction-harness-warmup",
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

/**
 * Test harness mocks for embedded-agent compaction hook coverage.
 */
import { vi, type Mock } from "vitest";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { clearAgentHarnesses } from "../harness/registry.js";
import type { AgentHarness } from "../harness/types.js";
import type { ModelAuthMode } from "../model-auth.js";
import type { AgentRuntimePlan, BuildAgentRuntimePlanParams } from "../runtime-plan/types.js";
import type { CompactionTranscriptRotation } from "./compaction-successor-transcript.js";

type MockResolvedModel = {
  model: {
    provider: string;
    api: string;
    baseUrl?: string;
    id: string;
    input: unknown[];
    contextWindow?: number;
  };
  error: null;
  authStorage: { setRuntimeApiKey: Mock<(provider?: string, apiKey?: string) => void> };
  modelRegistry: Record<string, never>;
};
type MockMemorySearchManager = {
  manager: {
    sync: (params?: unknown) => Promise<void>;
  };
};
type MockEmbeddedAgentStreamFn = Mock<
  (model?: unknown, context?: unknown, options?: unknown) => unknown
>;

export const contextEngineCompactMock = vi.fn(async () => ({
  ok: true as boolean,
  compacted: true as boolean,
  reason: undefined as string | undefined,
  result: { summary: "engine-summary", tokensAfter: 50 } as
    | { summary: string; tokensAfter: number }
    | undefined,
}));

export const hookRunner = {
  hasHooks: vi.fn<(hookName?: string) => boolean>(),
  runBeforeCompaction: vi.fn(async () => undefined),
  runAfterCompaction: vi.fn(async () => undefined),
};

export const ensureRuntimePluginsLoaded: Mock<(params?: unknown) => void> = vi.fn();
export const acquireSessionWriteLockMock = vi.fn(async (_params?: unknown) => ({
  release: vi.fn(async () => {}),
}));
export const resolveContextEngineMock = vi.fn(async () => ({
  info: { ownsCompaction: true as boolean },
  compact: contextEngineCompactMock,
}));
export const resolveModelMock: Mock<
  (provider?: string, modelId?: string, agentDir?: string, cfg?: unknown) => MockResolvedModel
> = vi.fn((provider?: string, modelId?: string, _agentDir?: string, _cfg?: unknown) => ({
  model: {
    provider: provider ?? "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    id: modelId ?? "fake",
    input: [],
  },
  error: null,
  authStorage: { setRuntimeApiKey: vi.fn() },
  modelRegistry: {},
}));
export const resolveModelAsyncMock = vi.fn(
  async (provider: string, modelId: string, agentDir?: string, cfg?: unknown) =>
    resolveModelMock(provider, modelId, agentDir, cfg),
);
export const sessionCompactImpl = vi.fn(async () => ({
  summary: "summary",
  firstKeptEntryId: "entry-1",
  tokensBefore: 120,
  details: { ok: true },
}));
export const triggerInternalHook: Mock<(event?: unknown) => void> = vi.fn();
const sanitizeSessionHistoryMock = vi.fn(
  async (params: { messages: unknown[] }) => params.messages,
);
const validateReplayTurnsMock = vi.fn(async ({ messages }: { messages: unknown[] }) => messages);
export const getMemorySearchManagerMock: Mock<
  (params?: unknown) => Promise<MockMemorySearchManager>
> = vi.fn(async () => ({
  manager: {
    sync: vi.fn(async (_params?: unknown) => {}),
  },
}));
export const resolveMemorySearchConfigMock = vi.fn(() => ({
  sources: ["sessions"],
  sync: {
    sessions: {
      postCompactionForce: true,
    },
  },
}));
export const resolveSessionAgentIdMock = vi.fn(() => "main");
export const resolveSessionAgentIdsMock = vi.fn(() => ({
  defaultAgentId: "main",
  sessionAgentId: "main",
}));
export const estimateTokensMock = vi.fn((_message?: unknown) => 10);
export const resolveAgentHarnessPolicyMock = vi.fn(() => ({ runtime: "openclaw" }));
function createSelectedAgentHarnessMock(params: {
  agentHarnessId?: string;
  agentHarnessRuntimeOverride?: string;
}): AgentHarness {
  const configured = resolveAgentHarnessPolicyMock() as { runtime?: string };
  const id =
    params.agentHarnessId ?? params.agentHarnessRuntimeOverride ?? configured.runtime ?? "openclaw";
  return {
    id,
    label: `${id} test harness`,
    ...(id === "codex" ? { authBootstrap: "harness" as const } : {}),
    supports: () => ({ supported: true }),
    runAttempt: vi.fn(),
  };
}
export const selectAgentHarnessMock = vi.fn(createSelectedAgentHarnessMock);
export const selectAgentHarnessForPreparedModelProvidersMock = vi.fn(
  createSelectedAgentHarnessMock,
);
export const resolveContextWindowInfoMock = vi.fn(() => ({ tokens: 128_000 }));
function createDefaultSessionMessages(): unknown[] {
  return [
    { role: "user", content: "hello", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "exec",
      content: [{ type: "text", text: "output" }],
      isError: false,
      timestamp: 3,
    },
  ];
}
export const sessionMessages: unknown[] = createDefaultSessionMessages();
export const sessionAbortCompactionMock: Mock<(reason?: unknown) => void> = vi.fn();
function createMockCompactionSession() {
  const session = {
    sessionId: "session-1",
    messages: sessionMessages.map((message) => structuredClone(message)),
    agent: {
      streamFn: vi.fn(),
      transport: "sse",
      state: {
        get messages() {
          return session.messages;
        },
        set messages(messages: unknown[]) {
          session.messages = [...messages];
        },
        systemPrompt: undefined as string | undefined,
      },
    },
    compact: vi.fn(async () => {
      session.messages.splice(1);
      return await sessionCompactImpl();
    }),
    setActiveToolsByName: vi.fn(),
    setBaseSystemPrompt: vi.fn((systemPrompt: string) => {
      session.agent.state.systemPrompt = systemPrompt;
    }),
    abortCompaction: sessionAbortCompactionMock,
    dispose: vi.fn(),
  };
  return session;
}
export const createAgentSessionMock = vi.fn(async (_options?: unknown) => ({
  session: createMockCompactionSession(),
}));
function createMockToolDefinitions(tools: unknown[] = []) {
  return tools.map((tool) => {
    const source = tool && typeof tool === "object" ? (tool as Record<string, unknown>) : {};
    const name = typeof source.name === "string" && source.name.length > 0 ? source.name : "tool";
    return {
      name,
      label: source.label ?? name,
      description: source.description ?? "",
      parameters: source.parameters,
      execute: source.execute ?? vi.fn(),
    };
  });
}
export const createOpenClawCodingToolsMock = vi.fn(() => []);
const buildEmbeddedExtensionFactoriesMock = vi.fn(() => []);
export const guardSessionManagerMock = vi.fn(() => ({
  flushPendingToolResults: vi.fn(),
}));
export const applyAgentCompactionSettingsFromConfigMock = vi.fn();
export const createPreparedEmbeddedAgentSettingsManagerMock = vi.fn(() => ({
  getGlobalSettings: vi.fn(() => ({})),
}));
export const listRegisteredPluginAgentPromptGuidanceMock = vi.fn((params?: { surface?: string }) =>
  params?.surface === "subagent"
    ? ["Subagent compact command guidance."]
    : params?.surface === "acp_backend"
      ? ["ACP compact command guidance."]
      : ["Main compact command guidance."],
);
export const buildEmbeddedSystemPromptMock = vi.fn(() => "");
export const resolveEmbeddedAgentStreamFnMock: Mock<
  (params?: unknown) => MockEmbeddedAgentStreamFn
> = vi.fn((_params?: unknown) => vi.fn());
const getModelRegistryRuntimeMock = vi.fn(() => ({
  apiRegistry: {},
  llmRuntime: { streamSimple: vi.fn() },
}));
export const getApiKeyForModelMock: Mock<
  (params?: { profileId?: string; allowAuthProfileFallback?: boolean }) => Promise<{
    apiKey: string;
    mode: ModelAuthMode;
    source: string;
    profileId?: string;
  }>
> = vi.fn(async (params?: { profileId?: string }) => ({
  apiKey: "test",
  mode: "api-key",
  source: params?.profileId ? `profile:${params.profileId}` : "test harness",
  ...(params?.profileId ? { profileId: params.profileId } : {}),
}));
export const resolveProviderEntryApiKeyProfileReferenceMock: Mock<() => unknown> = vi.fn(() => ({
  kind: "none",
}));
export const shouldPreferExplicitConfigApiKeyAuthMock = vi.fn(() => false);
export const registerProviderStreamForModelMock: Mock<(params?: unknown) => unknown> = vi.fn();
export const applyExtraParamsToAgentMock = vi.fn(() => ({ effectiveExtraParams: {} }));
function createDefaultCompactionAuthStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai:test": {
        type: "api_key",
        provider: "openai",
        key: "test",
      },
    },
    order: { openai: ["openai:test"] },
  };
}

export const ensureAuthProfileStoreMock: Mock<() => AuthProfileStore> = vi.fn(
  createDefaultCompactionAuthStore,
);
const ensureAuthProfileStoreWithoutExternalProfilesMock: Mock<() => AuthProfileStore> = vi.fn(
  createDefaultCompactionAuthStore,
);
const resolveAgentTransportOverrideMock: Mock<(params?: unknown) => string | undefined> = vi.fn(
  () => undefined,
);
export const resolveSandboxContextMock = vi.fn(async () => null);
export const maybeCompactAgentHarnessSessionMock: Mock<
  (params?: unknown, options?: unknown) => Promise<unknown>
> = vi.fn(async () => undefined);
async function runCompactWithSafetyTimeoutMock(
  compact: () => Promise<unknown>,
  _timeoutMs?: number,
  opts?: { abortSignal?: AbortSignal; onCancel?: () => void },
): Promise<unknown> {
  const abortSignal = opts?.abortSignal;
  if (!abortSignal) {
    return await compact();
  }
  const cancelAndCreateError = () => {
    opts?.onCancel?.();
    const reason = "reason" in abortSignal ? abortSignal.reason : undefined;
    if (reason instanceof Error) {
      return reason;
    }
    const err = new Error("aborted");
    err.name = "AbortError";
    return err;
  };
  if (abortSignal.aborted) {
    throw cancelAndCreateError();
  }
  return await Promise.race([
    compact(),
    new Promise<never>((_, reject) => {
      abortSignal.addEventListener(
        "abort",
        () => {
          reject(cancelAndCreateError());
        },
        { once: true },
      );
    }),
  ]);
}
export const compactWithSafetyTimeoutMock = vi.fn(runCompactWithSafetyTimeoutMock);
export const rotateTranscriptAfterCompactionMock: Mock<
  (_params?: unknown) => Promise<CompactionTranscriptRotation>
> = vi.fn(async () => ({
  rotated: false,
}));
export const enqueueCommandInLaneMock = vi.fn((_lane: unknown, task: () => unknown) => task());

function createCompactHooksRuntimePlan(params: BuildAgentRuntimePlanParams): AgentRuntimePlan {
  const modelApi = params.modelApi ?? params.model?.api ?? undefined;
  const transcriptPolicy = {
    sanitizeMode: "full" as const,
    sanitizeToolCallIds: false,
    preserveNativeAnthropicToolUseIds: false,
    repairToolUseResultPairing: false,
    preserveSignatures: false,
    dropThinkingBlocks: false,
    applyGoogleTurnOrdering: false,
    validateGeminiTurns: false,
    validateAnthropicTurns: false,
    allowSyntheticToolResults: false,
  };

  return {
    resolvedRef: {
      provider: params.provider,
      modelId: params.modelId,
      ...(modelApi ? { modelApi } : {}),
      ...(params.resolvedTransport ? { transport: params.resolvedTransport } : {}),
    },
    auth: {
      providerForAuth: params.provider,
      authProfileProviderForAuth: params.authProfileProvider ?? params.provider,
      ...(params.sessionAuthProfileId
        ? { forwardedAuthProfileId: params.sessionAuthProfileId }
        : {}),
      ...(params.sessionAuthProfileId && params.sessionAuthProfileSource
        ? { forwardedAuthProfileSource: params.sessionAuthProfileSource }
        : {}),
      ...(params.sessionAuthProfileCandidateIds?.length
        ? { forwardedAuthProfileCandidateIds: params.sessionAuthProfileCandidateIds }
        : {}),
      ...(params.authProfileMode ? { selectedAuthMode: params.authProfileMode } : {}),
      ...(params.modelRoute ? { modelRoute: params.modelRoute } : {}),
    },
    prompt: {
      provider: params.provider,
      modelId: params.modelId,
      resolveSystemPromptContribution: vi.fn(() => undefined),
      transformSystemPrompt: vi.fn((context: { systemPrompt: string }) => context.systemPrompt),
    },
    tools: {
      preparedPlanning: {
        loadMetadataSnapshot: () => ({}),
      },
      normalize: vi.fn((tools) => tools),
      logDiagnostics: vi.fn(),
    },
    transcript: {
      policy: transcriptPolicy,
      resolvePolicy: vi.fn(() => transcriptPolicy),
    },
    delivery: {
      isSilentPayload: vi.fn(() => false),
      resolveFollowupRoute: vi.fn(() => undefined),
    },
    outcome: {
      classifyRunResult: vi.fn(() => null),
    },
    transport: {
      extraParams: {},
      resolveExtraParams: vi.fn(() => ({})),
    },
    observability: {
      resolvedRef: `${params.provider}/${params.modelId}`,
      provider: params.provider,
      modelId: params.modelId,
      ...(modelApi ? { modelApi } : {}),
      ...(params.sessionAuthProfileId ? { authProfileId: params.sessionAuthProfileId } : {}),
      ...(params.resolvedTransport ? { transport: params.resolvedTransport } : {}),
    },
  };
}

export const buildAgentRuntimePlanMock = vi.fn((params: BuildAgentRuntimePlanParams) =>
  createCompactHooksRuntimePlan(params),
);

const emptyPluginMetadataSnapshot: PluginMetadataSnapshot = {
  policyHash: "",
  index: {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "",
    generatedAtMs: 1,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  },
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

export function resetCompactSessionStateMocks(): void {
  sanitizeSessionHistoryMock.mockReset();
  sanitizeSessionHistoryMock.mockImplementation(async (params: { messages: unknown[] }) => {
    return params.messages;
  });
  validateReplayTurnsMock.mockReset();
  validateReplayTurnsMock.mockImplementation(async ({ messages }: { messages: unknown[] }) => {
    return messages;
  });
  buildEmbeddedExtensionFactoriesMock.mockReset();
  buildEmbeddedExtensionFactoriesMock.mockReturnValue([]);

  getMemorySearchManagerMock.mockReset();
  getMemorySearchManagerMock.mockResolvedValue({
    manager: {
      sync: vi.fn(async () => {}),
    },
  });
  resolveMemorySearchConfigMock.mockReset();
  resolveMemorySearchConfigMock.mockReturnValue({
    sources: ["sessions"],
    sync: {
      sessions: {
        postCompactionForce: true,
      },
    },
  });
  resolveSessionAgentIdMock.mockReset();
  resolveSessionAgentIdMock.mockReturnValue("main");
  resolveSessionAgentIdsMock.mockReset();
  resolveSessionAgentIdsMock.mockReturnValue({ defaultAgentId: "main", sessionAgentId: "main" });
  estimateTokensMock.mockReset();
  estimateTokensMock.mockReturnValue(10);
  sessionMessages.splice(0, sessionMessages.length, ...createDefaultSessionMessages());
  sessionAbortCompactionMock.mockReset();
  createAgentSessionMock.mockReset();
  createAgentSessionMock.mockImplementation(async () => ({
    session: createMockCompactionSession(),
  }));
  resolveEmbeddedAgentStreamFnMock.mockReset();
  resolveEmbeddedAgentStreamFnMock.mockImplementation((_params?: unknown) => vi.fn());
  getModelRegistryRuntimeMock.mockReset();
  getModelRegistryRuntimeMock.mockReturnValue({
    apiRegistry: {},
    llmRuntime: { streamSimple: vi.fn() },
  });
  getApiKeyForModelMock.mockReset();
  getApiKeyForModelMock.mockImplementation(async (params?: { profileId?: string }) => ({
    apiKey: "test",
    mode: "api-key",
    source: params?.profileId ? `profile:${params.profileId}` : "test harness",
    ...(params?.profileId ? { profileId: params.profileId } : {}),
  }));
  resolveProviderEntryApiKeyProfileReferenceMock.mockReset();
  resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "none" });
  shouldPreferExplicitConfigApiKeyAuthMock.mockReset();
  shouldPreferExplicitConfigApiKeyAuthMock.mockReturnValue(false);
  registerProviderStreamForModelMock.mockReset();
  registerProviderStreamForModelMock.mockReturnValue(undefined);
  applyExtraParamsToAgentMock.mockReset();
  applyExtraParamsToAgentMock.mockReturnValue({ effectiveExtraParams: {} });
  ensureAuthProfileStoreMock.mockReset();
  ensureAuthProfileStoreMock.mockImplementation(createDefaultCompactionAuthStore);
  ensureAuthProfileStoreWithoutExternalProfilesMock.mockReset();
  ensureAuthProfileStoreWithoutExternalProfilesMock.mockImplementation(
    createDefaultCompactionAuthStore,
  );
  resolveAgentTransportOverrideMock.mockReset();
  resolveAgentTransportOverrideMock.mockReturnValue(undefined);
  resolveSandboxContextMock.mockReset();
  resolveSandboxContextMock.mockResolvedValue(null);
  maybeCompactAgentHarnessSessionMock.mockReset();
  maybeCompactAgentHarnessSessionMock.mockResolvedValue(undefined);
  resolveAgentHarnessPolicyMock.mockReset();
  resolveAgentHarnessPolicyMock.mockReturnValue({ runtime: "openclaw" });
  selectAgentHarnessMock.mockReset();
  selectAgentHarnessMock.mockImplementation(createSelectedAgentHarnessMock);
  selectAgentHarnessForPreparedModelProvidersMock.mockReset();
  selectAgentHarnessForPreparedModelProvidersMock.mockImplementation(
    createSelectedAgentHarnessMock,
  );
  resolveContextWindowInfoMock.mockReset();
  resolveContextWindowInfoMock.mockReturnValue({ tokens: 128_000 });
  rotateTranscriptAfterCompactionMock.mockReset();
  rotateTranscriptAfterCompactionMock.mockResolvedValue({ rotated: false });
  enqueueCommandInLaneMock.mockReset();
  enqueueCommandInLaneMock.mockImplementation((_lane: unknown, task: () => unknown) => task());
  listRegisteredPluginAgentPromptGuidanceMock.mockReset();
  listRegisteredPluginAgentPromptGuidanceMock.mockImplementation((params?: { surface?: string }) =>
    params?.surface === "subagent"
      ? ["Subagent compact command guidance."]
      : params?.surface === "acp_backend"
        ? ["ACP compact command guidance."]
        : ["Main compact command guidance."],
  );
  buildAgentRuntimePlanMock.mockReset();
  buildAgentRuntimePlanMock.mockImplementation((params: BuildAgentRuntimePlanParams) =>
    createCompactHooksRuntimePlan(params),
  );
  buildEmbeddedSystemPromptMock.mockReset();
  buildEmbeddedSystemPromptMock.mockReturnValue("");
}

export function resetCompactHooksHarnessMocks(): void {
  clearAgentHarnesses();
  hookRunner.hasHooks.mockReset();
  hookRunner.hasHooks.mockReturnValue(false);
  hookRunner.runBeforeCompaction.mockReset();
  hookRunner.runBeforeCompaction.mockResolvedValue(undefined);
  hookRunner.runAfterCompaction.mockReset();
  hookRunner.runAfterCompaction.mockResolvedValue(undefined);

  ensureRuntimePluginsLoaded.mockReset();
  acquireSessionWriteLockMock.mockClear();

  resolveContextEngineMock.mockReset();
  resolveContextEngineMock.mockResolvedValue({
    info: { ownsCompaction: true },
    compact: contextEngineCompactMock,
  });
  contextEngineCompactMock.mockReset();
  contextEngineCompactMock.mockResolvedValue({
    ok: true,
    compacted: true,
    reason: undefined,
    result: { summary: "engine-summary", tokensAfter: 50 },
  });
  compactWithSafetyTimeoutMock.mockReset();
  compactWithSafetyTimeoutMock.mockImplementation(runCompactWithSafetyTimeoutMock);

  resolveModelMock.mockReset();
  resolveModelMock.mockImplementation((provider?: string, modelId?: string) => ({
    model: {
      provider: provider ?? "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      id: modelId ?? "fake",
      input: [],
    },
    error: null,
    authStorage: { setRuntimeApiKey: vi.fn() },
    modelRegistry: {},
  }));
  resolveModelAsyncMock.mockReset();
  resolveModelAsyncMock.mockImplementation(
    async (provider: string, modelId: string, agentDir?: string, cfg?: unknown) =>
      resolveModelMock(provider, modelId, agentDir, cfg),
  );
  resolveAgentHarnessPolicyMock.mockReset();
  resolveAgentHarnessPolicyMock.mockReturnValue({ runtime: "openclaw" });
  resolveContextWindowInfoMock.mockReset();
  resolveContextWindowInfoMock.mockReturnValue({ tokens: 128_000 });

  sessionCompactImpl.mockReset();
  sessionCompactImpl.mockResolvedValue({
    summary: "summary",
    firstKeptEntryId: "entry-1",
    tokensBefore: 120,
    details: { ok: true },
  });

  triggerInternalHook.mockReset();
  resetCompactSessionStateMocks();
  createOpenClawCodingToolsMock.mockReset();
  createOpenClawCodingToolsMock.mockReturnValue([]);
  guardSessionManagerMock.mockReset();
  guardSessionManagerMock.mockReturnValue({
    flushPendingToolResults: vi.fn(),
  });
  applyAgentCompactionSettingsFromConfigMock.mockReset();
  createPreparedEmbeddedAgentSettingsManagerMock.mockReset();
  createPreparedEmbeddedAgentSettingsManagerMock.mockReturnValue({
    getGlobalSettings: vi.fn(() => ({})),
  });
}

export async function loadCompactHooksHarness(): Promise<{
  compactEmbeddedAgentSessionDirect: typeof import("./compact.js").compactEmbeddedAgentSessionDirect;
  compactEmbeddedAgentSession: typeof import("./compact.queued.js").compactEmbeddedAgentSession;
  testing: typeof import("./compact.js").testing;
  withOwnedSessionTranscriptWrites: typeof import("../../config/sessions/transcript-write-context.js").withOwnedSessionTranscriptWrites;
  onSessionTranscriptUpdate: typeof import("../../sessions/transcript-events.js").onSessionTranscriptUpdate;
  onInternalSessionTranscriptUpdate: typeof import("../../sessions/transcript-events.js").onInternalSessionTranscriptUpdate;
}> {
  resetCompactHooksHarnessMocks();
  vi.resetModules();

  vi.doMock("../../plugins/hook-runner-global.js", () => ({
    getGlobalHookRunner: () => hookRunner,
    getGlobalPluginRegistry: vi.fn(() => null),
    hasGlobalHooks: vi.fn(() => false),
    initializeGlobalHookRunner: vi.fn(),
    resetGlobalHookRunner: vi.fn(),
    runGlobalGatewayStopSafely: vi.fn(async () => undefined),
  }));

  vi.doMock("../runtime-plugins.js", () => ({
    ensureRuntimePluginsLoaded,
  }));

  vi.doMock("../../plugins/current-plugin-metadata-snapshot.js", () => ({
    captureCurrentPluginMetadataSnapshotState: vi.fn(() => ({
      snapshot: undefined,
      configFingerprint: undefined,
      compatiblePolicyHashes: undefined,
      compatibleConfigFingerprints: undefined,
    })),
    clearCurrentPluginMetadataSnapshot: vi.fn(),
    getCurrentPluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
    resolvePluginMetadataControlPlaneFingerprint: vi.fn(() => "test-plugin-fingerprint"),
    restoreCurrentPluginMetadataSnapshotState: vi.fn(),
    setCurrentPluginMetadataSnapshot: vi.fn(),
  }));

  vi.doMock("../../plugins/command-registry-state.js", () => {
    const pluginCommands = new Map<string, unknown>();
    return {
      clearPluginCommands: vi.fn(() => pluginCommands.clear()),
      clearPluginCommandsForPlugin: vi.fn(),
      isPluginCommandRegistryLocked: vi.fn(() => false),
      isTrustedReservedCommandOwner: vi.fn(() => false),
      listRegisteredPluginCommands: vi.fn(() => []),
      listRegisteredPluginAgentPromptGuidance: listRegisteredPluginAgentPromptGuidanceMock,
      pluginCommands,
      restorePluginCommands: vi.fn(),
      setPluginCommandRegistryLocked: vi.fn(),
    };
  });

  vi.doMock("../harness/compaction.js", () => ({
    maybeCompactAgentHarnessSession: maybeCompactAgentHarnessSessionMock,
  }));

  vi.doMock("../harness/policy.js", () => ({
    resolveAgentHarnessPolicy: resolveAgentHarnessPolicyMock,
  }));
  vi.doMock("../harness/runtime-plugin.js", () => ({
    ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
  }));

  vi.doMock("../harness/selection.js", async () => {
    const actual =
      await vi.importActual<typeof import("../harness/selection.js")>("../harness/selection.js");
    return {
      ...actual,
      selectAgentHarness: selectAgentHarnessMock,
      selectAgentHarnessForPreparedModelProviders: selectAgentHarnessForPreparedModelProvidersMock,
    };
  });

  vi.doMock("../../plugins/provider-runtime.js", () => ({
    prepareProviderRuntimeAuth: vi.fn(async () => ({ resolvedApiKey: undefined })),
    resolveProviderReasoningOutputModeWithPlugin: vi.fn(() => undefined),
    resolveProviderSystemPromptContribution: vi.fn(() => undefined),
    resolveProviderTextTransforms: vi.fn(() => undefined),
    shouldPreferProviderRuntimeResolvedModel: vi.fn(() => false),
    transformProviderSystemPrompt: vi.fn(
      (params: { systemPrompt?: string; context?: { systemPrompt?: string } }) =>
        params.context?.systemPrompt ?? params.systemPrompt,
    ),
  }));

  vi.doMock("../provider-stream.js", () => ({
    registerProviderStreamForModel: registerProviderStreamForModelMock,
  }));

  vi.doMock("../sessions/model-registry-runtime.js", () => ({
    getModelRegistryRuntime: getModelRegistryRuntimeMock,
  }));

  vi.doMock("../../hooks/internal-hooks.js", async () => {
    const actual = await vi.importActual<typeof import("../../hooks/internal-hooks.js")>(
      "../../hooks/internal-hooks.js",
    );
    return {
      ...actual,
      triggerInternalHook,
    };
  });

  vi.doMock("../sessions/index.js", () => ({
    AuthStorage: function AuthStorage() {},
    ModelRegistry: function ModelRegistry() {},
    createAgentSession: createAgentSessionMock,
    DefaultResourceLoader: function DefaultResourceLoader() {
      return {
        reload: vi.fn(async () => undefined),
      };
    },
    SessionManager: {
      open: vi.fn(() => ({
        buildSessionContext: vi.fn(() => ({ messages: sessionMessages })),
      })),
    },
    SettingsManager: {
      create: vi.fn(() => ({})),
    },
    estimateTokens: estimateTokensMock,
    generateSummary: vi.fn(async () => "summary"),
  }));

  vi.doMock("../session-tool-result-guard-wrapper.js", () => ({
    guardSessionManager: guardSessionManagerMock,
  }));

  vi.doMock("../agent-settings.js", () => ({
    applyAgentAutoCompactionGuard: vi.fn(() => ({ supported: true, disabled: false })),
    applyAgentCompactionSettingsFromConfig: applyAgentCompactionSettingsFromConfigMock,
    isSilentOverflowProneModel: vi.fn(() => false),
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
        metadataSnapshot: {
          ...emptyPluginMetadataSnapshot,
          workspaceDir: input.workspaceDir as string | undefined,
        },
        createStores: () => ({ authStorage: {}, modelRegistry: {} }),
      },
      release: vi.fn(),
    })),
    prepareModelRuntimeSnapshot: vi.fn(async () => ({
      createStores: () => ({ authStorage: {}, modelRegistry: {} }),
    })),
    loadPreparedModelRuntimeSnapshot: vi.fn(async () => ({
      createStores: () => ({ authStorage: {}, modelRegistry: {} }),
    })),
  }));

  vi.doMock("../model-auth.js", () => ({
    applyAuthHeaderOverride: vi.fn((model: unknown) => model),
    applyLocalNoAuthHeaderOverride: vi.fn((model: unknown) => model),
    ensureAuthProfileStore: ensureAuthProfileStoreMock,
    ensureAuthProfileStoreWithoutExternalProfiles:
      ensureAuthProfileStoreWithoutExternalProfilesMock,
    formatMissingAuthError: vi.fn(
      (auth: { mode: string; source: string }, provider: string) =>
        `No API key resolved for provider "${provider}" (auth mode: ${auth.mode}, checked: ${auth.source}).`,
    ),
    getApiKeyForModel: (params: { profileId?: string; allowAuthProfileFallback?: boolean }) =>
      getApiKeyForModelMock(params),
    hasUsableCustomProviderApiKey: vi.fn(() => false),
    resolveProviderEntryApiKeyProfileReference: resolveProviderEntryApiKeyProfileReferenceMock,
    resolveModelAuthMode: vi.fn(() => "env"),
    shouldPreferExplicitConfigApiKeyAuth: shouldPreferExplicitConfigApiKeyAuthMock,
  }));

  vi.doMock("../sandbox.js", () => ({
    resolveSandboxContext: resolveSandboxContextMock,
  }));

  vi.doMock("../session-file-repair.js", () => ({
    repairSessionFileIfNeeded: vi.fn(async () => {}),
  }));

  vi.doMock("../session-write-lock.js", () => ({
    acquireSessionWriteLock: acquireSessionWriteLockMock,
    resolveSessionLockMaxHoldFromTimeout: vi.fn(() => 0),
    resolveSessionWriteLockAcquireTimeoutMs: vi.fn(() => 60_000),
    resolveSessionWriteLockOptions: vi.fn(() => ({
      timeoutMs: 60_000,
      staleMs: 1_800_000,
      maxHoldMs: 300_000,
    })),
  }));

  vi.doMock("../../context-engine/init.js", () => ({
    ensureContextEnginesInitialized: vi.fn(),
  }));

  vi.doMock("../../context-engine/registry.js", () => ({
    resolveContextEngine: resolveContextEngineMock,
    resolveContextEngineOwnerPluginId: vi.fn(() => "lossless-claw"),
  }));

  vi.doMock("../../process/command-queue.js", () => ({
    enqueueCommandInLane: enqueueCommandInLaneMock,
    clearCommandLane: vi.fn(() => 0),
    GatewayDrainingError: class GatewayDrainingError extends Error {},
    isGatewayDraining: vi.fn(() => false),
  }));

  vi.doMock("../../tasks/detached-task-runtime.js", async () => {
    const actual = await vi.importActual<typeof import("../../tasks/detached-task-runtime.js")>(
      "../../tasks/detached-task-runtime.js",
    );
    return {
      ...actual,
      // Deferred-maintenance lifecycle tests isolate queue ownership from the
      // file-backed task registry, which has separate integration coverage.
      createQueuedTaskRun: vi.fn((params: { runId?: string }) => ({
        taskId: `test-task:${params.runId ?? "deferred"}`,
        runId: params.runId,
      })),
    };
  });

  vi.doMock("./lanes.js", () => ({
    resolveSessionLane: vi.fn(() => "test-session-lane"),
    resolveEmbeddedSessionLane: vi.fn(() => "test-session-lane"),
    resolveGlobalLane: vi.fn(() => "test-global-lane"),
  }));

  vi.doMock("../context-window-guard.js", () => ({
    resolveContextWindowInfo: resolveContextWindowInfoMock,
  }));

  vi.doMock("../bootstrap-files.js", () => ({
    makeBootstrapWarn: vi.fn(() => () => {}),
    resolveContextInjectionMode: vi.fn(() => "always"),
    resolveBootstrapContextForRun: vi.fn(async () => ({ contextFiles: [] })),
  }));

  vi.doMock("../bundle-mcp-tools.js", () => ({
    retireSessionMcpRuntime: vi.fn(async () => true),
    createBundleMcpToolRuntime: vi.fn(async () => ({
      tools: [],
      dispose: vi.fn(async () => {}),
    })),
  }));

  vi.doMock("../bundle-lsp-runtime.js", () => ({
    createBundleLspToolRuntime: vi.fn(async () => ({
      tools: [],
      sessions: [],
      dispose: vi.fn(async () => {}),
    })),
  }));

  vi.doMock("../docs-path.js", () => ({
    resolveOpenClawReferencePaths: vi.fn(async () => ({
      docsPath: undefined,
      sourcePath: undefined,
    })),
  }));

  vi.doMock("../channel-tools.js", () => ({
    listChannelSupportedActions: vi.fn(() => undefined),
    resolveChannelMessageToolHints: vi.fn(() => undefined),
  }));

  vi.doMock("../agent-tools.js", () => ({
    createOpenClawCodingTools: createOpenClawCodingToolsMock,
    resolveProcessToolScopeKey: ({
      scopeKey,
      sessionKey,
      sessionId,
      agentId,
    }: {
      scopeKey?: string;
      sessionKey?: string;
      sessionId?: string;
      agentId?: string;
    }) => scopeKey ?? sessionKey ?? sessionId ?? (agentId ? `agent:${agentId}` : undefined),
  }));

  vi.doMock("./replay-history.js", () => ({
    sanitizeSessionHistory: sanitizeSessionHistoryMock,
    validateReplayTurns: validateReplayTurnsMock,
  }));

  vi.doMock("./tool-schema-runtime.js", () => ({
    logProviderToolSchemaDiagnostics: vi.fn(),
    normalizeProviderToolSchemas: vi.fn(({ tools }: { tools: unknown[] }) => tools),
  }));

  vi.doMock("./stream-resolution.js", () => ({
    resolveEmbeddedAgentApiKey: vi.fn(async () => "test-api-key"),
    resolveEmbeddedAgentBaseStreamFn: vi.fn(() => vi.fn()),
    resolveEmbeddedAgentStreamFn: resolveEmbeddedAgentStreamFnMock,
  }));

  vi.doMock("./extra-params.js", () => ({
    applyExtraParamsToAgent: applyExtraParamsToAgentMock,
    resolveAgentTransportOverride: resolveAgentTransportOverrideMock,
    resolvePreparedExtraParams: vi.fn(() => ({})),
  }));

  vi.doMock("./tool-split.js", () => ({
    splitSdkTools: vi.fn(({ tools }: { tools?: unknown[] }) => ({
      customTools: createMockToolDefinitions(tools),
    })),
  }));

  vi.doMock("./compaction-safety-timeout.js", () => {
    return {
      compactWithSafetyTimeout: compactWithSafetyTimeoutMock,
      resolveCompactionTimeoutMs: vi.fn(() => 30_000),
      // Mirror the real wrapper: bound the engine's compact() with the
      // (mocked) safety timeout and thread the abort signal into its params.
      compactContextEngineWithSafetyTimeout: vi.fn(
        (
          contextEngine: { compact: (params: Record<string, unknown>) => Promise<unknown> },
          params: Record<string, unknown>,
          timeoutMs?: number,
          abortSignal?: AbortSignal,
        ) =>
          compactWithSafetyTimeoutMock(
            () => contextEngine.compact(abortSignal ? { ...params, abortSignal } : params),
            timeoutMs,
            abortSignal ? { abortSignal } : undefined,
          ),
      ),
    };
  });

  vi.doMock("./compaction-successor-transcript.js", async () => {
    const actual = await vi.importActual<typeof import("./compaction-successor-transcript.js")>(
      "./compaction-successor-transcript.js",
    );
    return {
      ...actual,
      rotateTranscriptAfterCompaction: rotateTranscriptAfterCompactionMock,
    };
  });

  vi.doMock("./wait-for-idle-before-flush.js", () => ({
    flushPendingToolResultsAfterIdle: vi.fn(async () => {}),
  }));

  vi.doMock("../transcript-policy.js", () => ({
    resolveTranscriptPolicy: vi.fn(() => ({
      allowSyntheticToolResults: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    })),
  }));

  vi.doMock("./extensions.js", () => ({
    buildEmbeddedExtensionFactories: buildEmbeddedExtensionFactoriesMock,
  }));

  vi.doMock("./history.js", () => ({
    getHistoryLimitFromSessionKey: vi.fn(() => undefined),
    limitHistoryTurns: vi.fn((msgs: unknown[]) => msgs.slice(0, 2)),
  }));

  vi.doMock("../../skills/runtime/env-overrides.js", () => ({
    applySkillEnvOverrides: vi.fn(() => () => {}),
    applySkillEnvOverridesFromSnapshot: vi.fn(() => () => {}),
  }));

  vi.doMock("../../skills/loading/workspace.js", () => ({
    loadWorkspaceSkillEntries: vi.fn(() => []),
    resolveSkillsPromptForRun: vi.fn(() => undefined),
  }));

  vi.doMock("../agent-scope.js", () => ({
    listAgentEntries: vi.fn(() => []),
    resolveAgentConfig: vi.fn(() => undefined),
    resolveAgentDir: vi.fn((_cfg: unknown, agentId: string) => `/tmp/agents/${agentId}/agent`),
    resolveAgentWorkspaceDir: vi.fn(() => "/tmp"),
    resolveDefaultAgentDir: vi.fn(() => "/tmp/agents/main/agent"),
    resolveDefaultAgentId: vi.fn(() => "main"),
    resolveAgentIdFromSessionKey: vi.fn(
      (sessionKey: string) => sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main",
    ),
    resolveRunModelFallbacksOverride: vi.fn(() => undefined),
    resolveSessionAgentId: resolveSessionAgentIdMock,
    resolveSessionAgentIds: resolveSessionAgentIdsMock,
  }));

  vi.doMock("../auth-profiles/source-check.js", () => ({
    hasAnyAuthProfileStoreSource: vi.fn(() => false),
  }));

  vi.doMock("../memory-search.js", () => ({
    resolveMemorySearchConfig: resolveMemorySearchConfigMock,
  }));

  vi.doMock("../runtime-plan/build.js", () => ({
    buildAgentRuntimePlan: buildAgentRuntimePlanMock,
  }));

  vi.doMock("../../plugins/memory-runtime.js", () => ({
    getActiveMemorySearchManager: getMemorySearchManagerMock,
  }));

  vi.doMock("../date-time.js", () => ({
    formatUserTime: vi.fn(() => ""),
    resolveUserTimeFormat: vi.fn(() => ""),
    resolveUserTimezone: vi.fn(() => ""),
  }));

  vi.doMock("../defaults.js", () => ({
    DEFAULT_MODEL: "fake-model",
    DEFAULT_PROVIDER: "openai",
    DEFAULT_CONTEXT_TOKENS: 128_000,
  }));

  vi.doMock("../utils.js", () => ({
    resolveUserPath: vi.fn((p: string) => p),
  }));

  vi.doMock("../../infra/machine-name.js", () => ({
    getMachineDisplayName: vi.fn(async () => "machine"),
  }));

  vi.doMock("../../config/channel-capabilities.js", () => ({
    resolveChannelCapabilities: vi.fn(() => undefined),
  }));

  vi.doMock("../../utils/message-channel.js", async () => {
    const actual = await vi.importActual<typeof import("../../utils/message-channel.js")>(
      "../../utils/message-channel.js",
    );
    return {
      ...actual,
      normalizeMessageChannel: vi.fn(() => undefined),
    };
  });

  vi.doMock("../embedded-agent-helpers.js", () => ({
    ensureSessionHeader: vi.fn(async () => {}),
    pickFallbackThinkingLevel: vi.fn((params: { message?: string; attempted?: Set<string> }) =>
      params.message?.includes("Reasoning is mandatory") && !params.attempted?.has("minimal")
        ? "minimal"
        : undefined,
    ),
    validateAnthropicTurns: vi.fn((m: unknown[]) => m),
    validateGeminiTurns: vi.fn((m: unknown[]) => m),
  }));

  vi.doMock("../agent-project-settings.js", () => ({
    createPreparedEmbeddedAgentSettingsManager: createPreparedEmbeddedAgentSettingsManagerMock,
  }));

  vi.doMock("./sandbox-info.js", () => ({
    buildEmbeddedSandboxInfo: vi.fn(() => undefined),
    resolveEmbeddedSandboxInfoExecPolicy: vi.fn(() => ({})),
  }));

  vi.doMock("./model.js", () => ({
    buildModelAliasLines: vi.fn(() => []),
    resolveModel: resolveModelMock,
    resolveModelAsync: resolveModelAsyncMock,
  }));

  vi.doMock("./session-manager-cache.js", () => ({
    prewarmSessionFile: vi.fn(async () => {}),
    trackSessionManagerAccess: vi.fn(),
  }));

  vi.doMock("./system-prompt.js", () => ({
    applySystemPromptToSession: vi.fn(
      (session: { setBaseSystemPrompt: (systemPrompt: string) => void }, systemPrompt: string) => {
        session.setBaseSystemPrompt(systemPrompt);
      },
    ),
    buildEmbeddedSystemPrompt: buildEmbeddedSystemPromptMock,
  }));

  vi.doMock("./utils.js", async () => {
    const actual = await vi.importActual<typeof import("./utils.js")>("./utils.js");
    return {
      ...actual,
      describeUnknownError: vi.fn((err: unknown) => String(err)),
      mapThinkingLevel: vi.fn((level?: string) => level ?? "off"),
      resolveExecToolDefaults: vi.fn(() => undefined),
    };
  });

  const [compactModule, compactQueuedModule, transcriptEvents, transcriptWriteContext] =
    await Promise.all([
      import("./compact.js"),
      import("./compact.queued.js"),
      import("../../sessions/transcript-events.js"),
      import("../../config/sessions/transcript-write-context.js"),
    ]);

  return {
    ...compactModule,
    compactEmbeddedAgentSession: compactQueuedModule.compactEmbeddedAgentSession,
    onSessionTranscriptUpdate: transcriptEvents.onSessionTranscriptUpdate,
    onInternalSessionTranscriptUpdate: transcriptEvents.onInternalSessionTranscriptUpdate,
    withOwnedSessionTranscriptWrites: transcriptWriteContext.withOwnedSessionTranscriptWrites,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

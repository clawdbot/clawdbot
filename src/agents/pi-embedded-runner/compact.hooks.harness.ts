import { vi, type Mock } from "vitest";
import { clearAgentHarnesses } from "../harness/registry.js";

type MockResolvedModel = {
  model: { provider: string; api: string; id: string; input: unknown[] };
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
export const resolveContextEngineMock = vi.fn(async () => ({
  info: { ownsCompaction: true as boolean },
  compact: contextEngineCompactMock,
}));
export const resolveModelMock: Mock<
  (provider?: string, modelId?: string, agentDir?: string, cfg?: unknown) => MockResolvedModel
> = vi.fn((_provider?: string, _modelId?: string, _agentDir?: string, _cfg?: unknown) => ({
  model: { provider: "openai", api: "responses", id: "fake", input: [] },
  error: null,
  authStorage: { setRuntimeApiKey: vi.fn() },
  modelRegistry: {},
}));
export const sessionCompactImpl = vi.fn(async () => ({
  summary: "summary",
  firstKeptEntryId: "entry-1",
  tokensBefore: 120,
  details: { ok: true },
}));
export const triggerInternalHook: Mock<(event?: unknown) => void> = vi.fn();
export const sanitizeSessionHistoryMock = vi.fn(
  async (params: { messages: unknown[] }) => params.messages,
);
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
export const estimateTokensMock = vi.fn((_message?: unknown) => 10);
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
export const createOpenClawCodingToolsMock = vi.fn(() => []);
export const resolveEmbeddedAgentStreamFnMock: Mock<
  (params?: unknown) => MockEmbeddedAgentStreamFn
> = vi.fn((_params?: unknown) => vi.fn());
export const registerProviderStreamForModelMock: Mock<(params?: unknown) => unknown> = vi.fn();
export const applyExtraParamsToAgentMock = vi.fn(() => ({ effectiveExtraParams: {} }));
export const resolveAgentTransportOverrideMock: Mock<(params?: unknown) => string | undefined> =
  vi.fn(() => undefined);
export const resolveSandboxContextMock = vi.fn(async () => null);
export const maybeCompactAgentHarnessSessionMock: Mock<(params?: unknown) => Promise<unknown>> =
  vi.fn(async () => undefined);

export function resetCompactSessionStateMocks(): void {
  sanitizeSessionHistoryMock.mockReset();
  sanitizeSessionHistoryMock.mockImplementation(async (params: { messages: unknown[] }) => {
    return params.messages;
  });

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
  estimateTokensMock.mockReset();
  estimateTokensMock.mockReturnValue(10);
  sessionMessages.splice(0, sessionMessages.length, ...createDefaultSessionMessages());
  sessionAbortCompactionMock.mockReset();
  resolveEmbeddedAgentStreamFnMock.mockReset();
  resolveEmbeddedAgentStreamFnMock.mockImplementation((_params?: unknown) => vi.fn());
  registerProviderStreamForModelMock.mockReset();
  registerProviderStreamForModelMock.mockReturnValue(undefined);
  applyExtraParamsToAgentMock.mockReset();
  applyExtraParamsToAgentMock.mockReturnValue({ effectiveExtraParams: {} });
  resolveAgentTransportOverrideMock.mockReset();
  resolveAgentTransportOverrideMock.mockReturnValue(undefined);
  resolveSandboxContextMock.mockReset();
  resolveSandboxContextMock.mockResolvedValue(null);
  maybeCompactAgentHarnessSessionMock.mockReset();
  maybeCompactAgentHarnessSessionMock.mockResolvedValue(undefined);
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

  resolveModelMock.mockReset();
  resolveModelMock.mockReturnValue({
    model: { provider: "openai", api: "responses", id: "fake", input: [] },
    error: null,
    authStorage: { setRuntimeApiKey: vi.fn() },
    modelRegistry: {},
  });

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
}

export async function loadCompactHooksHarness(): Promise<{
  compactEmbeddedPiSessionDirect: typeof import("./compact.js").compactEmbeddedPiSessionDirect;
  compactEmbeddedPiSession: typeof import("./compact.queued.js").compactEmbeddedPiSession;
  __testing: typeof import("./compact.js").__testing;
  onSessionTranscriptUpdate: typeof import("../../sessions/transcript-events.js").onSessionTranscriptUpdate;
}> {
  resetCompactHooksHarnessMocks();
  vi.resetModules();

  vi.doMock("../../plugins/hook-runner-global.js", () => ({
    getGlobalHookRunner: () => hookRunner,
  }));

  vi.doMock("../runtime-plugins.js", () => ({
    ensureRuntimePluginsLoaded,
  }));

  vi.doMock("../harness/selection.js", () => ({
    maybeCompactAgentHarnessSession: maybeCompactAgentHarnessSessionMock,
  }));

  vi.doMock("../../plugins/provider-runtime.js", () => ({
    prepareProviderRuntimeAuth: vi.fn(async () => ({ resolvedApiKey: undefined })),
    resolveProviderSystemPromptContribution: vi.fn(() => undefined),
    resolveProviderTextTransforms: vi.fn(() => undefined),
    transformProviderSystemPrompt: vi.fn(
      (params: { systemPrompt?: string }) => params.systemPrompt,
    ),
  }));

  vi.doMock("../provider-stream.js", () => ({
    registerProviderStreamForModel: registerProviderStreamForModelMock,
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

  vi.doMock("@mariozechner/pi-ai/oauth", async () => {
    const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
      "@mariozechner/pi-ai/oauth",
    );
    return {
      ...actual,
      getOAuthApiKey: vi.fn(),
      getOAuthProviders: vi.fn(() => []),
    };
  });

  vi.doMock("@mariozechner/pi-coding-agent", () => ({
    AuthStorage: function AuthStorage() {},
    ModelRegistry: function ModelRegistry() {},
    createAgentSession: vi.fn(async () => {
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
          },
        },
        compact: vi.fn(async () => {
          session.messages.splice(1);
          return await sessionCompactImpl();
        }),
        abortCompaction: sessionAbortCompactionMock,
        dispose: vi.fn(),
      };
      return { session };
    }),
    DefaultResourceLoader: function DefaultResourceLoader() {},
    SessionManager: {
      open: vi.fn(() => ({})),
    },
    SettingsManager: {
      create: vi.fn(() => ({})),
    },
    estimateTokens: estimateTokensMock,
    generateSummary: vi.fn(async () => "summary"),
  }));

  vi.doMock("../session-tool-result-guard-wrapper.js", () => ({
    guardSessionManager: vi.fn(() => ({
      flushPendingToolResults: vi.fn(),
    })),
  }));

  vi.doMock("../pi-settings.js", () => ({
    ensurePiCompactionReserveTokens: vi.fn(),
    resolveCompactionReserveTokensFloor: vi.fn(() => 0),
  }));

  vi.doMock("../models-config.js", () => ({
    ensureOpenClawModelsJson: vi.fn(async () => {}),
  }));

  vi.doMock("../model-auth.js", () => ({
    applyAuthHeaderOverride: vi.fn((model: unknown) => model),
    applyLocalNoAuthHeaderOverride: vi.fn((model: unknown) => model),
    getApiKeyForModel: vi.fn(async () => ({ apiKey: "test", mode: "env" })),
    resolveModelAuthMode: vi.fn(() => "env"),
  }));

  vi.doMock("../sandbox.js", () => ({
    resolveSandboxContext: resolveSandboxContextMock,
  }));

  vi.doMock("../session-file-repair.js", () => ({
    repairSessionFileIfNeeded: vi.fn(async () => {}),
  }));

  vi.doMock("../session-write-lock.js", () => ({
    acquireSessionWriteLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
    resolveSessionLockMaxHoldFromTimeout: vi.fn(() => 0),
  }));

  vi.doMock("../../context-engine/init.js", () => ({
    ensureContextEnginesInitialized: vi.fn(),
  }));

  vi.doMock("../../context-engine/registry.js", () => ({
    resolveContextEngine: resolveContextEngineMock,
  }));

  vi.doMock("../../process/command-queue.js", () => ({
    enqueueCommandInLane: vi.fn((_lane: unknown, task: () => unknown) => task()),
    clearCommandLane: vi.fn(() => 0),
  }));

  vi.doMock("./lanes.js", () => ({
    resolveSessionLane: vi.fn(() => "test-session-lane"),
    resolveGlobalLane: vi.fn(() => "test-global-lane"),
  }));

  vi.doMock("../context-window-guard.js", () => ({
    resolveContextWindowInfo: vi.fn(() => ({ tokens: 128_000 })),
  }));

  vi.doMock("../bootstrap-files.js", () => ({
    makeBootstrapWarn: vi.fn(() => () => {}),
    resolveBootstrapContextForRun: vi.fn(async () => ({ contextFiles: [] })),
  }));

  vi.doMock("../pi-bundle-mcp-tools.js", () => ({
    retireSessionMcpRuntime: vi.fn(async () => true),
    createBundleMcpToolRuntime: vi.fn(async () => ({
      tools: [],
      dispose: vi.fn(async () => {}),
    })),
  }));

  vi.doMock("../pi-bundle-lsp-runtime.js", () => ({
    createBundleLspToolRuntime: vi.fn(async () => ({
      tools: [],
      sessions: [],
      dispose: vi.fn(async () => {}),
    })),
  }));

  vi.doMock("../docs-path.js", () => ({
    resolveOpenClawDocsPath: vi.fn(async () => undefined),
  }));

  vi.doMock("../channel-tools.js", () => ({
    listChannelSupportedActions: vi.fn(() => undefined),
    resolveChannelMessageToolHints: vi.fn(() => undefined),
  }));

  vi.doMock("../pi-tools.js", () => ({
    createOpenClawCodingTools: createOpenClawCodingToolsMock,
  }));

  vi.doMock("./replay-history.js", () => ({
    sanitizeSessionHistory: sanitizeSessionHistoryMock,
    validateReplayTurns: vi.fn(async ({ messages }: { messages: unknown[] }) => messages),
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
  }));

  vi.doMock("./tool-split.js", () => ({
    splitSdkTools: vi.fn(() => ({ customTools: [] })),
  }));

  vi.doMock("./compaction-safety-timeout.js", () => ({
    compactWithSafetyTimeout: vi.fn(
      async (
        compact: () => Promise<unknown>,
        _timeoutMs?: number,
        opts?: { abortSignal?: AbortSignal; onCancel?: () => void },
      ) => {
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
      },
    ),
    resolveCompactionTimeoutMs: vi.fn(() => 30_000),
  }));

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
    buildEmbeddedExtensionFactories: vi.fn(() => []),
  }));

  vi.doMock("./history.js", () => ({
    getDmHistoryLimitFromSessionKey: vi.fn(() => undefined),
    limitHistoryTurns: vi.fn((msgs: unknown[]) => msgs.slice(0, 2)),
  }));

  vi.doMock("../skills.js", () => ({
    applySkillEnvOverrides: vi.fn(() => () => {}),
    applySkillEnvOverridesFromSnapshot: vi.fn(() => () => {}),
    loadWorkspaceSkillEntries: vi.fn(() => []),
    resolveSkillsPromptForRun: vi.fn(() => undefined),
  }));

  vi.doMock("../agent-paths.js", () => ({
    resolveOpenClawAgentDir: vi.fn(() => "/tmp"),
  }));

  vi.doMock("../agent-scope.js", () => ({
    listAgentEntries: vi.fn(() => []),
    resolveSessionAgentId: resolveSessionAgentIdMock,
    resolveSessionAgentIds: vi.fn(() => ({ defaultAgentId: "main", sessionAgentId: "main" })),
  }));

  vi.doMock("../memory-search.js", () => ({
    resolveMemorySearchConfig: resolveMemorySearchConfigMock,
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

  vi.doMock("../pi-embedded-helpers.js", () => ({
    ensureSessionHeader: vi.fn(async () => {}),
    pickFallbackThinkingLevel: vi.fn((params: { message?: string; attempted?: Set<string> }) =>
      params.message?.includes("Reasoning is mandatory") && !params.attempted?.has("minimal")
        ? "minimal"
        : undefined,
    ),
    validateAnthropicTurns: vi.fn((m: unknown[]) => m),
    validateGeminiTurns: vi.fn((m: unknown[]) => m),
  }));

  vi.doMock("../pi-project-settings.js", () => ({
    createPreparedEmbeddedPiSettingsManager: vi.fn(() => ({
      getGlobalSettings: vi.fn(() => ({})),
    })),
  }));

  vi.doMock("./sandbox-info.js", () => ({
    buildEmbeddedSandboxInfo: vi.fn(() => undefined),
  }));

  vi.doMock("./model.js", () => ({
    buildModelAliasLines: vi.fn(() => []),
    resolveModel: resolveModelMock,
    resolveModelAsync: vi.fn(
      async (provider: string, modelId: string, agentDir?: string, cfg?: unknown) =>
        resolveModelMock(provider, modelId, agentDir, cfg),
    ),
  }));

  vi.doMock("./session-manager-cache.js", () => ({
    prewarmSessionFile: vi.fn(async () => {}),
    trackSessionManagerAccess: vi.fn(),
  }));

  vi.doMock("./system-prompt.js", () => ({
    applySystemPromptOverrideToSession: vi.fn(),
    buildEmbeddedSystemPrompt: vi.fn(() => ""),
    createSystemPromptOverride: vi.fn(() => () => ""),
  }));

  vi.doMock("./utils.js", () => ({
    describeUnknownError: vi.fn((err: unknown) => String(err)),
    mapThinkingLevel: vi.fn((level?: string) => level ?? "off"),
    resolveExecToolDefaults: vi.fn(() => undefined),
  }));

  const [compactModule, compactQueuedModule, transcriptEvents] = await Promise.all([
    import("./compact.js"),
    import("./compact.queued.js"),
    import("../../sessions/transcript-events.js"),
  ]);

  return {
    ...compactModule,
    compactEmbeddedPiSession: compactQueuedModule.compactEmbeddedPiSession,
    onSessionTranscriptUpdate: transcriptEvents.onSessionTranscriptUpdate,
  };
}

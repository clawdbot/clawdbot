import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { expect, vi, type Mock } from "vitest";
import type {
  AssembleResult,
  BootstrapResult,
  CompactResult,
  ContextEngineInfo,
  IngestBatchResult,
  IngestResult,
} from "../../../context-engine/types.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../../shared/string-coerce.js";
import type { EmbeddedContextFile } from "../../pi-embedded-helpers.js";
import type { MessagingToolSend } from "../../pi-embedded-messaging.types.js";
import type { WorkspaceBootstrapFile } from "../../workspace.js";

type SubscribeEmbeddedPiSessionFn =
  typeof import("../../pi-embedded-subscribe.js").subscribeEmbeddedPiSession;
type AcquireSessionWriteLockFn =
  typeof import("../../session-write-lock.js").acquireSessionWriteLock;

type SubscriptionMock = ReturnType<SubscribeEmbeddedPiSessionFn>;
type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type BootstrapContext = {
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
};
type SessionManagerMocks = {
  getLeafEntry: UnknownMock;
  branch: UnknownMock;
  resetLeaf: UnknownMock;
  buildSessionContext: Mock<() => { messages: AgentMessage[] }>;
  appendCustomEntry: UnknownMock;
  flushPendingToolResults: UnknownMock;
  clearPendingToolResults: UnknownMock;
};
type AttemptSpawnWorkspaceHoisted = {
  spawnSubagentDirectMock: UnknownMock;
  createAgentSessionMock: UnknownMock;
  sessionManagerOpenMock: UnknownMock;
  resolveSandboxContextMock: UnknownMock;
  ensureGlobalUndiciEnvProxyDispatcherMock: UnknownMock;
  ensureGlobalUndiciStreamTimeoutsMock: UnknownMock;
  buildEmbeddedMessageActionDiscoveryInputMock: UnknownMock;
  subscribeEmbeddedPiSessionMock: Mock<SubscribeEmbeddedPiSessionFn>;
  acquireSessionWriteLockMock: Mock<AcquireSessionWriteLockFn>;
  installToolResultContextGuardMock: UnknownMock;
  flushPendingToolResultsAfterIdleMock: AsyncUnknownMock;
  releaseWsSessionMock: UnknownMock;
  resolveBootstrapContextForRunMock: Mock<() => Promise<BootstrapContext>>;
  resolveContextInjectionModeMock: Mock<() => "always" | "continuation-skip">;
  hasCompletedBootstrapTurnMock: Mock<() => Promise<boolean>>;
  getGlobalHookRunnerMock: Mock<() => unknown>;
  initializeGlobalHookRunnerMock: UnknownMock;
  runContextEngineMaintenanceMock: AsyncUnknownMock;
  getDmHistoryLimitFromSessionKeyMock: Mock<
    (sessionKey: string | undefined, config: unknown) => number | undefined
  >;
  limitHistoryTurnsMock: Mock<<T>(messages: T, limit: number | undefined) => T>;
  sessionManager: SessionManagerMocks;
};

const hoisted = vi.hoisted((): AttemptSpawnWorkspaceHoisted => {
  const spawnSubagentDirectMock = vi.fn();
  const createAgentSessionMock = vi.fn();
  const sessionManagerOpenMock = vi.fn();
  const resolveSandboxContextMock = vi.fn();
  const ensureGlobalUndiciEnvProxyDispatcherMock = vi.fn();
  const ensureGlobalUndiciStreamTimeoutsMock = vi.fn();
  const buildEmbeddedMessageActionDiscoveryInputMock = vi.fn((params: unknown) => params);
  const installToolResultContextGuardMock = vi.fn(() => () => {});
  const flushPendingToolResultsAfterIdleMock = vi.fn(async () => {});
  const releaseWsSessionMock = vi.fn(() => {});
  const subscribeEmbeddedPiSessionMock = vi.fn<SubscribeEmbeddedPiSessionFn>(
    (_params) =>
      ({
        assistantTexts: [] as string[],
        toolMetas: [] as Array<{ toolName: string; meta?: string }>,
        unsubscribe: () => {},
        setTerminalLifecycleMeta: () => {},
        waitForCompactionRetry: async () => {},
        getMessagingToolSentTexts: () => [] as string[],
        getMessagingToolSentMediaUrls: () => [] as string[],
        getMessagingToolSentTargets: () => [] as MessagingToolSend[],
        getSuccessfulCronAdds: () => 0,
        getReplayState: () => ({
          replayInvalid: false,
          hadPotentialSideEffects: false,
        }),
        didSendViaMessagingTool: () => false,
        didSendDeterministicApprovalPrompt: () => false,
        getLastToolError: () => undefined,
        getUsageTotals: () => undefined,
        getCompactionCount: () => 0,
        getItemLifecycle: () => ({ startedCount: 0, completedCount: 0, activeCount: 0 }),
        isCompacting: () => false,
        isCompactionInFlight: () => false,
      }) satisfies SubscriptionMock,
  );
  const acquireSessionWriteLockMock = vi.fn<AcquireSessionWriteLockFn>(async (_params) => ({
    release: async () => {},
  }));
  const resolveBootstrapContextForRunMock = vi.fn<() => Promise<BootstrapContext>>(async () => ({
    bootstrapFiles: [],
    contextFiles: [],
  }));
  const resolveContextInjectionModeMock = vi.fn<() => "always" | "continuation-skip">(
    () => "always",
  );
  const hasCompletedBootstrapTurnMock = vi.fn<() => Promise<boolean>>(async () => false);
  const getGlobalHookRunnerMock = vi.fn<() => unknown>(() => undefined);
  const initializeGlobalHookRunnerMock = vi.fn();
  const runContextEngineMaintenanceMock = vi.fn(async (_params?: unknown) => undefined);
  const getDmHistoryLimitFromSessionKeyMock = vi.fn<
    (sessionKey: string | undefined, config: unknown) => number | undefined
  >(() => undefined);
  const limitHistoryTurnsMock = vi.fn<<T>(messages: T, limit: number | undefined) => T>(
    (messages) => messages,
  );
  const sessionManager = {
    getLeafEntry: vi.fn(() => null),
    branch: vi.fn(),
    resetLeaf: vi.fn(),
    buildSessionContext: vi.fn<() => { messages: AgentMessage[] }>(() => ({ messages: [] })),
    appendCustomEntry: vi.fn(),
    flushPendingToolResults: vi.fn(),
    clearPendingToolResults: vi.fn(),
  };
  return {
    spawnSubagentDirectMock,
    createAgentSessionMock,
    sessionManagerOpenMock,
    resolveSandboxContextMock,
    ensureGlobalUndiciEnvProxyDispatcherMock,
    ensureGlobalUndiciStreamTimeoutsMock,
    buildEmbeddedMessageActionDiscoveryInputMock,
    subscribeEmbeddedPiSessionMock,
    acquireSessionWriteLockMock,
    installToolResultContextGuardMock,
    flushPendingToolResultsAfterIdleMock,
    releaseWsSessionMock,
    resolveBootstrapContextForRunMock,
    resolveContextInjectionModeMock,
    hasCompletedBootstrapTurnMock,
    getGlobalHookRunnerMock,
    initializeGlobalHookRunnerMock,
    runContextEngineMaintenanceMock,
    getDmHistoryLimitFromSessionKeyMock,
    limitHistoryTurnsMock,
    sessionManager,
  };
});

export function getHoisted(): AttemptSpawnWorkspaceHoisted {
  return hoisted;
}

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );
  function AuthStorage() {}
  class DefaultResourceLoader {
    async reload() {}
  }
  function ModelRegistry() {}

  return {
    ...actual,
    AuthStorage,
    createAgentSession: (...args: unknown[]) => hoisted.createAgentSessionMock(...args),
    DefaultResourceLoader,
    estimateTokens: () => 0,
    generateSummary: async () => "",
    ModelRegistry,
    SessionManager: {
      open: (...args: unknown[]) => hoisted.sessionManagerOpenMock(...args),
    },
  };
});

vi.mock("../../subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnSubagentDirectMock(...args),
}));

vi.mock("../../sandbox.js", () => ({
  resolveSandboxContext: (...args: unknown[]) => hoisted.resolveSandboxContextMock(...args),
}));

vi.mock("../../session-tool-result-guard-wrapper.js", () => ({
  guardSessionManager: () => hoisted.sessionManager,
}));

vi.mock("../../pi-embedded-subscribe.js", () => ({
  subscribeEmbeddedPiSession: (params: Parameters<SubscribeEmbeddedPiSessionFn>[0]) =>
    hoisted.subscribeEmbeddedPiSessionMock(params),
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: hoisted.getGlobalHookRunnerMock,
  initializeGlobalHookRunner: hoisted.initializeGlobalHookRunnerMock,
}));

vi.mock("../../../infra/machine-name.js", () => ({
  getMachineDisplayName: async () => "test-host",
}));

vi.mock("../../../infra/net/undici-global-dispatcher.js", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: (...args: unknown[]) =>
    hoisted.ensureGlobalUndiciEnvProxyDispatcherMock(...args),
  ensureGlobalUndiciStreamTimeouts: (...args: unknown[]) =>
    hoisted.ensureGlobalUndiciStreamTimeoutsMock(...args),
}));

vi.mock("../../bootstrap-files.js", async () => {
  const actual = await vi.importActual<typeof import("../../bootstrap-files.js")>(
    "../../bootstrap-files.js",
  );
  return {
    ...actual,
    makeBootstrapWarn: () => () => {},
    resolveBootstrapContextForRun: hoisted.resolveBootstrapContextForRunMock,
    resolveContextInjectionMode: hoisted.resolveContextInjectionModeMock,
    hasCompletedBootstrapTurn: hoisted.hasCompletedBootstrapTurnMock,
  };
});

vi.mock("../../skills.js", () => ({
  applySkillEnvOverrides: () => () => {},
  applySkillEnvOverridesFromSnapshot: () => () => {},
  resolveSkillsPromptForRun: () => "",
}));

vi.mock("../skills-runtime.js", () => ({
  resolveEmbeddedRunSkillEntries: () => ({
    shouldLoadSkillEntries: false,
    skillEntries: undefined,
  }),
}));

vi.mock("../context-engine-maintenance.js", () => ({
  runContextEngineMaintenance: (params: unknown) => hoisted.runContextEngineMaintenanceMock(params),
}));

vi.mock("../../docs-path.js", () => ({
  resolveOpenClawDocsPath: async () => undefined,
}));

vi.mock("../../pi-project-settings.js", () => ({
  createPreparedEmbeddedPiSettingsManager: () => ({
    getCompactionReserveTokens: () => 0,
    getCompactionKeepRecentTokens: () => 40_000,
    applyOverrides: () => {},
    setCompactionEnabled: () => {},
  }),
}));

vi.mock("../../pi-settings.js", () => ({
  applyPiAutoCompactionGuard: () => {},
}));

vi.mock("../extensions.js", () => ({
  buildEmbeddedExtensionFactories: () => [],
}));

vi.mock("../replay-history.js", () => ({
  sanitizeSessionHistory: async ({ messages }: { messages: unknown[] }) => messages,
  validateReplayTurns: async ({ messages }: { messages: unknown[] }) => messages,
}));

vi.mock("../tool-schema-runtime.js", () => ({
  logProviderToolSchemaDiagnostics: () => {},
  normalizeProviderToolSchemas: ({ tools }: { tools: unknown[] }) => tools,
}));

vi.mock("../../session-file-repair.js", () => ({
  repairSessionFileIfNeeded: async () => {},
}));

vi.mock("../session-manager-cache.js", () => ({
  prewarmSessionFile: async () => {},
  trackSessionManagerAccess: () => {},
}));

vi.mock("../session-manager-init.js", () => ({
  prepareSessionManagerForRun: async () => {},
}));

vi.mock("../../session-write-lock.js", () => ({
  acquireSessionWriteLock: (params: Parameters<AcquireSessionWriteLockFn>[0]) =>
    hoisted.acquireSessionWriteLockMock(params),
  resolveSessionLockMaxHoldFromTimeout: () => 1,
}));

vi.mock("../tool-result-context-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../tool-result-context-guard.js")>(
    "../tool-result-context-guard.js",
  );
  return {
    ...actual,
    formatContextLimitTruncationNotice: (truncatedChars: number) =>
      `[... ${Math.max(1, Math.floor(truncatedChars))} more characters truncated]`,
    installToolResultContextGuard: (...args: unknown[]) =>
      (hoisted.installToolResultContextGuardMock as (...args: unknown[]) => unknown)(...args),
  };
});

vi.mock("../wait-for-idle-before-flush.js", () => ({
  flushPendingToolResultsAfterIdle: (...args: unknown[]) =>
    (hoisted.flushPendingToolResultsAfterIdleMock as (...args: unknown[]) => unknown)(...args),
}));

vi.mock("../runs.js", () => ({
  setActiveEmbeddedRun: () => {},
  clearActiveEmbeddedRun: () => {},
  updateActiveEmbeddedRunSnapshot: () => {},
}));

vi.mock("./images.js", () => ({
  detectAndLoadPromptImages: async () => ({ images: [] }),
}));

vi.mock("../../system-prompt-params.js", () => ({
  buildSystemPromptParams: () => ({
    runtimeInfo: {},
    userTimezone: "UTC",
    userTime: "00:00",
    userTimeFormat: "24h",
  }),
}));

vi.mock("../../system-prompt-report.js", () => ({
  buildSystemPromptReport: () => undefined,
}));

vi.mock("../system-prompt.js", () => ({
  applySystemPromptOverrideToSession: () => {},
  buildEmbeddedSystemPrompt: () => "system prompt",
  createSystemPromptOverride: (prompt: string) => () => prompt,
}));

vi.mock("../extra-params.js", async () => {
  const actual = await vi.importActual<typeof import("../extra-params.js")>("../extra-params.js");
  return {
    ...actual,
    applyExtraParamsToAgent: () => ({ effectiveExtraParams: {} }),
    resolveAgentTransportOverride: () => undefined,
  };
});

vi.mock("../../openai-ws-stream.js", () => ({
  createOpenAIWebSocketStreamFn: vi.fn(),
  releaseWsSession: (...args: unknown[]) =>
    (hoisted.releaseWsSessionMock as (...args: unknown[]) => unknown)(...args),
}));

vi.mock("../../anthropic-payload-log.js", () => ({
  createAnthropicPayloadLogger: () => undefined,
}));

vi.mock("../../cache-trace.js", () => ({
  createCacheTrace: () => undefined,
}));

vi.mock("../../pi-tools.js", () => ({
  createOpenClawCodingTools: (options?: { workspaceDir?: string; spawnWorkspaceDir?: string }) => [
    {
      name: "sessions_spawn",
      execute: async (
        _callId: string,
        input: { task?: string },
        _session?: unknown,
        _abortSignal?: unknown,
        _ctx?: unknown,
      ) =>
        await hoisted.spawnSubagentDirectMock(
          {
            task: input.task ?? "",
          },
          {
            workspaceDir: options?.spawnWorkspaceDir ?? options?.workspaceDir,
          },
        ),
    },
  ],
  resolveToolLoopDetectionConfig: () => undefined,
}));

vi.mock("../../pi-bundle-mcp-tools.js", () => ({
  createBundleMcpToolRuntime: async () => undefined,
  getOrCreateSessionMcpRuntime: async () => undefined,
  materializeBundleMcpToolsForRun: async () => undefined,
}));

vi.mock("../../pi-bundle-lsp-runtime.js", () => ({
  createBundleLspToolRuntime: async () => undefined,
}));

vi.mock("../../../image-generation/runtime.js", () => ({
  generateImage: vi.fn(),
  listRuntimeImageGenerationProviders: () => [],
}));

vi.mock("../../model-selection.js", () => ({
  normalizeProviderId: (providerId?: string) => normalizeLowercaseStringOrEmpty(providerId),
  resolveDefaultModelForAgent: () => ({ provider: "openai", model: "gpt-test" }),
}));

vi.mock("../../anthropic-vertex-stream.js", () => ({
  createAnthropicVertexStreamFnForModel: vi.fn(),
}));

vi.mock("../../custom-api-registry.js", () => ({
  ensureCustomApiRegistered: () => {},
}));

vi.mock("../../model-auth.js", () => ({
  resolveModelAuthMode: () => undefined,
}));

vi.mock("../../model-tool-support.js", () => ({
  supportsModelTools: () => true,
}));

vi.mock("../../provider-stream.js", () => ({
  registerProviderStreamForModel: vi.fn(),
}));

vi.mock("../../owner-display.js", () => ({
  resolveOwnerDisplaySetting: () => ({
    ownerDisplay: undefined,
    ownerDisplaySecret: undefined,
  }),
}));

vi.mock("../../sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: () => ({
    agentId: "main",
    sessionKey: "agent:main:main",
    mainSessionKey: "agent:main:main",
    mode: "off",
    sandboxed: false,
    toolPolicy: { allow: [], deny: [], sources: { allow: { key: "" }, deny: { key: "" } } },
  }),
}));

vi.mock("../../tool-call-id.js", () => ({
  sanitizeToolCallIdsForCloudCodeAssist: <T>(messages: T) => messages,
}));

vi.mock("../../tool-fs-policy.js", () => ({
  resolveEffectiveToolFsWorkspaceOnly: () => false,
}));

vi.mock("../../tool-policy.js", () => ({
  normalizeToolName: (name: string) => name,
}));

vi.mock("../../transcript-policy.js", () => ({
  resolveTranscriptPolicy: () => ({
    allowSyntheticToolResults: false,
  }),
}));

vi.mock("../cache-ttl.js", () => ({
  appendCacheTtlTimestamp: (
    sessionManager: { appendCustomEntry?: (customType: string, data: unknown) => void },
    data: unknown,
  ) => sessionManager.appendCustomEntry?.("openclaw.cache-ttl", data),
  isCacheTtlEligibleProvider: (provider?: string) => provider === "anthropic",
  readLastCacheTtlTimestamp: (
    sessionManager: {
      appendCustomEntry?: { mock?: { calls?: unknown[][] } };
    },
    context?: { provider?: string; modelId?: string },
  ) => {
    const calls = sessionManager.appendCustomEntry?.mock?.calls ?? [];
    for (let index = calls.length - 1; index >= 0; index -= 1) {
      const [customType, data] = calls[index] ?? [];
      if (customType !== "openclaw.cache-ttl") {
        continue;
      }
      const entry = data as
        | {
            timestamp?: unknown;
            provider?: string;
            modelId?: string;
          }
        | undefined;
      if (
        context?.provider &&
        normalizeOptionalLowercaseString(entry?.provider) !==
          normalizeOptionalLowercaseString(context.provider)
      ) {
        continue;
      }
      if (
        context?.modelId &&
        normalizeOptionalLowercaseString(entry?.modelId) !==
          normalizeOptionalLowercaseString(context.modelId)
      ) {
        continue;
      }
      const timestamp = entry?.timestamp;
      return typeof timestamp === "number" ? timestamp : null;
    }
    return null;
  },
}));

vi.mock("../compaction-runtime-context.js", () => ({
  buildEmbeddedCompactionRuntimeContext: () => ({}),
}));

vi.mock("../compaction-safety-timeout.js", () => ({
  resolveCompactionTimeoutMs: () => undefined,
}));

vi.mock("../history.js", () => ({
  getDmHistoryLimitFromSessionKey: (sessionKey: string | undefined, config: unknown) =>
    hoisted.getDmHistoryLimitFromSessionKeyMock(sessionKey, config),
  limitHistoryTurns: <T>(messages: T, limit: number | undefined) =>
    hoisted.limitHistoryTurnsMock(messages, limit),
}));

vi.mock("../logger.js", () => ({
  log: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    isEnabled: () => false,
  },
}));

vi.mock("../message-action-discovery-input.js", () => ({
  buildEmbeddedMessageActionDiscoveryInput: (...args: unknown[]) =>
    hoisted.buildEmbeddedMessageActionDiscoveryInputMock(...args),
}));

vi.mock("../model.js", () => ({
  buildModelAliasLines: () => [],
}));

vi.mock("../sandbox-info.js", () => ({
  buildEmbeddedSandboxInfo: () => undefined,
}));

vi.mock("../thinking.js", () => ({
  dropThinkingBlocks: <T>(messages: T) => messages,
}));

vi.mock("../tool-name-allowlist.js", () => ({
  collectAllowedToolNames: () => undefined,
}));

vi.mock("../tool-split.js", () => ({
  splitSdkTools: ({ tools }: { tools: unknown[] }) => ({
    builtInTools: [],
    customTools: tools,
  }),
}));

vi.mock("../utils.js", () => ({
  describeUnknownError: (error: unknown) => formatErrorMessage(error),
  mapThinkingLevel: () => undefined,
}));

vi.mock("./compaction-retry-aggregate-timeout.js", () => ({
  waitForCompactionRetryWithAggregateTimeout: async () => ({
    timedOut: false,
    aborted: false,
  }),
}));

vi.mock("./compaction-timeout.js", () => ({
  resolveRunTimeoutDuringCompaction: () => "abort",
  resolveRunTimeoutWithCompactionGraceMs: ({
    runTimeoutMs,
    compactionTimeoutMs,
  }: {
    runTimeoutMs: number;
    compactionTimeoutMs: number;
  }) => runTimeoutMs + compactionTimeoutMs,
  selectCompactionTimeoutSnapshot: ({
    currentSnapshot,
    currentSessionId,
  }: {
    currentSnapshot: unknown[];
    currentSessionId: string;
  }) => ({
    messagesSnapshot: currentSnapshot,
    sessionIdUsed: currentSessionId,
    source: "current",
  }),
  shouldFlagCompactionTimeout: () => false,
}));

vi.mock("./history-image-prune.js", () => ({
  pruneProcessedHistoryImages: <T>(messages: T) => messages,
}));

export type MutableSession = {
  sessionId: string;
  messages: unknown[];
  isCompacting: boolean;
  isStreaming: boolean;
  agent: {
    streamFn?: unknown;
    transport?: string;
    state: {
      messages: unknown[];
      systemPrompt?: string;
    };
  };
  prompt: (prompt: string, options?: { images?: unknown[] }) => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
  steer: (text: string) => Promise<void>;
};

export function createSubscriptionMock(): SubscriptionMock {
  return {
    assistantTexts: [] as string[],
    toolMetas: [] as Array<{ toolName: string; meta?: string }>,
    unsubscribe: () => {},
    setTerminalLifecycleMeta: () => {},
    waitForCompactionRetry: async () => {},
    getMessagingToolSentTexts: () => [] as string[],
    getMessagingToolSentMediaUrls: () => [] as string[],
    getMessagingToolSentTargets: () => [] as MessagingToolSend[],
    getSuccessfulCronAdds: () => 0,
    getReplayState: () => ({
      replayInvalid: false,
      hadPotentialSideEffects: false,
    }),
    didSendViaMessagingTool: () => false,
    didSendDeterministicApprovalPrompt: () => false,
    getLastToolError: () => undefined,
    getUsageTotals: () => undefined,
    getCompactionCount: () => 0,
    getItemLifecycle: () => ({ startedCount: 0, completedCount: 0, activeCount: 0 }),
    isCompacting: () => false,
    isCompactionInFlight: () => false,
  };
}

type SessionPromptOverride = (
  session: MutableSession,
  prompt: string,
  options?: { images?: unknown[] },
) => Promise<void>;

let runEmbeddedAttemptPromise:
  | Promise<typeof import("./attempt.js").runEmbeddedAttempt>
  | undefined;
const ATTEMPT_SPAWN_WORKSPACE_TEST_SPECIFIER = "./attempt.ts?spawn-workspace-test";

async function loadRunEmbeddedAttempt() {
  runEmbeddedAttemptPromise ??= (
    import(ATTEMPT_SPAWN_WORKSPACE_TEST_SPECIFIER) as Promise<typeof import("./attempt.js")>
  ).then((mod) => mod.runEmbeddedAttempt);
  return await runEmbeddedAttemptPromise;
}

export function resetEmbeddedAttemptHarness(
  params: {
    includeSpawnSubagent?: boolean;
    subscribeImpl?: Parameters<
      (typeof hoisted.subscribeEmbeddedPiSessionMock)["mockImplementation"]
    >[0];
    sessionMessages?: AgentMessage[];
  } = {},
) {
  if (params.includeSpawnSubagent) {
    hoisted.spawnSubagentDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:child",
      runId: "run-child",
    });
  }
  hoisted.createAgentSessionMock.mockReset();
  hoisted.sessionManagerOpenMock.mockReset().mockReturnValue(hoisted.sessionManager);
  hoisted.resolveSandboxContextMock.mockReset();
  hoisted.ensureGlobalUndiciEnvProxyDispatcherMock.mockReset();
  hoisted.ensureGlobalUndiciStreamTimeoutsMock.mockReset();
  hoisted.buildEmbeddedMessageActionDiscoveryInputMock
    .mockReset()
    .mockImplementation((params) => params);
  hoisted.subscribeEmbeddedPiSessionMock
    .mockReset()
    .mockImplementation(() => createSubscriptionMock());
  hoisted.acquireSessionWriteLockMock.mockReset().mockResolvedValue({
    release: async () => {},
  });
  hoisted.installToolResultContextGuardMock.mockReset().mockReturnValue(() => {});
  hoisted.flushPendingToolResultsAfterIdleMock.mockReset().mockResolvedValue(undefined);
  hoisted.releaseWsSessionMock.mockReset().mockReturnValue(undefined);
  hoisted.resolveBootstrapContextForRunMock.mockReset().mockResolvedValue({
    bootstrapFiles: [],
    contextFiles: [],
  });
  hoisted.resolveContextInjectionModeMock.mockReset().mockReturnValue("always");
  hoisted.hasCompletedBootstrapTurnMock.mockReset().mockResolvedValue(false);
  hoisted.getGlobalHookRunnerMock.mockReset().mockReturnValue(undefined);
  hoisted.runContextEngineMaintenanceMock.mockReset().mockResolvedValue(undefined);
  hoisted.getDmHistoryLimitFromSessionKeyMock.mockReset().mockReturnValue(undefined);
  hoisted.limitHistoryTurnsMock.mockReset().mockImplementation((messages) => messages);
  hoisted.sessionManager.getLeafEntry.mockReset().mockReturnValue(null);
  hoisted.sessionManager.branch.mockReset();
  hoisted.sessionManager.resetLeaf.mockReset();
  hoisted.sessionManager.buildSessionContext
    .mockReset()
    .mockReturnValue({ messages: params.sessionMessages ?? [] });
  hoisted.sessionManager.appendCustomEntry.mockReset();
  if (params.subscribeImpl) {
    hoisted.subscribeEmbeddedPiSessionMock.mockImplementation(params.subscribeImpl);
  }
}

export async function cleanupTempPaths(tempPaths: string[]) {
  while (tempPaths.length > 0) {
    const target = tempPaths.pop();
    if (target) {
      await fs.rm(target, { recursive: true, force: true });
    }
  }
}

export function createDefaultEmbeddedSession(params?: {
  initialMessages?: unknown[];
  prompt?: (
    session: MutableSession,
    prompt: string,
    options?: { images?: unknown[] },
  ) => Promise<void>;
}): MutableSession {
  const session: MutableSession = {
    sessionId: "embedded-session",
    messages: [...(params?.initialMessages ?? [])],
    isCompacting: false,
    isStreaming: false,
    agent: {
      state: {
        get messages() {
          return session.messages;
        },
        set messages(messages: unknown[]) {
          session.messages = [...messages];
        },
      },
    },
    prompt: async (prompt, options) => {
      if (params?.prompt) {
        await params.prompt(session, prompt, options);
        return;
      }
      session.messages = [
        ...session.messages,
        { role: "assistant", content: "done", timestamp: 2 },
      ];
    },
    abort: async () => {},
    dispose: () => {},
    steer: async () => {},
  };

  return session;
}

export function createContextEngineBootstrapAndAssemble() {
  return {
    bootstrap: vi.fn(async (_params: { sessionKey?: string }) => ({ bootstrapped: true })),
    assemble: vi.fn(
      async ({ messages }: { messages: AgentMessage[]; sessionKey?: string; model?: string }) => ({
        messages,
        estimatedTokens: 1,
      }),
    ),
  };
}

export function expectCalledWithSessionKey(mock: ReturnType<typeof vi.fn>, sessionKey: string) {
  expect(mock).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionKey,
    }),
  );
}

export const testModel = {
  api: "openai-completions",
  provider: "openai",
  compat: {},
  contextWindow: 8192,
  input: ["text"],
} as unknown as Model<Api>;

export const cacheTtlEligibleModel = {
  api: "anthropic",
  provider: "anthropic",
  compat: {},
  contextWindow: 8192,
  input: ["text"],
} as unknown as Model<Api>;

const testAuthStorage = {
  getApiKey: async () => undefined,
};

export async function createContextEngineAttemptRunner(params: {
  contextEngine: {
    bootstrap?: (params: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
    }) => Promise<BootstrapResult>;
    maintain?:
      | boolean
      | ((params: {
          sessionId: string;
          sessionKey?: string;
          sessionFile: string;
          runtimeContext?: Record<string, unknown>;
        }) => Promise<{
          changed: boolean;
          bytesFreed: number;
          rewrittenEntries: number;
          reason?: string;
        }>);
    assemble: (params: {
      sessionId: string;
      sessionKey?: string;
      messages: AgentMessage[];
      tokenBudget?: number;
      model?: string;
    }) => Promise<AssembleResult>;
    afterTurn?: (params: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
      messages: AgentMessage[];
      prePromptMessageCount: number;
      tokenBudget?: number;
      runtimeContext?: Record<string, unknown>;
    }) => Promise<void>;
    ingestBatch?: (params: {
      sessionId: string;
      sessionKey?: string;
      messages: AgentMessage[];
    }) => Promise<IngestBatchResult>;
    ingest?: (params: {
      sessionId: string;
      sessionKey?: string;
      message: AgentMessage;
    }) => Promise<IngestResult>;
    compact?: (params: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
      tokenBudget?: number;
    }) => Promise<CompactResult>;
    info?: Partial<ContextEngineInfo>;
  };
  attemptOverrides?: Partial<Parameters<Awaited<ReturnType<typeof loadRunEmbeddedAttempt>>>[0]>;
  sessionMessages?: AgentMessage[];
  sessionPrompt?: SessionPromptOverride;
  sessionKey: string;
  tempPaths: string[];
}) {
  const { maintain: rawMaintain, ...contextEngineRest } = params.contextEngine;
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ctx-engine-workspace-"));
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ctx-engine-agent-"));
  const sessionFile = path.join(workspaceDir, "session.jsonl");
  params.tempPaths.push(workspaceDir, agentDir);
  await fs.writeFile(sessionFile, "", "utf8");
  const seedMessages: AgentMessage[] =
    params.sessionMessages ?? ([{ role: "user", content: "seed", timestamp: 1 }] as AgentMessage[]);
  const infoId = params.contextEngine.info?.id ?? "test-context-engine";
  const infoName = params.contextEngine.info?.name ?? "Test Context Engine";
  const infoVersion = params.contextEngine.info?.version ?? "0.0.1";
  const maintain =
    typeof rawMaintain === "function"
      ? rawMaintain
      : rawMaintain
        ? async () => ({
            changed: false,
            bytesFreed: 0,
            rewrittenEntries: 0,
            reason: "test maintenance",
          })
        : undefined;

  hoisted.sessionManager.buildSessionContext
    .mockReset()
    .mockReturnValue({ messages: seedMessages });

  hoisted.createAgentSessionMock.mockImplementation(async () => ({
    session: createDefaultEmbeddedSession({
      initialMessages: seedMessages,
      prompt: params.sessionPrompt,
    }),
  }));

  return await (
    await loadRunEmbeddedAttempt()
  )({
    sessionId: "embedded-session",
    sessionKey: params.sessionKey,
    sessionFile,
    workspaceDir,
    agentDir,
    config: {},
    prompt: "hello",
    timeoutMs: 10_000,
    runId: "run-context-engine-forwarding",
    provider: "openai",
    modelId: "gpt-test",
    model: testModel,
    authStorage: testAuthStorage as never,
    modelRegistry: {} as never,
    thinkLevel: "off",
    senderIsOwner: true,
    disableMessageTool: true,
    contextTokenBudget: 2048,
    contextEngine: {
      ...contextEngineRest,
      ingest:
        params.contextEngine.ingest ??
        (async () => ({
          ingested: true,
        })),
      compact:
        params.contextEngine.compact ??
        (async () => ({
          ok: false,
          compacted: false,
          reason: "not used in this test",
        })),
      ...(maintain ? { maintain } : {}),
      info: {
        id: infoId,
        name: infoName,
        version: infoVersion,
      },
    },
    ...params.attemptOverrides,
  });
}

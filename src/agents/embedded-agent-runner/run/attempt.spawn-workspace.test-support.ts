// Shared harness and mocks for embedded attempt spawn-workspace tests.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { expect, vi, type Mock } from "vitest";
import type {
  AssembleResult,
  BootstrapResult,
  CompactResult,
  ContextEngineInfo,
  ContextEngineMaintenanceResult,
  ContextEngineSessionTarget,
  IngestBatchResult,
  IngestResult,
} from "../../../context-engine/types.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { Model } from "../../../llm/types.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.js";
import { createLazyPromise } from "../../../shared/lazy-runtime.js";
import type { EmbeddedContextFile } from "../../embedded-agent-helpers.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "../../embedded-agent-messaging.types.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { WorkspaceBootstrapFile } from "../../workspace.js";

type SubscribeEmbeddedAgentSessionFn =
  typeof import("../../embedded-agent-subscribe.js").subscribeEmbeddedAgentSession;
type AcquireSessionWriteLockFn =
  typeof import("../../session-write-lock.js").acquireSessionWriteLock;
type ShouldPreemptivelyCompactBeforePromptFn =
  typeof import("./preemptive-compaction.js").shouldPreemptivelyCompactBeforePrompt;

type SubscriptionMock = ReturnType<SubscribeEmbeddedAgentSessionFn>;
type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type AsyncContextEngineMaintenanceMock = Mock<
  (...args: unknown[]) => Promise<ContextEngineMaintenanceResult | undefined>
>;
type BootstrapContext = {
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
};
type CapturedTrajectoryEvent = {
  data?: Record<string, unknown>;
  type: string;
  workspaceDir?: string;
};

function normalizeMockProviderId(providerId?: string): string {
  // Provider ids in mocked model routing follow the same lowercase normalization
  // as production helpers.
  return normalizeLowercaseStringOrEmpty(providerId);
}

type SessionManagerMocks = {
  getLeafEntry: UnknownMock;
  getEntry: UnknownMock;
  branch: UnknownMock;
  resetLeaf: UnknownMock;
  buildSessionContext: Mock<() => { messages: AgentMessage[] }>;
  appendThinkingLevelChange: UnknownMock;
  appendModelChange: UnknownMock;
  appendCustomEntry: UnknownMock;
  appendSessionInfo: UnknownMock;
  appendLabelChange: UnknownMock;
  replacePersistedTranscript: UnknownMock;
  flushPendingToolResults: UnknownMock;
  clearPendingToolResults: UnknownMock;
  clearNextUserMessagePersistenceSuppression: UnknownMock;
  removeTrailingEntries: UnknownMock;
};
type AttemptSpawnWorkspaceHoisted = {
  spawnSubagentDirectMock: UnknownMock;
  createAgentSessionMock: UnknownMock;
  applyExtraParamsToAgentMock: UnknownMock;
  sessionManagerOpenMock: UnknownMock;
  defaultResourceLoaderInitMock: UnknownMock;
  resolveSandboxContextMock: UnknownMock;
  ensureGlobalUndiciEnvProxyDispatcherMock: UnknownMock;
  ensureGlobalUndiciDispatcherStreamTimeoutsMock: UnknownMock;
  ensureGlobalUndiciStreamTimeoutsMock: UnknownMock;
  buildEmbeddedMessageActionDiscoveryInputMock: UnknownMock;
  createOpenClawCodingToolsMock: UnknownMock;
  subscribeEmbeddedAgentSessionMock: Mock<SubscribeEmbeddedAgentSessionFn>;
  acquireSessionWriteLockMock: Mock<AcquireSessionWriteLockFn>;
  installToolResultContextGuardMock: UnknownMock;
  installContextEngineLoopHookMock: UnknownMock;
  flushPendingToolResultsAfterIdleMock: AsyncUnknownMock;
  resolveBootstrapFilesForRunMock: Mock<(...args: unknown[]) => Promise<WorkspaceBootstrapFile[]>>;
  resolveBootstrapContextForRunMock: Mock<() => Promise<BootstrapContext>>;
  isWorkspaceBootstrapPendingMock: Mock<(workspaceDir: string) => Promise<boolean>>;
  resolveContextInjectionModeMock: Mock<() => "always" | "continuation-skip">;
  hasCompletedBootstrapTurnMock: Mock<() => Promise<boolean>>;
  resolveEmbeddedRunSkillEntriesMock: UnknownMock;
  resolveSkillsPromptForRunMock: UnknownMock;
  supportsModelToolsMock: Mock<(model?: unknown) => boolean>;
  getGlobalHookRunnerMock: Mock<() => unknown>;
  initializeGlobalHookRunnerMock: UnknownMock;
  runContextEngineMaintenanceMock: AsyncContextEngineMaintenanceMock;
  prepareSessionManagerForRunMock: AsyncUnknownMock;
  detectAndLoadPromptImagesMock: AsyncUnknownMock;
  getHistoryLimitFromSessionKeyMock: Mock<
    (sessionKey: string | undefined, config: unknown) => number | undefined
  >;
  limitHistoryTurnsMock: Mock<<T>(messages: T, limit: number | undefined) => T>;
  preemptiveCompactionCalls: Parameters<ShouldPreemptivelyCompactBeforePromptFn>[0][];
  compactionReserveTokens: number;
  systemPromptTexts: string[];
  embeddedSystemPromptInputs: unknown[];
  trajectoryEvents: CapturedTrajectoryEvent[];
  sessionManager: SessionManagerMocks;
};

function createSubscriptionMock(): SubscriptionMock {
  // Minimal subscription surface for runEmbeddedAttempt tests; individual tests
  // override only the lifecycle method they need.
  return {
    assistantTexts: [] as string[],
    getLastAssistantTextMessageIndex: () => undefined,
    toolMetas: [] as Array<{ toolName: string; meta?: string; asyncStarted?: boolean }>,
    runToolLifecycle: async <T>(toolParams: { execute: () => Promise<T> }) =>
      await toolParams.execute(),
    unsubscribe: () => {},
    setTerminalLifecycleMeta: () => {},
    waitForCompactionRetry: async () => {},
    waitForPendingEvents: async () => {},
    getAcceptedSessionSpawns: () => [],
    getMessagingToolSentTexts: () => [] as string[],
    getMessagingToolSentMediaUrls: () => [] as string[],
    getMessagingToolSentTargets: () => [] as MessagingToolSend[],
    getMessagingToolSourceReplyPayloads: () => [] as MessagingToolSourceReplyPayload[],
    getHeartbeatToolResponse: () => undefined,
    getPendingToolMediaReply: () => null,
    hasToolMediaBlockReply: () => false,
    getVisibleBlockReplyCount: () => 0,
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
    getLastCompactionTokensAfter: () => undefined,
    getItemLifecycle: () => ({ startedCount: 0, completedCount: 0, activeCount: 0 }),
    isCompacting: () => false,
    isCompactionInFlight: () => false,
  };
}

const hoisted = vi.hoisted((): AttemptSpawnWorkspaceHoisted => {
  // Hoisted mocks must exist before the runner module graph is imported, because
  // runEmbeddedAttempt captures these dependencies at module load.
  const spawnSubagentDirectMock = vi.fn();
  const createAgentSessionMock = vi.fn();
  const applyExtraParamsToAgentMock = vi.fn();
  const sessionManagerOpenMock = vi.fn();
  const defaultResourceLoaderInitMock = vi.fn();
  const resolveSandboxContextMock = vi.fn();
  const ensureGlobalUndiciEnvProxyDispatcherMock = vi.fn();
  const ensureGlobalUndiciDispatcherStreamTimeoutsMock = vi.fn();
  const ensureGlobalUndiciStreamTimeoutsMock = vi.fn();
  const buildEmbeddedMessageActionDiscoveryInputMock = vi.fn((params: unknown) => params);
  const createOpenClawCodingToolsMock = vi.fn(() => []);
  const installToolResultContextGuardMock = vi.fn(() => () => {});
  const installContextEngineLoopHookMock = vi.fn(() => () => {});
  const flushPendingToolResultsAfterIdleMock = vi.fn(async () => {});
  const subscribeEmbeddedAgentSessionMock = vi.fn<SubscribeEmbeddedAgentSessionFn>(() =>
    createSubscriptionMock(),
  );
  const acquireSessionWriteLockMock = vi.fn<AcquireSessionWriteLockFn>(async (_params) => ({
    release: async () => {},
  }));
  const resolveBootstrapContextForRunMock = vi.fn<() => Promise<BootstrapContext>>(async () => ({
    bootstrapFiles: [],
    contextFiles: [],
  }));
  const resolveBootstrapFilesForRunMock = vi.fn<
    (...args: unknown[]) => Promise<WorkspaceBootstrapFile[]>
  >(async () => {
    const context = await resolveBootstrapContextForRunMock();
    return context.bootstrapFiles;
  });
  const isWorkspaceBootstrapPendingMock = vi.fn<(workspaceDir: string) => Promise<boolean>>(
    async () => false,
  );
  const resolveContextInjectionModeMock = vi.fn<() => "always" | "continuation-skip">(
    () => "always",
  );
  const hasCompletedBootstrapTurnMock = vi.fn<() => Promise<boolean>>(async () => false);
  const resolveEmbeddedRunSkillEntriesMock = vi.fn(() => ({
    shouldLoadSkillEntries: false,
    skillEntries: undefined,
  }));
  const resolveSkillsPromptForRunMock = vi.fn(() => "");
  const supportsModelToolsMock = vi.fn<(model?: unknown) => boolean>(() => true);
  const getGlobalHookRunnerMock = vi.fn<() => unknown>(() => undefined);
  const initializeGlobalHookRunnerMock = vi.fn();
  const runContextEngineMaintenanceMock = vi.fn(async (_params?: unknown) => undefined);
  const prepareSessionManagerForRunMock = vi.fn(async (_params?: unknown) => undefined);
  const detectAndLoadPromptImagesMock = vi.fn(async () => ({
    images: [],
    detectedRefs: [],
    loadedCount: 0,
    skippedCount: 0,
  }));
  const getHistoryLimitFromSessionKeyMock = vi.fn<
    (sessionKey: string | undefined, config: unknown) => number | undefined
  >(() => undefined);
  const limitHistoryTurnsMock = vi.fn<<T>(messages: T, limit: number | undefined) => T>(
    (messages) => messages,
  );
  const preemptiveCompactionCalls: Parameters<ShouldPreemptivelyCompactBeforePromptFn>[0][] = [];
  const compactionReserveTokens = 0;
  const systemPromptTexts: string[] = [];
  const embeddedSystemPromptInputs: unknown[] = [];
  const trajectoryEvents: CapturedTrajectoryEvent[] = [];
  const sessionManager = {
    getLeafEntry: vi.fn(() => null),
    getEntry: vi.fn(() => undefined),
    branch: vi.fn(),
    resetLeaf: vi.fn(),
    buildSessionContext: vi.fn<() => { messages: AgentMessage[] }>(() => ({ messages: [] })),
    appendThinkingLevelChange: vi.fn(),
    appendModelChange: vi.fn(),
    appendCustomEntry: vi.fn(),
    appendSessionInfo: vi.fn(),
    appendLabelChange: vi.fn(),
    replacePersistedTranscript: vi.fn(),
    flushPendingToolResults: vi.fn(),
    clearPendingToolResults: vi.fn(),
    clearNextUserMessagePersistenceSuppression: vi.fn(),
    removeTrailingEntries: vi.fn(() => 0),
  };
  return {
    spawnSubagentDirectMock,
    createAgentSessionMock,
    applyExtraParamsToAgentMock,
    sessionManagerOpenMock,
    defaultResourceLoaderInitMock,
    resolveSandboxContextMock,
    ensureGlobalUndiciEnvProxyDispatcherMock,
    ensureGlobalUndiciDispatcherStreamTimeoutsMock,
    ensureGlobalUndiciStreamTimeoutsMock,
    buildEmbeddedMessageActionDiscoveryInputMock,
    createOpenClawCodingToolsMock,
    subscribeEmbeddedAgentSessionMock,
    acquireSessionWriteLockMock,
    installToolResultContextGuardMock,
    installContextEngineLoopHookMock,
    flushPendingToolResultsAfterIdleMock,
    resolveBootstrapFilesForRunMock,
    resolveBootstrapContextForRunMock,
    isWorkspaceBootstrapPendingMock,
    resolveContextInjectionModeMock,
    hasCompletedBootstrapTurnMock,
    resolveEmbeddedRunSkillEntriesMock,
    resolveSkillsPromptForRunMock,
    supportsModelToolsMock,
    getGlobalHookRunnerMock,
    initializeGlobalHookRunnerMock,
    runContextEngineMaintenanceMock,
    prepareSessionManagerForRunMock,
    detectAndLoadPromptImagesMock,
    getHistoryLimitFromSessionKeyMock,
    limitHistoryTurnsMock,
    preemptiveCompactionCalls,
    compactionReserveTokens,
    systemPromptTexts,
    embeddedSystemPromptInputs,
    trajectoryEvents,
    sessionManager,
  };
});

export function getHoisted(): AttemptSpawnWorkspaceHoisted {
  return hoisted;
}

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

vi.mock("../../../plugins/plugin-metadata-snapshot.js", () => ({
  isPluginMetadataSnapshotCompatible: () => true,
  listPluginOriginsFromMetadataSnapshot: () => new Map(),
  loadPluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
}));

vi.mock("../../../plugins/provider-hook-runtime.js", () => ({
  ensureProviderRuntimePluginHandle: (params: Record<string, unknown>) =>
    params.runtimeHandle ?? params,
  prepareProviderExtraParams: () => undefined,
  resolveProviderExtraParamsForTransport: () => undefined,
  resolveProviderRuntimePluginHandle: (params: Record<string, unknown>) => params,
  wrapProviderStreamFn: () => undefined,
}));

vi.mock("../../../trajectory/metadata.js", () => ({
  buildTrajectoryArtifacts: (params: Record<string, unknown>) => params,
  buildTrajectoryRunMetadata: () => ({ source: "test" }),
}));

vi.mock("../../../trajectory/runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../../trajectory/runtime.js")>(
    "../../../trajectory/runtime.js",
  );
  return {
    ...actual,
    createTrajectoryRuntimeRecorder: (
      params: Parameters<typeof actual.createTrajectoryRuntimeRecorder>[0],
    ) => {
      const recorder = actual.createTrajectoryRuntimeRecorder(params);
      return {
        enabled: true as const,
        describeFlushState: () => recorder?.describeFlushState(),
        flush: async () => {
          await recorder?.flush();
        },
        recordEvent: (type: string, data?: Record<string, unknown>) => {
          hoisted.trajectoryEvents.push({
            type,
            ...(data ? { data } : {}),
            ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
          });
          recorder?.recordEvent(type, data);
        },
      };
    },
  };
});

vi.mock("../../sessions/index.js", () => {
  function AuthStorage() {}
  class DefaultResourceLoader {
    constructor(...args: unknown[]) {
      hoisted.defaultResourceLoaderInitMock(...args);
    }
    async reload() {}
  }
  function ModelRegistry() {}
  const estimateTokens = (value: unknown) =>
    Math.max(1, Math.ceil(JSON.stringify(value ?? "").length / 4));

  return {
    AuthStorage,
    createAgentSession: (...args: unknown[]) => hoisted.createAgentSessionMock(...args),
    DefaultResourceLoader,
    estimateTokens,
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
  guardSessionManager: (sessionManager: unknown) => sessionManager,
}));

vi.mock("../../embedded-agent-subscribe.js", () => ({
  subscribeEmbeddedAgentSession: (params: Parameters<SubscribeEmbeddedAgentSessionFn>[0]) =>
    hoisted.subscribeEmbeddedAgentSessionMock(params),
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: hoisted.getGlobalHookRunnerMock,
  initializeGlobalHookRunner: hoisted.initializeGlobalHookRunnerMock,
}));

vi.mock("../../../plugins/provider-runtime.js", () => ({
  resolveProviderReasoningOutputModeWithPlugin: () => undefined,
  resolveProviderSystemPromptContribution: () => undefined,
  resolveProviderTextTransforms: () => undefined,
  transformProviderSystemPrompt: ({ context }: { context: { systemPrompt?: string } }) =>
    context.systemPrompt,
}));

vi.mock("../../../infra/machine-name.js", () => ({
  getMachineDisplayName: async () => "test-host",
}));

vi.mock("../../../infra/net/undici-global-dispatcher.js", () => ({
  DEFAULT_UNDICI_STREAM_TIMEOUT_MS: 120_000,
  ensureGlobalUndiciEnvProxyDispatcher: (...args: unknown[]) =>
    hoisted.ensureGlobalUndiciEnvProxyDispatcherMock(...args),
  ensureGlobalUndiciDispatcherStreamTimeouts: (...args: unknown[]) =>
    hoisted.ensureGlobalUndiciDispatcherStreamTimeoutsMock(...args),
  ensureGlobalUndiciStreamTimeouts: (...args: unknown[]) =>
    hoisted.ensureGlobalUndiciStreamTimeoutsMock(...args),
}));

vi.mock("../../../tts/tts.js", () => ({
  buildTtsSystemPromptHint: () => undefined,
}));

vi.mock("../../bootstrap-files.js", async () => {
  const actual = await vi.importActual<typeof import("../../bootstrap-files.js")>(
    "../../bootstrap-files.js",
  );
  return {
    ...actual,
    makeBootstrapWarn: () => () => {},
    isWorkspaceBootstrapPending: hoisted.isWorkspaceBootstrapPendingMock,
    resolveBootstrapFilesForRun: hoisted.resolveBootstrapFilesForRunMock,
    resolveBootstrapContextForRun: hoisted.resolveBootstrapContextForRunMock,
    resolveContextInjectionMode: hoisted.resolveContextInjectionModeMock,
    hasCompletedBootstrapTurn: hoisted.hasCompletedBootstrapTurnMock,
  };
});

vi.mock("../../workspace.js", async () => {
  const actual = await vi.importActual<typeof import("../../workspace.js")>("../../workspace.js");
  return {
    ...actual,
    isWorkspaceBootstrapPending: hoisted.isWorkspaceBootstrapPendingMock,
  };
});

vi.mock("../../../skills/runtime/env-overrides.js", () => ({
  applySkillEnvOverrides: () => () => {},
  applySkillEnvOverridesFromSnapshot: () => () => {},
}));

vi.mock("../../../skills/loading/workspace.js", () => ({
  resolveSkillsPromptForRun: (...args: unknown[]) => hoisted.resolveSkillsPromptForRunMock(...args),
}));

vi.mock("../../../skills/runtime/embedded-run-entries.js", () => ({
  resolveEmbeddedRunSkillEntries: (...args: unknown[]) =>
    hoisted.resolveEmbeddedRunSkillEntriesMock(...args),
}));

vi.mock("../context-engine-maintenance.js", () => ({
  runContextEngineMaintenance: (params: unknown) => hoisted.runContextEngineMaintenanceMock(params),
}));

vi.mock("../../docs-path.js", () => ({
  resolveOpenClawReferencePaths: async () => ({ docsPath: undefined, sourcePath: undefined }),
}));

vi.mock("../../agent-project-settings.js", () => ({
  createPreparedEmbeddedAgentSettingsManager: () => ({
    reload: async () => {},
    getCompactionReserveTokens: () => hoisted.compactionReserveTokens,
    getCompactionKeepRecentTokens: () => 40_000,
    getDefaultProvider: () => undefined,
    getDefaultModel: () => undefined,
    getDefaultThinkingLevel: () => undefined,
    getBlockImages: () => false,
    getSteeringMode: () => undefined,
    getFollowUpMode: () => undefined,
    getTransport: () => undefined,
    getThinkingBudgets: () => undefined,
    getProviderRetrySettings: () => ({ maxRetryDelayMs: undefined }),
    getImageAutoResize: () => false,
    getShellCommandPrefix: () => undefined,
    getShellPath: () => undefined,
    getGlobalSettings: () => ({}),
    getProjectSettings: () => ({}),
    applyOverrides: () => {},
    setCompactionEnabled: () => {},
  }),
}));

vi.mock("../../agent-settings.js", () => ({
  applyAgentAutoCompactionGuard: () => {},
  applyAgentCompactionSettingsFromConfig: () => ({
    didOverride: false,
    compaction: {
      reserveTokens: 0,
      keepRecentTokens: 40_000,
    },
  }),
  isSilentOverflowProneModel: () => false,
  resolveEffectiveCompactionMode: () => "default",
}));

vi.mock("../extensions.js", () => ({
  buildEmbeddedExtensionFactories: () => [],
}));

vi.mock("../replay-history.js", () => ({
  normalizeAssistantReplayContent: <T>(messages: T) => messages,
  sanitizeSessionHistory: async ({ messages }: { messages: unknown[] }) => messages,
  validateReplayTurns: async ({ messages }: { messages: unknown[] }) => messages,
}));

vi.mock("../tool-schema-runtime.js", () => ({
  logProviderToolSchemaDiagnostics: () => {},
  normalizeProviderToolSchemas: ({ tools }: { tools: unknown[] }) => tools,
}));

vi.mock("../../session-file-repair.js", () => ({
  repairSessionFileIfNeeded: async () => ({ repaired: false, droppedLines: 0 }),
}));

vi.mock("../session-manager-cache.js", () => ({
  prewarmSessionFile: async () => {},
  trackSessionManagerAccess: () => {},
}));

vi.mock("../session-manager-init.js", () => ({
  prepareSessionManagerForRun: (params: unknown) => hoisted.prepareSessionManagerForRunMock(params),
}));

vi.mock("../../session-write-lock.js", () => ({
  acquireSessionWriteLock: (params: Parameters<AcquireSessionWriteLockFn>[0]) =>
    hoisted.acquireSessionWriteLockMock(params),
  resolveSessionWriteLockAcquireTimeoutMs: () => 60000,
  resolveSessionWriteLockOptions: () => ({ timeoutMs: 60000, staleMs: 1_800_000, maxHoldMs: 1 }),
  resolveSessionLockMaxHoldFromTimeout: () => 1,
}));

vi.mock("../tool-result-context-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../tool-result-context-guard.js")>(
    "../tool-result-context-guard.js",
  );
  return {
    ...actual,
    formatContextLimitTruncationNotice: (truncatedChars: number) =>
      `[... ${Math.max(
        1,
        Math.floor(truncatedChars),
      )} more characters truncated; rerun with narrower args if needed]`,
    installToolResultContextGuard: (...args: unknown[]) =>
      (hoisted.installToolResultContextGuardMock as (...args: unknown[]) => unknown)(...args),
    installContextEngineLoopHook: (...args: unknown[]) =>
      (hoisted.installContextEngineLoopHookMock as (...args: unknown[]) => unknown)(...args),
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
  detectAndLoadPromptImages: (...args: unknown[]) =>
    (hoisted.detectAndLoadPromptImagesMock as (...args: unknown[]) => unknown)(...args),
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

vi.mock("../system-prompt.js", async () => {
  const actual = await vi.importActual<typeof import("../system-prompt.js")>("../system-prompt.js");
  return {
    ...actual,
    applySystemPromptToSession: (session: MutableSession, systemPrompt: string) => {
      hoisted.systemPromptTexts.push(systemPrompt);
      session.setBaseSystemPrompt(systemPrompt);
    },
    buildEmbeddedSystemPrompt: (params: unknown) => {
      hoisted.embeddedSystemPromptInputs.push(params);
      return "system prompt";
    },
  };
});

vi.mock("../extra-params.js", async () => {
  const actual = await vi.importActual<typeof import("../extra-params.js")>("../extra-params.js");
  return {
    ...actual,
    applyExtraParamsToAgent: (...args: unknown[]) => {
      hoisted.applyExtraParamsToAgentMock(...args);
      return { effectiveExtraParams: {} };
    },
    resolvePreparedExtraParams: (params: {
      cfg?: unknown;
      provider: string;
      modelId: string;
      agentId?: string;
      extraParamsOverride?: Record<string, unknown>;
      resolvedExtraParams?: Record<string, unknown>;
    }) => ({
      ...(params.resolvedExtraParams ??
        actual.resolveExtraParams({
          cfg: params.cfg as Parameters<typeof actual.resolveExtraParams>[0]["cfg"],
          provider: params.provider,
          modelId: params.modelId,
          agentId: params.agentId,
        })),
      ...(params.extraParamsOverride
        ? Object.fromEntries(
            Object.entries(params.extraParamsOverride).filter(([, value]) => value !== undefined),
          )
        : undefined),
    }),
    resolveAgentTransportOverride: () => undefined,
  };
});

vi.mock("../../anthropic-payload-log.js", () => ({
  createAnthropicPayloadLogger: () => undefined,
}));

vi.mock("../../cache-trace.js", () => ({
  createCacheTrace: () => undefined,
}));

vi.mock("../../agent-tools.js", () => ({
  createOpenClawCodingTools: (options?: { workspaceDir?: string; spawnWorkspaceDir?: string }) =>
    hoisted.createOpenClawCodingToolsMock(options),
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
  resolveToolLoopDetectionConfig: () => undefined,
}));

vi.mock("../../agent-bundle-mcp-tools.js", () => ({
  createBundleMcpToolRuntime: async () => undefined,
  getOrCreateSessionMcpRuntime: async () => undefined,
  materializeBundleMcpToolsForRun: async () => undefined,
  retireSessionMcpRuntime: async () => true,
}));

vi.mock("../../agent-bundle-lsp-runtime.js", () => ({
  createBundleLspToolRuntime: async () => undefined,
}));

vi.mock("../../../image-generation/runtime.js", () => ({
  generateImage: vi.fn(),
  listRuntimeImageGenerationProviders: () => [],
}));

vi.mock("../../model-selection.js", () => ({
  findNormalizedProviderValue: <T>(entries: Record<string, T> | undefined, provider: string) => {
    if (!entries) {
      return undefined;
    }
    const providerKey = normalizeMockProviderId(provider);
    for (const [key, value] of Object.entries(entries)) {
      if (normalizeMockProviderId(key) === providerKey) {
        return value;
      }
    }
    return undefined;
  },
  normalizeProviderId: normalizeMockProviderId,
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
  supportsModelTools: (...args: unknown[]) => hoisted.supportsModelToolsMock(...args),
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

vi.mock("../../tool-call-id.js", async (importOriginal) => {
  return await importOriginal<typeof import("../../tool-call-id.js")>();
});

vi.mock("../../tool-fs-policy.js", () => ({
  createToolFsPolicy: (params: { workspaceOnly?: boolean }) => ({
    workspaceOnly: params.workspaceOnly === true,
  }),
  resolveEffectiveToolFsWorkspaceOnly: () => false,
}));

vi.mock("../../tool-policy.js", async (importOriginal) => {
  return await importOriginal<typeof import("../../tool-policy.js")>();
});

vi.mock("../../transcript-policy.js", () => ({
  resolveTranscriptPolicy: () => ({
    allowSyntheticToolResults: false,
    repairToolUseResultPairing: true,
  }),
  shouldAllowProviderOwnedThinkingReplay: () => false,
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

vi.mock("./preemptive-compaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./preemptive-compaction.js")>();
  return {
    ...actual,
    shouldPreemptivelyCompactBeforePrompt: (
      params: Parameters<typeof actual.shouldPreemptivelyCompactBeforePrompt>[0],
    ) => {
      hoisted.preemptiveCompactionCalls.push(params);
      return actual.shouldPreemptivelyCompactBeforePrompt(params);
    },
  };
});

vi.mock("../compaction-safety-timeout.js", () => ({
  resolveCompactionTimeoutMs: () => undefined,
}));

vi.mock("../history.js", () => ({
  getHistoryLimitFromSessionKey: (sessionKey: string | undefined, config: unknown) =>
    hoisted.getHistoryLimitFromSessionKeyMock(sessionKey, config),
  limitHistoryTurns: (messages: unknown, limit: number | undefined) =>
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
  resolveEmbeddedSandboxInfoExecPolicy: () => ({}),
}));

vi.mock("../thinking.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../thinking.js")>();
  return {
    ...actual,
    dropReasoningFromHistory: <T>(messages: T) => messages,
    dropThinkingBlocks: <T>(messages: T) => messages,
  };
});

vi.mock("../tool-name-allowlist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tool-name-allowlist.js")>();
  return {
    ...actual,
  };
});

vi.mock("../tool-split.js", () => ({
  splitSdkTools: ({ tools }: { tools: unknown[] }) => ({
    customTools: tools,
  }),
}));

vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
  return {
    ...actual,
    describeUnknownError: (error: unknown) => formatErrorMessage(error),
  };
});

vi.mock("./compaction-retry-aggregate-timeout.js", () => ({
  hasActiveCompactionRetryWork: ({
    isCompactionInFlight,
    isSessionStreaming,
  }: {
    isCompactionInFlight: boolean;
    isSessionStreaming: boolean;
  }) => isCompactionInFlight || isSessionStreaming,
  waitForCompactionRetryWithAggregateTimeout: async () => ({
    timedOut: false,
    aborted: false,
  }),
}));

vi.mock("./compaction-timeout.js", () => ({
  resolveRunTimeoutDuringCompaction: () => "abort",
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
  installHistoryImagePruneContextTransform: () => () => {},
  pruneProcessedHistoryImages: () => null,
}));

type MutableSession = {
  sessionId: string;
  messages: unknown[];
  isCompacting: boolean;
  isStreaming: boolean;
  agent: {
    convertToLlm?: (messages: AgentMessage[]) => AgentMessage[] | Promise<AgentMessage[]>;
    prompt?: (...args: unknown[]) => Promise<unknown>;
    streamFn?: (...args: unknown[]) => Promise<unknown>;
    transport?: string;
    reset: () => void;
    state: {
      messages: unknown[];
      systemPrompt?: string;
    };
  };
  prompt: (
    prompt: string,
    options?: { images?: unknown[]; preflightResult?: (submitted: boolean) => void },
  ) => Promise<void>;
  setBaseSystemPrompt: (systemPrompt: string) => void;
  sendCustomMessage: (
    message: {
      customType: string;
      content: string;
      display: boolean;
      details?: Record<string, unknown>;
    },
    options?: { deliverAs?: "nextTurn"; triggerTurn?: boolean },
  ) => Promise<void>;
  setActiveToolsByName: (toolNames: string[]) => void;
  abort: () => Promise<void>;
  dispose: () => void;
  steer: (text: string) => Promise<void>;
};

type SessionPromptOverride = (
  session: MutableSession,
  prompt: string,
  options?: { images?: unknown[]; preflightResult?: (submitted: boolean) => void },
) => Promise<void>;

type TestAgentStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

function createCompletedAssistantStream(): TestAgentStream {
  return {
    async result() {
      return { role: "assistant", content: "done" };
    },
    [Symbol.asyncIterator]() {
      return (async function* () {})();
    },
  };
}
const ATTEMPT_SPAWN_WORKSPACE_TEST_SPECIFIER = "./attempt.ts?spawn-workspace-test";

const loadRunEmbeddedAttempt = createLazyPromise(
  () =>
    (import(ATTEMPT_SPAWN_WORKSPACE_TEST_SPECIFIER) as Promise<typeof import("./attempt.js")>).then(
      (mod) => mod.runEmbeddedAttempt,
    ),
  { cacheRejections: true },
);

export async function preloadRunEmbeddedAttemptForTests(): Promise<void> {
  await loadRunEmbeddedAttempt();
}

export function resetEmbeddedAttemptHarness(
  params: {
    includeSpawnSubagent?: boolean;
    subscribeImpl?: Parameters<
      (typeof hoisted.subscribeEmbeddedAgentSessionMock)["mockImplementation"]
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
  hoisted.applyExtraParamsToAgentMock.mockReset();
  hoisted.sessionManagerOpenMock.mockReset().mockReturnValue(hoisted.sessionManager);
  hoisted.defaultResourceLoaderInitMock.mockReset();
  hoisted.resolveSandboxContextMock.mockReset();
  hoisted.ensureGlobalUndiciEnvProxyDispatcherMock.mockReset();
  hoisted.ensureGlobalUndiciDispatcherStreamTimeoutsMock.mockReset();
  hoisted.ensureGlobalUndiciStreamTimeoutsMock.mockReset();
  hoisted.buildEmbeddedMessageActionDiscoveryInputMock
    .mockReset()
    .mockImplementation((paramsLocal) => paramsLocal);
  hoisted.createOpenClawCodingToolsMock.mockReset().mockImplementation((...args: unknown[]) => {
    const options = args[0] as
      | {
          workspaceDir?: string;
          spawnWorkspaceDir?: string;
        }
      | undefined;
    return [
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
    ];
  });
  hoisted.subscribeEmbeddedAgentSessionMock
    .mockReset()
    .mockImplementation(() => createSubscriptionMock());
  hoisted.acquireSessionWriteLockMock.mockReset().mockResolvedValue({
    release: async () => {},
  });
  hoisted.installToolResultContextGuardMock.mockReset().mockReturnValue(() => {});
  hoisted.installContextEngineLoopHookMock.mockReset().mockReturnValue(() => {});
  hoisted.flushPendingToolResultsAfterIdleMock.mockReset().mockResolvedValue(undefined);
  hoisted.resolveBootstrapContextForRunMock.mockReset().mockResolvedValue({
    bootstrapFiles: [],
    contextFiles: [],
  });
  hoisted.resolveBootstrapFilesForRunMock.mockReset().mockImplementation(async () => {
    const context = await hoisted.resolveBootstrapContextForRunMock();
    return context.bootstrapFiles;
  });
  hoisted.isWorkspaceBootstrapPendingMock.mockReset().mockResolvedValue(false);
  hoisted.resolveContextInjectionModeMock.mockReset().mockReturnValue("always");
  hoisted.hasCompletedBootstrapTurnMock.mockReset().mockResolvedValue(false);
  hoisted.resolveEmbeddedRunSkillEntriesMock.mockReset().mockReturnValue({
    shouldLoadSkillEntries: false,
    skillEntries: undefined,
  });
  hoisted.resolveSkillsPromptForRunMock.mockReset().mockReturnValue("");
  hoisted.supportsModelToolsMock.mockReset().mockReturnValue(true);
  hoisted.getGlobalHookRunnerMock.mockReset().mockReturnValue(undefined);
  hoisted.runContextEngineMaintenanceMock.mockReset().mockResolvedValue(undefined);
  hoisted.prepareSessionManagerForRunMock.mockReset().mockResolvedValue(undefined);
  hoisted.getHistoryLimitFromSessionKeyMock.mockReset().mockReturnValue(undefined);
  hoisted.limitHistoryTurnsMock.mockReset().mockImplementation((messages) => messages);
  hoisted.preemptiveCompactionCalls.length = 0;
  hoisted.compactionReserveTokens = 0;
  hoisted.systemPromptTexts.length = 0;
  hoisted.embeddedSystemPromptInputs.length = 0;
  hoisted.trajectoryEvents.length = 0;
  hoisted.sessionManager.getLeafEntry.mockReset().mockReturnValue(null);
  hoisted.sessionManager.getEntry.mockReset().mockReturnValue(undefined);
  hoisted.sessionManager.branch.mockReset();
  hoisted.sessionManager.resetLeaf.mockReset();
  hoisted.sessionManager.clearNextUserMessagePersistenceSuppression.mockReset();
  hoisted.sessionManager.buildSessionContext
    .mockReset()
    .mockReturnValue({ messages: params.sessionMessages ?? [] });
  hoisted.sessionManager.appendThinkingLevelChange.mockReset();
  hoisted.sessionManager.appendModelChange.mockReset();
  hoisted.sessionManager.appendCustomEntry.mockReset();
  hoisted.sessionManager.appendSessionInfo.mockReset();
  hoisted.sessionManager.appendLabelChange.mockReset();
  hoisted.sessionManager.replacePersistedTranscript.mockReset();
  if (params.subscribeImpl) {
    hoisted.subscribeEmbeddedAgentSessionMock.mockImplementation(params.subscribeImpl);
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
    options?: { images?: unknown[]; preflightResult?: (submitted: boolean) => void },
  ) => Promise<void>;
}): MutableSession {
  let pendingPrompt:
    | {
        prompt: string;
        options?: { images?: unknown[]; preflightResult?: (submitted: boolean) => void };
      }
    | undefined;
  const session: MutableSession = {
    sessionId: "embedded-session",
    messages: [...(params?.initialMessages ?? [])],
    isCompacting: false,
    isStreaming: false,
    agent: {
      prompt: async (prompt, options) => {
        pendingPrompt = {
          prompt: String(prompt),
          options: options as {
            images?: unknown[];
            preflightResult?: (submitted: boolean) => void;
          },
        };
        await session.agent.streamFn?.();
      },
      streamFn: async () => {
        if (params?.prompt && pendingPrompt) {
          const currentPrompt = pendingPrompt;
          pendingPrompt = undefined;
          currentPrompt.options?.preflightResult?.(true);
          await params.prompt(session, currentPrompt.prompt, currentPrompt.options);
        }
        return createCompletedAssistantStream();
      },
      reset: () => {
        session.messages = [];
      },
      state: {
        get messages() {
          return session.messages;
        },
        set messages(messages: unknown[]) {
          session.messages = [...messages];
        },
      },
    },
    setActiveToolsByName: () => {},
    setBaseSystemPrompt: (systemPrompt) => {
      session.agent.state.systemPrompt = systemPrompt;
    },
    prompt: async (prompt, options) => {
      await session.agent.prompt?.(prompt, options);
      if (params?.prompt) {
        return;
      }
      session.messages = [
        ...session.messages,
        { role: "assistant", content: "done", timestamp: 2 },
      ];
    },
    sendCustomMessage: async (message, options) => {
      if (options?.deliverAs === "nextTurn") {
        session.messages = [...session.messages, { role: "custom", timestamp: 1, ...message }];
        return;
      }
      if (options?.triggerTurn) {
        session.messages = [
          ...session.messages,
          { role: "custom", timestamp: 1, ...message },
          { role: "assistant", content: "done", timestamp: 2 },
        ];
        return;
      }
      session.messages = [...session.messages, { role: "custom", timestamp: 1, ...message }];
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
  expect(mock).toHaveBeenCalledWith(expect.objectContaining({ sessionKey }));
}

const testModel = {
  api: "openai-completions",
  provider: "openai",
  compat: {},
  contextWindow: 8192,
  input: ["text"],
} as unknown as Model;

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
      sessionKey: string;
      agentId?: string;
      sessionTarget?: ContextEngineSessionTarget;
      tokenBudget?: number;
    }) => Promise<CompactResult>;
    info?: Partial<ContextEngineInfo>;
  };
  attemptOverrides?: Partial<Parameters<Awaited<ReturnType<typeof loadRunEmbeddedAttempt>>>[0]>;
  createSession?: () => MutableSession;
  sessionMessages?: AgentMessage[];
  sessionMessagesAfterRepair?: AgentMessage[];
  sessionPrompt?: SessionPromptOverride;
  sessionKey: string;
  tempPaths: string[];
  trajectory?: boolean;
}) {
  const { maintain: rawMaintain, ...contextEngineRest } = params.contextEngine;
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ctx-engine-workspace-"));
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ctx-engine-agent-"));
  const sessionFile = path.join(workspaceDir, "session.jsonl");
  const sessionStore = path.join(workspaceDir, "sessions.json");
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
    .mockReturnValue({ messages: params.sessionMessagesAfterRepair ?? seedMessages });

  hoisted.createAgentSessionMock.mockImplementation(async () => ({
    session:
      params.createSession?.() ??
      createDefaultEmbeddedSession({
        initialMessages: seedMessages,
        prompt: params.sessionPrompt,
      }),
  }));

  const previousTrajectoryEnv = process.env.OPENCLAW_TRAJECTORY;
  const previousTrajectoryDirEnv = process.env.OPENCLAW_TRAJECTORY_DIR;
  if (params.trajectory !== true) {
    process.env.OPENCLAW_TRAJECTORY = "0";
    delete process.env.OPENCLAW_TRAJECTORY_DIR;
  } else {
    delete process.env.OPENCLAW_TRAJECTORY;
    process.env.OPENCLAW_TRAJECTORY_DIR = workspaceDir;
  }
  try {
    return await (
      await loadRunEmbeddedAttempt()
    )({
      sessionId: "embedded-session",
      sessionKey: params.sessionKey,
      sessionFile,
      workspaceDir,
      agentDir,
      config: { session: { store: sessionStore } },
      prompt: "hello",
      timeoutMs: 10_000,
      runId: "run-context-engine-forwarding",
      provider: "openai",
      modelId: "gpt-test",
      model: testModel,
      authStorage: testAuthStorage as never,
      authProfileStore: { version: 1, profiles: {} },
      modelRegistry: {} as never,
      thinkLevel: "off",
      disableTools: true,
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
          ...params.contextEngine.info,
          id: infoId,
          name: infoName,
          version: infoVersion,
        },
      },
      ...params.attemptOverrides,
    });
  } finally {
    if (previousTrajectoryEnv === undefined) {
      delete process.env.OPENCLAW_TRAJECTORY;
    } else {
      process.env.OPENCLAW_TRAJECTORY = previousTrajectoryEnv;
    }
    if (previousTrajectoryDirEnv === undefined) {
      delete process.env.OPENCLAW_TRAJECTORY_DIR;
    } else {
      process.env.OPENCLAW_TRAJECTORY_DIR = previousTrajectoryDirEnv;
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

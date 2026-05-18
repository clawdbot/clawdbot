import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { INTERNAL_RUNTIME_CONTEXT_BEGIN, INTERNAL_RUNTIME_CONTEXT_END } from "./internal-events.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";

const state = vi.hoisted(() => ({
  defaultRuntimeConfig: {
    agents: {
      defaults: {
        models: {
          "anthropic/claude": {},
          "openai/claude": {},
          "openai/gpt-5.4": {},
        },
      },
    },
  },
  runtimeConfigMock: undefined as unknown,
  acpResolveSessionMock: vi.fn((..._args: unknown[]): unknown => null),
  acpRunTurnMock: vi.fn((..._args: unknown[]): unknown => undefined),
  buildAcpResultMock: vi.fn(),
  createAcpVisibleTextAccumulatorMock: vi.fn(),
  persistAcpTurnTranscriptMock: vi.fn(),
  resolveAcpAgentPolicyErrorMock: vi.fn(),
  resolveAcpDispatchPolicyErrorMock: vi.fn(),
  resolveAcpExplicitTurnPolicyErrorMock: vi.fn(),
  runWithModelFallbackMock: vi.fn(),
  runAgentAttemptMock: vi.fn(),
  resolveEffectiveModelFallbacksMock: vi.fn().mockReturnValue(undefined),
  emitAgentEventMock: vi.fn(),
  registerAgentRunContextMock: vi.fn(),
  clearAgentRunContextMock: vi.fn(),
  updateSessionStoreAfterAgentRunMock: vi.fn(),
  deliverAgentCommandResultMock: vi.fn(),
  trajectoryRecordEventMock: vi.fn(),
  trajectoryFlushMock: vi.fn(async () => undefined),
  persistSessionEntryMock: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  clearSessionAuthProfileOverrideMock: vi.fn(),
  isThinkingLevelSupportedMock: vi.fn((_args: unknown) => true),
  resolveThinkingDefaultMock: vi.fn((_args: unknown) => "low"),
  loadManifestModelCatalogMock: vi.fn(() => []),
  buildWorkspaceSkillSnapshotMock: vi.fn((..._args: unknown[]): unknown => ({
    prompt: "",
    skills: [],
    resolvedSkills: [],
    version: 0,
  })),
  authProfileStoreMock: { profiles: {} } as { profiles: Record<string, unknown> },
  sessionEntryMock: undefined as unknown,
  sessionStoreMock: undefined as unknown,
  storePathMock: undefined as string | undefined,
}));

vi.mock("./model-fallback.js", () => ({
  runWithModelFallback: (params: unknown) => state.runWithModelFallbackMock(params),
}));

vi.mock("./command/attempt-execution.runtime.js", () => ({
  buildAcpResult: (...args: unknown[]) => state.buildAcpResultMock(...args),
  createAcpVisibleTextAccumulator: () => state.createAcpVisibleTextAccumulatorMock(),
  emitAcpAssistantDelta: vi.fn(),
  emitAcpLifecycleEnd: vi.fn(),
  emitAcpLifecycleError: vi.fn(),
  emitAcpLifecycleStart: vi.fn(),
  emitAcpRuntimeEvent: vi.fn(),
  persistAcpTurnTranscript: (...args: unknown[]) => state.persistAcpTurnTranscriptMock(...args),
  persistSessionEntry: vi.fn(),
  prependInternalEventContext: (_body: string) => _body,
  runAgentAttempt: (...args: unknown[]) => state.runAgentAttemptMock(...args),
  sessionFileHasContent: vi.fn(async () => false),
}));

vi.mock("./command/attempt-execution.shared.js", async () => {
  const actual = await vi.importActual<typeof import("./command/attempt-execution.shared.js")>(
    "./command/attempt-execution.shared.js",
  );
  return {
    ...actual,
    persistSessionEntry: (...args: unknown[]) => state.persistSessionEntryMock(...args),
  };
});

vi.mock("./command/delivery.runtime.js", () => ({
  deliverAgentCommandResult: (...args: unknown[]) => state.deliverAgentCommandResultMock(...args),
}));

vi.mock("./command/run-context.js", () => ({
  resolveAgentRunContext: () => ({
    messageChannel: "test",
    accountId: "acct",
    groupId: undefined,
    groupChannel: undefined,
    groupSpace: undefined,
    currentChannelId: undefined,
    currentThreadTs: undefined,
    replyToMode: undefined,
    hasRepliedRef: { current: false },
  }),
}));

vi.mock("./command/session-store.runtime.js", () => ({
  updateSessionStoreAfterAgentRun: (...args: unknown[]) =>
    state.updateSessionStoreAfterAgentRunMock(...args),
}));

vi.mock("./command/session.js", () => ({
  resolveSession: () => ({
    sessionId: "session-1",
    sessionKey: "agent:main",
    sessionEntry: state.sessionEntryMock ?? {
      sessionId: "session-1",
      updatedAt: Date.now(),
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    },
    sessionStore: state.sessionStoreMock,
    storePath: state.storePathMock,
    isNewSession: false,
    persistedThinking: undefined,
    persistedVerbose: undefined,
  }),
}));

vi.mock("./command/types.js", () => ({}));

vi.mock("./harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));

vi.mock("../acp/policy.js", () => ({
  resolveAcpAgentPolicyError: (...args: unknown[]) => state.resolveAcpAgentPolicyErrorMock(...args),
  resolveAcpDispatchPolicyError: (...args: unknown[]) =>
    state.resolveAcpDispatchPolicyErrorMock(...args),
  resolveAcpExplicitTurnPolicyError: (...args: unknown[]) =>
    state.resolveAcpExplicitTurnPolicyErrorMock(...args),
}));

vi.mock("../acp/runtime/errors.js", () => ({
  toAcpRuntimeError: ({ error }: { error: unknown }) =>
    error instanceof Error ? error : new Error(String(error)),
}));

vi.mock("../acp/runtime/session-identifiers.js", () => ({
  resolveAcpSessionCwd: () => "/tmp",
}));

vi.mock("../auto-reply/thinking.js", () => ({
  formatThinkingLevels: () => "low, medium, high",
  formatXHighModelHint: () => "model-x",
  normalizeThinkLevel: (v?: string) => v || undefined,
  normalizeVerboseLevel: (v?: string) => v || undefined,
  isThinkingLevelSupported: (args: unknown) => state.isThinkingLevelSupportedMock(args),
  resolveSupportedThinkingLevel: ({ level }: { level?: string }) => level,
  supportsXHighThinking: () => false,
}));

vi.mock("../cli/command-format.js", () => ({
  formatCliCommand: (cmd: string) => cmd,
}));

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: async (params: { config: unknown }) => ({
    resolvedConfig: params.config,
    diagnostics: [],
  }),
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getAgentRuntimeCommandSecretTargetIds: () => [],
}));

vi.mock("../cli/deps.js", () => ({
  createDefaultDeps: () => ({}),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => state.runtimeConfigMock ?? state.defaultRuntimeConfig,
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: { valid: false },
  }),
}));

vi.mock("./agent-runtime-config.js", () => {
  return {
    resolveAgentRuntimeConfig: async () => ({
      loadedRaw: state.runtimeConfigMock ?? state.defaultRuntimeConfig,
      sourceConfig: state.runtimeConfigMock ?? state.defaultRuntimeConfig,
      cfg: state.runtimeConfigMock ?? state.defaultRuntimeConfig,
    }),
  };
});

vi.mock("../config/runtime-snapshot.js", () => ({
  setRuntimeConfigSnapshot: vi.fn(),
}));

vi.mock("../config/sessions.js", () => ({
  resolveAgentIdFromSessionKey: () => "default",
  mergeSessionEntry: (a: unknown, b: unknown) => ({ ...(a as object), ...(b as object) }),
  updateSessionStore: vi.fn(
    async (_path: string, fn: (store: Record<string, unknown>) => unknown) => {
      const store: Record<string, unknown> = {};
      return fn(store);
    },
  ),
}));

vi.mock("../config/sessions/transcript-resolve.runtime.js", () => ({
  resolveSessionTranscriptFile: async () => ({
    sessionFile: "/tmp/session.jsonl",
    sessionEntry: { sessionId: "session-1", updatedAt: Date.now() },
  }),
}));

vi.mock("../infra/agent-events.js", () => ({
  clearAgentRunContext: (...args: unknown[]) => state.clearAgentRunContextMock(...args),
  emitAgentEvent: (...args: unknown[]) => state.emitAgentEventMock(...args),
  onAgentEvent: vi.fn(),
  registerAgentRunContext: (...args: unknown[]) => state.registerAgentRunContextMock(...args),
}));

vi.mock("../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: () => ({}),
}));

vi.mock("../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: () => ({ eligible: false }),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      raw: vi.fn(),
      child: vi.fn(() => logger),
    };
    return logger;
  },
}));

vi.mock("../routing/session-key.js", () => ({
  normalizeAgentId: (id: string) => id,
  normalizeMainKey: (key?: string | null) => key?.trim() || "main",
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
    log: vi.fn(),
  },
}));

vi.mock("../sessions/level-overrides.js", () => ({
  applyVerboseOverride: vi.fn(),
}));

vi.mock("../sessions/model-overrides.js", () => ({
  applyModelOverrideToSessionEntry: () => ({ updated: false }),
  repairProviderWrappedModelOverride: () => ({ updated: false }),
}));

vi.mock("../sessions/send-policy.js", () => ({
  resolveSendPolicy: () => "allow",
}));

vi.mock("../terminal/ansi.js", () => ({
  sanitizeForLog: (s: string) => s,
}));

vi.mock("../trajectory/runtime.js", () => ({
  createTrajectoryRuntimeRecorder: () => ({
    enabled: true,
    filePath: "/tmp/session.trajectory.jsonl",
    recordEvent: (...args: unknown[]) => state.trajectoryRecordEventMock(...args),
    flush: () => state.trajectoryFlushMock(),
  }),
}));

vi.mock("../utils/message-channel.js", () => ({
  resolveMessageChannel: () => "test",
}));

vi.mock("./agent-scope.js", () => ({
  clearAutoFallbackPrimaryProbeSelection: vi.fn(),
  entryMatchesAutoFallbackPrimaryProbe: () => true,
  hasSessionAutoModelFallbackProvenance: () => false,
  listAgentEntries: () => [],
  listAgentIds: () => ["default"],
  markAutoFallbackPrimaryProbe: vi.fn(),
  resolveAutoFallbackPrimaryProbe: () => undefined,
  resolveAgentConfig: () => undefined,
  resolveAgentDir: () => "/tmp/agent",
  resolveEffectiveModelFallbacks: state.resolveEffectiveModelFallbacksMock,
  resolveSessionAgentIds: () => ({ defaultAgentId: "default", sessionAgentId: "default" }),
  resolveSessionAgentId: () => "default",
  resolveAgentSkillsFilter: () => undefined,
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
}));

vi.mock("./auth-profiles.js", () => ({
  ensureAuthProfileStore: () => ({ profiles: {} }),
}));

vi.mock("./auth-profiles/store.js", () => ({
  ensureAuthProfileStore: () => state.authProfileStoreMock,
}));

vi.mock("./auth-profiles/session-override.js", () => ({
  clearSessionAuthProfileOverride: (...args: unknown[]) =>
    state.clearSessionAuthProfileOverrideMock(...args),
}));

vi.mock("./defaults.js", () => ({
  DEFAULT_MODEL: "claude",
  DEFAULT_PROVIDER: "anthropic",
}));

vi.mock("./lanes.js", () => ({
  AGENT_LANE_SUBAGENT: "subagent",
}));

vi.mock("./model-catalog.js", () => ({
  loadManifestModelCatalog: state.loadManifestModelCatalogMock,
}));

vi.mock("./model-selection.js", () => {
  const buildAllowedModelSet = ({
    cfg,
    catalog,
    defaultProvider,
    defaultModel,
  }: {
    cfg?: unknown;
    catalog?: Array<{ provider: string; id: string }>;
    defaultProvider: string;
    defaultModel?: string;
  }) => {
    const modelMap =
      (cfg as { agents?: { defaults?: { models?: Record<string, unknown> } } } | undefined)?.agents
        ?.defaults?.models ?? {};
    const configuredCatalog = (
      (cfg as { models?: { providers?: Record<string, { models?: unknown[] }> } } | undefined)
        ?.models?.providers
        ? Object.entries(
            (cfg as { models?: { providers?: Record<string, { models?: unknown[] }> } }).models!
              .providers!,
          ).flatMap(([provider, entry]) =>
            Array.isArray(entry?.models)
              ? entry.models
                  .filter(
                    (model): model is Record<string, unknown> =>
                      !!model && typeof model === "object",
                  )
                  .map((model) => {
                    const id = typeof model.id === "string" ? model.id : "";
                    return {
                      provider,
                      id,
                      name: typeof model.name === "string" ? model.name : id,
                      reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
                      compat: model.compat,
                    };
                  })
                  .filter((model) => model.id)
              : [],
          )
        : []
    ) as Array<{ provider: string; id: string }>;
    const combinedCatalog = [...(catalog ?? []), ...configuredCatalog];
    const allowedKeys = new Set<string>(
      Object.keys(modelMap).map((ref) => {
        const [provider, ...modelParts] = ref.split("/");
        return `${provider}/${modelParts.join("/")}`;
      }),
    );
    if (defaultModel) {
      allowedKeys.add(`${defaultProvider}/${defaultModel}`);
    }
    if (Object.keys(modelMap).length === 0) {
      return {
        allowedKeys,
        allowedCatalog: combinedCatalog,
        allowAny: true,
      };
    }
    return {
      allowedKeys,
      allowedCatalog: combinedCatalog.filter((entry) =>
        allowedKeys.has(`${entry.provider}/${entry.id}`),
      ),
      allowAny: false,
    };
  };

  return {
    buildAllowedModelSet,
    createModelVisibilityPolicy: (params: {
      cfg?: unknown;
      catalog?: Array<{ provider: string; id: string }>;
      defaultProvider: string;
      defaultModel?: string;
    }) => {
      const allowed = buildAllowedModelSet(params);
      const allowsKey = (key: string) => {
        if (allowed.allowAny || allowed.allowedKeys.has(key)) {
          return true;
        }
        const slash = key.indexOf("/");
        return slash > 0 && allowed.allowedKeys.has(`${key.slice(0, slash)}/*`);
      };
      return {
        ...allowed,
        exactModelRefs: [],
        providerWildcards: new Set<string>(),
        hasConfiguredEntries: !allowed.allowAny,
        hasProviderWildcards: [...allowed.allowedKeys].some((key) => key.endsWith("/*")),
        allowsKey,
        allows: ({ provider, model }: { provider: string; model: string }) =>
          allowsKey(`${provider}/${model}`),
        resolveSelection: ({ provider, model }: { provider: string; model: string }) => {
          const key = `${provider}/${model}`;
          if (allowsKey(key)) {
            return { provider, model };
          }
          const fallback = allowed.allowedCatalog[0];
          return fallback ? { provider: fallback.provider, model: fallback.id } : null;
        },
        visibleCatalog: ({ catalog }: { catalog: Array<{ provider: string; id: string }> }) =>
          catalog,
      };
    },
    buildConfiguredModelCatalog: ({ cfg }: { cfg?: unknown }) => {
      const providers = (cfg as { models?: { providers?: Record<string, { models?: unknown[] }> } })
        ?.models?.providers;
      if (!providers) {
        return [];
      }
      return Object.entries(providers).flatMap(([provider, entry]) =>
        Array.isArray(entry?.models)
          ? entry.models
              .filter(
                (model): model is Record<string, unknown> => !!model && typeof model === "object",
              )
              .map((model) => {
                const id = typeof model.id === "string" ? model.id : "";
                return {
                  provider,
                  id,
                  name: typeof model.name === "string" ? model.name : id,
                  reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
                  compat: model.compat,
                };
              })
              .filter((model) => model.id)
          : [],
      );
    },
    isModelKeyAllowedBySet: (allowedKeys: ReadonlySet<string>, key: string) => {
      if (allowedKeys.has(key)) {
        return true;
      }
      const slash = key.indexOf("/");
      return slash > 0 && allowedKeys.has(`${key.slice(0, slash)}/*`);
    },
    resolveAllowedModelSelection: ({
      provider,
      model,
      allowAny,
      allowedKeys,
      allowedCatalog,
    }: {
      provider: string;
      model: string;
      allowAny: boolean;
      allowedKeys: ReadonlySet<string>;
      allowedCatalog: Array<{ provider: string; id: string }>;
    }) => {
      const key = `${provider}/${model}`;
      if (
        allowAny ||
        allowedKeys.has(key) ||
        (key.includes("/") && allowedKeys.has(`${key.slice(0, key.indexOf("/"))}/*`))
      ) {
        return { provider, model };
      }
      const fallback = allowedCatalog[0];
      return fallback ? { provider: fallback.provider, model: fallback.id } : null;
    },
    modelKey: (p: string, m: string) => `${p}/${m}`,
    normalizeModelRef: (p: string, m: string) => ({ provider: p, model: m }),
    parseModelRef: (m: string, p: string) => ({ provider: p, model: m }),
    resolveConfiguredModelRef: ({ cfg }: { cfg?: unknown }) => {
      const raw = (cfg as { agents?: { defaults?: { model?: string | { primary?: string } } } })
        ?.agents?.defaults?.model;
      const primary = typeof raw === "string" ? raw : raw?.primary;
      const [provider, ...modelParts] = (primary ?? "anthropic/claude").split("/");
      return { provider, model: modelParts.join("/") || "claude" };
    },
    resolveDefaultModelForAgent: ({ cfg }: { cfg?: unknown }) => {
      const raw = (cfg as { agents?: { defaults?: { model?: string | { primary?: string } } } })
        ?.agents?.defaults?.model;
      const primary = typeof raw === "string" ? raw : raw?.primary;
      const [provider, ...modelParts] = (primary ?? "anthropic/claude").split("/");
      return { provider, model: modelParts.join("/") || "claude" };
    },
    resolveThinkingDefault: (args: unknown) => state.resolveThinkingDefaultMock(args),
  };
});

vi.mock("./model-visibility-policy.js", () => ({
  createModelVisibilityPolicy: ({
    cfg,
    catalog,
    defaultProvider,
    defaultModel,
  }: {
    cfg?: unknown;
    catalog?: Array<{ provider: string; id: string }>;
    defaultProvider: string;
    defaultModel?: string;
  }) => {
    const modelMap =
      (cfg as { agents?: { defaults?: { models?: Record<string, unknown> } } } | undefined)?.agents
        ?.defaults?.models ?? {};
    const allowedKeys = new Set<string>(
      Object.keys(modelMap).map((ref) => {
        const [provider, ...modelParts] = ref.split("/");
        return `${provider}/${modelParts.join("/")}`;
      }),
    );
    if (defaultModel) {
      allowedKeys.add(`${defaultProvider}/${defaultModel}`);
    }
    const allowAny = Object.keys(modelMap).length === 0;
    const allowedCatalog = allowAny
      ? (catalog ?? [])
      : (catalog ?? []).filter((entry) => allowedKeys.has(`${entry.provider}/${entry.id}`));
    const allowsKey = (key: string) => {
      if (allowAny || allowedKeys.has(key)) {
        return true;
      }
      const slash = key.indexOf("/");
      return slash > 0 && allowedKeys.has(`${key.slice(0, slash)}/*`);
    };
    return {
      allowAny,
      allowedKeys,
      allowedCatalog,
      exactModelRefs: [],
      providerWildcards: new Set<string>(),
      hasConfiguredEntries: !allowAny,
      hasProviderWildcards: [...allowedKeys].some((key) => key.endsWith("/*")),
      allowsKey,
      allows: ({ provider, model }: { provider: string; model: string }) =>
        allowsKey(`${provider}/${model}`),
      resolveSelection: ({ provider, model }: { provider: string; model: string }) => {
        const key = `${provider}/${model}`;
        if (allowsKey(key)) {
          return { provider, model };
        }
        const fallback = allowedCatalog[0];
        return fallback ? { provider: fallback.provider, model: fallback.id } : null;
      },
      visibleCatalog: ({ catalog }: { catalog: Array<{ provider: string; id: string }> }) =>
        catalog,
    };
  },
}));

vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({}),
  resolveProviderIdForAuth: (provider: string) =>
    provider.trim().toLowerCase() === "codex-cli" ? "openai-codex" : provider.trim().toLowerCase(),
}));

vi.mock("./skills.js", () => ({
  buildWorkspaceSkillSnapshot: (workspaceDir: string, opts: unknown) =>
    state.buildWorkspaceSkillSnapshotMock(workspaceDir, opts),
}));

vi.mock("./skills/filter.js", () => ({
  matchesSkillFilter: () => true,
}));

vi.mock("./skills/refresh-state.js", () => ({
  getSkillsSnapshotVersion: () => 0,
  shouldRefreshSnapshotForVersion: () => false,
}));

vi.mock("./spawned-context.js", () => ({
  normalizeSpawnedRunMetadata: (meta: unknown) => meta ?? {},
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: () => 30_000,
}));

vi.mock("./workspace.js", () => ({
  ensureAgentWorkspace: async () => ({ dir: "/tmp/workspace" }),
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: (...args: unknown[]) => state.acpResolveSessionMock(...args),
    runTurn: (...args: unknown[]) => state.acpRunTurnMock(...args),
  }),
}));

let agentCommand: typeof import("./agent-command.js").agentCommand;

beforeAll(async () => {
  agentCommand ??= (await import("./agent-command.js")).agentCommand;
});

type FallbackRunnerParams = {
  provider: string;
  model: string;
  run: (provider: string, model: string) => Promise<unknown>;
  onFallbackStep?: (step: Record<string, unknown>) => void | Promise<void>;
  classifyResult?: (params: {
    provider: string;
    model: string;
    result: unknown;
    attempt: number;
    total: number;
  }) => unknown;
};

type ModelSwitchOptions = ConstructorParameters<typeof LiveSessionModelSwitchError>[0];

function makeSuccessResult(provider: string, model: string) {
  return {
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 100,
      aborted: false,
      stopReason: "end_turn",
      agentMeta: { provider, model },
    },
  };
}

function makeEmptyResult(provider: string, model: string) {
  return {
    payloads: [],
    meta: {
      durationMs: 30_000,
      aborted: false,
      stopReason: "end_turn",
      agentHarnessResultClassification: "empty",
      agentMeta: { provider, model },
    },
  };
}

function setupModelSwitchRetry(switchOptions: ModelSwitchOptions) {
  let invocation = 0;
  state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
    invocation += 1;
    if (invocation === 1) {
      throw new LiveSessionModelSwitchError(switchOptions);
    }
    const result = await params.run(params.provider, params.model);
    return {
      result,
      provider: params.provider,
      model: params.model,
      attempts: [],
    };
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} to be an array`);
  }
  return value;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function expectRecordFields(value: unknown, expected: Record<string, unknown>): void {
  const actual = requireRecord(value, "record");
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(actual[key]).toEqual(expectedValue);
  }
}

async function runBasicAgentCommand() {
  await agentCommand({
    message: "hello",
    to: "+1234567890",
    senderIsOwner: true,
  });
}

function expectFallbackOverrideCalls(first: boolean, second: boolean) {
  expect(state.resolveEffectiveModelFallbacksMock).toHaveBeenCalledTimes(2);
  expectRecordFields(mockCallArg(state.resolveEffectiveModelFallbacksMock, 0), {
    hasSessionModelOverride: first,
  });
  expectRecordFields(mockCallArg(state.resolveEffectiveModelFallbacksMock, 1), {
    hasSessionModelOverride: second,
  });
}

describe("agentCommand – LiveSessionModelSwitchError retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.acpResolveSessionMock.mockReturnValue(null);
    state.resolveAcpAgentPolicyErrorMock.mockReturnValue(null);
    state.resolveAcpDispatchPolicyErrorMock.mockReturnValue(null);
    state.resolveAcpExplicitTurnPolicyErrorMock.mockReturnValue(null);
    state.runtimeConfigMock = undefined;
    state.isThinkingLevelSupportedMock.mockReturnValue(true);
    state.resolveThinkingDefaultMock.mockReturnValue("low");
    state.loadManifestModelCatalogMock.mockReturnValue([]);
    state.acpRunTurnMock.mockImplementation(async (params: unknown) => {
      const onEvent = (params as { onEvent?: (event: unknown) => void }).onEvent;
      onEvent?.({ type: "text_delta", stream: "output", text: "done" });
      onEvent?.({ type: "done", stopReason: "end_turn" });
    });
    state.createAcpVisibleTextAccumulatorMock.mockImplementation(() => {
      let text = "";
      return {
        consume(chunk: string) {
          text += chunk;
          return { text, delta: chunk };
        },
        finalizeRaw: () => text,
        finalize: () => text,
      };
    });
    state.buildAcpResultMock.mockImplementation((params: { payloadText?: string }) => ({
      payloads: params.payloadText ? [{ text: params.payloadText }] : [],
      meta: { durationMs: 0, stopReason: "end_turn" },
    }));
    state.persistAcpTurnTranscriptMock.mockImplementation(
      async (params: { sessionEntry?: unknown }) => params.sessionEntry,
    );
    state.authProfileStoreMock = { profiles: {} };
    state.sessionEntryMock = undefined;
    state.sessionStoreMock = undefined;
    state.storePathMock = undefined;
    state.persistSessionEntryMock.mockImplementation(async (...args: unknown[]) => {
      const params = args[0] as {
        sessionStore?: Record<string, unknown>;
        sessionKey?: string;
        entry?: unknown;
        shouldPersist?: (entry: unknown) => boolean;
      };
      const current =
        params.sessionStore && params.sessionKey
          ? params.sessionStore[params.sessionKey]
          : undefined;
      if (params.shouldPersist && !params.shouldPersist(current)) {
        if (current === undefined && params.sessionStore && params.sessionKey) {
          delete params.sessionStore[params.sessionKey];
        }
        return current;
      }
      if (params.sessionStore && params.sessionKey && params.entry) {
        params.sessionStore[params.sessionKey] = params.entry;
        return params.entry;
      }
      return current;
    });
    state.buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "",
      skills: [],
      resolvedSkills: [],
      version: 0,
    });
    state.deliverAgentCommandResultMock.mockResolvedValue(undefined);
    state.updateSessionStoreAfterAgentRunMock.mockResolvedValue(undefined);
    state.trajectoryFlushMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries with the switched provider/model when LiveSessionModelSwitchError is thrown", async () => {
    setupModelSwitchRetry({
      provider: "openai",
      model: "gpt-5.4",
    });

    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await runBasicAgentCommand();

    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(2);

    const secondCall = mockCallArg(state.runWithModelFallbackMock, 1) as FallbackRunnerParams;
    expect(secondCall.provider).toBe("openai");
    expect(secondCall.model).toBe("gpt-5.4");

    const lifecycleEndCalls = state.emitAgentEventMock.mock.calls.filter((call: unknown[]) => {
      const arg = call[0] as { stream?: string; data?: { phase?: string } };
      return arg?.stream === "lifecycle" && arg?.data?.phase === "end";
    });
    expect(lifecycleEndCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("validates explicit thinking against configured model compat without an allowlist", async () => {
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: { primary: "gmn/gpt-5.4" },
        },
      },
      models: {
        providers: {
          gmn: {
            models: [
              {
                id: "gpt-5.4",
                name: "GPT 5.4 via GMN",
                reasoning: true,
                compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
              },
            ],
          },
        },
      },
    };
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      const result = await params.run(params.provider, params.model);
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("gmn", "gpt-5.4"));

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      senderIsOwner: true,
      thinking: "xhigh",
    });

    const thinkingArgs = requireRecord(
      mockCallArg(state.isThinkingLevelSupportedMock),
      "thinking args",
    );
    expect(thinkingArgs.provider).toBe("gmn");
    expect(thinkingArgs.model).toBe("gpt-5.4");
    expect(thinkingArgs.level).toBe("xhigh");
    const catalog = requireArray(thinkingArgs.catalog, "thinking catalog");
    expectRecordFields(catalog[0], {
      provider: "gmn",
      id: "gpt-5.4",
      compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
    });
  });

  it("validates explicit thinking against allowlisted configured model compat when manifest catalog is empty", async () => {
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: { primary: "gmn/gpt-5.4" },
          models: {
            "gmn/gpt-5.4": {},
          },
        },
      },
      models: {
        providers: {
          gmn: {
            models: [
              {
                id: "gpt-5.4",
                name: "GPT 5.4 via GMN",
                reasoning: true,
                compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
              },
            ],
          },
        },
      },
    };
    state.loadManifestModelCatalogMock.mockReturnValue([]);
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      const result = await params.run(params.provider, params.model);
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("gmn", "gpt-5.4"));

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      senderIsOwner: true,
      thinking: "xhigh",
    });

    expect(state.loadManifestModelCatalogMock).toHaveBeenCalledTimes(1);
    const thinkingArgs = requireRecord(
      mockCallArg(state.isThinkingLevelSupportedMock),
      "thinking args",
    );
    expect(thinkingArgs.provider).toBe("gmn");
    expect(thinkingArgs.model).toBe("gpt-5.4");
    expect(thinkingArgs.level).toBe("xhigh");
    const catalog = requireArray(thinkingArgs.catalog, "thinking catalog");
    expectRecordFields(catalog[0], {
      provider: "gmn",
      id: "gpt-5.4",
      compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
    });
  });

  it("records fallback steps to the session trajectory runtime", async () => {
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      await params.onFallbackStep?.({
        fallbackStepType: "fallback_step",
        fallbackStepFromModel: "ollama/llama3",
        fallbackStepToModel: "openai/gpt-5.4",
        fallbackStepFromFailureReason: "overloaded",
        fallbackStepChainPosition: 1,
        fallbackStepFinalOutcome: "next_fallback",
      });
      const result = await params.run(params.provider, params.model);
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await runBasicAgentCommand();

    expect(state.trajectoryRecordEventMock).toHaveBeenCalledTimes(1);
    expect(mockCallArg(state.trajectoryRecordEventMock, 0, 0)).toBe("model.fallback_step");
    expectRecordFields(mockCallArg(state.trajectoryRecordEventMock, 0, 1), {
      fallbackStepType: "fallback_step",
      fallbackStepFromModel: "ollama/llama3",
      fallbackStepToModel: "openai/gpt-5.4",
      fallbackStepFromFailureReason: "overloaded",
      fallbackStepChainPosition: 1,
      fallbackStepFinalOutcome: "next_fallback",
    });
    expect(state.trajectoryFlushMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses duplicate user persistence only after the current turn has flushed", async () => {
    type AttemptCall = {
      onUserMessagePersisted?: () => void;
      suppressPromptPersistenceOnRetry?: boolean;
    };
    const attemptCalls: AttemptCall[] = [];
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      const first = await params.run(params.provider, params.model);
      const result = await params.run(params.provider, params.model);
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [first],
      };
    });
    state.runAgentAttemptMock.mockImplementation(async (attemptParams: AttemptCall) => {
      const firstAttempt = attemptCalls.length === 0;
      attemptCalls.push(attemptParams);
      if (firstAttempt) {
        if (!attemptParams.onUserMessagePersisted) {
          throw new Error("expected retry persistence callback on first attempt");
        }
        attemptParams.onUserMessagePersisted();
      } else {
        attemptParams.onUserMessagePersisted?.();
      }
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await runBasicAgentCommand();

    expect(attemptCalls).toHaveLength(2);
    expect(attemptCalls[0]?.suppressPromptPersistenceOnRetry).not.toBe(true);
    expect(attemptCalls[1]?.suppressPromptPersistenceOnRetry).toBe(true);
  });

  it("suppresses prompt persistence for internal handoffs on every fallback attempt", async () => {
    type AttemptCall = {
      suppressPromptPersistenceOnRetry?: boolean;
    };
    const attemptCalls: AttemptCall[] = [];
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      const first = await params.run(params.provider, params.model);
      const result = await params.run(params.provider, params.model);
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [first],
      };
    });
    state.runAgentAttemptMock.mockImplementation(async (attemptParams: AttemptCall) => {
      attemptCalls.push(attemptParams);
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await agentCommand({
      message: "internal handoff",
      to: "+1234567890",
      senderIsOwner: true,
      suppressPromptPersistence: true,
    });

    expect(attemptCalls).toHaveLength(2);
    expect(attemptCalls[0]?.suppressPromptPersistenceOnRetry).toBe(true);
    expect(attemptCalls[1]?.suppressPromptPersistenceOnRetry).toBe(true);
  });

  it("propagates non-switch errors without retrying and emits lifecycle error", async () => {
    state.runWithModelFallbackMock.mockRejectedValueOnce(new Error("provider down"));

    await expect(
      agentCommand({
        message: "hello",
        to: "+1234567890",
        senderIsOwner: true,
      }),
    ).rejects.toThrow("provider down");

    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(1);

    const lifecycleErrorCalls = state.emitAgentEventMock.mock.calls.filter((call: unknown[]) => {
      const arg = call[0] as { stream?: string; data?: { phase?: string } };
      return arg?.stream === "lifecycle" && arg?.data?.phase === "error";
    });
    expect(lifecycleErrorCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("propagates authProfileId from the switch error to the retried session entry", async () => {
    let capturedAuthProfileProvider: string | undefined;
    setupModelSwitchRetry({
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "profile-openai-prod",
      authProfileIdSource: "user",
    });

    state.runAgentAttemptMock.mockImplementation(async (...args: unknown[]) => {
      const attemptParams = args[0] as { authProfileProvider?: string } | undefined;
      capturedAuthProfileProvider = attemptParams?.authProfileProvider;
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await runBasicAgentCommand();

    expect(capturedAuthProfileProvider).toBe("openai");
    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(2);
  });

  it("does not persist a user live switch as an auto fallback probe result", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "openai",
      modelOverride: "claude",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    state.sessionEntryMock = sessionEntry;
    const sessionStore: Record<string, SessionEntry> = { "agent:main": sessionEntry };
    state.sessionStoreMock = sessionStore;
    state.storePathMock = "/tmp/openclaw-session-store.json";
    setupModelSwitchRetry({
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "openai:primary",
      authProfileIdSource: "user",
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await runBasicAgentCommand();

    const autoPinnedSwitchWrites = state.persistSessionEntryMock.mock.calls.filter((call) => {
      const entry = (call[0] as { entry?: Record<string, unknown> } | undefined)?.entry;
      return (
        entry?.providerOverride === "openai" &&
        entry?.modelOverride === "gpt-5.4" &&
        entry?.modelOverrideSource === "auto" &&
        entry?.modelOverrideFallbackOriginProvider === "anthropic"
      );
    });
    expect(autoPinnedSwitchWrites).toHaveLength(0);
    expectRecordFields(mockCallArg(state.updateSessionStoreAfterAgentRunMock), {
      fallbackProvider: "openai",
      fallbackModel: "gpt-5.4",
    });
  });

  it("does not overwrite a concurrent user model switch after a primary probe", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "openai",
      modelOverride: "claude",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    state.sessionEntryMock = sessionEntry;
    const sessionStore: Record<string, SessionEntry> = { "agent:main": sessionEntry };
    state.sessionStoreMock = sessionStore;
    state.storePathMock = "/tmp/openclaw-session-store.json";
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run(params.provider, params.model);
      sessionStore["agent:main"] = {
        sessionId: "session-1",
        updatedAt: Date.now(),
        providerOverride: "google",
        modelOverride: "gemini-3-pro",
        modelOverrideSource: "user",
        skillsSnapshot: { prompt: "", skills: [], version: 0 },
      };
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude"));

    await runBasicAgentCommand();

    expectRecordFields(sessionStore["agent:main"], {
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "user",
    });
  });

  it("keeps aliased session auth profiles for codex-cli runs", async () => {
    let capturedAuthProfileProvider: string | undefined;
    const sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-cli",
      modelOverride: "gpt-5.4",
      authProfileOverride: "openai-codex:work",
      authProfileOverrideSource: "user",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    state.sessionEntryMock = sessionEntry;
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          models: {
            "codex-cli/gpt-5.4": {},
          },
        },
      },
    };
    state.authProfileStoreMock = {
      profiles: {
        "openai-codex:work": {
          type: "api_key",
          provider: "openai-codex",
          key: "sk-test",
        },
      },
    };
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      const result = await params.run(params.provider, params.model);
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockImplementation(async (...args: unknown[]) => {
      const attemptParams = args[0] as { authProfileProvider?: string } | undefined;
      capturedAuthProfileProvider = attemptParams?.authProfileProvider;
      return makeSuccessResult("codex-cli", "gpt-5.4");
    });

    await runBasicAgentCommand();

    expect(capturedAuthProfileProvider).toBe("codex-cli");
    expect(state.clearSessionAuthProfileOverrideMock).not.toHaveBeenCalled();
  });

  it("hydrates stripped persisted skill snapshots before running the CLI path", async () => {
    const persistedSnapshot = {
      prompt: "persisted prompt",
      skills: [{ name: "cli-skill" }],
      skillFilter: ["cli-skill"],
      version: 0,
    };
    const rebuiltSkills = [
      {
        name: "cli-skill",
        description: "CLI skill",
        filePath: "/tmp/workspace/skills/cli-skill/SKILL.md",
        baseDir: "/tmp/workspace/skills/cli-skill",
        source: "# CLI skill",
      },
    ];
    state.sessionEntryMock = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      skillsSnapshot: persistedSnapshot,
    };
    state.buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "rebuilt prompt",
      skills: [{ name: "different-skill" }],
      resolvedSkills: rebuiltSkills,
      version: 99,
    });
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      const result = await params.run(params.provider, params.model);
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude"));

    await runBasicAgentCommand();

    const attemptParams = mockCallArg(state.runAgentAttemptMock) as {
      skillsSnapshot?: Record<string, unknown>;
    };
    expectRecordFields(attemptParams?.skillsSnapshot, {
      prompt: "persisted prompt",
      skills: [{ name: "cli-skill" }],
      skillFilter: ["cli-skill"],
      version: 0,
      resolvedSkills: rebuiltSkills,
    });
    expect(state.buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("classifies empty embedded run results before model fallback accepts them", async () => {
    let observedClassification: unknown;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      const primaryResult = await params.run(params.provider, params.model);
      observedClassification = await params.classifyResult?.({
        provider: params.provider,
        model: params.model,
        result: primaryResult,
        attempt: 1,
        total: 2,
      });
      const fallbackResult = await params.run("openai", "gpt-5.4");
      return {
        result: fallbackResult,
        provider: "openai",
        model: "gpt-5.4",
        attempts: [
          {
            provider: params.provider,
            model: params.model,
            error: "empty result",
            reason: "format",
            code: "empty_result",
          },
        ],
      };
    });
    state.runAgentAttemptMock
      .mockResolvedValueOnce(makeEmptyResult("anthropic", "claude"))
      .mockResolvedValueOnce(makeSuccessResult("openai", "gpt-5.4"));

    await runBasicAgentCommand();

    expectRecordFields(observedClassification, {
      reason: "format",
      code: "empty_result",
    });
    expect(state.runAgentAttemptMock).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(state.runAgentAttemptMock, 1), {
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      isFallbackRetry: true,
    });
    const deliveryParams = requireRecord(
      mockCallArg(state.deliverAgentCommandResultMock),
      "delivery params",
    );
    const result = requireRecord(deliveryParams.result, "delivery result");
    const meta = requireRecord(result.meta, "delivery result meta");
    const agentMeta = requireRecord(meta.agentMeta, "delivery agent meta");
    const fallbackAttempts = requireArray(agentMeta.fallbackAttempts, "fallback attempts");
    expectRecordFields(fallbackAttempts[0], {
      provider: "anthropic",
      model: "claude",
      reason: "format",
    });
  });

  it("updates hasSessionModelOverride for fallback resolution after switch", async () => {
    setupModelSwitchRetry({
      provider: "openai",
      model: "gpt-5.4",
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    state.resolveEffectiveModelFallbacksMock.mockClear();

    await runBasicAgentCommand();

    expectFallbackOverrideCalls(false, true);
  });

  it("does not flip hasSessionModelOverride on auth-only switch with same model", async () => {
    setupModelSwitchRetry({
      provider: "anthropic",
      model: "claude",
      authProfileId: "profile-99",
      authProfileIdSource: "user",
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude"));

    state.resolveEffectiveModelFallbacksMock.mockClear();

    await runBasicAgentCommand();

    expectFallbackOverrideCalls(false, false);
  });

  it("sends internal completion wakes to ACP sessions as plain prompt text", async () => {
    state.acpResolveSessionMock.mockReturnValue({
      kind: "ready",
      meta: {
        agent: "claude",
        cwd: "/tmp/workspace",
      },
    });

    await agentCommand({
      message: [
        INTERNAL_RUNTIME_CONTEXT_BEGIN,
        "OpenClaw runtime context (internal):",
        "hidden task completion event",
        INTERNAL_RUNTIME_CONTEXT_END,
      ].join("\n"),
      sessionKey: "agent:main",
      senderIsOwner: true,
      internalEvents: [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:main:subagent:child",
          childSessionId: "child-session-id",
          announceType: "subagent task",
          taskLabel: "inspect ACP delivery",
          status: "ok",
          statusLabel: "completed successfully",
          result: "child output",
          replyInstruction: "Summarize the result for the user.",
        },
      ],
    });

    expect(state.acpRunTurnMock).toHaveBeenCalledTimes(1);
    const runTurnParams = mockCallArg(state.acpRunTurnMock) as { text?: string };
    expect(runTurnParams.text).toContain("A background task completed.");
    expect(runTurnParams.text).toContain("inspect ACP delivery");
    expect(runTurnParams.text).toContain("child output");
    expect(runTurnParams.text).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
    expect(runTurnParams.text).not.toContain(INTERNAL_RUNTIME_CONTEXT_END);

    expect(state.persistAcpTurnTranscriptMock).toHaveBeenCalledTimes(1);
    const transcriptParams = mockCallArg(state.persistAcpTurnTranscriptMock) as {
      body?: string;
      transcriptBody?: string;
    };
    expect(transcriptParams.body).toBe(runTurnParams.text);
    expect(transcriptParams.transcriptBody).toContain("A background task completed.");
    expect(transcriptParams.transcriptBody).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
    expect(transcriptParams.transcriptBody).not.toContain(INTERNAL_RUNTIME_CONTEXT_END);
  });

  it("allows manual ACP spawn turns when ACP dispatch is disabled", async () => {
    state.acpResolveSessionMock.mockReturnValue({
      kind: "ready",
      meta: {
        agent: "claude",
        cwd: "/tmp/workspace",
      },
    });
    state.resolveAcpDispatchPolicyErrorMock.mockReturnValue(
      new Error("ACP dispatch is disabled by policy (`acp.dispatch.enabled=false`)."),
    );

    await agentCommand({
      message: "bootstrap ACP child",
      sessionKey: "agent:main",
      senderIsOwner: true,
      acpTurnSource: "manual_spawn",
    });

    expect(state.resolveAcpExplicitTurnPolicyErrorMock).toHaveBeenCalledTimes(1);
    expect(state.resolveAcpDispatchPolicyErrorMock).not.toHaveBeenCalled();
    expect(state.acpRunTurnMock).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary ACP turns blocked when ACP dispatch is disabled", async () => {
    state.acpResolveSessionMock.mockReturnValue({
      kind: "ready",
      meta: {
        agent: "claude",
        cwd: "/tmp/workspace",
      },
    });
    state.resolveAcpDispatchPolicyErrorMock.mockReturnValue(
      new Error("ACP dispatch is disabled by policy (`acp.dispatch.enabled=false`)."),
    );

    await expect(
      agentCommand({
        message: "automatic ACP turn",
        sessionKey: "agent:main",
        senderIsOwner: true,
      }),
    ).rejects.toThrow("ACP dispatch is disabled");

    expect(state.resolveAcpExplicitTurnPolicyErrorMock).not.toHaveBeenCalled();
    expect(state.resolveAcpDispatchPolicyErrorMock).toHaveBeenCalledTimes(1);
    expect(state.acpRunTurnMock).not.toHaveBeenCalled();
  });

  it("flips hasSessionModelOverride on provider-only switch with same model", async () => {
    setupModelSwitchRetry({
      provider: "openai",
      model: "claude",
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "claude"));

    state.resolveEffectiveModelFallbacksMock.mockClear();

    await runBasicAgentCommand();

    expectFallbackOverrideCalls(false, true);
  });
});

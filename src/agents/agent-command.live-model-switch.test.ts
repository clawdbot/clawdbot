/** Tests live model switching behavior in active agent command sessions. */

import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "./internal-runtime-context.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
} from "./run-termination.js";

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
  emitAcpLifecycleEndMock: vi.fn(),
  emitAcpLifecycleErrorMock: vi.fn(),
  persistCliTurnTranscriptMock: vi.fn(),
  persistAcpTurnTranscriptMock: vi.fn(),
  runCliTurnCompactionLifecycleMock: vi.fn(),
  resolveAcpAgentPolicyErrorMock: vi.fn(),
  resolveAcpDispatchPolicyErrorMock: vi.fn(),
  resolveAcpExplicitTurnPolicyErrorMock: vi.fn(),
  runWithModelFallbackMock: vi.fn(),
  runAgentAttemptMock: vi.fn(),
  resolveAgentSkillsFilterMock: vi.fn(
    (_cfg?: unknown, _agentId?: string): string[] | undefined => undefined,
  ),
  resolveEffectiveModelFallbacksMock: vi.fn().mockReturnValue(undefined),
  hasLegacyAutoFallbackWithoutOriginMock: vi.fn((_entry: unknown) => false),
  isModelSelectionLockedMock: vi.fn(
    (entry: unknown) =>
      (entry as { modelSelectionLocked?: boolean } | undefined)?.modelSelectionLocked === true,
  ),
  applyModelOverrideToSessionEntryMock: vi.fn((_params: unknown) => ({ updated: false })),
  repairProviderWrappedModelOverrideMock: vi.fn((_params: unknown) => ({ updated: false })),
  resolveAutoFallbackPrimaryProbeMock: vi.fn((_params: unknown) => undefined as unknown),
  resolveChannelModelOverrideMock: vi.fn((_params: unknown) => null as unknown),
  assertLifecycleCurrentMock: vi.fn(),
  emitAgentEventMock: vi.fn(),
  registerAgentRunContextMock: vi.fn(),
  clearAgentRunContextMock: vi.fn(),
  loadSessionEntryMock: vi.fn(),
  updateSessionStoreAfterAgentRunMock: vi.fn(),
  deliverAgentCommandResultMock: vi.fn(),
  resolveAgentDeliveryPlanMock: vi.fn(),
  resolveAgentOutboundTargetMock: vi.fn(),
  resolveMessageChannelSelectionMock: vi.fn(),
  createTrajectoryRuntimeRecorderMock: vi.fn(),
  trajectoryRecordEventMock: vi.fn(),
  trajectoryFlushMock: vi.fn(async () => undefined),
  persistSessionEntryMock: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  clearSessionAuthProfileOverrideMock: vi.fn(),
  isThinkingLevelSupportedMock: vi.fn((_args: unknown) => true),
  resolveSupportedThinkingLevelMock: vi.fn(({ level }: { level?: string }) => level),
  resolveThinkingDefaultMock: vi.fn((_args: unknown) => "low"),
  loadManifestModelCatalogMock: vi.fn(() => []),
  buildWorkspaceSkillSnapshotMock: vi.fn((..._args: unknown[]): unknown => ({
    prompt: "",
    skills: [],
    resolvedSkills: [],
    version: 0,
  })),
  prepareInternalSessionEffectsSessionMock: vi.fn(),
  removeInternalSessionEffectsSessionMock: vi.fn(),
  authProfileStoreMock: { profiles: {} } as { profiles: Record<string, unknown> },
  sessionEntryMock: undefined as SessionEntry | undefined,
  sessionStoreMock: undefined as unknown,
  storePathMock: undefined as string | undefined,
  resolvedSessionKeyMock: undefined as string | undefined,
  trajectoryRecorderParamsMock: vi.fn(),
}));

vi.mock("./model-fallback.js", () => ({
  runWithModelFallback: (params: unknown) => state.runWithModelFallbackMock(params),
}));

vi.mock("./command/attempt-execution.runtime.js", () => ({
  buildAcpResult: (...args: unknown[]) => state.buildAcpResultMock(...args),
  createAcpToolLifecycleTracker: () => ({
    active: new Map(),
    terminalToolCallIds: new Set(),
    saturated: false,
  }),
  createAcpVisibleTextAccumulator: () => state.createAcpVisibleTextAccumulatorMock(),
  emitAcpAssistantDelta: vi.fn(),
  emitAcpLifecycleEnd: (...args: unknown[]) => state.emitAcpLifecycleEndMock(...args),
  emitAcpLifecycleError: (...args: unknown[]) => state.emitAcpLifecycleErrorMock(...args),
  emitAcpLifecycleStart: vi.fn(),
  emitAcpRuntimeEvent: vi.fn(),
  persistCliTurnTranscript: (...args: unknown[]) => state.persistCliTurnTranscriptMock(...args),
  persistAcpTurnTranscript: (...args: unknown[]) => state.persistAcpTurnTranscriptMock(...args),
  persistSessionEntry: vi.fn(),
  prependInternalEventContext: (body: string) => body,
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

vi.mock("./command/cli-compaction.js", () => ({
  runCliTurnCompactionLifecycle: (...args: unknown[]) =>
    state.runCliTurnCompactionLifecycleMock(...args),
}));

vi.mock("./command/run-context.js", () => ({
  resolveAgentRunContext: (opts: {
    accountId?: string;
    channel?: string;
    groupChannel?: string | null;
    groupId?: string | null;
    groupSpace?: string | null;
    messageChannel?: string;
    replyChannel?: string;
    runContext?: {
      accountId?: string;
      currentChannelId?: string;
      currentThreadTs?: string;
      groupChannel?: string | null;
      groupId?: string | null;
      groupSpace?: string | null;
      messageChannel?: string;
      replyToMode?: "off" | "first" | "all" | "batched";
    };
    threadId?: string | number;
    to?: string;
  }) => ({
    messageChannel:
      opts.runContext?.messageChannel ?? opts.messageChannel ?? opts.replyChannel ?? opts.channel,
    accountId: opts.runContext?.accountId ?? opts.accountId ?? "acct",
    groupId: opts.runContext?.groupId ?? opts.groupId,
    groupChannel: opts.runContext?.groupChannel ?? opts.groupChannel,
    groupSpace: opts.runContext?.groupSpace ?? opts.groupSpace,
    currentChannelId: undefined,
    currentThreadTs:
      opts.runContext?.currentThreadTs ??
      (opts.threadId == null ? undefined : String(opts.threadId)),
    replyToMode: opts.runContext?.replyToMode,
    hasRepliedRef: { current: false },
  }),
}));

vi.mock("./command/session-store.runtime.js", () => ({
  loadSessionEntry: (...args: unknown[]) => state.loadSessionEntryMock(...args),
  updateSessionStoreAfterAgentRun: (...args: unknown[]) =>
    state.updateSessionStoreAfterAgentRunMock(...args),
}));

vi.mock("./command/session.js", () => ({
  resolveSession: () => {
    const sessionEntry: SessionEntry = state.sessionEntryMock ?? {
      sessionId: "session-1",
      updatedAt: Date.now(),
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    return {
      sessionId: "session-1",
      sessionKey: state.resolvedSessionKeyMock ?? "agent:main:main",
      sessionEntry,
      sessionStore: state.sessionStoreMock,
      storePath: state.storePathMock,
      isNewSession: false,
      persistedThinking:
        typeof sessionEntry.thinkingLevel === "string" ? sessionEntry.thinkingLevel : undefined,
      persistedVerbose: undefined,
    };
  },
}));

vi.mock("./command/types.js", () => ({}));

vi.mock("./harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));

// Harness selection has dedicated coverage; this command suite registers no auto harnesses.
vi.mock("./harness/support.js", () => ({
  resolveAutoAgentHarnessId: () => undefined,
}));

vi.mock("../acp/policy.js", () => ({
  isAcpEnabledByPolicy: () => true,
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

vi.mock("@openclaw/acp-core/runtime/session-identifiers", () => ({
  resolveAcpSessionCwd: () => "/tmp",
}));

vi.mock("../auto-reply/thinking.js", () => ({
  formatThinkingLevels: () => "low, medium, high",
  normalizeThinkLevel: (v?: string) => v || undefined,
  normalizeVerboseLevel: (v?: string) => v || undefined,
  isThinkingLevelSupported: (args: unknown) => state.isThinkingLevelSupportedMock(args),
  resolveSupportedThinkingLevel: (args: { level?: string }) =>
    state.resolveSupportedThinkingLevelMock(args),
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

// Model selection is mocked below, so plugin discovery cannot affect these assertions.
vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: () => ({ plugins: [] }),
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
  resolveSessionTranscriptFile: async (params: { sessionEntry?: SessionEntry }) => ({
    sessionFile: params.sessionEntry?.sessionFile ?? "/tmp/session.jsonl",
    sessionEntry: params.sessionEntry ?? { sessionId: "session-1", updatedAt: Date.now() },
  }),
}));

vi.mock("./internal-session-effects.js", () => ({
  prepareInternalSessionEffectsSession: (...args: unknown[]) =>
    state.prepareInternalSessionEffectsSessionMock(...args),
  removeInternalSessionEffectsSession: (...args: unknown[]) =>
    state.removeInternalSessionEffectsSessionMock(...args),
  resolveInternalSessionEffectsTarget: ({ agentId, runId, storePath }: Record<string, string>) => ({
    agentId,
    sessionId: `internal-${runId}`,
    sessionKey: `agent:${agentId}:internal-session-effects:${runId}`,
    storePath,
  }),
}));

vi.mock("../infra/agent-events.js", () => ({
  assertAgentRunLifecycleGenerationCurrent: (...args: unknown[]) =>
    state.assertLifecycleCurrentMock(...args),
  captureAgentRunLifecycleGeneration: () => "test-generation",
  clearAgentRunContext: (...args: unknown[]) => state.clearAgentRunContextMock(...args),
  emitAgentEvent: (...args: unknown[]) => state.emitAgentEventMock(...args),
  getAgentEventLifecycleGeneration: () => "test-generation",
  onAgentEvent: vi.fn(),
  registerAgentRunContext: (...args: unknown[]) => state.registerAgentRunContextMock(...args),
  withAgentRunLifecycleGeneration: (_generation: string, run: () => unknown) => run(),
}));

vi.mock("../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: () => ({}),
}));

vi.mock("../infra/outbound/agent-delivery.js", () => ({
  resolveAgentDeliveryPlan: (...args: unknown[]) => state.resolveAgentDeliveryPlanMock(...args),
  resolveAgentOutboundTarget: (...args: unknown[]) => state.resolveAgentOutboundTargetMock(...args),
}));

vi.mock("../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: (...args: unknown[]) =>
    state.resolveMessageChannelSelectionMock(...args),
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

afterAll(() => {
  // This suite runs in a shared worker; do not leak its module-level logger
  // mock into later files that verify real warning diagnostics.
  vi.doUnmock("../logging/subsystem.js");
});

vi.mock("../channels/model-overrides.js", () => ({
  resolveChannelModelOverride: (params: unknown) => state.resolveChannelModelOverrideMock(params),
}));

vi.mock("../routing/session-key.js", async () => {
  const actual = await vi.importActual<typeof import("../routing/session-key.js")>(
    "../routing/session-key.js",
  );
  return {
    ...actual,
    normalizeAgentId: (id: string) => id,
    normalizeMainKey: (key?: string | null) => key?.trim() || "main",
  };
});

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
  applyModelOverrideToSessionEntry: (params: unknown) =>
    state.applyModelOverrideToSessionEntryMock(params),
  isModelSelectionLocked: (entry: unknown) => state.isModelSelectionLockedMock(entry),
  MODEL_SELECTION_LOCKED_MESSAGE: "Model selection is locked for this session.",
  ModelSelectionLockedError: class ModelSelectionLockedError extends Error {
    constructor() {
      super("Model selection is locked for this session.");
      this.name = "ModelSelectionLockedError";
    }
  },
  repairProviderWrappedModelOverride: (params: unknown) =>
    state.repairProviderWrappedModelOverrideMock(params),
}));

vi.mock("../sessions/send-policy.js", () => ({
  resolveSendPolicy: () => "allow",
}));

vi.mock("../terminal/ansi.js", () => ({
  sanitizeForLog: (s: string) => s,
}));

vi.mock("../trajectory/runtime.js", () => ({
  createTrajectoryRuntimeRecorder: (params: unknown) => {
    state.createTrajectoryRuntimeRecorderMock(params);
    state.trajectoryRecorderParamsMock(params);
    return {
      enabled: true,
      filePath: "/tmp/session.trajectory.jsonl",
      recordEvent: (...args: unknown[]) => state.trajectoryRecordEventMock(...args),
      flush: () => state.trajectoryFlushMock(),
    };
  },
}));

vi.mock("../utils/message-channel.js", () => ({
  INTERNAL_MESSAGE_CHANNEL: "internal",
  isDeliverableMessageChannel: (value: string) => value !== "internal",
  normalizeMessageChannel: (value?: string | null) => value?.trim().toLowerCase() || undefined,
  resolveMessageChannel: (...values: Array<string | null | undefined>) =>
    values
      .find((value) => value?.trim())
      ?.trim()
      .toLowerCase(),
}));

vi.mock("./agent-scope.js", () => ({
  clearAutoFallbackPrimaryProbeSelection: vi.fn(),
  entryMatchesAutoFallbackPrimaryProbe: () => true,
  hasLegacyAutoFallbackWithoutOrigin: (entry: unknown) =>
    state.hasLegacyAutoFallbackWithoutOriginMock(entry),
  hasSessionAutoModelFallbackProvenance: () => false,
  listAgentEntries: () => [],
  listAgentIds: () => ["default"],
  markAutoFallbackPrimaryProbe: vi.fn(),
  resolveAutoFallbackPrimaryProbe: (params: unknown) =>
    state.resolveAutoFallbackPrimaryProbeMock(params),
  resolveAgentConfig: () => undefined,
  resolveAgentDir: () => "/tmp/agent",
  resolveAgentEffectiveModelPrimary: (cfg: unknown) => {
    const raw = (cfg as { agents?: { defaults?: { model?: string | { primary?: string } } } })
      ?.agents?.defaults?.model;
    return typeof raw === "string" ? raw : raw?.primary;
  },
  resolveDefaultAgentId: () => "default",
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

// Exec eligibility is outside model-switch scope; avoid loading its policy graph.
vi.mock("./exec-defaults.js", () => ({
  resolveNodeExecEligibility: () => ({ canExec: false }),
}));

vi.mock("./lanes.js", () => ({
  AGENT_LANE_SUBAGENT: "subagent",
}));

vi.mock("./model-catalog.js", () => ({
  loadManifestModelCatalog: state.loadManifestModelCatalogMock,
}));

vi.mock("./model-selection.js", () => {
  const normalizeProviderId = (provider: string) => provider.trim().toLowerCase();
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
                      Boolean(model) && typeof model === "object",
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
                (model): model is Record<string, unknown> =>
                  Boolean(model) && typeof model === "object",
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
    buildModelAliasIndex: ({
      cfg,
    }: {
      cfg?: { agents?: { defaults?: { models?: Record<string, { alias?: string }> } } };
    }) => {
      const byAlias = new Map<
        string,
        { alias: string; ref: { provider: string; model: string } }
      >();
      const byKey = new Map<string, string[]>();
      for (const [ref, entry] of Object.entries(cfg?.agents?.defaults?.models ?? {})) {
        const alias = entry?.alias?.trim();
        if (!alias) {
          continue;
        }
        const [rawProvider, ...modelParts] = ref.split("/");
        const provider = expectDefined(rawProvider, `provider in model ref ${ref}`);
        const model = modelParts.join("/");
        byAlias.set(alias.toLowerCase(), {
          alias,
          ref: { provider, model },
        });
        byKey.set(`${provider}/${model}`, [alias]);
      }
      return { byAlias, byKey };
    },
    modelKey: (p: string, m: string) => `${p}/${m}`,
    normalizeModelRef: (p: string, m: string) => ({ provider: normalizeProviderId(p), model: m }),
    normalizeProviderId,
    normalizeProviderIdForAuth: normalizeProviderId,
    parseModelRef: (m: string, p: string) => {
      const slash = m.indexOf("/");
      return slash > 0
        ? { provider: m.slice(0, slash), model: m.slice(slash + 1) }
        : { provider: p, model: m };
    },
    resolveModelRefFromString: ({
      raw,
      defaultProvider,
      aliasIndex,
    }: {
      raw: string;
      defaultProvider: string;
      aliasIndex?: {
        byAlias: Map<string, { alias: string; ref: { provider: string; model: string } }>;
      };
    }) => {
      const aliasMatch = aliasIndex?.byAlias.get(raw.trim().toLowerCase());
      if (aliasMatch) {
        return { ref: aliasMatch.ref, alias: aliasMatch.alias };
      }
      const slash = raw.indexOf("/");
      return {
        ref:
          slash > 0
            ? { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
            : { provider: defaultProvider, model: raw },
      };
    },
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
      const [model, authProfileId] = (modelParts.join("/") || "claude").split("@");
      return { provider, model, ...(authProfileId ? { authProfileId } : {}) };
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
      visibleCatalog: ({
        catalog: catalogLocal,
      }: {
        catalog: Array<{ provider: string; id: string }>;
      }) => catalogLocal,
    };
  },
}));

vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({}),
  resolveProviderIdForAuth: (provider: string) =>
    provider.trim().toLowerCase() === "codex-cli" ? "openai" : provider.trim().toLowerCase(),
}));

vi.mock("../skills/discovery/agent-filter.js", () => ({
  resolveEffectiveAgentSkillFilter: (_cfg: unknown, agentId: string) =>
    state.resolveAgentSkillsFilterMock(_cfg, agentId),
}));

vi.mock("../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: () => ({ eligible: false }),
}));

vi.mock("../skills/runtime/session-snapshot.js", () => ({
  resolveReusableWorkspaceSkillSnapshot: (params: {
    workspaceDir: string;
    existingSnapshot?: { resolvedSkills?: unknown };
    skillFilter?: string[];
  }) => {
    if (params.skillFilter !== undefined && params.skillFilter.length === 0) {
      return {
        snapshot: {
          prompt: "",
          skills: [],
          resolvedSkills: [],
          skillFilter: params.skillFilter,
          version: 0,
        },
        shouldRefresh: !params.existingSnapshot,
        snapshotVersion: 0,
      };
    }
    if (params.existingSnapshot?.resolvedSkills !== undefined) {
      return {
        snapshot: params.existingSnapshot,
        shouldRefresh: false,
        snapshotVersion: 0,
      };
    }
    const rebuilt = state.buildWorkspaceSkillSnapshotMock(params.workspaceDir, params) as {
      resolvedSkills?: unknown;
    };
    return {
      snapshot: params.existingSnapshot
        ? { ...params.existingSnapshot, resolvedSkills: rebuilt?.resolvedSkills }
        : rebuilt,
      shouldRefresh: !params.existingSnapshot,
      snapshotVersion: 0,
    };
  },
}));

vi.mock("./spawned-context.js", () => ({
  normalizeSpawnedRunMetadata: (meta: unknown) => meta ?? {},
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: ({ overrideSeconds }: { overrideSeconds?: number | null }) =>
    typeof overrideSeconds === "number" && Number.isFinite(overrideSeconds)
      ? overrideSeconds === 0
        ? 2_147_483_647
        : Math.max(overrideSeconds * 1000, 1)
      : 30_000,
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
let agentCommandTesting: typeof import("./agent-command.js").testing;

beforeAll(async () => {
  const mod = await import("./agent-command.js");
  agentCommand ??= mod.agentCommand;
  agentCommandTesting ??= mod.testing;
});

type FallbackRunnerParams = {
  provider: string;
  model: string;
  sessionId?: string;
  fallbacksOverride?: string[];
  resolveAgentHarnessRuntimeOverride?: (provider: string, model: string) => string | undefined;
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

function setupSingleAttemptFallback() {
  state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
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
  });
}

function setupSessionTouchStore(): void {
  const sessionEntry: SessionEntry = {
    sessionId: "session-1",
    updatedAt: 1,
    skillsSnapshot: { prompt: "", skills: [], version: 0 },
  };
  state.sessionEntryMock = sessionEntry;
  state.sessionStoreMock = { "agent:main:main": sessionEntry };
  state.storePathMock = "/tmp/openclaw-sessions.json";
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
    delete (state.defaultRuntimeConfig.agents as { list?: unknown }).list;
    state.isThinkingLevelSupportedMock.mockReturnValue(true);
    state.resolveSupportedThinkingLevelMock.mockImplementation(
      ({ level }: { level?: string }) => level,
    );
    state.resolveThinkingDefaultMock.mockReturnValue("low");
    state.resolveAgentSkillsFilterMock.mockReturnValue(undefined);
    state.loadManifestModelCatalogMock.mockReturnValue([]);
    state.hasLegacyAutoFallbackWithoutOriginMock.mockReturnValue(false);
    state.isModelSelectionLockedMock.mockImplementation(
      (entry: unknown) =>
        (entry as { modelSelectionLocked?: boolean } | undefined)?.modelSelectionLocked === true,
    );
    state.applyModelOverrideToSessionEntryMock.mockReturnValue({ updated: false });
    state.repairProviderWrappedModelOverrideMock.mockReturnValue({ updated: false });
    state.resolveAutoFallbackPrimaryProbeMock.mockReturnValue(undefined);
    state.resolveChannelModelOverrideMock.mockImplementation((params: unknown) => {
      const input = params as {
        cfg?: { channels?: { modelByChannel?: Record<string, Record<string, string>> } };
        channel?: string;
        groupId?: string;
        parentSessionKey?: string;
      };
      const channel = input.channel?.trim().toLowerCase();
      const entries = channel ? input.cfg?.channels?.modelByChannel?.[channel] : undefined;
      if (!entries) {
        return null;
      }
      const direct = input.groupId ? entries[input.groupId] : undefined;
      if (direct) {
        return { channel, model: direct, matchKey: input.groupId };
      }
      const parentChannel = input.parentSessionKey?.match(/:channel:([^:]+)/u)?.[1];
      const parent = parentChannel ? entries[parentChannel] : undefined;
      return parent ? { channel, model: parent, matchKey: parentChannel } : null;
    });
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
    state.persistCliTurnTranscriptMock.mockImplementation(
      async (params: { sessionEntry?: unknown }) => ({
        kind: "persisted",
        sessionEntry: params.sessionEntry,
      }),
    );
    state.persistAcpTurnTranscriptMock.mockImplementation(
      async (params: { sessionEntry?: unknown }) => ({
        kind: "persisted",
        sessionEntry: params.sessionEntry,
      }),
    );
    state.runCliTurnCompactionLifecycleMock.mockImplementation(
      async (params: { sessionEntry?: unknown }) => params.sessionEntry,
    );
    state.authProfileStoreMock = { profiles: {} };
    state.sessionEntryMock = undefined;
    state.sessionStoreMock = undefined;
    state.storePathMock = undefined;
    state.resolvedSessionKeyMock = undefined;
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
    state.resolveAgentOutboundTargetMock.mockImplementation(
      (params: { plan?: { resolvedTo?: string }; targetMode?: string }) => ({
        resolvedTarget: null,
        resolvedTo: params.plan?.resolvedTo,
        targetMode: params.targetMode ?? "implicit",
      }),
    );
    state.resolveMessageChannelSelectionMock.mockRejectedValue(new Error("channel required"));
    state.loadSessionEntryMock.mockReset().mockImplementation((params: { sessionKey?: string }) => {
      const sessionKey = params.sessionKey ?? state.resolvedSessionKeyMock ?? "agent:main:main";
      return (state.sessionStoreMock as Record<string, SessionEntry> | undefined)?.[sessionKey];
    });
    state.resolveAgentDeliveryPlanMock.mockImplementation(
      (params: {
        accountId?: string;
        explicitThreadId?: string | number;
        explicitTo?: string;
        requestedChannel?: string;
        sessionEntry?: SessionEntry;
      }) => {
        const context = params.sessionEntry?.deliveryContext;
        const channel =
          params.requestedChannel ??
          context?.channel ??
          params.sessionEntry?.lastChannel ??
          "internal";
        const to = params.explicitTo ?? context?.to ?? params.sessionEntry?.lastTo;
        const accountId =
          params.accountId ?? context?.accountId ?? params.sessionEntry?.lastAccountId;
        const threadId =
          params.explicitThreadId ?? context?.threadId ?? params.sessionEntry?.lastThreadId;
        return {
          baseDelivery: {},
          resolvedChannel: channel,
          resolvedTo: to,
          resolvedAccountId: accountId,
          resolvedThreadId: threadId,
          deliveryTargetMode: params.explicitTo ? "explicit" : to ? "implicit" : undefined,
        };
      },
    );
    state.updateSessionStoreAfterAgentRunMock.mockResolvedValue(undefined);
    state.trajectoryFlushMock.mockResolvedValue(undefined);
    state.prepareInternalSessionEffectsSessionMock.mockResolvedValue({
      agentId: "default",
      sessionId: "internal-session",
      sessionKey: "agent:default:internal-session-effects:run",
      storePath: "/tmp/openclaw-session-store.json",
      sessionFile: "sqlite:default:internal-session:/tmp/openclaw-session-store.json",
      sessionEntry: { sessionId: "internal-session", updatedAt: 1 },
    });
    state.removeInternalSessionEffectsSessionMock.mockResolvedValue(undefined);
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
    expect(secondCall.sessionId).toBe("session-1");

    const lifecycleEndCalls = state.emitAgentEventMock.mock.calls.filter((call: unknown[]) => {
      const arg = call[0] as { stream?: string; data?: { phase?: string } };
      return arg?.stream === "lifecycle" && arg?.data?.phase === "end";
    });
    expect(lifecycleEndCalls.length).toBeGreaterThanOrEqual(1);
    const lifecycleFinishingCalls = state.emitAgentEventMock.mock.calls.filter(
      (call: unknown[]) => {
        const arg = call[0] as { stream?: string; data?: { phase?: string } };
        return arg?.stream === "lifecycle" && arg?.data?.phase === "finishing";
      },
    );
    expect(lifecycleFinishingCalls.length).toBeGreaterThanOrEqual(1);
    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      deferTerminalLifecycle: true,
    });
    const firstFinishingIndex = state.emitAgentEventMock.mock.calls.findIndex((call: unknown[]) => {
      const arg = call[0] as { stream?: string; data?: { phase?: string } };
      return arg?.stream === "lifecycle" && arg?.data?.phase === "finishing";
    });
    const lastEndIndex = state.emitAgentEventMock.mock.calls.findLastIndex((call: unknown[]) => {
      const arg = call[0] as { stream?: string; data?: { phase?: string } };
      return arg?.stream === "lifecycle" && arg?.data?.phase === "end";
    });
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledTimes(1);
    const deliveryOrder = state.deliverAgentCommandResultMock.mock.invocationCallOrder[0] ?? 0;
    expect(
      state.emitAgentEventMock.mock.invocationCallOrder[firstFinishingIndex] ?? 0,
    ).toBeLessThan(deliveryOrder);
    expect(deliveryOrder).toBeLessThan(
      state.emitAgentEventMock.mock.invocationCallOrder[lastEndIndex] ?? 0,
    );
  });

  it("forwards the auth profile bound to the configured default model", async () => {
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude@anthropic:verified" },
          models: { "anthropic/claude": {} },
        },
      },
    };
    state.sessionEntryMock = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      authProfileOverride: "anthropic:stale-auto",
      authProfileOverrideSource: "auto",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude"));

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      providerOverride: "anthropic",
      modelOverride: "claude",
      configuredAuthProfileId: "anthropic:verified",
    });
  });

  it("retries a same-model switch with the runtime carried by the error", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      agentRuntimeOverride: "openclaw",
    };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-sessions.json";
    setupModelSwitchRetry({
      provider: "openai",
      model: "gpt-5.4",
      agentRuntimeOverride: "codex",
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await runBasicAgentCommand();

    const retry = mockCallArg(state.runWithModelFallbackMock, 1) as FallbackRunnerParams;
    expect(retry.resolveAgentHarnessRuntimeOverride?.("openai", "gpt-5.4")).toBe("codex");
    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      agentHarnessRuntimeOverride: "codex",
    });
  });

  it("rejects live model switches for locked sessions without retrying", async () => {
    setupModelSwitchRetry({
      provider: "openai",
      model: "gpt-5.4",
    });
    state.sessionEntryMock = {
      sessionId: "session-1",
      updatedAt: 1,
      modelSelectionLocked: true,
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    state.isModelSelectionLockedMock.mockReturnValue(true);

    await expect(runBasicAgentCommand()).rejects.toMatchObject({
      name: "ModelSelectionLockedError",
      message: "Model selection is locked for this session.",
    });

    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
    expect(state.trajectoryFlushMock).toHaveBeenCalledTimes(1);
  });

  it("pins catalog-adopted direct runs before fallback preflight", async () => {
    setupSingleAttemptFallback();
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          models: state.defaultRuntimeConfig.agents.defaults.models,
          cliBackends: { codex: { command: "codex" } },
        },
      },
    };
    state.sessionEntryMock = {
      sessionId: "session-1",
      updatedAt: 1,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      pluginExtensions: {
        codex: {
          supervision: {
            sourceThreadId: "019f-codex-thread",
            modelLocked: true,
          },
        },
      },
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    state.isModelSelectionLockedMock.mockReturnValue(true);
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude"));

    await runBasicAgentCommand();

    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.resolveAgentHarnessRuntimeOverride?.("anthropic", "claude")).toBe(
      "codex",
    );
    expect(fallbackParams.fallbacksOverride).toEqual([]);
    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      providerOverride: "anthropic",
      modelOverride: "claude",
      agentHarnessRuntimeOverride: "codex",
      sessionEntry: expect.objectContaining({
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      }),
    });
  });

  it("skips legacy override repair when continuing an ordinary locked harness session", async () => {
    setupSingleAttemptFallback();
    state.resolvedSessionKeyMock = "agent:main:plugin-owned";
    state.hasLegacyAutoFallbackWithoutOriginMock.mockReturnValue(true);
    state.sessionEntryMock = {
      sessionId: "session-1",
      updatedAt: 1,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      providerOverride: "openai",
      modelOverride: "stale-fallback-model",
      modelOverrideSource: "auto",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude"));

    await runBasicAgentCommand();

    expect(state.applyModelOverrideToSessionEntryMock).not.toHaveBeenCalled();
    expect(state.repairProviderWrappedModelOverrideMock).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      agentHarnessRuntimeOverride: "codex",
      sessionEntry: expect.objectContaining({
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        providerOverride: "openai",
        modelOverride: "stale-fallback-model",
        modelOverrideSource: "auto",
      }),
    });
  });

  it("keeps the fast mode cutoff timestamp across live model switch retries", async () => {
    let invocation = 0;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      invocation++;
      const result = await params.run(params.provider, params.model);
      if (invocation === 1) {
        throw new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.4",
        });
      }
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await runBasicAgentCommand();

    const firstAttempt = mockCallArg(state.runAgentAttemptMock, 0) as {
      fastModeStartedAtMs?: number;
    };
    const secondAttempt = mockCallArg(state.runAgentAttemptMock, 1) as {
      fastModeStartedAtMs?: number;
    };
    expect(firstAttempt.fastModeStartedAtMs).toBe(secondAttempt.fastModeStartedAtMs);
  });

  it("reuses durable user-turn proof across live model switch retries", async () => {
    let fallbackInvocation = 0;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      fallbackInvocation += 1;
      const result = await params.run(params.provider, params.model);
      if (fallbackInvocation === 1) {
        throw new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.4",
        });
      }
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockImplementation(async (attemptParams: unknown) => {
      const attempt = attemptParams as {
        userTurnTranscriptRecorder?: {
          markRuntimePersisted: (message: { role: "user"; content: string }) => void;
        };
      };
      if (state.runAgentAttemptMock.mock.calls.length === 1) {
        attempt.userTurnTranscriptRecorder?.markRuntimePersisted({
          role: "user",
          content: "hello",
        });
      }
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await runBasicAgentCommand();

    const firstAttempt = mockCallArg(state.runAgentAttemptMock, 0) as {
      suppressPromptPersistenceOnRetry?: boolean;
      userTurnTranscriptRecorder?: unknown;
    };
    const secondAttempt = mockCallArg(state.runAgentAttemptMock, 1) as {
      suppressPromptPersistenceOnRetry?: boolean;
      userTurnTranscriptRecorder?: unknown;
    };
    expect(secondAttempt.userTurnTranscriptRecorder).toBe(firstAttempt.userTurnTranscriptRecorder);
    expect(firstAttempt.suppressPromptPersistenceOnRetry).toBe(false);
    expect(secondAttempt.suppressPromptPersistenceOnRetry).toBe(true);
  });

  it("uses an embedded queue rebound generation for terminal lifecycle and cleanup", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockImplementation(async (attemptParams: unknown) => {
      (
        attemptParams as {
          onLifecycleGenerationChanged?: (lifecycleGeneration: string) => void;
        }
      ).onLifecycleGenerationChanged?.("post-restart-generation");
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await runBasicAgentCommand();

    const lifecycleEnd = state.emitAgentEventMock.mock.calls
      .map(
        (call) =>
          call[0] as {
            stream?: string;
            data?: { phase?: string };
            lifecycleGeneration?: string;
          },
      )
      .find((event) => event.stream === "lifecycle" && event.data?.phase === "end");
    expect(lifecycleEnd?.lifecycleGeneration).toBe("post-restart-generation");
    expect(state.clearAgentRunContextMock).toHaveBeenCalledWith(
      expect.any(String),
      "post-restart-generation",
    );
  });

  it("uses an embedded queue rebound generation for cleanup when the attempt fails", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockImplementation(async (attemptParams: unknown) => {
      (
        attemptParams as {
          onLifecycleGenerationChanged?: (lifecycleGeneration: string) => void;
        }
      ).onLifecycleGenerationChanged?.("post-restart-generation");
      throw new Error("attempt failed after queue rebound");
    });

    await expect(runBasicAgentCommand()).rejects.toThrow("attempt failed after queue rebound");

    expect(state.clearAgentRunContextMock).toHaveBeenCalledWith(
      expect.any(String),
      "post-restart-generation",
    );
  });

  it("preserves restart ownership when an aborted attempt resolves normally", async () => {
    setupSingleAttemptFallback();
    const controller = new AbortController();
    state.runAgentAttemptMock.mockImplementation(async () => {
      controller.abort(createAgentRunRestartAbortError());
      return {
        payloads: [],
        meta: {
          durationMs: 100,
          aborted: true,
          stopReason: "end_turn",
          agentMeta: { provider: "anthropic", model: "claude" },
        },
      };
    });

    await expect(
      agentCommand({
        message: "hello",
        to: "+1234567890",
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("agent run aborted for restart");

    const lifecycleEvents = state.emitAgentEventMock.mock.calls
      .map((call) => call[0] as { stream?: string; data?: Record<string, unknown> })
      .filter((event) => event.stream === "lifecycle");
    expect(lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "error",
            aborted: true,
            stopReason: "restart",
          }),
        }),
      ]),
    );
    expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
  });

  it("preserves restart ownership when an aborted ACP turn resolves normally", async () => {
    state.acpResolveSessionMock.mockReturnValue({
      kind: "ready",
      meta: {
        agent: "claude",
        cwd: "/tmp/workspace",
      },
    });
    const controller = new AbortController();
    controller.abort(createAgentRunRestartAbortError());

    await expect(
      agentCommand({
        message: "hello",
        sessionKey: "agent:main:main",
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("agent run aborted for restart");

    expect(state.emitAcpLifecycleEndMock).not.toHaveBeenCalled();
    expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
  });

  it("suppresses ACP delivery when restart begins during transcript persistence", async () => {
    state.acpResolveSessionMock.mockReturnValue({
      kind: "ready",
      meta: {
        agent: "claude",
        cwd: "/tmp/workspace",
      },
    });
    const controller = new AbortController();
    state.persistAcpTurnTranscriptMock.mockImplementation(
      async (params: { sessionEntry?: unknown }) => {
        controller.abort(createAgentRunRestartAbortError());
        return { kind: "persisted", sessionEntry: params.sessionEntry };
      },
    );

    await expect(
      agentCommand({
        message: "hello",
        sessionKey: "agent:main:main",
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("agent run aborted for restart");

    expect(state.emitAcpLifecycleEndMock).not.toHaveBeenCalled();
    expect(state.emitAcpLifecycleErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "session-1",
        sessionKey: "agent:main:main",
      }),
    );
    const lifecycleError = state.emitAcpLifecycleErrorMock.mock.calls[0]?.[0] as
      | { abortSignal?: AbortSignal }
      | undefined;
    expect(lifecycleError?.abortSignal?.aborted).toBe(true);
    expect(lifecycleError?.abortSignal?.reason).toBe(controller.signal.reason);
    expect(state.persistAcpTurnTranscriptMock).toHaveBeenCalledTimes(1);
    expect(state.buildAcpResultMock).not.toHaveBeenCalled();
    expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
  });

  it("threads lifecycle ownership into ACP delivery", async () => {
    state.acpResolveSessionMock.mockReturnValue({
      kind: "ready",
      meta: {
        agent: "claude",
        cwd: "/tmp/workspace",
      },
    });

    await agentCommand({
      message: "hello",
      sessionKey: "agent:main:main",
    });

    const deliveryParams = requireRecord(
      mockCallArg(state.deliverAgentCommandResultMock),
      "ACP delivery params",
    );
    expect(deliveryParams.assertDeliveryCurrent).toBeTypeOf("function");
    (deliveryParams.assertDeliveryCurrent as () => void)();
    expect(state.assertLifecycleCurrentMock).toHaveBeenLastCalledWith("test-generation");
  });

  it("persists structured transcript media for ACP turns", async () => {
    state.acpResolveSessionMock.mockReturnValue({
      kind: "ready",
      meta: {
        agent: "claude",
        cwd: "/tmp/workspace",
      },
    });

    await agentCommand({
      message: "[media attached: media://inbound/image-1]",
      transcriptMessage: "",
      transcriptMedia: [{ path: "/media/inbound/image-1.png", contentType: "image/png" }],
      sessionKey: "agent:main:main",
    });

    expect(state.persistAcpTurnTranscriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptBody: "",
        userInput: {
          text: "",
          media: [{ path: "/media/inbound/image-1.png", contentType: "image/png" }],
          mediaOnlyText: "[User sent media without caption]",
        },
      }),
    );
  });

  it("keeps the initial session touch for local runs", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    setupSessionTouchStore();

    await runBasicAgentCommand();

    const touchWrites = state.persistSessionEntryMock.mock.calls.filter((call) => {
      const entry = (call[0] as { entry?: Record<string, unknown> } | undefined)?.entry;
      return entry?.lastInteractionAt !== undefined;
    });
    expect(touchWrites).toHaveLength(1);
    expect(state.updateSessionStoreAfterAgentRunMock).toHaveBeenCalledTimes(1);
  });

  it("threads lifecycle ownership into normal delivery", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    setupSessionTouchStore();

    await runBasicAgentCommand();

    const deliveryParams = requireRecord(
      mockCallArg(state.deliverAgentCommandResultMock),
      "delivery params",
    );
    expect(deliveryParams.assertDeliveryCurrent).toBeTypeOf("function");
    (deliveryParams.assertDeliveryCurrent as () => void)();
    expect(state.assertLifecycleCurrentMock).toHaveBeenLastCalledWith("test-generation");
  });

  it("passes explicit timeout overrides into agent attempts", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      timeout: "600",
    });

    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      timeoutMs: 600_000,
      runTimeoutOverrideMs: 600_000,
    });
  });

  it("clamps unsupported explicit thinking for subagent spawns instead of throwing", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude-fable-5"));
    state.resolvedSessionKeyMock = "agent:planner:subagent:00000000-0000-4000-8000-000000000000";
    state.isThinkingLevelSupportedMock.mockReturnValue(false);
    state.resolveSupportedThinkingLevelMock.mockReturnValue("high");

    await agentCommand({
      message: "hello",
      sessionKey: state.resolvedSessionKeyMock,
      thinking: "xhigh",
      lane: "subagent",
    });

    expect(state.resolveSupportedThinkingLevelMock).toHaveBeenCalled();
    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      resolvedThinkLevel: "high",
    });
  });

  it("rejects unsupported explicit thinking for interactive subagent-key runs", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude-fable-5"));
    state.resolvedSessionKeyMock = "agent:planner:subagent:00000000-0000-4000-8000-000000000000";
    state.isThinkingLevelSupportedMock.mockReturnValue(false);

    await expect(
      agentCommand({
        message: "hello",
        sessionKey: state.resolvedSessionKeyMock,
        thinking: "xhigh",
      }),
    ).rejects.toThrow(/is not supported/u);
    expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported explicit thinking for non-subagent sessions on the subagent lane", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude-fable-5"));
    state.resolvedSessionKeyMock = "agent:main:main";
    state.isThinkingLevelSupportedMock.mockReturnValue(false);

    await expect(
      agentCommand({
        message: "hello",
        sessionKey: state.resolvedSessionKeyMock,
        thinking: "xhigh",
        lane: "subagent",
      }),
    ).rejects.toThrow(/is not supported/u);
    expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported explicit thinking for direct interactive runs", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude-fable-5"));
    state.resolvedSessionKeyMock = "agent:main:main";
    state.isThinkingLevelSupportedMock.mockReturnValue(false);
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
      thinkingLevel: "low",
    };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-sessions.json";

    await expect(
      agentCommand({
        message: "hello",
        to: "+1234567890",
        thinking: "ultra",
      }),
    ).rejects.toThrow(/is not supported/u);
    expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
    expect(
      (state.sessionStoreMock as Record<string, SessionEntry>)["agent:main:main"]?.thinkingLevel,
    ).toBe("low");
    expect(state.persistSessionEntryMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ thinkingLevel: "ultra" }),
      }),
    );
  });

  it("skips the initial session touch after gateway ingress already persisted activity", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    setupSessionTouchStore();

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      skipInitialSessionTouch: true,
    });

    const touchWrites = state.persistSessionEntryMock.mock.calls.filter((call) => {
      const entry = (call[0] as { entry?: Record<string, unknown> } | undefined)?.entry;
      return entry?.lastInteractionAt !== undefined;
    });
    expect(touchWrites).toHaveLength(0);
    expect(state.updateSessionStoreAfterAgentRunMock).toHaveBeenCalledTimes(1);
  });

  it("uses channel model override as the initial run model for channel-backed sessions", async () => {
    setupSingleAttemptFallback();
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: "anthropic/default-model",
          models: {
            "anthropic/default-model": {},
            "openai/channel-model": {},
          },
        },
      },
      channels: {
        modelByChannel: {
          discord: {
            "channel-123": "openai/channel-model",
          },
        },
      },
    };
    state.sessionEntryMock = {
      sessionId: "session-1",
      updatedAt: 1,
      channel: "discord",
      groupId: "channel-123",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "channel-model"));

    await runBasicAgentCommand();

    expect(mockCallArg(state.resolveChannelModelOverrideMock)).toMatchObject({
      channel: "discord",
      groupId: "channel-123",
    });
    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.provider).toBe("openai");
    expect(fallbackParams.model).toBe("channel-model");
    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      providerOverride: "openai",
      modelOverride: "channel-model",
    });
  });

  it("uses current run channel context when persisted session metadata is absent", async () => {
    setupSingleAttemptFallback();
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: "anthropic/default-model",
          models: {
            "anthropic/default-model": {},
            "openai/channel-model": {},
          },
        },
      },
      channels: {
        modelByChannel: {
          discord: {
            "channel-123": "openai/channel-model",
          },
        },
      },
    };
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "channel-model"));

    await agentCommand({
      message: "hello",
      channel: "discord",
      groupId: "channel-123",
      to: "discord:channel:channel-123",
    });

    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.provider).toBe("openai");
    expect(fallbackParams.model).toBe("channel-model");
  });

  it("keeps persisted channel model override when current run context is internal", async () => {
    setupSingleAttemptFallback();
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: "anthropic/default-model",
          models: {
            "anthropic/default-model": {},
            "openai/channel-model": {},
          },
        },
      },
      channels: {
        modelByChannel: {
          discord: {
            "channel-123": "openai/channel-model",
          },
        },
      },
    };
    state.sessionEntryMock = {
      sessionId: "session-1",
      updatedAt: 1,
      channel: "discord",
      groupId: "channel-123",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "channel-model"));

    await agentCommand({
      message: "hello",
      channel: "internal",
      messageChannel: "internal",
      to: "internal",
    });

    expect(mockCallArg(state.resolveChannelModelOverrideMock)).toMatchObject({
      channel: "discord",
      groupId: "channel-123",
    });
    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.provider).toBe("openai");
    expect(fallbackParams.model).toBe("channel-model");
  });

  it("uses channel model override after ignoring stale legacy fallback overrides", async () => {
    setupSingleAttemptFallback();
    state.hasLegacyAutoFallbackWithoutOriginMock.mockReturnValue(true);
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: "anthropic/default-model",
          models: {
            "anthropic/default-model": {},
            "openai/channel-model": {},
          },
        },
      },
      channels: {
        modelByChannel: {
          discord: {
            "channel-123": "openai/channel-model",
          },
        },
      },
    };
    state.sessionEntryMock = {
      sessionId: "session-1",
      updatedAt: 1,
      channel: "discord",
      groupId: "channel-123",
      providerOverride: "anthropic",
      modelOverride: "stale-fallback-model",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "channel-model"));

    await runBasicAgentCommand();

    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.provider).toBe("openai");
    expect(fallbackParams.model).toBe("channel-model");
  });

  it("uses a concurrent user override adopted during legacy fallback repair", async () => {
    setupSingleAttemptFallback();
    state.applyModelOverrideToSessionEntryMock.mockImplementation((params: unknown) => {
      const { entry } = params as { entry: SessionEntry };
      delete entry.providerOverride;
      delete entry.modelOverride;
      delete entry.modelOverrideSource;
      return { updated: true };
    });
    state.hasLegacyAutoFallbackWithoutOriginMock.mockImplementation(
      (entry: unknown) =>
        (entry as SessionEntry | undefined)?.modelOverride === "stale-fallback-model",
    );
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: "anthropic/default-model",
          models: {
            "anthropic/default-model": {},
            "anthropic/stale-fallback-model": {},
            "google/gemini-3-pro": {},
          },
        },
      },
    };
    const sessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      providerOverride: "anthropic",
      modelOverride: "stale-fallback-model",
      modelOverrideSource: "auto",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    } satisfies SessionEntry;
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-session-store.json";
    state.persistSessionEntryMock.mockImplementation(async (...args: unknown[]) => {
      const params = args[0] as { entry?: SessionEntry };
      if (params.entry?.modelOverride === "stale-fallback-model") {
        return params.entry;
      }
      return {
        ...sessionEntry,
        updatedAt: 2,
        providerOverride: "google",
        modelOverride: "gemini-3-pro",
        modelOverrideSource: "user",
      };
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("google", "gemini-3-pro"));

    await runBasicAgentCommand();

    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.provider).toBe("google");
    expect(fallbackParams.model).toBe("gemini-3-pro");
  });

  it("probes the channel primary when a session is pinned to an auto fallback", async () => {
    setupSingleAttemptFallback();
    state.resolveAutoFallbackPrimaryProbeMock.mockReturnValue({
      provider: "openai",
      model: "channel-model",
      fallbackProvider: "anthropic",
      fallbackModel: "fallback-model",
    });
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: "anthropic/default-model",
          models: {
            "anthropic/default-model": {},
            "anthropic/fallback-model": {},
            "openai/channel-model": {},
          },
        },
      },
      channels: {
        modelByChannel: {
          discord: {
            "channel-123": "openai/channel-model",
          },
        },
      },
    };
    state.sessionEntryMock = {
      sessionId: "session-1",
      updatedAt: 1,
      channel: "discord",
      groupId: "channel-123",
      providerOverride: "anthropic",
      modelOverride: "fallback-model",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "openai",
      modelOverrideFallbackOriginModel: "channel-model",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "channel-model"));

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.resolveAutoFallbackPrimaryProbeMock), {
      primaryProvider: "openai",
      primaryModel: "channel-model",
    });
    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.provider).toBe("openai");
    expect(fallbackParams.model).toBe("channel-model");
  });

  it("uses current threaded session key for parent channel model overrides", async () => {
    setupSingleAttemptFallback();
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: "anthropic/default-model",
          models: {
            "anthropic/default-model": {},
            "openai/parent-channel-model": {},
          },
        },
      },
      channels: {
        modelByChannel: {
          slack: {
            general: "openai/parent-channel-model",
          },
        },
      },
    };
    state.resolvedSessionKeyMock = "agent:main:slack:channel:general:thread:thread-1";
    state.sessionEntryMock = {
      sessionId: "session-1",
      updatedAt: 1,
      channel: "slack",
      groupId: "thread-1",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    state.runAgentAttemptMock.mockResolvedValue(
      makeSuccessResult("openai", "parent-channel-model"),
    );

    await runBasicAgentCommand();

    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.provider).toBe("openai");
    expect(fallbackParams.model).toBe("parent-channel-model");
  });

  it("keeps stored session model overrides ahead of channel model overrides", async () => {
    setupSingleAttemptFallback();
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: "anthropic/default-model",
          models: {
            "anthropic/default-model": {},
            "openai/channel-model": {},
            "anthropic/stored-model": {},
          },
        },
      },
      channels: {
        modelByChannel: {
          discord: {
            "channel-123": "openai/channel-model",
          },
        },
      },
    };
    state.sessionEntryMock = {
      sessionId: "session-1",
      updatedAt: 1,
      channel: "discord",
      groupId: "channel-123",
      providerOverride: "anthropic",
      modelOverride: "stored-model",
      modelOverrideSource: "user",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "stored-model"));

    await runBasicAgentCommand();

    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.provider).toBe("anthropic");
    expect(fallbackParams.model).toBe("stored-model");
  });

  it("keeps explicit run model overrides ahead of channel model overrides", async () => {
    setupSingleAttemptFallback();
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: "anthropic/default-model",
          models: {
            "anthropic/default-model": {},
            "openai/channel-model": {},
            "openai/explicit-model": {},
          },
        },
      },
      channels: {
        modelByChannel: {
          discord: {
            "channel-123": "openai/channel-model",
          },
        },
      },
    };
    state.sessionEntryMock = {
      sessionId: "session-1",
      updatedAt: 1,
      channel: "discord",
      groupId: "channel-123",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "explicit-model"));

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      model: "openai/explicit-model",
      allowModelOverride: true,
    });

    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.provider).toBe("openai");
    expect(fallbackParams.model).toBe("explicit-model");
  });

  it("uses rotated session identity for all post-run session persistence", async () => {
    setupSingleAttemptFallback();
    setupSessionTouchStore();
    const rotatedEntry: SessionEntry = {
      sessionId: "rotated-session",
      sessionFile: "/tmp/rotated-session.jsonl",
      updatedAt: 2,
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    const result = makeSuccessResult("openai", "gpt-5.4") as ReturnType<
      typeof makeSuccessResult
    > & {
      meta: Record<string, unknown> & { agentMeta: Record<string, unknown> };
    };
    result.meta.executionTrace = {
      runner: "embedded",
      fallbackUsed: false,
      winnerProvider: "openai",
      winnerModel: "gpt-5.4",
    };
    result.meta.finalAssistantVisibleText = "ok";
    result.meta.agentMeta = {
      ...result.meta.agentMeta,
      sessionId: "rotated-session",
      sessionFile: "/tmp/rotated-session.jsonl",
    };
    state.runAgentAttemptMock.mockResolvedValue(result);
    state.updateSessionStoreAfterAgentRunMock.mockImplementation(async () => {
      state.sessionStoreMock = { "agent:main:main": rotatedEntry };
    });
    state.persistCliTurnTranscriptMock.mockResolvedValue({
      kind: "persisted",
      sessionEntry: rotatedEntry,
    });
    state.runCliTurnCompactionLifecycleMock.mockResolvedValue(rotatedEntry);

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.updateSessionStoreAfterAgentRunMock), {
      sessionId: "rotated-session",
    });
    expectRecordFields(mockCallArg(state.persistCliTurnTranscriptMock), {
      sessionId: "rotated-session",
      sessionKey: "agent:main:main",
    });
    expectRecordFields(mockCallArg(state.runCliTurnCompactionLifecycleMock), {
      sessionId: "rotated-session",
      sessionKey: "agent:main:main",
    });
    expectRecordFields(mockCallArg(state.deliverAgentCommandResultMock), {
      expectedSessionIdForFreshDelivery: "rotated-session",
    });
  });

  it("skips post-run persistence after the session is deleted", async () => {
    setupSingleAttemptFallback();
    setupSessionTouchStore();
    const result = makeSuccessResult("openai", "gpt-5.4") as ReturnType<
      typeof makeSuccessResult
    > & {
      meta: Record<string, unknown> & { executionTrace: Record<string, unknown> };
    };
    result.meta.executionTrace = {
      runner: "cli",
      fallbackUsed: false,
      winnerProvider: "openai",
      winnerModel: "gpt-5.4",
    };
    state.runAgentAttemptMock.mockResolvedValue(result);
    state.persistCliTurnTranscriptMock.mockResolvedValue({
      kind: "session-rebound",
      sessionEntry: undefined,
    });

    await runBasicAgentCommand();

    expect(state.persistCliTurnTranscriptMock).toHaveBeenCalledTimes(1);
    expect(state.runCliTurnCompactionLifecycleMock).not.toHaveBeenCalled();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledTimes(1);
  });

  it("preserves restart recovery ownership when delivery fails after a session rebound", async () => {
    setupSingleAttemptFallback();
    setupSessionTouchStore();
    const sessionStore = state.sessionStoreMock as Record<string, SessionEntry>;
    const claimedEntry = expectDefined(
      sessionStore["agent:main:main"],
      "preclaimed restart recovery session",
    );
    claimedEntry.restartRecoveryDeliveryRunId = "session-1";
    claimedEntry.restartRecoveryDeliveryContext = {
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
    };
    const result = makeSuccessResult("openai", "gpt-5.4") as ReturnType<
      typeof makeSuccessResult
    > & {
      meta: Record<string, unknown> & { executionTrace: Record<string, unknown> };
    };
    result.meta.executionTrace = {
      runner: "cli",
      fallbackUsed: false,
      winnerProvider: "openai",
      winnerModel: "gpt-5.4",
    };
    state.runAgentAttemptMock.mockResolvedValue(result);
    state.persistCliTurnTranscriptMock.mockResolvedValue({
      kind: "session-rebound",
      sessionEntry: undefined,
    });
    state.deliverAgentCommandResultMock.mockRejectedValue(new Error("delivery failed"));

    await expect(
      agentCommand({
        message: "hello",
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
        deliver: true,
      }),
    ).rejects.toThrow("delivery failed");

    expect(sessionStore["agent:main:main"]?.restartRecoveryDeliveryRunId).toBe("session-1");
  });

  it("persists only the CLI assistant reply after the runner persists the current user turn", async () => {
    type AttemptCall = {
      onUserMessagePersisted?: () => void;
    };
    setupSingleAttemptFallback();
    setupSessionTouchStore();
    const result = makeSuccessResult("openai", "gpt-5.4") as ReturnType<
      typeof makeSuccessResult
    > & {
      meta: Record<string, unknown> & { executionTrace: Record<string, unknown> };
    };
    result.meta.executionTrace = {
      runner: "cli",
      fallbackUsed: false,
      winnerProvider: "openai",
      winnerModel: "gpt-5.4",
    };
    state.runAgentAttemptMock.mockImplementation(async (attemptParams: AttemptCall) => {
      attemptParams.onUserMessagePersisted?.();
      return result;
    });
    state.persistCliTurnTranscriptMock.mockResolvedValue({
      kind: "persisted",
      sessionEntry: state.sessionEntryMock,
    });

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      userTurnTranscriptRecorder: {} as NonNullable<
        Parameters<typeof agentCommand>[0]["userTurnTranscriptRecorder"]
      >,
    });

    expectRecordFields(mockCallArg(state.persistCliTurnTranscriptMock), {
      embeddedAssistantGapFill: false,
    });
  });

  it("persists the full embedded turn when no canonical user recorder exists", async () => {
    type AttemptCall = {
      onUserMessagePersisted?: () => void;
    };
    setupSingleAttemptFallback();
    setupSessionTouchStore();
    const result = makeSuccessResult("openai", "gpt-5.4") as ReturnType<
      typeof makeSuccessResult
    > & {
      meta: Record<string, unknown> & { executionTrace: Record<string, unknown> };
    };
    result.meta.executionTrace = {
      runner: "embedded",
      fallbackUsed: false,
      winnerProvider: "openai",
      winnerModel: "gpt-5.4",
    };
    state.runAgentAttemptMock.mockImplementation(async (attemptParams: AttemptCall) => {
      attemptParams.onUserMessagePersisted?.();
      return result;
    });
    state.persistCliTurnTranscriptMock.mockResolvedValue({
      kind: "persisted",
      sessionEntry: state.sessionEntryMock,
    });

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.persistCliTurnTranscriptMock), {
      embeddedAssistantGapFill: true,
    });
  });

  it("does not treat backend CLI session id as OpenClaw session identity", async () => {
    setupSingleAttemptFallback();
    setupSessionTouchStore();
    const result = makeSuccessResult("openai", "gpt-5.4") as ReturnType<
      typeof makeSuccessResult
    > & {
      meta: Record<string, unknown> & { agentMeta: Record<string, unknown> };
    };
    result.meta.agentMeta = {
      ...result.meta.agentMeta,
      sessionId: "backend-cli-session",
    };
    state.runAgentAttemptMock.mockResolvedValue(result);

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.updateSessionStoreAfterAgentRunMock), {
      sessionId: "session-1",
    });
    expectRecordFields(mockCallArg(state.deliverAgentCommandResultMock), {
      expectedSessionIdForFreshDelivery: "session-1",
    });
  });

  it("scopes explicit-agent sentinel store keys before command routing", () => {
    expect(
      agentCommandTesting.resolveExplicitAgentCommandSessionKey({
        rawExplicitSessionKey: "global",
        agentIdOverride: "work",
        cfg: {},
      }),
    ).toBe("agent:work:global");
    expect(
      agentCommandTesting.resolveExplicitAgentCommandSessionKey({
        rawExplicitSessionKey: "main",
        agentIdOverride: "work",
        cfg: {},
      }),
    ).toBe("agent:work:main");
  });

  it("persists explicit overrides even when ingress skips the initial touch", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    setupSessionTouchStore();

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      thinking: "medium",
      skipInitialSessionTouch: true,
    });

    const touchWrite = state.persistSessionEntryMock.mock.calls.find((call) => {
      const entry = (call[0] as { entry?: Record<string, unknown> } | undefined)?.entry;
      return entry?.thinkingLevel === "medium";
    })?.[0] as { entry?: Record<string, unknown> } | undefined;
    expect(touchWrite?.entry?.lastInteractionAt).toBeDefined();
    expect(state.updateSessionStoreAfterAgentRunMock).toHaveBeenCalledTimes(1);
  });

  it("forwards an explicit OpenClaw runtime override into fallback and attempt execution", async () => {
    setupSingleAttemptFallback();
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: { "openai/gpt-5.4": {} },
        },
      },
    };
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
      agentRuntimeOverride: "openclaw",
      agentHarnessId: "codex",
    };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-sessions.json";
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await runBasicAgentCommand();

    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.resolveAgentHarnessRuntimeOverride?.("openai", "gpt-5.4")).toBe(
      "openclaw",
    );
    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      agentHarnessRuntimeOverride: "openclaw",
    });
  });

  it("does not persist turn-local thinking fallback over a stored session override", async () => {
    setupSingleAttemptFallback();
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
      thinkingLevel: "high",
    };
    const sessionStore: Record<string, SessionEntry> = { "agent:main:main": sessionEntry };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = sessionStore;
    state.storePathMock = "/tmp/openclaw-sessions.json";
    state.isThinkingLevelSupportedMock.mockReturnValue(false);
    state.resolveSupportedThinkingLevelMock.mockReturnValue("off");
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      resolvedThinkLevel: "off",
    });
    expect(sessionEntry.thinkingLevel).toBe("high");
    expect(sessionStore["agent:main:main"]?.thinkingLevel).toBe("high");
    expect(state.persistSessionEntryMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ thinkingLevel: "off" }),
      }),
    );
  });

  it("revalidates immutable Ultra for each model fallback without persisting the remap", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
      thinkingLevel: "ultra",
    };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-sessions.json";
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-luna" },
          models: {
            "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
            "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
          },
        },
      },
    };
    state.isThinkingLevelSupportedMock.mockImplementation((args: unknown) => {
      const { model, level } = args as { model?: string; level?: string };
      return model !== "gpt-5.6-luna" || level !== "ultra";
    });
    state.resolveSupportedThinkingLevelMock.mockImplementation(
      ({ level, model }: { level?: string; model?: string }) =>
        model === "gpt-5.6-luna" && level === "ultra" ? "max" : level,
    );
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      await params.run(params.provider, params.model);
      const result = await params.run("openai", "gpt-5.6-sol");
      return {
        result,
        provider: "openai",
        model: "gpt-5.6-sol",
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockImplementation(
      async (params: { providerOverride: string; modelOverride: string }) =>
        makeSuccessResult(params.providerOverride, params.modelOverride),
    );

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.runAgentAttemptMock, 0), {
      modelOverride: "gpt-5.6-luna",
      resolvedThinkLevel: "max",
    });
    expectRecordFields(mockCallArg(state.runAgentAttemptMock, 1), {
      modelOverride: "gpt-5.6-sol",
      resolvedThinkLevel: "ultra",
    });
    expect(state.resolveSupportedThinkingLevelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.6-luna",
        level: "ultra",
        agentRuntime: "codex",
      }),
    );
    expect(sessionEntry.thinkingLevel).toBe("ultra");
    expect(state.persistSessionEntryMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ thinkingLevel: "max" }),
      }),
    );
  });

  it("recomputes a model-derived thinking default for each fallback candidate", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-sessions.json";
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: {
            "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
            "openai/gpt-5.6-terra": { agentRuntime: { id: "codex" } },
          },
        },
      },
    };
    state.resolveThinkingDefaultMock.mockImplementation((args: unknown) => {
      const { model } = args as { model?: string };
      return model === "gpt-5.6-terra" ? "medium" : "low";
    });
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      await params.run(params.provider, params.model);
      const result = await params.run("openai", "gpt-5.6-terra");
      return {
        result,
        provider: "openai",
        model: "gpt-5.6-terra",
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockImplementation(
      async (params: { providerOverride: string; modelOverride: string }) =>
        makeSuccessResult(params.providerOverride, params.modelOverride),
    );

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.runAgentAttemptMock, 0), {
      modelOverride: "gpt-5.6-sol",
      resolvedThinkLevel: "low",
    });
    expectRecordFields(mockCallArg(state.runAgentAttemptMock, 1), {
      modelOverride: "gpt-5.6-terra",
      resolvedThinkLevel: "medium",
    });
  });

  it("persists and clears current run delivery context for restart recovery", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
    };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-sessions.json";
    state.deliverAgentCommandResultMock.mockResolvedValue({ deliverySucceeded: true });

    await agentCommand({
      message: "hello",
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      threadId: "reply-1",
      deliver: true,
    });

    const persistedContexts = state.persistSessionEntryMock.mock.calls.map((call) => {
      const params = call[0] as { entry?: SessionEntry };
      return params.entry?.restartRecoveryDeliveryContext;
    });
    expect(persistedContexts).toContainEqual({
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      threadId: "reply-1",
    });
    const cleanupParams = state.persistSessionEntryMock.mock.calls.at(-1)?.[0] as
      | { sessionStore?: Record<string, SessionEntry> }
      | undefined;
    const stored = cleanupParams?.sessionStore?.["agent:main:main"];
    expect(stored?.restartRecoveryDeliveryContext).toBeUndefined();
  });

  it("records generated-media delivery runs as durable terminal sources", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
    };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-sessions.json";
    state.deliverAgentCommandResultMock.mockImplementation(async (params: unknown) => {
      const onDeliveryResult = (params as { onDeliveryResult?: (result: unknown) => void })
        .onDeliveryResult;
      const deliveryResult = {
        payloads: [{ isReasoning: true }, { text: "ready", mediaUrls: ["/tmp/payload.png"] }],
        meta: {},
        deliverySucceeded: true,
        deliveryStatus: {
          status: "partial_failed",
          payloadOutcomes: [
            { index: 0, status: "suppressed" },
            { index: 1, status: "failed", sentBeforeError: false },
          ],
        },
        messagingToolSentTargets: [
          {
            provider: "discord",
            to: "discord:dm:123",
            threadId: 42,
            mediaUrls: ["/tmp/proof.png"],
          },
        ],
      };
      onDeliveryResult?.(deliveryResult);
      return deliveryResult;
    });

    await agentCommand({
      message: "generated image ready",
      channel: "discord",
      to: "discord:dm:123",
      deliver: false,
      runId: "image:task-1:agent-loop",
      sourceReplyDeliveryMode: "automatic",
      disableMessageTool: true,
      forceRestartSafeTools: true,
      internalDeliveryMediaUrls: ["/tmp/payload.png"],
      inputProvenance: {
        kind: "inter_session",
        sourceChannel: "webchat",
        sourceTool: "image_generate",
      },
    });

    const persistedSourceRunIds = state.persistSessionEntryMock.mock.calls.map((call) => {
      const params = call[0] as { entry?: SessionEntry };
      return params.entry?.restartRecoveryDeliverySourceRunId;
    });
    expect(persistedSourceRunIds).toContain("image:task-1:agent-loop");
    expect(
      state.persistSessionEntryMock.mock.calls.some((call) => {
        const params = call[0] as { entry?: SessionEntry };
        return params.entry?.restartRecoverySourceReplyDeliveryMode === "automatic";
      }),
    ).toBe(true);
    const cleanupParams = state.persistSessionEntryMock.mock.calls.at(-1)?.[0] as
      | { sessionStore?: Record<string, SessionEntry> }
      | undefined;
    const stored = cleanupParams?.sessionStore?.["agent:main:main"];
    expect(stored?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(stored?.restartRecoverySourceReplyDeliveryMode).toBeUndefined();
    expect(stored?.restartRecoveryTerminalRunIds).toEqual(["image:task-1:agent-loop"]);
    expect(stored?.restartRecoveryTerminalDeliveryEvidence).toEqual([
      {
        runId: "image:task-1:agent-loop",
        captured: true,
        payloads: [{ visible: false }, { mediaUrls: ["/tmp/payload.png"], visible: true }],
        deliveryStatus: {
          status: "partial_failed",
          payloadOutcomes: [
            { index: 0, status: "suppressed" },
            { index: 1, status: "failed", sentBeforeError: false },
          ],
        },
        messagingToolSentTargets: [
          {
            provider: "discord",
            to: "discord:dm:123",
            threadId: "42",
            mediaUrls: ["/tmp/proof.png"],
            visible: true,
          },
        ],
        restartUnsafeSideEffectsDetected: true,
      },
    ]);
  });

  it("does not make an unconstrained message-tool completion replayable", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
    };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-sessions.json";

    await agentCommand({
      message: "generated image ready",
      sessionKey: "agent:main:main",
      deliver: false,
      runId: "image:unsafe-message-tool:agent-loop",
      sourceReplyDeliveryMode: "message_tool_only",
      inputProvenance: {
        kind: "inter_session",
        sourceChannel: "webchat",
        sourceTool: "image_generate",
      },
    });

    expect(
      state.persistSessionEntryMock.mock.calls.some((call) => {
        const params = call[0] as { entry?: SessionEntry };
        return params.entry?.restartRecoveryDeliverySourceRunId !== undefined;
      }),
    ).toBe(false);
  });

  it("constrains recovery delivery to host-owned media before persistence and send", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue({
      ...makeSuccessResult("openai", "gpt-5.4"),
      payloads: [{ text: "ready", mediaUrls: ["/tmp/already-delivered.png"] }],
    });

    await agentCommand({
      message: "deliver only missing generated media",
      channel: "discord",
      to: "channel:123",
      deliver: true,
      sourceReplyDeliveryMode: "automatic",
      disableMessageTool: true,
      forceRestartSafeTools: true,
      internalDeliveryMediaUrls: ["/tmp/missing.png"],
      runId: "image:task-policy:agent-loop",
      inputProvenance: {
        kind: "inter_session",
        sourceChannel: "webchat",
        sourceTool: "image_generate",
      },
    });

    const deliveryParams = requireRecord(
      mockCallArg(state.deliverAgentCommandResultMock),
      "delivery params",
    );
    expect(requireRecord(deliveryParams.result, "delivery result").payloads).toEqual([
      { text: "ready" },
      { mediaUrls: ["/tmp/missing.png"], trustedLocalMedia: true },
    ]);
    expect(deliveryParams.payloads).toEqual([
      { text: "ready" },
      { mediaUrls: ["/tmp/missing.png"], trustedLocalMedia: true },
    ]);
    expect(
      state.persistSessionEntryMock.mock.calls.some((call) => {
        const params = call[0] as { entry?: SessionEntry };
        return (
          params.entry?.restartRecoveryDeliveryMediaUrls?.[0] === "/tmp/missing.png" &&
          params.entry.restartRecoveryDisableMessageTool === true &&
          params.entry.restartRecoveryForceSafeTools === true
        );
      }),
    ).toBe(true);
  });

  it("restores the exact generated-media policy for a preclaimed recovery run", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue({
      ...makeSuccessResult("openai", "gpt-5.4"),
      payloads: [{ text: "ready", mediaUrls: ["/tmp/model-selected.png"] }],
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "image:task-policy:agent-loop",
      restartRecoveryDeliveryContext: { channel: "discord", to: "channel:123" },
      restartRecoveryDeliveryMediaUrls: ["/tmp/missing.png"],
      restartRecoveryDisableMessageTool: true,
      restartRecoverySuppressTextDelivery: true,
      restartRecoverySourceReplyDeliveryMode: "automatic",
      restartRecoveryForceSafeTools: true,
    };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-sessions.json";

    await agentCommand({
      message: "continue generated media delivery",
      sessionKey: "agent:main:main",
      channel: "discord",
      to: "channel:123",
      deliver: true,
      runId: "recovery-run",
    });

    const deliveryParams = requireRecord(
      mockCallArg(state.deliverAgentCommandResultMock),
      "delivery params",
    );
    expect(requireRecord(deliveryParams.result, "delivery result").payloads).toEqual([
      { mediaUrls: ["/tmp/missing.png"], trustedLocalMedia: true },
    ]);
    const persistedPolicies = state.persistSessionEntryMock.mock.calls.map((call) => {
      const params = call[0] as { entry?: SessionEntry };
      return {
        mediaUrls: params.entry?.restartRecoveryDeliveryMediaUrls,
        disableMessageTool: params.entry?.restartRecoveryDisableMessageTool,
        forceSafeTools: params.entry?.restartRecoveryForceSafeTools,
        suppressText: params.entry?.restartRecoverySuppressTextDelivery,
      };
    });
    expect(persistedPolicies).toContainEqual({
      mediaUrls: undefined,
      disableMessageTool: undefined,
      forceSafeTools: undefined,
      suppressText: undefined,
    });
  });

  it("rejects host-owned media constraints without the scoped recovery policy", async () => {
    await expect(
      agentCommand({
        message: "unsafe delivery constraint",
        sessionKey: "agent:main:main",
        internalDeliveryMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow(
      "internal delivery media constraints require automatic delivery with restart-safe tools and no message tool",
    );

    expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
  });

  it("retains and clears a preclaimed transcript-only recovery run", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      updatedAt: 1,
    };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-sessions.json";

    await agentCommand({
      message: "continue after restart",
      sessionKey: "agent:main:main",
      deliver: false,
      runId: "recovery-run",
    });

    const persistedClaims = state.persistSessionEntryMock.mock.calls.map((call) => {
      const params = call[0] as { entry?: SessionEntry };
      return {
        context: params.entry?.restartRecoveryDeliveryContext,
        runId: params.entry?.restartRecoveryDeliveryRunId,
        sourceRunId: params.entry?.restartRecoveryDeliverySourceRunId,
      };
    });
    expect(persistedClaims).toContainEqual({
      context: undefined,
      runId: "recovery-run",
      sourceRunId: "control-ui-run",
    });
    expect(persistedClaims.at(-1)).toEqual({
      context: undefined,
      runId: undefined,
      sourceRunId: undefined,
    });
    const cleanupParams = state.persistSessionEntryMock.mock.calls.at(-1)?.[0] as
      | {
          sessionStore?: Record<string, SessionEntry>;
        }
      | undefined;
    const stored = cleanupParams?.sessionStore?.["agent:main:main"];
    expect(stored?.restartRecoveryDeliveryContext).toBeUndefined();
    expect(stored?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(stored?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(stored?.restartRecoveryTerminalRunIds).toEqual(["control-ui-run"]);
  });

  it("refreshes delivery session entries through the session accessor", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
    };
    const freshEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 2,
      deliveryContext: {
        channel: "discord",
        to: "discord:dm:sqlite",
        accountId: "main",
      },
    };
    const sessionStore: Record<string, SessionEntry> = { "agent:main:main": sessionEntry };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = sessionStore;
    state.storePathMock = "/tmp/openclaw-sessions.json";
    state.loadSessionEntryMock.mockReturnValue(freshEntry);
    state.deliverAgentCommandResultMock.mockImplementation(async (params: unknown) => {
      const resolver = (
        params as {
          resolveFreshSessionEntryForDelivery?: () => Promise<SessionEntry | undefined>;
        }
      ).resolveFreshSessionEntryForDelivery;
      const resolved = await resolver?.();
      expect(resolved).toEqual(freshEntry);
      return { deliverySucceeded: true };
    });

    await agentCommand({
      message: "hello",
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(state.loadSessionEntryMock).toHaveBeenCalledWith({
      storePath: "/tmp/openclaw-sessions.json",
      sessionKey: "agent:main:main",
      readConsistency: "latest",
      clone: false,
    });
  });

  it("preserves parsed explicit target threads for restart recovery", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
    };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-sessions.json";
    state.deliverAgentCommandResultMock.mockResolvedValue({ deliverySucceeded: true });
    state.resolveAgentDeliveryPlanMock.mockReturnValueOnce({
      baseDelivery: {
        mode: "explicit",
        threadId: "thread-1",
        threadIdSource: "explicit",
      },
      resolvedChannel: "discord",
      resolvedTo: "discord:channel:general",
      resolvedAccountId: "main",
      resolvedThreadId: "thread-1",
      deliveryTargetMode: "explicit",
    });

    await agentCommand({
      message: "hello",
      channel: "discord",
      to: "discord:channel:general/thread:thread-1",
      accountId: "main",
      deliver: true,
    });

    const persistedContexts = state.persistSessionEntryMock.mock.calls.map((call) => {
      const params = call[0] as { entry?: SessionEntry };
      return params.entry?.restartRecoveryDeliveryContext;
    });
    expect(persistedContexts).toContainEqual({
      channel: "discord",
      to: "discord:channel:general",
      accountId: "main",
      threadId: "thread-1",
    });
  });

  it("does not inherit a stale thread when restart recovery uses an explicit target", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      lastThreadId: "stale-thread",
    };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-sessions.json";
    state.deliverAgentCommandResultMock.mockResolvedValue({ deliverySucceeded: true });

    await agentCommand({
      message: "hello",
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    const persistedContexts = state.persistSessionEntryMock.mock.calls.map((call) => {
      const params = call[0] as { entry?: SessionEntry };
      return params.entry?.restartRecoveryDeliveryContext;
    });
    expect(persistedContexts).toContainEqual({
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
    });
  });

  it("persists implicit session delivery route for restart recovery", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      deliveryContext: {
        channel: "discord",
        to: "discord:channel:general",
        accountId: "main",
        threadId: "thread-1",
      },
    };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-sessions.json";
    state.deliverAgentCommandResultMock.mockResolvedValue({ deliverySucceeded: true });

    await agentCommand({
      message: "hello",
      sessionKey: "agent:main:main",
      deliver: true,
    });

    const persistedContexts = state.persistSessionEntryMock.mock.calls.map((call) => {
      const params = call[0] as { entry?: SessionEntry };
      return params.entry?.restartRecoveryDeliveryContext;
    });
    expect(persistedContexts).toContainEqual({
      channel: "discord",
      to: "discord:channel:general",
      accountId: "main",
      threadId: "thread-1",
    });
    expect(state.resolveAgentDeliveryPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        explicitTo: undefined,
        requestedChannel: undefined,
        sessionEntry: expect.objectContaining({
          deliveryContext: expect.objectContaining({ to: "discord:channel:general" }),
        }),
        wantsDelivery: true,
      }),
    );
  });

  it("persists default target delivery route for restart recovery", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
    };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-sessions.json";
    state.deliverAgentCommandResultMock.mockResolvedValue({ deliverySucceeded: true });
    state.resolveMessageChannelSelectionMock.mockResolvedValue({
      channel: "discord",
      configured: ["discord"],
      source: "single-configured",
    });
    state.resolveAgentOutboundTargetMock.mockReturnValue({
      resolvedTarget: { ok: true, to: "discord:channel:default" },
      resolvedTo: "discord:channel:default",
      targetMode: "implicit",
    });

    await agentCommand({
      message: "hello",
      sessionKey: "agent:main:main",
      deliver: true,
    });

    const persistedContexts = state.persistSessionEntryMock.mock.calls.map((call) => {
      const params = call[0] as { entry?: SessionEntry };
      return params.entry?.restartRecoveryDeliveryContext;
    });
    expect(persistedContexts).toContainEqual({
      channel: "discord",
      to: "discord:channel:default",
    });
  });

  it("does not overwrite another active run's restart recovery context", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeEmptyResult("openai", "gpt-5.4"));
    const staleEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
    };
    const laterRunEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 2,
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "discord:dm:456",
        accountId: "main",
      },
      restartRecoveryDeliveryRunId: "later-run",
    };
    const sessionStore: Record<string, SessionEntry> = {
      "agent:main:main": laterRunEntry,
    };
    state.sessionEntryMock = staleEntry;
    state.sessionStoreMock = sessionStore;
    state.storePathMock = "/tmp/openclaw-sessions.json";

    await agentCommand({
      message: "hello",
      sessionKey: "agent:main:main",
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
      runId: "stale-run",
    });

    expect(sessionStore["agent:main:main"]?.restartRecoveryDeliveryContext).toEqual(
      laterRunEntry.restartRecoveryDeliveryContext,
    );
    expect(sessionStore["agent:main:main"]?.restartRecoveryDeliveryRunId).toBe("later-run");
  });

  it("does not clear another active run's restart recovery context", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeEmptyResult("openai", "gpt-5.4"));
    const staleEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
    };
    const laterRunEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 2,
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "discord:dm:456",
        accountId: "main",
      },
      restartRecoveryDeliveryRunId: "later-run",
    };
    const sessionStore: Record<string, SessionEntry> = {
      "agent:main:main": laterRunEntry,
    };
    state.sessionEntryMock = staleEntry;
    state.sessionStoreMock = sessionStore;
    state.storePathMock = "/tmp/openclaw-sessions.json";

    await agentCommand({
      message: "hello",
      sessionKey: "agent:main:main",
      deliver: true,
      runId: "stale-run",
    });

    expect(sessionStore["agent:main:main"]?.restartRecoveryDeliveryContext).toEqual(
      laterRunEntry.restartRecoveryDeliveryContext,
    );
    expect(sessionStore["agent:main:main"]?.restartRecoveryDeliveryRunId).toBe("later-run");
  });

  it("keeps current run delivery context when restart marker wins the cleanup race", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
    };
    const sessionStore: Record<string, SessionEntry> = { "agent:main:main": sessionEntry };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = sessionStore;
    state.storePathMock = "/tmp/openclaw-sessions.json";
    state.deliverAgentCommandResultMock.mockImplementation(async () => {
      const current = sessionStore["agent:main:main"];
      if (current) {
        current.abortedLastRun = true;
      }
      return { deliverySucceeded: false };
    });

    await agentCommand({
      message: "hello",
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(sessionStore["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(state.persistSessionEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          restartRecoveryDeliveryContext: {
            channel: "discord",
            to: "discord:dm:123",
            accountId: "main",
          },
          restartRecoveryDeliveryRunId: "session-1",
        }),
      }),
    );
  });

  it("does not recreate a deleted session entry during restart recovery cleanup", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeEmptyResult("openai", "gpt-5.4"));
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
    };
    const sessionStore: Record<string, SessionEntry> = { "agent:main:main": sessionEntry };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = sessionStore;
    state.storePathMock = "/tmp/openclaw-sessions.json";
    state.deliverAgentCommandResultMock.mockImplementation(async () => {
      delete sessionStore["agent:main:main"];
      return { deliverySucceeded: true };
    });

    await agentCommand({
      message: "hello",
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(sessionStore["agent:main:main"]).toBeUndefined();
  });

  it("does not clear restart recovery context from a rotated session entry", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeEmptyResult("openai", "gpt-5.4"));
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
    };
    const rotatedEntry: SessionEntry = {
      sessionId: "session-2",
      updatedAt: 2,
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "discord:dm:456",
        accountId: "main",
      },
    };
    const sessionStore: Record<string, SessionEntry> = { "agent:main:main": sessionEntry };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = sessionStore;
    state.storePathMock = "/tmp/openclaw-sessions.json";
    state.deliverAgentCommandResultMock.mockImplementation(async () => {
      sessionStore["agent:main:main"] = rotatedEntry;
      return { deliverySucceeded: true };
    });

    await agentCommand({
      message: "hello",
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(sessionStore["agent:main:main"]).toEqual(rotatedEntry);
  });

  it("does not clear restart recovery context from another active run in the same session", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeEmptyResult("openai", "gpt-5.4"));
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
    };
    const laterRunEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 2,
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "discord:dm:456",
        accountId: "main",
      },
      restartRecoveryDeliveryRunId: "later-run",
    };
    const sessionStore: Record<string, SessionEntry> = { "agent:main:main": sessionEntry };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = sessionStore;
    state.storePathMock = "/tmp/openclaw-sessions.json";
    state.deliverAgentCommandResultMock.mockImplementation(async () => {
      sessionStore["agent:main:main"] = laterRunEntry;
      return { deliverySucceeded: false };
    });

    await agentCommand({
      message: "hello",
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(sessionStore["agent:main:main"]).toEqual(laterRunEntry);
  });

  it("stores pending final delivery with the current run delivery context", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
    };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-sessions.json";
    state.deliverAgentCommandResultMock.mockResolvedValue({ deliverySucceeded: false });

    await agentCommand({
      message: "hello",
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    const pendingEntries = state.persistSessionEntryMock.mock.calls
      .map((call) => (call[0] as { entry?: SessionEntry }).entry)
      .filter((entry): entry is SessionEntry => entry?.pendingFinalDelivery === true);
    expect(pendingEntries).toContainEqual(
      expect.objectContaining({
        pendingFinalDeliveryText: "ok",
        pendingFinalDeliveryContext: {
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
        },
      }),
    );
  });

  it("clears stale flag-only pending final delivery when there is no final payload", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeEmptyResult("openai", "gpt-5.4"));

    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      pendingFinalDelivery: true,
      pendingFinalDeliveryCreatedAt: 2,
      pendingFinalDeliveryLastAttemptAt: 3,
      pendingFinalDeliveryAttemptCount: 4,
      pendingFinalDeliveryLastError: "previous failure",
      pendingFinalDeliveryContext: { channel: "tui" },
      pendingFinalDeliveryIntentId: "intent-1",
    };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-sessions.json";
    state.deliverAgentCommandResultMock.mockResolvedValue(undefined);

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      deliver: true,
    });

    expect(state.persistSessionEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          pendingFinalDelivery: undefined,
          pendingFinalDeliveryText: undefined,
          pendingFinalDeliveryCreatedAt: undefined,
          pendingFinalDeliveryLastAttemptAt: undefined,
          pendingFinalDeliveryAttemptCount: undefined,
          pendingFinalDeliveryLastError: undefined,
          pendingFinalDeliveryContext: undefined,
          pendingFinalDeliveryIntentId: undefined,
        }),
      }),
    );
  });

  it("passes SQLite transcript markers to visible agent attempts", async () => {
    setupSingleAttemptFallback();
    const visibleEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      sessionFile: "sqlite:default:session-1:/tmp/openclaw-session-store.json",
    };
    const sessionStore: Record<string, SessionEntry> = { "agent:main:main": visibleEntry };
    state.sessionEntryMock = visibleEntry;
    state.sessionStoreMock = sessionStore;
    state.storePathMock = "/tmp/openclaw-session-store.json";
    state.loadSessionEntryMock.mockReturnValue(visibleEntry);
    const attemptCalls: Array<{ sessionFile?: string; sessionEntry?: SessionEntry }> = [];
    state.runAgentAttemptMock.mockImplementation(async (params) => {
      attemptCalls.push(params as { sessionFile?: string; sessionEntry?: SessionEntry });
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await agentCommand({
      message: "visible run",
      to: "+1234567890",
    });

    expect(attemptCalls).toHaveLength(1);
    expect(attemptCalls[0]?.sessionFile).toBe(
      "sqlite:default:session-1:/tmp/openclaw-session-store.json",
    );
  });

  it("keeps internal session-effect CLI runs out of visible session state", async () => {
    setupSingleAttemptFallback();
    const visibleEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      sessionFile: "/tmp/session.jsonl",
      providerOverride: "anthropic",
      modelOverride: "claude",
      modelOverrideSource: "user",
      skillsSnapshot: { prompt: "visible", skills: [{ name: "existing" }], version: 1 },
    };
    const sessionStore: Record<string, SessionEntry> = { "agent:main:main": visibleEntry };
    state.sessionEntryMock = visibleEntry;
    state.sessionStoreMock = sessionStore;
    state.storePathMock = "/tmp/openclaw-session-store.json";
    state.loadSessionEntryMock.mockReturnValue(visibleEntry);
    const attemptCalls: Array<{ sessionFile?: string; sessionEntry?: SessionEntry }> = [];
    state.runAgentAttemptMock.mockImplementation(async (params) => {
      attemptCalls.push(params as { sessionFile?: string; sessionEntry?: SessionEntry });
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await agentCommand({
      message: "internal resume",
      to: "+1234567890",
      sessionEffects: "internal",
      suppressPromptPersistence: true,
    });

    expect(state.prepareInternalSessionEffectsSessionMock).toHaveBeenCalledWith({
      agentId: "default",
      cwd: "/tmp/workspace",
      runId: "session-1",
      source: {
        agentId: "default",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: "/tmp/openclaw-session-store.json",
      },
      storePath: "/tmp/openclaw-session-store.json",
    });
    expect(attemptCalls).toHaveLength(1);
    expect(attemptCalls[0]?.sessionFile).toBe(
      "sqlite:default:internal-session:/tmp/openclaw-session-store.json",
    );
    expect(attemptCalls[0]?.sessionEntry).toStrictEqual(visibleEntry);
    expect(state.trajectoryRecorderParamsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: "sqlite:default:internal-session:/tmp/openclaw-session-store.json",
      }),
    );
    expect(state.persistSessionEntryMock).not.toHaveBeenCalled();
    expect(state.updateSessionStoreAfterAgentRunMock).not.toHaveBeenCalled();
    expect(sessionStore["agent:main:main"]).toBe(visibleEntry);
    expect(state.registerAgentRunContextMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sessionKey: "agent:main:main",
        sessionId: "session-1",
        isControlUiVisible: false,
      }),
    );
    expect(state.removeInternalSessionEffectsSessionMock).not.toHaveBeenCalled();
  });

  it("rejects session-id-resolved model runs for harness-owned sessions", async () => {
    state.resolvedSessionKeyMock = "agent:main:harness:codex:supervision:native-thread";
    state.sessionEntryMock = {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionId: "session-1",
      updatedAt: 1,
    };

    await expect(
      agentCommand({
        message: "probe",
        sessionId: "session-1",
        modelRun: true,
        promptMode: "none",
        sessionEffects: "internal",
      }),
    ).rejects.toThrow("Agent harness-owned sessions cannot be used for one-shot model runs.");
    expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
  });

  it("rejects one-shot model runs for locked harness sessions with ordinary keys", async () => {
    state.resolvedSessionKeyMock = "agent:main:plugin-owned";
    state.sessionEntryMock = {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionId: "session-1",
      updatedAt: 1,
    };

    await expect(
      agentCommand({
        message: "probe",
        sessionId: "session-1",
        modelRun: true,
        promptMode: "none",
        sessionEffects: "internal",
      }),
    ).rejects.toThrow("Agent harness-owned sessions cannot be used for one-shot model runs.");
    expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
  });

  it("continues a grandfathered unlocked harness-prefixed session as an ordinary run", async () => {
    setupSingleAttemptFallback();
    state.resolvedSessionKeyMock = "agent:main:harness:notes";
    state.sessionEntryMock = {
      agentHarnessId: "codex",
      modelSelectionLocked: false,
      sessionId: "session-1",
      sessionFile: "/tmp/legacy-session.jsonl",
      updatedAt: 1,
    };
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude"));

    await runBasicAgentCommand();

    expect(state.runAgentAttemptMock).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      agentHarnessRuntimeOverride: undefined,
      sessionEntry: expect.objectContaining({
        agentHarnessId: "codex",
        modelSelectionLocked: false,
        sessionId: "session-1",
      }),
    });
  });

  it("rejects a locked harness row with the wrong owner before transcript or model work", async () => {
    state.resolvedSessionKeyMock = "agent:main:harness:codex:supervision:native-thread";
    state.sessionEntryMock = {
      agentHarnessId: "other",
      modelSelectionLocked: true,
      sessionId: "session-1",
      sessionFile: "/tmp/native-session.jsonl",
      updatedAt: 1,
    };

    await expect(agentCommand({ message: "continue", sessionId: "session-1" })).rejects.toThrow(
      "Session key namespace is reserved for agent harness-owned sessions.",
    );
    expect(state.prepareInternalSessionEffectsSessionMock).not.toHaveBeenCalled();
    expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
  });

  it("removes the one-shot internal model-run SQLite session after success", async () => {
    setupSingleAttemptFallback();
    const result = makeSuccessResult("openai", "gpt-5.4");
    state.runAgentAttemptMock.mockResolvedValue({
      ...result,
      meta: {
        ...result.meta,
        executionTrace: {
          runner: "embedded",
          fallbackUsed: false,
          winnerProvider: "openai",
          winnerModel: "gpt-5.4",
        },
        finalAssistantVisibleText: "ok",
        agentMeta: {
          provider: "openai",
          model: "gpt-5.4",
          sessionId: "rotated-model-run-session",
          sessionFile: "sqlite:default:rotated-model-run-session:/tmp/openclaw-session-store.json",
        },
      },
    });

    await agentCommand({
      message: "probe",
      to: "+1234567890",
      runId: "model-run-success",
      modelRun: true,
      promptMode: "none",
      sessionEffects: "internal",
    });

    expect(state.createTrajectoryRuntimeRecorderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: "sqlite:default:internal-session:/tmp/openclaw-session-store.json",
      }),
    );
    expect(state.persistCliTurnTranscriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "rotated-model-run-session",
        sessionKey: "agent:default:internal-session-effects:run",
        storePath: "/tmp/openclaw-session-store.json",
      }),
    );
    expect(state.removeInternalSessionEffectsSessionMock).toHaveBeenCalledWith({
      agentId: "default",
      sessionId: "rotated-model-run-session",
      sessionKey: "agent:default:internal-session-effects:run",
      storePath: "/tmp/openclaw-session-store.json",
      sessionFile: "sqlite:default:internal-session:/tmp/openclaw-session-store.json",
      sessionEntry: { sessionId: "internal-session", updatedAt: 1 },
    });
    const deliveryOrder = state.deliverAgentCommandResultMock.mock.invocationCallOrder[0] ?? 0;
    const cleanupOrder =
      state.removeInternalSessionEffectsSessionMock.mock.invocationCallOrder[0] ?? 0;
    expect(deliveryOrder).toBeLessThan(cleanupOrder);
  });

  it("removes the one-shot internal model-run SQLite session after provider failure", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockRejectedValueOnce(new Error("probe failed"));

    await expect(
      agentCommand({
        message: "probe",
        to: "+1234567890",
        runId: "model-run-failure",
        modelRun: true,
        promptMode: "none",
        sessionEffects: "internal",
      }),
    ).rejects.toThrow("probe failed");

    expect(state.removeInternalSessionEffectsSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "internal-session",
        sessionKey: "agent:default:internal-session-effects:run",
        storePath: "/tmp/openclaw-session-store.json",
      }),
    );
  });

  it("cleans the deterministic model-run session when preparation fails", async () => {
    state.storePathMock = "/tmp/openclaw-session-store.json";
    state.loadSessionEntryMock.mockReturnValue({ sessionId: "session-1", updatedAt: 1 });
    state.prepareInternalSessionEffectsSessionMock.mockRejectedValueOnce(
      new Error("session preparation failed"),
    );

    await expect(
      agentCommand({
        message: "probe",
        to: "+1234567890",
        runId: "model-run-prepare-failure",
        modelRun: true,
        promptMode: "none",
        sessionEffects: "internal",
      }),
    ).rejects.toThrow("session preparation failed");

    expect(state.removeInternalSessionEffectsSessionMock).toHaveBeenCalledWith({
      agentId: "default",
      sessionId: "internal-model-run-prepare-failure",
      sessionKey: "agent:default:internal-session-effects:model-run-prepare-failure",
      storePath: "/tmp/openclaw-session-store.json",
    });
  });

  it("does not replace a completed model-run result with a SQLite cleanup failure", async () => {
    setupSingleAttemptFallback();
    state.storePathMock = "/tmp/openclaw-session-store.json";
    state.loadSessionEntryMock.mockReturnValue({ sessionId: "session-1", updatedAt: 1 });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    state.removeInternalSessionEffectsSessionMock.mockRejectedValue(
      new Error("database is locked"),
    );

    await expect(
      agentCommand({
        message: "probe",
        to: "+1234567890",
        runId: "model-run-cleanup-failure",
        modelRun: true,
        promptMode: "none",
        sessionEffects: "internal",
      }),
    ).resolves.toBeUndefined();

    expect(state.removeInternalSessionEffectsSessionMock).toHaveBeenCalled();
  });

  it("does not duplicate finishing lifecycle when an attempt already emitted finishing", async () => {
    setupModelSwitchRetry({
      provider: "openai",
      model: "gpt-5.4",
    });
    state.runAgentAttemptMock.mockImplementation(async (attemptParams: unknown) => {
      state.emitAgentEventMock({
        runId: "run-live-switch",
        stream: "lifecycle",
        data: { phase: "finishing" },
      });
      (attemptParams as { onAgentEvent?: (evt: unknown) => void }).onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: "finishing" },
      });
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await runBasicAgentCommand();

    const lifecycleFinishingCalls = state.emitAgentEventMock.mock.calls.filter(
      (call: unknown[]) => {
        const arg = call[0] as { stream?: string; data?: { phase?: string } };
        return arg?.stream === "lifecycle" && arg?.data?.phase === "finishing";
      },
    );
    expect(lifecycleFinishingCalls).toHaveLength(1);
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

  it("resolves explicit model aliases before thinking validation", async () => {
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {
            "openai/*": {},
            "codex/gpt-5.5": {
              alias: "code",
            },
          },
        },
      },
      models: {
        providers: {
          codex: {
            models: [
              {
                id: "gpt-5.5",
                name: "GPT 5.5 Codex",
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
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("codex", "gpt-5.5"));

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      model: "code",
      thinking: "xhigh",
      allowModelOverride: true,
    });

    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.provider).toBe("codex");
    expect(fallbackParams.model).toBe("gpt-5.5");
    const thinkingArgs = requireRecord(
      mockCallArg(state.isThinkingLevelSupportedMock),
      "thinking args",
    );
    expect(thinkingArgs.provider).toBe("codex");
    expect(thinkingArgs.model).toBe("gpt-5.5");
    expect(thinkingArgs.level).toBe("xhigh");
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

  it("keeps a hook-blocked user turn suppressed across model fallback", async () => {
    type AttemptCall = {
      suppressPromptPersistenceOnRetry?: boolean;
      userTurnTranscriptRecorder?: {
        markBlocked: () => void;
      };
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
      if (attemptCalls.length === 1) {
        attemptParams.userTurnTranscriptRecorder?.markBlocked();
      }
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await runBasicAgentCommand();

    expect(attemptCalls).toHaveLength(2);
    expect(attemptCalls[1]?.userTurnTranscriptRecorder).toBe(
      attemptCalls[0]?.userTurnTranscriptRecorder,
    );
    expect(attemptCalls[0]?.suppressPromptPersistenceOnRetry).toBe(false);
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
      const result = makeSuccessResult("openai", "gpt-5.4") as ReturnType<
        typeof makeSuccessResult
      > & {
        meta: Record<string, unknown> & { executionTrace?: Record<string, unknown> };
      };
      result.meta.executionTrace = {
        runner: "cli",
        fallbackUsed: false,
        winnerProvider: "openai",
        winnerModel: "gpt-5.4",
      };
      return result;
    });

    await agentCommand({
      message: "internal handoff",
      to: "+1234567890",
      suppressPromptPersistence: true,
    });

    expect(attemptCalls).toHaveLength(2);
    expect(attemptCalls[0]?.suppressPromptPersistenceOnRetry).toBe(true);
    expect(attemptCalls[1]?.suppressPromptPersistenceOnRetry).toBe(true);
    expectRecordFields(mockCallArg(state.persistCliTurnTranscriptMock), {
      skipUserTurn: true,
    });
  });

  it("preserves an explicit empty transcript message as user-turn omission", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await agentCommand({
      message: "synthetic announce prompt",
      transcriptMessage: "",
      to: "+1234567890",
    });

    const attempt = mockCallArg(state.runAgentAttemptMock) as {
      suppressPromptPersistenceOnRetry?: boolean;
      userTurnTranscriptRecorder?: { message?: unknown };
    };
    expect(attempt.suppressPromptPersistenceOnRetry).toBe(true);
    expect(attempt.userTurnTranscriptRecorder?.message).toBeUndefined();
  });

  it("uses a tracker-only recorder for text plus image turns", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await agentCommand({
      message: "inspect this image",
      transcriptMessage: "canonical image caption",
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      to: "+1234567890",
    });

    const attempt = mockCallArg(state.runAgentAttemptMock) as {
      transcriptBody?: string;
      suppressPromptPersistenceOnRetry?: boolean;
      userTurnTranscriptRecorder?: { message?: unknown };
    };
    expect(attempt.transcriptBody).toBe("canonical image caption");
    expect(attempt.suppressPromptPersistenceOnRetry).toBe(false);
    expect(attempt.userTurnTranscriptRecorder?.message).toMatchObject({
      role: "user",
      content: "canonical image caption",
    });
  });

  it("persists structured transcript media without a caption", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await agentCommand({
      message: "[media attached: media://inbound/image-1]",
      transcriptMessage: "",
      transcriptMedia: [{ path: "/media/inbound/image-1.png", contentType: "image/png" }],
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      to: "+1234567890",
    });

    const attempt = mockCallArg(state.runAgentAttemptMock) as {
      suppressPromptPersistenceOnRetry?: boolean;
      userTurnTranscriptRecorder?: { message?: unknown };
    };
    expect(attempt.suppressPromptPersistenceOnRetry).toBe(false);
    expect(attempt.userTurnTranscriptRecorder?.message).toMatchObject({
      role: "user",
      content: "[User sent media without caption]",
      MediaPath: "/media/inbound/image-1.png",
      MediaPaths: ["/media/inbound/image-1.png"],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    });
  });

  it("propagates non-switch errors without retrying and emits lifecycle error", async () => {
    state.runWithModelFallbackMock.mockRejectedValueOnce(new Error("provider down"));

    await expect(
      agentCommand({
        message: "hello",
        to: "+1234567890",
      }),
    ).rejects.toThrow("provider down");

    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(1);

    const lifecycleErrorCalls = state.emitAgentEventMock.mock.calls.filter((call: unknown[]) => {
      const arg = call[0] as { stream?: string; data?: { phase?: string } };
      return arg?.stream === "lifecycle" && arg?.data?.phase === "error";
    });
    expect(lifecycleErrorCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("marks lifecycle errors aborted when cancellation reaches post-turn handling", async () => {
    const abortController = new AbortController();
    state.runWithModelFallbackMock.mockImplementationOnce(async () => {
      abortController.abort();
      throw new Error("request aborted");
    });

    await expect(
      agentCommand({
        message: "hello",
        to: "+1234567890",
        abortSignal: abortController.signal,
      }),
    ).rejects.toThrow("request aborted");

    expect(
      state.emitAgentEventMock.mock.calls.some(([event]) => {
        const candidate = event as {
          stream?: string;
          data?: { phase?: string; aborted?: boolean };
        };
        return (
          candidate.stream === "lifecycle" &&
          candidate.data?.phase === "error" &&
          candidate.data.aborted === true
        );
      }),
    ).toBe(true);
  });

  it("marks direct active-run cancellation aborted without a caller signal", async () => {
    state.runWithModelFallbackMock.mockRejectedValueOnce(createAgentRunDirectAbortError());

    await expect(
      agentCommand({
        message: "hello",
        to: "+1234567890",
      }),
    ).rejects.toThrow("agent run aborted");

    expect(
      state.emitAgentEventMock.mock.calls.some(([event]) => {
        const candidate = event as {
          stream?: string;
          data?: { phase?: string; aborted?: boolean; stopReason?: string };
        };
        return (
          candidate.stream === "lifecycle" &&
          candidate.data?.phase === "error" &&
          candidate.data.aborted === true &&
          candidate.data.stopReason === "aborted"
        );
      }),
    ).toBe(true);
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
    const sessionStore: Record<string, SessionEntry> = { "agent:main:main": sessionEntry };
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
    const sessionStore: Record<string, SessionEntry> = { "agent:main:main": sessionEntry };
    state.sessionStoreMock = sessionStore;
    state.storePathMock = "/tmp/openclaw-session-store.json";
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run(params.provider, params.model);
      sessionStore["agent:main:main"] = {
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

    expectRecordFields(sessionStore["agent:main:main"], {
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "user",
    });
  });

  it("does not persist an automatic probe result after the session becomes locked", async () => {
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
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-session-store.json";
    state.resolveAutoFallbackPrimaryProbeMock.mockReturnValue({
      provider: "anthropic",
      model: "claude",
      fallbackProvider: "openai",
      fallbackModel: "claude",
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      state.persistSessionEntryMock.mockClear();
      const result = await params.run("openai", "claude");
      const currentEntry = expectDefined(
        (state.sessionStoreMock as Record<string, SessionEntry>)["agent:main:main"],
        '(state.sessionStoreMock as Record<string, SessionEntry>)[ "agent:main... test invariant',
      );
      currentEntry.modelSelectionLocked = true;
      state.isModelSelectionLockedMock.mockReturnValue(true);
      return {
        result,
        provider: "openai",
        model: "claude",
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "claude"));

    await runBasicAgentCommand();

    const autoProbeWrites = state.persistSessionEntryMock.mock.calls.filter((call) => {
      const entry = (call[0] as { entry?: SessionEntry } | undefined)?.entry;
      return entry?.modelOverrideSource === "auto" && entry?.modelOverride === "claude";
    });
    expect(autoProbeWrites).toHaveLength(0);
  });

  it("keeps aliased session auth profiles for codex-cli runs", async () => {
    let capturedAuthProfileProvider: string | undefined;
    const sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-cli",
      modelOverride: "gpt-5.4",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    } satisfies SessionEntry;
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
        "openai:work": {
          type: "api_key",
          provider: "openai",
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

  it("emits a failure lifecycle after delivering a preserved exhausted result", async () => {
    const exhaustedResult = {
      payloads: [{ text: "Terminal tool summary", isError: true }],
      meta: {
        durationMs: 100,
        aborted: false,
        stopReason: "end_turn",
        error: {
          kind: "incomplete_turn",
          message: "All fallback candidates ended incomplete",
          fallbackSafe: true,
          terminalPresentation: true,
        },
        agentMeta: { provider: "anthropic", model: "claude" },
      },
    };
    state.runAgentAttemptMock.mockImplementationOnce(async (attemptParams: unknown) => {
      const params = attemptParams as {
        deferTerminalLifecycle?: boolean;
        onAgentEvent?: (event: { stream: string; data: Record<string, unknown> }) => void;
      };
      expect(params.deferTerminalLifecycle).toBe(true);
      params.onAgentEvent?.({
        stream: "lifecycle",
        data: {
          phase: "finishing",
          error: "All fallback candidates ended incomplete",
        },
      });
      return exhaustedResult;
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "exhausted",
      result: await params.run("anthropic", "claude"),
      provider: "anthropic",
      model: "claude",
      attempts: [
        {
          provider: "anthropic",
          model: "claude",
          error: "All fallback candidates ended incomplete",
          reason: "format",
        },
      ],
    }));

    await runBasicAgentCommand();

    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledTimes(1);
    const lifecycleEvents = state.emitAgentEventMock.mock.calls
      .map((call) => call[0] as { stream?: string; data?: Record<string, unknown> })
      .filter((event) => event.stream === "lifecycle");
    expect(lifecycleEvents.some((event) => event.data?.phase === "finishing")).toBe(false);
    expect(lifecycleEvents.some((event) => event.data?.phase === "end")).toBe(false);
    expect(lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "error",
            error: "All fallback candidates ended incomplete",
            fallbackExhaustedFailure: true,
          }),
        }),
      ]),
    );
  });

  it("emits a failure lifecycle for completed non-fallbackable error results", async () => {
    const terminalErrorResult = {
      payloads: [{ text: "Command may have changed state", isError: true }],
      meta: {
        durationMs: 100,
        aborted: false,
        stopReason: "end_turn",
        replayInvalid: true,
        error: {
          kind: "incomplete_turn",
          message: "raw provider detail should stay private",
          fallbackSafe: false,
        },
        agentMeta: { provider: "anthropic", model: "claude" },
      },
    };
    state.runAgentAttemptMock.mockImplementationOnce(async (attemptParams: unknown) => {
      const params = attemptParams as {
        onAgentEvent?: (event: { stream: string; data: Record<string, unknown> }) => void;
      };
      params.onAgentEvent?.({
        stream: "lifecycle",
        data: {
          phase: "finishing",
          error: "Command may have changed state",
          replayInvalid: true,
        },
      });
      return terminalErrorResult;
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run("anthropic", "claude"),
      provider: "anthropic",
      model: "claude",
      attempts: [],
    }));

    await runBasicAgentCommand();

    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledTimes(1);
    const lifecycleEvents = state.emitAgentEventMock.mock.calls
      .map((call) => call[0] as { stream?: string; data?: Record<string, unknown> })
      .filter((event) => event.stream === "lifecycle");
    expect(lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "error",
            error: "Command may have changed state",
            replayInvalid: true,
          }),
        }),
      ]),
    );
    expect(
      lifecycleEvents.some(
        (event) => event.data?.phase === "end" || event.data?.fallbackExhaustedFailure === true,
      ),
    ).toBe(false);
    expect(JSON.stringify(lifecycleEvents)).not.toContain("raw provider detail");
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
      sessionKey: "agent:main:main",
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

  it("keeps session provenance for internal ACP turns", async () => {
    state.acpResolveSessionMock.mockReturnValue({
      kind: "ready",
      meta: {
        agent: "claude",
        cwd: "/tmp/workspace",
      },
    });

    await agentCommand({
      message: "internal ACP turn",
      sessionKey: "agent:main:main",
      sessionEffects: "internal",
    });

    expect(state.registerAgentRunContextMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        sessionId: "session-1",
        isControlUiVisible: false,
      }),
    );
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
      sessionKey: "agent:main:main",
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
        sessionKey: "agent:main:main",
      }),
    ).rejects.toThrow("ACP dispatch is disabled");

    expect(state.resolveAcpExplicitTurnPolicyErrorMock).not.toHaveBeenCalled();
    expect(state.resolveAcpDispatchPolicyErrorMock).toHaveBeenCalledTimes(1);
    expect(state.acpRunTurnMock).not.toHaveBeenCalled();
    expect(state.emitAcpLifecycleErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ terminalOutcome: "blocked" }),
    );
  });

  it("preserves ACP cancelled results without a stop reason", async () => {
    state.acpResolveSessionMock.mockReturnValue({
      kind: "ready",
      meta: {
        agent: "claude",
        cwd: "/tmp/workspace",
      },
    });
    state.acpRunTurnMock.mockImplementationOnce(async (params: unknown) => {
      const onEvent = (params as { onEvent?: (event: unknown) => void }).onEvent;
      onEvent?.({ type: "done", status: "cancelled" });
    });

    await agentCommand({
      message: "cancelled ACP turn",
      sessionKey: "agent:main:main",
    });

    expect(state.emitAcpLifecycleEndMock).toHaveBeenCalledWith(
      expect.objectContaining({ resultStatus: "cancelled", stopReason: undefined }),
    );
    expect(state.buildAcpResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ resultStatus: "cancelled", stopReason: undefined }),
    );
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

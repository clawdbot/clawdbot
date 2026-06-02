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
  resolveAutoFallbackPrimaryProbeMock: vi.fn((_params: unknown) => undefined as unknown),
  resolveChannelModelOverrideMock: vi.fn((_params: unknown) => null as unknown),
  emitAgentEventMock: vi.fn(),
  registerAgentRunContextMock: vi.fn(),
  clearAgentRunContextMock: vi.fn(),
  updateSessionStoreAfterAgentRunMock: vi.fn(),
  deliverAgentCommandResultMock: vi.fn(),
  resolveAgentDeliveryPlanMock: vi.fn(),
  resolveAgentOutboundTargetMock: vi.fn(),
  resolveMessageChannelSelectionMock: vi.fn(),
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
  prepareInternalSessionEffectsTranscriptMock: vi.fn(),
  removeInternalSessionEffectsTranscriptMock: vi.fn(),
  authProfileStoreMock: { profiles: {} } as { profiles: Record<string, unknown> },
  sessionEntryMock: undefined as SessionEntry | undefined,
  sessionStoreMock: undefined as unknown,
  storePathMock: undefined as string | undefined,
  resolvedSessionKeyMock: undefined as string | undefined,
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
  formatXHighModelHint: () => "model-x",
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

vi.mock("./internal-session-effects.js", () => ({
  prepareInternalSessionEffectsTranscript: (...args: unknown[]) =>
    state.prepareInternalSessionEffectsTranscriptMock(...args),
  removeInternalSessionEffectsTranscript: (...args: unknown[]) =>
    state.removeInternalSessionEffectsTranscriptMock(...args),
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

vi.mock("../channels/model-overrides.js", () => ({
  resolveChannelModelOverride: (params: unknown) => state.resolveChannelModelOverrideMock(params),
}));

vi.mock("../routing/session-key.js", async () => {
  const actual = await vi.importActual<typeof import("../routing/session-key.js")>(
    "../routing/session-key.js",
  );
  return {
    ...actual,
    isSubagentSessionKey: () => false,
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
        const [provider, ...modelParts] = ref.split("/");
        const model = modelParts.join("/");
        byAlias.set(alias.toLowerCase(), { alias, ref: { provider, model } });
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
      async (params: { sessionEntry?: unknown }) => params.sessionEntry,
    );
    state.persistAcpTurnTranscriptMock.mockImplementation(
      async (params: { sessionEntry?: unknown }) => params.sessionEntry,
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
    state.prepareInternalSessionEffectsTranscriptMock.mockResolvedValue(
      "/tmp/openclaw-internal-run.jsonl",
    );
    state.removeInternalSessionEffectsTranscriptMock.mockResolvedValue(undefined);
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
      deferTerminalLifecycleEnd: true,
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
    state.persistCliTurnTranscriptMock.mockResolvedValue(rotatedEntry);
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
    const stored = (state.sessionStoreMock as Record<string, SessionEntry>)["agent:main:main"];
    expect(stored?.restartRecoveryDeliveryContext).toBeUndefined();
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

    expect(state.prepareInternalSessionEffectsTranscriptMock).toHaveBeenCalledWith({
      sessionFile: "/tmp/session.jsonl",
      runId: expect.any(String),
    });
    expect(attemptCalls).toHaveLength(1);
    expect(attemptCalls[0]?.sessionFile).toBe("/tmp/openclaw-internal-run.jsonl");
    expect(attemptCalls[0]?.sessionEntry).toStrictEqual(visibleEntry);
    expect(state.persistSessionEntryMock).not.toHaveBeenCalled();
    expect(state.updateSessionStoreAfterAgentRunMock).not.toHaveBeenCalled();
    expect(sessionStore["agent:main:main"]).toBe(visibleEntry);
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

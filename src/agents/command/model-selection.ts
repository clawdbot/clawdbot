import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import {
  formatThinkingLevels,
  isThinkingLevelSupported,
  normalizeThinkLevel,
  type ThinkLevel,
} from "../../auto-reply/thinking.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { isValidAgentHarnessSessionStoreEntry } from "../../sessions/agent-harness-session-key.js";
import {
  applyModelOverrideToSessionEntry,
  ModelSelectionLockedError,
  isModelSelectionLocked,
  repairProviderWrappedModelOverride,
} from "../../sessions/model-overrides.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel.js";
import {
  clearAutoFallbackPrimaryProbeSelection,
  hasLegacyAutoFallbackWithoutOrigin,
  hasSessionAutoModelFallbackProvenance,
  resolveAutoFallbackPrimaryProbe,
  resolveAgentConfig,
  resolveAgentEffectiveModelPrimary,
} from "../agent-scope.js";
import { isStoredCredentialCompatibleWithAuthProvider } from "../auth-profiles/order.js";
import { clearSessionAuthProfileOverride } from "../auth-profiles/session-override.js";
import { ensureAuthProfileStore } from "../auth-profiles/store.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import { resolveAvailableAgentHarnessPolicy } from "../harness/selection.js";
import { loadManifestModelCatalog } from "../model-catalog.js";
import { splitTrailingAuthProfile } from "../model-ref-profile.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import {
  modelKey,
  resolveDefaultModelForAgent,
  resolveThinkingDefault,
} from "../model-selection.js";
import {
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "../model-visibility-policy.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../openai-routing.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { resolveSessionRuntimeOverrideForProvider } from "../session-runtime-compat.js";
import { resolveEffectiveAgentRuntime } from "../thinking-runtime.js";
import {
  normalizeAgentCommandDefaultModelRef,
  normalizeAgentCommandModelRef,
  parseAgentCommandModelRef,
} from "./model-ref.js";
import { normalizeExplicitOverrideInput } from "./prepare.js";
import type { resolveAgentRunContext } from "./run-context.js";
import { loadTranscriptResolveRuntime } from "./runtime-loaders.js";
import { persistSessionEntry } from "./session-helpers.js";
import type { AgentCommandOpts } from "./types.js";

type AgentRunContext = ReturnType<typeof resolveAgentRunContext>;

export async function resolveEmbeddedModelSelection(params: {
  cfg: OpenClawConfig;
  opts: AgentCommandOpts;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  sessionId: string;
  storePath: string;
  sessionAgentId: string;
  workspaceDir: string;
  pluginsEnabled: boolean;
  manifestMetadataSnapshot?: NonNullable<
    Parameters<typeof resolveProviderIdForAuth>[1]
  >["metadataSnapshot"];
  modelManifestContext: ModelManifestNormalizationContext;
  configuredThinkingCatalog: ReturnType<typeof loadManifestModelCatalog>;
  requestedThinkLevel?: ThinkLevel;
  thinkOverride?: ThinkLevel;
  thinkOnce?: ThinkLevel;
  isSubagentLane: boolean;
  suppressVisibleSessionEffects: boolean;
  runContext: AgentRunContext;
}) {
  const configuredDefaultRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.sessionAgentId,
    allowPluginNormalization: params.pluginsEnabled,
    ...params.modelManifestContext,
  });
  const configuredDefaultAuthProfileId = splitTrailingAuthProfile(
    resolveAgentEffectiveModelPrimary(params.cfg, params.sessionAgentId) ?? "",
  ).profile;
  const { provider: defaultProvider, model: defaultModel } = normalizeAgentCommandDefaultModelRef(
    params.cfg,
    configuredDefaultRef.provider,
    configuredDefaultRef.model,
    params.modelManifestContext,
  );
  let provider = defaultProvider;
  let model = defaultModel;
  let sessionEntry = params.sessionEntry;
  const hasStoredOverride = Boolean(sessionEntry?.modelOverride || sessionEntry?.providerOverride);
  let storedModelOverrideSource = hasStoredOverride ? sessionEntry?.modelOverrideSource : undefined;
  let hasStoredAutoFallbackProvenance =
    hasStoredOverride && hasSessionAutoModelFallbackProvenance(sessionEntry);
  let hasLegacyAutoFallbackOverrideWithoutOrigin =
    hasStoredOverride && hasLegacyAutoFallbackWithoutOrigin(sessionEntry);
  const explicitProviderOverride =
    typeof params.opts.provider === "string"
      ? normalizeExplicitOverrideInput(params.opts.provider, "provider")
      : undefined;
  const explicitModelOverride =
    typeof params.opts.model === "string"
      ? normalizeExplicitOverrideInput(params.opts.model, "model")
      : undefined;
  const hasExplicitRunOverride = Boolean(explicitProviderOverride || explicitModelOverride);
  if (hasExplicitRunOverride && isModelSelectionLocked(sessionEntry)) {
    throw new ModelSelectionLockedError();
  }
  if (hasExplicitRunOverride && params.opts.allowModelOverride !== true) {
    throw new Error("Model override is not authorized for this caller.");
  }

  let allowedModelCatalog: ReturnType<typeof loadManifestModelCatalog> = [];
  let modelCatalog: ReturnType<typeof loadManifestModelCatalog> | null = null;
  let visibilityPolicy: ModelVisibilityPolicy = createModelVisibilityPolicy({
    cfg: params.cfg,
    catalog: [],
    defaultProvider,
    defaultModel,
    agentId: params.sessionAgentId,
    allowManifestNormalization: true,
    allowPluginNormalization: params.pluginsEnabled,
    ...params.modelManifestContext,
  });
  const hasAllowlist = !visibilityPolicy.allowAny;
  const agentModels = resolveAgentConfig(params.cfg, params.sessionAgentId)?.models;
  const hasConfiguredModels =
    Object.keys(params.cfg.agents?.defaults?.models ?? {}).length > 0 ||
    Object.keys(agentModels ?? {}).length > 0;
  if (hasAllowlist || hasConfiguredModels) {
    modelCatalog = params.pluginsEnabled
      ? loadManifestModelCatalog({ config: params.cfg, workspaceDir: params.workspaceDir })
      : [];
    visibilityPolicy = createModelVisibilityPolicy({
      cfg: params.cfg,
      catalog: modelCatalog,
      defaultProvider,
      defaultModel,
      agentId: params.sessionAgentId,
      allowManifestNormalization: true,
      allowPluginNormalization: params.pluginsEnabled,
      ...params.modelManifestContext,
    });
    allowedModelCatalog = visibilityPolicy.allowedCatalog;
  }

  if (
    sessionEntry &&
    params.sessionStore &&
    params.sessionKey &&
    hasStoredOverride &&
    !isValidAgentHarnessSessionStoreEntry(params.sessionKey, sessionEntry) &&
    !params.suppressVisibleSessionEffects
  ) {
    // Validate legacy model-only locks on a clone so repair rejects before mutation.
    // Durable harness locks own their model metadata and bypass generic repair entirely.
    const initialEntry = sessionEntry;
    const entry = { ...sessionEntry };
    let entryUpdated = false;
    if (hasLegacyAutoFallbackOverrideWithoutOrigin) {
      const { updated } = applyModelOverrideToSessionEntry({
        entry,
        selection: { provider: defaultProvider, model: defaultModel, isDefault: true },
      });
      if (updated) {
        storedModelOverrideSource = undefined;
        entryUpdated = true;
      }
    }
    const repaired = repairProviderWrappedModelOverride({ entry, defaultProvider, defaultModel });
    entryUpdated ||= repaired.updated;
    const overrideProvider = entry.providerOverride?.trim() || defaultProvider;
    const overrideModel = entry.modelOverride?.trim();
    if (overrideModel) {
      const normalizedOverride = normalizeAgentCommandModelRef(
        params.cfg,
        overrideProvider,
        overrideModel,
        params.modelManifestContext,
      );
      if (
        !visibilityPolicy.allowsKey(modelKey(normalizedOverride.provider, normalizedOverride.model))
      ) {
        const { updated } = applyModelOverrideToSessionEntry({
          entry,
          selection: { provider: defaultProvider, model: defaultModel, isDefault: true },
        });
        entryUpdated ||= updated;
      }
    }
    if (entryUpdated) {
      sessionEntry = await persistSessionEntry({
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        initialEntry,
        entry,
      });
      const adoptedHasStoredOverride = Boolean(
        sessionEntry?.modelOverride || sessionEntry?.providerOverride,
      );
      storedModelOverrideSource = adoptedHasStoredOverride
        ? sessionEntry?.modelOverrideSource
        : undefined;
      hasStoredAutoFallbackProvenance =
        adoptedHasStoredOverride && hasSessionAutoModelFallbackProvenance(sessionEntry);
      hasLegacyAutoFallbackOverrideWithoutOrigin =
        adoptedHasStoredOverride && hasLegacyAutoFallbackWithoutOrigin(sessionEntry);
    }
  }

  const storedProviderOverride = hasLegacyAutoFallbackOverrideWithoutOrigin
    ? undefined
    : sessionEntry?.providerOverride?.trim();
  const storedModelOverride = hasLegacyAutoFallbackOverrideWithoutOrigin
    ? undefined
    : sessionEntry?.modelOverride?.trim();
  const currentRunModelChannel = [
    params.runContext.messageChannel,
    params.opts.replyChannel,
    params.opts.channel,
  ].find((channel): channel is string => Boolean(channel && isDeliverableMessageChannel(channel)));
  const channelOverrideGroupId = currentRunModelChannel
    ? (params.runContext.groupId ?? sessionEntry?.groupId ?? params.runContext.currentChannelId)
    : (sessionEntry?.groupId ?? params.runContext.groupId ?? params.runContext.currentChannelId);
  const channelModelOverride =
    params.cfg.channels?.modelByChannel && !hasExplicitRunOverride
      ? resolveChannelModelOverride({
          cfg: params.cfg,
          channel:
            currentRunModelChannel ??
            sessionEntry?.channel ??
            sessionEntry?.lastChannel ??
            sessionEntry?.origin?.provider,
          groupId: channelOverrideGroupId,
          groupChatType: sessionEntry?.chatType ?? sessionEntry?.origin?.chatType,
          groupChannel: params.runContext.groupChannel ?? sessionEntry?.groupChannel,
          groupSubject: sessionEntry?.subject,
          parentSessionKey: sessionEntry?.parentSessionKey ?? params.sessionKey,
          directUserIds: [
            sessionEntry?.origin?.nativeDirectUserId,
            sessionEntry?.origin?.from,
            sessionEntry?.origin?.to,
          ],
        })
      : null;
  const normalizedChannelOverride = channelModelOverride
    ? parseAgentCommandModelRef(
        params.cfg,
        channelModelOverride.model,
        defaultProvider,
        params.modelManifestContext,
      )
    : null;
  const primaryProvider = normalizedChannelOverride?.provider ?? defaultProvider;
  const primaryModel = normalizedChannelOverride?.model ?? defaultModel;
  const hasEffectiveStoredOverride = Boolean(storedProviderOverride || storedModelOverride);
  if (normalizedChannelOverride && !hasEffectiveStoredOverride) {
    provider = normalizedChannelOverride.provider;
    model = normalizedChannelOverride.model;
  }
  if (storedModelOverride) {
    const candidateProvider = storedProviderOverride || defaultProvider;
    const normalizedStored = normalizeAgentCommandModelRef(
      params.cfg,
      candidateProvider,
      storedModelOverride,
      params.modelManifestContext,
    );
    if (visibilityPolicy.allowsKey(modelKey(normalizedStored.provider, normalizedStored.model))) {
      provider = normalizedStored.provider;
      model = normalizedStored.model;
    }
  }
  const autoFallbackPrimaryProbe =
    !hasExplicitRunOverride && !isModelSelectionLocked(sessionEntry)
      ? resolveAutoFallbackPrimaryProbe({
          entry: sessionEntry,
          sessionKey: params.sessionKey,
          primaryProvider,
          primaryModel,
        })
      : undefined;
  let autoFallbackPrimaryProbeSessionEntry: SessionEntry | undefined;
  if (autoFallbackPrimaryProbe && sessionEntry) {
    provider = autoFallbackPrimaryProbe.provider;
    model = autoFallbackPrimaryProbe.model;
    autoFallbackPrimaryProbeSessionEntry = { ...sessionEntry };
    clearAutoFallbackPrimaryProbeSelection(autoFallbackPrimaryProbeSessionEntry);
  }

  if (hasExplicitRunOverride) {
    const explicitRef = explicitModelOverride
      ? explicitProviderOverride
        ? normalizeAgentCommandModelRef(
            params.cfg,
            explicitProviderOverride,
            explicitModelOverride,
            params.modelManifestContext,
          )
        : parseAgentCommandModelRef(
            params.cfg,
            explicitModelOverride,
            provider,
            params.modelManifestContext,
          )
      : explicitProviderOverride
        ? normalizeAgentCommandModelRef(
            params.cfg,
            explicitProviderOverride,
            model,
            params.modelManifestContext,
          )
        : null;
    if (!explicitRef) {
      throw new Error("Invalid model override.");
    }
    if (!visibilityPolicy.allowsKey(modelKey(explicitRef.provider, explicitRef.model))) {
      const rejectedKey = `${sanitizeForLog(explicitRef.provider)}/${sanitizeForLog(explicitRef.model)}`;
      const policyPath = visibilityPolicy.allowConfigPath ?? "modelPolicy.allow";
      const repairPath = visibilityPolicy.allowRepairConfigPath;
      throw new Error(
        `Model override "${rejectedKey}" is not allowed for agent "${params.sessionAgentId}" by ${policyPath}. Add "${rejectedKey}" or "${sanitizeForLog(explicitRef.provider)}/*" to ${repairPath}, or remove/empty the list to allow any model.`,
      );
    }
    provider = explicitRef.provider;
    model = explicitRef.model;
  }
  const allowedInitialSelection = visibilityPolicy.resolveSelection({ provider, model });
  if (!allowedInitialSelection) {
    const policyPath = visibilityPolicy.allowConfigPath ?? "modelPolicy.allow";
    throw new Error(
      `Configured default model "${modelKey(provider, model)}" is not allowed by ${policyPath}, and no allowed model is available.`,
    );
  }
  provider = allowedInitialSelection.provider;
  model = allowedInitialSelection.model;
  const providerForAuthProfileValidation = provider;
  let sessionEntryForAttempt = autoFallbackPrimaryProbeSessionEntry ?? sessionEntry;
  const initialAgentHarnessRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
    provider,
    entry: sessionEntryForAttempt,
    cfg: params.cfg,
  });
  await ensureSelectedAgentHarnessPlugin({
    config: params.cfg,
    provider,
    modelId: model,
    agentId: params.sessionAgentId,
    sessionKey: params.sessionKey,
    agentHarnessRuntimeOverride: initialAgentHarnessRuntimeOverride,
    workspaceDir: params.workspaceDir,
  });

  const authProfileId = sessionEntryForAttempt?.authProfileOverride;
  if (sessionEntryForAttempt && authProfileId) {
    const entry = sessionEntryForAttempt;
    const profile = ensureAuthProfileStore().profiles[authProfileId];
    const validationHarnessPolicy = resolveAvailableAgentHarnessPolicy({
      provider: providerForAuthProfileValidation,
      modelId: model,
      config: params.cfg,
      agentId: params.sessionAgentId,
      sessionKey: params.sessionKey,
    });
    const acceptedAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime({
      provider: providerForAuthProfileValidation,
      harnessRuntime: validationHarnessPolicy.runtime,
      config: params.cfg,
    }).map((candidateProvider) =>
      params.pluginsEnabled
        ? resolveProviderIdForAuth(candidateProvider, {
            config: params.cfg,
            workspaceDir: params.workspaceDir,
            ...(params.manifestMetadataSnapshot
              ? { metadataSnapshot: params.manifestMetadataSnapshot }
              : {}),
          })
        : candidateProvider,
    );
    const authAliasLookupParams = params.pluginsEnabled
      ? {
          config: params.cfg,
          workspaceDir: params.workspaceDir,
          ...(params.manifestMetadataSnapshot
            ? { metadataSnapshot: params.manifestMetadataSnapshot }
            : {}),
        }
      : {
          config: params.cfg,
          workspaceDir: params.workspaceDir,
          metadataSnapshot: { plugins: [] },
        };
    const profileMatchesRuntime =
      profile &&
      acceptedAuthProviders.some((candidateProvider) =>
        isStoredCredentialCompatibleWithAuthProvider({
          cfg: params.cfg,
          authAliasLookupParams,
          provider: candidateProvider,
          credential: profile,
        }),
      );
    if (!profileMatchesRuntime) {
      if (hasExplicitRunOverride || autoFallbackPrimaryProbe) {
        sessionEntryForAttempt = {
          ...entry,
          authProfileOverride: undefined,
          authProfileOverrideSource: undefined,
          authProfileOverrideCompactionCount: undefined,
        };
      } else if (
        params.sessionStore &&
        params.sessionKey &&
        !params.suppressVisibleSessionEffects
      ) {
        await clearSessionAuthProfileOverride({
          sessionEntry: entry,
          sessionStore: params.sessionStore,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        });
      }
    }
  }

  const catalogForThinking =
    allowedModelCatalog.length > 0
      ? allowedModelCatalog
      : modelCatalog && modelCatalog.length > 0
        ? modelCatalog
        : params.configuredThinkingCatalog;
  const thinkingCatalog = catalogForThinking.length > 0 ? catalogForThinking : undefined;
  const thinkingRuntime = resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider,
    modelId: model,
    agentId: params.sessionAgentId,
    sessionKey: params.sessionKey,
    sessionEntry: sessionEntryForAttempt,
  });
  const configuredThinkLevel = normalizeThinkLevel(
    resolveAgentConfig(params.cfg, params.sessionAgentId)?.thinkingDefault,
  );
  const immutableThinkLevel = params.requestedThinkLevel ?? configuredThinkLevel;
  const primaryThinkLevel =
    immutableThinkLevel ??
    resolveThinkingDefault({
      cfg: params.cfg,
      provider,
      model,
      catalog: thinkingCatalog,
      agentRuntime: thinkingRuntime,
    });
  if (
    !isThinkingLevelSupported({
      provider,
      model,
      level: primaryThinkLevel,
      catalog: thinkingCatalog,
      agentRuntime: thinkingRuntime,
    })
  ) {
    const explicitThink = Boolean(params.thinkOnce || params.thinkOverride);
    const isSubagentSpawnRun = params.isSubagentLane && isSubagentSessionKey(params.sessionKey);
    if (explicitThink && !isSubagentSpawnRun) {
      throw new Error(
        `Thinking level "${primaryThinkLevel}" is not supported for ${provider}/${model}. Use one of: ${formatThinkingLevels(provider, model, ", ", thinkingCatalog, thinkingRuntime)}.`,
      );
    }
  }
  if (
    params.thinkOverride &&
    params.sessionStore &&
    params.sessionKey &&
    !params.suppressVisibleSessionEffects
  ) {
    const now = Date.now();
    const entry = params.sessionStore[params.sessionKey] ??
      sessionEntry ?? { sessionId: params.sessionId, updatedAt: now, sessionStartedAt: now };
    const next: SessionEntry = {
      ...entry,
      sessionId: params.sessionId,
      updatedAt: now,
      sessionStartedAt: entry.sessionStartedAt ?? now,
      lastInteractionAt: now,
      thinkingLevel: params.thinkOverride,
    };
    sessionEntry =
      (await persistSessionEntry({
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        initialEntry: entry,
        entry: next,
      })) ?? sessionEntry;
    sessionEntryForAttempt = {
      ...(sessionEntryForAttempt ?? next),
      thinkingLevel: params.thinkOverride,
    };
  }

  const { resolveSessionTranscriptFile } = await loadTranscriptResolveRuntime();
  let sessionFile: string | undefined;
  if (params.sessionStore && params.sessionKey) {
    const resolvedSessionFile = await resolveSessionTranscriptFile({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionStore: params.suppressVisibleSessionEffects ? undefined : params.sessionStore,
      storePath: params.suppressVisibleSessionEffects ? undefined : params.storePath,
      sessionEntry,
      agentId: params.sessionAgentId,
      threadId: params.opts.threadId,
    });
    sessionFile = resolvedSessionFile.sessionFile;
    sessionEntry = resolvedSessionFile.sessionEntry;
  }
  if (!sessionFile) {
    const resolvedSessionFile = await resolveSessionTranscriptFile({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey ?? params.sessionId,
      storePath: params.storePath,
      sessionEntry,
      agentId: params.sessionAgentId,
      threadId: params.opts.threadId,
    });
    sessionFile = resolvedSessionFile.sessionFile;
    sessionEntry = resolvedSessionFile.sessionEntry;
  }

  return {
    sessionEntry,
    provider,
    model,
    defaultProvider,
    defaultModel,
    configuredDefaultAuthProfileId,
    providerForAuthProfileValidation,
    visibilityPolicy,
    hasExplicitRunOverride,
    storedProviderOverride,
    storedModelOverride,
    storedModelOverrideSource,
    hasStoredAutoFallbackProvenance,
    autoFallbackPrimaryProbe,
    sessionEntryForAttempt,
    thinkingCatalog,
    immutableThinkLevel,
    effectiveTurnThinkLevel: primaryThinkLevel,
    sessionFile,
  };
}

export type EmbeddedModelSelection = Awaited<ReturnType<typeof resolveEmbeddedModelSelection>>;

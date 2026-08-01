// Persists directive-derived session preferences such as model and auth choices.
import {
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { modelKey, type ModelAliasIndex } from "../../agents/model-selection.js";
import { resolveContextConfigProviderForRuntime } from "../../agents/openai-routing.js";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { applySessionModelSelectionToEntry } from "../../model-picker/apply-session-model-selection.js";
import {
  formatThinkingLevels,
  isThinkingLevelSupported,
  resolveSupportedThinkingLevel,
} from "../thinking.js";
import {
  applyModelRuntimeDirective,
  resolveModelRuntimeDirective,
} from "./directive-handling.model-runtime.js";
import { resolveModelSelectionFromDirective } from "./directive-handling.model-selection.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import {
  applySessionDirectiveFields,
  canPersistSessionDirectiveDefaults,
  enqueueModeSwitchEvents,
  persistSessionDirectiveSnapshot,
  resolveDirectiveTouchedSessionFields,
} from "./directive-handling.shared.js";
import type { ThinkLevel } from "./directives.js";
import { resolveContextTokens } from "./model-selection.js";
import { refreshQueuedFollowupSession } from "./queue.js";

type PersistedThinkingLevelRemap = {
  from: ThinkLevel;
  to: ThinkLevel;
  provider: string;
  model: string;
};

export async function persistInlineDirectives(params: {
  directives: InlineDirectives;
  effectiveModelDirective?: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
  provider: string;
  model: string;
  initialModelLabel: string;
  formatModelSwitchEvent: (label: string, alias?: string) => string;
  canPersistStickyModelSelection?: boolean;
  agentCfg: NonNullable<OpenClawConfig["agents"]>["defaults"] | undefined;
  messageProvider?: string;
  surface?: string;
  gatewayClientScopes?: string[];
  commandAuthorized?: boolean;
  senderIsOwner?: boolean;
  markLiveSwitchPending?: boolean;
  modelCatalog?: ModelCatalogEntry[];
  thinkingCatalog?: ModelCatalogEntry[];
}): Promise<{
  provider: string;
  model: string;
  contextTokens: number;
  sessionChangesApplied: boolean;
  thinkingRemap?: PersistedThinkingLevelRemap;
  errorText?: string;
  runtimeChange?: { kind: "clear" } | { kind: "set"; runtime: string };
}> {
  const {
    directives,
    cfg,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    elevatedEnabled,
    elevatedAllowed,
    defaultProvider,
    defaultModel,
    aliasIndex,
    allowedModelKeys,
    initialModelLabel,
    formatModelSwitchEvent,
    agentCfg,
  } = params;
  let { provider, model } = params;
  let thinkingRemap: PersistedThinkingLevelRemap | undefined;
  let sessionChangesApplied = true;
  const allowPrivilegedPersistence = canPersistSessionDirectiveDefaults({
    messageProvider: params.messageProvider,
    surface: params.surface,
    gatewayClientScopes: params.gatewayClientScopes,
    commandAuthorized: params.commandAuthorized,
    senderIsOwner: params.senderIsOwner,
  });
  const touchedSessionFields = resolveDirectiveTouchedSessionFields({
    directives,
    allowPrivilegedPersistence,
  });
  const thinkingCatalog =
    params.thinkingCatalog && params.thinkingCatalog.length > 0
      ? params.thinkingCatalog
      : undefined;
  const delegatedTraceAllowed = (params.gatewayClientScopes ?? []).includes("operator.admin");
  const activeAgentId = sessionKey
    ? resolveSessionAgentId({ sessionKey, config: cfg })
    : resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, activeAgentId) ?? params.agentDir;
  const modelDirective =
    directives.hasModelDirective && params.effectiveModelDirective
      ? params.effectiveModelDirective
      : undefined;
  const modelResolution = modelDirective
    ? resolveModelSelectionFromDirective({
        directives: {
          ...directives,
          hasModelDirective: true,
          rawModelDirective: modelDirective,
        },
        cfg,
        agentDir,
        defaultProvider,
        defaultModel,
        aliasIndex,
        allowedModelKeys,
        allowedModelCatalog: params.modelCatalog ?? [],
        provider,
        agentId: activeAgentId,
      })
    : undefined;
  const modelRuntimeResolution = modelResolution?.modelSelection
    ? resolveModelRuntimeDirective({
        rawRuntime: directives.rawModelRuntime,
        provider: modelResolution.modelSelection.provider,
        cfg,
        sessionEntry,
      })
    : ({ kind: "unchanged" } as const);
  let thinkingErrorText: string | undefined;
  if (directives.hasThinkDirective && directives.thinkLevel) {
    const resolvedProvider = modelResolution?.modelSelection?.provider ?? provider;
    const resolvedModel = modelResolution?.modelSelection?.model ?? model;
    const prospectiveSessionEntry = { ...sessionEntry };
    applyModelRuntimeDirective(prospectiveSessionEntry, modelRuntimeResolution);
    const prospectiveThinkingRuntime = resolveEffectiveAgentRuntime({
      cfg,
      provider: resolvedProvider,
      modelId: resolvedModel,
      agentId: activeAgentId,
      sessionKey,
      sessionEntry: prospectiveSessionEntry,
    });
    if (
      !isThinkingLevelSupported({
        provider: resolvedProvider,
        model: resolvedModel,
        level: directives.thinkLevel,
        catalog: thinkingCatalog,
        agentRuntime: prospectiveThinkingRuntime,
      })
    ) {
      thinkingErrorText = `Thinking level "${directives.thinkLevel}" is not supported for ${resolvedProvider}/${resolvedModel}. Use one of: ${formatThinkingLevels(resolvedProvider, resolvedModel, ", ", thinkingCatalog, prospectiveThinkingRuntime)}.`;
    }
  }
  const errorText =
    modelResolution?.errorText ??
    (modelRuntimeResolution.kind === "invalid" ? modelRuntimeResolution.errorText : undefined) ??
    thinkingErrorText;
  let modelRuntimeApplied = false;

  if (!errorText && sessionEntry && sessionStore && sessionKey) {
    const initialSessionEntry = { ...sessionEntry };
    const appliedSessionEntry = sessionEntry;
    const elevatedChanged =
      directives.hasElevatedDirective &&
      directives.elevatedLevel !== undefined &&
      elevatedEnabled &&
      elevatedAllowed;
    const reasoningChanged =
      directives.hasReasoningDirective && directives.reasoningLevel !== undefined;
    let updated = applySessionDirectiveFields({
      directives,
      sessionEntry,
      allowPrivilegedPersistence,
      allowTracePersistence: params.senderIsOwner === true || delegatedTraceAllowed,
      allowElevatedPersistence: elevatedEnabled && elevatedAllowed,
      persistDirectiveOnlyFields: false,
    });

    let modelUpdated = false;
    let modelApplied = true;
    let modelSwitchEvent: { alias?: string; label: string } | undefined;
    if (modelDirective && modelResolution?.modelSelection) {
      if (modelRuntimeResolution.kind === "invalid") {
        throw new Error("invalid model runtime reached persistence");
      }
      const appliedSelection = applySessionModelSelectionToEntry({
        entry: sessionEntry,
        request: {
          ...modelResolution.modelSelection,
          profileOverride: modelResolution.profileOverride,
          runtime: modelRuntimeResolution,
        },
        runtime: modelRuntimeResolution,
        markLiveSwitchPending: params.markLiveSwitchPending,
      });
      modelUpdated = appliedSelection.changed;
      provider = modelResolution.modelSelection.provider;
      model = modelResolution.modelSelection.model;
      const thinkingRuntime = resolveEffectiveAgentRuntime({
        cfg,
        provider,
        modelId: model,
        agentId: activeAgentId,
        sessionKey,
        sessionEntry,
      });
      const currentThinkingLevel = sessionEntry.thinkingLevel as ThinkLevel | undefined;
      if (
        currentThinkingLevel &&
        !directives.hasThinkDirective &&
        !isThinkingLevelSupported({
          provider,
          model,
          level: currentThinkingLevel,
          catalog: thinkingCatalog,
          agentRuntime: thinkingRuntime,
        })
      ) {
        const remappedThinkingLevel = resolveSupportedThinkingLevel({
          provider,
          model,
          level: currentThinkingLevel,
          catalog: thinkingCatalog,
          agentRuntime: thinkingRuntime,
        });
        if (remappedThinkingLevel !== currentThinkingLevel) {
          sessionEntry.thinkingLevel = remappedThinkingLevel;
          thinkingRemap = {
            from: currentThinkingLevel,
            to: remappedThinkingLevel,
            provider,
            model,
          };
        }
      }
      const nextLabel = `${provider}/${model}`;
      if (nextLabel !== initialModelLabel) {
        modelSwitchEvent = {
          label: nextLabel,
          ...(modelResolution.modelSelection.alias
            ? { alias: modelResolution.modelSelection.alias }
            : {}),
        };
      }
      // Explicit model selections must still perform the atomic persisted
      // winner check when their value matches the local snapshot.
      updated = true;
    }
    if (updated) {
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        const persistence = await persistSessionDirectiveSnapshot({
          storePath,
          sessionKey,
          initialEntry: initialSessionEntry,
          sessionEntry,
          sessionStore,
          hasModelSelection: Boolean(modelDirective),
          reassertLiveModelSwitchPending:
            modelUpdated &&
            params.markLiveSwitchPending === true &&
            sessionEntry.liveModelSwitchPending === true,
          touchedFields: touchedSessionFields,
        });
        sessionChangesApplied = persistence.sessionChangesApplied;
        modelApplied = persistence.modelSelectionApplied;
      }
      if (modelDirective && !modelApplied) {
        sessionChangesApplied = false;
        const persistedEntry = sessionStore[sessionKey];
        provider = persistedEntry?.providerOverride?.trim() || defaultProvider;
        model = persistedEntry?.modelOverride?.trim() || defaultModel;
        thinkingRemap = undefined;
      }
      if (
        modelDirective &&
        modelResolution?.modelSelection &&
        modelApplied &&
        !modelResolution.modelSelection.isDefault &&
        params.canPersistStickyModelSelection === true
      ) {
        persistStickyModelSelectionBestEffort({
          agentId: activeAgentId,
          model: `${provider}/${model}`,
        });
      }
      if (modelDirective && modelUpdated && modelApplied) {
        triggerSessionPatchHook({
          cfg,
          sessionEntry: appliedSessionEntry,
          sessionKey,
          patch: { key: sessionKey, model: modelDirective },
        });
        refreshQueuedFollowupSession({
          key: sessionKey,
          nextProvider: provider,
          nextModel: model,
          nextRouteResolution: "resolved",
          nextModelOverrideSource: "user",
          nextAuthProfileId: appliedSessionEntry.authProfileOverride,
          nextAuthProfileIdSource: appliedSessionEntry.authProfileOverrideSource,
          nextThinking: {
            level: appliedSessionEntry.thinkingLevel,
            catalog: thinkingCatalog,
            agentRuntime: resolveEffectiveAgentRuntime({
              cfg,
              provider,
              modelId: model,
              agentId: activeAgentId,
              sessionKey,
              sessionEntry: appliedSessionEntry,
            }),
          },
        });
      }
      if (sessionChangesApplied) {
        enqueueModeSwitchEvents({
          enqueueSystemEvent,
          sessionEntry: appliedSessionEntry,
          sessionKey,
          elevatedChanged,
          reasoningChanged,
        });
      }
    }
    modelRuntimeApplied =
      modelApplied &&
      (modelRuntimeResolution.kind === "clear" || modelRuntimeResolution.kind === "set");
    if (modelSwitchEvent && modelApplied) {
      enqueueSystemEvent(formatModelSwitchEvent(modelSwitchEvent.label, modelSwitchEvent.alias), {
        sessionKey,
        contextKey: `model:${modelSwitchEvent.label}`,
      });
    }
  }

  const selectedCatalogEntry = params.modelCatalog?.find(
    (entry) => modelKey(entry.provider, entry.id) === modelKey(provider, model),
  );
  return {
    provider,
    model,
    thinkingRemap,
    errorText,
    runtimeChange:
      modelRuntimeApplied &&
      (modelRuntimeResolution.kind === "clear" || modelRuntimeResolution.kind === "set")
        ? modelRuntimeResolution
        : undefined,
    sessionChangesApplied,
    contextTokens: resolveContextTokens({
      cfg,
      agentCfg,
      provider: resolveContextConfigProviderForRuntime({
        provider,
        runtimeId: resolveAgentHarnessPolicy({
          provider,
          modelId: model,
          config: cfg,
          agentId: activeAgentId,
          sessionKey,
        }).runtime,
        config: cfg,
      }),
      model,
      modelContextWindow: selectedCatalogEntry?.contextWindow,
      modelContextTokens: selectedCatalogEntry?.contextTokens,
    }),
  };
}

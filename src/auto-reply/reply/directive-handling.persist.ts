import {
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/selection.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { listLegacyRuntimeModelProviderAliases } from "../../agents/model-runtime-aliases.js";
import { normalizeProviderId, type ModelAliasIndex } from "../../agents/model-selection.js";
import { updateSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { applyTraceOverride, applyVerboseOverride } from "../../sessions/level-overrides.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { isThinkingLevelSupported, resolveSupportedThinkingLevel } from "../thinking.js";
import { resolveModelSelectionFromDirective } from "./directive-handling.model-selection.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import {
  canPersistInternalExecDirective,
  canPersistInternalVerboseDirective,
  enqueueModeSwitchEvents,
} from "./directive-handling.shared.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel } from "./directives.js";
import { resolveContextTokens } from "./model-selection.js";

export type PersistedThinkingLevelRemap = {
  from: ThinkLevel;
  to: ThinkLevel;
  provider: string;
  model: string;
};

const MODEL_RUNTIME_CLEAR_VALUES = new Set(["auto", "default"]);

function resolveModelRuntimeOverride(params: {
  rawRuntime?: string;
  provider: string;
}):
  | { kind: "clear" }
  | { kind: "set"; runtime: string }
  | { kind: "invalid"; runtime: string }
  | undefined {
  const rawRuntime = params.rawRuntime?.trim();
  if (!rawRuntime) {
    return undefined;
  }

  const runtime = normalizeProviderId(rawRuntime);
  if (MODEL_RUNTIME_CLEAR_VALUES.has(runtime)) {
    return { kind: "clear" };
  }
  if (runtime === "pi") {
    return { kind: "set", runtime: "pi" };
  }

  const provider = normalizeProviderId(params.provider);
  for (const alias of listLegacyRuntimeModelProviderAliases()) {
    if (normalizeProviderId(alias.provider) !== provider) {
      continue;
    }
    const aliasRuntime = normalizeProviderId(alias.runtime);
    if (runtime === aliasRuntime || (aliasRuntime === "codex" && runtime === "codex-app-server")) {
      return { kind: "set", runtime: alias.runtime };
    }
  }

  return { kind: "invalid", runtime: rawRuntime };
}

function resolveContextConfigProviderForRuntime(params: {
  provider: string;
  runtimeId?: string;
}): string {
  const provider = normalizeProviderId(params.provider);
  const runtimeId = normalizeProviderId(params.runtimeId ?? "");
  if (provider === "openai" && runtimeId === "codex") {
    return "openai-codex";
  }
  return params.provider;
}

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
  agentCfg: NonNullable<OpenClawConfig["agents"]>["defaults"] | undefined;
  messageProvider?: string;
  surface?: string;
  gatewayClientScopes?: string[];
  senderIsOwner?: boolean;
  markLiveSwitchPending?: boolean;
  thinkingCatalog?: ModelCatalogEntry[];
}): Promise<{
  provider: string;
  model: string;
  contextTokens: number;
  thinkingRemap?: PersistedThinkingLevelRemap;
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
  const allowInternalExecPersistence = canPersistInternalExecDirective({
    messageProvider: params.messageProvider,
    surface: params.surface,
    gatewayClientScopes: params.gatewayClientScopes,
  });
  const allowInternalVerbosePersistence = canPersistInternalVerboseDirective({
    messageProvider: params.messageProvider,
    surface: params.surface,
    gatewayClientScopes: params.gatewayClientScopes,
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

  if (sessionEntry && sessionStore && sessionKey) {
    const prevElevatedLevel =
      (sessionEntry.elevatedLevel as ElevatedLevel | undefined) ??
      (agentCfg?.elevatedDefault as ElevatedLevel | undefined) ??
      (elevatedAllowed ? ("on" as ElevatedLevel) : ("off" as ElevatedLevel));
    const prevReasoningLevel = (sessionEntry.reasoningLevel as ReasoningLevel | undefined) ?? "off";
    let elevatedChanged =
      directives.hasElevatedDirective &&
      directives.elevatedLevel !== undefined &&
      elevatedEnabled &&
      elevatedAllowed;
    let reasoningChanged =
      directives.hasReasoningDirective && directives.reasoningLevel !== undefined;
    let updated = false;

    if (directives.clearThinkLevel) {
      if (sessionEntry.thinkingLevel) {
        delete sessionEntry.thinkingLevel;
        updated = true;
      }
    } else if (directives.hasThinkDirective && directives.thinkLevel) {
      sessionEntry.thinkingLevel = directives.thinkLevel;
      updated = true;
    }
    if (directives.clearFastMode) {
      if (sessionEntry.fastMode !== undefined) {
        delete sessionEntry.fastMode;
        updated = true;
      }
    }
    if (
      directives.hasVerboseDirective &&
      directives.verboseLevel &&
      allowInternalVerbosePersistence
    ) {
      applyVerboseOverride(sessionEntry, directives.verboseLevel);
      updated = true;
    }
    if (
      directives.hasTraceDirective &&
      directives.traceLevel &&
      (params.senderIsOwner || delegatedTraceAllowed)
    ) {
      applyTraceOverride(sessionEntry, directives.traceLevel);
      updated = true;
    }
    if (directives.hasReasoningDirective && directives.reasoningLevel) {
      if (directives.reasoningLevel === "off") {
        // Persist explicit off so it overrides model-capability defaults.
        sessionEntry.reasoningLevel = "off";
      } else {
        sessionEntry.reasoningLevel = directives.reasoningLevel;
      }
      reasoningChanged =
        reasoningChanged ||
        (directives.reasoningLevel !== prevReasoningLevel &&
          directives.reasoningLevel !== undefined);
      updated = true;
    }
    if (
      directives.hasElevatedDirective &&
      directives.elevatedLevel &&
      elevatedEnabled &&
      elevatedAllowed
    ) {
      // Persist "off" explicitly so inline `/elevated off` overrides defaults.
      sessionEntry.elevatedLevel = directives.elevatedLevel;
      elevatedChanged =
        elevatedChanged ||
        (directives.elevatedLevel !== prevElevatedLevel && directives.elevatedLevel !== undefined);
      updated = true;
    }
    if (directives.hasExecDirective && directives.hasExecOptions && allowInternalExecPersistence) {
      if (directives.execHost) {
        sessionEntry.execHost = directives.execHost;
        updated = true;
      }
      if (directives.execSecurity) {
        sessionEntry.execSecurity = directives.execSecurity;
        updated = true;
      }
      if (directives.execAsk) {
        sessionEntry.execAsk = directives.execAsk;
        updated = true;
      }
      if (directives.execNode) {
        sessionEntry.execNode = directives.execNode;
        updated = true;
      }
    }

    const modelDirective =
      directives.hasModelDirective && params.effectiveModelDirective
        ? params.effectiveModelDirective
        : undefined;
    if (modelDirective) {
      const modelResolution = resolveModelSelectionFromDirective({
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
        allowedModelCatalog: [],
        provider,
      });
      if (modelResolution.modelSelection) {
        const { updated: modelUpdated } = applyModelOverrideToSessionEntry({
          entry: sessionEntry,
          selection: modelResolution.modelSelection,
          profileOverride: modelResolution.profileOverride,
          markLiveSwitchPending: params.markLiveSwitchPending,
        });
        const runtimeOverride = resolveModelRuntimeOverride({
          rawRuntime: directives.rawModelRuntime,
          provider: modelResolution.modelSelection.provider,
        });
        if (runtimeOverride?.kind === "clear") {
          if (sessionEntry.agentRuntimeOverride) {
            delete sessionEntry.agentRuntimeOverride;
            updated = true;
          }
        } else if (runtimeOverride?.kind === "set") {
          if (sessionEntry.agentRuntimeOverride) {
            delete sessionEntry.agentRuntimeOverride;
            updated = true;
          }
          enqueueSystemEvent(
            `Ignored session runtime ${runtimeOverride.runtime}; configure provider or model runtime policy instead.`,
            {
              sessionKey,
              contextKey: `model-runtime:${modelResolution.modelSelection.provider}:${runtimeOverride.runtime}:ignored-session-runtime`,
            },
          );
        } else if (runtimeOverride?.kind === "invalid") {
          if (sessionEntry.agentRuntimeOverride) {
            delete sessionEntry.agentRuntimeOverride;
            updated = true;
          }
          enqueueSystemEvent(
            `Ignored unsupported runtime ${runtimeOverride.runtime} for ${modelResolution.modelSelection.provider}.`,
            {
              sessionKey,
              contextKey: `model-runtime:${modelResolution.modelSelection.provider}:${runtimeOverride.runtime}`,
            },
          );
        }
        provider = modelResolution.modelSelection.provider;
        model = modelResolution.modelSelection.model;
        const currentThinkingLevel = sessionEntry.thinkingLevel as ThinkLevel | undefined;
        if (
          currentThinkingLevel &&
          !directives.hasThinkDirective &&
          !isThinkingLevelSupported({
            provider,
            model,
            level: currentThinkingLevel,
            catalog: thinkingCatalog,
          })
        ) {
          const remappedThinkingLevel = resolveSupportedThinkingLevel({
            provider,
            model,
            level: currentThinkingLevel,
            catalog: thinkingCatalog,
          });
          if (remappedThinkingLevel !== currentThinkingLevel) {
            sessionEntry.thinkingLevel = remappedThinkingLevel;
            thinkingRemap = {
              from: currentThinkingLevel,
              to: remappedThinkingLevel,
              provider,
              model,
            };
            updated = true;
          }
        }
        const nextLabel = `${provider}/${model}`;
        if (nextLabel !== initialModelLabel) {
          enqueueSystemEvent(
            formatModelSwitchEvent(nextLabel, modelResolution.modelSelection.alias),
            {
              sessionKey,
              contextKey: `model:${nextLabel}`,
            },
          );
        }
        updated = updated || modelUpdated;
      }
    }
    if (directives.hasQueueDirective && directives.queueReset) {
      delete sessionEntry.queueMode;
      delete sessionEntry.queueDebounceMs;
      delete sessionEntry.queueCap;
      delete sessionEntry.queueDrop;
      updated = true;
    }

    if (updated) {
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        await updateSessionStore(storePath, (store) => {
          store[sessionKey] = sessionEntry;
        });
      }
      enqueueModeSwitchEvents({
        enqueueSystemEvent,
        sessionEntry,
        sessionKey,
        elevatedChanged,
        reasoningChanged,
      });
    }
  }

  return {
    provider,
    model,
    thinkingRemap,
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
      }),
      model,
    }),
  };
}

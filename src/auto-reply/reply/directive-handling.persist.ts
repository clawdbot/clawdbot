import {
  resolveAgentDir,
  resolveAgentModelPrimary,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  buildModelAliasIndex,
  type ModelAliasIndex,
  modelKey,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { type SessionEntry, updateSessionStore } from "../../config/sessions.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { applyVerboseOverride } from "../../sessions/level-overrides.js";
import { resolveProfileOverride } from "./directive-handling.auth.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { formatElevatedEvent, formatReasoningEvent } from "./directive-handling.shared.js";
import type { ElevatedLevel, ReasoningLevel } from "./directives.js";

export async function persistInlineDirectives(params: {
  directives: InlineDirectives;
  effectiveModelDirective?: string;
  cfg: ClawdbotConfig;
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
  agentCfg: NonNullable<ClawdbotConfig["agents"]>["defaults"] | undefined;
}): Promise<{ provider: string; model: string; contextTokens: number }> {
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
  const activeAgentId = sessionKey
    ? resolveSessionAgentId({ sessionKey, config: cfg })
    : resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, activeAgentId);

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

    if (directives.hasThinkDirective && directives.thinkLevel) {
      if (directives.thinkLevel === "off") {
        delete sessionEntry.thinkingLevel;
      } else {
        sessionEntry.thinkingLevel = directives.thinkLevel;
      }
      updated = true;
    }
    if (directives.hasVerboseDirective && directives.verboseLevel) {
      applyVerboseOverride(sessionEntry, directives.verboseLevel);
      updated = true;
    }
    if (directives.hasReasoningDirective && directives.reasoningLevel) {
      if (directives.reasoningLevel === "off") {
        delete sessionEntry.reasoningLevel;
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
    if (directives.hasExecDirective && directives.hasExecOptions) {
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
      const resolved = resolveModelRefFromString({
        raw: modelDirective,
        defaultProvider,
        aliasIndex,
      });
      if (resolved) {
        const key = modelKey(resolved.ref.provider, resolved.ref.model);
        if (allowedModelKeys.size === 0 || allowedModelKeys.has(key)) {
          let profileOverride: string | undefined;
          if (directives.rawModelProfile) {
            const profileResolved = resolveProfileOverride({
              rawProfile: directives.rawModelProfile,
              provider: resolved.ref.provider,
              cfg,
              agentDir,
            });
            if (profileResolved.error) {
              throw new Error(profileResolved.error);
            }
            profileOverride = profileResolved.profileId;
          }
          const isDefault =
            resolved.ref.provider === defaultProvider && resolved.ref.model === defaultModel;
          if (isDefault) {
            delete sessionEntry.providerOverride;
            delete sessionEntry.modelOverride;
          } else {
            sessionEntry.providerOverride = resolved.ref.provider;
            sessionEntry.modelOverride = resolved.ref.model;
          }
          if (profileOverride) {
            sessionEntry.authProfileOverride = profileOverride;
            sessionEntry.authProfileOverrideSource = "user";
            delete sessionEntry.authProfileOverrideCompactionCount;
          } else if (directives.hasModelDirective) {
            delete sessionEntry.authProfileOverride;
            delete sessionEntry.authProfileOverrideSource;
            delete sessionEntry.authProfileOverrideCompactionCount;
          }
          provider = resolved.ref.provider;
          model = resolved.ref.model;
          const nextLabel = `${provider}/${model}`;
          if (nextLabel !== initialModelLabel) {
            enqueueSystemEvent(formatModelSwitchEvent(nextLabel, resolved.alias), {
              sessionKey,
              contextKey: `model:${nextLabel}`,
            });
          }
          updated = true;
        }
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
      if (elevatedChanged) {
        const nextElevated = (sessionEntry.elevatedLevel ?? "off") as ElevatedLevel;
        enqueueSystemEvent(formatElevatedEvent(nextElevated), {
          sessionKey,
          contextKey: "mode:elevated",
        });
      }
      if (reasoningChanged) {
        const nextReasoning = (sessionEntry.reasoningLevel ?? "off") as ReasoningLevel;
        enqueueSystemEvent(formatReasoningEvent(nextReasoning), {
          sessionKey,
          contextKey: "mode:reasoning",
        });
      }
    }
  }

  return {
    provider,
    model,
    contextTokens: agentCfg?.contextTokens ?? lookupContextTokens(model) ?? DEFAULT_CONTEXT_TOKENS,
  };
}

export function resolveDefaultModel(params: { cfg: ClawdbotConfig; agentId?: string }): {
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
} {
  const agentModelOverride = params.agentId
    ? resolveAgentModelPrimary(params.cfg, params.agentId)
    : undefined;
  const cfg =
    agentModelOverride && agentModelOverride.length > 0
      ? {
          ...params.cfg,
          agents: {
            ...params.cfg.agents,
            defaults: {
              ...params.cfg.agents?.defaults,
              model: {
                ...(typeof params.cfg.agents?.defaults?.model === "object"
                  ? params.cfg.agents.defaults.model
                  : undefined),
                primary: agentModelOverride,
              },
            },
          },
        }
      : params.cfg;
  const mainModel = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const defaultProvider = mainModel.provider;
  const defaultModel = mainModel.model;
  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider,
  });
  return { defaultProvider, defaultModel, aliasIndex };
}

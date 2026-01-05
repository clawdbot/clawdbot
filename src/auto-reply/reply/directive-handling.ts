import { getEnvApiKey } from "@mariozechner/pi-ai";
import { discoverAuthStorage } from "@mariozechner/pi-coding-agent";
import { resolveClawdbotAgentDir } from "../../agents/agent-paths.js";
import { lookupContextTokens } from "../../agents/context.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "../../agents/defaults.js";
import { hydrateAuthStorage } from "../../agents/model-auth.js";
import {
  buildModelAliasIndex,
  type ModelAliasIndex,
  modelKey,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { type SessionEntry, saveSessionStore } from "../../config/sessions.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { extractModelDirective } from "../model.js";
import type { MsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import {
  type ElevatedLevel,
  extractElevatedDirective,
  extractStatusDirective,
  extractThinkDirective,
  extractVerboseDirective,
  type ThinkLevel,
  type VerboseLevel,
} from "./directives.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import {
  type ModelDirectiveSelection,
  resolveModelDirectiveSelection,
} from "./model-selection.js";
import {
  extractQueueDirective,
  type QueueDropPolicy,
  type QueueMode,
} from "./queue.js";

const SYSTEM_MARK = "⚙️";

const maskApiKey = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "missing";
  if (trimmed.length <= 16) return trimmed;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-8)}`;
};

const resolveAuthLabel = async (
  provider: string,
  authStorage: ReturnType<typeof discoverAuthStorage>,
): Promise<string> => {
  const stored = authStorage.get(provider);
  if (stored?.type === "oauth") {
    const email = stored.email?.trim();
    return email ? `OAuth ${email}` : "OAuth (unknown)";
  }
  if (stored?.type === "api_key") {
    return maskApiKey(stored.key);
  }
  const envKey = getEnvApiKey(provider);
  if (envKey) return maskApiKey(envKey);
  if (provider === "anthropic") {
    const oauthEnv = process.env.ANTHROPIC_OAUTH_TOKEN?.trim();
    if (oauthEnv) return "OAuth (env)";
  }
  try {
    const key = await authStorage.getApiKey(provider);
    if (key) return maskApiKey(key);
  } catch {
    // ignore missing auth
  }
  return "missing";
};

export type InlineDirectives = {
  cleaned: string;
  hasThinkDirective: boolean;
  thinkLevel?: ThinkLevel;
  rawThinkLevel?: string;
  hasVerboseDirective: boolean;
  verboseLevel?: VerboseLevel;
  rawVerboseLevel?: string;
  hasElevatedDirective: boolean;
  elevatedLevel?: ElevatedLevel;
  rawElevatedLevel?: string;
  hasStatusDirective: boolean;
  hasModelDirective: boolean;
  rawModelDirective?: string;
  hasQueueDirective: boolean;
  queueMode?: QueueMode;
  queueReset: boolean;
  rawQueueMode?: string;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
  rawDebounce?: string;
  rawCap?: string;
  rawDrop?: string;
  hasQueueOptions: boolean;
};

export function parseInlineDirectives(body: string): InlineDirectives {
  const {
    cleaned: thinkCleaned,
    thinkLevel,
    rawLevel: rawThinkLevel,
    hasDirective: hasThinkDirective,
  } = extractThinkDirective(body);
  const {
    cleaned: verboseCleaned,
    verboseLevel,
    rawLevel: rawVerboseLevel,
    hasDirective: hasVerboseDirective,
  } = extractVerboseDirective(thinkCleaned);
  const {
    cleaned: elevatedCleaned,
    elevatedLevel,
    rawLevel: rawElevatedLevel,
    hasDirective: hasElevatedDirective,
  } = extractElevatedDirective(verboseCleaned);
  const { cleaned: statusCleaned, hasDirective: hasStatusDirective } =
    extractStatusDirective(elevatedCleaned);
  const {
    cleaned: modelCleaned,
    rawModel,
    hasDirective: hasModelDirective,
  } = extractModelDirective(statusCleaned);
  const {
    cleaned: queueCleaned,
    queueMode,
    queueReset,
    rawMode,
    debounceMs,
    cap,
    dropPolicy,
    rawDebounce,
    rawCap,
    rawDrop,
    hasDirective: hasQueueDirective,
    hasOptions: hasQueueOptions,
  } = extractQueueDirective(modelCleaned);

  return {
    cleaned: queueCleaned,
    hasThinkDirective,
    thinkLevel,
    rawThinkLevel,
    hasVerboseDirective,
    verboseLevel,
    rawVerboseLevel,
    hasElevatedDirective,
    elevatedLevel,
    rawElevatedLevel,
    hasStatusDirective,
    hasModelDirective,
    rawModelDirective: rawModel,
    hasQueueDirective,
    queueMode,
    queueReset,
    rawQueueMode: rawMode,
    debounceMs,
    cap,
    dropPolicy,
    rawDebounce,
    rawCap,
    rawDrop,
    hasQueueOptions,
  };
}

export function isDirectiveOnly(params: {
  directives: InlineDirectives;
  cleanedBody: string;
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  isGroup: boolean;
}): boolean {
  const { directives, cleanedBody, ctx, cfg, isGroup } = params;
  if (
    !directives.hasThinkDirective &&
    !directives.hasVerboseDirective &&
    !directives.hasElevatedDirective &&
    !directives.hasModelDirective &&
    !directives.hasQueueDirective
  )
    return false;
  const stripped = stripStructuralPrefixes(cleanedBody ?? "");
  const noMentions = isGroup ? stripMentions(stripped, ctx, cfg) : stripped;
  return noMentions.length === 0;
}

export async function handleDirectiveOnly(params: {
  directives: InlineDirectives;
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
  allowedModelCatalog: Awaited<
    ReturnType<typeof import("../../agents/model-catalog.js").loadModelCatalog>
  >;
  resetModelOverride: boolean;
  provider: string;
  model: string;
  initialModelLabel: string;
  formatModelSwitchEvent: (label: string, alias?: string) => string;
}): Promise<ReplyPayload | undefined> {
  const {
    directives,
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
    allowedModelCatalog,
    resetModelOverride,
    initialModelLabel,
    formatModelSwitchEvent,
  } = params;

  if (directives.hasModelDirective) {
    const isModelListAlias =
      directives.rawModelDirective?.trim().toLowerCase() === "status";
    if (!directives.rawModelDirective || isModelListAlias) {
      if (allowedModelCatalog.length === 0) {
        return { text: "No models available." };
      }
      const authStorage = discoverAuthStorage(resolveClawdbotAgentDir());
      hydrateAuthStorage(authStorage);
      const authByProvider = new Map<string, string>();
      for (const entry of allowedModelCatalog) {
        if (authByProvider.has(entry.provider)) continue;
        authByProvider.set(
          entry.provider,
          await resolveAuthLabel(entry.provider, authStorage),
        );
      }
      const current = `${params.provider}/${params.model}`;
      const defaultLabel = `${defaultProvider}/${defaultModel}`;
      const header =
        current === defaultLabel
          ? `Models (current: ${current}):`
          : `Models (current: ${current}, default: ${defaultLabel}):`;
      const lines = [header];
      if (resetModelOverride) {
        lines.push(`(previous selection reset to default)`);
      }
      for (const entry of allowedModelCatalog) {
        const label = `${entry.provider}/${entry.id}`;
        const aliases = aliasIndex.byKey.get(label);
        const aliasSuffix =
          aliases && aliases.length > 0
            ? ` (alias: ${aliases.join(", ")})`
            : "";
        const nameSuffix =
          entry.name && entry.name !== entry.id ? ` — ${entry.name}` : "";
        const authLabel = authByProvider.get(entry.provider) ?? "missing";
        const authSuffix = ` — auth: ${authLabel}`;
        lines.push(`- ${label}${aliasSuffix}${nameSuffix}${authSuffix}`);
      }
      return { text: lines.join("\n") };
    }
  }

  if (directives.hasThinkDirective && !directives.thinkLevel) {
    return {
      text: `Unrecognized thinking level "${directives.rawThinkLevel ?? ""}". Valid levels: off, minimal, low, medium, high.`,
    };
  }
  if (directives.hasVerboseDirective && !directives.verboseLevel) {
    return {
      text: `Unrecognized verbose level "${directives.rawVerboseLevel ?? ""}". Valid levels: off, on.`,
    };
  }
  if (directives.hasElevatedDirective && !directives.elevatedLevel) {
    return {
      text: `Unrecognized elevated level "${directives.rawElevatedLevel ?? ""}". Valid levels: off, on.`,
    };
  }
  if (
    directives.hasElevatedDirective &&
    (!elevatedEnabled || !elevatedAllowed)
  ) {
    return { text: "elevated is not available right now." };
  }

  const queueModeInvalid =
    directives.hasQueueDirective &&
    !directives.queueMode &&
    !directives.queueReset &&
    Boolean(directives.rawQueueMode);
  const queueDebounceInvalid =
    directives.hasQueueDirective &&
    directives.rawDebounce !== undefined &&
    typeof directives.debounceMs !== "number";
  const queueCapInvalid =
    directives.hasQueueDirective &&
    directives.rawCap !== undefined &&
    typeof directives.cap !== "number";
  const queueDropInvalid =
    directives.hasQueueDirective &&
    directives.rawDrop !== undefined &&
    !directives.dropPolicy;
  if (
    queueModeInvalid ||
    queueDebounceInvalid ||
    queueCapInvalid ||
    queueDropInvalid
  ) {
    const errors: string[] = [];
    if (queueModeInvalid) {
      errors.push(
        `Unrecognized queue mode "${directives.rawQueueMode ?? ""}". Valid modes: steer, followup, collect, steer+backlog, interrupt.`,
      );
    }
    if (queueDebounceInvalid) {
      errors.push(
        `Invalid debounce "${directives.rawDebounce ?? ""}". Use ms/s/m (e.g. debounce:1500ms, debounce:2s).`,
      );
    }
    if (queueCapInvalid) {
      errors.push(
        `Invalid cap "${directives.rawCap ?? ""}". Use a positive integer (e.g. cap:10).`,
      );
    }
    if (queueDropInvalid) {
      errors.push(
        `Invalid drop policy "${directives.rawDrop ?? ""}". Use drop:old, drop:new, or drop:summarize.`,
      );
    }
    return { text: errors.join(" ") };
  }

  let modelSelection: ModelDirectiveSelection | undefined;
  if (directives.hasModelDirective && directives.rawModelDirective) {
    const resolved = resolveModelDirectiveSelection({
      raw: directives.rawModelDirective,
      defaultProvider,
      defaultModel,
      aliasIndex,
      allowedModelKeys,
    });
    if (resolved.error) {
      return { text: resolved.error };
    }
    modelSelection = resolved.selection;
    if (modelSelection) {
      const nextLabel = `${modelSelection.provider}/${modelSelection.model}`;
      if (nextLabel !== initialModelLabel) {
        enqueueSystemEvent(
          formatModelSwitchEvent(nextLabel, modelSelection.alias),
          {
            contextKey: `model:${nextLabel}`,
          },
        );
      }
    }
  }

  if (sessionEntry && sessionStore && sessionKey) {
    if (directives.hasThinkDirective && directives.thinkLevel) {
      if (directives.thinkLevel === "off") delete sessionEntry.thinkingLevel;
      else sessionEntry.thinkingLevel = directives.thinkLevel;
    }
    if (directives.hasVerboseDirective && directives.verboseLevel) {
      if (directives.verboseLevel === "off") delete sessionEntry.verboseLevel;
      else sessionEntry.verboseLevel = directives.verboseLevel;
    }
    if (directives.hasElevatedDirective && directives.elevatedLevel) {
      if (directives.elevatedLevel === "off") delete sessionEntry.elevatedLevel;
      else sessionEntry.elevatedLevel = directives.elevatedLevel;
    }
    if (modelSelection) {
      if (modelSelection.isDefault) {
        delete sessionEntry.providerOverride;
        delete sessionEntry.modelOverride;
      } else {
        sessionEntry.providerOverride = modelSelection.provider;
        sessionEntry.modelOverride = modelSelection.model;
      }
    }
    if (directives.hasQueueDirective && directives.queueReset) {
      delete sessionEntry.queueMode;
      delete sessionEntry.queueDebounceMs;
      delete sessionEntry.queueCap;
      delete sessionEntry.queueDrop;
    } else if (directives.hasQueueDirective) {
      if (directives.queueMode) sessionEntry.queueMode = directives.queueMode;
      if (typeof directives.debounceMs === "number") {
        sessionEntry.queueDebounceMs = directives.debounceMs;
      }
      if (typeof directives.cap === "number") {
        sessionEntry.queueCap = directives.cap;
      }
      if (directives.dropPolicy) {
        sessionEntry.queueDrop = directives.dropPolicy;
      }
    }
    sessionEntry.updatedAt = Date.now();
    sessionStore[sessionKey] = sessionEntry;
    if (storePath) {
      await saveSessionStore(storePath, sessionStore);
    }
  }

  const parts: string[] = [];
  if (directives.hasThinkDirective && directives.thinkLevel) {
    parts.push(
      directives.thinkLevel === "off"
        ? "Thinking disabled."
        : `Thinking level set to ${directives.thinkLevel}.`,
    );
  }
  if (directives.hasVerboseDirective && directives.verboseLevel) {
    parts.push(
      directives.verboseLevel === "off"
        ? `${SYSTEM_MARK} Verbose logging disabled.`
        : `${SYSTEM_MARK} Verbose logging enabled.`,
    );
  }
  if (directives.hasElevatedDirective && directives.elevatedLevel) {
    parts.push(
      directives.elevatedLevel === "off"
        ? `${SYSTEM_MARK} Elevated mode disabled.`
        : `${SYSTEM_MARK} Elevated mode enabled.`,
    );
  }
  if (modelSelection) {
    const label = `${modelSelection.provider}/${modelSelection.model}`;
    const labelWithAlias = modelSelection.alias
      ? `${modelSelection.alias} (${label})`
      : label;
    parts.push(
      modelSelection.isDefault
        ? `Model reset to default (${labelWithAlias}).`
        : `Model set to ${labelWithAlias}.`,
    );
  }
  if (directives.hasQueueDirective && directives.queueMode) {
    parts.push(`${SYSTEM_MARK} Queue mode set to ${directives.queueMode}.`);
  } else if (directives.hasQueueDirective && directives.queueReset) {
    parts.push(`${SYSTEM_MARK} Queue mode reset to default.`);
  }
  if (
    directives.hasQueueDirective &&
    typeof directives.debounceMs === "number"
  ) {
    parts.push(
      `${SYSTEM_MARK} Queue debounce set to ${directives.debounceMs}ms.`,
    );
  }
  if (directives.hasQueueDirective && typeof directives.cap === "number") {
    parts.push(`${SYSTEM_MARK} Queue cap set to ${directives.cap}.`);
  }
  if (directives.hasQueueDirective && directives.dropPolicy) {
    parts.push(`${SYSTEM_MARK} Queue drop set to ${directives.dropPolicy}.`);
  }
  const ack = parts.join(" ").trim();
  return { text: ack || "OK." };
}

export async function persistInlineDirectives(params: {
  directives: InlineDirectives;
  effectiveModelDirective?: string;
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
  agentCfg: ClawdbotConfig["agent"] | undefined;
}): Promise<{ provider: string; model: string; contextTokens: number }> {
  const {
    directives,
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

  if (sessionEntry && sessionStore && sessionKey) {
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
      if (directives.verboseLevel === "off") {
        delete sessionEntry.verboseLevel;
      } else {
        sessionEntry.verboseLevel = directives.verboseLevel;
      }
      updated = true;
    }
    if (
      directives.hasElevatedDirective &&
      directives.elevatedLevel &&
      elevatedEnabled &&
      elevatedAllowed
    ) {
      if (directives.elevatedLevel === "off") {
        delete sessionEntry.elevatedLevel;
      } else {
        sessionEntry.elevatedLevel = directives.elevatedLevel;
      }
      updated = true;
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
          const isDefault =
            resolved.ref.provider === defaultProvider &&
            resolved.ref.model === defaultModel;
          if (isDefault) {
            delete sessionEntry.providerOverride;
            delete sessionEntry.modelOverride;
          } else {
            sessionEntry.providerOverride = resolved.ref.provider;
            sessionEntry.modelOverride = resolved.ref.model;
          }
          provider = resolved.ref.provider;
          model = resolved.ref.model;
          const nextLabel = `${provider}/${model}`;
          if (nextLabel !== initialModelLabel) {
            enqueueSystemEvent(
              formatModelSwitchEvent(nextLabel, resolved.alias),
              {
                contextKey: `model:${nextLabel}`,
              },
            );
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
        await saveSessionStore(storePath, sessionStore);
      }
    }
  }

  return {
    provider,
    model,
    contextTokens:
      agentCfg?.contextTokens ??
      lookupContextTokens(model) ??
      DEFAULT_CONTEXT_TOKENS,
  };
}

export function resolveDefaultModel(params: { cfg: ClawdbotConfig }): {
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
} {
  const mainModel = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const defaultProvider = mainModel.provider;
  const defaultModel = mainModel.model;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider,
  });
  return { defaultProvider, defaultModel, aliasIndex };
}

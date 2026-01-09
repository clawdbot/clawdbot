import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  isProfileInCooldown,
  resolveAuthProfileDisplayLabel,
  resolveAuthStorePathForDisplay,
} from "../../agents/auth-profiles.js";
import { lookupContextTokens } from "../../agents/context.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "../../agents/defaults.js";
import {
  ensureAuthProfileStore,
  getCustomProviderApiKey,
  resolveAuthProfileOrder,
  resolveEnvApiKey,
} from "../../agents/model-auth.js";
import {
  buildModelAliasIndex,
  type ModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox.js";
import type { ClawdbotConfig } from "../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  type SessionEntry,
  saveSessionStore,
} from "../../config/sessions.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { shortenHomePath } from "../../utils.js";
import { extractModelDirective } from "../model.js";
import type { MsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import {
  type ElevatedLevel,
  extractElevatedDirective,
  extractReasoningDirective,
  extractStatusDirective,
  extractThinkDirective,
  extractVerboseDirective,
  type ReasoningLevel,
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
  resolveQueueSettings,
} from "./queue.js";

const SYSTEM_MARK = "⚙️";
const formatOptionsLine = (options: string) => `Options: ${options}.`;
const withOptions = (line: string, options: string) =>
  `${line}\n${formatOptionsLine(options)}`;
const formatElevatedRuntimeHint = () =>
  `${SYSTEM_MARK} Runtime is direct; sandboxing does not apply.`;

const maskApiKey = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "missing";
  if (trimmed.length <= 16) return trimmed;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-8)}`;
};

type ModelAuthDetailMode = "compact" | "verbose";

const resolveAuthLabel = async (
  provider: string,
  cfg: ClawdbotConfig,
  modelsPath: string,
  agentDir?: string,
  mode: ModelAuthDetailMode = "compact",
): Promise<{ label: string; source: string }> => {
  const formatPath = (value: string) => shortenHomePath(value);
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const order = resolveAuthProfileOrder({ cfg, store, provider });
  const providerKey = normalizeProviderId(provider);
  const lastGood = (() => {
    const map = store.lastGood;
    if (!map) return undefined;
    for (const [key, value] of Object.entries(map)) {
      if (normalizeProviderId(key) === providerKey) return value;
    }
    return undefined;
  })();
  const nextProfileId = order[0];
  const now = Date.now();

  const formatUntil = (timestampMs: number) => {
    const remainingMs = Math.max(0, timestampMs - now);
    const minutes = Math.round(remainingMs / 60_000);
    if (minutes < 1) return "soon";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h`;
    const days = Math.round(hours / 24);
    return `${days}d`;
  };

  if (order.length > 0) {
    if (mode === "compact") {
      const profileId = nextProfileId;
      if (!profileId) return { label: "missing", source: "missing" };
      const profile = store.profiles[profileId];
      const configProfile = cfg.auth?.profiles?.[profileId];
      const missing =
        !profile ||
        (configProfile?.provider &&
          configProfile.provider !== profile.provider) ||
        (configProfile?.mode &&
          configProfile.mode !== profile.type &&
          !(configProfile.mode === "oauth" && profile.type === "token"));

      const more = order.length > 1 ? ` (+${order.length - 1})` : "";
      if (missing) return { label: `${profileId} missing${more}`, source: "" };

      if (profile.type === "api_key") {
        return {
          label: `${profileId} api-key ${maskApiKey(profile.key)}${more}`,
          source: "",
        };
      }
      if (profile.type === "token") {
        const exp =
          typeof profile.expires === "number" &&
          Number.isFinite(profile.expires) &&
          profile.expires > 0
            ? profile.expires <= now
              ? " expired"
              : ` exp ${formatUntil(profile.expires)}`
            : "";
        return {
          label: `${profileId} token ${maskApiKey(profile.token)}${exp}${more}`,
          source: "",
        };
      }
      const display = resolveAuthProfileDisplayLabel({ cfg, store, profileId });
      const label = display === profileId ? profileId : display;
      const exp =
        typeof profile.expires === "number" &&
        Number.isFinite(profile.expires) &&
        profile.expires > 0
          ? profile.expires <= now
            ? " expired"
            : ` exp ${formatUntil(profile.expires)}`
          : "";
      return { label: `${label} oauth${exp}${more}`, source: "" };
    }

    const labels = order.map((profileId) => {
      const profile = store.profiles[profileId];
      const configProfile = cfg.auth?.profiles?.[profileId];
      const flags: string[] = [];
      if (profileId === nextProfileId) flags.push("next");
      if (lastGood && profileId === lastGood) flags.push("lastGood");
      if (isProfileInCooldown(store, profileId)) {
        const until = store.usageStats?.[profileId]?.cooldownUntil;
        if (
          typeof until === "number" &&
          Number.isFinite(until) &&
          until > now
        ) {
          flags.push(`cooldown ${formatUntil(until)}`);
        } else {
          flags.push("cooldown");
        }
      }
      if (
        !profile ||
        (configProfile?.provider &&
          configProfile.provider !== profile.provider) ||
        (configProfile?.mode &&
          configProfile.mode !== profile.type &&
          !(configProfile.mode === "oauth" && profile.type === "token"))
      ) {
        const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
        return `${profileId}=missing${suffix}`;
      }
      if (profile.type === "api_key") {
        const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
        return `${profileId}=${maskApiKey(profile.key)}${suffix}`;
      }
      if (profile.type === "token") {
        if (
          typeof profile.expires === "number" &&
          Number.isFinite(profile.expires) &&
          profile.expires > 0
        ) {
          flags.push(
            profile.expires <= now
              ? "expired"
              : `exp ${formatUntil(profile.expires)}`,
          );
        }
        const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
        return `${profileId}=token:${maskApiKey(profile.token)}${suffix}`;
      }
      const display = resolveAuthProfileDisplayLabel({
        cfg,
        store,
        profileId,
      });
      const suffix =
        display === profileId
          ? ""
          : display.startsWith(profileId)
            ? display.slice(profileId.length).trim()
            : `(${display})`;
      if (
        typeof profile.expires === "number" &&
        Number.isFinite(profile.expires) &&
        profile.expires > 0
      ) {
        flags.push(
          profile.expires <= now
            ? "expired"
            : `exp ${formatUntil(profile.expires)}`,
        );
      }
      const suffixLabel = suffix ? ` ${suffix}` : "";
      const suffixFlags = flags.length > 0 ? ` (${flags.join(", ")})` : "";
      return `${profileId}=OAuth${suffixLabel}${suffixFlags}`;
    });
    return {
      label: labels.join(", "),
      source: `auth-profiles.json: ${formatPath(resolveAuthStorePathForDisplay(agentDir))}`,
    };
  }

  const envKey = resolveEnvApiKey(provider);
  if (envKey) {
    const isOAuthEnv =
      envKey.source.includes("ANTHROPIC_OAUTH_TOKEN") ||
      envKey.source.toLowerCase().includes("oauth");
    const label = isOAuthEnv ? "OAuth (env)" : maskApiKey(envKey.apiKey);
    return { label, source: mode === "verbose" ? envKey.source : "" };
  }
  const customKey = getCustomProviderApiKey(cfg, provider);
  if (customKey) {
    return {
      label: maskApiKey(customKey),
      source:
        mode === "verbose" ? `models.json: ${formatPath(modelsPath)}` : "",
    };
  }
  return { label: "missing", source: "missing" };
};

const formatAuthLabel = (auth: { label: string; source: string }) => {
  if (!auth.source || auth.source === auth.label || auth.source === "missing") {
    return auth.label;
  }
  return `${auth.label} (${auth.source})`;
};

const resolveProfileOverride = (params: {
  rawProfile?: string;
  provider: string;
  cfg: ClawdbotConfig;
  agentDir?: string;
}): { profileId?: string; error?: string } => {
  const raw = params.rawProfile?.trim();
  if (!raw) return {};
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const profile = store.profiles[raw];
  if (!profile) {
    return { error: `Auth profile "${raw}" not found.` };
  }
  if (profile.provider !== params.provider) {
    return {
      error: `Auth profile "${raw}" is for ${profile.provider}, not ${params.provider}.`,
    };
  }
  return { profileId: raw };
};

export type InlineDirectives = {
  cleaned: string;
  hasThinkDirective: boolean;
  thinkLevel?: ThinkLevel;
  rawThinkLevel?: string;
  hasVerboseDirective: boolean;
  verboseLevel?: VerboseLevel;
  rawVerboseLevel?: string;
  hasReasoningDirective: boolean;
  reasoningLevel?: ReasoningLevel;
  rawReasoningLevel?: string;
  hasElevatedDirective: boolean;
  elevatedLevel?: ElevatedLevel;
  rawElevatedLevel?: string;
  hasStatusDirective: boolean;
  hasModelDirective: boolean;
  rawModelDirective?: string;
  rawModelProfile?: string;
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

export function parseInlineDirectives(
  body: string,
  options?: { modelAliases?: string[]; disableElevated?: boolean },
): InlineDirectives {
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
    cleaned: reasoningCleaned,
    reasoningLevel,
    rawLevel: rawReasoningLevel,
    hasDirective: hasReasoningDirective,
  } = extractReasoningDirective(verboseCleaned);
  const {
    cleaned: elevatedCleaned,
    elevatedLevel,
    rawLevel: rawElevatedLevel,
    hasDirective: hasElevatedDirective,
  } = options?.disableElevated
    ? {
        cleaned: reasoningCleaned,
        elevatedLevel: undefined,
        rawLevel: undefined,
        hasDirective: false,
      }
    : extractElevatedDirective(reasoningCleaned);
  const { cleaned: statusCleaned, hasDirective: hasStatusDirective } =
    extractStatusDirective(elevatedCleaned);
  const {
    cleaned: modelCleaned,
    rawModel,
    rawProfile,
    hasDirective: hasModelDirective,
  } = extractModelDirective(statusCleaned, {
    aliases: options?.modelAliases,
  });
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
    hasReasoningDirective,
    reasoningLevel,
    rawReasoningLevel,
    hasElevatedDirective,
    elevatedLevel,
    rawElevatedLevel,
    hasStatusDirective,
    hasModelDirective,
    rawModelDirective: rawModel,
    rawModelProfile: rawProfile,
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
  agentId?: string;
  isGroup: boolean;
}): boolean {
  const { directives, cleanedBody, ctx, cfg, agentId, isGroup } = params;
  if (
    !directives.hasThinkDirective &&
    !directives.hasVerboseDirective &&
    !directives.hasReasoningDirective &&
    !directives.hasElevatedDirective &&
    !directives.hasModelDirective &&
    !directives.hasQueueDirective
  )
    return false;
  const stripped = stripStructuralPrefixes(cleanedBody ?? "");
  const noMentions = isGroup
    ? stripMentions(stripped, ctx, cfg, agentId)
    : stripped;
  return noMentions.length === 0;
}

export async function handleDirectiveOnly(params: {
  cfg: ClawdbotConfig;
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
  currentThinkLevel?: ThinkLevel;
  currentVerboseLevel?: VerboseLevel;
  currentReasoningLevel?: ReasoningLevel;
  currentElevatedLevel?: ElevatedLevel;
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
    provider,
    initialModelLabel,
    formatModelSwitchEvent,
    currentThinkLevel,
    currentVerboseLevel,
    currentReasoningLevel,
    currentElevatedLevel,
  } = params;
  const activeAgentId = params.sessionKey
    ? resolveAgentIdFromSessionKey(params.sessionKey)
    : resolveDefaultAgentId(params.cfg);
  const agentDir = resolveAgentDir(params.cfg, activeAgentId);
  const runtimeIsSandboxed = (() => {
    const sessionKey = params.sessionKey?.trim();
    if (!sessionKey) return false;
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const sandboxCfg = resolveSandboxConfigForAgent(params.cfg, agentId);
    if (sandboxCfg.mode === "off") return false;
    const mainKey = resolveAgentMainSessionKey({
      cfg: params.cfg,
      agentId,
    });
    if (sandboxCfg.mode === "all") return true;
    return sessionKey !== mainKey;
  })();
  const shouldHintDirectRuntime =
    directives.hasElevatedDirective && !runtimeIsSandboxed;

  if (directives.hasModelDirective) {
    const modelDirective = directives.rawModelDirective?.trim().toLowerCase();
    const isModelListAlias =
      modelDirective === "status" || modelDirective === "list";
    if (!directives.rawModelDirective || isModelListAlias) {
      const modelsPath = `${agentDir}/models.json`;
      const formatPath = (value: string) => shortenHomePath(value);
      const authMode: ModelAuthDetailMode =
        modelDirective === "status" ? "verbose" : "compact";
      if (allowedModelCatalog.length === 0) {
        const resolvedDefault = resolveConfiguredModelRef({
          cfg: params.cfg,
          defaultProvider,
          defaultModel,
        });
        const fallbackKeys = new Set<string>();
        const fallbackCatalog: Array<{
          provider: string;
          id: string;
        }> = [];
        for (const raw of Object.keys(
          params.cfg.agents?.defaults?.models ?? {},
        )) {
          const resolved = resolveModelRefFromString({
            raw: String(raw),
            defaultProvider,
            aliasIndex,
          });
          if (!resolved) continue;
          const key = modelKey(resolved.ref.provider, resolved.ref.model);
          if (fallbackKeys.has(key)) continue;
          fallbackKeys.add(key);
          fallbackCatalog.push({
            provider: resolved.ref.provider,
            id: resolved.ref.model,
          });
        }
        if (fallbackCatalog.length === 0 && resolvedDefault.model) {
          const key = modelKey(resolvedDefault.provider, resolvedDefault.model);
          fallbackKeys.add(key);
          fallbackCatalog.push({
            provider: resolvedDefault.provider,
            id: resolvedDefault.model,
          });
        }
        if (fallbackCatalog.length === 0) {
          return { text: "No models available." };
        }
        const authByProvider = new Map<string, string>();
        for (const entry of fallbackCatalog) {
          if (authByProvider.has(entry.provider)) continue;
          const auth = await resolveAuthLabel(
            entry.provider,
            params.cfg,
            modelsPath,
            agentDir,
            authMode,
          );
          authByProvider.set(entry.provider, formatAuthLabel(auth));
        }
        const current = `${params.provider}/${params.model}`;
        const defaultLabel = `${defaultProvider}/${defaultModel}`;
        const lines = [
          `Current: ${current}`,
          `Default: ${defaultLabel}`,
          `Agent: ${activeAgentId}`,
          `Auth file: ${formatPath(resolveAuthStorePathForDisplay(agentDir))}`,
          `⚠️ Model catalog unavailable; showing configured models only.`,
        ];
        const byProvider = new Map<string, typeof fallbackCatalog>();
        for (const entry of fallbackCatalog) {
          const models = byProvider.get(entry.provider);
          if (models) {
            models.push(entry);
            continue;
          }
          byProvider.set(entry.provider, [entry]);
        }
        for (const provider of byProvider.keys()) {
          const models = byProvider.get(provider);
          if (!models) continue;
          const authLabel = authByProvider.get(provider) ?? "missing";
          lines.push("");
          lines.push(`[${provider}] auth: ${authLabel}`);
          for (const entry of models) {
            const label = `${entry.provider}/${entry.id}`;
            const aliases = aliasIndex.byKey.get(label);
            const aliasSuffix =
              aliases && aliases.length > 0 ? ` (${aliases.join(", ")})` : "";
            lines.push(`  • ${label}${aliasSuffix}`);
          }
        }
        return { text: lines.join("\n") };
      }
      const authByProvider = new Map<string, string>();
      for (const entry of allowedModelCatalog) {
        if (authByProvider.has(entry.provider)) continue;
        const auth = await resolveAuthLabel(
          entry.provider,
          params.cfg,
          modelsPath,
          agentDir,
          authMode,
        );
        authByProvider.set(entry.provider, formatAuthLabel(auth));
      }
      const current = `${params.provider}/${params.model}`;
      const defaultLabel = `${defaultProvider}/${defaultModel}`;
      const lines = [
        `Current: ${current}`,
        `Default: ${defaultLabel}`,
        `Agent: ${activeAgentId}`,
        `Auth file: ${formatPath(resolveAuthStorePathForDisplay(agentDir))}`,
      ];
      if (resetModelOverride) {
        lines.push(`(previous selection reset to default)`);
      }

      // Group models by provider
      const byProvider = new Map<string, typeof allowedModelCatalog>();
      for (const entry of allowedModelCatalog) {
        const models = byProvider.get(entry.provider);
        if (models) {
          models.push(entry);
          continue;
        }
        byProvider.set(entry.provider, [entry]);
      }

      // Iterate over provider groups
      for (const provider of byProvider.keys()) {
        const models = byProvider.get(provider);
        if (!models) continue;
        const authLabel = authByProvider.get(provider) ?? "missing";
        lines.push("");
        lines.push(`[${provider}] auth: ${authLabel}`);
        for (const entry of models) {
          const label = `${entry.provider}/${entry.id}`;
          const aliases = aliasIndex.byKey.get(label);
          const aliasSuffix =
            aliases && aliases.length > 0 ? ` (${aliases.join(", ")})` : "";
          lines.push(`  • ${label}${aliasSuffix}`);
        }
      }
      return { text: lines.join("\n") };
    }
    if (directives.rawModelProfile && !modelDirective) {
      throw new Error("Auth profile override requires a model selection.");
    }
  }

  if (directives.hasThinkDirective && !directives.thinkLevel) {
    // If no argument was provided, show the current level
    if (!directives.rawThinkLevel) {
      const level = currentThinkLevel ?? "off";
      return {
        text: withOptions(
          `Current thinking level: ${level}.`,
          "off, minimal, low, medium, high",
        ),
      };
    }
    return {
      text: `Unrecognized thinking level "${directives.rawThinkLevel}". Valid levels: off, minimal, low, medium, high.`,
    };
  }
  if (directives.hasVerboseDirective && !directives.verboseLevel) {
    if (!directives.rawVerboseLevel) {
      const level = currentVerboseLevel ?? "off";
      return {
        text: withOptions(`Current verbose level: ${level}.`, "on, off"),
      };
    }
    return {
      text: `Unrecognized verbose level "${directives.rawVerboseLevel}". Valid levels: off, on.`,
    };
  }
  if (directives.hasReasoningDirective && !directives.reasoningLevel) {
    if (!directives.rawReasoningLevel) {
      const level = currentReasoningLevel ?? "off";
      return {
        text: withOptions(
          `Current reasoning level: ${level}.`,
          "on, off, stream",
        ),
      };
    }
    return {
      text: `Unrecognized reasoning level "${directives.rawReasoningLevel}". Valid levels: on, off, stream.`,
    };
  }
  if (directives.hasElevatedDirective && !directives.elevatedLevel) {
    if (!directives.rawElevatedLevel) {
      if (!elevatedEnabled || !elevatedAllowed) {
        return { text: "elevated is not available right now." };
      }
      const level = currentElevatedLevel ?? "off";
      return {
        text: [
          withOptions(`Current elevated level: ${level}.`, "on, off"),
          shouldHintDirectRuntime ? formatElevatedRuntimeHint() : null,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    return {
      text: `Unrecognized elevated level "${directives.rawElevatedLevel}". Valid levels: off, on.`,
    };
  }
  if (
    directives.hasElevatedDirective &&
    (!elevatedEnabled || !elevatedAllowed)
  ) {
    return { text: "elevated is not available right now." };
  }

  if (
    directives.hasQueueDirective &&
    !directives.queueMode &&
    !directives.queueReset &&
    !directives.hasQueueOptions &&
    directives.rawQueueMode === undefined &&
    directives.rawDebounce === undefined &&
    directives.rawCap === undefined &&
    directives.rawDrop === undefined
  ) {
    const settings = resolveQueueSettings({
      cfg: params.cfg,
      provider,
      sessionEntry,
    });
    const debounceLabel =
      typeof settings.debounceMs === "number"
        ? `${settings.debounceMs}ms`
        : "default";
    const capLabel =
      typeof settings.cap === "number" ? String(settings.cap) : "default";
    const dropLabel = settings.dropPolicy ?? "default";
    return {
      text: withOptions(
        `Current queue settings: mode=${settings.mode}, debounce=${debounceLabel}, cap=${capLabel}, drop=${dropLabel}.`,
        "modes steer, followup, collect, steer+backlog, interrupt; debounce:<ms|s|m>, cap:<n>, drop:old|new|summarize",
      ),
    };
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
  let profileOverride: string | undefined;
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
      if (directives.rawModelProfile) {
        const profileResolved = resolveProfileOverride({
          rawProfile: directives.rawModelProfile,
          provider: modelSelection.provider,
          cfg: params.cfg,
          agentDir,
        });
        if (profileResolved.error) {
          return { text: profileResolved.error };
        }
        profileOverride = profileResolved.profileId;
      }
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
  if (directives.rawModelProfile && !modelSelection) {
    return { text: "Auth profile override requires a model selection." };
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
    if (directives.hasReasoningDirective && directives.reasoningLevel) {
      if (directives.reasoningLevel === "off")
        delete sessionEntry.reasoningLevel;
      else sessionEntry.reasoningLevel = directives.reasoningLevel;
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
      if (profileOverride) {
        sessionEntry.authProfileOverride = profileOverride;
      } else if (directives.hasModelDirective) {
        delete sessionEntry.authProfileOverride;
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
  if (directives.hasReasoningDirective && directives.reasoningLevel) {
    parts.push(
      directives.reasoningLevel === "off"
        ? `${SYSTEM_MARK} Reasoning visibility disabled.`
        : directives.reasoningLevel === "stream"
          ? `${SYSTEM_MARK} Reasoning stream enabled (Telegram only).`
          : `${SYSTEM_MARK} Reasoning visibility enabled.`,
    );
  }
  if (directives.hasElevatedDirective && directives.elevatedLevel) {
    parts.push(
      directives.elevatedLevel === "off"
        ? `${SYSTEM_MARK} Elevated mode disabled.`
        : `${SYSTEM_MARK} Elevated mode enabled.`,
    );
    if (shouldHintDirectRuntime) parts.push(formatElevatedRuntimeHint());
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
    if (profileOverride) {
      parts.push(`Auth profile set to ${profileOverride}.`);
    }
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
  if (!ack && directives.hasStatusDirective) return undefined;
  return { text: ack || "OK." };
}

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
    ? resolveAgentIdFromSessionKey(sessionKey)
    : resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, activeAgentId);

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
    if (directives.hasReasoningDirective && directives.reasoningLevel) {
      if (directives.reasoningLevel === "off") {
        delete sessionEntry.reasoningLevel;
      } else {
        sessionEntry.reasoningLevel = directives.reasoningLevel;
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
            resolved.ref.provider === defaultProvider &&
            resolved.ref.model === defaultModel;
          if (isDefault) {
            delete sessionEntry.providerOverride;
            delete sessionEntry.modelOverride;
          } else {
            sessionEntry.providerOverride = resolved.ref.provider;
            sessionEntry.modelOverride = resolved.ref.model;
          }
          if (profileOverride) {
            sessionEntry.authProfileOverride = profileOverride;
          } else if (directives.hasModelDirective) {
            delete sessionEntry.authProfileOverride;
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

export function resolveDefaultModel(params: {
  cfg: ClawdbotConfig;
  agentId?: string;
}): {
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
} {
  const agentModelOverride = params.agentId
    ? resolveAgentConfig(params.cfg, params.agentId)?.model?.trim()
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

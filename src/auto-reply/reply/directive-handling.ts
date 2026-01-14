import {
  resolveAgentDir,
  resolveAgentModelPrimary,
  resolveDefaultAgentId,
  resolveSessionAgentId,
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
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { type SessionEntry, saveSessionStore } from "../../config/sessions.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { applyVerboseOverride } from "../../sessions/level-overrides.js";
import { shortenHomePath } from "../../utils.js";
import { extractModelDirective } from "../model.js";
import type { MsgContext } from "../templating.js";
import {
  formatThinkingLevels,
  formatXHighModelHint,
  supportsXHighThinking,
} from "../thinking.js";
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
export const formatDirectiveAck = (text: string): string => {
  if (!text) return text;
  if (text.startsWith(SYSTEM_MARK)) return text;
  return `${SYSTEM_MARK} ${text}`;
};

const formatOptionsLine = (options: string) => `Options: ${options}.`;
const withOptions = (line: string, options: string) =>
  `${line}\n${formatOptionsLine(options)}`;
const formatElevatedRuntimeHint = () =>
  `${SYSTEM_MARK} Runtime is direct; sandboxing does not apply.`;

const formatElevatedEvent = (level: ElevatedLevel) =>
  level === "on"
    ? "Elevated ON — exec runs on host; set elevated:false to stay sandboxed."
    : "Elevated OFF — exec stays in sandbox.";

const formatReasoningEvent = (level: ReasoningLevel) => {
  if (level === "stream") return "Reasoning STREAM — emit live <think>.";
  if (level === "on") return "Reasoning ON — include <think>.";
  return "Reasoning OFF — hide <think>.";
};

function formatElevatedUnavailableText(params: {
  runtimeSandboxed: boolean;
  failures?: Array<{ gate: string; key: string }>;
  sessionKey?: string;
}): string {
  const lines: string[] = [];
  lines.push(
    `elevated is not available right now (runtime=${params.runtimeSandboxed ? "sandboxed" : "direct"}).`,
  );
  const failures = params.failures ?? [];
  if (failures.length > 0) {
    lines.push(
      `Failing gates: ${failures.map((f) => `${f.gate} (${f.key})`).join(", ")}`,
    );
  } else {
    lines.push(
      "Fix-it keys: tools.elevated.enabled, tools.elevated.allowFrom.<provider>, agents.list[].tools.elevated.*",
    );
  }
  if (params.sessionKey) {
    lines.push(`See: clawdbot sandbox explain --session ${params.sessionKey}`);
  }
  return lines.join("\n");
}

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

type ModelPickerCatalogEntry = {
  provider: string;
  id: string;
  name?: string;
};

type ModelPickerItem = {
  model: string;
  providers: string[];
  providerModels: Record<string, string>;
};

const MODEL_PICK_PROVIDER_PREFERENCE = [
  "anthropic",
  "openai",
  "openai-codex",
  "minimax",
  "synthetic",
  "google",
  "zai",
  "openrouter",
  "opencode",
  "github-copilot",
  "groq",
  "cerebras",
  "mistral",
  "xai",
  "lmstudio",
] as const;

function normalizeModelFamilyId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return trimmed;
  const parts = trimmed.split("/").filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? trimmed) : trimmed;
}

function sortProvidersForPicker(providers: string[]): string[] {
  const pref = new Map<string, number>(
    MODEL_PICK_PROVIDER_PREFERENCE.map((provider, idx) => [provider, idx]),
  );
  return providers.sort((a, b) => {
    const pa = pref.get(a);
    const pb = pref.get(b);
    if (pa !== undefined && pb !== undefined) return pa - pb;
    if (pa !== undefined) return -1;
    if (pb !== undefined) return 1;
    return a.localeCompare(b);
  });
}

function buildModelPickerItems(
  catalog: ModelPickerCatalogEntry[],
): ModelPickerItem[] {
  const byModel = new Map<string, { providerModels: Record<string, string> }>();
  for (const entry of catalog) {
    const provider = normalizeProviderId(entry.provider);
    const model = normalizeModelFamilyId(entry.id);
    if (!provider || !model) continue;
    const existing = byModel.get(model);
    if (existing) {
      existing.providerModels[provider] = entry.id;
      continue;
    }
    byModel.set(model, { providerModels: { [provider]: entry.id } });
  }
  const out: ModelPickerItem[] = [];
  for (const [model, data] of byModel.entries()) {
    const providers = sortProvidersForPicker(Object.keys(data.providerModels));
    out.push({ model, providers, providerModels: data.providerModels });
  }
  out.sort((a, b) =>
    a.model.toLowerCase().localeCompare(b.model.toLowerCase()),
  );
  return out;
}

function pickProviderForModel(params: {
  item: ModelPickerItem;
  preferredProvider?: string;
}): { provider: string; model: string } | null {
  const preferred = params.preferredProvider
    ? normalizeProviderId(params.preferredProvider)
    : undefined;
  if (preferred && params.item.providerModels[preferred]) {
    return {
      provider: preferred,
      model: params.item.providerModels[preferred],
    };
  }
  const first = params.item.providers[0];
  if (!first) return null;
  return {
    provider: first,
    model: params.item.providerModels[first] ?? params.item.model,
  };
}

function resolveProviderEndpointLabel(
  provider: string,
  cfg: ClawdbotConfig,
): { endpoint?: string; api?: string } {
  const normalized = normalizeProviderId(provider);
  const providers = (cfg.models?.providers ?? {}) as Record<
    string,
    { baseUrl?: string; api?: string } | undefined
  >;
  const entry = providers[normalized];
  const endpoint = entry?.baseUrl?.trim();
  const api = entry?.api?.trim();
  return {
    endpoint: endpoint || undefined,
    api: api || undefined,
  };
}

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
  options?: {
    modelAliases?: string[];
    disableElevated?: boolean;
    allowStatusDirective?: boolean;
  },
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
  const allowStatusDirective = options?.allowStatusDirective !== false;
  const { cleaned: statusCleaned, hasDirective: hasStatusDirective } =
    allowStatusDirective
      ? extractStatusDirective(elevatedCleaned)
      : { cleaned: elevatedCleaned, hasDirective: false };
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

export async function applyInlineDirectivesFastLane(params: {
  directives: InlineDirectives;
  commandAuthorized: boolean;
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  agentId?: string;
  isGroup: boolean;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  elevatedFailures?: Array<{ gate: string; key: string }>;
  messageProviderKey?: string;
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
  agentCfg?: NonNullable<ClawdbotConfig["agents"]>["defaults"];
  modelState: {
    resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
    allowedModelKeys: Set<string>;
    allowedModelCatalog: Awaited<
      ReturnType<
        typeof import("../../agents/model-catalog.js").loadModelCatalog
      >
    >;
    resetModelOverride: boolean;
  };
}): Promise<{ directiveAck?: ReplyPayload; provider: string; model: string }> {
  const {
    directives,
    commandAuthorized,
    ctx,
    cfg,
    agentId,
    isGroup,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    messageProviderKey,
    defaultProvider,
    defaultModel,
    aliasIndex,
    allowedModelKeys,
    allowedModelCatalog,
    resetModelOverride,
    formatModelSwitchEvent,
    modelState,
  } = params;

  let { provider, model } = params;
  if (
    !commandAuthorized ||
    isDirectiveOnly({
      directives,
      cleanedBody: directives.cleaned,
      ctx,
      cfg,
      agentId,
      isGroup,
    })
  ) {
    return { directiveAck: undefined, provider, model };
  }

  const agentCfg = params.agentCfg;
  const resolvedDefaultThinkLevel =
    (sessionEntry?.thinkingLevel as ThinkLevel | undefined) ??
    (agentCfg?.thinkingDefault as ThinkLevel | undefined) ??
    (await modelState.resolveDefaultThinkingLevel());
  const currentThinkLevel = resolvedDefaultThinkLevel;
  const currentVerboseLevel =
    (sessionEntry?.verboseLevel as VerboseLevel | undefined) ??
    (agentCfg?.verboseDefault as VerboseLevel | undefined);
  const currentReasoningLevel =
    (sessionEntry?.reasoningLevel as ReasoningLevel | undefined) ?? "off";
  const currentElevatedLevel =
    (sessionEntry?.elevatedLevel as ElevatedLevel | undefined) ??
    (agentCfg?.elevatedDefault as ElevatedLevel | undefined);

  const directiveAck = await handleDirectiveOnly({
    cfg,
    directives,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    messageProviderKey,
    defaultProvider,
    defaultModel,
    aliasIndex,
    allowedModelKeys,
    allowedModelCatalog,
    resetModelOverride,
    provider,
    model,
    initialModelLabel: params.initialModelLabel,
    formatModelSwitchEvent,
    currentThinkLevel,
    currentVerboseLevel,
    currentReasoningLevel,
    currentElevatedLevel,
  });

  if (sessionEntry?.providerOverride) {
    provider = sessionEntry.providerOverride;
  }
  if (sessionEntry?.modelOverride) {
    model = sessionEntry.modelOverride;
  }

  return { directiveAck, provider, model };
}

export async function handleDirectiveOnly(params: {
  cfg: ClawdbotConfig;
  directives: InlineDirectives;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  elevatedFailures?: Array<{ gate: string; key: string }>;
  messageProviderKey?: string;
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
    model,
    initialModelLabel,
    formatModelSwitchEvent,
    currentThinkLevel,
    currentVerboseLevel,
    currentReasoningLevel,
    currentElevatedLevel,
  } = params;
  const activeAgentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  const agentDir = resolveAgentDir(params.cfg, activeAgentId);
  const runtimeIsSandboxed = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  }).sandboxed;
  const shouldHintDirectRuntime =
    directives.hasElevatedDirective && !runtimeIsSandboxed;

  if (directives.hasModelDirective) {
    const rawDirective = directives.rawModelDirective?.trim();
    const directive = rawDirective?.toLowerCase();
    const wantsStatus = directive === "status";
    const wantsList = !rawDirective || directive === "list";

    if ((wantsList || wantsStatus) && directives.rawModelProfile) {
      return { text: "Auth profile override requires a model selection." };
    }

    const resolvedDefault = resolveConfiguredModelRef({
      cfg: params.cfg,
      defaultProvider,
      defaultModel,
    });
    const pickerCatalog: ModelPickerCatalogEntry[] = (() => {
      const keys = new Set<string>();
      const out: ModelPickerCatalogEntry[] = [];

      const push = (entry: ModelPickerCatalogEntry) => {
        const provider = normalizeProviderId(entry.provider);
        const id = String(entry.id ?? "").trim();
        if (!provider || !id) return;
        const key = modelKey(provider, id);
        if (keys.has(key)) return;
        keys.add(key);
        out.push({ provider, id, name: entry.name });
      };

      // Prefer catalog entries (when available), but always merge in config-only
      // allowlist entries. This keeps custom providers/models visible in /model.
      for (const entry of allowedModelCatalog) push(entry);

      // Merge any configured allowlist keys that the catalog doesn't know about.
      for (const raw of Object.keys(
        params.cfg.agents?.defaults?.models ?? {},
      )) {
        const resolved = resolveModelRefFromString({
          raw: String(raw),
          defaultProvider,
          aliasIndex,
        });
        if (!resolved) continue;
        push({
          provider: resolved.ref.provider,
          id: resolved.ref.model,
          name: resolved.ref.model,
        });
      }

      // Ensure the configured default is always present (even when no allowlist).
      if (resolvedDefault.model) {
        push({
          provider: resolvedDefault.provider,
          id: resolvedDefault.model,
          name: resolvedDefault.model,
        });
      }

      return out;
    })();

    if (wantsList) {
      const items = buildModelPickerItems(pickerCatalog);
      if (items.length === 0) return { text: "No models available." };
      const current = `${params.provider}/${params.model}`;
      const lines: string[] = [
        `Current: ${current}`,
        "Pick: /model <#> or /model <provider/model>",
      ];
      for (const [idx, item] of items.entries()) {
        lines.push(`${idx + 1}) ${item.model} — ${item.providers.join(", ")}`);
      }
      lines.push("", "More: /model status");
      return { text: lines.join("\n") };
    }

    if (wantsStatus) {
      const modelsPath = `${agentDir}/models.json`;
      const formatPath = (value: string) => shortenHomePath(value);
      const authMode: ModelAuthDetailMode = "verbose";
      const catalog = pickerCatalog;
      if (catalog.length === 0) return { text: "No models available." };

      const authByProvider = new Map<string, string>();
      for (const entry of catalog) {
        const provider = normalizeProviderId(entry.provider);
        if (authByProvider.has(provider)) continue;
        const auth = await resolveAuthLabel(
          provider,
          params.cfg,
          modelsPath,
          agentDir,
          authMode,
        );
        authByProvider.set(provider, formatAuthLabel(auth));
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

      const byProvider = new Map<string, ModelPickerCatalogEntry[]>();
      for (const entry of catalog) {
        const provider = normalizeProviderId(entry.provider);
        const models = byProvider.get(provider);
        if (models) {
          models.push(entry);
          continue;
        }
        byProvider.set(provider, [entry]);
      }

      for (const provider of byProvider.keys()) {
        const models = byProvider.get(provider);
        if (!models) continue;
        const authLabel = authByProvider.get(provider) ?? "missing";
        const endpoint = resolveProviderEndpointLabel(provider, params.cfg);
        const endpointSuffix = endpoint.endpoint
          ? ` endpoint: ${endpoint.endpoint}`
          : " endpoint: default";
        const apiSuffix = endpoint.api ? ` api: ${endpoint.api}` : "";
        lines.push("");
        lines.push(
          `[${provider}]${endpointSuffix}${apiSuffix} auth: ${authLabel}`,
        );
        for (const entry of models) {
          const label = `${provider}/${entry.id}`;
          const aliases = aliasIndex.byKey.get(label);
          const aliasSuffix =
            aliases && aliases.length > 0 ? ` (${aliases.join(", ")})` : "";
          lines.push(`  • ${label}${aliasSuffix}`);
        }
      }
      return { text: lines.join("\n") };
    }
  }

  let modelSelection: ModelDirectiveSelection | undefined;
  let profileOverride: string | undefined;
  if (directives.hasModelDirective && directives.rawModelDirective) {
    const raw = directives.rawModelDirective.trim();
    if (/^[0-9]+$/.test(raw)) {
      const resolvedDefault = resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider,
        defaultModel,
      });
      const pickerCatalog: ModelPickerCatalogEntry[] = (() => {
        const keys = new Set<string>();
        const out: ModelPickerCatalogEntry[] = [];

        const push = (entry: ModelPickerCatalogEntry) => {
          const provider = normalizeProviderId(entry.provider);
          const id = String(entry.id ?? "").trim();
          if (!provider || !id) return;
          const key = modelKey(provider, id);
          if (keys.has(key)) return;
          keys.add(key);
          out.push({ provider, id, name: entry.name });
        };

        for (const entry of allowedModelCatalog) push(entry);

        for (const rawKey of Object.keys(
          params.cfg.agents?.defaults?.models ?? {},
        )) {
          const resolved = resolveModelRefFromString({
            raw: String(rawKey),
            defaultProvider,
            aliasIndex,
          });
          if (!resolved) continue;
          push({
            provider: resolved.ref.provider,
            id: resolved.ref.model,
            name: resolved.ref.model,
          });
        }
        if (resolvedDefault.model) {
          push({
            provider: resolvedDefault.provider,
            id: resolvedDefault.model,
            name: resolvedDefault.model,
          });
        }
        return out;
      })();

      const items = buildModelPickerItems(pickerCatalog);
      const index = Number.parseInt(raw, 10) - 1;
      const item = Number.isFinite(index) ? items[index] : undefined;
      if (!item) {
        return {
          text: `Invalid model selection "${raw}". Use /model to list.`,
        };
      }
      const picked = pickProviderForModel({
        item,
        preferredProvider: params.provider,
      });
      if (!picked) {
        return {
          text: `Invalid model selection "${raw}". Use /model to list.`,
        };
      }
      const key = `${picked.provider}/${picked.model}`;
      const aliases = aliasIndex.byKey.get(key);
      const alias = aliases && aliases.length > 0 ? aliases[0] : undefined;
      modelSelection = {
        provider: picked.provider,
        model: picked.model,
        isDefault:
          picked.provider === defaultProvider && picked.model === defaultModel,
        ...(alias ? { alias } : {}),
      };
    } else {
      const resolved = resolveModelDirectiveSelection({
        raw,
        defaultProvider,
        defaultModel,
        aliasIndex,
        allowedModelKeys,
      });
      if (resolved.error) {
        return { text: resolved.error };
      }
      modelSelection = resolved.selection;
    }
    if (modelSelection && directives.rawModelProfile) {
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
  }
  if (directives.rawModelProfile && !modelSelection) {
    return { text: "Auth profile override requires a model selection." };
  }

  const resolvedProvider = modelSelection?.provider ?? provider;
  const resolvedModel = modelSelection?.model ?? model;

  if (directives.hasThinkDirective && !directives.thinkLevel) {
    // If no argument was provided, show the current level
    if (!directives.rawThinkLevel) {
      const level = currentThinkLevel ?? "off";
      return {
        text: withOptions(
          `Current thinking level: ${level}.`,
          formatThinkingLevels(resolvedProvider, resolvedModel),
        ),
      };
    }
    return {
      text: `Unrecognized thinking level "${directives.rawThinkLevel}". Valid levels: ${formatThinkingLevels(resolvedProvider, resolvedModel)}.`,
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
        return {
          text: formatElevatedUnavailableText({
            runtimeSandboxed: runtimeIsSandboxed,
            failures: params.elevatedFailures,
            sessionKey: params.sessionKey,
          }),
        };
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
    return {
      text: formatElevatedUnavailableText({
        runtimeSandboxed: runtimeIsSandboxed,
        failures: params.elevatedFailures,
        sessionKey: params.sessionKey,
      }),
    };
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
      channel: provider,
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

  if (
    directives.hasThinkDirective &&
    directives.thinkLevel === "xhigh" &&
    !supportsXHighThinking(resolvedProvider, resolvedModel)
  ) {
    return {
      text: `Thinking level "xhigh" is only supported for ${formatXHighModelHint()}.`,
    };
  }

  const nextThinkLevel = directives.hasThinkDirective
    ? directives.thinkLevel
    : ((sessionEntry?.thinkingLevel as ThinkLevel | undefined) ??
      currentThinkLevel);
  const shouldDowngradeXHigh =
    !directives.hasThinkDirective &&
    nextThinkLevel === "xhigh" &&
    !supportsXHighThinking(resolvedProvider, resolvedModel);

  if (sessionEntry && sessionStore && sessionKey) {
    const prevElevatedLevel =
      currentElevatedLevel ??
      (sessionEntry.elevatedLevel as ElevatedLevel | undefined) ??
      (elevatedAllowed ? ("on" as ElevatedLevel) : ("off" as ElevatedLevel));
    const prevReasoningLevel =
      currentReasoningLevel ??
      (sessionEntry.reasoningLevel as ReasoningLevel | undefined) ??
      "off";
    let elevatedChanged =
      directives.hasElevatedDirective &&
      directives.elevatedLevel !== undefined &&
      elevatedEnabled &&
      elevatedAllowed;
    let reasoningChanged =
      directives.hasReasoningDirective &&
      directives.reasoningLevel !== undefined;
    if (directives.hasThinkDirective && directives.thinkLevel) {
      if (directives.thinkLevel === "off") delete sessionEntry.thinkingLevel;
      else sessionEntry.thinkingLevel = directives.thinkLevel;
    }
    if (shouldDowngradeXHigh) {
      sessionEntry.thinkingLevel = "high";
    }
    if (directives.hasVerboseDirective && directives.verboseLevel) {
      applyVerboseOverride(sessionEntry, directives.verboseLevel);
    }
    if (directives.hasReasoningDirective && directives.reasoningLevel) {
      if (directives.reasoningLevel === "off")
        delete sessionEntry.reasoningLevel;
      else sessionEntry.reasoningLevel = directives.reasoningLevel;
      reasoningChanged =
        directives.reasoningLevel !== prevReasoningLevel &&
        directives.reasoningLevel !== undefined;
    }
    if (directives.hasElevatedDirective && directives.elevatedLevel) {
      // Unlike other toggles, elevated defaults can be "on".
      // Persist "off" explicitly so `/elevated off` actually overrides defaults.
      sessionEntry.elevatedLevel = directives.elevatedLevel;
      elevatedChanged =
        elevatedChanged ||
        (directives.elevatedLevel !== prevElevatedLevel &&
          directives.elevatedLevel !== undefined);
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
    if (modelSelection) {
      const nextLabel = `${modelSelection.provider}/${modelSelection.model}`;
      if (nextLabel !== initialModelLabel) {
        enqueueSystemEvent(
          formatModelSwitchEvent(nextLabel, modelSelection.alias),
          {
            sessionKey,
            contextKey: `model:${nextLabel}`,
          },
        );
      }
    }
    if (elevatedChanged) {
      const nextElevated = (sessionEntry.elevatedLevel ??
        "off") as ElevatedLevel;
      enqueueSystemEvent(formatElevatedEvent(nextElevated), {
        sessionKey,
        contextKey: "mode:elevated",
      });
    }
    if (reasoningChanged) {
      const nextReasoning = (sessionEntry.reasoningLevel ??
        "off") as ReasoningLevel;
      enqueueSystemEvent(formatReasoningEvent(nextReasoning), {
        sessionKey,
        contextKey: "mode:reasoning",
      });
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
        ? formatDirectiveAck("Verbose logging disabled.")
        : formatDirectiveAck("Verbose logging enabled."),
    );
  }
  if (directives.hasReasoningDirective && directives.reasoningLevel) {
    parts.push(
      directives.reasoningLevel === "off"
        ? formatDirectiveAck("Reasoning visibility disabled.")
        : directives.reasoningLevel === "stream"
          ? formatDirectiveAck("Reasoning stream enabled (Telegram only).")
          : formatDirectiveAck("Reasoning visibility enabled."),
    );
  }
  if (directives.hasElevatedDirective && directives.elevatedLevel) {
    parts.push(
      directives.elevatedLevel === "off"
        ? formatDirectiveAck("Elevated mode disabled.")
        : formatDirectiveAck("Elevated mode enabled."),
    );
    if (shouldHintDirectRuntime) parts.push(formatElevatedRuntimeHint());
  }
  if (shouldDowngradeXHigh) {
    parts.push(
      `Thinking level set to high (xhigh not supported for ${resolvedProvider}/${resolvedModel}).`,
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
    if (profileOverride) {
      parts.push(`Auth profile set to ${profileOverride}.`);
    }
  }
  if (directives.hasQueueDirective && directives.queueMode) {
    parts.push(
      formatDirectiveAck(`Queue mode set to ${directives.queueMode}.`),
    );
  } else if (directives.hasQueueDirective && directives.queueReset) {
    parts.push(formatDirectiveAck("Queue mode reset to default."));
  }
  if (
    directives.hasQueueDirective &&
    typeof directives.debounceMs === "number"
  ) {
    parts.push(
      formatDirectiveAck(`Queue debounce set to ${directives.debounceMs}ms.`),
    );
  }
  if (directives.hasQueueDirective && typeof directives.cap === "number") {
    parts.push(formatDirectiveAck(`Queue cap set to ${directives.cap}.`));
  }
  if (directives.hasQueueDirective && directives.dropPolicy) {
    parts.push(
      formatDirectiveAck(`Queue drop set to ${directives.dropPolicy}.`),
    );
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
    ? resolveSessionAgentId({ sessionKey, config: cfg })
    : resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, activeAgentId);

  if (sessionEntry && sessionStore && sessionKey) {
    const prevElevatedLevel =
      (sessionEntry.elevatedLevel as ElevatedLevel | undefined) ??
      (agentCfg?.elevatedDefault as ElevatedLevel | undefined) ??
      (elevatedAllowed ? ("on" as ElevatedLevel) : ("off" as ElevatedLevel));
    const prevReasoningLevel =
      (sessionEntry.reasoningLevel as ReasoningLevel | undefined) ?? "off";
    let elevatedChanged =
      directives.hasElevatedDirective &&
      directives.elevatedLevel !== undefined &&
      elevatedEnabled &&
      elevatedAllowed;
    let reasoningChanged =
      directives.hasReasoningDirective &&
      directives.reasoningLevel !== undefined;
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
        (directives.elevatedLevel !== prevElevatedLevel &&
          directives.elevatedLevel !== undefined);
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
                sessionKey,
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
      if (elevatedChanged) {
        const nextElevated = (sessionEntry.elevatedLevel ??
          "off") as ElevatedLevel;
        enqueueSystemEvent(formatElevatedEvent(nextElevated), {
          sessionKey,
          contextKey: "mode:elevated",
        });
      }
      if (reasoningChanged) {
        const nextReasoning = (sessionEntry.reasoningLevel ??
          "off") as ReasoningLevel;
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

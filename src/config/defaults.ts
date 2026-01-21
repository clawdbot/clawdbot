import { parseModelRef } from "../agents/model-selection.js";
import { resolveTalkApiKey } from "./talk.js";
import type { ClawdbotConfig } from "./types.js";
import { DEFAULT_AGENT_MAX_CONCURRENT, DEFAULT_SUBAGENT_MAX_CONCURRENT } from "./agent-limits.js";

type WarnState = { warned: boolean };

let defaultWarnState: WarnState = { warned: false };

type AnthropicAuthDefaultsMode = "api_key" | "oauth";

const DEFAULT_MODEL_ALIASES: Readonly<Record<string, string>> = {
  // Anthropic (pi-ai catalog uses "latest" ids without date suffix)
  opus: "anthropic/claude-opus-4-5",
  sonnet: "anthropic/claude-sonnet-4-5",

  // OpenAI
  gpt: "openai/gpt-5.2",
  "gpt-mini": "openai/gpt-5-mini",

  // Google Gemini (3.x are preview ids in the catalog)
  gemini: "google/gemini-3-pro-preview",
  "gemini-flash": "google/gemini-3-flash-preview",
};

function resolveAnthropicDefaultAuthMode(cfg: ClawdbotConfig): AnthropicAuthDefaultsMode | null {
  const profiles = cfg.auth?.profiles ?? {};
  const anthropicProfiles = Object.entries(profiles).filter(
    ([, profile]) => profile?.provider === "anthropic",
  );

  const order = cfg.auth?.order?.anthropic ?? [];
  for (const profileId of order) {
    const entry = profiles[profileId];
    if (!entry || entry.provider !== "anthropic") continue;
    if (entry.mode === "api_key") return "api_key";
    if (entry.mode === "oauth" || entry.mode === "token") return "oauth";
  }

  const hasApiKey = anthropicProfiles.some(([, profile]) => profile?.mode === "api_key");
  const hasOauth = anthropicProfiles.some(
    ([, profile]) => profile?.mode === "oauth" || profile?.mode === "token",
  );
  if (hasApiKey && !hasOauth) return "api_key";
  if (hasOauth && !hasApiKey) return "oauth";

  if (process.env.ANTHROPIC_OAUTH_TOKEN?.trim()) return "oauth";
  if (process.env.ANTHROPIC_API_KEY?.trim()) return "api_key";
  return null;
}

function resolvePrimaryModelRef(raw?: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const aliasKey = trimmed.toLowerCase();
  return DEFAULT_MODEL_ALIASES[aliasKey] ?? trimmed;
}

export type SessionDefaultsOptions = {
  warn?: (message: string) => void;
  warnState?: WarnState;
};

export function applyMessageDefaults(cfg: ClawdbotConfig): ClawdbotConfig {
  const messages = cfg.messages;
  const hasAckScope = messages?.ackReactionScope !== undefined;
  if (hasAckScope) return cfg;

  const nextMessages = messages ? { ...messages } : {};
  nextMessages.ackReactionScope = "group-mentions";
  return {
    ...cfg,
    messages: nextMessages,
  };
}

export function applySessionDefaults(
  cfg: ClawdbotConfig,
  options: SessionDefaultsOptions = {},
): ClawdbotConfig {
  const session = cfg.session;
  if (!session || session.mainKey === undefined) return cfg;

  const trimmed = session.mainKey.trim();
  const warn = options.warn ?? console.warn;
  const warnState = options.warnState ?? defaultWarnState;

  const next: ClawdbotConfig = {
    ...cfg,
    session: { ...session, mainKey: "main" },
  };

  if (trimmed && trimmed !== "main" && !warnState.warned) {
    warnState.warned = true;
    warn('session.mainKey is ignored; main session is always "main".');
  }

  return next;
}

export function applyTalkApiKey(config: ClawdbotConfig): ClawdbotConfig {
  const resolved = resolveTalkApiKey();
  if (!resolved) return config;
  const existing = config.talk?.apiKey?.trim();
  if (existing) return config;
  return {
    ...config,
    talk: {
      ...config.talk,
      apiKey: resolved,
    },
  };
}

export function applyModelDefaults(cfg: ClawdbotConfig): ClawdbotConfig {
  const existingAgent = cfg.agents?.defaults;
  if (!existingAgent) return cfg;
  const existingModels = existingAgent.models ?? {};
  if (Object.keys(existingModels).length === 0) return cfg;

  let mutated = false;
  const nextModels: Record<string, { alias?: string }> = {
    ...existingModels,
  };

  for (const [alias, target] of Object.entries(DEFAULT_MODEL_ALIASES)) {
    const entry = nextModels[target];
    if (!entry) continue;
    if (entry.alias !== undefined) continue;
    nextModels[target] = { ...entry, alias };
    mutated = true;
  }

  if (!mutated) return cfg;

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: { ...existingAgent, models: nextModels },
    },
  };
}

export function applyAgentDefaults(cfg: ClawdbotConfig): ClawdbotConfig {
  const agents = cfg.agents;
  const defaults = agents?.defaults;
  const hasMax =
    typeof defaults?.maxConcurrent === "number" && Number.isFinite(defaults.maxConcurrent);
  const hasSubMax =
    typeof defaults?.subagents?.maxConcurrent === "number" &&
    Number.isFinite(defaults.subagents.maxConcurrent);
  if (hasMax && hasSubMax) return cfg;

  let mutated = false;
  const nextDefaults = defaults ? { ...defaults } : {};
  if (!hasMax) {
    nextDefaults.maxConcurrent = DEFAULT_AGENT_MAX_CONCURRENT;
    mutated = true;
  }

  const nextSubagents = defaults?.subagents ? { ...defaults.subagents } : {};
  if (!hasSubMax) {
    nextSubagents.maxConcurrent = DEFAULT_SUBAGENT_MAX_CONCURRENT;
    mutated = true;
  }

  if (!mutated) return cfg;

  return {
    ...cfg,
    agents: {
      ...agents,
      defaults: {
        ...nextDefaults,
        subagents: nextSubagents,
      },
    },
  };
}

export function applyLoggingDefaults(cfg: ClawdbotConfig): ClawdbotConfig {
  const logging = cfg.logging;
  if (!logging) return cfg;
  if (logging.redactSensitive) return cfg;
  return {
    ...cfg,
    logging: {
      ...logging,
      redactSensitive: "tools",
    },
  };
}

export function applyContextPruningDefaults(cfg: ClawdbotConfig): ClawdbotConfig {
  const defaults = cfg.agents?.defaults;
  if (!defaults) return cfg;

  const authMode = resolveAnthropicDefaultAuthMode(cfg);
  if (!authMode) return cfg;

  let mutated = false;
  const nextDefaults = { ...defaults };

  if (defaults.contextPruning?.mode === undefined) {
    nextDefaults.contextPruning = {
      ...(defaults.contextPruning ?? {}),
      mode: "cache-ttl",
      ttl: defaults.contextPruning?.ttl ?? "1h",
    };
    mutated = true;
  }

  if (defaults.heartbeat?.every === undefined) {
    nextDefaults.heartbeat = {
      ...(defaults.heartbeat ?? {}),
      every: authMode === "oauth" ? "1h" : "30m",
    };
    mutated = true;
  }

  if (authMode === "api_key") {
    const nextModels = defaults.models ? { ...defaults.models } : {};
    let modelsMutated = false;

    for (const [key, entry] of Object.entries(nextModels)) {
      const parsed = parseModelRef(key, "anthropic");
      if (!parsed || parsed.provider !== "anthropic") continue;
      const current = entry ?? {};
      const params = (current as { params?: Record<string, unknown> }).params ?? {};
      if (typeof params.cacheControlTtl === "string") continue;
      nextModels[key] = {
        ...(current as Record<string, unknown>),
        params: { ...params, cacheControlTtl: "1h" },
      };
      modelsMutated = true;
    }

    const primary = resolvePrimaryModelRef(defaults.model?.primary ?? undefined);
    if (primary) {
      const parsedPrimary = parseModelRef(primary, "anthropic");
      if (parsedPrimary?.provider === "anthropic") {
        const key = `${parsedPrimary.provider}/${parsedPrimary.model}`;
        const entry = nextModels[key];
        const current = entry ?? {};
        const params = (current as { params?: Record<string, unknown> }).params ?? {};
        if (typeof params.cacheControlTtl !== "string") {
          nextModels[key] = {
            ...(current as Record<string, unknown>),
            params: { ...params, cacheControlTtl: "1h" },
          };
          modelsMutated = true;
        }
      }
    }

    if (modelsMutated) {
      nextDefaults.models = nextModels;
      mutated = true;
    }
  }

  if (!mutated) return cfg;

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: nextDefaults,
    },
  };
}

export function applyCompactionDefaults(cfg: ClawdbotConfig): ClawdbotConfig {
  const defaults = cfg.agents?.defaults;
  if (!defaults) return cfg;
  const compaction = defaults?.compaction;
  if (compaction?.mode) return cfg;

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        compaction: {
          ...compaction,
          mode: "safeguard",
        },
      },
    },
  };
}

export function resetSessionDefaultsWarningForTests() {
  defaultWarnState = { warned: false };
}

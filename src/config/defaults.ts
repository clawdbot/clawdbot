import { resolveTalkApiKey } from "./talk.js";
import type { ClawdbotConfig } from "./types.js";

type WarnState = { warned: boolean };

let defaultWarnState: WarnState = { warned: false };

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

export type SessionDefaultsOptions = {
  warn?: (message: string) => void;
  warnState?: WarnState;
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyIdentityDefaults(cfg: ClawdbotConfig): ClawdbotConfig {
  const identity = cfg.identity;
  if (!identity) return cfg;

  const name = identity.name?.trim();

  const routing = cfg.routing ?? {};
  const groupChat = routing.groupChat ?? {};

  let mutated = false;
  const next: ClawdbotConfig = { ...cfg };

  if (name && !groupChat.mentionPatterns) {
    const parts = name.split(/\s+/).filter(Boolean).map(escapeRegExp);
    const re = parts.length ? parts.join("\\s+") : escapeRegExp(name);
    const pattern = `\\b@?${re}\\b`;
    next.routing = {
      ...(next.routing ?? routing),
      groupChat: { ...groupChat, mentionPatterns: [pattern] },
    };
    mutated = true;
  }

  return mutated ? next : cfg;
}

export function applyMessageDefaults(cfg: ClawdbotConfig): ClawdbotConfig {
  const messages = cfg.messages;
  const hasAckReaction = messages?.ackReaction !== undefined;
  const hasAckScope = messages?.ackReactionScope !== undefined;
  if (hasAckReaction && hasAckScope) return cfg;

  const fallbackEmoji = cfg.identity?.emoji?.trim() || "👀";
  const nextMessages = messages ? { ...messages } : {};
  let mutated = false;

  if (!hasAckReaction) {
    nextMessages.ackReaction = fallbackEmoji;
    mutated = true;
  }
  if (!hasAckScope) {
    nextMessages.ackReactionScope = "group-mentions";
    mutated = true;
  }

  if (!mutated) return cfg;
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
  const existingAgent = cfg.agent;
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
    agent: {
      ...existingAgent,
      models: nextModels,
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

export function resetSessionDefaultsWarningForTests() {
  defaultWarnState = { warned: false };
}

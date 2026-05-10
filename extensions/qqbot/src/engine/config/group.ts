import { asOptionalObjectRecord as asRecord } from "../utils/string-normalize.js";
import { resolveAccountBase } from "./resolve.js";

type GroupToolPolicy = "full" | "restricted" | "none";

interface GroupConfig {
  requireMention: boolean;
  ignoreOtherMentions: boolean;
  toolPolicy: GroupToolPolicy;
  name: string;
  prompt?: string;
  historyLimit: number;
}

export const DEFAULT_GROUP_HISTORY_LIMIT = 50;

export const DEFAULT_GROUP_PROMPT =
  "If the sender is a bot, respond only when they explicitly @mention you to ask a question or request assistance with a specific task; keep your replies concise and clear, avoiding the urge to race other bots to answer or engage in lengthy, unproductive exchanges. In group chats, prioritize responding to messages from human users; bots should maintain a collaborative rather than competitive dynamic to ensure the conversation remains orderly and does not result in message flooding.";

const DEFAULT_GROUP_CONFIG: Readonly<Omit<GroupConfig, "prompt">> = {
  requireMention: true,
  ignoreOtherMentions: false,
  toolPolicy: "restricted",
  name: "",
  historyLimit: DEFAULT_GROUP_HISTORY_LIMIT,
};

function readGroupsMap(
  cfg: Record<string, unknown>,
  accountId?: string | null,
): Record<string, Record<string, unknown>> {
  const account = resolveAccountBase(cfg, accountId);
  const groups = asRecord(account.config.groups);
  if (!groups) {
    return {};
  }
  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(groups)) {
    const sub = asRecord(value);
    if (sub) {
      normalized[key] = sub;
    }
  }
  return normalized;
}

function readBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  return typeof v === "boolean" ? v : undefined;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function readToolPolicy(obj: Record<string, unknown>, key: string): GroupToolPolicy | undefined {
  const v = obj[key];
  return v === "full" || v === "restricted" || v === "none" ? v : undefined;
}

function readHistoryLimit(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return undefined;
  }
  return Math.max(0, Math.floor(v));
}

export function resolveGroupConfig(
  cfg: Record<string, unknown>,
  groupOpenid?: string | null,
  accountId?: string | null,
): GroupConfig {
  const groups = readGroupsMap(cfg, accountId);
  const wildcard = groups["*"] ?? {};
  const specific = groupOpenid ? (groups[groupOpenid] ?? {}) : {};

  return {
    requireMention:
      readBoolean(specific, "requireMention") ??
      readBoolean(wildcard, "requireMention") ??
      DEFAULT_GROUP_CONFIG.requireMention,
    ignoreOtherMentions:
      readBoolean(specific, "ignoreOtherMentions") ??
      readBoolean(wildcard, "ignoreOtherMentions") ??
      DEFAULT_GROUP_CONFIG.ignoreOtherMentions,
    toolPolicy:
      readToolPolicy(specific, "toolPolicy") ??
      readToolPolicy(wildcard, "toolPolicy") ??
      DEFAULT_GROUP_CONFIG.toolPolicy,
    name: readString(specific, "name") ?? readString(wildcard, "name") ?? DEFAULT_GROUP_CONFIG.name,
    prompt: readString(specific, "prompt") ?? readString(wildcard, "prompt"),
    historyLimit:
      readHistoryLimit(specific, "historyLimit") ??
      readHistoryLimit(wildcard, "historyLimit") ??
      DEFAULT_GROUP_CONFIG.historyLimit,
  };
}

export function resolveHistoryLimit(
  cfg: Record<string, unknown>,
  groupOpenid?: string | null,
  accountId?: string | null,
): number {
  return resolveGroupConfig(cfg, groupOpenid, accountId).historyLimit;
}

export function resolveRequireMention(
  cfg: Record<string, unknown>,
  groupOpenid?: string | null,
  accountId?: string | null,
): boolean {
  return resolveGroupConfig(cfg, groupOpenid, accountId).requireMention;
}

export function resolveIgnoreOtherMentions(
  cfg: Record<string, unknown>,
  groupOpenid?: string | null,
  accountId?: string | null,
): boolean {
  return resolveGroupConfig(cfg, groupOpenid, accountId).ignoreOtherMentions;
}

/** Resolve tool policy for a given group. */
export function resolveGroupToolPolicy(
  cfg: Record<string, unknown>,
  groupOpenid?: string | null,
  accountId?: string | null,
): GroupToolPolicy {
  return resolveGroupConfig(cfg, groupOpenid, accountId).toolPolicy;
}

/**
 * Resolve the behaviour prompt (PE) for a group. Falls back to the built-in
 * default when neither specific nor wildcard configuration provides one.
 */
export function resolveGroupPrompt(
  cfg: Record<string, unknown>,
  groupOpenid?: string | null,
  accountId?: string | null,
): string {
  return resolveGroupConfig(cfg, groupOpenid, accountId).prompt ?? DEFAULT_GROUP_PROMPT;
}

/**
 * Resolve the display name for a group.
 *
 * When no name is configured, the first 8 characters of the openid are used
 * as a short identifier so log lines stay compact.
 */
export function resolveGroupName(
  cfg: Record<string, unknown>,
  groupOpenid: string,
  accountId?: string | null,
): string {
  const name = resolveGroupConfig(cfg, groupOpenid, accountId).name;
  return name || groupOpenid.slice(0, 8);
}

// ============ GroupSettings (aggregate) ============

/**
 * Per-inbound aggregate of everything the pipeline needs about a group.
 *
 * Built once at the top of the group-gate stage so downstream consumers
 * don't repeatedly re-parse the same `cfg` tree. Superset of
 * {@link GroupConfig}: also includes the effective `mentionPatterns`
 * (which depend on `agentId`, not on the group itself) and a
 * pre-computed display name for logging.
 */
interface GroupSettings {
  /** Merged group config (specific > wildcard > defaults). */
  config: GroupConfig;
  /** Display name — `config.name` or the first 8 chars of the openid. */
  name: string;
  /** Raw mentionPatterns (agent > global > []). */
  mentionPatterns: string[];
}

export function resolveGroupSettings(params: {
  cfg: Record<string, unknown>;
  groupOpenid: string;
  accountId?: string | null;
  agentId?: string | null;
}): GroupSettings {
  const config = resolveGroupConfig(params.cfg, params.groupOpenid, params.accountId);
  const name = config.name || params.groupOpenid.slice(0, 8);
  const mentionPatterns = resolveMentionPatterns(params.cfg, params.agentId);
  return { config, name, mentionPatterns };
}

interface AgentEntry {
  id?: unknown;
  groupChat?: { mentionPatterns?: unknown };
}

export function resolveMentionPatterns(
  cfg: Record<string, unknown>,
  agentId?: string | null,
): string[] {
  if (agentId) {
    const agents = asRecord(cfg.agents);
    const list = Array.isArray(agents?.list) ? (agents?.list as AgentEntry[]) : [];
    const entry = list.find(
      (a) => typeof a.id === "string" && a.id.trim().toLowerCase() === agentId.trim().toLowerCase(),
    );
    const agentGroupChat = entry?.groupChat;
    if (agentGroupChat && Object.hasOwn(agentGroupChat, "mentionPatterns")) {
      const patterns = agentGroupChat.mentionPatterns;
      return Array.isArray(patterns)
        ? patterns.filter((p): p is string => typeof p === "string")
        : [];
    }
  }

  const messages = asRecord(cfg.messages);
  const globalGroupChat = asRecord(messages?.groupChat);
  if (globalGroupChat && Object.hasOwn(globalGroupChat, "mentionPatterns")) {
    const patterns = globalGroupChat.mentionPatterns;
    return Array.isArray(patterns)
      ? patterns.filter((p): p is string => typeof p === "string")
      : [];
  }

  return [];
}

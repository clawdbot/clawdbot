// Qqbot plugin module implements group behavior.
import { resolveScopeRequireMention, type ScopeTree } from "openclaw/plugin-sdk/channel-policy";
import { asBoolean } from "openclaw/plugin-sdk/string-coerce-runtime";
import { asOptionalObjectRecord as asRecord } from "../utils/string-normalize.js";
import { resolveAccountBase } from "./resolve.js";

interface GroupConfig {
  requireMention: boolean;
  ignoreOtherMentions: boolean;
  commandLevel: QQBotGroupCommandLevel;
  name: string;
  prompt?: string;
  historyLimit: number;
}

export type QQBotGroupCommandLevel = "all" | "safety" | "strict";

const DEFAULT_GROUP_HISTORY_LIMIT = 50;
// Omitted commandLevel preserves shipped QQBot group behavior. Operators opt in to
// the fail-closed safety/strict modes per group or wildcard group config.
const DEFAULT_GROUP_COMMAND_LEVEL: QQBotGroupCommandLevel = "all";

export const DEFAULT_GROUP_PROMPT =
  "If the sender is a bot, respond only when they explicitly @mention you to ask a question or request assistance with a specific task; keep your replies concise and clear, avoiding the urge to race other bots to answer or engage in lengthy, unproductive exchanges. In group chats, prioritize responding to messages from human users; bots should maintain a collaborative rather than competitive dynamic to ensure the conversation remains orderly and does not result in message flooding.";

const DEFAULT_GROUP_CONFIG: Readonly<Omit<GroupConfig, "prompt">> = {
  requireMention: true,
  ignoreOtherMentions: false,
  commandLevel: DEFAULT_GROUP_COMMAND_LEVEL,
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
  return asBoolean(obj[key]);
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function readCommandLevel(
  obj: Record<string, unknown>,
  key: string,
): QQBotGroupCommandLevel | undefined {
  const v = readString(obj, key);
  return v === "all" || v === "safety" || v === "strict" ? v : undefined;
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
  const account = resolveAccountBase(cfg, accountId);
  const groups = readGroupsMap(cfg, accountId);
  const { "*": wildcard = {}, ...scopes } = groups;
  const specific = groupOpenid ? (groups[groupOpenid] ?? {}) : {};

  // 账户级默认值：defaultRequireMention 配置 > 默认 true
  const accountDefaultRequireMention = asBoolean(account.config.defaultRequireMention);
  const mentionTree: ScopeTree = {
    defaults: { requireMention: readBoolean(wildcard, "requireMention") },
    scopes: Object.fromEntries(
      Object.entries(scopes).map(([key, entry]) => [
        key,
        { requireMention: readBoolean(entry, "requireMention") },
      ]),
    ),
  };
  // Engine mention matching stays exact and case-sensitive. QQBot's tool-policy
  // adapter is intentionally case-insensitive, so these paths remain asymmetric.
  const mentionPath =
    groupOpenid && Object.hasOwn(mentionTree.scopes, groupOpenid) ? [groupOpenid] : [];

  return {
    requireMention: resolveScopeRequireMention({
      tree: mentionTree,
      path: mentionPath,
      requireMentionOverride: accountDefaultRequireMention,
      overrideOrder: "after-config",
    }),
    ignoreOtherMentions:
      readBoolean(specific, "ignoreOtherMentions") ??
      readBoolean(wildcard, "ignoreOtherMentions") ??
      DEFAULT_GROUP_CONFIG.ignoreOtherMentions,
    commandLevel:
      readCommandLevel(specific, "commandLevel") ??
      readCommandLevel(wildcard, "commandLevel") ??
      DEFAULT_GROUP_CONFIG.commandLevel,
    name: readString(specific, "name") ?? readString(wildcard, "name") ?? DEFAULT_GROUP_CONFIG.name,
    prompt: readString(specific, "prompt") ?? readString(wildcard, "prompt"),
    historyLimit:
      readHistoryLimit(specific, "historyLimit") ??
      readHistoryLimit(wildcard, "historyLimit") ??
      DEFAULT_GROUP_CONFIG.historyLimit,
  };
}

export function resolveGroupCommandLevelFromAccountConfig(
  accountConfig: Record<string, unknown> | undefined,
  groupOpenid?: string | null,
): QQBotGroupCommandLevel {
  const groups = asRecord(accountConfig?.groups);
  const wildcard = asRecord(groups?.["*"]) ?? {};
  const specific = groupOpenid ? (asRecord(groups?.[groupOpenid]) ?? {}) : {};
  return (
    readCommandLevel(specific, "commandLevel") ??
    readCommandLevel(wildcard, "commandLevel") ??
    DEFAULT_GROUP_CONFIG.commandLevel
  );
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

import {
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import { resolveChannelConfigWrites } from "../../channels/plugins/config-writes.js";
import { getChannelDock } from "../../channels/dock.js";
import { normalizeChannelId } from "../../channels/registry.js";
import { listPairingChannels } from "../../channels/plugins/pairing.js";
import { logVerbose } from "../../globals.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { resolveDiscordAccount } from "../../discord/accounts.js";
import { resolveIMessageAccount } from "../../imessage/accounts.js";
import { resolveSignalAccount } from "../../signal/accounts.js";
import { resolveSlackAccount } from "../../slack/accounts.js";
import { resolveTelegramAccount } from "../../telegram/accounts.js";
import { resolveWhatsAppAccount } from "../../web/accounts.js";
import { resolveSlackUserAllowlist } from "../../slack/resolve-users.js";
import { resolveDiscordUserAllowlist } from "../../discord/resolve-users.js";
import {
  addChannelAllowFromStoreEntry,
  readChannelAllowFromStore,
  removeChannelAllowFromStoreEntry,
} from "../../pairing/pairing-store.js";
import type { MoltbotConfig } from "../../config/config.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { CommandHandler } from "./commands-types.js";

type AllowlistScope = "dm" | "group" | "all";
type AllowlistAction = "list" | "add" | "remove";
type AllowlistTarget = "both" | "config" | "store";

type AllowlistCommand =
  | {
      action: "list";
      scope: AllowlistScope;
      channel?: string;
      account?: string;
      resolve?: boolean;
    }
  | {
      action: "add" | "remove";
      scope: AllowlistScope;
      channel?: string;
      account?: string;
      entry: string;
      resolve?: boolean;
      target: AllowlistTarget;
    }
  | { action: "error"; message: string };

const ACTIONS = new Set(["list", "add", "remove"]);
const SCOPES = new Set<AllowlistScope>(["dm", "group", "all"]);

function parseAllowlistCommand(raw: string): AllowlistCommand | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("/allowlist")) return null;
  const rest = trimmed.slice("/allowlist".length).trim();
  if (!rest) return { action: "list", scope: "dm" };

  const tokens = rest.split(/\s+/);
  let action: AllowlistAction = "list";
  let scope: AllowlistScope = "dm";
  let resolve = false;
  let target: AllowlistTarget = "both";
  let channel: string | undefined;
  let account: string | undefined;
  const entryTokens: string[] = [];

  let i = 0;
  if (tokens[i] && ACTIONS.has(tokens[i].toLowerCase())) {
    action = tokens[i].toLowerCase() as AllowlistAction;
    i += 1;
  }
  if (tokens[i] && SCOPES.has(tokens[i].toLowerCase() as AllowlistScope)) {
    scope = tokens[i].toLowerCase() as AllowlistScope;
    i += 1;
  }

  for (; i < tokens.length; i += 1) {
    const token = tokens[i];
    const lowered = token.toLowerCase();
    if (lowered === "--resolve" || lowered === "resolve") {
      resolve = true;
      continue;
    }
    if (lowered === "--config" || lowered === "config") {
      target = "config";
      continue;
    }
    if (lowered === "--store" || lowered === "store") {
      target = "store";
      continue;
    }
    if (lowered === "--channel" && tokens[i + 1]) {
      channel = tokens[i + 1];
      i += 1;
      continue;
    }
    if (lowered === "--account" && tokens[i + 1]) {
      account = tokens[i + 1];
      i += 1;
      continue;
    }
    const kv = token.split("=");
    if (kv.length === 2) {
      const key = kv[0]?.trim().toLowerCase();
      const value = kv[1]?.trim();
      if (key === "channel") {
        if (value) channel = value;
        continue;
      }
      if (key === "account") {
        if (value) account = value;
        continue;
      }
      if (key === "scope" && value && SCOPES.has(value.toLowerCase() as AllowlistScope)) {
        scope = value.toLowerCase() as AllowlistScope;
        continue;
      }
    }
    entryTokens.push(token);
  }

  if (action === "add" || action === "remove") {
    const entry = entryTokens.join(" ").trim();
    if (!entry) {
      return { action: "error", message: "Usage: /allowlist add|remove <entry>" };
    }
    return { action, scope, entry, channel, account, resolve, target };
  }

  return { action: "list", scope, channel, account, resolve };
}

function normalizeAllowFrom(params: {
  cfg: MoltbotConfig;
  channelId: ChannelId;
  accountId?: string | null;
  values: Array<string | number>;
}): string[] {
  const dock = getChannelDock(params.channelId);
  if (dock?.config?.formatAllowFrom) {
    return dock.config.formatAllowFrom({
      cfg: params.cfg,
      accountId: params.accountId,
      allowFrom: params.values,
    });
  }
  return params.values.map((entry) => String(entry).trim()).filter(Boolean);
}

function formatEntryList(entries: string[], resolved?: Map<string, string>): string {
  if (entries.length === 0) return "(none)";
  return entries
    .map((entry) => {
      const name = resolved?.get(entry);
      return name ? `${entry} (${name})` : entry;
    })
    .join(", ");
}

function resolveAccountTarget(
  parsed: Record<string, unknown>,
  channelId: ChannelId,
  accountId?: string | null,
) {
  const channels = (parsed.channels ??= {}) as Record<string, unknown>;
  const channel = (channels[channelId] ??= {}) as Record<string, unknown>;
  const normalizedAccountId = normalizeAccountId(accountId);
  const hasAccounts = Boolean(channel.accounts && typeof channel.accounts === "object");
  const useAccount = normalizedAccountId !== DEFAULT_ACCOUNT_ID || hasAccounts;
  if (!useAccount) {
    return { target: channel, pathPrefix: `channels.${channelId}`, accountId: normalizedAccountId };
  }
  const accounts = (channel.accounts ??= {}) as Record<string, unknown>;
  const account = (accounts[normalizedAccountId] ??= {}) as Record<string, unknown>;
  return {
    target: account,
    pathPrefix: `channels.${channelId}.accounts.${normalizedAccountId}`,
    accountId: normalizedAccountId,
  };
}

function getNestedValue(root: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function ensureNestedObject(
  root: Record<string, unknown>,
  path: string[],
): Record<string, unknown> {
  let current = root;
  for (const key of path) {
    const existing = current[key];
    if (!existing || typeof existing !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  return current;
}

function setNestedValue(root: Record<string, unknown>, path: string[], value: unknown) {
  if (path.length === 0) return;
  if (path.length === 1) {
    root[path[0]] = value;
    return;
  }
  const parent = ensureNestedObject(root, path.slice(0, -1));
  parent[path[path.length - 1]] = value;
}

function deleteNestedValue(root: Record<string, unknown>, path: string[]) {
  if (path.length === 0) return;
  if (path.length === 1) {
    delete root[path[0]];
    return;
  }
  const parent = getNestedValue(root, path.slice(0, -1));
  if (!parent || typeof parent !== "object") return;
  delete (parent as Record<string, unknown>)[path[path.length - 1]];
}

function resolveChannelAllowFromPaths(
  channelId: ChannelId,
  scope: AllowlistScope,
): string[] | null {
  if (scope === "all") return null;
  if (scope === "dm") {
    if (channelId === "slack" || channelId === "discord") return ["dm", "allowFrom"];
    if (
      channelId === "telegram" ||
      channelId === "whatsapp" ||
      channelId === "signal" ||
      channelId === "imessage"
    ) {
      return ["allowFrom"];
    }
    return null;
  }
  if (scope === "group") {
    if (
      channelId === "telegram" ||
      channelId === "whatsapp" ||
      channelId === "signal" ||
      channelId === "imessage"
    ) {
      return ["groupAllowFrom"];
    }
    return null;
  }
  return null;
}

async function resolveSlackNames(params: {
  cfg: MoltbotConfig;
  accountId?: string | null;
  entries: string[];
}) {
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const token = account.config.userToken?.trim() || account.botToken?.trim();
  if (!token) return new Map<string, string>();
  const resolved = await resolveSlackUserAllowlist({ token, entries: params.entries });
  const map = new Map<string, string>();
  for (const entry of resolved) {
    if (entry.resolved && entry.name) map.set(entry.input, entry.name);
  }
  return map;
}

async function resolveDiscordNames(params: {
  cfg: MoltbotConfig;
  accountId?: string | null;
  entries: string[];
}) {
  const account = resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
  const token = account.token?.trim();
  if (!token) return new Map<string, string>();
  const resolved = await resolveDiscordUserAllowlist({ token, entries: params.entries });
  const map = new Map<string, string>();
  for (const entry of resolved) {
    if (entry.resolved && entry.name) map.set(entry.input, entry.name);
  }
  return map;
}

export const handleAllowlistCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) return null;
  const parsed = parseAllowlistCommand(params.command.commandBodyNormalized);
  if (!parsed) return null;
  if (parsed.action === "error") {
    return { shouldContinue: false, reply: { text: `⚠️ ${parsed.message}` } };
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /allowlist from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const channelId =
    normalizeChannelId(parsed.channel) ??
    params.command.channelId ??
    normalizeChannelId(params.command.channel);
  if (!channelId) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Unknown channel. Add channel=<id> to the command." },
    };
  }
  const accountId = normalizeAccountId(parsed.account ?? params.ctx.AccountId);
  const scope = parsed.scope;

  if (parsed.action === "list") {
    const pairingChannels = listPairingChannels();
    const supportsStore = pairingChannels.includes(channelId);
    const storeAllowFrom = supportsStore
      ? await readChannelAllowFromStore(channelId).catch(() => [])
      : [];

    let dmAllowFrom: string[] = [];
    let groupAllowFrom: string[] = [];
    let groupOverrides: Array<{ label: string; entries: string[] }> = [];
    let dmPolicy: string | undefined;
    let groupPolicy: string | undefined;

    if (channelId === "telegram") {
      const account = resolveTelegramAccount({ cfg: params.cfg, accountId });
      dmAllowFrom = (account.config.allowFrom ?? []).map(String);
      groupAllowFrom = (account.config.groupAllowFrom ?? []).map(String);
      dmPolicy = account.config.dmPolicy;
      groupPolicy = account.config.groupPolicy;
      const groups = account.config.groups ?? {};
      for (const [groupId, groupCfg] of Object.entries(groups)) {
        const entries = (groupCfg?.allowFrom ?? []).map(String).filter(Boolean);
        if (entries.length > 0) {
          groupOverrides.push({ label: groupId, entries });
        }
        const topics = groupCfg?.topics ?? {};
        for (const [topicId, topicCfg] of Object.entries(topics)) {
          const topicEntries = (topicCfg?.allowFrom ?? []).map(String).filter(Boolean);
          if (topicEntries.length > 0) {
            groupOverrides.push({ label: `${groupId} topic ${topicId}`, entries: topicEntries });
          }
        }
      }
    } else if (channelId === "whatsapp") {
      const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId });
      dmAllowFrom = (account.allowFrom ?? []).map(String);
      groupAllowFrom = (account.groupAllowFrom ?? []).map(String);
      dmPolicy = account.dmPolicy;
      groupPolicy = account.groupPolicy;
    } else if (channelId === "signal") {
      const account = resolveSignalAccount({ cfg: params.cfg, accountId });
      dmAllowFrom = (account.config.allowFrom ?? []).map(String);
      groupAllowFrom = (account.config.groupAllowFrom ?? []).map(String);
      dmPolicy = account.config.dmPolicy;
      groupPolicy = account.config.groupPolicy;
    } else if (channelId === "imessage") {
      const account = resolveIMessageAccount({ cfg: params.cfg, accountId });
      dmAllowFrom = (account.config.allowFrom ?? []).map(String);
      groupAllowFrom = (account.config.groupAllowFrom ?? []).map(String);
      dmPolicy = account.config.dmPolicy;
      groupPolicy = account.config.groupPolicy;
    } else if (channelId === "slack") {
      const account = resolveSlackAccount({ cfg: params.cfg, accountId });
      dmAllowFrom = (account.dm?.allowFrom ?? []).map(String);
      groupPolicy = account.groupPolicy;
      const channels = account.channels ?? {};
      groupOverrides = Object.entries(channels)
        .map(([key, value]) => {
          const entries = (value?.users ?? []).map(String).filter(Boolean);
          return entries.length > 0 ? { label: key, entries } : null;
        })
        .filter(Boolean) as Array<{ label: string; entries: string[] }>;
    } else if (channelId === "discord") {
      const account = resolveDiscordAccount({ cfg: params.cfg, accountId });
      dmAllowFrom = (account.config.dm?.allowFrom ?? []).map(String);
      groupPolicy = account.config.groupPolicy;
      const guilds = account.config.guilds ?? {};
      for (const [guildKey, guildCfg] of Object.entries(guilds)) {
        const entries = (guildCfg?.users ?? []).map(String).filter(Boolean);
        if (entries.length > 0) {
          groupOverrides.push({ label: `guild ${guildKey}`, entries });
        }
        const channels = guildCfg?.channels ?? {};
        for (const [channelKey, channelCfg] of Object.entries(channels)) {
          const channelEntries = (channelCfg?.users ?? []).map(String).filter(Boolean);
          if (channelEntries.length > 0) {
            groupOverrides.push({
              label: `guild ${guildKey} / channel ${channelKey}`,
              entries: channelEntries,
            });
          }
        }
      }
    }

    const dmDisplay = normalizeAllowFrom({
      cfg: params.cfg,
      channelId,
      accountId,
      values: dmAllowFrom,
    });
    const groupDisplay = normalizeAllowFrom({
      cfg: params.cfg,
      channelId,
      accountId,
      values: groupAllowFrom,
    });
    const groupOverrideEntries = groupOverrides.flatMap((entry) => entry.entries);
    const groupOverrideDisplay = normalizeAllowFrom({
      cfg: params.cfg,
      channelId,
      accountId,
      values: groupOverrideEntries,
    });
    const resolvedDm =
      parsed.resolve && dmDisplay.length > 0 && channelId === "slack"
        ? await resolveSlackNames({ cfg: params.cfg, accountId, entries: dmDisplay })
        : parsed.resolve && dmDisplay.length > 0 && channelId === "discord"
          ? await resolveDiscordNames({ cfg: params.cfg, accountId, entries: dmDisplay })
          : undefined;
    const resolvedGroup =
      parsed.resolve && groupOverrideDisplay.length > 0 && channelId === "slack"
        ? await resolveSlackNames({
            cfg: params.cfg,
            accountId,
            entries: groupOverrideDisplay,
          })
        : parsed.resolve && groupOverrideDisplay.length > 0 && channelId === "discord"
          ? await resolveDiscordNames({
              cfg: params.cfg,
              accountId,
              entries: groupOverrideDisplay,
            })
          : undefined;

    const lines: string[] = ["🧾 Allowlist"];
    lines.push(`Channel: ${channelId}${accountId ? ` (account ${accountId})` : ""}`);
    if (dmPolicy) lines.push(`DM policy: ${dmPolicy}`);
    if (groupPolicy) lines.push(`Group policy: ${groupPolicy}`);

    const showDm = scope === "dm" || scope === "all";
    const showGroup = scope === "group" || scope === "all";
    if (showDm) {
      lines.push(`DM allowFrom (config): ${formatEntryList(dmDisplay, resolvedDm)}`);
    }
    if (supportsStore && storeAllowFrom.length > 0) {
      const storeLabel = normalizeAllowFrom({
        cfg: params.cfg,
        channelId,
        accountId,
        values: storeAllowFrom,
      });
      lines.push(`Paired allowFrom (store): ${formatEntryList(storeLabel)}`);
    }
    if (showGroup) {
      if (groupAllowFrom.length > 0) {
        lines.push(`Group allowFrom (config): ${formatEntryList(groupDisplay)}`);
      }
      if (groupOverrides.length > 0) {
        lines.push("Group overrides:");
        for (const entry of groupOverrides) {
          const normalized = normalizeAllowFrom({
            cfg: params.cfg,
            channelId,
            accountId,
            values: entry.entries,
          });
          lines.push(`- ${entry.label}: ${formatEntryList(normalized, resolvedGroup)}`);
        }
      }
    }

    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  if (params.cfg.commands?.config !== true) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ /allowlist edits are disabled. Set commands.config=true to enable." },
    };
  }

  const shouldUpdateConfig = parsed.target !== "store";
  const shouldTouchStore = parsed.target !== "config" && listPairingChannels().includes(channelId);

  if (shouldUpdateConfig) {
    const allowWrites = resolveChannelConfigWrites({
      cfg: params.cfg,
      channelId,
      accountId: params.ctx.AccountId,
    });
    if (!allowWrites) {
      const hint = `channels.${channelId}.configWrites=true`;
      return {
        shouldContinue: false,
        reply: { text: `⚠️ Config writes are disabled for ${channelId}. Set ${hint} to enable.` },
      };
    }

    const allowlistPath = resolveChannelAllowFromPaths(channelId, scope);
    if (!allowlistPath) {
      return {
        shouldContinue: false,
        reply: {
          text: `⚠️ ${channelId} does not support ${scope} allowlist edits via /allowlist.`,
        },
      };
    }

    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
      return {
        shouldContinue: false,
        reply: { text: "⚠️ Config file is invalid; fix it before using /allowlist." },
      };
    }
    const parsedConfig = structuredClone(snapshot.parsed as Record<string, unknown>);
    const {
      target,
      pathPrefix,
      accountId: normalizedAccountId,
    } = resolveAccountTarget(parsedConfig, channelId, accountId);
    const existingRaw = getNestedValue(target, allowlistPath);
    const existing = Array.isArray(existingRaw)
      ? existingRaw.map((entry) => String(entry).trim()).filter(Boolean)
      : [];

    const normalizedEntry = normalizeAllowFrom({
      cfg: params.cfg,
      channelId,
      accountId: normalizedAccountId,
      values: [parsed.entry],
    });
    if (normalizedEntry.length === 0) {
      return {
        shouldContinue: false,
        reply: { text: "⚠️ Invalid allowlist entry." },
      };
    }

    const existingNormalized = normalizeAllowFrom({
      cfg: params.cfg,
      channelId,
      accountId: normalizedAccountId,
      values: existing,
    });

    const shouldMatch = (value: string) => normalizedEntry.includes(value);

    let configChanged = false;
    let next = existing;
    const configHasEntry = existingNormalized.some((value) => shouldMatch(value));
    if (parsed.action === "add") {
      if (!configHasEntry) {
        next = [...existing, parsed.entry.trim()];
        configChanged = true;
      }
    }

    if (parsed.action === "remove") {
      const keep: string[] = [];
      for (const entry of existing) {
        const normalized = normalizeAllowFrom({
          cfg: params.cfg,
          channelId,
          accountId: normalizedAccountId,
          values: [entry],
        });
        if (normalized.some((value) => shouldMatch(value))) {
          configChanged = true;
          continue;
        }
        keep.push(entry);
      }
      next = keep;
    }

    if (configChanged) {
      if (next.length === 0) {
        deleteNestedValue(target, allowlistPath);
      } else {
        setNestedValue(target, allowlistPath, next);
      }
    }

    if (configChanged) {
      const validated = validateConfigObjectWithPlugins(parsedConfig);
      if (!validated.ok) {
        const issue = validated.issues[0];
        return {
          shouldContinue: false,
          reply: { text: `⚠️ Config invalid after update (${issue.path}: ${issue.message}).` },
        };
      }
      await writeConfigFile(validated.config);
    }

    if (!configChanged && !shouldTouchStore) {
      const message = parsed.action === "add" ? "✅ Already allowlisted." : "⚠️ Entry not found.";
      return { shouldContinue: false, reply: { text: message } };
    }

    if (shouldTouchStore) {
      if (parsed.action === "add") {
        await addChannelAllowFromStoreEntry({ channel: channelId, entry: parsed.entry });
      } else if (parsed.action === "remove") {
        await removeChannelAllowFromStoreEntry({ channel: channelId, entry: parsed.entry });
      }
    }

    const actionLabel = parsed.action === "add" ? "added" : "removed";
    const scopeLabel = scope === "dm" ? "DM" : "group";
    const locations: string[] = [];
    if (configChanged) {
      locations.push(`${pathPrefix}.${allowlistPath.join(".")}`);
    }
    if (shouldTouchStore) {
      locations.push("pairing store");
    }
    const targetLabel = locations.length > 0 ? locations.join(" + ") : "no-op";
    return {
      shouldContinue: false,
      reply: {
        text: `✅ ${scopeLabel} allowlist ${actionLabel}: ${targetLabel}.`,
      },
    };
  }

  if (!shouldTouchStore) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ This channel does not support allowlist storage." },
    };
  }

  if (parsed.action === "add") {
    await addChannelAllowFromStoreEntry({ channel: channelId, entry: parsed.entry });
  } else if (parsed.action === "remove") {
    await removeChannelAllowFromStoreEntry({ channel: channelId, entry: parsed.entry });
  }

  const actionLabel = parsed.action === "add" ? "added" : "removed";
  const scopeLabel = scope === "dm" ? "DM" : "group";
  return {
    shouldContinue: false,
    reply: { text: `✅ ${scopeLabel} allowlist ${actionLabel} in pairing store.` },
  };
};

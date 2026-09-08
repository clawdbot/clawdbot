import { expectDefined } from "@openclaw/normalization-core";
/** Handles /allowlist commands across config and pairing-store targets. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolveExplicitConfigWriteTarget } from "../../channels/plugins/config-writes.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { normalizeChatChannelId } from "../../channels/registry.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  addChannelAllowFromStoreEntry,
  readChannelAllowFromStore,
  removeChannelAllowFromStoreEntry,
} from "../../pairing/pairing-store.js";
import { DEFAULT_ACCOUNT_ID, normalizeOptionalAccountId } from "../../routing/session-key.js";
import { resolveChannelAccountId, resolveCommandSurfaceChannel } from "./channel-context.js";
import {
  commandReply,
  rejectNonOwnerCommand,
  rejectUnauthorizedCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScope,
} from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { applyAllowlistConfigMutation, AutoReplyConfigMutationError } from "./config-mutations.js";
import { resolveConfigWriteDeniedText } from "./config-write-authorization.js";

type AllowlistScope = "dm" | "group" | "all";
type AllowlistAction = "list" | "add" | "remove";
type AllowlistTarget = "both" | "config" | "store";
type ResolvedAllowlistName = {
  input: string;
  resolved: boolean;
  name?: string | null;
};

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

function resolveAllowlistAccountId(params: {
  cfg: OpenClawConfig;
  channelId: ChannelId;
  parsedAccount?: string;
  ctxAccountId?: string;
}): string {
  const explicitAccountId = normalizeOptionalAccountId(params.parsedAccount);
  if (explicitAccountId) {
    return explicitAccountId;
  }
  const plugin = getChannelPlugin(params.channelId);
  const configuredDefaultAccountId = normalizeOptionalString(
    plugin?.config.defaultAccountId?.(params.cfg),
  );
  const ctxAccountId = normalizeOptionalAccountId(params.ctxAccountId);
  return configuredDefaultAccountId || ctxAccountId || DEFAULT_ACCOUNT_ID;
}

function parseAllowlistCommand(raw: string): AllowlistCommand | null {
  const trimmed = raw.trim();
  const trimmedLower = normalizeOptionalLowercaseString(trimmed) ?? "";
  if (!trimmedLower.startsWith("/allowlist")) {
    return null;
  }
  const rest = trimmed.slice("/allowlist".length).trim();
  if (!rest) {
    return { action: "list", scope: "dm" };
  }

  const tokens = rest.split(/\s+/);
  let action: AllowlistAction = "list";
  let scope: AllowlistScope = "dm";
  let resolve = false;
  let target: AllowlistTarget = "both";
  let channel: string | undefined;
  let account: string | undefined;
  const entryTokens: string[] = [];

  let i = 0;
  const firstAction = normalizeOptionalLowercaseString(tokens[i]);
  if (firstAction && ACTIONS.has(firstAction)) {
    action = firstAction as AllowlistAction;
    i += 1;
  }
  const firstScope = normalizeOptionalLowercaseString(tokens[i]);
  if (firstScope && SCOPES.has(firstScope as AllowlistScope)) {
    scope = firstScope as AllowlistScope;
    i += 1;
  }

  for (; i < tokens.length; i += 1) {
    const token = expectDefined(tokens[i], "tokens entry at i");
    const lowered = normalizeOptionalLowercaseString(token) ?? "";
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
      const key = normalizeOptionalLowercaseString(kv[0]);
      const value = normalizeOptionalString(kv[1]);
      if (key === "channel") {
        if (value) {
          channel = value;
        }
        continue;
      }
      if (key === "account") {
        if (value) {
          account = value;
        }
        continue;
      }
      const normalizedValue = normalizeOptionalLowercaseString(value);
      if (key === "scope" && normalizedValue && SCOPES.has(normalizedValue as AllowlistScope)) {
        scope = normalizedValue as AllowlistScope;
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
  cfg: OpenClawConfig;
  channelId: ChannelId;
  accountId?: string | null;
  values: Array<string | number>;
}): string[] {
  const plugin = getChannelPlugin(params.channelId);
  if (plugin?.config.formatAllowFrom) {
    return plugin.config.formatAllowFrom({
      cfg: params.cfg,
      accountId: params.accountId,
      allowFrom: params.values,
    });
  }
  return normalizeStringEntries(params.values);
}

function formatEntryList(entries: string[], resolved?: Map<string, string>): string {
  if (entries.length === 0) {
    return "(none)";
  }
  return entries
    .map((entry) => {
      const name = resolved?.get(entry);
      return name ? `${entry} (${name})` : entry;
    })
    .join(", ");
}

async function updatePairingStoreAllowlist(params: {
  action: "add" | "remove";
  channelId: ChannelId;
  accountId?: string;
  entry: string;
}) {
  const storeEntry = {
    channel: params.channelId,
    entry: params.entry,
    accountId: params.accountId,
  };
  if (params.action === "add") {
    await addChannelAllowFromStoreEntry(storeEntry);
    return;
  }

  await removeChannelAllowFromStoreEntry(storeEntry);
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    await removeChannelAllowFromStoreEntry({
      channel: params.channelId,
      entry: params.entry,
    });
  }
}

async function resolveAllowlistNames(params: {
  cfg: OpenClawConfig;
  channelId: ChannelId;
  accountId?: string | null;
  scope: "dm" | "group";
  entries: string[];
}) {
  const plugin = getChannelPlugin(params.channelId);
  const resolved = await plugin?.allowlist?.resolveNames?.({
    cfg: params.cfg,
    accountId: params.accountId,
    scope: params.scope,
    entries: params.entries,
  });
  return new Map(
    (resolved ?? []).flatMap((entry: ResolvedAllowlistName) =>
      entry.resolved && entry.name ? [[entry.input, entry.name] as const] : [],
    ),
  );
}

async function readAllowlistConfig(params: {
  cfg: OpenClawConfig;
  channelId: ChannelId;
  accountId?: string | null;
}) {
  const plugin = getChannelPlugin(params.channelId);
  return (
    (await plugin?.allowlist?.readConfig?.({
      cfg: params.cfg,
      accountId: params.accountId,
    })) ?? {}
  );
}

/** Command handler for listing, adding, and removing allowlist entries. */
export const handleAllowlistCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseAllowlistCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  if (parsed.action === "error") {
    return commandReply(`⚠️ ${parsed.message}`);
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/allowlist");
  if (unauthorized) {
    return unauthorized;
  }
  if (parsed.action !== "list") {
    const nonOwner = rejectNonOwnerCommand(params, "/allowlist");
    if (nonOwner) {
      return nonOwner;
    }
  }

  const channelId =
    normalizeChatChannelId(parsed.channel) ??
    params.command.channelId ??
    normalizeChatChannelId(params.command.channel);
  if (!channelId) {
    return commandReply("⚠️ Unknown channel. Add channel=<id> to the command.");
  }
  if (normalizeOptionalString(parsed.account) && !normalizeOptionalAccountId(parsed.account)) {
    return commandReply(
      "⚠️ Invalid account id. Reserved keys (__proto__, constructor, prototype) are blocked.",
    );
  }
  const accountId = resolveAllowlistAccountId({
    cfg: params.cfg,
    channelId,
    parsedAccount: parsed.account,
    ctxAccountId: params.ctx.AccountId,
  });
  const originChannelId =
    params.command.channelId ?? normalizeChatChannelId(resolveCommandSurfaceChannel(params));
  const originAccountId = resolveChannelAccountId({
    cfg: params.cfg,
    ctx: params.ctx,
    command: params.command,
  });
  const plugin = getChannelPlugin(channelId);

  if (parsed.action === "list") {
    const supportsStore = Boolean(plugin?.pairing);
    if (!plugin?.allowlist?.readConfig && !supportsStore) {
      return commandReply(`⚠️ ${channelId} does not expose allowlist configuration.`);
    }
    let storeAllowFrom: string[] = [];
    let storeReadFailed = false;
    if (supportsStore) {
      try {
        storeAllowFrom = await readChannelAllowFromStore(channelId, process.env, accountId);
      } catch {
        storeReadFailed = true;
      }
    }
    const configState = await readAllowlistConfig({
      cfg: params.cfg,
      channelId,
      accountId,
    });

    const dmAllowFrom = (configState.dmAllowFrom ?? []).map(String);
    const groupAllowFrom = (configState.groupAllowFrom ?? []).map(String);
    const groupOverrides = (configState.groupOverrides ?? []).map((entry) => ({
      label: entry.label,
      entries: entry.entries.map(String).filter(Boolean),
    }));

    const normalizeValues = (values: Array<string | number>) =>
      normalizeAllowFrom({ cfg: params.cfg, channelId, accountId, values });
    const dmDisplay = normalizeValues(dmAllowFrom);
    const groupDisplay = normalizeValues(groupAllowFrom);
    const groupOverrideEntries = groupOverrides.flatMap((entry) => entry.entries);
    const groupOverrideDisplay = normalizeValues(groupOverrideEntries);

    const resolvedDm =
      parsed.resolve && dmDisplay.length > 0
        ? await resolveAllowlistNames({
            cfg: params.cfg,
            channelId,
            accountId,
            scope: "dm",
            entries: dmDisplay,
          })
        : undefined;
    const resolvedGroup =
      parsed.resolve && groupOverrideDisplay.length > 0
        ? await resolveAllowlistNames({
            cfg: params.cfg,
            channelId,
            accountId,
            scope: "group",
            entries: groupOverrideDisplay,
          })
        : undefined;

    const lines: string[] = ["🧾 Allowlist"];
    lines.push(`Channel: ${channelId}${accountId ? ` (account ${accountId})` : ""}`);
    if (configState.dmPolicy) {
      lines.push(`DM policy: ${configState.dmPolicy}`);
    }
    if (configState.groupPolicy) {
      lines.push(`Group policy: ${configState.groupPolicy}`);
    }

    const showDm = parsed.scope === "dm" || parsed.scope === "all";
    const showGroup = parsed.scope === "group" || parsed.scope === "all";
    if (showDm) {
      lines.push(`DM allowFrom (config): ${formatEntryList(dmDisplay, resolvedDm)}`);
    }
    if (supportsStore && storeReadFailed) {
      lines.push(
        "Paired allowFrom (store): unavailable (read failed). Retry this command; if it still fails, run openclaw doctor.",
      );
    } else if (supportsStore && storeAllowFrom.length > 0) {
      lines.push(`Paired allowFrom (store): ${formatEntryList(normalizeValues(storeAllowFrom))}`);
    }
    if (showGroup) {
      if (groupAllowFrom.length > 0) {
        lines.push(`Group allowFrom (config): ${formatEntryList(groupDisplay, resolvedGroup)}`);
      }
      if (groupOverrides.length > 0) {
        lines.push("Group overrides:");
        for (const entry of groupOverrides) {
          lines.push(
            `- ${entry.label}: ${formatEntryList(normalizeValues(entry.entries), resolvedGroup)}`,
          );
        }
      }
    }

    return commandReply(lines.join("\n"));
  }

  const missingAdminScope = requireGatewayClientScope(params, {
    label: "/allowlist write",
    allowedScopes: ["operator.admin"],
    missingText: "❌ /allowlist add|remove requires operator.admin for gateway clients.",
  });
  if (missingAdminScope) {
    return missingAdminScope;
  }

  const disabled = requireCommandFlagEnabled(params.cfg, {
    label: "/allowlist edits",
    configKey: "config",
    disabledVerb: "are",
  });
  if (disabled) {
    return disabled;
  }

  if (parsed.scope === "group" && parsed.target === "store") {
    return commandReply(
      "⚠️ Pairing-store allowlist edits apply to DMs only; omit --store for groups.",
    );
  }

  const shouldUpdateConfig = parsed.target !== "store";
  // Pairing stores authorize DMs only. Group edits must stay config-scoped or a
  // group-only sender could gain or lose unrelated direct-message access.
  const shouldTouchStore =
    parsed.scope !== "group" && parsed.target !== "config" && Boolean(plugin?.pairing);

  if (shouldUpdateConfig) {
    if (parsed.scope === "all") {
      return commandReply("⚠️ /allowlist add|remove requires scope dm or group.");
    }
    if (!plugin?.allowlist?.applyConfigEdit) {
      return commandReply(
        `⚠️ ${channelId} does not support ${parsed.scope} allowlist edits via /allowlist.`,
      );
    }
    const applyConfigEdit = plugin.allowlist.applyConfigEdit;
    const editScope = parsed.scope;

    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
      return commandReply("⚠️ Config file is invalid; fix it before using /allowlist.");
    }
    const parsedConfig = structuredClone(snapshot.parsed as Record<string, unknown>);
    const editResult = await plugin.allowlist.applyConfigEdit({
      cfg: params.cfg,
      parsedConfig,
      accountId,
      scope: parsed.scope,
      action: parsed.action,
      entry: parsed.entry,
    });
    if (!editResult) {
      return commandReply(
        `⚠️ ${channelId} does not support ${parsed.scope} allowlist edits via /allowlist.`,
      );
    }
    if (editResult.kind === "invalid-entry") {
      return commandReply("⚠️ Invalid allowlist entry.");
    }
    const deniedText = resolveConfigWriteDeniedText({
      cfg: params.cfg,
      channel: params.command.channel,
      originChannelId,
      originAccountId,
      gatewayClientScopes: params.ctx.GatewayClientScopes,
      target: editResult.writeTarget,
      fallbackChannelId: channelId,
    });
    if (deniedText) {
      return commandReply(deniedText);
    }
    const configChanged = editResult.changed;

    if (configChanged) {
      try {
        await applyAllowlistConfigMutation({
          cfg: params.cfg,
          accountId,
          scope: editScope,
          action: parsed.action,
          entry: parsed.entry,
          applyConfigEdit,
        });
      } catch (error) {
        if (error instanceof AutoReplyConfigMutationError) {
          return commandReply(`⚠️ ${error.message}`);
        }
        throw error;
      }
    }

    if (!configChanged && !shouldTouchStore) {
      const message = parsed.action === "add" ? "✅ Already allowlisted." : "⚠️ Entry not found.";
      return commandReply(message);
    }

    if (shouldTouchStore) {
      await updatePairingStoreAllowlist({
        action: parsed.action,
        channelId,
        accountId,
        entry: parsed.entry,
      });
    }

    const actionLabel = parsed.action === "add" ? "added" : "removed";
    const scopeLabel = parsed.scope === "dm" ? "DM" : "group";
    const locations: string[] = [];
    if (configChanged) {
      locations.push(editResult.pathLabel);
    }
    if (shouldTouchStore) {
      locations.push("pairing store");
    }
    const targetLabel = locations.length > 0 ? locations.join(" + ") : "no-op";
    return commandReply(`✅ ${scopeLabel} allowlist ${actionLabel}: ${targetLabel}.`);
  }

  if (!shouldTouchStore) {
    return commandReply("⚠️ This channel does not support allowlist storage.");
  }

  const storeDeniedText = resolveConfigWriteDeniedText({
    cfg: params.cfg,
    channel: params.command.channel,
    originChannelId,
    originAccountId,
    gatewayClientScopes: params.ctx.GatewayClientScopes,
    target: resolveExplicitConfigWriteTarget({ channelId, accountId }),
    fallbackChannelId: channelId,
  });
  if (storeDeniedText) {
    return commandReply(storeDeniedText);
  }

  await updatePairingStoreAllowlist({
    action: parsed.action,
    channelId,
    accountId,
    entry: parsed.entry,
  });

  const actionLabel = parsed.action === "add" ? "added" : "removed";
  const scopeLabel = parsed.scope === "group" ? "group" : "DM";
  return commandReply(`✅ ${scopeLabel} allowlist ${actionLabel} in pairing store.`);
};

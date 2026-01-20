import { getChannelPlugin, listChannelPlugins } from "../../channels/plugins/index.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import type { ChannelCapabilities, ChannelPlugin } from "../../channels/plugins/types.js";
import { fetchChannelPermissionsDiscord } from "../../discord/send.js";
import { parseDiscordTarget } from "../../discord/targets.js";
import { danger } from "../../globals.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { fetchSlackScopes, type SlackScopesResult } from "../../slack/scopes.js";
import { theme } from "../../terminal/theme.js";
import { formatChannelAccountLabel, requireValidConfig } from "./shared.js";

export type ChannelsCapabilitiesOptions = {
  channel?: string;
  account?: string;
  target?: string;
  timeout?: string;
  json?: boolean;
};

type DiscordTargetSummary = {
  raw?: string;
  normalized?: string;
  kind?: "channel" | "user";
  channelId?: string;
};

type DiscordPermissionsReport = {
  channelId?: string;
  guildId?: string;
  isDm?: boolean;
  channelType?: number;
  permissions?: string[];
  missingRequired?: string[];
  raw?: string;
  error?: string;
};

type ChannelCapabilitiesReport = {
  channel: string;
  accountId: string;
  accountName?: string;
  configured?: boolean;
  enabled?: boolean;
  support?: ChannelCapabilities;
  actions?: string[];
  probe?: unknown;
  slackScopes?: Array<{
    tokenType: "bot" | "user";
    result: SlackScopesResult;
  }>;
  target?: DiscordTargetSummary;
  channelPermissions?: DiscordPermissionsReport;
};

const REQUIRED_DISCORD_PERMISSIONS = ["ViewChannel", "SendMessages"] as const;

const TEAMS_GRAPH_PERMISSION_HINTS: Record<string, string> = {
  "ChannelMessage.Read.All": "channel history",
  "Chat.Read.All": "chat history",
  "Channel.ReadBasic.All": "channel list",
  "Team.ReadBasic.All": "team list",
  "TeamsActivity.Read.All": "teams activity",
  "Sites.Read.All": "files (SharePoint)",
  "Files.Read.All": "files (OneDrive)",
};

function normalizeTimeout(raw: unknown, fallback = 10_000) {
  const value = typeof raw === "string" ? Number(raw) : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function formatSupport(capabilities?: ChannelCapabilities) {
  if (!capabilities) return "unknown";
  const bits: string[] = [];
  if (capabilities.chatTypes?.length) {
    bits.push(`chatTypes=${capabilities.chatTypes.join(",")}`);
  }
  if (capabilities.polls) bits.push("polls");
  if (capabilities.reactions) bits.push("reactions");
  if (capabilities.edit) bits.push("edit");
  if (capabilities.unsend) bits.push("unsend");
  if (capabilities.reply) bits.push("reply");
  if (capabilities.effects) bits.push("effects");
  if (capabilities.groupManagement) bits.push("groupManagement");
  if (capabilities.threads) bits.push("threads");
  if (capabilities.media) bits.push("media");
  if (capabilities.nativeCommands) bits.push("nativeCommands");
  if (capabilities.blockStreaming) bits.push("blockStreaming");
  return bits.length ? bits.join(" ") : "none";
}

function summarizeDiscordTarget(raw?: string): DiscordTargetSummary | undefined {
  if (!raw) return undefined;
  const target = parseDiscordTarget(raw, { defaultKind: "channel" });
  if (!target) return { raw };
  if (target.kind === "channel") {
    return {
      raw,
      normalized: target.normalized,
      kind: "channel",
      channelId: target.id,
    };
  }
  if (target.kind === "user") {
    return {
      raw,
      normalized: target.normalized,
      kind: "user",
    };
  }
  return { raw, normalized: target.normalized };
}

function formatDiscordIntents(intents?: {
  messageContent?: string;
  guildMembers?: string;
  presence?: string;
}) {
  if (!intents) return "unknown";
  return [
    `messageContent=${intents.messageContent ?? "unknown"}`,
    `guildMembers=${intents.guildMembers ?? "unknown"}`,
    `presence=${intents.presence ?? "unknown"}`,
  ].join(" ");
}

function formatProbeLines(channelId: string, probe: unknown): string[] {
  const lines: string[] = [];
  if (!probe || typeof probe !== "object") return lines;
  const probeObj = probe as Record<string, unknown>;

  if (channelId === "discord") {
    const bot = probeObj.bot as { id?: string | null; username?: string | null } | undefined;
    if (bot?.username) {
      const botId = bot.id ? ` (${bot.id})` : "";
      lines.push(`Bot: ${theme.accent(`@${bot.username}`)}${botId}`);
    }
    const app = probeObj.application as { intents?: Record<string, unknown> } | undefined;
    if (app?.intents) {
      lines.push(`Intents: ${formatDiscordIntents(app.intents)}`);
    }
  }

  if (channelId === "telegram") {
    const bot = probeObj.bot as { username?: string | null; id?: number | null } | undefined;
    if (bot?.username) {
      const botId = bot.id ? ` (${bot.id})` : "";
      lines.push(`Bot: ${theme.accent(`@${bot.username}`)}${botId}`);
    }
    const flags: string[] = [];
    const canJoinGroups = (bot as { canJoinGroups?: boolean | null })?.canJoinGroups;
    const canReadAll = (bot as { canReadAllGroupMessages?: boolean | null })
      ?.canReadAllGroupMessages;
    const inlineQueries = (bot as { supportsInlineQueries?: boolean | null })
      ?.supportsInlineQueries;
    if (typeof canJoinGroups === "boolean") flags.push(`joinGroups=${canJoinGroups}`);
    if (typeof canReadAll === "boolean") flags.push(`readAllGroupMessages=${canReadAll}`);
    if (typeof inlineQueries === "boolean") flags.push(`inlineQueries=${inlineQueries}`);
    if (flags.length > 0) lines.push(`Flags: ${flags.join(" ")}`);
    const webhook = probeObj.webhook as { url?: string | null } | undefined;
    if (webhook?.url !== undefined) {
      lines.push(`Webhook: ${webhook.url || "none"}`);
    }
  }

  if (channelId === "slack") {
    const bot = probeObj.bot as { name?: string } | undefined;
    const team = probeObj.team as { name?: string; id?: string } | undefined;
    if (bot?.name) {
      lines.push(`Bot: ${theme.accent(`@${bot.name}`)}`);
    }
    if (team?.name || team?.id) {
      const id = team?.id ? ` (${team.id})` : "";
      lines.push(`Team: ${team?.name ?? "unknown"}${id}`);
    }
  }

  if (channelId === "signal") {
    const version = probeObj.version as string | null | undefined;
    if (version) {
      lines.push(`Signal daemon: ${version}`);
    }
  }

  if (channelId === "msteams") {
    const appId = typeof probeObj.appId === "string" ? probeObj.appId.trim() : "";
    if (appId) lines.push(`App: ${theme.accent(appId)}`);
    const graph = probeObj.graph as
      | { ok?: boolean; roles?: unknown; scopes?: unknown; error?: string }
      | undefined;
    if (graph) {
      const roles = Array.isArray(graph.roles)
        ? graph.roles.map((role) => String(role).trim()).filter(Boolean)
        : [];
      const scopes =
        typeof graph.scopes === "string"
          ? graph.scopes
              .split(/\s+/)
              .map((scope) => scope.trim())
              .filter(Boolean)
          : Array.isArray(graph.scopes)
            ? graph.scopes.map((scope) => String(scope).trim()).filter(Boolean)
            : [];
      if (graph.ok === false) {
        lines.push(`Graph: ${theme.error(graph.error ?? "failed")}`);
      } else if (roles.length > 0 || scopes.length > 0) {
        const formatPermission = (permission: string) => {
          const hint = TEAMS_GRAPH_PERMISSION_HINTS[permission];
          return hint ? `${permission} (${hint})` : permission;
        };
        if (roles.length > 0) {
          lines.push(`Graph roles: ${roles.map(formatPermission).join(", ")}`);
        }
        if (scopes.length > 0) {
          lines.push(`Graph scopes: ${scopes.map(formatPermission).join(", ")}`);
        }
      } else if (graph.ok === true) {
        lines.push("Graph: ok");
      }
    }
  }

  const ok = typeof probeObj.ok === "boolean" ? probeObj.ok : undefined;
  if (ok === true && lines.length === 0) {
    lines.push("Probe: ok");
  }
  if (ok === false) {
    const error =
      typeof probeObj.error === "string" && probeObj.error ? ` (${probeObj.error})` : "";
    lines.push(`Probe: ${theme.error(`failed${error}`)}`);
  }
  return lines;
}

async function buildDiscordPermissions(params: {
  account: { token?: string; accountId?: string };
  target?: string;
}): Promise<{ target?: DiscordTargetSummary; report?: DiscordPermissionsReport }> {
  const target = summarizeDiscordTarget(params.target?.trim());
  if (!target) return {};
  if (target.kind !== "channel" || !target.channelId) {
    return {
      target,
      report: {
        error: "Target looks like a DM user; pass channel:<id> to audit channel permissions.",
      },
    };
  }
  const token = params.account.token?.trim();
  if (!token) {
    return {
      target,
      report: {
        channelId: target.channelId,
        error: "Discord bot token missing for permission audit.",
      },
    };
  }
  try {
    const perms = await fetchChannelPermissionsDiscord(target.channelId, {
      token,
      accountId: params.account.accountId ?? undefined,
    });
    const missing = REQUIRED_DISCORD_PERMISSIONS.filter(
      (permission) => !perms.permissions.includes(permission),
    );
    return {
      target,
      report: {
        channelId: perms.channelId,
        guildId: perms.guildId,
        isDm: perms.isDm,
        channelType: perms.channelType,
        permissions: perms.permissions,
        missingRequired: missing.length ? missing : [],
        raw: perms.raw,
      },
    };
  } catch (err) {
    return {
      target,
      report: {
        channelId: target.channelId,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

async function resolveChannelReports(params: {
  plugin: ChannelPlugin;
  cfg: ClawdbotConfig;
  timeoutMs: number;
  accountOverride?: string;
  target?: string;
}): Promise<ChannelCapabilitiesReport[]> {
  const { plugin, cfg, timeoutMs } = params;
  const accountIds = params.accountOverride
    ? [params.accountOverride]
    : (() => {
        const ids = plugin.config.listAccountIds(cfg);
        return ids.length > 0
          ? ids
          : [resolveChannelDefaultAccountId({ plugin, cfg, accountIds: ids })];
      })();
  const reports: ChannelCapabilitiesReport[] = [];
  const listedActions = plugin.actions?.listActions?.({ cfg }) ?? [];
  const actions = Array.from(
    new Set<string>(["send", "broadcast", ...listedActions.map((action) => String(action))]),
  );

  for (const accountId of accountIds) {
    const resolvedAccount = plugin.config.resolveAccount(cfg, accountId);
    const configured = plugin.config.isConfigured
      ? await plugin.config.isConfigured(resolvedAccount, cfg)
      : Boolean(resolvedAccount);
    const enabled = plugin.config.isEnabled
      ? plugin.config.isEnabled(resolvedAccount, cfg)
      : (resolvedAccount as { enabled?: boolean }).enabled !== false;
    let probe: unknown;
    if (configured && enabled && plugin.status?.probeAccount) {
      try {
        probe = await plugin.status.probeAccount({
          account: resolvedAccount,
          timeoutMs,
          cfg,
        });
      } catch (err) {
        probe = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    let slackScopes: ChannelCapabilitiesReport["slackScopes"];
    if (plugin.id === "slack" && configured && enabled) {
      const botToken = (resolvedAccount as { botToken?: string }).botToken?.trim();
      const userToken = (
        resolvedAccount as { config?: { userToken?: string } }
      ).config?.userToken?.trim();
      const scopeReports: NonNullable<ChannelCapabilitiesReport["slackScopes"]> = [];
      if (botToken) {
        scopeReports.push({
          tokenType: "bot",
          result: await fetchSlackScopes(botToken, timeoutMs),
        });
      } else {
        scopeReports.push({
          tokenType: "bot",
          result: { ok: false, error: "Slack bot token missing." },
        });
      }
      if (userToken) {
        scopeReports.push({
          tokenType: "user",
          result: await fetchSlackScopes(userToken, timeoutMs),
        });
      }
      slackScopes = scopeReports;
    }

    let discordTarget: DiscordTargetSummary | undefined;
    let discordPermissions: DiscordPermissionsReport | undefined;
    if (plugin.id === "discord" && params.target) {
      const perms = await buildDiscordPermissions({
        account: resolvedAccount as { token?: string; accountId?: string },
        target: params.target,
      });
      discordTarget = perms.target;
      discordPermissions = perms.report;
    }

    reports.push({
      channel: plugin.id,
      accountId,
      accountName:
        typeof (resolvedAccount as { name?: string }).name === "string"
          ? (resolvedAccount as { name?: string }).name?.trim() || undefined
          : undefined,
      configured,
      enabled,
      support: plugin.capabilities,
      probe,
      target: discordTarget,
      channelPermissions: discordPermissions,
      actions,
      slackScopes,
    });
  }
  return reports;
}

export async function channelsCapabilitiesCommand(
  opts: ChannelsCapabilitiesOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) return;
  const timeoutMs = normalizeTimeout(opts.timeout, 10_000);
  const rawChannel = typeof opts.channel === "string" ? opts.channel.trim().toLowerCase() : "";
  const rawTarget = typeof opts.target === "string" ? opts.target.trim() : "";

  if (opts.account && (!rawChannel || rawChannel === "all")) {
    runtime.error(danger("--account requires a specific --channel."));
    runtime.exit(1);
    return;
  }
  if (rawTarget && rawChannel !== "discord") {
    runtime.error(danger("--target requires --channel discord."));
    runtime.exit(1);
    return;
  }

  const plugins = listChannelPlugins();
  const selected =
    !rawChannel || rawChannel === "all"
      ? plugins
      : (() => {
          const plugin = getChannelPlugin(rawChannel);
          if (!plugin) return null;
          return [plugin];
        })();

  if (!selected || selected.length === 0) {
    runtime.error(danger(`Unknown channel "${rawChannel}".`));
    runtime.exit(1);
    return;
  }

  const reports: ChannelCapabilitiesReport[] = [];
  for (const plugin of selected) {
    const accountOverride = opts.account?.trim() || undefined;
    reports.push(
      ...(await resolveChannelReports({
        plugin,
        cfg,
        timeoutMs,
        accountOverride,
        target: rawTarget && plugin.id === "discord" ? rawTarget : undefined,
      })),
    );
  }

  if (opts.json) {
    runtime.log(JSON.stringify({ channels: reports }, null, 2));
    return;
  }

  const lines: string[] = [];
  for (const report of reports) {
    const label = formatChannelAccountLabel({
      channel: report.channel,
      accountId: report.accountId,
      name: report.accountName,
      channelStyle: theme.accent,
      accountStyle: theme.heading,
    });
    lines.push(theme.heading(label));
    lines.push(`Support: ${formatSupport(report.support)}`);
    if (report.actions && report.actions.length > 0) {
      lines.push(`Actions: ${report.actions.join(", ")}`);
    }
    if (report.configured === false || report.enabled === false) {
      const configuredLabel = report.configured === false ? "not configured" : "configured";
      const enabledLabel = report.enabled === false ? "disabled" : "enabled";
      lines.push(`Status: ${configuredLabel}, ${enabledLabel}`);
    }
    const probeLines = formatProbeLines(report.channel, report.probe);
    if (probeLines.length > 0) {
      lines.push(...probeLines);
    } else if (report.configured && report.enabled) {
      lines.push(theme.muted("Probe: unavailable"));
    }
    if (report.channel === "slack" && report.slackScopes) {
      for (const entry of report.slackScopes) {
        const source = entry.result.source ? ` (${entry.result.source})` : "";
        const label = entry.tokenType === "user" ? "User scopes" : "Bot scopes";
        if (entry.result.ok && entry.result.scopes?.length) {
          lines.push(`${label}${source}: ${entry.result.scopes.join(", ")}`);
        } else if (entry.result.error) {
          lines.push(`${label}: ${theme.error(entry.result.error)}`);
        }
      }
    }
    if (report.channel === "discord" && report.channelPermissions) {
      const perms = report.channelPermissions;
      if (perms.error) {
        lines.push(`Permissions: ${theme.error(perms.error)}`);
      } else {
        const list = perms.permissions?.length ? perms.permissions.join(", ") : "none";
        const label = perms.channelId ? ` (${perms.channelId})` : "";
        lines.push(`Permissions${label}: ${list}`);
        if (perms.missingRequired && perms.missingRequired.length > 0) {
          lines.push(`${theme.warn("Missing required:")} ${perms.missingRequired.join(", ")}`);
        } else {
          lines.push(theme.success("Missing required: none"));
        }
      }
    } else if (report.channel === "discord" && rawTarget && !report.channelPermissions) {
      lines.push(theme.muted("Permissions: skipped (no target)."));
    }
    lines.push("");
  }

  runtime.log(lines.join("\n").trimEnd());
}

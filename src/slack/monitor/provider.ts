import { App } from "@slack/bolt";

import { resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "../../auto-reply/reply/history.js";
import { mergeAllowlist, summarizeMapping } from "../../channels/allowlists/resolve-utils.js";
import { loadConfig } from "../../config/config.js";
import type { SessionScope } from "../../config/sessions.js";
import type { DmPolicy, GroupPolicy } from "../../config/types.js";
import { warn } from "../../globals.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import type { RuntimeEnv } from "../../runtime.js";

import { resolveSlackAccount } from "../accounts.js";
import { resolveSlackChannelAllowlist } from "../resolve-channels.js";
import { resolveSlackUserAllowlist } from "../resolve-users.js";
import { resolveSlackAppToken, resolveSlackBotToken } from "../token.js";
import { resolveSlackSlashCommandConfig } from "./commands.js";
import { createSlackMonitorContext } from "./context.js";
import { registerSlackMonitorEvents } from "./events.js";
import { createSlackMessageHandler } from "./message-handler.js";
import { registerSlackMonitorSlashCommands } from "./slash.js";
import { normalizeAllowList } from "./allow-list.js";

import type { MonitorSlackOpts } from "./types.js";

function parseApiAppIdFromAppToken(raw?: string) {
  const token = raw?.trim();
  if (!token) return undefined;
  const match = /^xapp-\d-([a-z0-9]+)-/i.exec(token);
  return match?.[1]?.toUpperCase();
}

export async function monitorSlackProvider(opts: MonitorSlackOpts = {}) {
  const cfg = opts.config ?? loadConfig();

  let account = resolveSlackAccount({
    cfg,
    accountId: opts.accountId,
  });

  const historyLimit = Math.max(
    0,
    account.config.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );

  const sessionCfg = cfg.session;
  const sessionScope: SessionScope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);

  const botToken = resolveSlackBotToken(opts.botToken ?? account.botToken);
  const appToken = resolveSlackAppToken(opts.appToken ?? account.appToken);
  if (!botToken || !appToken) {
    throw new Error(
      `Slack bot + app tokens missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken/appToken or SLACK_BOT_TOKEN/SLACK_APP_TOKEN for default).`,
    );
  }

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const slackCfg = account.config;
  const dmConfig = slackCfg.dm;

  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicy = (dmConfig?.policy ?? "pairing") as DmPolicy;
  let allowFrom = dmConfig?.allowFrom;
  const groupDmEnabled = dmConfig?.groupEnabled ?? false;
  const groupDmChannels = dmConfig?.groupChannels;
  let channelsConfig = slackCfg.channels;
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = (slackCfg.groupPolicy ?? defaultGroupPolicy ?? "open") as GroupPolicy;
  if (
    slackCfg.groupPolicy === undefined &&
    slackCfg.channels === undefined &&
    defaultGroupPolicy === undefined &&
    groupPolicy === "open"
  ) {
    runtime.log?.(
      warn(
        'slack: groupPolicy defaults to "open" when channels.slack is missing; set channels.slack.groupPolicy (or channels.defaults.groupPolicy) or add channels.slack.channels to restrict access.',
      ),
    );
  }

  const resolveToken = slackCfg.userToken?.trim() || botToken;
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const reactionMode = slackCfg.reactionNotifications ?? "own";
  const reactionAllowlist = slackCfg.reactionAllowlist ?? [];
  const replyToMode = slackCfg.replyToMode ?? "off";
  const threadHistoryScope = slackCfg.thread?.historyScope ?? "thread";
  const threadInheritParent = slackCfg.thread?.inheritParent ?? false;
  const slashCommand = resolveSlackSlashCommandConfig(opts.slashCommand ?? slackCfg.slashCommand);
  const textLimit = resolveTextChunkLimit(cfg, "slack", account.accountId);
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const mediaMaxBytes = (opts.mediaMaxMb ?? slackCfg.mediaMaxMb ?? 20) * 1024 * 1024;
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;

  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  let botUserId = "";
  let teamId = "";
  let apiAppId = "";
  const expectedApiAppIdFromAppToken = parseApiAppIdFromAppToken(appToken);
  try {
    const auth = await app.client.auth.test({ token: botToken });
    botUserId = auth.user_id ?? "";
    teamId = auth.team_id ?? "";
    apiAppId = (auth as { api_app_id?: string }).api_app_id ?? "";
  } catch {
    // auth test failing is non-fatal; message handler falls back to regex mentions.
  }

  if (apiAppId && expectedApiAppIdFromAppToken && apiAppId !== expectedApiAppIdFromAppToken) {
    runtime.error?.(
      `slack token mismatch: bot token api_app_id=${apiAppId} but app token looks like api_app_id=${expectedApiAppIdFromAppToken}`,
    );
  }

  const ctx = createSlackMonitorContext({
    cfg,
    accountId: account.accountId,
    botToken,
    app,
    runtime,
    botUserId,
    teamId,
    apiAppId,
    historyLimit,
    sessionScope,
    mainKey,
    dmEnabled,
    dmPolicy,
    allowFrom,
    groupDmEnabled,
    groupDmChannels,
    defaultRequireMention: slackCfg.requireMention,
    channelsConfig,
    groupPolicy,
    useAccessGroups,
    reactionMode,
    reactionAllowlist,
    replyToMode,
    threadHistoryScope,
    threadInheritParent,
    slashCommand,
    textLimit,
    ackReactionScope,
    mediaMaxBytes,
    removeAckAfterReply,
  });

  const handleSlackMessage = createSlackMessageHandler({ ctx, account });

  registerSlackMonitorEvents({ ctx, account, handleSlackMessage });
  registerSlackMonitorSlashCommands({ ctx, account });

  if (resolveToken) {
    void (async () => {
      if (opts.abortSignal?.aborted) return;

      if (channelsConfig && Object.keys(channelsConfig).length > 0) {
        try {
          const entries = Object.keys(channelsConfig).filter((key) => key !== "*");
          if (entries.length > 0) {
            const resolved = await resolveSlackChannelAllowlist({
              token: resolveToken,
              entries,
            });
            const nextChannels = { ...channelsConfig };
            const mapping: string[] = [];
            const unresolved: string[] = [];
            for (const entry of resolved) {
              const source = channelsConfig?.[entry.input];
              if (!source) continue;
              if (!entry.resolved || !entry.id) {
                unresolved.push(entry.input);
                continue;
              }
              mapping.push(`${entry.input}→${entry.id}${entry.archived ? " (archived)" : ""}`);
              const existing = nextChannels[entry.id] ?? {};
              nextChannels[entry.id] = { ...source, ...existing };
            }
            channelsConfig = nextChannels;
            ctx.channelsConfig = nextChannels;
            summarizeMapping("slack channels", mapping, unresolved, runtime);
          }
        } catch (err) {
          runtime.log?.(`slack channel resolve failed; using config entries. ${String(err)}`);
        }
      }

      const allowEntries =
        allowFrom?.filter((entry) => String(entry).trim() && String(entry).trim() !== "*") ?? [];
      if (allowEntries.length > 0) {
        try {
          const resolvedUsers = await resolveSlackUserAllowlist({
            token: resolveToken,
            entries: allowEntries.map((entry) => String(entry)),
          });
          const mapping: string[] = [];
          const unresolved: string[] = [];
          const additions: string[] = [];
          for (const entry of resolvedUsers) {
            if (entry.resolved && entry.id) {
              const note = entry.note ? ` (${entry.note})` : "";
              mapping.push(`${entry.input}→${entry.id}${note}`);
              additions.push(entry.id);
            } else {
              unresolved.push(entry.input);
            }
          }
          allowFrom = mergeAllowlist({ existing: allowFrom, additions });
          ctx.allowFrom = normalizeAllowList(allowFrom);
          summarizeMapping("slack users", mapping, unresolved, runtime);
        } catch (err) {
          runtime.log?.(`slack user resolve failed; using config entries. ${String(err)}`);
        }
      }

      if (channelsConfig && Object.keys(channelsConfig).length > 0) {
        const userEntries = new Set<string>();
        for (const channel of Object.values(channelsConfig)) {
          if (!channel || typeof channel !== "object") continue;
          const channelUsers = (channel as { users?: Array<string | number> }).users;
          if (!Array.isArray(channelUsers)) continue;
          for (const entry of channelUsers) {
            const trimmed = String(entry).trim();
            if (trimmed && trimmed !== "*") userEntries.add(trimmed);
          }
        }

        if (userEntries.size > 0) {
          try {
            const resolvedUsers = await resolveSlackUserAllowlist({
              token: resolveToken,
              entries: Array.from(userEntries),
            });
            const resolvedMap = new Map(resolvedUsers.map((entry) => [entry.input, entry]));
            const mapping = resolvedUsers
              .filter((entry) => entry.resolved && entry.id)
              .map((entry) => `${entry.input}→${entry.id}`);
            const unresolved = resolvedUsers
              .filter((entry) => !entry.resolved)
              .map((entry) => entry.input);

            const nextChannels = { ...channelsConfig };
            for (const [channelKey, channelConfig] of Object.entries(channelsConfig)) {
              if (!channelConfig || typeof channelConfig !== "object") continue;
              const channelUsers = (channelConfig as { users?: Array<string | number> }).users;
              if (!Array.isArray(channelUsers) || channelUsers.length === 0) continue;
              const additions: string[] = [];
              for (const entry of channelUsers) {
                const trimmed = String(entry).trim();
                const resolved = resolvedMap.get(trimmed);
                if (resolved?.resolved && resolved.id) additions.push(resolved.id);
              }
              nextChannels[channelKey] = {
                ...channelConfig,
                users: mergeAllowlist({ existing: channelUsers, additions }),
              };
            }
            channelsConfig = nextChannels;
            ctx.channelsConfig = nextChannels;
            summarizeMapping("slack channel users", mapping, unresolved, runtime);
          } catch (err) {
            runtime.log?.(
              `slack channel user resolve failed; using config entries. ${String(err)}`,
            );
          }
        }
      }
    })();
  }

  const stopOnAbort = () => {
    if (opts.abortSignal?.aborted) void app.stop();
  };
  opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });

  try {
    await app.start();
    runtime.log?.("slack socket mode connected");
    if (opts.abortSignal?.aborted) return;
    await new Promise<void>((resolve) => {
      opts.abortSignal?.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  } finally {
    opts.abortSignal?.removeEventListener("abort", stopOnAbort);
    await app.stop().catch(() => undefined);
  }
}

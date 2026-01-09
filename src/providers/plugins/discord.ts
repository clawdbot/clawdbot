import {
  listDiscordAccountIds,
  type ResolvedDiscordAccount,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
} from "../../discord/accounts.js";
import {
  auditDiscordChannelPermissions,
  collectDiscordAuditChannelIds,
} from "../../discord/audit.js";
import { monitorDiscordProvider } from "../../discord/index.js";
import { probeDiscord } from "../../discord/probe.js";
import { sendMessageDiscord, sendPollDiscord } from "../../discord/send.js";
import { shouldLogVerbose } from "../../globals.js";
import { getChatProviderMeta } from "../registry.js";
import type { ProviderPlugin } from "./types.js";

const meta = getChatProviderMeta("discord");

export const discordPlugin: ProviderPlugin<ResolvedDiscordAccount> = {
  id: "discord",
  meta: {
    ...meta,
    aliases: [],
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    polls: true,
    reactions: true,
    threads: true,
    media: true,
  },
  reload: { configPrefixes: ["discord"] },
  config: {
    listAccountIds: (cfg) => listDiscordAccountIds(cfg),
    resolveAccount: (cfg, accountId) =>
      resolveDiscordAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultDiscordAccountId(cfg),
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),
  },
  outbound: {
    deliveryMode: "direct",
    chunker: null,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error(
            "Delivering to Discord requires --to <channelId|user:ID|channel:ID>",
          ),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text, accountId, deps }) => {
      const send = deps?.sendDiscord ?? sendMessageDiscord;
      const result = await send(to, text, {
        verbose: false,
        accountId: accountId ?? undefined,
      });
      return { provider: "discord", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, deps }) => {
      const send = deps?.sendDiscord ?? sendMessageDiscord;
      const result = await send(to, text, {
        verbose: false,
        mediaUrl,
        accountId: accountId ?? undefined,
      });
      return { provider: "discord", ...result };
    },
    sendPoll: async ({ to, poll, accountId }) =>
      await sendPollDiscord(to, poll, {
        accountId: accountId ?? undefined,
      }),
  },
  status: {
    probeAccount: async ({ account, timeoutMs }) =>
      probeDiscord(account.token, timeoutMs, { includeApplication: true }),
    auditAccount: async ({ account, timeoutMs, cfg }) => {
      const { channelIds, unresolvedChannels } = collectDiscordAuditChannelIds({
        cfg,
        accountId: account.accountId,
      });
      if (!channelIds.length && unresolvedChannels === 0) return undefined;
      const botToken = account.token?.trim();
      if (!botToken) {
        return {
          ok: unresolvedChannels === 0,
          checkedChannels: 0,
          unresolvedChannels,
          channels: [],
          elapsedMs: 0,
        };
      }
      const audit = await auditDiscordChannelPermissions({
        token: botToken,
        accountId: account.accountId,
        channelIds,
        timeoutMs,
      });
      return { ...audit, unresolvedChannels };
    },
    buildAccountSnapshot: ({ account, runtime, probe, audit }) => {
      const configured = Boolean(account.token?.trim());
      const app =
        runtime?.application ??
        (probe as { application?: unknown })?.application;
      const bot = runtime?.bot ?? (probe as { bot?: unknown })?.bot;
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        tokenSource: account.tokenSource,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        application: app ?? undefined,
        bot: bot ?? undefined,
        probe,
        audit,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.token.trim();
      let discordBotLabel = "";
      try {
        const probe = await probeDiscord(token, 2500, {
          includeApplication: true,
        });
        const username = probe.ok ? probe.bot?.username?.trim() : null;
        if (username) discordBotLabel = ` (@${username})`;
        ctx.setStatus({
          accountId: account.accountId,
          bot: probe.bot,
          application: probe.application,
        });
        const messageContent = probe.application?.intents?.messageContent;
        if (messageContent === "disabled") {
          ctx.log?.warn(
            `[${account.accountId}] Discord Message Content Intent is disabled; bot may not respond to channel messages. Enable it in Discord Dev Portal (Bot → Privileged Gateway Intents) or require mentions.`,
          );
        } else if (messageContent === "limited") {
          ctx.log?.info(
            `[${account.accountId}] Discord Message Content Intent is limited; bots under 100 servers can use it without verification.`,
          );
        }
      } catch (err) {
        if (shouldLogVerbose()) {
          ctx.log?.debug?.(
            `[${account.accountId}] bot probe failed: ${String(err)}`,
          );
        }
      }
      ctx.log?.info(
        `[${account.accountId}] starting provider${discordBotLabel}`,
      );
      return monitorDiscordProvider({
        token,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        mediaMaxMb: account.config.mediaMaxMb,
        historyLimit: account.config.historyLimit,
      });
    },
  },
};

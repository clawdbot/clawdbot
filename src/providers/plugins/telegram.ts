import { chunkMarkdownText } from "../../auto-reply/chunk.js";
import { shouldLogVerbose } from "../../globals.js";
import {
  listTelegramAccountIds,
  type ResolvedTelegramAccount,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
} from "../../telegram/accounts.js";
import {
  auditTelegramGroupMembership,
  collectTelegramUnmentionedGroupIds,
} from "../../telegram/audit.js";
import { monitorTelegramProvider } from "../../telegram/monitor.js";
import { probeTelegram } from "../../telegram/probe.js";
import { sendMessageTelegram } from "../../telegram/send.js";
import { getChatProviderMeta } from "../registry.js";
import type { ProviderPlugin } from "./types.js";

const meta = getChatProviderMeta("telegram");

export const telegramPlugin: ProviderPlugin<ResolvedTelegramAccount> = {
  id: "telegram",
  meta: {
    ...meta,
    aliases: [],
  },
  capabilities: {
    chatTypes: ["direct", "group", "channel", "thread"],
    reactions: true,
    threads: true,
    media: true,
  },
  reload: { configPrefixes: ["telegram"] },
  config: {
    listAccountIds: (cfg) => listTelegramAccountIds(cfg),
    resolveAccount: (cfg, accountId) =>
      resolveTelegramAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultTelegramAccountId(cfg),
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
    chunker: chunkMarkdownText,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("Delivering to Telegram requires --to <chatId>"),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text, accountId, deps }) => {
      const send = deps?.sendTelegram ?? sendMessageTelegram;
      const result = await send(to, text, {
        verbose: false,
        accountId: accountId ?? undefined,
      });
      return { provider: "telegram", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, deps }) => {
      const send = deps?.sendTelegram ?? sendMessageTelegram;
      const result = await send(to, text, {
        verbose: false,
        mediaUrl,
        accountId: accountId ?? undefined,
      });
      return { provider: "telegram", ...result };
    },
  },
  status: {
    probeAccount: async ({ account, timeoutMs }) =>
      probeTelegram(account.token, timeoutMs, account.config.proxy),
    auditAccount: async ({ account, timeoutMs, probe, cfg }) => {
      const groups =
        cfg.telegram?.accounts?.[account.accountId]?.groups ??
        cfg.telegram?.groups;
      const { groupIds, unresolvedGroups, hasWildcardUnmentionedGroups } =
        collectTelegramUnmentionedGroupIds(groups);
      if (
        !groupIds.length &&
        unresolvedGroups === 0 &&
        !hasWildcardUnmentionedGroups
      ) {
        return undefined;
      }
      const botId =
        (probe as { ok?: boolean; bot?: { id?: number } })?.ok &&
        (probe as { bot?: { id?: number } }).bot?.id != null
          ? (probe as { bot: { id: number } }).bot.id
          : null;
      if (!botId) {
        return {
          ok: unresolvedGroups === 0 && !hasWildcardUnmentionedGroups,
          checkedGroups: 0,
          unresolvedGroups,
          hasWildcardUnmentionedGroups,
          groups: [],
          elapsedMs: 0,
        };
      }
      const audit = await auditTelegramGroupMembership({
        token: account.token,
        botId,
        groupIds,
        proxyUrl: account.config.proxy,
        timeoutMs,
      });
      return { ...audit, unresolvedGroups, hasWildcardUnmentionedGroups };
    },
    buildAccountSnapshot: ({ account, cfg, runtime, probe, audit }) => {
      const configured = Boolean(account.token?.trim());
      const groups =
        cfg.telegram?.accounts?.[account.accountId]?.groups ??
        cfg.telegram?.groups;
      const allowUnmentionedGroups =
        Boolean(
          groups?.["*"] &&
            (groups["*"] as { requireMention?: boolean }).requireMention ===
              false,
        ) ||
        Object.entries(groups ?? {}).some(
          ([key, value]) =>
            key !== "*" &&
            Boolean(value) &&
            typeof value === "object" &&
            (value as { requireMention?: boolean }).requireMention === false,
        );
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
        mode:
          runtime?.mode ?? (account.config.webhookUrl ? "webhook" : "polling"),
        probe,
        audit,
        allowUnmentionedGroups,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.token.trim();
      let telegramBotLabel = "";
      try {
        const probe = await probeTelegram(token, 2500, account.config.proxy);
        const username = probe.ok ? probe.bot?.username?.trim() : null;
        if (username) telegramBotLabel = ` (@${username})`;
      } catch (err) {
        if (shouldLogVerbose()) {
          ctx.log?.debug?.(
            `[${account.accountId}] bot probe failed: ${String(err)}`,
          );
        }
      }
      ctx.log?.info(
        `[${account.accountId}] starting provider${telegramBotLabel}`,
      );
      return monitorTelegramProvider({
        token,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        useWebhook: Boolean(account.config.webhookUrl),
        webhookUrl: account.config.webhookUrl,
        webhookSecret: account.config.webhookSecret,
        webhookPath: account.config.webhookPath,
      });
    },
  },
};

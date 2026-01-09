import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import {
  listSlackAccountIds,
  type ResolvedSlackAccount,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
} from "../../slack/accounts.js";
import { monitorSlackProvider } from "../../slack/index.js";
import { probeSlack } from "../../slack/probe.js";
import { sendMessageSlack } from "../../slack/send.js";
import { getChatProviderMeta } from "../registry.js";
import type { ProviderPlugin } from "./types.js";

const meta = getChatProviderMeta("slack");

export const slackPlugin: ProviderPlugin<ResolvedSlackAccount> = {
  id: "slack",
  meta: {
    ...meta,
    aliases: [],
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    reactions: true,
    threads: true,
    media: true,
  },
  reload: { configPrefixes: ["slack"] },
  config: {
    listAccountIds: (cfg) => listSlackAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveSlackAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultSlackAccountId(cfg),
    isConfigured: (account) => Boolean(account.botToken && account.appToken),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.botToken && account.appToken),
      botTokenSource: account.botTokenSource,
      appTokenSource: account.appTokenSource,
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
            "Delivering to Slack requires --to <channelId|user:ID|channel:ID>",
          ),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text, accountId, deps, replyToId }) => {
      const send = deps?.sendSlack ?? sendMessageSlack;
      const result = await send(to, text, {
        threadTs: replyToId ?? undefined,
        accountId: accountId ?? undefined,
      });
      return { provider: "slack", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId }) => {
      const send = deps?.sendSlack ?? sendMessageSlack;
      const result = await send(to, text, {
        mediaUrl,
        threadTs: replyToId ?? undefined,
        accountId: accountId ?? undefined,
      });
      return { provider: "slack", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildProviderSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      botTokenSource: snapshot.botTokenSource ?? "none",
      appTokenSource: snapshot.appTokenSource ?? "none",
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      const token = account.botToken?.trim();
      if (!token) return { ok: false, error: "missing token" };
      return await probeSlack(token, timeoutMs);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const configured = Boolean(account.botToken && account.appToken);
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        botTokenSource: account.botTokenSource,
        appTokenSource: account.appTokenSource,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const botToken = account.botToken?.trim();
      const appToken = account.appToken?.trim();
      ctx.log?.info(`[${account.accountId}] starting provider`);
      return monitorSlackProvider({
        botToken: botToken ?? "",
        appToken: appToken ?? "",
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        mediaMaxMb: account.config.mediaMaxMb,
        slashCommand: account.config.slashCommand,
      });
    },
  },
};

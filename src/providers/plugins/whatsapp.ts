import { chunkText } from "../../auto-reply/chunk.js";
import { shouldLogVerbose } from "../../globals.js";
import { normalizeE164 } from "../../utils.js";
import {
  listWhatsAppAccountIds,
  type ResolvedWhatsAppAccount,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
} from "../../web/accounts.js";
import { sendMessageWhatsApp, sendPollWhatsApp } from "../../web/outbound.js";
import { readWebSelfId, webAuthExists } from "../../web/session.js";
import { getChatProviderMeta } from "../registry.js";
import { monitorWebProvider } from "../web/index.js";
import type { ProviderPlugin } from "./types.js";

const meta = getChatProviderMeta("whatsapp");

export const whatsappPlugin: ProviderPlugin<ResolvedWhatsAppAccount> = {
  id: "whatsapp",
  meta: {
    ...meta,
    aliases: [],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    polls: true,
    reactions: true,
    media: true,
  },
  reload: { configPrefixes: ["web"] },
  config: {
    listAccountIds: (cfg) => listWhatsAppAccountIds(cfg),
    resolveAccount: (cfg, accountId) =>
      resolveWhatsAppAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultWhatsAppAccountId(cfg),
    isConfigured: async (account) => await webAuthExists(account.authDir),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.authDir),
      dmPolicy: account.dmPolicy,
      allowFrom: account.allowFrom,
    }),
  },
  outbound: {
    deliveryMode: "gateway",
    chunker: chunkText,
    resolveTarget: ({ to, allowFrom }) => {
      const trimmed = to?.trim();
      if (trimmed) {
        return { ok: true, to: normalizeE164(trimmed) };
      }
      const fallback = allowFrom?.[0]?.trim();
      if (fallback) {
        return { ok: true, to: normalizeE164(fallback) };
      }
      return {
        ok: false,
        error: new Error(
          "Delivering to WhatsApp requires --to <E.164> or whatsapp.allowFrom[0]",
        ),
      };
    },
    sendText: async ({ to, text, accountId, deps, gifPlayback }) => {
      const send = deps?.sendWhatsApp ?? sendMessageWhatsApp;
      const result = await send(to, text, {
        verbose: false,
        accountId: accountId ?? undefined,
        gifPlayback,
      });
      return { provider: "whatsapp", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, deps, gifPlayback }) => {
      const send = deps?.sendWhatsApp ?? sendMessageWhatsApp;
      const result = await send(to, text, {
        verbose: false,
        mediaUrl,
        accountId: accountId ?? undefined,
        gifPlayback,
      });
      return { provider: "whatsapp", ...result };
    },
    sendPoll: async ({ to, poll, accountId }) =>
      await sendPollWhatsApp(to, poll, {
        verbose: shouldLogVerbose(),
        accountId: accountId ?? undefined,
      }),
  },
  status: {
    buildAccountSnapshot: async ({ account, runtime }) => {
      const linked = await webAuthExists(account.authDir);
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: true,
        linked,
        running: runtime?.running ?? false,
        connected: runtime?.connected ?? false,
        reconnectAttempts: runtime?.reconnectAttempts,
        lastConnectedAt: runtime?.lastConnectedAt ?? null,
        lastDisconnect: runtime?.lastDisconnect ?? null,
        lastMessageAt: runtime?.lastMessageAt ?? null,
        lastEventAt: runtime?.lastEventAt ?? null,
        lastError: runtime?.lastError ?? null,
        dmPolicy: account.dmPolicy,
        allowFrom: account.allowFrom,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const { e164, jid } = readWebSelfId(account.authDir);
      const identity = e164 ? e164 : jid ? `jid ${jid}` : "unknown";
      ctx.log?.info(`[${account.accountId}] starting provider (${identity})`);
      return monitorWebProvider(
        shouldLogVerbose(),
        undefined,
        true,
        undefined,
        ctx.runtime,
        ctx.abortSignal,
        {
          statusSink: (next) =>
            ctx.setStatus({ accountId: ctx.accountId, ...next }),
          accountId: account.accountId,
        },
      );
    },
  },
};

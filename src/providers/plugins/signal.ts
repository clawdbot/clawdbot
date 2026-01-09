import { chunkText } from "../../auto-reply/chunk.js";
import {
  listSignalAccountIds,
  type ResolvedSignalAccount,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "../../signal/accounts.js";
import { monitorSignalProvider } from "../../signal/index.js";
import { probeSignal } from "../../signal/probe.js";
import { sendMessageSignal } from "../../signal/send.js";
import { getChatProviderMeta } from "../registry.js";
import type { ProviderPlugin } from "./types.js";

const meta = getChatProviderMeta("signal");

export const signalPlugin: ProviderPlugin<ResolvedSignalAccount> = {
  id: "signal",
  meta: {
    ...meta,
    aliases: [],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
  },
  reload: { configPrefixes: ["signal"] },
  config: {
    listAccountIds: (cfg) => listSignalAccountIds(cfg),
    resolveAccount: (cfg, accountId) =>
      resolveSignalAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultSignalAccountId(cfg),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
    }),
  },
  outbound: {
    deliveryMode: "direct",
    chunker: chunkText,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error(
            "Delivering to Signal requires --to <E.164|group:ID|signal:group:ID|signal:+E.164>",
          ),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text, accountId, deps }) => {
      const send = deps?.sendSignal ?? sendMessageSignal;
      const result = await send(to, text, {
        accountId: accountId ?? undefined,
      });
      return { provider: "signal", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, deps }) => {
      const send = deps?.sendSignal ?? sendMessageSignal;
      const result = await send(to, text, {
        mediaUrl,
        accountId: accountId ?? undefined,
      });
      return { provider: "signal", ...result };
    },
  },
  status: {
    probeAccount: async ({ account, timeoutMs }) => {
      const baseUrl = account.baseUrl;
      return await probeSignal(baseUrl, timeoutMs);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
      });
      ctx.log?.info(
        `[${account.accountId}] starting provider (${account.baseUrl})`,
      );
      return monitorSignalProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        mediaMaxMb: account.config.mediaMaxMb,
      });
    },
  },
};

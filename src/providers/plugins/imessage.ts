import { chunkText } from "../../auto-reply/chunk.js";
import {
  listIMessageAccountIds,
  type ResolvedIMessageAccount,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
} from "../../imessage/accounts.js";
import { monitorIMessageProvider } from "../../imessage/index.js";
import { probeIMessage } from "../../imessage/probe.js";
import { sendMessageIMessage } from "../../imessage/send.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { getChatProviderMeta } from "../registry.js";
import {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "./config-helpers.js";
import { resolveProviderMediaMaxBytes } from "./media-limits.js";
import { PAIRING_APPROVED_MESSAGE } from "./pairing-message.js";
import type { ProviderPlugin } from "./types.js";

const meta = getChatProviderMeta("imessage");

export const imessagePlugin: ProviderPlugin<ResolvedIMessageAccount> = {
  id: "imessage",
  meta: {
    ...meta,
    aliases: ["imsg"],
    showConfigured: false,
  },
  pairing: {
    idLabel: "imessageSenderId",
    notifyApproval: async ({ id }) => {
      await sendMessageIMessage(id, PAIRING_APPROVED_MESSAGE);
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
  },
  reload: { configPrefixes: ["imessage"] },
  config: {
    listAccountIds: (cfg) => listIMessageAccountIds(cfg),
    resolveAccount: (cfg, accountId) =>
      resolveIMessageAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultIMessageAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "imessage",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "imessage",
        accountId,
        clearBaseFields: ["cliPath", "dbPath", "service", "region", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
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
            "Delivering to iMessage requires --to <handle|chat_id:ID>",
          ),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ cfg, to, text, accountId, deps }) => {
      const send = deps?.sendIMessage ?? sendMessageIMessage;
      const maxBytes = resolveProviderMediaMaxBytes({
        cfg,
        provider: "imessage",
        accountId,
      });
      const result = await send(to, text, {
        maxBytes,
        accountId: accountId ?? undefined,
      });
      return { provider: "imessage", ...result };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, deps }) => {
      const send = deps?.sendIMessage ?? sendMessageIMessage;
      const maxBytes = resolveProviderMediaMaxBytes({
        cfg,
        provider: "imessage",
        accountId,
      });
      const result = await send(to, text, {
        mediaUrl,
        maxBytes,
        accountId: accountId ?? undefined,
      });
      return { provider: "imessage", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      cliPath: null,
      dbPath: null,
    },
    buildProviderSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      cliPath: snapshot.cliPath ?? null,
      dbPath: snapshot.dbPath ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ timeoutMs }) => probeIMessage(timeoutMs),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      cliPath: runtime?.cliPath ?? account.config.cliPath ?? null,
      dbPath: runtime?.dbPath ?? account.config.dbPath ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const cliPath = account.config.cliPath?.trim() || "imsg";
      const dbPath = account.config.dbPath?.trim();
      ctx.setStatus({
        accountId: account.accountId,
        cliPath,
        dbPath: dbPath ?? null,
      });
      ctx.log?.info(
        `[${account.accountId}] starting provider (${cliPath}${dbPath ? ` db=${dbPath}` : ""})`,
      );
      return monitorIMessageProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};

import {
  createActionGate,
  readStringParam,
} from "../../agents/tools/common.js";
import { handleWhatsAppAction } from "../../agents/tools/whatsapp-actions.js";
import { chunkText } from "../../auto-reply/chunk.js";
import { shouldLogVerbose } from "../../globals.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "../../routing/session-key.js";
import {
  listWhatsAppAccountIds,
  type ResolvedWhatsAppAccount,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
} from "../../web/accounts.js";
import { getActiveWebListener } from "../../web/active-listener.js";
import { sendMessageWhatsApp, sendPollWhatsApp } from "../../web/outbound.js";
import {
  getWebAuthAgeMs,
  logoutWeb,
  logWebSelfId,
  readWebSelfId,
  webAuthExists,
} from "../../web/session.js";
import {
  isWhatsAppGroupJid,
  normalizeWhatsAppTarget,
} from "../../whatsapp/normalize.js";
import { getChatProviderMeta } from "../registry.js";
import { monitorWebProvider } from "../web/index.js";
import { resolveWhatsAppGroupRequireMention } from "./group-mentions.js";
import { normalizeWhatsAppMessagingTarget } from "./normalize-target.js";
import {
  applyAccountNameToProviderSection,
  migrateBaseNameToDefaultAccount,
} from "./setup-helpers.js";
import { collectWhatsAppStatusIssues } from "./status-issues/whatsapp.js";
import type { ProviderMessageActionName, ProviderPlugin } from "./types.js";

const meta = getChatProviderMeta("whatsapp");

export const whatsappPlugin: ProviderPlugin<ResolvedWhatsAppAccount> = {
  id: "whatsapp",
  meta: {
    ...meta,
    aliases: ["web"],
    showConfigured: false,
    quickstartAllowFrom: true,
    forceAccountBinding: true,
    preferSessionLookupForAnnounceTarget: true,
  },
  pairing: {
    idLabel: "whatsappSenderId",
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    polls: true,
    reactions: true,
    media: true,
  },
  reload: { configPrefixes: ["web"], noopPrefixes: ["whatsapp"] },
  gatewayMethods: ["web.login.start", "web.login.wait"],
  config: {
    listAccountIds: (cfg) => listWhatsAppAccountIds(cfg),
    resolveAccount: (cfg, accountId) =>
      resolveWhatsAppAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultWhatsAppAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const accountKey = accountId || DEFAULT_ACCOUNT_ID;
      const accounts = { ...cfg.whatsapp?.accounts };
      const existing = accounts[accountKey] ?? {};
      return {
        ...cfg,
        whatsapp: {
          ...cfg.whatsapp,
          accounts: {
            ...accounts,
            [accountKey]: {
              ...existing,
              enabled,
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const accountKey = accountId || DEFAULT_ACCOUNT_ID;
      const accounts = { ...cfg.whatsapp?.accounts };
      delete accounts[accountKey];
      return {
        ...cfg,
        whatsapp: {
          ...cfg.whatsapp,
          accounts: Object.keys(accounts).length ? accounts : undefined,
        },
      };
    },
    isEnabled: (account, cfg) =>
      account.enabled !== false && cfg.web?.enabled !== false,
    disabledReason: () => "disabled",
    isConfigured: async (account) => await webAuthExists(account.authDir),
    unconfiguredReason: () => "not linked",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.authDir),
      dmPolicy: account.dmPolicy,
      allowFrom: account.allowFrom,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveWhatsAppAccount({ cfg, accountId }).allowFrom ?? [],
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter((entry): entry is string => Boolean(entry))
        .map((entry) =>
          entry === "*" ? entry : normalizeWhatsAppTarget(entry),
        )
        .filter((entry): entry is string => Boolean(entry)),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToProviderSection({
        cfg,
        providerKey: "whatsapp",
        accountId,
        name,
        alwaysUseAccounts: true,
      }),
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToProviderSection({
        cfg,
        providerKey: "whatsapp",
        accountId,
        name: input.name,
        alwaysUseAccounts: true,
      });
      const next = migrateBaseNameToDefaultAccount({
        cfg: namedConfig,
        providerKey: "whatsapp",
        alwaysUseAccounts: true,
      });
      const entry = {
        ...next.whatsapp?.accounts?.[accountId],
        ...(input.authDir ? { authDir: input.authDir } : {}),
        enabled: true,
      };
      return {
        ...next,
        whatsapp: {
          ...next.whatsapp,
          accounts: {
            ...next.whatsapp?.accounts,
            [accountId]: entry,
          },
        },
      };
    },
  },
  groups: {
    resolveRequireMention: resolveWhatsAppGroupRequireMention,
  },
  commands: {
    enforceOwnerForCommands: true,
    skipWhenConfigEmpty: true,
  },
  messaging: {
    normalizeTarget: normalizeWhatsAppMessagingTarget,
  },
  actions: {
    listActions: ({ cfg }) => {
      if (!cfg.whatsapp) return [];
      const gate = createActionGate(cfg.whatsapp.actions);
      const actions = new Set<ProviderMessageActionName>();
      if (gate("reactions")) actions.add("react");
      if (gate("polls")) actions.add("poll");
      return Array.from(actions);
    },
    supportsAction: ({ action }) => action === "react",
    handleAction: async ({ action, params, cfg, accountId }) => {
      if (action !== "react") {
        throw new Error(
          `Action ${action} is not supported for provider ${meta.id}.`,
        );
      }
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      const emoji = readStringParam(params, "emoji", { allowEmpty: true });
      const remove =
        typeof params.remove === "boolean" ? params.remove : undefined;
      return await handleWhatsAppAction(
        {
          action: "react",
          chatJid:
            readStringParam(params, "chatJid") ??
            readStringParam(params, "to", { required: true }),
          messageId,
          emoji,
          remove,
          participant: readStringParam(params, "participant"),
          accountId: accountId ?? undefined,
          fromMe:
            typeof params.fromMe === "boolean" ? params.fromMe : undefined,
        },
        cfg,
      );
    },
  },
  outbound: {
    deliveryMode: "gateway",
    chunker: chunkText,
    textChunkLimit: 4000,
    pollMaxOptions: 12,
    resolveTarget: ({ to, allowFrom, mode }) => {
      const trimmed = to?.trim() ?? "";
      const allowListRaw = (allowFrom ?? [])
        .map((entry) => String(entry).trim())
        .filter(Boolean);
      const hasWildcard = allowListRaw.includes("*");
      const allowList = allowListRaw
        .filter((entry) => entry !== "*")
        .map((entry) => normalizeWhatsAppTarget(entry))
        .filter((entry): entry is string => Boolean(entry));

      if (trimmed) {
        const normalizedTo = normalizeWhatsAppTarget(trimmed);
        if (!normalizedTo) {
          if (
            (mode === "implicit" || mode === "heartbeat") &&
            allowList.length > 0
          ) {
            return { ok: true, to: allowList[0] };
          }
          return {
            ok: false,
            error: new Error(
              "Delivering to WhatsApp requires --to <E.164|group JID> or whatsapp.allowFrom[0]",
            ),
          };
        }
        if (isWhatsAppGroupJid(normalizedTo)) {
          return { ok: true, to: normalizedTo };
        }
        if (mode === "implicit" || mode === "heartbeat") {
          if (hasWildcard || allowList.length === 0) {
            return { ok: true, to: normalizedTo };
          }
          if (allowList.includes(normalizedTo)) {
            return { ok: true, to: normalizedTo };
          }
          return { ok: true, to: allowList[0] };
        }
        return { ok: true, to: normalizedTo };
      }

      if (allowList.length > 0) {
        return { ok: true, to: allowList[0] };
      }
      return {
        ok: false,
        error: new Error(
          "Delivering to WhatsApp requires --to <E.164|group JID> or whatsapp.allowFrom[0]",
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
  heartbeat: {
    checkReady: async ({ cfg, accountId, deps }) => {
      if (cfg.web?.enabled === false) {
        return { ok: false, reason: "whatsapp-disabled" };
      }
      const account = resolveWhatsAppAccount({ cfg, accountId });
      const authExists = await (deps?.webAuthExists ?? webAuthExists)(
        account.authDir,
      );
      if (!authExists) {
        return { ok: false, reason: "whatsapp-not-linked" };
      }
      const listenerActive = deps?.hasActiveWebListener
        ? deps.hasActiveWebListener()
        : Boolean(getActiveWebListener());
      if (!listenerActive) {
        return { ok: false, reason: "whatsapp-not-running" };
      }
      return { ok: true, reason: "ok" };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      reconnectAttempts: 0,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastMessageAt: null,
      lastEventAt: null,
      lastError: null,
    },
    collectStatusIssues: collectWhatsAppStatusIssues,
    buildProviderSummary: async ({ account, snapshot }) => {
      const authDir = account.authDir;
      const linked =
        typeof snapshot.linked === "boolean"
          ? snapshot.linked
          : authDir
            ? await webAuthExists(authDir)
            : false;
      const authAgeMs = linked && authDir ? getWebAuthAgeMs(authDir) : null;
      const self =
        linked && authDir ? readWebSelfId(authDir) : { e164: null, jid: null };
      return {
        configured: linked,
        linked,
        authAgeMs,
        self,
        running: snapshot.running ?? false,
        connected: snapshot.connected ?? false,
        lastConnectedAt: snapshot.lastConnectedAt ?? null,
        lastDisconnect: snapshot.lastDisconnect ?? null,
        reconnectAttempts: snapshot.reconnectAttempts,
        lastMessageAt: snapshot.lastMessageAt ?? null,
        lastEventAt: snapshot.lastEventAt ?? null,
        lastError: snapshot.lastError ?? null,
      };
    },
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
    resolveAccountState: ({ configured }) =>
      configured ? "linked" : "not linked",
    logSelfId: ({ account, runtime, includeProviderPrefix }) => {
      logWebSelfId(account.authDir, runtime, includeProviderPrefix);
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
    logoutAccount: async ({ account, runtime }) => {
      const cleared = await logoutWeb({
        authDir: account.authDir,
        isLegacyAuthDir: account.isLegacyAuthDir,
        runtime,
      });
      return { cleared, loggedOut: cleared };
    },
  },
};

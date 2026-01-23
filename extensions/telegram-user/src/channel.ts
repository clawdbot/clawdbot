import fs from "node:fs";

import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type ChannelSetupInput,
  type ClawdbotConfig,
} from "clawdbot/plugin-sdk";

import {
  listTelegramUserAccountIds,
  resolveDefaultTelegramUserAccountId,
  resolveTelegramUserAccount,
  type ResolvedTelegramUserAccount,
} from "./accounts.js";
import { TelegramUserConfigSchema } from "./config-schema.js";
import { loginTelegramUser } from "./login.js";
import { monitorTelegramUserProvider } from "./monitor/index.js";
import {
  looksLikeTelegramUserTargetId,
  normalizeTelegramUserMessagingTarget,
  sendMediaTelegramUser,
  sendMessageTelegramUser,
} from "./send.js";
import { resolveTelegramUserSessionPath } from "./session.js";
import { getTelegramUserRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

const meta = {
  id: "telegram-user",
  label: "Telegram User",
  selectionLabel: "Telegram User (MTProto)",
  detailLabel: "Telegram User",
  docsPath: "/channels/telegram-user",
  docsLabel: "telegram-user",
  blurb: "login as a Telegram user via QR; DM-only for now.",
  order: 12,
  quickstartAllowFrom: true,
};

type TelegramUserSetupInput = ChannelSetupInput & {
  apiId?: number;
  apiHash?: string;
};

const isSessionLinked = async (accountId: string): Promise<boolean> => {
  const sessionPath = resolveTelegramUserSessionPath(accountId);
  return fs.existsSync(sessionPath);
};

export const telegramUserPlugin: ChannelPlugin<ResolvedTelegramUserAccount> = {
  id: "telegram-user",
  meta,
  pairing: {
    idLabel: "telegramUserId",
    normalizeAllowEntry: (entry) =>
      entry.replace(/^(telegram-user|telegram|tg):/i, "").toLowerCase(),
    notifyApproval: async ({ id }) => {
      await sendMessageTelegramUser(String(id), "Clawdbot: access approved.", {});
    },
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  messaging: {
    normalizeTarget: normalizeTelegramUserMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeTelegramUserTargetId,
      hint: "<userId or @username>",
    },
  },
  reload: { configPrefixes: ["channels.telegram-user"] },
  configSchema: buildChannelConfigSchema(TelegramUserConfigSchema),
  config: {
    listAccountIds: (cfg) => listTelegramUserAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveTelegramUserAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultTelegramUserAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "telegram-user",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "telegram-user",
        accountId,
        clearBaseFields: ["apiId", "apiHash", "name"],
      }),
    isConfigured: (account) =>
      Boolean(account.credentials.apiId && account.credentials.apiHash),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.credentials.apiId && account.credentials.apiHash),
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveTelegramUserAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom ?? []).map(
        (entry) => String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(telegram-user|telegram|tg):/i, ""))
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.["telegram-user"]?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.telegram-user.accounts.${resolvedAccountId}.`
        : "channels.telegram-user.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("telegram-user"),
        normalizeEntry: (raw) =>
          raw.replace(/^(telegram-user|telegram|tg):/i, "").toLowerCase(),
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) =>
      getTelegramUserRuntime().channel.text.chunkMarkdownText(text, limit),
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const result = await sendMessageTelegramUser(to, text, { accountId: accountId ?? undefined });
      return { channel: "telegram-user", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const result = await sendMediaTelegramUser(to, text, {
        accountId: accountId ?? undefined,
        mediaUrl,
      });
      return { channel: "telegram-user", ...result };
    },
  },
  auth: {
    login: async ({ cfg, accountId, runtime }) => {
      const account = resolveTelegramUserAccount({
        cfg: cfg as CoreConfig,
        accountId,
      });
      const apiId = account.credentials.apiId;
      const apiHash = account.credentials.apiHash;
      if (!apiId || !apiHash) {
        throw new Error("Telegram user apiId/apiHash required. Set in config or env.");
      }
      const storagePath = resolveTelegramUserSessionPath(account.accountId);
      await loginTelegramUser({
        apiId,
        apiHash,
        storagePath,
        runtime,
      });
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    buildAccountSnapshot: async ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.credentials.apiId && account.credentials.apiHash),
      linked: await isSessionLinked(account.accountId),
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      dmPolicy: account.config.dmPolicy ?? "pairing",
      allowFrom: (account.config.allowFrom ?? []).map((entry) => String(entry)),
    }),
    resolveAccountState: ({ configured }) => (configured ? "configured" : "not configured"),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg as ClawdbotConfig,
        channelKey: "telegram-user",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      const setupInput = input as TelegramUserSetupInput;
      if (setupInput.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "TELEGRAM_USER_API_ID/TELEGRAM_USER_API_HASH can only be used for the default account.";
      }
      if (!setupInput.useEnv && (!setupInput.apiId || !setupInput.apiHash)) {
        return "Telegram user requires apiId/apiHash (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const setupInput = input as TelegramUserSetupInput;
      const namedConfig = applyAccountNameToChannelSection({
        cfg: cfg as ClawdbotConfig,
        channelKey: "telegram-user",
        accountId,
        name: setupInput.name,
      });
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...namedConfig,
          channels: {
            ...namedConfig.channels,
            "telegram-user": {
              ...namedConfig.channels?.["telegram-user"],
              enabled: true,
              ...(setupInput.useEnv
                ? {}
                : {
                    apiId: setupInput.apiId,
                    apiHash: setupInput.apiHash,
                  }),
            },
          },
        };
      }
      return {
        ...namedConfig,
        channels: {
          ...namedConfig.channels,
          "telegram-user": {
            ...namedConfig.channels?.["telegram-user"],
            enabled: true,
            accounts: {
              ...namedConfig.channels?.["telegram-user"]?.accounts,
              [accountId]: {
                ...namedConfig.channels?.["telegram-user"]?.accounts?.[accountId],
                enabled: true,
                ...(setupInput.useEnv
                  ? {}
                  : {
                      apiId: setupInput.apiId,
                      apiHash: setupInput.apiHash,
                    }),
              },
            },
          },
        },
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      ctx.setStatus({
        accountId: ctx.accountId,
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });
      try {
        await monitorTelegramUserProvider({
          runtime: ctx.runtime,
          abortSignal: ctx.abortSignal,
          accountId: ctx.accountId,
        });
        ctx.setStatus({
          accountId: ctx.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      } catch (err) {
        ctx.setStatus({
          accountId: ctx.accountId,
          running: false,
          lastStopAt: Date.now(),
          lastError: String(err),
        });
        throw err;
      }
    },
    stopAccount: async () => {
      const { getActiveTelegramUserClient, setActiveTelegramUserClient } =
        await import("./active-client.js");
      const active = getActiveTelegramUserClient();
      if (active) {
        await active.destroy().catch(() => undefined);
        setActiveTelegramUserClient(null);
      }
    },
  },
};

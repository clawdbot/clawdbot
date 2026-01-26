import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  collectTelegramStatusIssues,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  getChatChannelMeta,
  listTelegramAccountIds,
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
  looksLikeTelegramTargetId,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  normalizeTelegramMessagingTarget,
  PAIRING_APPROVED_MESSAGE,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
  resolveTelegramGroupRequireMention,
  resolveTelegramGroupToolPolicy,
  setAccountEnabledInConfigSection,
  telegramOnboardingAdapter,
  TelegramConfigSchema,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
  type ClawdbotConfig,
  type ResolvedTelegramAccount,
} from "clawdbot/plugin-sdk";

import { getTelegramRuntime } from "./runtime.js";

const meta = getChatChannelMeta("telegram");

const telegramMessageActions: ChannelMessageActionAdapter = {
  listActions: (ctx) => getTelegramRuntime().channel.telegram.messageActions.listActions(ctx),
  extractToolSend: (ctx) =>
    getTelegramRuntime().channel.telegram.messageActions.extractToolSend(ctx),
  handleAction: async (ctx) =>
    await getTelegramRuntime().channel.telegram.messageActions.handleAction(ctx),
};

function parseReplyToMessageId(replyToId?: string | null) {
  if (!replyToId) return undefined;
  const parsed = Number.parseInt(replyToId, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseThreadId(threadId?: string | number | null) {
  if (threadId == null) return undefined;
  if (typeof threadId === "number") {
    return Number.isFinite(threadId) ? Math.trunc(threadId) : undefined;
  }
  const trimmed = threadId.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
export const telegramPlugin: ChannelPlugin<ResolvedTelegramAccount> = {
  id: "telegram",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  onboarding: telegramOnboardingAdapter,
  pairing: {
    idLabel: "telegramUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(telegram|tg):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const { token } = getTelegramRuntime().channel.telegram.resolveTelegramToken(cfg);
      if (!token) throw new Error("telegram token not configured");
      await getTelegramRuntime().channel.telegram.sendMessageTelegram(id, PAIRING_APPROVED_MESSAGE, {
        token,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "group", "channel", "thread"],
    reactions: true,
    threads: true,
    media: true,
    nativeCommands: true,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.telegram"] },
  configSchema: buildChannelConfigSchema(TelegramConfigSchema),
  config: {
    listAccountIds: (cfg) => listTelegramAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveTelegramAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultTelegramAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "telegram",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "telegram",
        accountId,
        clearBaseFields: ["botToken", "tokenFile", "name"],
      }),
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveTelegramAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(telegram|tg):/i, ""))
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.telegram?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.telegram.accounts.${resolvedAccountId}.`
        : "channels.telegram.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("telegram"),
        normalizeEntry: (raw) => raw.replace(/^(telegram|tg):/i, ""),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      const groupAllowlistConfigured =
        account.config.groups && Object.keys(account.config.groups).length > 0;
      if (groupAllowlistConfigured) {
        return [
          `- Telegram groups: groupPolicy="open" allows any member in allowed groups to trigger (mention-gated). Set channels.telegram.groupPolicy="allowlist" + channels.telegram.groupAllowFrom to restrict senders.`,
        ];
      }
      return [
        `- Telegram groups: groupPolicy="open" with no channels.telegram.groups allowlist; any group can add + ping (mention-gated). Set channels.telegram.groupPolicy="allowlist" + channels.telegram.groupAllowFrom or configure channels.telegram.groups.`,
      ];
    },
  },
  groups: {
    resolveRequireMention: resolveTelegramGroupRequireMention,
    resolveToolPolicy: resolveTelegramGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: ({ cfg }) => cfg.channels?.telegram?.replyToMode ?? "first",
  },
  messaging: {
    normalizeTarget: normalizeTelegramMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeTelegramTargetId,
      hint: "<chatId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async (params) => listTelegramDirectoryPeersFromConfig(params),
    listGroups: async (params) => listTelegramDirectoryGroupsFromConfig(params),
  },
  actions: telegramMessageActions,
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "telegram",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "TELEGRAM_BOT_TOKEN can only be used for the default account.";
      }
      if (!input.useEnv && !input.token && !input.tokenFile) {
        return "Telegram requires token or --token-file (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "telegram",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "telegram",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            telegram: {
              ...next.channels?.telegram,
              enabled: true,
              ...(input.useEnv
                ? {}
                : input.tokenFile
                  ? { tokenFile: input.tokenFile }
                  : input.token
                    ? { botToken: input.token }
                    : {}),
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          telegram: {
            ...next.channels?.telegram,
            enabled: true,
            accounts: {
              ...next.channels?.telegram?.accounts,
              [accountId]: {
                ...next.channels?.telegram?.accounts?.[accountId],
                enabled: true,
                ...(input.tokenFile
                  ? { tokenFile: input.tokenFile }
                  : input.token
                    ? { botToken: input.token }
                    : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getTelegramRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId, deps, replyToId, threadId }) => {
      const send =
        deps?.sendTelegram ?? getTelegramRuntime().channel.telegram.sendMessageTelegram;
      const replyToMessageId = parseReplyToMessageId(replyToId);
      const messageThreadId = parseThreadId(threadId);
      const result = await send(to, text, {
        verbose: false,
        messageThreadId,
        replyToMessageId,
        accountId: accountId ?? undefined,
      });
      return { channel: "telegram", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId, threadId }) => {
      const send =
        deps?.sendTelegram ?? getTelegramRuntime().channel.telegram.sendMessageTelegram;
      const replyToMessageId = parseReplyToMessageId(replyToId);
      const messageThreadId = parseThreadId(threadId);
      const result = await send(to, text, {
        verbose: false,
        mediaUrl,
        messageThreadId,
        replyToMessageId,
        accountId: accountId ?? undefined,
      });
      return { channel: "telegram", ...result };
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
    collectStatusIssues: collectTelegramStatusIssues,
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      mode: snapshot.mode ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      getTelegramRuntime().channel.telegram.probeTelegram(
        account.token,
        timeoutMs,
        account.config.proxy,
      ),
    auditAccount: async ({ account, timeoutMs, probe, cfg }) => {
      const groups =
        cfg.channels?.telegram?.accounts?.[account.accountId]?.groups ??
        cfg.channels?.telegram?.groups;
      const { groupIds, unresolvedGroups, hasWildcardUnmentionedGroups } =
        getTelegramRuntime().channel.telegram.collectUnmentionedGroupIds(groups);
      if (!groupIds.length && unresolvedGroups === 0 && !hasWildcardUnmentionedGroups) {
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
      const audit = await getTelegramRuntime().channel.telegram.auditGroupMembership({
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
        cfg.channels?.telegram?.accounts?.[account.accountId]?.groups ??
        cfg.channels?.telegram?.groups;
      const allowUnmentionedGroups =
        Boolean(
          groups?.["*"] && (groups["*"] as { requireMention?: boolean }).requireMention === false,
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
        mode: runtime?.mode ?? (account.config.webhookUrl ? "webhook" : "polling"),
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
        const probe = await getTelegramRuntime().channel.telegram.probeTelegram(
          token,
          2500,
          account.config.proxy,
        );
        const username = probe.ok ? probe.bot?.username?.trim() : null;
        if (username) telegramBotLabel = ` (@${username})`;
      } catch (err) {
        if (getTelegramRuntime().logging.shouldLogVerbose()) {
          ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
        }
      }
      ctx.log?.info(`[${account.accountId}] starting provider${telegramBotLabel}`);
      return getTelegramRuntime().channel.telegram.monitorTelegramProvider({
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
    logoutAccount: async ({ accountId, cfg }) => {
      const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
      const nextCfg = { ...cfg } as ClawdbotConfig;
      const nextTelegram = cfg.channels?.telegram ? { ...cfg.channels.telegram } : undefined;
      let cleared = false;
      let changed = false;
      if (nextTelegram) {
        if (accountId === DEFAULT_ACCOUNT_ID && nextTelegram.botToken) {
          delete nextTelegram.botToken;
          cleared = true;
          changed = true;
        }
        const accounts =
          nextTelegram.accounts && typeof nextTelegram.accounts === "object"
            ? { ...nextTelegram.accounts }
            : undefined;
        if (accounts && accountId in accounts) {
          const entry = accounts[accountId];
          if (entry && typeof entry === "object") {
            const nextEntry = { ...entry } as Record<string, unknown>;
            if ("botToken" in nextEntry) {
              const token = nextEntry.botToken;
              if (typeof token === "string" ? token.trim() : token) {
                cleared = true;
              }
              delete nextEntry.botToken;
              changed = true;
            }
            if (Object.keys(nextEntry).length === 0) {
              delete accounts[accountId];
              changed = true;
            } else {
              accounts[accountId] = nextEntry as typeof entry;
            }
          }
        }
        if (accounts) {
          if (Object.keys(accounts).length === 0) {
            delete nextTelegram.accounts;
            changed = true;
          } else {
            nextTelegram.accounts = accounts;
          }
        }
      }
      if (changed) {
        if (nextTelegram && Object.keys(nextTelegram).length > 0) {
          nextCfg.channels = { ...nextCfg.channels, telegram: nextTelegram };
        } else {
          const nextChannels = { ...nextCfg.channels };
          delete nextChannels.telegram;
          if (Object.keys(nextChannels).length > 0) {
            nextCfg.channels = nextChannels;
          } else {
            delete nextCfg.channels;
          }
        }
      }
      const resolved = resolveTelegramAccount({
        cfg: changed ? nextCfg : cfg,
        accountId,
      });
      const loggedOut = resolved.tokenSource === "none";
      if (changed) {
        await getTelegramRuntime().config.writeConfigFile(nextCfg);
      }
      return { cleared, envToken: Boolean(envToken), loggedOut };
    },
  },
};

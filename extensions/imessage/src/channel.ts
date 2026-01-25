import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  getChatChannelMeta,
  imessageOnboardingAdapter,
  IMessageConfigSchema,
  listIMessageAccountIds,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  resolveChannelMediaMaxBytes,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type ResolvedIMessageAccount,
} from "clawdbot/plugin-sdk";

import { getIMessageRuntime } from "./runtime.js";

const meta = getChatChannelMeta("imessage");

export const imessagePlugin: ChannelPlugin<ResolvedIMessageAccount> = {
  id: "imessage",
  meta: {
    ...meta,
    aliases: ["imsg"],
    showConfigured: false,
  },
  onboarding: imessageOnboardingAdapter,
  pairing: {
    idLabel: "imessageSenderId",
    notifyApproval: async ({ id }) => {
      await getIMessageRuntime().channel.imessage.sendMessageIMessage(
        id,
        PAIRING_APPROVED_MESSAGE,
      );
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
  },
  reload: { configPrefixes: ["channels.imessage"] },
  configSchema: buildChannelConfigSchema(IMessageConfigSchema),
  config: {
    listAccountIds: (cfg) => listIMessageAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveIMessageAccount({ cfg, accountId }),
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
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveIMessageAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.imessage?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.imessage.accounts.${resolvedAccountId}.`
        : "channels.imessage.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("imessage"),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      return [
        `- iMessage groups: groupPolicy="open" allows any member to trigger the bot. Set channels.imessage.groupPolicy="allowlist" + channels.imessage.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  groups: {
    resolveRequireMention: resolveIMessageGroupRequireMention,
    resolveToolPolicy: resolveIMessageGroupToolPolicy,
  },
  messaging: {
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) return false;
        if (/^(imessage:|chat_id:)/i.test(trimmed)) return true;
        if (trimmed.includes("@")) return true;
        return /^\+?\d{3,}$/.test(trimmed);
      },
      hint: "<handle|chat_id:ID>",
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "imessage",
        accountId,
        name,
      }),
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "imessage",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "imessage",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            imessage: {
              ...next.channels?.imessage,
              enabled: true,
              ...(input.cliPath ? { cliPath: input.cliPath } : {}),
              ...(input.dbPath ? { dbPath: input.dbPath } : {}),
              ...(input.service ? { service: input.service } : {}),
              ...(input.region ? { region: input.region } : {}),
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          imessage: {
            ...next.channels?.imessage,
            enabled: true,
            accounts: {
              ...next.channels?.imessage?.accounts,
              [accountId]: {
                ...next.channels?.imessage?.accounts?.[accountId],
                enabled: true,
                ...(input.cliPath ? { cliPath: input.cliPath } : {}),
                ...(input.dbPath ? { dbPath: input.dbPath } : {}),
                ...(input.service ? { service: input.service } : {}),
                ...(input.region ? { region: input.region } : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getIMessageRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ cfg, to, text, accountId, deps }) => {
      const send = deps?.sendIMessage ?? getIMessageRuntime().channel.imessage.sendMessageIMessage;
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg,
        resolveChannelLimitMb: ({ cfg, accountId }) =>
          cfg.channels?.imessage?.accounts?.[accountId]?.mediaMaxMb ??
          cfg.channels?.imessage?.mediaMaxMb,
        accountId,
      });
      const result = await send(to, text, {
        maxBytes,
        accountId: accountId ?? undefined,
      });
      return { channel: "imessage", ...result };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, deps }) => {
      const send = deps?.sendIMessage ?? getIMessageRuntime().channel.imessage.sendMessageIMessage;
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg,
        resolveChannelLimitMb: ({ cfg, accountId }) =>
          cfg.channels?.imessage?.accounts?.[accountId]?.mediaMaxMb ??
          cfg.channels?.imessage?.mediaMaxMb,
        accountId,
      });
      const result = await send(to, text, {
        mediaUrl,
        maxBytes,
        accountId: accountId ?? undefined,
      });
      return { channel: "imessage", ...result };
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
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) return [];
        return [
          {
            channel: "imessage",
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
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
    probeAccount: async ({ timeoutMs }) =>
      getIMessageRuntime().channel.imessage.probeIMessage(timeoutMs),
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
    resolveAccountState: ({ enabled }) => (enabled ? "enabled" : "disabled"),
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
      return getIMessageRuntime().channel.imessage.monitorIMessageProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};

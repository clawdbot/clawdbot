import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  collectDiscordAuditChannelIds,
  collectDiscordStatusIssues,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  discordOnboardingAdapter,
  DiscordConfigSchema,
  formatPairingApproveHint,
  getChatChannelMeta,
  listDiscordAccountIds,
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
  looksLikeDiscordTargetId,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  normalizeDiscordMessagingTarget,
  PAIRING_APPROVED_MESSAGE,
  resolveDiscordAccount,
  resolveDefaultDiscordAccountId,
  resolveDiscordGroupRequireMention,
  resolveDiscordGroupToolPolicy,
  setAccountEnabledInConfigSection,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
  type ResolvedDiscordAccount,
} from "clawdbot/plugin-sdk";

import { getDiscordRuntime } from "./runtime.js";

const meta = getChatChannelMeta("discord");

function resolveDiscordMessageActions() {
  try {
    return getDiscordRuntime().channel.discord?.messageActions ?? null;
  } catch {
    return null;
  }
}

const discordMessageActions: ChannelMessageActionAdapter = {
  listActions: (ctx) => resolveDiscordMessageActions()?.listActions?.(ctx) ?? [],
  extractToolSend: (ctx) => resolveDiscordMessageActions()?.extractToolSend?.(ctx),
  handleAction: async (ctx) => {
    const actions = resolveDiscordMessageActions();
    if (!actions?.handleAction) return null;
    return await actions.handleAction(ctx);
  },
};

export const discordPlugin: ChannelPlugin<ResolvedDiscordAccount> = {
  id: "discord",
  meta: {
    ...meta,
  },
  onboarding: discordOnboardingAdapter,
  pairing: {
    idLabel: "discordUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(discord|user):/i, ""),
    notifyApproval: async ({ id }) => {
      await getDiscordRuntime().channel.discord.sendMessageDiscord(
        `user:${id}`,
        PAIRING_APPROVED_MESSAGE,
      );
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    polls: true,
    reactions: true,
    threads: true,
    media: true,
    nativeCommands: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.discord"] },
  configSchema: buildChannelConfigSchema(DiscordConfigSchema),
  config: {
    listAccountIds: (cfg) => listDiscordAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveDiscordAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultDiscordAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "discord",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "discord",
        accountId,
        clearBaseFields: ["token", "name"],
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
      (resolveDiscordAccount({ cfg, accountId }).config.dm?.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.discord?.accounts?.[resolvedAccountId]);
      const allowFromPath = useAccountPath
        ? `channels.discord.accounts.${resolvedAccountId}.dm.`
        : "channels.discord.dm.";
      return {
        policy: account.config.dm?.policy ?? "pairing",
        allowFrom: account.config.dm?.allowFrom ?? [],
        allowFromPath,
        approveHint: formatPairingApproveHint("discord"),
        normalizeEntry: (raw) => raw.replace(/^(discord|user):/i, "").replace(/^<@!?(\d+)>$/, "$1"),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "open";
      const guildEntries = account.config.guilds ?? {};
      const guildsConfigured = Object.keys(guildEntries).length > 0;
      const channelAllowlistConfigured = guildsConfigured;

      if (groupPolicy === "open") {
        if (channelAllowlistConfigured) {
          warnings.push(
            `- Discord guilds: groupPolicy="open" allows any channel not explicitly denied to trigger (mention-gated). Set channels.discord.groupPolicy="allowlist" and configure channels.discord.guilds.<id>.channels.`,
          );
        } else {
          warnings.push(
            `- Discord guilds: groupPolicy="open" with no guild/channel allowlist; any channel can trigger (mention-gated). Set channels.discord.groupPolicy="allowlist" and configure channels.discord.guilds.<id>.channels.`,
          );
        }
      }

      return warnings;
    },
  },
  groups: {
    resolveRequireMention: resolveDiscordGroupRequireMention,
    resolveToolPolicy: resolveDiscordGroupToolPolicy,
  },
  mentions: {
    stripPatterns: () => ["<@!?\\d+>"],
  },
  threading: {
    resolveReplyToMode: ({ cfg }) => cfg.channels?.discord?.replyToMode ?? "off",
  },
  messaging: {
    normalizeTarget: normalizeDiscordMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeDiscordTargetId,
      hint: "<channelId|user:ID|channel:ID>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async (params) => listDiscordDirectoryPeersFromConfig(params),
    listGroups: async (params) => listDiscordDirectoryGroupsFromConfig(params),
    listPeersLive: async (params) =>
      getDiscordRuntime().channel.discord.listDirectoryPeersLive(params),
    listGroupsLive: async (params) =>
      getDiscordRuntime().channel.discord.listDirectoryGroupsLive(params),
  },
  resolver: {
    resolveTargets: async ({ cfg, accountId, inputs, kind }) => {
      const account = resolveDiscordAccount({ cfg, accountId });
      const token = account.token?.trim();
      if (!token) {
        return inputs.map((input) => ({
          input,
          resolved: false,
          note: "missing Discord token",
        }));
      }
      if (kind === "group") {
        const resolved = await getDiscordRuntime().channel.discord.resolveChannelAllowlist({
          token,
          entries: inputs,
        });
        return resolved.map((entry) => ({
          input: entry.input,
          resolved: entry.resolved,
          id: entry.channelId ?? entry.guildId,
          name:
            entry.channelName ??
            entry.guildName ??
            (entry.guildId && !entry.channelId ? entry.guildId : undefined),
          note: entry.note,
        }));
      }
      const resolved = await getDiscordRuntime().channel.discord.resolveUserAllowlist({
        token,
        entries: inputs,
      });
      return resolved.map((entry) => ({
        input: entry.input,
        resolved: entry.resolved,
        id: entry.id,
        name: entry.name,
        note: entry.note,
      }));
    },
  },
  actions: discordMessageActions,
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "discord",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "DISCORD_BOT_TOKEN can only be used for the default account.";
      }
      if (!input.useEnv && !input.token) {
        return "Discord requires token (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "discord",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "discord",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            discord: {
              ...next.channels?.discord,
              enabled: true,
              ...(input.useEnv ? {} : input.token ? { token: input.token } : {}),
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          discord: {
            ...next.channels?.discord,
            enabled: true,
            accounts: {
              ...next.channels?.discord?.accounts,
              [accountId]: {
                ...next.channels?.discord?.accounts?.[accountId],
                enabled: true,
                ...(input.token ? { token: input.token } : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: null,
    textChunkLimit: 2000,
    pollMaxOptions: 10,
    sendText: async ({ to, text, accountId, deps, replyToId }) => {
      const send =
        deps?.sendDiscord ?? getDiscordRuntime().channel.discord.sendMessageDiscord;
      const result = await send(to, text, {
        verbose: false,
        replyTo: replyToId ?? undefined,
        accountId: accountId ?? undefined,
      });
      return { channel: "discord", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId }) => {
      const send =
        deps?.sendDiscord ?? getDiscordRuntime().channel.discord.sendMessageDiscord;
      const result = await send(to, text, {
        verbose: false,
        mediaUrl,
        replyTo: replyToId ?? undefined,
        accountId: accountId ?? undefined,
      });
      return { channel: "discord", ...result };
    },
    sendPoll: async ({ to, poll, accountId }) =>
      await getDiscordRuntime().channel.discord.sendPollDiscord(to, poll, {
        accountId: accountId ?? undefined,
      }),
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: collectDiscordStatusIssues,
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      getDiscordRuntime().channel.discord.probeDiscord(account.token, timeoutMs, {
        includeApplication: true,
      }),
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
      const audit = await getDiscordRuntime().channel.discord.auditChannelPermissions({
        token: botToken,
        accountId: account.accountId,
        channelIds,
        timeoutMs,
      });
      return { ...audit, unresolvedChannels };
    },
    buildAccountSnapshot: ({ account, runtime, probe, audit }) => {
      const configured = Boolean(account.token?.trim());
      const app = runtime?.application ?? (probe as { application?: unknown })?.application;
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
        const probe = await getDiscordRuntime().channel.discord.probeDiscord(token, 2500, {
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
        if (getDiscordRuntime().logging.shouldLogVerbose()) {
          ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
        }
      }
      ctx.log?.info(`[${account.accountId}] starting provider${discordBotLabel}`);
      return getDiscordRuntime().channel.discord.monitorDiscordProvider({
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

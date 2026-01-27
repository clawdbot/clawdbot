import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type MoltbotConfig,
  type ChannelSetupInput,
} from "clawdbot/plugin-sdk";

import {
  listNextcloudTalkAccountIds,
  resolveDefaultNextcloudTalkAccountId,
  resolveNextcloudTalkAccount,
  type ResolvedNextcloudTalkAccount,
} from "./accounts.js";
import { NextcloudTalkConfigSchema } from "./config-schema.js";
import { monitorNextcloudTalkProvider } from "./monitor.js";
import { looksLikeNextcloudTalkTargetId, normalizeNextcloudTalkMessagingTarget } from "./normalize.js";
import { nextcloudTalkOnboardingAdapter } from "./onboarding.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { sendMessageNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";
import { resolveNextcloudTalkGroupToolPolicy } from "./policy.js";

const meta = {
  id: "nextcloud-talk",
  label: "Nextcloud Talk",
  selectionLabel: "Nextcloud Talk (self-hosted)",
  docsPath: "/channels/nextcloud-talk",
  docsLabel: "nextcloud-talk",
  blurb: "Self-hosted chat via Nextcloud Talk webhook bots.",
  aliases: ["nc-talk", "nc"],
  order: 65,
  quickstartAllowFrom: true,
};

type NextcloudSetupInput = ChannelSetupInput & {
  baseUrl?: string;
  secret?: string;
  secretFile?: string;
  useEnv?: boolean;
};

export const nextcloudTalkPlugin: ChannelPlugin<ResolvedNextcloudTalkAccount> = {
  id: "nextcloud-talk",
  meta,
  onboarding: nextcloudTalkOnboardingAdapter,
  pairing: {
    idLabel: "nextcloudUserId",
    normalizeAllowEntry: (entry) =>
      entry.replace(/^(nextcloud-talk|nc-talk|nc):/i, "").toLowerCase(),
    notifyApproval: async ({ id }) => {
      console.log(`[nextcloud-talk] User ${id} approved for pairing`);
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: true,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.nextcloud-talk"] },
  configSchema: buildChannelConfigSchema(NextcloudTalkConfigSchema),
  config: {
    listAccountIds: (cfg) => listNextcloudTalkAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultNextcloudTalkAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "nextcloud-talk",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "nextcloud-talk",
        accountId,
        clearBaseFields: ["botSecret", "botSecretFile", "baseUrl", "name"],
      }),
    isConfigured: (account) => Boolean(account.secret?.trim() && account.baseUrl?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.secret?.trim() && account.baseUrl?.trim()),
      secretSource: account.secretSource,
      baseUrl: account.baseUrl ? "[set]" : "[missing]",
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom ?? []).map(
        (entry) => String(entry).toLowerCase(),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(nextcloud-talk|nc-talk|nc):/i, ""))
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(
        cfg.channels?.["nextcloud-talk"]?.accounts?.[resolvedAccountId],
      );
      const basePath = useAccountPath
        ? `channels.nextcloud-talk.accounts.${resolvedAccountId}.`
        : "channels.nextcloud-talk.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("nextcloud-talk"),
        normalizeEntry: (raw) =>
          raw.replace(/^(nextcloud-talk|nc-talk|nc):/i, "").toLowerCase(),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      const roomAllowlistConfigured =
        account.config.rooms && Object.keys(account.config.rooms).length > 0;
      if (roomAllowlistConfigured) {
        return [
          `- Nextcloud Talk rooms: groupPolicy="open" allows any member in allowed rooms to trigger (mention-gated). Set channels.nextcloud-talk.groupPolicy="allowlist" + channels.nextcloud-talk.groupAllowFrom to restrict senders.`,
        ];
      }
      return [
        `- Nextcloud Talk rooms: groupPolicy="open" with no channels.nextcloud-talk.rooms allowlist; any room can add + ping (mention-gated). Set channels.nextcloud-talk.groupPolicy="allowlist" + channels.nextcloud-talk.groupAllowFrom or configure channels.nextcloud-talk.rooms.`,
      ];
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      const account = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
      const rooms = account.config.rooms;
      if (!rooms || !groupId) return true;

      const roomConfig = rooms[groupId];
      if (roomConfig?.requireMention !== undefined) {
        return roomConfig.requireMention;
      }

      const wildcardConfig = rooms["*"];
      if (wildcardConfig?.requireMention !== undefined) {
        return wildcardConfig.requireMention;
      }

      return true;
    },
    resolveToolPolicy: resolveNextcloudTalkGroupToolPolicy,
  },
  messaging: {
    normalizeTarget: normalizeNextcloudTalkMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeNextcloudTalkTargetId,
      hint: "<roomToken>",
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg as MoltbotConfig,
        channelKey: "nextcloud-talk",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      const setupInput = input as NextcloudSetupInput;
      if (setupInput.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "NEXTCLOUD_TALK_BOT_SECRET can only be used for the default account.";
      }
      if (!setupInput.useEnv && !setupInput.secret && !setupInput.secretFile) {
        return "Nextcloud Talk requires bot secret or --secret-file (or --use-env).";
      }
      if (!setupInput.baseUrl) {
        return "Nextcloud Talk requires --base-url.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const setupInput = input as NextcloudSetupInput;
      const namedConfig = applyAccountNameToChannelSection({
        cfg: cfg as MoltbotConfig,
        channelKey: "nextcloud-talk",
        accountId,
        name: setupInput.name,
      });
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...namedConfig,
          channels: {
            ...namedConfig.channels,
            "nextcloud-talk": {
              ...namedConfig.channels?.["nextcloud-talk"],
              enabled: true,
              baseUrl: setupInput.baseUrl,
              ...(setupInput.useEnv
                ? {}
                : setupInput.secretFile
                  ? { botSecretFile: setupInput.secretFile }
                  : setupInput.secret
                    ? { botSecret: setupInput.secret }
                    : {}),
            },
          },
        } as MoltbotConfig;
      }
      return {
        ...namedConfig,
        channels: {
          ...namedConfig.channels,
          "nextcloud-talk": {
            ...namedConfig.channels?.["nextcloud-talk"],
            enabled: true,
            accounts: {
              ...namedConfig.channels?.["nextcloud-talk"]?.accounts,
              [accountId]: {
                ...namedConfig.channels?.["nextcloud-talk"]?.accounts?.[accountId],
                enabled: true,
                baseUrl: setupInput.baseUrl,
                ...(setupInput.secretFile
                  ? { botSecretFile: setupInput.secretFile }
                  : setupInput.secret
                    ? { botSecret: setupInput.secret }
                    : {}),
              },
            },
          },
        },
      } as MoltbotConfig;
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getNextcloudTalkRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId, replyToId }) => {
      const result = await sendMessageNextcloudTalk(to, text, {
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      });
      return { channel: "nextcloud-talk", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId }) => {
      const messageWithMedia = mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text;
      const result = await sendMessageNextcloudTalk(to, messageWithMedia, {
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      });
      return { channel: "nextcloud-talk", ...result };
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
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      secretSource: snapshot.secretSource ?? "none",
      running: snapshot.running ?? false,
      mode: "webhook",
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => {
      const configured = Boolean(account.secret?.trim() && account.baseUrl?.trim());
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        secretSource: account.secretSource,
        baseUrl: account.baseUrl ? "[set]" : "[missing]",
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        mode: "webhook",
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.secret || !account.baseUrl) {
        throw new Error(
          `Nextcloud Talk not configured for account "${account.accountId}" (missing secret or baseUrl)`,
        );
      }

      ctx.log?.info(`[${account.accountId}] starting Nextcloud Talk webhook server`);

      const { stop } = await monitorNextcloudTalkProvider({
        accountId: account.accountId,
        config: ctx.cfg as CoreConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });

      return { stop };
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const nextCfg = { ...cfg } as MoltbotConfig;
      const nextSection = cfg.channels?.["nextcloud-talk"]
        ? { ...cfg.channels["nextcloud-talk"] }
        : undefined;
      let cleared = false;
      let changed = false;

      if (nextSection) {
        if (accountId === DEFAULT_ACCOUNT_ID && nextSection.botSecret) {
          delete nextSection.botSecret;
          cleared = true;
          changed = true;
        }
        const accounts =
          nextSection.accounts && typeof nextSection.accounts === "object"
            ? { ...nextSection.accounts }
            : undefined;
        if (accounts && accountId in accounts) {
          const entry = accounts[accountId];
          if (entry && typeof entry === "object") {
            const nextEntry = { ...entry } as Record<string, unknown>;
            if ("botSecret" in nextEntry) {
              const secret = nextEntry.botSecret;
              if (typeof secret === "string" ? secret.trim() : secret) {
                cleared = true;
              }
              delete nextEntry.botSecret;
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
            delete nextSection.accounts;
            changed = true;
          } else {
            nextSection.accounts = accounts;
          }
        }
      }

      if (changed) {
        if (nextSection && Object.keys(nextSection).length > 0) {
          nextCfg.channels = { ...nextCfg.channels, "nextcloud-talk": nextSection };
        } else {
          const nextChannels = { ...nextCfg.channels } as Record<string, unknown>;
          delete nextChannels["nextcloud-talk"];
          if (Object.keys(nextChannels).length > 0) {
            nextCfg.channels = nextChannels as MoltbotConfig["channels"];
          } else {
            delete nextCfg.channels;
          }
        }
      }

      const resolved = resolveNextcloudTalkAccount({
        cfg: (changed ? (nextCfg as CoreConfig) : (cfg as CoreConfig)),
        accountId,
      });
      const loggedOut = resolved.secretSource === "none";

      if (changed) {
        await getNextcloudTalkRuntime().config.writeConfigFile(nextCfg);
      }

      return {
        cleared,
        envSecret: Boolean(process.env.NEXTCLOUD_TALK_BOT_SECRET?.trim()),
        loggedOut,
      };
    },
  },
};

import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  getChatChannelMeta,
  migrateBaseNameToDefaultAccount,
  missingTargetError,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  resolveChannelMediaMaxBytes,
  resolveGoogleChatGroupRequireMention,
  setAccountEnabledInConfigSection,
  type ChannelDock,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
  type ClawdbotConfig,
} from "clawdbot/plugin-sdk";
import { GoogleChatConfigSchema } from "clawdbot/plugin-sdk";

import {
  listGoogleChatAccountIds,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatAccount,
  type ResolvedGoogleChatAccount,
} from "./accounts.js";
import { googlechatMessageActions } from "./actions.js";
import { sendGoogleChatMessage, uploadGoogleChatAttachment, probeGoogleChat } from "./api.js";
import { googlechatOnboardingAdapter } from "./onboarding.js";
import { getGoogleChatRuntime } from "./runtime.js";
import { resolveGoogleChatWebhookPath, startGoogleChatMonitor } from "./monitor.js";
import {
  isGoogleChatSpaceTarget,
  isGoogleChatUserTarget,
  normalizeGoogleChatTarget,
  resolveGoogleChatOutboundSpace,
} from "./targets.js";

const meta = getChatChannelMeta("googlechat");

const formatAllowFromEntry = (entry: string) =>
  entry
    .trim()
    .replace(/^(googlechat|google-chat|gchat):/i, "")
    .replace(/^user:/i, "")
    .replace(/^users\//i, "")
    .toLowerCase();

export const googlechatDock: ChannelDock = {
  id: "googlechat",
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    reactions: true,
    media: true,
    threads: true,
    blockStreaming: true,
  },
  outbound: { textChunkLimit: 4000 },
  config: {
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveGoogleChatAccount({ cfg: cfg as ClawdbotConfig, accountId }).config.dm?.allowFrom ??
        []
      ).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map(formatAllowFromEntry),
  },
  groups: {
    resolveRequireMention: resolveGoogleChatGroupRequireMention,
  },
  threading: {
    resolveReplyToMode: ({ cfg }) => cfg.channels?.["googlechat"]?.replyToMode ?? "off",
    buildToolContext: ({ context, hasRepliedRef }) => {
      const threadId = context.MessageThreadId ?? context.ReplyToId;
      return {
        currentChannelId: context.To?.trim() || undefined,
        currentThreadTs: threadId != null ? String(threadId) : undefined,
        hasRepliedRef,
      };
    },
  },
};

const googlechatActions: ChannelMessageActionAdapter = {
  listActions: (ctx) => googlechatMessageActions.listActions?.(ctx) ?? [],
  extractToolSend: (ctx) => googlechatMessageActions.extractToolSend?.(ctx) ?? null,
  handleAction: async (ctx) => {
    if (!googlechatMessageActions.handleAction) {
      throw new Error("Google Chat actions are not available.");
    }
    return await googlechatMessageActions.handleAction(ctx);
  },
};

export const googlechatPlugin: ChannelPlugin<ResolvedGoogleChatAccount> = {
  id: "googlechat",
  meta: { ...meta },
  onboarding: googlechatOnboardingAdapter,
  pairing: {
    idLabel: "googlechatUserId",
    normalizeAllowEntry: (entry) => formatAllowFromEntry(entry),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveGoogleChatAccount({ cfg: cfg as ClawdbotConfig });
      if (account.credentialSource === "none") return;
      const user = normalizeGoogleChatTarget(id) ?? id;
      const target = isGoogleChatUserTarget(user) ? user : `users/${user}`;
      const space = await resolveGoogleChatOutboundSpace({ account, target });
      await sendGoogleChatMessage({
        account,
        space,
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    reactions: true,
    threads: true,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.googlechat"] },
  configSchema: buildChannelConfigSchema(GoogleChatConfigSchema),
  config: {
    listAccountIds: (cfg) => listGoogleChatAccountIds(cfg as ClawdbotConfig),
    resolveAccount: (cfg, accountId) =>
      resolveGoogleChatAccount({ cfg: cfg as ClawdbotConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultGoogleChatAccountId(cfg as ClawdbotConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as ClawdbotConfig,
        sectionKey: "googlechat",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as ClawdbotConfig,
        sectionKey: "googlechat",
        accountId,
        clearBaseFields: [
          "serviceAccount",
          "serviceAccountFile",
          "oauthClientId",
          "oauthClientSecret",
          "oauthRedirectUri",
          "oauthClientFile",
          "oauthRefreshToken",
          "oauthRefreshTokenFile",
          "oauthFromGog",
          "gogAccount",
          "gogClient",
          "audienceType",
          "audience",
          "webhookPath",
          "webhookUrl",
          "botUser",
          "name",
        ],
      }),
    isConfigured: (account) => account.credentialSource !== "none",
    unconfiguredReason: (account) => {
      if (account.config.oauthFromGog) {
        return "Google Chat OAuth from gog is enabled but no gog credentials were found. Ensure gog is installed, the gateway can access its keyring, or set oauthRefreshToken/oauthClientFile.";
      }
      return "Google Chat credentials are missing. Configure a service account or user OAuth.";
    },
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.credentialSource !== "none",
      credentialSource: account.credentialSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveGoogleChatAccount({
        cfg: cfg as ClawdbotConfig,
        accountId,
      }).config.dm?.allowFrom ?? []
      ).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map(formatAllowFromEntry),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(
        (cfg as ClawdbotConfig).channels?.["googlechat"]?.accounts?.[resolvedAccountId],
      );
      const allowFromPath = useAccountPath
        ? `channels.googlechat.accounts.${resolvedAccountId}.dm.`
        : "channels.googlechat.dm.";
      return {
        policy: account.config.dm?.policy ?? "pairing",
        allowFrom: account.config.dm?.allowFrom ?? [],
        allowFromPath,
        approveHint: formatPairingApproveHint("googlechat"),
        normalizeEntry: (raw) => formatAllowFromEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy === "open") {
        warnings.push(
          `- Google Chat spaces: groupPolicy="open" allows any space to trigger (mention-gated). Set channels.googlechat.groupPolicy="allowlist" and configure channels.googlechat.groups.`,
        );
      }
      if (account.config.dm?.policy === "open") {
        warnings.push(
          `- Google Chat DMs are open to anyone. Set channels.googlechat.dm.policy="pairing" or "allowlist".`,
        );
      }
      return warnings;
    },
  },
  groups: {
    resolveRequireMention: resolveGoogleChatGroupRequireMention,
  },
  threading: {
    resolveReplyToMode: ({ cfg }) => cfg.channels?.["googlechat"]?.replyToMode ?? "off",
  },
  messaging: {
    normalizeTarget: normalizeGoogleChatTarget,
    targetResolver: {
      looksLikeId: (raw, normalized) => {
        const value = normalized ?? raw.trim();
        return isGoogleChatSpaceTarget(value) || isGoogleChatUserTarget(value);
      },
      hint: "<spaces/{space}|users/{user}>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveGoogleChatAccount({
        cfg: cfg as ClawdbotConfig,
        accountId,
      });
      const q = query?.trim().toLowerCase() || "";
      const allowFrom = account.config.dm?.allowFrom ?? [];
      const peers = Array.from(
        new Set(
          allowFrom
            .map((entry) => String(entry).trim())
            .filter((entry) => Boolean(entry) && entry !== "*")
            .map((entry) => normalizeGoogleChatTarget(entry) ?? entry),
        ),
      )
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
      return peers;
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveGoogleChatAccount({
        cfg: cfg as ClawdbotConfig,
        accountId,
      });
      const groups = account.config.groups ?? {};
      const q = query?.trim().toLowerCase() || "";
      const entries = Object.keys(groups)
        .filter((key) => key && key !== "*")
        .filter((key) => (q ? key.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id }) as const);
      return entries;
    },
  },
  resolver: {
    resolveTargets: async ({ inputs, kind }) => {
      const resolved = inputs.map((input) => {
        const normalized = normalizeGoogleChatTarget(input);
        if (!normalized) {
          return { input, resolved: false, note: "empty target" };
        }
        if (kind === "user" && isGoogleChatUserTarget(normalized)) {
          return { input, resolved: true, id: normalized };
        }
        if (kind === "group" && isGoogleChatSpaceTarget(normalized)) {
          return { input, resolved: true, id: normalized };
        }
        return {
          input,
          resolved: false,
          note: "use spaces/{space} or users/{user}",
        };
      });
      return resolved;
    },
  },
  actions: googlechatActions,
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg as ClawdbotConfig,
        channelKey: "googlechat",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "Google Chat env credentials can only be used for the default account.";
      }
      const hasServiceAccount = Boolean(input.token || input.tokenFile);
      const hasOauthInput = Boolean(
        input.oauthFromGog ||
          input.oauthClientId ||
          input.oauthClientSecret ||
          input.oauthRedirectUri ||
          input.oauthClientFile ||
          input.oauthRefreshToken ||
          input.oauthRefreshTokenFile,
      );
      if (!input.useEnv && !hasServiceAccount && !hasOauthInput) {
        return "Google Chat requires service account JSON or OAuth credentials.";
      }
      if (hasOauthInput && !input.oauthFromGog) {
        const hasClient =
          Boolean(input.oauthClientFile) ||
          (Boolean(input.oauthClientId) && Boolean(input.oauthClientSecret));
        const hasRefresh = Boolean(input.oauthRefreshToken || input.oauthRefreshTokenFile);
        if (!hasClient || !hasRefresh) {
          return "Google Chat OAuth requires client id/secret (or --oauth-client-file) and a refresh token.";
        }
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg: cfg as ClawdbotConfig,
        channelKey: "googlechat",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig as ClawdbotConfig,
              channelKey: "googlechat",
            })
          : namedConfig;
      const patch = input.useEnv
        ? {}
        : input.tokenFile
          ? { serviceAccountFile: input.tokenFile }
          : input.token
            ? { serviceAccount: input.token }
            : {};
      const oauthClientId = input.oauthClientId?.trim();
      const oauthClientSecret = input.oauthClientSecret?.trim();
      const oauthRedirectUri = input.oauthRedirectUri?.trim();
      const oauthClientFile = input.oauthClientFile?.trim();
      const oauthRefreshToken = input.oauthRefreshToken?.trim();
      const oauthRefreshTokenFile = input.oauthRefreshTokenFile?.trim();
      const oauthFromGog = input.oauthFromGog === true ? true : undefined;
      const gogAccount = input.gogAccount?.trim();
      const gogClient = input.gogClient?.trim();
      const audienceType = input.audienceType?.trim();
      const audience = input.audience?.trim();
      const webhookPath = input.webhookPath?.trim();
      const webhookUrl = input.webhookUrl?.trim();
      const configPatch = {
        ...patch,
        ...(oauthClientId ? { oauthClientId } : {}),
        ...(oauthClientSecret ? { oauthClientSecret } : {}),
        ...(oauthRedirectUri ? { oauthRedirectUri } : {}),
        ...(oauthClientFile ? { oauthClientFile } : {}),
        ...(oauthRefreshToken ? { oauthRefreshToken } : {}),
        ...(oauthRefreshTokenFile ? { oauthRefreshTokenFile } : {}),
        ...(oauthFromGog ? { oauthFromGog } : {}),
        ...(gogAccount ? { gogAccount } : {}),
        ...(gogClient ? { gogClient } : {}),
        ...(audienceType ? { audienceType } : {}),
        ...(audience ? { audience } : {}),
        ...(webhookPath ? { webhookPath } : {}),
        ...(webhookUrl ? { webhookUrl } : {}),
      };
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            "googlechat": {
              ...(next.channels?.["googlechat"] ?? {}),
              enabled: true,
              ...configPatch,
            },
          },
        } as ClawdbotConfig;
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          "googlechat": {
            ...(next.channels?.["googlechat"] ?? {}),
            enabled: true,
            accounts: {
              ...(next.channels?.["googlechat"]?.accounts ?? {}),
              [accountId]: {
                ...(next.channels?.["googlechat"]?.accounts?.[accountId] ?? {}),
                enabled: true,
                ...configPatch,
              },
            },
          },
        },
      } as ClawdbotConfig;
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) =>
      getGoogleChatRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    resolveTarget: ({ to, allowFrom, mode }) => {
      const trimmed = to?.trim() ?? "";
      const allowListRaw = (allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
      const allowList = allowListRaw
        .filter((entry) => entry !== "*")
        .map((entry) => normalizeGoogleChatTarget(entry))
        .filter((entry): entry is string => Boolean(entry));

      if (trimmed) {
        const normalized = normalizeGoogleChatTarget(trimmed);
        if (!normalized) {
          if ((mode === "implicit" || mode === "heartbeat") && allowList.length > 0) {
            return { ok: true, to: allowList[0] };
          }
          return {
            ok: false,
            error: missingTargetError(
              "Google Chat",
              "<spaces/{space}|users/{user}> or channels.googlechat.dm.allowFrom[0]",
            ),
          };
        }
        return { ok: true, to: normalized };
      }

      if (allowList.length > 0) {
        return { ok: true, to: allowList[0] };
      }
      return {
        ok: false,
        error: missingTargetError(
          "Google Chat",
          "<spaces/{space}|users/{user}> or channels.googlechat.dm.allowFrom[0]",
        ),
      };
    },
    sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
      const account = resolveGoogleChatAccount({
        cfg: cfg as ClawdbotConfig,
        accountId,
      });
      const space = await resolveGoogleChatOutboundSpace({ account, target: to });
      const thread = (threadId ?? replyToId ?? undefined) as string | undefined;
      const result = await sendGoogleChatMessage({
        account,
        space,
        text,
        thread,
      });
      return {
        channel: "googlechat",
        messageId: result?.messageName ?? "",
        chatId: space,
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId, threadId }) => {
      if (!mediaUrl) {
        throw new Error("Google Chat mediaUrl is required.");
      }
      const account = resolveGoogleChatAccount({
        cfg: cfg as ClawdbotConfig,
        accountId,
      });
      const space = await resolveGoogleChatOutboundSpace({ account, target: to });
      const thread = (threadId ?? replyToId ?? undefined) as string | undefined;
      const runtime = getGoogleChatRuntime();
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg: cfg as ClawdbotConfig,
        resolveChannelLimitMb: ({ cfg, accountId }) =>
          (cfg.channels?.["googlechat"] as { accounts?: Record<string, { mediaMaxMb?: number }>; mediaMaxMb?: number } | undefined)
            ?.accounts?.[accountId]?.mediaMaxMb ??
          (cfg.channels?.["googlechat"] as { mediaMaxMb?: number } | undefined)?.mediaMaxMb,
        accountId,
      });
      const loaded = await runtime.channel.media.fetchRemoteMedia(mediaUrl, {
        maxBytes: maxBytes ?? (account.config.mediaMaxMb ?? 20) * 1024 * 1024,
      });
      const upload = await uploadGoogleChatAttachment({
        account,
        space,
        filename: loaded.filename ?? "attachment",
        buffer: loaded.buffer,
        contentType: loaded.contentType,
      });
      const result = await sendGoogleChatMessage({
        account,
        space,
        text,
        thread,
        attachments: upload.attachmentUploadToken
          ? [{ attachmentUploadToken: upload.attachmentUploadToken, contentName: loaded.filename }]
          : undefined,
      });
      return {
        channel: "googlechat",
        messageId: result?.messageName ?? "",
        chatId: space,
      };
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
    collectStatusIssues: (accounts) =>
      accounts.flatMap((entry) => {
        const accountId = String(entry.accountId ?? DEFAULT_ACCOUNT_ID);
        const enabled = entry.enabled !== false;
        const configured = entry.configured === true;
        if (!enabled || !configured) return [];
        const issues = [];
        if (entry.oauthFromGog && entry.userCredentialSource === "none") {
          issues.push({
            channel: "googlechat",
            accountId,
            kind: "auth",
            message:
              "Google Chat OAuth is set to reuse gog, but no gog OAuth credentials were detected.",
            fix: "Ensure gog is installed and the keyring is unlocked (set GOG_KEYRING_PASSWORD), or set oauthRefreshToken/oauthClientFile manually.",
          });
        }
        if (!entry.audience) {
          issues.push({
            channel: "googlechat",
            accountId,
            kind: "config",
            message: "Google Chat audience is missing (set channels.googlechat.audience).",
            fix: "Set channels.googlechat.audienceType and channels.googlechat.audience.",
          });
        }
        if (!entry.audienceType) {
          issues.push({
            channel: "googlechat",
            accountId,
            kind: "config",
            message: "Google Chat audienceType is missing (app-url or project-number).",
            fix: "Set channels.googlechat.audienceType and channels.googlechat.audience.",
          });
        }
        return issues;
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      credentialSource: snapshot.credentialSource ?? "none",
      audienceType: snapshot.audienceType ?? null,
      audience: snapshot.audience ?? null,
      webhookPath: snapshot.webhookPath ?? null,
      webhookUrl: snapshot.webhookUrl ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => probeGoogleChat(account),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.credentialSource !== "none",
      credentialSource: account.credentialSource,
      oauthFromGog: account.config.oauthFromGog ?? false,
      userCredentialSource: account.userCredentialSource,
      audienceType: account.config.audienceType,
      audience: account.config.audience,
      webhookPath: account.config.webhookPath,
      webhookUrl: account.config.webhookUrl,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      dmPolicy: account.config.dm?.policy ?? "pairing",
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info(`[${account.accountId}] starting Google Chat webhook`);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        webhookPath: resolveGoogleChatWebhookPath({ account }),
        audienceType: account.config.audienceType,
        audience: account.config.audience,
      });
      const unregister = await startGoogleChatMonitor({
        account,
        config: ctx.cfg as ClawdbotConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        webhookPath: account.config.webhookPath,
        webhookUrl: account.config.webhookUrl,
        statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });
      return () => {
        unregister?.();
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      };
    },
  },
};

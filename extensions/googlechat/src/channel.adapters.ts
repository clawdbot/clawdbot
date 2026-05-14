import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-message";
import {
  composeAccountWarningCollectors,
  createAllowlistProviderOpenWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import {
  createChannelDirectoryAdapter,
  listResolvedDirectoryGroupEntriesFromMapKeys,
  listResolvedDirectoryUserEntriesFromAllowFrom,
} from "openclaw/plugin-sdk/directory-runtime";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import type { OutboundMediaLoadOptions } from "openclaw/plugin-sdk/outbound-media";
import { sanitizeForPlainText } from "openclaw/plugin-sdk/outbound-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  type ResolvedGoogleChatAccount,
  chunkTextForOutbound,
  readRemoteMediaBuffer,
  isGoogleChatUserTarget,
  loadOutboundMediaFromUrl,
  missingTargetError,
  normalizeGoogleChatTarget,
  PAIRING_APPROVED_MESSAGE,
  resolveChannelMediaMaxBytes,
  resolveGoogleChatAccount,
  resolveGoogleChatOutboundSpace,
  type OpenClawConfig,
} from "./channel.deps.runtime.js";
import { resolveGoogleChatGroupRequireMention } from "./group-policy.js";

const loadGoogleChatChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "googleChatChannelRuntime",
);

function createGoogleChatSendReceipt(params: {
  messageId?: string;
  chatId: string;
  kind: MessageReceiptPartKind;
}) {
  const messageId = params.messageId?.trim();
  return createMessageReceiptFromOutboundResults({
    results: messageId
      ? [
          {
            channel: "googlechat",
            messageId,
            chatId: params.chatId,
            conversationId: params.chatId,
          },
        ]
      : [],
    threadId: params.chatId,
    kind: params.kind,
  });
}

export const formatAllowFromEntry = (entry: string) =>
  normalizeLowercaseStringOrEmpty(
    entry
      .trim()
      .replace(/^(googlechat|google-chat|gchat):/i, "")
      .replace(/^user:/i, "")
      .replace(/^users\//i, ""),
  );

const collectGoogleChatGroupPolicyWarnings =
  createAllowlistProviderOpenWarningCollector<ResolvedGoogleChatAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.googlechat !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    buildOpenWarning: {
      surface: "Google Chat spaces",
      openBehavior: "allows any space to trigger (mention-gated)",
      remediation:
        'Set channels.googlechat.groupPolicy="allowlist" and configure channels.googlechat.groups',
    },
  });

const collectGoogleChatSecurityWarnings = composeAccountWarningCollectors<
  ResolvedGoogleChatAccount,
  {
    cfg: OpenClawConfig;
    account: ResolvedGoogleChatAccount;
  }
>(
  collectGoogleChatGroupPolicyWarnings,
  (account) =>
    account.config.dm?.policy === "open" &&
    '- Google Chat DMs are open to anyone. Set channels.googlechat.dm.policy="pairing" or "allowlist".',
);

export const googlechatGroupsAdapter = {
  resolveRequireMention: resolveGoogleChatGroupRequireMention,
};

export const googlechatDirectoryAdapter = createChannelDirectoryAdapter({
  listPeers: async (params) =>
    listResolvedDirectoryUserEntriesFromAllowFrom<ResolvedGoogleChatAccount>({
      ...params,
      resolveAccount: adaptScopedAccountAccessor(resolveGoogleChatAccount),
      resolveAllowFrom: (account) => account.config.dm?.allowFrom,
      normalizeId: (entry) => normalizeGoogleChatTarget(entry) ?? entry,
    }),
  listGroups: async (params) =>
    listResolvedDirectoryGroupEntriesFromMapKeys<ResolvedGoogleChatAccount>({
      ...params,
      resolveAccount: adaptScopedAccountAccessor(resolveGoogleChatAccount),
      resolveGroups: (account) => account.config.groups,
    }),
});

export const googlechatSecurityAdapter = {
  dm: {
    channelKey: "googlechat",
    resolvePolicy: (account: ResolvedGoogleChatAccount) => account.config.dm?.policy,
    resolveAllowFrom: (account: ResolvedGoogleChatAccount) => account.config.dm?.allowFrom,
    allowFromPathSuffix: "dm.",
    normalizeEntry: (raw: string) => formatAllowFromEntry(raw),
  },
  collectWarnings: collectGoogleChatSecurityWarnings,
};

export const googlechatThreadingAdapter = {
  scopedAccountReplyToMode: {
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
      resolveGoogleChatAccount({ cfg, accountId }),
    resolveReplyToMode: (account: ResolvedGoogleChatAccount, _chatType?: string | null) =>
      account.config.replyToMode,
    fallback: "off" as const,
  },
};

export const googlechatPairingTextAdapter = {
  idLabel: "googlechatUserId",
  message: PAIRING_APPROVED_MESSAGE,
  normalizeAllowEntry: (entry: string) => formatAllowFromEntry(entry),
  notify: async ({
    cfg,
    id,
    message,
    accountId,
  }: {
    cfg: OpenClawConfig;
    id: string;
    message: string;
    accountId?: string | null;
  }) => {
    const account = resolveGoogleChatAccount({ cfg: cfg, accountId });
    if (account.credentialSource === "none") {
      return;
    }
    const user = normalizeGoogleChatTarget(id) ?? id;
    const target = isGoogleChatUserTarget(user) ? user : `users/${user}`;
    const space = await resolveGoogleChatOutboundSpace({ account, target });
    const { sendGoogleChatMessage } = await loadGoogleChatChannelRuntime();
    await sendGoogleChatMessage({
      account,
      space,
      text: message,
    });
  },
};

export const googlechatOutboundAdapter = {
  base: {
    deliveryMode: "direct" as const,
    chunker: chunkTextForOutbound,
    chunkerMode: "markdown" as const,
    textChunkLimit: 4000,
    sanitizeText: ({ text }: { text: string }) => sanitizeForPlainText(text),
    resolveTarget: ({ to }: { to?: string }) => {
      const trimmed = normalizeOptionalString(to) ?? "";

      if (trimmed) {
        const normalized = normalizeGoogleChatTarget(trimmed);
        if (!normalized) {
          return {
            ok: false as const,
            error: missingTargetError("Google Chat", "<spaces/{space}|users/{user}>"),
          };
        }
        return { ok: true as const, to: normalized };
      }

      return {
        ok: false as const,
        error: missingTargetError("Google Chat", "<spaces/{space}|users/{user}>"),
      };
    },
  },
  attachedResults: {
    channel: "googlechat" as const,
    sendText: async ({
      cfg,
      to,
      text,
      accountId,
      replyToId,
      threadId,
    }: {
      cfg: OpenClawConfig;
      to: string;
      text: string;
      accountId?: string | null;
      replyToId?: string | null;
      threadId?: string | number | null;
    }) => {
      const account = resolveGoogleChatAccount({
        cfg: cfg,
        accountId,
      });
      const space = await resolveGoogleChatOutboundSpace({ account, target: to });
      const thread =
        typeof threadId === "number" ? String(threadId) : (threadId ?? replyToId ?? undefined);
      const { sendGoogleChatMessage } = await loadGoogleChatChannelRuntime();
      const result = await sendGoogleChatMessage({
        account,
        space,
        text,
        thread,
      });
      const messageId = result?.messageName ?? "";
      return {
        messageId,
        chatId: space,
        receipt: createGoogleChatSendReceipt({ messageId, chatId: space, kind: "text" }),
      };
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      replyToId,
      threadId,
    }: {
      cfg: OpenClawConfig;
      to: string;
      text?: string;
      mediaUrl?: string;
      mediaAccess?: OutboundMediaLoadOptions["mediaAccess"];
      mediaLocalRoots?: OutboundMediaLoadOptions["mediaLocalRoots"];
      mediaReadFile?: OutboundMediaLoadOptions["mediaReadFile"];
      accountId?: string | null;
      replyToId?: string | null;
      threadId?: string | number | null;
    }) => {
      if (!mediaUrl) {
        throw new Error("Google Chat mediaUrl is required.");
      }
      const account = resolveGoogleChatAccount({
        cfg: cfg,
        accountId,
      });
      const space = await resolveGoogleChatOutboundSpace({ account, target: to });
      const thread =
        typeof threadId === "number" ? String(threadId) : (threadId ?? replyToId ?? undefined);
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg: cfg,
        resolveChannelLimitMb: ({ cfg, accountId }) =>
          (
            cfg.channels?.googlechat as
              | { accounts?: Record<string, { mediaMaxMb?: number }>; mediaMaxMb?: number }
              | undefined
          )?.accounts?.[accountId]?.mediaMaxMb ??
          (cfg.channels?.googlechat as { mediaMaxMb?: number } | undefined)?.mediaMaxMb,
        accountId,
      });
      const effectiveMaxBytes = maxBytes ?? (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
      const loaded = /^https?:\/\//i.test(mediaUrl)
        ? await readRemoteMediaBuffer({
            url: mediaUrl,
            maxBytes: effectiveMaxBytes,
          })
        : await loadOutboundMediaFromUrl(mediaUrl, {
            maxBytes: effectiveMaxBytes,
            mediaAccess,
            mediaLocalRoots,
            mediaReadFile,
          });
      const { sendGoogleChatMessage, uploadGoogleChatAttachment } =
        await loadGoogleChatChannelRuntime();
      const upload = await uploadGoogleChatAttachment({
        account,
        space,
        filename: loaded.fileName ?? "attachment",
        buffer: loaded.buffer,
        contentType: loaded.contentType,
      });
      const result = await sendGoogleChatMessage({
        account,
        space,
        text,
        thread,
        attachments: upload.attachmentUploadToken
          ? [
              {
                attachmentUploadToken: upload.attachmentUploadToken,
                contentName: loaded.fileName,
              },
            ]
          : undefined,
      });
      const messageId = result?.messageName ?? "";
      return {
        messageId,
        chatId: space,
        receipt: createGoogleChatSendReceipt({ messageId, chatId: space, kind: "media" }),
      };
    },
  },
};

export const googlechatMessageAdapter = defineChannelMessageAdapter({
  id: "googlechat",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: googlechatOutboundAdapter.attachedResults.sendText,
    media: googlechatOutboundAdapter.attachedResults.sendMedia,
  },
});

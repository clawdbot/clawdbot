// Googlechat plugin module implements channel.adapters behavior.
import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import type {
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
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
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { shouldSuppressGoogleChatManualExecApprovalFollowupPayload } from "./approval-card-actions.js";
import { formatGoogleChatAllowFromEntry } from "./channel-base.js";
import {
  type ResolvedGoogleChatAccount,
  isGoogleChatUserTarget,
  missingTargetError,
  normalizeGoogleChatTarget,
  PAIRING_APPROVED_MESSAGE,
  resolveGoogleChatAccount,
  resolveGoogleChatOutboundSpace,
  type OpenClawConfig,
} from "./channel.deps.runtime.js";
import {
  formatGoogleChatTextChunks,
  GOOGLE_CHAT_FORMAT_PROFILE,
  sanitizeGoogleChatText,
} from "./format.js";
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
    account.config.dmPolicy === "open" &&
    '- Google Chat DMs are open to anyone. Set channels.googlechat.dmPolicy="pairing" or "allowlist".',
);

export const googlechatGroupsAdapter = {
  resolveRequireMention: resolveGoogleChatGroupRequireMention,
};

export const googlechatDirectoryAdapter = createChannelDirectoryAdapter({
  listPeers: async (params) =>
    listResolvedDirectoryUserEntriesFromAllowFrom<ResolvedGoogleChatAccount>({
      ...params,
      resolveAccount: adaptScopedAccountAccessor(resolveGoogleChatAccount),
      resolveAllowFrom: (account) => account.config.allowFrom,
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
    resolvePolicy: (account: ResolvedGoogleChatAccount) => account.config.dmPolicy,
    resolveAllowFrom: (account: ResolvedGoogleChatAccount) => account.config.allowFrom,
    allowFromPathSuffix: "",
    normalizeEntry: (raw: string) => formatGoogleChatAllowFromEntry(raw),
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
  buildToolContext: ({
    cfg,
    accountId,
    context,
    hasRepliedRef,
  }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    context: ChannelThreadingContext;
    hasRepliedRef?: { value: boolean };
  }): ChannelThreadingToolContext => {
    const currentChannelId = normalizeGoogleChatTarget(context.To);
    const replyToId =
      normalizeOptionalString(context.ReplyToIdFull) ?? normalizeOptionalString(context.ReplyToId);

    return {
      currentChannelId,
      currentMessageId: replyToId,
      currentThreadTs: replyToId,
      replyToMode: resolveGoogleChatAccount({ cfg, accountId }).config.replyToMode,
      hasRepliedRef,
    };
  },
};

export const googlechatPairingTextAdapter = {
  idLabel: "googlechatUserId",
  message: PAIRING_APPROVED_MESSAGE,
  normalizeAllowEntry: (entry: string) => formatGoogleChatAllowFromEntry(entry),
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
    const account = resolveGoogleChatAccount({ cfg, accountId });
    if (account.credentialSource === "none" || account.tokenStatus === "configured_unavailable") {
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
    chunker: (text: string, limit: number) => formatGoogleChatTextChunks(text, limit),
    chunkerMode: "markdown" as const,
    textChunkLimit: GOOGLE_CHAT_FORMAT_PROFILE.chunk.limit,
    sanitizeText: ({ text }: { text: string }) => sanitizeGoogleChatText(text),
    normalizePayload: ({ payload }: { payload: ReplyPayload }) =>
      shouldSuppressGoogleChatManualExecApprovalFollowupPayload(payload) ? null : payload,
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
        cfg,
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
  },
};

export const googlechatMessageAdapter = defineChannelMessageAdapter({
  id: "googlechat",
  durableFinal: {
    capabilities: {
      text: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: googlechatOutboundAdapter.attachedResults.sendText,
  },
});

// Zalouser plugin module implements channel.adapters behavior.
import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import {
  defineChannelMessageAdapter,
  type ChannelMessageSendResult,
} from "openclaw/plugin-sdk/channel-outbound";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import {
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
} from "openclaw/plugin-sdk/channel-policy";
import {
  createEmptyChannelResult,
  type ChannelOutboundAdapter,
  type OutboundDeliveryResult,
} from "openclaw/plugin-sdk/channel-send-result";
import { createStaticReplyToModeResolver } from "openclaw/plugin-sdk/conversation-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  checkZcaAuthenticated,
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
  type ResolvedZalouserAccount,
} from "./accounts.js";
import type {
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  GroupToolPolicyConfig,
  OpenClawConfig,
} from "./channel-api.js";
import {
  DEFAULT_ACCOUNT_ID,
  chunkTextForOutbound,
  isDangerousNameMatchingEnabled,
  isNumericTargetId,
  normalizeAccountId,
  sendPayloadWithChunkedTextAndMedia,
} from "./channel-api.js";
import { buildZalouserGroupCandidates, resolveZalouserGroupScope } from "./group-policy.js";
import { resolveZalouserReactionMessageIds } from "./message-sid.js";
import { writeQrDataUrlToTempFile } from "./qr-temp-file.js";
import { getZalouserRuntime } from "./runtime.js";
import {
  normalizeZalouserTarget,
  parseZalouserOutboundTarget,
  resolveZalouserOutboundSessionRoute,
} from "./session-route.js";
import type { ZaloSendResult } from "./types.js";

const loadZalouserChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));

const ZALOUSER_TEXT_CHUNK_LIMIT = 2000;

type ZalouserSendTextContext = {
  to: string;
  text: string;
  accountId?: string | null;
  cfg: OpenClawConfig;
  onDeliveryResult?: (result: ChannelMessageSendResult) => Promise<void> | void;
};

type ZalouserSendMediaContext = ZalouserSendTextContext & {
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
};

export function resolveZalouserQrProfile(accountId?: string | null): string {
  const normalized = normalizeAccountId(accountId);
  if (!normalized || normalized === DEFAULT_ACCOUNT_ID) {
    return process.env.ZALOUSER_PROFILE?.trim() || process.env.ZCA_PROFILE?.trim() || "default";
  }
  return normalized;
}

function resolveZalouserOutboundChunkMode(cfg: OpenClawConfig, accountId?: string) {
  return getZalouserRuntime().channel.text.resolveChunkMode(cfg, "zalouser", accountId);
}

function resolveZalouserOutboundTextChunkLimit(cfg: OpenClawConfig, accountId?: string) {
  return getZalouserRuntime().channel.text.resolveTextChunkLimit(cfg, "zalouser", accountId, {
    fallbackLimit: ZALOUSER_TEXT_CHUNK_LIMIT,
  });
}

function toZalouserMessageSendResult(result: ZaloSendResult): ChannelMessageSendResult {
  return {
    messageId: result.messageId,
    receipt: result.receipt,
  };
}

function resolveZalouserGroupPolicyScope(params: ChannelGroupContext) {
  const account = resolveZalouserAccountSync({
    cfg: params.cfg,
    accountId: params.accountId ?? undefined,
  });
  return resolveZalouserGroupScope(
    account.config.groups,
    buildZalouserGroupCandidates({
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      // The adapter falls back to the "*" entry when no candidate matches.
      allowNameMatching: isDangerousNameMatchingEnabled(account.config),
    }),
  );
}

function resolveZalouserGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  return resolveScopeToolsPolicy(resolveZalouserGroupPolicyScope(params));
}

function resolveZalouserRequireMention(params: ChannelGroupContext): boolean {
  return resolveScopeRequireMention(resolveZalouserGroupPolicyScope(params));
}

async function sendZalouserTextFromContext({
  to,
  text,
  accountId,
  cfg,
  onDeliveryResult,
}: ZalouserSendTextContext) {
  const { sendMessageZalouser } = await loadZalouserChannelRuntime();
  const account = resolveZalouserAccountSync({ cfg, accountId });
  const target = parseZalouserOutboundTarget(to);
  const result = await sendMessageZalouser(target.threadId, text, {
    profile: account.profile,
    isGroup: target.isGroup,
    textMode: "markdown",
    textChunkMode: resolveZalouserOutboundChunkMode(cfg, account.accountId),
    textChunkLimit: resolveZalouserOutboundTextChunkLimit(cfg, account.accountId),
    onDeliveryResult: async (progress) => {
      await onDeliveryResult?.(toZalouserMessageSendResult(progress));
    },
  });
  return toZalouserMessageSendResult(result);
}

async function sendZalouserMediaFromContext({
  to,
  text,
  mediaUrl,
  accountId,
  cfg,
  mediaLocalRoots,
  mediaReadFile,
  onDeliveryResult,
}: ZalouserSendMediaContext) {
  const { sendMessageZalouser } = await loadZalouserChannelRuntime();
  const account = resolveZalouserAccountSync({ cfg, accountId });
  const target = parseZalouserOutboundTarget(to);
  const result = await sendMessageZalouser(target.threadId, text, {
    profile: account.profile,
    isGroup: target.isGroup,
    mediaUrl,
    mediaLocalRoots,
    mediaReadFile,
    textMode: "markdown",
    textChunkMode: resolveZalouserOutboundChunkMode(cfg, account.accountId),
    textChunkLimit: resolveZalouserOutboundTextChunkLimit(cfg, account.accountId),
    onDeliveryResult: async (progress) => {
      await onDeliveryResult?.(toZalouserMessageSendResult(progress));
    },
  });
  return toZalouserMessageSendResult(result);
}

function adaptZalouserOutboundProgress(
  onDeliveryResult: ((result: OutboundDeliveryResult) => Promise<void> | void) | undefined,
) {
  return onDeliveryResult
    ? async (result: ChannelMessageSendResult) => {
        await onDeliveryResult(toZalouserOutboundDeliveryResult(result));
      }
    : undefined;
}

function toZalouserOutboundDeliveryResult(
  result: ChannelMessageSendResult,
): OutboundDeliveryResult {
  return createEmptyChannelResult("zalouser", {
    messageId:
      result.messageId ??
      result.receipt.primaryPlatformMessageId ??
      result.receipt.platformMessageIds[0],
    receipt: result.receipt,
  });
}

const zalouserRawSendResultAdapter: Pick<ChannelOutboundAdapter, "sendText" | "sendMedia"> = {
  sendText: async ({ onDeliveryResult, ...ctx }) =>
    toZalouserOutboundDeliveryResult(
      await sendZalouserTextFromContext({
        ...ctx,
        onDeliveryResult: adaptZalouserOutboundProgress(onDeliveryResult),
      }),
    ),
  sendMedia: async ({ onDeliveryResult, ...ctx }) =>
    toZalouserOutboundDeliveryResult(
      await sendZalouserMediaFromContext({
        ...ctx,
        onDeliveryResult: adaptZalouserOutboundProgress(onDeliveryResult),
      }),
    ),
};

export const zalouserMessageAdapter = defineChannelMessageAdapter({
  id: "zalouser",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: sendZalouserTextFromContext,
    media: sendZalouserMediaFromContext,
  },
});

const resolveZalouserDmPolicy = createScopedDmSecurityResolver<ResolvedZalouserAccount>({
  channelKey: "zalouser",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => raw.trim().replace(/^(zalouser|zlu):/i, ""),
});

export const zalouserGroupsAdapter = {
  resolveRequireMention: resolveZalouserRequireMention,
  resolveToolPolicy: resolveZalouserGroupToolPolicy,
};

export const zalouserMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    const accounts = accountId
      ? [resolveZalouserAccountSync({ cfg, accountId })].filter((account) => account.enabled)
      : listZalouserAccountIds(cfg)
          .map((resolvedAccountId) =>
            resolveZalouserAccountSync({ cfg, accountId: resolvedAccountId }),
          )
          .filter((account) => account.enabled);
    if (accounts.length === 0) {
      return null;
    }
    return { actions: ["react"] };
  },
  supportsAction: ({ action }) => action === "react",
  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    if (action !== "react") {
      throw new Error(`Zalouser action ${action} not supported`);
    }
    const { sendReactionZalouser } = await loadZalouserChannelRuntime();
    const account = resolveZalouserAccountSync({ cfg, accountId });
    const threadId =
      (typeof params.threadId === "string" ? params.threadId.trim() : "") ||
      (typeof params.to === "string" ? params.to.trim() : "") ||
      (typeof params.chatId === "string" ? params.chatId.trim() : "") ||
      (toolContext?.currentChannelId?.trim() ?? "");
    if (!threadId) {
      throw new Error("Zalouser react requires threadId (or to/chatId).");
    }
    const emoji = typeof params.emoji === "string" ? params.emoji.trim() : "";
    if (!emoji) {
      throw new Error("Zalouser react requires emoji.");
    }
    const ids = resolveZalouserReactionMessageIds({
      messageId: typeof params.messageId === "string" ? params.messageId : undefined,
      cliMsgId: typeof params.cliMsgId === "string" ? params.cliMsgId : undefined,
      currentMessageId: toolContext?.currentMessageId,
    });
    if (!ids) {
      throw new Error(
        "Zalouser react requires messageId + cliMsgId (or a current message context id).",
      );
    }
    const result = await sendReactionZalouser({
      profile: account.profile,
      threadId,
      isGroup: params.isGroup === true,
      msgId: ids.msgId,
      cliMsgId: ids.cliMsgId,
      emoji,
      remove: params.remove === true,
    });
    if (!result.ok) {
      throw new Error(result.error || "Failed to react on Zalo message");
    }
    return {
      content: [
        {
          type: "text" as const,
          text:
            params.remove === true
              ? `Removed reaction ${emoji} from ${ids.msgId}`
              : `Reacted ${emoji} on ${ids.msgId}`,
        },
      ],
      details: {
        messageId: ids.msgId,
        cliMsgId: ids.cliMsgId,
        threadId,
      },
    };
  },
};

export const zalouserResolverAdapter = {
  resolveTargets: async ({
    cfg,
    accountId,
    inputs,
    kind,
    runtime,
  }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    inputs: string[];
    kind: "user" | "group";
    runtime: RuntimeEnv;
  }) => {
    const results = [];
    for (const input of inputs) {
      const trimmed = input.trim();
      if (!trimmed) {
        results.push({ input, resolved: false, note: "empty input" });
        continue;
      }
      if (/^\d+$/.test(trimmed)) {
        results.push({ input, resolved: true, id: trimmed });
        continue;
      }
      try {
        const runtimeModule = await loadZalouserChannelRuntime();
        const account = resolveZalouserAccountSync({
          cfg,
          accountId: accountId ?? resolveDefaultZalouserAccountId(cfg),
        });
        if (kind === "user") {
          const friends = await runtimeModule.listZaloFriendsMatching(account.profile, trimmed);
          const best = friends[0];
          results.push({
            input,
            resolved: Boolean(best?.userId),
            id: best?.userId,
            name: best?.displayName,
            note: friends.length > 1 ? "multiple matches; chose first" : undefined,
          });
        } else {
          const groups = await runtimeModule.listZaloGroupsMatching(account.profile, trimmed);
          const best =
            groups.find(
              (group) =>
                normalizeLowercaseStringOrEmpty(group.name) ===
                normalizeLowercaseStringOrEmpty(trimmed),
            ) ?? groups[0];
          results.push({
            input,
            resolved: Boolean(best?.groupId),
            id: best?.groupId,
            name: best?.name,
            note: groups.length > 1 ? "multiple matches; chose first" : undefined,
          });
        }
      } catch (err) {
        runtime.error?.(`zalouser resolve failed: ${String(err)}`);
        results.push({ input, resolved: false, note: "lookup failed" });
      }
    }
    return results;
  },
};

export const zalouserAuthAdapter = {
  login: async ({
    cfg,
    accountId,
    runtime,
  }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    runtime: RuntimeEnv;
  }) => {
    const { startZaloQrLogin, waitForZaloQrLogin } = await loadZalouserChannelRuntime();
    const account = resolveZalouserAccountSync({
      cfg,
      accountId: accountId ?? resolveDefaultZalouserAccountId(cfg),
    });

    runtime.log(
      `Generating QR login for Zalo Personal (account: ${account.accountId}, profile: ${account.profile})...`,
    );

    const started = await startZaloQrLogin({
      profile: account.profile,
      timeoutMs: 35_000,
    });
    if (!started.qrDataUrl) {
      throw new Error(started.message || "Failed to start QR login");
    }

    const qrPath = await writeQrDataUrlToTempFile(started.qrDataUrl, account.profile);
    if (qrPath) {
      runtime.log(`Scan QR image: ${qrPath}`);
    } else {
      runtime.log("QR generated but could not be written to a temp file.");
    }

    const waited = await waitForZaloQrLogin({ profile: account.profile, timeoutMs: 180_000 });
    if (!waited.connected) {
      throw new Error(waited.message || "Zalouser login failed");
    }

    runtime.log(waited.message);
  },
};

export const zalouserSecurityAdapter = {
  resolveDmPolicy: resolveZalouserDmPolicy,
  collectAuditFindings: async (params: {
    accountId?: string | null;
    account: ResolvedZalouserAccount;
    orderedAccountIds: string[];
    hasExplicitAccountPath: boolean;
  }) => (await loadZalouserChannelRuntime()).collectZalouserSecurityAuditFindings(params),
};

export const zalouserThreadingAdapter = {
  resolveReplyToMode: createStaticReplyToModeResolver("off"),
};

export const zalouserPairingTextAdapter = {
  idLabel: "zalouserUserId",
  message: "Your pairing request has been approved.",
  normalizeAllowEntry: createPairingPrefixStripper(/^(zalouser|zlu):/i),
  notify: async ({ cfg, id, message }: { cfg: OpenClawConfig; id: string; message: string }) => {
    const { sendMessageZalouser } = await loadZalouserChannelRuntime();
    const account = resolveZalouserAccountSync({ cfg });
    const authenticated = await checkZcaAuthenticated(account.profile);
    if (!authenticated) {
      throw new Error("Zalouser not authenticated");
    }
    await sendMessageZalouser(id, message, {
      profile: account.profile,
    });
  },
};

export const zalouserOutboundAdapter = {
  deliveryMode: "direct" as const,
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown" as const,
  sendPayload: async (
    ctx: { payload: object } & Parameters<
      NonNullable<typeof zalouserRawSendResultAdapter.sendText>
    >[0],
  ) =>
    await sendPayloadWithChunkedTextAndMedia({
      ctx,
      sendText: (nextCtx) => zalouserRawSendResultAdapter.sendText!(nextCtx),
      sendMedia: (nextCtx) => zalouserRawSendResultAdapter.sendMedia!(nextCtx),
      emptyResult: createEmptyChannelResult("zalouser"),
    }),
  ...zalouserRawSendResultAdapter,
};

export const zalouserMessagingAdapter = {
  targetPrefixes: ["zalouser", "zlu"],
  normalizeTarget: (raw: string) => normalizeZalouserTarget(raw),
  resolveOutboundSessionRoute: (
    params: Parameters<typeof resolveZalouserOutboundSessionRoute>[0],
  ) => resolveZalouserOutboundSessionRoute(params),
  targetResolver: {
    looksLikeId: (raw: string) => {
      const normalized = normalizeZalouserTarget(raw);
      if (!normalized) {
        return false;
      }
      if (/^group:[^\s]+$/i.test(normalized) || /^user:[^\s]+$/i.test(normalized)) {
        return true;
      }
      return isNumericTargetId(normalized);
    },
    hint: "<user:id|group:id>",
  },
};

/** Extracts message delivery evidence from embedded-agent tool calls and results. */
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import type { ChannelMessageActionName } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeTargetForProvider } from "../infra/outbound/target-normalization.js";
import {
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
} from "../interactive/payload.js";
import { isMessagingToolTargetEvidenceAction } from "./embedded-agent-messaging.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "./embedded-agent-messaging.types.js";
import { readToolResultDetails } from "./tool-result-error.js";

export function extractMessagingToolSourceReplyPayload(
  result: unknown,
): MessagingToolSourceReplyPayload | undefined {
  const details = readToolResultDetails(result);
  if (!details || details.sourceReplySink !== "internal-ui") {
    return undefined;
  }
  const status = normalizeOptionalLowercaseString(details.deliveryStatus);
  if (status && status !== "sent") {
    return undefined;
  }
  const sourceReply = readRecord(details.sourceReply) ?? details;
  const payload: MessagingToolSourceReplyPayload = {};
  const text = readStringValue(sourceReply.text) ?? readStringValue(details.message);
  if (text) {
    payload.text = text;
  }
  const mediaUrl = readStringValue(sourceReply.mediaUrl) ?? readStringValue(details.mediaUrl);
  if (mediaUrl) {
    payload.mediaUrl = mediaUrl;
  }
  const rawMediaUrls = Array.isArray(sourceReply.mediaUrls)
    ? sourceReply.mediaUrls
    : Array.isArray(details.mediaUrls)
      ? details.mediaUrls
      : [];
  const mediaUrls = uniqueStrings(
    rawMediaUrls.filter((value): value is string => typeof value === "string"),
  );
  if (mediaUrls.length > 0) {
    payload.mediaUrls = mediaUrls;
  }
  if (sourceReply.audioAsVoice === true || details.audioAsVoice === true) {
    payload.audioAsVoice = true;
  }
  const presentation = normalizeMessagePresentation(sourceReply.presentation);
  if (presentation) {
    payload.presentation = presentation;
  }
  const interactive = normalizeLegacyInteractiveReply(sourceReply.interactive);
  if (interactive) {
    payload.interactive = interactive;
  }
  const channelData = readRecord(sourceReply.channelData);
  if (channelData) {
    payload.channelData = { ...channelData };
  }
  const idempotencyKey =
    readStringValue(sourceReply.idempotencyKey) ?? readStringValue(details.idempotencyKey);
  if (idempotencyKey) {
    payload.idempotencyKey = idempotencyKey;
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

// Core tool names that are allowed to emit trusted local media artifacts.
// Plugin tools must be explicitly passed as trusted run-local names by the caller.

function resolveMessageToolTarget(params: {
  action: string;
  args: Record<string, unknown>;
  providerId: string | null;
  currentChannelId?: string;
  currentMessagingTarget?: string;
}): string | undefined {
  const directTarget =
    normalizeOptionalString(params.args.target) ??
    normalizeOptionalString(params.args.to) ??
    normalizeOptionalString(params.args.channelId);
  if (directTarget) {
    return directTarget;
  }
  const aliases = params.providerId
    ? getChannelPlugin(params.providerId)?.actions?.messageActionTargetAliases?.[
        params.action as ChannelMessageActionName
      ]?.deliveryTargetAliases
    : undefined;
  for (const alias of aliases ?? []) {
    const aliasTarget = normalizeOptionalStringifiedId(params.args[alias]);
    if (aliasTarget) {
      return aliasTarget;
    }
  }
  return params.currentMessagingTarget ?? params.currentChannelId;
}

function resolveMessagingToolThreadEvidence(params: {
  providerId: string;
  to: string;
  accountId?: string;
  threadId?: string;
  replyToId?: string;
  allowImplicitThread: boolean;
  threadSuppressed: boolean;
  options?: {
    config?: OpenClawConfig;
    currentChannelId?: string;
    currentMessagingTarget?: string;
    currentThreadId?: string;
    currentMessageId?: string | number;
    replyToMode?: "off" | "first" | "all" | "batched";
    hasRepliedRef?: { value: boolean };
  };
}): Pick<MessagingToolSend, "threadId" | "threadImplicit" | "threadSuppressed"> {
  const threading = getChannelPlugin(params.providerId)?.threading;
  const autoThreadResolver = params.allowImplicitThread
    ? threading?.resolveAutoThreadId
    : undefined;
  const replyTransport = params.replyToId
    ? threading?.resolveReplyTransport?.({
        cfg: params.options?.config ?? {},
        accountId: params.accountId,
        threadId: params.threadId,
        replyToId: params.replyToId,
      })
    : undefined;
  const transportThreadId = normalizeOptionalStringifiedId(replyTransport?.threadId);
  const replyToThreadId =
    replyTransport?.threadId === null
      ? normalizeOptionalString(replyTransport.replyToId)
      : undefined;
  const explicitThreadId = transportThreadId ?? replyToThreadId ?? params.threadId;
  const currentChannelId = normalizeOptionalString(params.options?.currentChannelId);
  const currentMessagingTarget = normalizeOptionalString(params.options?.currentMessagingTarget);
  const currentThreadId = normalizeOptionalString(params.options?.currentThreadId);
  const replyToMode = params.options?.replyToMode ?? (currentThreadId ? "all" : undefined);
  const canResolveCurrentThread = Boolean(
    (currentChannelId || currentMessagingTarget) && currentThreadId,
  );
  const resolvedCurrentThreadId =
    !explicitThreadId && !params.threadSuppressed && autoThreadResolver && canResolveCurrentThread
      ? autoThreadResolver({
          cfg: params.options?.config ?? {},
          accountId: params.accountId,
          to: params.to,
          replyToId: params.replyToId,
          toolContext: {
            currentChannelId,
            currentMessagingTarget,
            currentThreadTs: currentThreadId,
            currentMessageId: params.options?.currentMessageId,
            replyToMode,
            hasRepliedRef: params.options?.hasRepliedRef,
          },
        })
      : undefined;
  const threadImplicit =
    !explicitThreadId &&
    !params.threadSuppressed &&
    Boolean(autoThreadResolver) &&
    (!canResolveCurrentThread || Boolean(resolvedCurrentThreadId));
  return {
    ...((explicitThreadId ?? resolvedCurrentThreadId)
      ? { threadId: explicitThreadId ?? resolvedCurrentThreadId }
      : {}),
    ...(threadImplicit ? { threadImplicit: true } : {}),
    ...(params.threadSuppressed ? { threadSuppressed: true } : {}),
  };
}

export function extractMessagingToolSend(
  toolName: string,
  args: Record<string, unknown>,
  options?: {
    config?: OpenClawConfig;
    currentChannelId?: string;
    currentMessagingTarget?: string;
    currentThreadId?: string;
    currentMessageId?: string | number;
    replyToMode?: "off" | "first" | "all" | "batched";
    hasRepliedRef?: { value: boolean };
  },
): MessagingToolSend | undefined {
  // Provider docking: new provider tools must implement plugin.actions.extractToolSend.
  const action = normalizeOptionalString(args.action) ?? "";
  const accountId = normalizeOptionalString(args.accountId);
  if (toolName === "conversations_send" || toolName === "conversations_turn") {
    const conversationRef = normalizeOptionalString(args.conversationRef);
    return conversationRef
      ? {
          tool: toolName,
          provider: "conversation",
          to: conversationRef,
        }
      : undefined;
  }
  if (toolName === "message") {
    if (!isMessagingToolTargetEvidenceAction(toolName, args)) {
      return undefined;
    }
    const providerRaw = normalizeOptionalString(args.provider) ?? "";
    const channelRaw = normalizeOptionalString(args.channel) ?? "";
    const providerHint = providerRaw || channelRaw;
    const providerId = providerHint ? normalizeChannelId(providerHint) : null;
    const toRaw = resolveMessageToolTarget({
      action,
      args,
      providerId,
      currentChannelId: options?.currentChannelId,
      currentMessagingTarget: options?.currentMessagingTarget,
    });
    if (!toRaw) {
      return undefined;
    }
    const provider = providerId ?? normalizeOptionalLowercaseString(providerHint) ?? "message";
    const to = normalizeTargetForProvider(provider, toRaw);
    const pluginExtractionArgs = { ...args, to: toRaw };
    const pluginExtracted = providerId
      ? getChannelPlugin(providerId)?.actions?.extractToolSend?.({ args: pluginExtractionArgs })
      : null;
    const resolvedAccountId = normalizeOptionalString(pluginExtracted?.accountId) ?? accountId;
    const threadId =
      normalizeOptionalString(pluginExtracted?.threadId) ?? normalizeOptionalString(args.threadId);
    const replyToId = normalizeOptionalString(args.replyTo);
    // Normal sends use prepared core delivery, where provider transport owns
    // reply/thread precedence. Other send-like actions use plugin dispatch.
    const outboundReplyToId = action === "send" ? replyToId : undefined;
    const threadSuppressed =
      pluginExtracted?.threadSuppressed === true ||
      args.topLevel === true ||
      args.threadId === null;
    return to
      ? {
          tool: toolName,
          provider,
          accountId: resolvedAccountId,
          to,
          ...(providerId
            ? resolveMessagingToolThreadEvidence({
                providerId,
                to,
                accountId: resolvedAccountId,
                threadId,
                replyToId: outboundReplyToId,
                allowImplicitThread: pluginExtracted
                  ? pluginExtracted.threadImplicit === true
                  : true,
                threadSuppressed,
                options,
              })
            : {
                ...(threadId ? { threadId } : {}),
                ...(threadSuppressed ? { threadSuppressed: true } : {}),
              }),
        }
      : undefined;
  }

  const providerId = normalizeChannelId(toolName);
  if (!providerId) {
    return undefined;
  }
  const plugin = getChannelPlugin(providerId);
  const extracted = plugin?.actions?.extractToolSend?.({ args });
  if (!extracted?.to) {
    return undefined;
  }
  const to = normalizeTargetForProvider(providerId, extracted.to);
  const threadId = normalizeOptionalString(extracted.threadId);
  const threadSuppressed = extracted.threadSuppressed === true;
  const extractedAccountId = normalizeOptionalString(extracted.accountId) ?? accountId;
  const nativeReplyToMode = options?.replyToMode;
  const nativeSingleUseMode = nativeReplyToMode === "first" || nativeReplyToMode === "batched";
  const canResolveNativeImplicitThread =
    extracted.threadImplicit === true &&
    nativeReplyToMode !== undefined &&
    (!nativeSingleUseMode || options?.hasRepliedRef !== undefined);
  return to
    ? {
        tool: toolName,
        provider: providerId,
        accountId: extractedAccountId,
        to,
        ...resolveMessagingToolThreadEvidence({
          providerId,
          to,
          accountId: extractedAccountId,
          threadId,
          allowImplicitThread: canResolveNativeImplicitThread,
          threadSuppressed,
          options,
        }),
      }
    : undefined;
}

/** Reconciles pending send evidence with the provider's successful action result. */
export function extractMessagingToolSendResult(
  pending: MessagingToolSend,
  result: unknown,
): MessagingToolSend {
  const providerId = normalizeChannelId(pending.provider);
  const extracted = providerId
    ? getChannelPlugin(providerId)?.actions?.extractToolSendResult?.({
        result,
        send: {
          to: pending.to ?? "",
          accountId: pending.accountId,
          threadId: pending.threadId,
          threadImplicit: pending.threadImplicit,
          threadSuppressed: pending.threadSuppressed,
        },
      })
    : null;
  if (!extracted?.to) {
    return pending;
  }
  const extractedThreadId = normalizeOptionalString(extracted.threadId);
  const providerReportedThread =
    extractedThreadId != null ||
    extracted.threadImplicit === true ||
    extracted.threadSuppressed === true;
  // Thread route fields are one state. Mixing provider and pending values can
  // create contradictory implicit and suppressed evidence.
  const threadEvidence = providerReportedThread ? extracted : pending;
  return {
    ...pending,
    ...extracted,
    accountId: normalizeOptionalString(extracted.accountId) ?? pending.accountId,
    to: normalizeTargetForProvider(providerId ?? pending.provider, extracted.to),
    threadId: normalizeOptionalString(threadEvidence.threadId),
    threadImplicit: threadEvidence.threadImplicit === true ? true : undefined,
    threadSuppressed: threadEvidence.threadSuppressed === true ? true : undefined,
  };
}

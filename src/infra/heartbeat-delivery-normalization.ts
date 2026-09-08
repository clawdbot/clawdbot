import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { replaceGenericExternalRunFailureText } from "../agents/failover/user-copy.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "../agents/stream-message-shared.js";
import type { HeartbeatTerminalToolFailure } from "../auto-reply/heartbeat-reply-payload.js";
import {
  getHeartbeatToolNotificationText,
  type HeartbeatToolResponse,
} from "../auto-reply/heartbeat-tool-response.js";
import { stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { isSilentReplyPayloadText } from "../auto-reply/tokens.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { escapeRegExp } from "../utils.js";
import { truncateHeartbeatPreview } from "./heartbeat-runner-prompt.js";

export type NormalizedHeartbeatDelivery = {
  shouldSkip: boolean;
  text: string;
  hasMedia: boolean;
  isInternalPlaceholderOnly: boolean;
  silent?: boolean;
};

function stripLeadingHeartbeatResponsePrefix(
  text: string,
  responsePrefix: string | undefined,
): string {
  const normalizedPrefix = responsePrefix?.trim();
  if (!normalizedPrefix) {
    return text;
  }
  const prefixPattern = new RegExp(
    `^${escapeRegExp(normalizedPrefix)}(?=$|\\s|[\\p{P}\\p{S}])\\s*`,
    "iu",
  );
  return text.replace(prefixPattern, "");
}

function isStreamErrorFallbackPlaceholderOnly(text: string): boolean {
  let remaining = text.trim();
  if (!remaining) {
    return false;
  }
  while (remaining.startsWith(STREAM_ERROR_FALLBACK_TEXT)) {
    remaining = remaining.slice(STREAM_ERROR_FALLBACK_TEXT.length).trimStart();
  }
  return remaining.length === 0;
}

const TRAILING_HEARTBEAT_NOTIFY_FALSE_RE = /(?:^|[\r\n])[ \t]*notify=false[ \t]*(?:\r?\n[ \t]*)*$/i;

function stripTrailingHeartbeatNotifyFalse(text: string): {
  text: string;
  silent: boolean;
} {
  const match = TRAILING_HEARTBEAT_NOTIFY_FALSE_RE.exec(text);
  return match
    ? { text: text.slice(0, match.index).trimEnd(), silent: true }
    : { text, silent: false };
}

function normalizeHeartbeatReply(
  payload: ReplyPayload,
  responsePrefix: string | undefined,
  ackMaxChars: number,
  mode: "heartbeat" | "message" = "heartbeat",
): NormalizedHeartbeatDelivery {
  const rawText = typeof payload.text === "string" ? payload.text : "";
  const textForStrip = stripLeadingHeartbeatResponsePrefix(rawText, responsePrefix);
  const isSilentReply = isSilentReplyPayloadText(textForStrip);
  const stripped = stripHeartbeatToken(isSilentReply ? "" : textForStrip, {
    mode,
    maxAckChars: ackMaxChars,
  });
  const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
  const notifyFalse = stripTrailingHeartbeatNotifyFalse(stripped.text);
  notifyFalse.silent ||= isSilentReply;
  const isInternalPlaceholderOnly = isStreamErrorFallbackPlaceholderOnly(notifyFalse.text);
  if ((stripped.shouldSkip || isInternalPlaceholderOnly) && !hasMedia) {
    return {
      shouldSkip: true,
      text: "",
      hasMedia,
      isInternalPlaceholderOnly,
      ...(notifyFalse.silent ? { silent: true } : {}),
    };
  }
  let finalText = isInternalPlaceholderOnly ? "" : notifyFalse.text;
  if (responsePrefix && finalText && !finalText.startsWith(responsePrefix)) {
    finalText = `${responsePrefix} ${finalText}`;
  }
  return {
    shouldSkip: !hasMedia && finalText.trim().length === 0,
    text: finalText,
    hasMedia,
    isInternalPlaceholderOnly,
    ...(notifyFalse.silent ? { silent: true } : {}),
  };
}

function normalizeHeartbeatToolNotification(
  response: HeartbeatToolResponse,
  responsePrefix: string | undefined,
): NormalizedHeartbeatDelivery {
  let finalText = getHeartbeatToolNotificationText(response);
  if (responsePrefix && finalText && !finalText.startsWith(responsePrefix)) {
    finalText = `${responsePrefix} ${finalText}`;
  }
  return {
    shouldSkip: finalText.trim().length === 0,
    text: finalText,
    hasMedia: false,
    isInternalPlaceholderOnly: false,
    ...(response.notify ? {} : { silent: true }),
  };
}

export function classifyHeartbeatAgentOutcome(params: {
  agentRun: {
    agentRunFailed: boolean;
    heartbeatToolResponse?: HeartbeatToolResponse;
    heartbeatTerminalToolFailure?: HeartbeatTerminalToolFailure;
    replyPayload?: ReplyPayload;
  };
  hasRelayableExecCompletion: boolean;
  suppressUnmarkedSourceReplies: boolean;
  responsePrefix: string | undefined;
  ackMaxChars: number;
}) {
  const { agentRunFailed, heartbeatToolResponse, heartbeatTerminalToolFailure, replyPayload } =
    params.agentRun;
  const replyMetadata = replyPayload ? getReplyPayloadMetadata(replyPayload) : undefined;
  const hasExplicitFailure = Boolean(heartbeatTerminalToolFailure || agentRunFailed);
  const shouldSuppressSourceReply =
    params.suppressUnmarkedSourceReplies &&
    !params.hasRelayableExecCompletion &&
    replyPayload &&
    replyPayload.isError !== true &&
    replyMetadata?.deliverDespiteSourceReplySuppression !== true &&
    ((!hasExplicitFailure && !heartbeatToolResponse) ||
      (agentRunFailed && !heartbeatTerminalToolFailure));
  if (heartbeatToolResponse && !heartbeatToolResponse.notify && !hasExplicitFailure) {
    return {
      kind: "ack",
      eventStatus: "ok-token",
      preview: truncateHeartbeatPreview(heartbeatToolResponse.summary),
      response: heartbeatToolResponse,
    } as const;
  }
  if (shouldSuppressSourceReply && !hasExplicitFailure) {
    // Message-tool privacy never makes an ordinary assistant final outbound;
    // marked operator notices and terminal failures keep their visible paths.
    return { kind: "ack", eventStatus: "ok-token", silent: true } as const;
  }
  if (
    !heartbeatToolResponse &&
    !hasExplicitFailure &&
    (!replyPayload || !hasOutboundReplyContent(replyPayload))
  ) {
    return { kind: "ack", eventStatus: "ok-empty" } as const;
  }
  const mode = params.hasRelayableExecCompletion ? "message" : "heartbeat";
  const normalized =
    heartbeatToolResponse && !shouldSuppressSourceReply && !(hasExplicitFailure && replyPayload)
      ? normalizeHeartbeatToolNotification(heartbeatToolResponse, params.responsePrefix)
      : normalizeHeartbeatReply(
          shouldSuppressSourceReply ? {} : (replyPayload ?? {}),
          params.responsePrefix,
          params.ackMaxChars,
          mode,
        );
  if (agentRunFailed) {
    const replacement = replaceGenericExternalRunFailureText(normalized.text);
    if (replacement.replaced) {
      normalized.text = replacement.text;
      normalized.shouldSkip = false;
    }
  }
  const hasStructuredReplyContent =
    !shouldSuppressSourceReply &&
    (!heartbeatToolResponse || agentRunFailed) &&
    replyPayload !== undefined &&
    hasOutboundReplyContent({
      ...replyPayload,
      text: undefined,
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
  const shouldSkipMain =
    normalized.shouldSkip &&
    !normalized.hasMedia &&
    (!hasStructuredReplyContent || normalized.isInternalPlaceholderOnly);
  if (hasExplicitFailure) {
    return {
      kind: "failure",
      reason: heartbeatTerminalToolFailure ? "agent-tool-failure" : "agent-runner-failure",
      ...(heartbeatTerminalToolFailure
        ? {
            previewText: heartbeatToolResponse?.summary || heartbeatTerminalToolFailure.toolName,
          }
        : {}),
      replyPayload: shouldSuppressSourceReply ? undefined : replyPayload,
      normalized,
      shouldSkipMain,
    } as const;
  }
  if (shouldSkipMain) {
    // A heartbeat's canonical quiet reply still honors explicit showOk; event
    // relays and message-tool privacy retain their unconditional silence.
    const silent =
      normalized.silent && !(mode === "heartbeat" && isSilentReplyPayloadText(replyPayload?.text));
    return { kind: "ack", eventStatus: "ok-token", silent } as const;
  }
  return {
    kind: "delivery",
    response: heartbeatToolResponse,
    normalized,
    hasStructuredReplyContent,
    replyPayload: heartbeatToolResponse ? undefined : replyPayload,
    mediaUrls:
      heartbeatToolResponse || !replyPayload
        ? []
        : resolveSendableOutboundReplyParts(replyPayload).mediaUrls,
  } as const;
}

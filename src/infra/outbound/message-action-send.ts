import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { stripPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/index.js";
import { resolveAgentIdentity, resolveResponsePrefix } from "../../agents/identity.js";
import { readStringArrayParam, readToolStringParam } from "../../agents/tools/common.js";
import {
  copyReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { resolveResponsePrefixTemplate } from "../../auto-reply/reply/response-prefix-template.js";
import { normalizeOutboundLocation } from "../../channels/location.js";
import { normalizeConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import type { ChannelId, ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  hasLegacyInteractiveReplyBlocks,
  hasMessagePresentationBlocks,
  hasReplyPayloadContent,
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
  type ReplyPayloadDelivery,
} from "../../interactive/payload.js";
import type { AssistantDeliveryTtsFacts } from "../../llm/types.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { stripUnsupportedCitationControlMarkers } from "../../shared/text/citation-control-markers.js";
import { findCodeRegions } from "../../shared/text/code-regions.js";
import { stripFormattedReasoningMessage } from "../../shared/text/formatted-reasoning-message.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import { throwIfAborted } from "./abort.js";
import type {
  MessageActionInput,
  MessageActionNormalization,
  MessageActionResult,
  ResolvedActionContext,
} from "./message-action-contracts.js";
import {
  annotateSourceDelivery,
  applyMessageCrossContextMarker,
  executeGatewayAction,
} from "./message-action-execution.js";
import {
  collectActionMediaSourceHints,
  collectAttachmentSources,
  normalizeSandboxMediaList,
} from "./message-action-params.js";
import {
  prepareOutboundMirrorRoute,
  resolveAndApplyOutboundReplyToId,
} from "./message-action-threading.js";
import { maybeApplyTtsToMessageActionSendPayload } from "./message-action-tts.js";
import {
  executeSendAction,
  hasCorePresentationDelivery,
  materializeMessagePresentationFallback,
} from "./outbound-send-service.js";
import { ensureOutboundSessionEntry, resolveOutboundSessionRoute } from "./outbound-session.js";

type SendPayloadParts = {
  message: string;
  payload: ReplyPayload;
  mediaUrl?: string;
  mediaUrls?: string[];
  asVoice: boolean;
  gifPlayback: boolean;
  forceDocument: boolean;
  bestEffort?: boolean;
  silent?: boolean;
  normalization?: MessageActionNormalization;
};

function updateSendPayloadPartsFromReplyPayload(
  parts: SendPayloadParts,
  payload: ReplyPayload,
): SendPayloadParts {
  const sendable = resolveSendableOutboundReplyParts(payload);
  const mediaUrls = sendable.mediaUrls.length > 0 ? sendable.mediaUrls : undefined;
  return {
    ...parts,
    message: payload.text ?? "",
    payload,
    mediaUrl: mediaUrls?.[0],
    mediaUrls,
    asVoice: payload.audioAsVoice === true,
  };
}

function applySendLocationToActionParams(
  actionParams: Record<string, unknown>,
  location: ReplyPayload["location"],
) {
  if (location) {
    actionParams.location = location;
  } else {
    delete actionParams.location;
  }
}

function applySendPayloadPartsToActionParams(
  actionParams: Record<string, unknown>,
  parts: SendPayloadParts,
) {
  if (parts.message || !parts.payload.presentation) {
    actionParams.message = parts.message;
  } else {
    // Presentation-only gateway handlers distinguish an omitted body from an
    // explicit empty body when deciding whether to render semantic fallback.
    delete actionParams.message;
  }
  actionParams.media = parts.mediaUrl;
  actionParams.mediaUrl = parts.mediaUrl;
  actionParams.mediaUrls = parts.mediaUrls;
  actionParams.asVoice = parts.asVoice || undefined;
  actionParams.audioAsVoice = parts.asVoice || undefined;
  actionParams.asVideoNote = parts.payload.videoAsNote || undefined;
  applySendLocationToActionParams(actionParams, parts.payload.location);
}

function withSendNormalization(
  result: MessageActionResult,
  normalization?: MessageActionNormalization,
): MessageActionResult {
  return normalization && result.kind === "send" ? { ...result, normalization } : result;
}

export async function buildMessagePayload(params: {
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
  input: MessageActionInput;
  channel?: ChannelId;
  target?: string;
  accountId?: string | null;
  agentId?: string;
}): Promise<SendPayloadParts> {
  const { actionParams, input } = params;
  if (actionParams.pin === true && actionParams.delivery == null) {
    actionParams.delivery = { pin: { enabled: true } };
  }
  // Models may emit message body under non-canonical aliases.
  if (typeof actionParams.message !== "string" || !actionParams.message.trim()) {
    for (const alias of ["SendMessage", "content", "text"] as const) {
      const value = actionParams[alias];
      if (typeof value === "string" && value.trim()) {
        actionParams.message = stripFormattedReasoningMessage(value);
        console.warn(`[message-tool] normalized alias "${alias}" to "message" for send action`);
        break;
      }
    }
  }
  const mediaHint =
    readToolStringParam(actionParams, "media", { trim: false }) ??
    readToolStringParam(actionParams, "mediaUrl", { trim: false }) ??
    readToolStringParam(actionParams, "path", { trim: false }) ??
    readToolStringParam(actionParams, "filePath", { trim: false }) ??
    readToolStringParam(actionParams, "fileUrl", { trim: false }) ??
    readToolStringParam(actionParams, "image", { trim: false });
  const mediaUrlHints = readStringArrayParam(actionParams, "mediaUrls") ?? [];
  const attachmentMediaHints = collectAttachmentSources(actionParams).map((source) => source.value);
  const hasBuffer = Boolean(readToolStringParam(actionParams, "buffer", { trim: false }));
  const hasMediaHint =
    hasBuffer || Boolean(mediaHint) || mediaUrlHints.length > 0 || attachmentMediaHints.length > 0;
  const hasPresentation = hasMessagePresentationBlocks(actionParams.presentation);
  const hasInteractive = hasLegacyInteractiveReplyBlocks(actionParams.interactive);
  const rawLocation = actionParams.location;
  // The flat tool schema also carries scheduled-event `location` as a string,
  // and some models pad unused optional slots with blanks. Keep real send locations strict.
  let location =
    typeof rawLocation === "string" && normalizeOptionalString(rawLocation) === undefined
      ? undefined
      : normalizeOutboundLocation(rawLocation);
  const caption = readToolStringParam(actionParams, "caption", { allowEmpty: true }) ?? "";
  const voiceText = readToolStringParam(actionParams, "voiceText");
  const voiceProvider = readToolStringParam(actionParams, "voiceProvider");
  const voiceId = readToolStringParam(actionParams, "voiceId");
  let message =
    readToolStringParam(actionParams, "message", {
      required: !hasMediaHint && !hasPresentation && !hasInteractive && !location && !voiceText,
      allowEmpty: true,
    }) ?? "";
  if (message.includes("\\n")) {
    message = message.replaceAll("\\n", "\n");
  }
  if (!message.trim() && caption.trim()) {
    message = caption;
  }

  const parsed = parseInlineDirectives(message, {
    stripAudioTag: true,
    stripReplyTags: true,
  });
  const mergedMediaUrls: string[] = [];
  const seenMedia = new Set<string>();
  const pushMedia = (value?: string | null) => {
    const trimmed = normalizeOptionalString(value);
    if (!trimmed || seenMedia.has(trimmed)) {
      return;
    }
    seenMedia.add(trimmed);
    mergedMediaUrls.push(trimmed);
  };
  pushMedia(mediaHint);
  for (const mediaUrlHint of mediaUrlHints) {
    pushMedia(mediaUrlHint);
  }
  for (const attachmentMediaHint of attachmentMediaHints) {
    pushMedia(attachmentMediaHint);
  }

  const normalizedMediaUrls = await normalizeSandboxMediaList({
    values: mergedMediaUrls,
    sandboxRoot: input.sandboxRoot,
  });
  mergedMediaUrls.length = 0;
  mergedMediaUrls.push(...normalizedMediaUrls);

  message = stripPlainTextToolCallBlocks(stripUnsupportedCitationControlMarkers(parsed.text), {
    resolveProtectedRanges: findCodeRegions,
  });
  if (message || !hasPresentation) {
    actionParams.message = message;
  } else {
    delete actionParams.message;
  }
  if (!actionParams.replyTo && parsed.replyToId) {
    actionParams.replyTo = parsed.replyToId;
  }
  if (!actionParams.media) {
    actionParams.media = mergedMediaUrls[0] || undefined;
  }
  actionParams.mediaUrls = mergedMediaUrls.length > 0 ? [...mergedMediaUrls] : undefined;

  const hasLocationConflict = Boolean(
    location &&
    (message.trim() ||
      voiceText ||
      hasBuffer ||
      mergedMediaUrls.length > 0 ||
      hasPresentation ||
      hasInteractive),
  );
  const normalization =
    hasLocationConflict && input.actionOrigin === "message-tool"
      ? {
          locationOmitted: true as const,
          notice:
            "Content sent; location omitted because locations must be sent separately. Do not retry this send. Send a standalone location only if the user explicitly requested it.",
        }
      : undefined;
  if (hasLocationConflict && !normalization) {
    throw new Error("Location sends cannot be combined with message text or media.");
  }
  if (normalization) {
    location = undefined;
  }
  applySendLocationToActionParams(actionParams, location);

  if (params.channel && params.target) {
    message = await applyMessageCrossContextMarker({
      cfg: params.cfg,
      channel: params.channel,
      action: "send",
      target: params.target,
      toolContext: input.toolContext,
      accountId: params.accountId,
      agentId: params.agentId,
      args: actionParams,
      message,
      preferPresentation: true,
    });
  }

  const mediaUrl = readToolStringParam(actionParams, "media", { trim: false });
  if (
    !voiceText &&
    !hasReplyPayloadContent({
      text: message,
      mediaUrl,
      mediaUrls: mergedMediaUrls,
      presentation: actionParams.presentation,
      interactive: actionParams.interactive,
      location,
    })
  ) {
    throw new Error("send requires text or media or location");
  }
  if (message || !hasPresentation) {
    actionParams.message = message;
  } else {
    delete actionParams.message;
  }
  const gifPlayback = readBooleanParam(actionParams, "gifPlayback") ?? false;
  const forceDocument =
    readBooleanParam(actionParams, "forceDocument") ??
    readBooleanParam(actionParams, "asDocument") ??
    false;
  const asVoice =
    readBooleanParam(actionParams, "asVoice") ??
    readBooleanParam(actionParams, "audioAsVoice") ??
    parsed.audioAsVoice;
  const asVideoNote = readBooleanParam(actionParams, "asVideoNote") ?? false;
  const bestEffort = readBooleanParam(actionParams, "bestEffort");
  const silent = readBooleanParam(actionParams, "silent");
  const mirrorMediaUrls =
    mergedMediaUrls.length > 0 ? mergedMediaUrls : mediaUrl ? [mediaUrl] : undefined;
  const rawDelivery = actionParams.delivery;
  const delivery =
    rawDelivery && typeof rawDelivery === "object" && !Array.isArray(rawDelivery)
      ? (rawDelivery as ReplyPayloadDelivery)
      : undefined;
  const rawChannelData = actionParams.channelData;
  const channelData =
    rawChannelData && typeof rawChannelData === "object" && !Array.isArray(rawChannelData)
      ? (rawChannelData as Record<string, unknown>)
      : undefined;
  const presentation = normalizeMessagePresentation(actionParams.presentation);
  const interactive = normalizeLegacyInteractiveReply(actionParams.interactive);
  const payload: ReplyPayload = {
    text: message,
    ...(mediaUrl ? { mediaUrl } : {}),
    ...(mergedMediaUrls.length ? { mediaUrls: mergedMediaUrls } : {}),
    ...(asVoice ? { audioAsVoice: true } : {}),
    ...(asVideoNote ? { videoAsNote: true } : {}),
    ...(location ? { location } : {}),
    ...(presentation ? { presentation } : {}),
    ...(interactive ? { interactive } : {}),
    ...(delivery ? { delivery } : {}),
    ...(channelData ? { channelData } : {}),
  };
  const ttsFacts: AssistantDeliveryTtsFacts | undefined =
    voiceText || voiceProvider || voiceId
      ? {
          tagged: true as const,
          ...(voiceText ? { text: voiceText } : {}),
          ...(voiceProvider || voiceId
            ? {
                directives: [
                  {
                    ...(voiceProvider ? { provider: voiceProvider.toLowerCase() } : {}),
                    values: voiceId ? { voiceid: voiceId } : {},
                  },
                ],
              }
            : {}),
        }
      : undefined;
  return {
    message,
    payload: ttsFacts
      ? setReplyPayloadMetadata(payload, { tts: ttsFacts, ttsExplicit: true })
      : payload,
    ...(mediaUrl ? { mediaUrl } : {}),
    ...(mirrorMediaUrls ? { mediaUrls: mirrorMediaUrls } : {}),
    asVoice,
    gifPlayback,
    forceDocument,
    ...(bestEffort !== undefined ? { bestEffort } : {}),
    ...(silent !== undefined ? { silent } : {}),
    ...(normalization ? { normalization } : {}),
  };
}

// Detects leftover `{variable}` placeholders after prefix interpolation. Non-global so
// `.test()` stays stateless; mirrors the variable shape in response-prefix-template.ts.
const UNRESOLVED_PREFIX_VAR_PATTERN = /\{[a-zA-Z][a-zA-Z0-9.]*\}/;

export async function executeMessageSend(ctx: ResolvedActionContext): Promise<MessageActionResult> {
  const {
    cfg,
    params,
    channel,
    channelPlugin,
    accountId,
    dryRun,
    gateway,
    input,
    agentId,
    resolvedTarget,
    abortSignal,
  } = ctx;
  throwIfAborted(abortSignal);
  const action: ChannelMessageActionName = "send";
  const to = readToolStringParam(params, "to", { required: true });
  let sendPayload = await buildMessagePayload({
    cfg,
    actionParams: params,
    input,
    channel,
    target: to,
    accountId,
    agentId,
  });

  // `message(action=send)` crosses into other conversations, so mirror the direct-reply
  // egress and prepend messages.responsePrefix here too; otherwise the disambiguation
  // prefix is silently dropped on tool sends while replies keep it. Interpolate the
  // template like normalize-reply.ts so identity tokens render. model/provider/thinking
  // tokens need the live model selection that a tool send never performs, so when any
  // placeholder stays unresolved we skip prefixing instead of leaking a literal `{model}`.
  // The startsWith guard matches normalize-reply.ts and keeps re-runs idempotent.
  const responsePrefix = resolveResponsePrefixTemplate(
    resolveResponsePrefix(cfg, agentId ?? "", {
      channel,
      accountId: accountId ?? undefined,
    }),
    { identityName: normalizeOptionalString(resolveAgentIdentity(cfg, agentId ?? "")?.name) },
  );
  const prefixHasUnresolvedVar =
    responsePrefix !== undefined && UNRESOLVED_PREFIX_VAR_PATTERN.test(responsePrefix);
  if (
    responsePrefix &&
    !prefixHasUnresolvedVar &&
    sendPayload.message &&
    !sendPayload.message.startsWith(responsePrefix)
  ) {
    const prefixedMessage = `${responsePrefix} ${sendPayload.message}`;
    sendPayload = {
      ...sendPayload,
      message: prefixedMessage,
      payload: copyReplyPayloadMetadata(sendPayload.payload, {
        ...sendPayload.payload,
        text: prefixedMessage,
      }),
    };
    applySendPayloadPartsToActionParams(params, sendPayload);
  }

  const replyToIsExplicit = Boolean(readToolStringParam(params, "replyTo"));
  resolveAndApplyOutboundReplyToId(params, {
    channel,
    toolContext: input.toolContext,
    matchesToolContextTarget: channelPlugin?.threading?.matchesToolContextTarget,
  });
  const { resolvedThreadId, outboundRoute } = await prepareOutboundMirrorRoute({
    cfg,
    channel,
    to,
    actionParams: params,
    accountId,
    toolContext: input.toolContext,
    agentId,
    currentSessionKey: input.sessionKey,
    dryRun,
    resolvedTarget,
    resolveAutoThreadId: channelPlugin?.threading?.resolveAutoThreadId,
    resolveReplyTransport: channelPlugin?.threading?.resolveReplyTransport,
    replyToIsExplicit,
    resolveOutboundSessionRoute,
  });
  // Durable route/session persistence commits only on send success. A failed
  // probe (missing channel credentials above all) must not rebind the folded
  // main session's delivery route or mint a conversation identity. Once-only:
  // multi-payload sends report several platform results for one route.
  let outboundRoutePersisted = false;
  const commitOutboundSessionRoute = async () => {
    if (outboundRoutePersisted || !outboundRoute) {
      return;
    }
    outboundRoutePersisted = true;
    await ensureOutboundSessionEntry({ cfg, channel, accountId, route: outboundRoute });
  };
  const resolvedReplyToId = readToolStringParam(params, "replyTo");
  throwIfAborted(abortSignal);

  const ttsPayload = await maybeApplyTtsToMessageActionSendPayload({
    payload: sendPayload.payload,
    cfg,
    channel,
    accountId,
    agentId,
    sessionKey: input.sessionKey,
    inboundAudio: input.inboundAudio,
    dryRun,
  });
  if (ttsPayload !== sendPayload.payload) {
    sendPayload = updateSendPayloadPartsFromReplyPayload(sendPayload, ttsPayload);
    applySendPayloadPartsToActionParams(params, sendPayload);
  }
  delete params.voiceText;
  delete params.voiceProvider;
  delete params.voiceId;
  throwIfAborted(abortSignal);
  const mediaAccess = resolveAgentScopedOutboundMediaAccess({
    cfg,
    agentId,
    mediaSources: collectActionMediaSourceHints(params, ctx.extraActionMediaSourceParamKeys, {
      structuredAttachments: "all",
    }),
    sessionKey: input.sessionKey,
    messageProvider: input.sessionKey ? undefined : channel,
    accountId: input.sessionKey ? (input.requesterAccountId ?? accountId) : accountId,
    requesterSenderId: input.requesterSenderId,
    requesterSenderName: input.requesterSenderName,
    requesterSenderUsername: input.requesterSenderUsername,
    requesterSenderE164: input.requesterSenderE164,
  });

  // Required queue persistence is itself an ownership decision: neither the
  // remote gateway action nor a provider-native action may bypass core queueing.
  const requiresCoreDelivery =
    input.forceCoreDelivery === true || input.requireQueuePersistence === true;

  // Gateway action ownership wins even when this process has a render-capable
  // outbound adapter; credentials and account selection may exist only remotely.
  const gatewayPluginAction = requiresCoreDelivery
    ? null
    : await executeGatewayAction({
        cfg,
        params,
        channel,
        channelPlugin,
        action,
        accountId,
        dryRun,
        gateway,
        input,
        agentId,
        result: (payload) => ({
          kind: "send",
          channel,
          action,
          to,
          handledBy: "plugin",
          payload,
          dryRun,
        }),
      });
  if (gatewayPluginAction) {
    await commitOutboundSessionRoute();
    return annotateSourceDelivery(
      withSendNormalization(gatewayPluginAction, sendPayload.normalization),
      {
        cfg,
        actionParams: params,
        channel,
        accountId,
        input,
        agentId,
        replyToIsExplicit,
      },
    );
  }

  const useCorePresentationDelivery = Boolean(
    sendPayload.payload.presentation && hasCorePresentationDelivery(channelPlugin?.outbound),
  );
  if (sendPayload.payload.presentation && !useCorePresentationDelivery) {
    const fallbackMessage = materializeMessagePresentationFallback({
      payload: sendPayload.payload,
      text: sendPayload.message,
    });
    sendPayload = {
      ...sendPayload,
      message: fallbackMessage,
      payload: { ...sendPayload.payload, text: fallbackMessage },
    };
    applySendPayloadPartsToActionParams(params, sendPayload);
  }

  const send = await executeSendAction({
    ctx: {
      cfg,
      channel,
      plugin: channelPlugin,
      params,
      idempotencyKey: ctx.idempotencyKey,
      agentId,
      sessionKey: input.sessionKey,
      requesterAccountId: input.requesterAccountId ?? undefined,
      requesterSenderId: input.requesterSenderId ?? undefined,
      requesterSenderName: input.requesterSenderName ?? undefined,
      requesterSenderUsername: input.requesterSenderUsername ?? undefined,
      requesterSenderE164: input.requesterSenderE164 ?? undefined,
      senderIsOwner: input.senderIsOwner,
      conversationReadOrigin: normalizeConversationReadInvocationOrigin(
        input.conversationReadOrigin,
      ),
      mediaAccess,
      accountId: accountId ?? undefined,
      conversationType: outboundRoute?.chatType,
      sessionId: input.sessionId,
      inboundEventKind: input.inboundEventKind,
      gateway,
      toolContext: input.toolContext,
      deps: input.deps,
      dryRun,
      preparedMessageId: input.preparedMessageId,
      gatewayOwnedDelivery: input.gatewayOwnedDelivery,
      forceCoreDelivery: requiresCoreDelivery,
      requireQueuePersistence: input.requireQueuePersistence,
      deliveryIntentId: input.deliveryIntentId,
      deliveryCompletion: input.deliveryCompletion,
      onDeliveryIntent: input.onDeliveryIntent,
      // Identified platform evidence is the first success proof on the core
      // path; commit the route here so the transcript mirror (which runs later
      // in the same delivery) can resolve a just-created session entry.
      onDeliveryResult: async (result) => {
        await commitOutboundSessionRoute();
        await input.onDeliveryResult?.(result);
      },
      onPluginSendAccepted: commitOutboundSessionRoute,
      mirror:
        !dryRun && input.transcriptMirror
          ? {
              ...input.transcriptMirror,
              text: sendPayload.message,
              mediaUrls: sendPayload.mediaUrls,
            }
          : outboundRoute && !dryRun && input.suppressTranscriptMirror !== true
            ? {
                sessionKey: outboundRoute.sessionKey,
                agentId,
                text: sendPayload.message,
                mediaUrls: sendPayload.mediaUrls,
                idempotencyKey: normalizeOptionalString(params.idempotencyKey) ?? undefined,
              }
            : undefined,
      abortSignal,
      silent: sendPayload.silent ?? undefined,
    },
    to,
    message: sendPayload.message,
    payload: sendPayload.payload,
    mediaUrl: sendPayload.mediaUrl,
    mediaUrls: sendPayload.mediaUrls,
    buffer: readToolStringParam(params, "buffer", { trim: false }) ?? undefined,
    filename: readToolStringParam(params, "filename") ?? undefined,
    contentType: readToolStringParam(params, "contentType") ?? undefined,
    asVoice: sendPayload.asVoice,
    gifPlayback: sendPayload.gifPlayback,
    forceDocument: sendPayload.forceDocument,
    bestEffort: sendPayload.bestEffort,
    replyToId: resolvedReplyToId ?? undefined,
    replyToIdSource: resolvedReplyToId ? (replyToIsExplicit ? "explicit" : "implicit") : undefined,
    threadId: resolvedThreadId ?? undefined,
  });

  // Gateway-relayed core sends return no identified platform result locally;
  // a non-failed, non-suppressed return is their success proof. Failed and
  // suppressed sends leave the durable route untouched.
  const coreDeliveryStatus = send.sendResult?.deliveryStatus;
  if (coreDeliveryStatus !== "failed" && coreDeliveryStatus !== "suppressed") {
    await commitOutboundSessionRoute();
  }

  const result: Extract<MessageActionResult, { kind: "send" }> = {
    kind: "send",
    channel,
    action,
    to,
    handledBy: send.handledBy,
    payload: send.payload,
    ...(send.deliveredText ? { deliveredText: send.deliveredText } : {}),
    toolResult: send.toolResult,
    sendResult: send.sendResult,
    dryRun,
  };
  return annotateSourceDelivery(withSendNormalization(result, sendPayload.normalization), {
    cfg,
    actionParams: params,
    channel,
    accountId,
    input,
    agentId,
    replyToIsExplicit,
  });
}

import path from "node:path";
import type { GatewayClientInfo } from "../../../packages/gateway-protocol/src/client-info.js";
import type { RuntimeMsgContext as MsgContext } from "../../auto-reply/templating.js";
import type { MediaFact } from "../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { SavedMedia } from "../../media/store.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { UserTurnInput } from "../../sessions/user-turn-transcript.js";
import { INTERNAL_MESSAGE_CHANNEL, isOperatorUiClient } from "../../utils/message-channel.js";
import {
  type ChatImageContent,
  type OffloadedRef,
  persistInboundImagesForTranscript,
} from "../chat-attachments.js";
import { isAcpBridgeClient } from "./chat-origin-routing.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { prepareChatSendAttachments } from "./chat-send-attachments.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { normalizeOptionalChatText } from "./chat-text-normalization.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

type PreparedChatSendAttachments = Extract<
  Awaited<ReturnType<typeof prepareChatSendAttachments>>,
  { ok: true }
>["value"];

type ChatSendUserTurnInputController = {
  baseInput: UserTurnInput;
  setInputPromise: (input: Promise<UserTurnInput>) => void;
};

async function persistChatSendImages(params: {
  images: ChatImageContent[];
  imageOrder: PromptImageOrderEntry[];
  offloadedRefs: OffloadedRef[];
  client: GatewayRequestHandlerOptions["client"];
  logGateway: GatewayRequestContext["logGateway"];
}): Promise<SavedMedia[]> {
  if (
    (params.images.length === 0 && params.offloadedRefs.length === 0) ||
    isAcpBridgeClient(params.client)
  ) {
    return [];
  }
  return await persistInboundImagesForTranscript({
    images: params.images,
    imageOrder: params.imageOrder,
    offloadedRefs: params.offloadedRefs,
    log: params.logGateway,
    logContext: "chat.send",
  });
}

function resolveChatSendManagedMedia(savedImages: SavedMedia[]): MediaFact[] {
  return savedImages.map((entry) => ({
    path: entry.path,
    contentType: entry.contentType ?? "application/octet-stream",
  }));
}

export function applyChatSendManagedMedia(ctx: MsgContext, media: MediaFact[]): void {
  if ((!ctx.media || ctx.media.length === 0) && media.length > 0) {
    ctx.media = media;
  }
}

function buildChatSendUserTurnMedia(
  savedMedia: SavedMedia[],
  offloadedRefs: OffloadedRef[],
): MediaFact[] {
  const offloadedRefsById = new Map(offloadedRefs.map((ref) => [ref.id, ref] as const));
  return savedMedia.map((entry) => {
    const offloadedRef = offloadedRefsById.get(entry.id);
    return {
      path: entry.path,
      ...(offloadedRef
        ? {
            // Every offload keeps its claim-check alias so persisted marker
            // ownership survives; only non-images skip native image hydration.
            url: offloadedRef.mediaRef,
            ...(offloadedRef.mimeType.startsWith("image/") ? {} : { hydrationSuppressed: true }),
          }
        : {}),
      contentType: entry.contentType,
    };
  });
}

function buildChatSendPromptMedia(
  attachments: PreparedChatSendAttachments,
): MediaFact[] | undefined {
  if (!attachments.imageOrder.includes("offloaded")) {
    return undefined;
  }
  const media = attachments.offloadedRefs
    .filter((ref) => ref.mimeType.startsWith("image/"))
    .map((ref) => ({ path: ref.path, url: ref.mediaRef, contentType: ref.mimeType }));
  return media.length > 0 ? media : undefined;
}

function buildChatSendMessageContext(params: {
  agentId: string;
  client: GatewayRequestHandlerOptions["client"];
  clientInfo?: GatewayClientInfo;
  clientRunId: string;
  mediaPathOffloadPaths: string[];
  mediaPathOffloadTypes: string[];
  mediaPathOffloadWorkspaceDir?: string;
  originatingRoute: AdmittedChatSend["originatingRoute"];
  parsedMessage: string;
  sessionKey: string;
  suppressCommandInterpretation: boolean;
  systemInputProvenance?: InputProvenance;
  systemProvenanceReceipt?: string;
  toolBindings?: Readonly<Record<string, unknown>>;
}) {
  const commandBody = params.parsedMessage;
  const commandSource =
    !params.suppressCommandInterpretation && params.parsedMessage.trim().startsWith("/")
      ? "text"
      : undefined;
  const messageForAgent = params.systemProvenanceReceipt
    ? [params.systemProvenanceReceipt, params.parsedMessage].filter(Boolean).join("\n\n")
    : params.parsedMessage;
  const queuedFollowupOwnerDeviceId = normalizeOptionalChatText(params.client?.connect?.device?.id);
  const queuedFollowupOwnerConnId = normalizeOptionalChatText(params.client?.connId);
  const queuedFollowupOwnerKey = queuedFollowupOwnerDeviceId
    ? `device:${queuedFollowupOwnerDeviceId}`
    : queuedFollowupOwnerConnId
      ? `connection:${queuedFollowupOwnerConnId}`
      : undefined;
  const { originatingChannel, originatingTo, accountId, messageThreadId, explicitDeliverRoute } =
    params.originatingRoute;
  // Current and historical turns must reach the single LLM timestamp boundary
  // with identical bare text. Stamping this live turn would bust the prompt cache.
  const ctx: MsgContext = {
    Body: messageForAgent,
    BodyForAgent: messageForAgent,
    BodyForCommands: commandBody,
    RawBody: params.parsedMessage,
    CommandBody: commandBody,
    InputProvenance: params.systemInputProvenance,
    SessionKey: params.sessionKey,
    AgentId: params.agentId,
    Provider: INTERNAL_MESSAGE_CHANNEL,
    Surface: INTERNAL_MESSAGE_CHANNEL,
    OriginatingChannel: originatingChannel,
    OriginatingTo: originatingTo,
    ExplicitDeliverRoute: explicitDeliverRoute,
    AccountId: accountId,
    MessageThreadId: messageThreadId,
    ChatType: "direct",
    ...(commandSource ? { CommandSource: commandSource } : {}),
    CommandAuthorized: !params.suppressCommandInterpretation,
    CommandTurn: commandSource
      ? {
          kind: "text-slash",
          source: commandSource,
          authorized: true,
          body: commandBody,
        }
      : {
          kind: "normal",
          source: "message",
          authorized: false,
          body: commandBody,
        },
    MessageSid: params.clientRunId,
    SessionCreation: resolveOperatorSessionCreation(params.client),
    ApprovalReviewerDeviceId: queuedFollowupOwnerDeviceId,
    ...(!isOperatorUiClient(params.clientInfo)
      ? {
          SenderId: params.clientInfo?.id,
          SenderName: params.clientInfo?.displayName,
          SenderUsername: params.clientInfo?.displayName,
        }
      : {}),
    GatewayClientScopes: params.client?.connect?.scopes ?? [],
    GatewayClientCaps: params.client?.connect?.caps ?? [],
    GatewayRunToolBindings: params.toolBindings,
  };
  if (params.mediaPathOffloadPaths.length > 0) {
    // Pre-staged offloads must use structured facts and marker text so the
    // dispatch path renders their prompt note without staging them a second time.
    ctx.media = params.mediaPathOffloadPaths.map((pathValue, index) => ({
      path: pathValue,
      contentType: params.mediaPathOffloadTypes[index],
      workspaceDir: params.mediaPathOffloadWorkspaceDir ?? path.dirname(pathValue),
    }));
  }
  return {
    accountId,
    ctx,
    isInternalTextSlashCommandTurn: commandSource === "text",
    queuedFollowupOwnerKey,
  };
}

/** Assemble transcript media and the portable inbound context after chat.send ACK. */
export function prepareChatSendUserTurn(params: {
  request: Pick<
    NormalizedChatSendRequest,
    | "clientInfo"
    | "normalizedAttachments"
    | "suppressCommandInterpretation"
    | "systemInputProvenance"
    | "systemProvenanceReceipt"
    | "toolBindings"
  >;
  session: Pick<PreparedChatSendSession, "agentId" | "clientRunId" | "sessionKey">;
  admission: Pick<AdmittedChatSend, "originatingRoute">;
  attachments: PreparedChatSendAttachments;
  client: GatewayRequestHandlerOptions["client"];
  logGateway: GatewayRequestContext["logGateway"];
  userTurn: ChatSendUserTurnInputController;
}) {
  const { request, session, admission, attachments, client, logGateway, userTurn } = params;
  const persistedMediaForTranscriptPromise = persistChatSendImages({
    images: attachments.parsedImages,
    imageOrder: attachments.imageOrder,
    offloadedRefs: attachments.offloadedRefs,
    client,
    logGateway,
  });
  const preparedUserTurnMediaPromise: Promise<MediaFact[]> =
    request.normalizedAttachments.length > 0
      ? persistedMediaForTranscriptPromise.then((media) =>
          buildChatSendUserTurnMedia(media, attachments.offloadedRefs),
        )
      : Promise.resolve([]);
  userTurn.setInputPromise(
    preparedUserTurnMediaPromise.then((media) => ({
      ...userTurn.baseInput,
      ...(media.length > 0 ? { media } : {}),
      ...(media.length > 0 && attachments.imageOrder.length > 0
        ? {
            mediaImageLayout: {
              // persistInboundImagesForTranscript emits image facts in this exact order,
              // then appends non-images, so image slot ordinals are fact ordinals.
              slots: attachments.imageOrder.map((kind, factIndex) => ({ kind, factIndex })),
            },
          }
        : {}),
    })),
  );
  const pluginBoundMediaPromise =
    attachments.explicitOriginTargetsPlugin && attachments.parsedImages.length > 0
      ? persistedMediaForTranscriptPromise.then(resolveChatSendManagedMedia)
      : Promise.resolve([]);
  const messageContext = buildChatSendMessageContext({
    agentId: session.agentId,
    client,
    clientInfo: request.clientInfo,
    clientRunId: session.clientRunId,
    mediaPathOffloadPaths: attachments.mediaPathOffloadPaths,
    mediaPathOffloadTypes: attachments.mediaPathOffloadTypes,
    mediaPathOffloadWorkspaceDir: attachments.mediaPathOffloadWorkspaceDir,
    originatingRoute: admission.originatingRoute,
    parsedMessage: attachments.parsedMessage,
    sessionKey: session.sessionKey,
    suppressCommandInterpretation: request.suppressCommandInterpretation,
    systemInputProvenance: request.systemInputProvenance,
    systemProvenanceReceipt: request.systemProvenanceReceipt,
    toolBindings: request.toolBindings,
  });
  const mediaPathOffloadsIncludeImages = attachments.mediaPathOffloadTypes.some((type) =>
    type.startsWith("image/"),
  );
  return {
    ...messageContext,
    pluginBoundMediaPromise,
    replyOptionImages: mediaPathOffloadsIncludeImages
      ? undefined
      : attachments.parsedImages.length > 0
        ? attachments.parsedImages
        : undefined,
    replyOptionMedia: buildChatSendPromptMedia(attachments),
  };
}

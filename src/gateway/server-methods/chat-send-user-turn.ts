import type { GatewayClientInfo } from "../../../packages/gateway-protocol/src/client-info.js";
import type { MsgContext } from "../../auto-reply/templating.js";
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
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

type PreparedChatSendAttachments = Extract<
  Awaited<ReturnType<typeof prepareChatSendAttachments>>,
  { ok: true }
>["value"];

type ChatSendUserTurnInputController = {
  baseInput: UserTurnInput;
  setInputPromise: (input: Promise<UserTurnInput>) => void;
};

type ChatSendManagedMediaFields = Partial<
  Pick<MsgContext, "MediaPath" | "MediaPaths" | "MediaType" | "MediaTypes">
>;

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

function resolveChatSendManagedMediaFields(savedImages: SavedMedia[]): ChatSendManagedMediaFields {
  const mediaPaths = savedImages.map((entry) => entry.path);
  if (mediaPaths.length === 0) {
    return {};
  }
  const mediaTypes = savedImages.map((entry) => entry.contentType ?? "application/octet-stream");
  return {
    MediaPath: mediaPaths[0],
    MediaPaths: mediaPaths,
    MediaType: mediaTypes[0],
    MediaTypes: mediaTypes,
  };
}

export function applyChatSendManagedMediaFields(
  ctx: MsgContext,
  fields: ChatSendManagedMediaFields,
) {
  if (!ctx.MediaStaged) {
    Object.assign(ctx, fields);
    return;
  }

  if (ctx.MediaPath === undefined && fields.MediaPath !== undefined) {
    ctx.MediaPath = fields.MediaPath;
  }
  if (ctx.MediaPaths === undefined && fields.MediaPaths !== undefined) {
    ctx.MediaPaths = fields.MediaPaths;
  }
  if (ctx.MediaType === undefined && fields.MediaType !== undefined) {
    ctx.MediaType = fields.MediaType;
  }
  if (ctx.MediaTypes === undefined && fields.MediaTypes !== undefined) {
    ctx.MediaTypes = fields.MediaTypes;
  }
}

function buildChatSendUserTurnMedia(savedMedia: SavedMedia[]): NonNullable<UserTurnInput["media"]> {
  return savedMedia.map((entry) => ({
    path: entry.path,
    contentType: entry.contentType,
  }));
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
  };
  if (params.mediaPathOffloadPaths.length > 0) {
    // Pre-staged offloads must use the channel media fields and marker so the
    // dispatch path renders their prompt note without staging them a second time.
    ctx.MediaPath = params.mediaPathOffloadPaths[0];
    ctx.MediaPaths = params.mediaPathOffloadPaths;
    ctx.MediaType = params.mediaPathOffloadTypes[0];
    ctx.MediaTypes = params.mediaPathOffloadTypes;
    ctx.MediaWorkspaceDir = params.mediaPathOffloadWorkspaceDir;
    ctx.MediaStaged = true;
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
  >;
  session: Pick<PreparedChatSendSession, "agentId" | "clientRunId" | "sessionKey">;
  admission: Pick<AdmittedChatSend, "originatingRoute">;
  attachments: PreparedChatSendAttachments;
  client: GatewayRequestHandlerOptions["client"];
  logGateway: GatewayRequestContext["logGateway"];
  userTurn: ChatSendUserTurnInputController;
}) {
  const { request, session, admission, attachments, client, logGateway, userTurn } = params;
  const persistedImagesPromise = persistChatSendImages({
    images: attachments.parsedImages,
    imageOrder: attachments.imageOrder,
    offloadedRefs: attachments.offloadedRefs,
    client,
    logGateway,
  });
  let persistedMediaForTranscript: SavedMedia[] | undefined;
  const getPersistedMediaForTranscript = async () => {
    if (!persistedMediaForTranscript) {
      persistedMediaForTranscript = await persistedImagesPromise;
    }
    return persistedMediaForTranscript;
  };
  const preparedUserTurnMediaPromise =
    request.normalizedAttachments.length > 0
      ? getPersistedMediaForTranscript()
      : Promise.resolve([]);
  userTurn.setInputPromise(
    preparedUserTurnMediaPromise.then(buildChatSendUserTurnMedia).then((media) => ({
      ...userTurn.baseInput,
      ...(media.length > 0
        ? {
            media,
            mediaOnlyText: "[User sent media without caption]",
          }
        : {}),
    })),
  );
  const pluginBoundMediaFieldsPromise =
    attachments.explicitOriginTargetsPlugin && attachments.parsedImages.length > 0
      ? preparedUserTurnMediaPromise.then(resolveChatSendManagedMediaFields)
      : Promise.resolve({});
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
  });
  const mediaPathOffloadsIncludeImages = attachments.mediaPathOffloadTypes.some((type) =>
    type.startsWith("image/"),
  );
  return {
    ...messageContext,
    pluginBoundMediaFieldsPromise,
    replyOptionImages: mediaPathOffloadsIncludeImages
      ? undefined
      : attachments.parsedImages.length > 0
        ? attachments.parsedImages
        : undefined,
  };
}

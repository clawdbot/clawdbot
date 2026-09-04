import path from "node:path";
import type { GatewayClientInfo } from "../../../packages/gateway-protocol/src/client-info.js";
import type { RuntimeMsgContext as MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MediaFact } from "../../media/media-facts.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import type { UserTurnInput } from "../../sessions/user-turn-transcript.js";
import {
  type ChatImageContent,
  type OffloadedRef,
  INLINE_IMAGE_DURABLE_OMISSION_MARKER,
  persistInboundImagesForTranscript,
} from "../chat-attachments.js";
import { resolveCreatorSandbox } from "../operator-role-policy.js";
import { resolveGatewayInputParticipant } from "../session-input-participant.js";
import { prepareSkillLibrarySessionCreation } from "../skill-library-session.js";
import { isAcpBridgeClient } from "./chat-origin-routing.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { prepareChatSendAttachments } from "./chat-send-attachments.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { normalizeOptionalChatText } from "./chat-text-normalization.js";
import { resolveChatSendCallerContext } from "./gateway-client-identity.js";
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

type PersistedChatSendMedia = Awaited<
  ReturnType<typeof persistInboundImagesForTranscript>
>["entries"];

async function persistChatSendImages(params: {
  images: ChatImageContent[];
  offloadedRefs: OffloadedRef[];
  client: GatewayRequestHandlerOptions["client"];
  logGateway: GatewayRequestContext["logGateway"];
}): Promise<Awaited<ReturnType<typeof persistInboundImagesForTranscript>>> {
  if (
    (params.images.length === 0 && params.offloadedRefs.length === 0) ||
    isAcpBridgeClient(params.client)
  ) {
    return { entries: [], omission: "none" };
  }
  return await persistInboundImagesForTranscript({
    images: params.images,
    offloadedRefs: params.offloadedRefs,
    log: params.logGateway,
    logContext: "chat.send",
  });
}

function resolveChatSendManagedMedia(entries: PersistedChatSendMedia): MediaFact[] {
  return entries.map((entry) => ({
    path: entry.path,
    contentType: entry.fact.contentType ?? "application/octet-stream",
  }));
}

export function applyChatSendManagedMedia(ctx: MsgContext, media: MediaFact[]): void {
  if ((!ctx.media || ctx.media.length === 0) && media.length > 0) {
    ctx.media = media;
  }
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
  cfg?: OpenClawConfig;
  getConfig?: () => OpenClawConfig;
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
  const creation = params.systemInputProvenance
    ? resolveOperatorSessionCreation(params.client)
    : prepareSkillLibrarySessionCreation(
        params.client,
        params.getConfig ?? params.cfg ?? {},
        resolveOperatorSessionCreation(params.client),
      );
  const sandbox = params.cfg ? resolveCreatorSandbox(params.cfg, creation) : undefined;
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
    OriginatingTo: originatingTo,
    ExplicitDeliverRoute: explicitDeliverRoute,
    AccountId: accountId,
    MessageThreadId: messageThreadId,
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
    ...(params.suppressCommandInterpretation ? { CommandInterpretationSuppressed: true } : {}),
    MessageSid: params.clientRunId,
    SessionCreation: { ...creation, ...(sandbox ? { sandbox } : {}) },
    ...resolveChatSendCallerContext(params.client, params.clientInfo, originatingChannel),
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
  session: Pick<PreparedChatSendSession, "agentId" | "clientRunId" | "sessionKey"> &
    Partial<Pick<PreparedChatSendSession, "cfg">>;
  admission: Pick<AdmittedChatSend, "originatingRoute">;
  attachments: PreparedChatSendAttachments;
  client: GatewayRequestHandlerOptions["client"];
  logGateway: GatewayRequestContext["logGateway"];
  getConfig?: () => OpenClawConfig;
  userTurn: ChatSendUserTurnInputController;
}) {
  const { request, session, admission, attachments, client, logGateway, userTurn } = params;
  const persistedMediaForTranscriptPromise = persistChatSendImages({
    images: attachments.parsedImages,
    offloadedRefs: attachments.offloadedRefs,
    client,
    logGateway,
  });
  userTurn.setInputPromise(
    persistedMediaForTranscriptPromise.then((result) => {
      const media = result.entries.map((entry) => entry.fact);
      const slots = result.entries.flatMap((entry, factIndex) =>
        entry.imageKind ? [{ kind: entry.imageKind, factIndex }] : [],
      );
      return {
        ...userTurn.baseInput,
        ...(result.omission === "inline-image-save-failed"
          ? {
              text: [userTurn.baseInput.text, INLINE_IMAGE_DURABLE_OMISSION_MARKER]
                .filter(Boolean)
                .join("\n"),
            }
          : {}),
        ...(media.length > 0 ? { media } : {}),
        ...(slots.length > 0 ? { mediaImageLayout: { slots } } : {}),
      };
    }),
  );
  const pluginBoundMediaPromise =
    attachments.explicitOriginTargetsPlugin && attachments.parsedImages.length > 0
      ? persistedMediaForTranscriptPromise.then((result) =>
          resolveChatSendManagedMedia(result.entries),
        )
      : Promise.resolve([]);
  void pluginBoundMediaPromise.catch(() => undefined);
  const messageContext = buildChatSendMessageContext({
    agentId: session.agentId,
    cfg: session.cfg,
    getConfig: params.getConfig,
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
  const participant = resolveGatewayInputParticipant(client, request.systemInputProvenance);
  if (participant) {
    prepareSessionParticipantInput(messageContext.ctx, participant, userTurn.baseInput.timestamp);
  }
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

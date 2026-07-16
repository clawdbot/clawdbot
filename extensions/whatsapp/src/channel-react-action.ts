import {
  isWhatsAppGroupJid,
  resolveReactionMessageId,
  handleWhatsAppAction,
  normalizeWhatsAppTarget,
  readStringOrNumberParam,
  readStringParam,
  type OpenClawConfig,
} from "./channel-react-action.runtime.js";

const WHATSAPP_CHANNEL = "whatsapp" as const;

export async function handleWhatsAppReactAction(params: {
  action: string;
  params: Record<string, unknown>;
  cfg: OpenClawConfig;
  accountId?: string | null;
  requesterSenderId?: string | null;
  toolContext?: {
    currentChannelId?: string | null;
    currentChannelProvider?: string | null;
    currentMessageId?: string | number | null;
  };
}) {
  if (params.action !== "react") {
    throw new Error(`Action ${params.action} is not supported for provider ${WHATSAPP_CHANNEL}.`);
  }
  const isWhatsAppSource = params.toolContext?.currentChannelProvider === WHATSAPP_CHANNEL;
  const explicitTarget =
    readStringParam(params.params, "chatJid") ?? readStringParam(params.params, "to");
  const normalizedTarget = explicitTarget ? normalizeWhatsAppTarget(explicitTarget) : null;
  const normalizedCurrent =
    isWhatsAppSource && params.toolContext?.currentChannelId
      ? normalizeWhatsAppTarget(params.toolContext.currentChannelId)
      : null;
  const isCrossChat =
    normalizedTarget != null &&
    (normalizedCurrent == null || normalizedTarget !== normalizedCurrent);
  const scopedContext =
    !isWhatsAppSource || isCrossChat || !params.toolContext
      ? undefined
      : {
          currentChannelId: params.toolContext.currentChannelId ?? undefined,
          currentChannelProvider: params.toolContext.currentChannelProvider ?? undefined,
          currentMessageId: params.toolContext.currentMessageId ?? undefined,
        };
  const messageIdRaw = resolveReactionMessageId({
    args: params.params,
    toolContext: scopedContext,
  });
  if (messageIdRaw == null) {
    readStringParam(params.params, "messageId", { required: true });
  }
  const messageId = String(messageIdRaw);
  const explicitMessageId = readStringOrNumberParam(params.params, "messageId");
  const emoji = readStringParam(params.params, "emoji", { allowEmpty: true });
  const remove = typeof params.params.remove === "boolean" ? params.params.remove : undefined;
  const explicitParticipant = readStringParam(params.params, "participant");
  const inferredParticipant =
    explicitParticipant ||
    explicitMessageId != null ||
    !isWhatsAppSource ||
    isCrossChat ||
    !isWhatsAppGroupJid(explicitTarget ?? params.toolContext?.currentChannelId ?? "")
      ? undefined
      : typeof params.requesterSenderId === "string" && params.requesterSenderId.trim().length > 0
        ? params.requesterSenderId.trim()
        : undefined;
  return await handleWhatsAppAction(
    {
      action: "react",
      chatJid:
        readStringParam(params.params, "chatJid") ??
        readStringParam(params.params, "to", { required: true }),
      messageId,
      emoji,
      remove,
      participant: explicitParticipant ?? inferredParticipant,
      accountId: params.accountId ?? undefined,
      fromMe: typeof params.params.fromMe === "boolean" ? params.params.fromMe : undefined,
    },
    params.cfg,
  );
}

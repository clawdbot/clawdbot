import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import { buildPersistedUserTurnMediaInputsFromFields } from "./user-turn-transcript.media-normalize.js";
import type { PersistedUserTurnMessage } from "./user-turn-transcript.types.js";

export function readUserTurnMessageMeta(
  message: AgentMessage,
): Record<string, unknown> | undefined {
  return asOptionalRecord(Reflect.get(message, "__openclaw"));
}

export function buildLateResolvedMediaMessage(params: {
  admittedMessage?: PersistedUserTurnMessage;
  resolvedMessage: PersistedUserTurnMessage;
}): PersistedUserTurnMessage | undefined {
  const admittedMedia = buildPersistedUserTurnMediaInputsFromFields(params.admittedMessage);
  const resolvedMedia = buildPersistedUserTurnMediaInputsFromFields(params.resolvedMessage);
  if (
    resolvedMedia.length === 0 ||
    JSON.stringify(resolvedMedia) === JSON.stringify(admittedMedia)
  ) {
    return undefined;
  }
  const resolvedIdempotencyKey = Reflect.get(params.resolvedMessage, "idempotencyKey");
  const resolvedTimestamp = Reflect.get(params.resolvedMessage, "timestamp");
  const admittedContent = params.admittedMessage?.content;
  const resolvedContent = params.resolvedMessage.content;
  let content = resolvedContent;
  if (resolvedContent === admittedContent) {
    content = "";
  } else if (Array.isArray(resolvedContent) && typeof admittedContent === "string") {
    content = resolvedContent.filter((block) => {
      return block.type !== "text" || block.text !== admittedContent;
    });
  }
  const idempotencyKey =
    typeof resolvedIdempotencyKey === "string" && resolvedIdempotencyKey.length > 0
      ? resolvedIdempotencyKey + ":late-media"
      : "late-media:" + (typeof resolvedTimestamp === "number" ? resolvedTimestamp : Date.now());
  // Late-media scaffolding is wire-only so user-facing transcript projections skip it.
  const lateResolvedMessage = {
    ...params.resolvedMessage,
    content,
    idempotencyKey,
    __openclaw: { ...readUserTurnMessageMeta(params.resolvedMessage), lateMedia: true },
  };
  // SAFETY: idempotencyKey and __openclaw are informal wire-only extension fields read via Reflect elsewhere, not part of PersistedUserTurnMessage's declared shape.
  return lateResolvedMessage as PersistedUserTurnMessage;
}

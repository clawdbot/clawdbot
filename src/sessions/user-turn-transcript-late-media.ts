import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import { buildPersistedUserTurnMediaInputsFromFields } from "./user-turn-transcript.media-normalize.js";
import type { PersistedUserTurnMessage } from "./user-turn-transcript.types.js";

export function readUserTurnMessageMeta(
  message: AgentMessage,
): Record<string, unknown> | undefined {
  return asOptionalRecord((message as unknown as Record<string, unknown>)["__openclaw"]);
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
  const resolved = params.resolvedMessage as unknown as Record<string, unknown>;
  const admittedContent = params.admittedMessage?.content;
  const resolvedContent = params.resolvedMessage.content;
  let content = resolvedContent;
  if (resolvedContent === admittedContent) {
    content = "";
  } else if (Array.isArray(resolvedContent) && typeof admittedContent === "string") {
    content = resolvedContent.filter((block) => {
      const textBlock = block as { type?: unknown; text?: unknown } | null;
      return textBlock?.type !== "text" || textBlock.text !== admittedContent;
    });
  }
  const idempotencyKey =
    typeof resolved.idempotencyKey === "string" && resolved.idempotencyKey.length > 0
      ? `${resolved.idempotencyKey}:late-media`
      : `late-media:${typeof resolved.timestamp === "number" ? resolved.timestamp : Date.now()}`;
  // Late-media scaffolding is wire-only so user-facing transcript projections skip it.
  return {
    ...resolved,
    content,
    idempotencyKey,
    __openclaw: { ...readUserTurnMessageMeta(params.resolvedMessage), lateMedia: true },
  } as unknown as PersistedUserTurnMessage;
}

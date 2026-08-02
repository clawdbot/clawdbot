import type { RunCliAgentParams } from "./types.js";

/** Resolves a current turn that must not be exposed as prior CLI history. */
export function resolveCliSessionHistoryExcludedMessageIdempotencyKey(
  params: Pick<
    RunCliAgentParams,
    | "excludeMessageIdempotencyKey"
    | "suppressNextUserMessagePersistence"
    | "userTurnTranscriptRecorder"
  >,
): string | undefined {
  const explicitKey = params.excludeMessageIdempotencyKey;
  if (typeof explicitKey === "string" && explicitKey.length > 0) {
    return explicitKey;
  }
  const recorder = params.userTurnTranscriptRecorder;
  if (params.suppressNextUserMessagePersistence !== true || !recorder?.hasPersisted()) {
    return undefined;
  }
  const message = recorder.getPersistedMessage?.() ?? recorder.message;
  const idempotencyKey = (message as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
  return typeof idempotencyKey === "string" && idempotencyKey.length > 0
    ? idempotencyKey
    : undefined;
}

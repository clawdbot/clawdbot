import {
  normalizeRpcAttachmentsToChatAttachments,
  type RpcAttachmentInput,
} from "./attachment-normalize.js";

const RESTART_RECOVERY_CONTINUATION_MESSAGE =
  "Continue from the recovered transcript and finish the interrupted work.";

const RESTART_RECOVERY_ALLOWED_PARAMS = new Set(["agentId", "parentSessionKey", "recover"]);

export function validateSessionRecoveryCreateParams(
  params: Record<string, unknown>,
): string | undefined {
  if (
    params.recover === true &&
    Object.keys(params).some((key) => !RESTART_RECOVERY_ALLOWED_PARAMS.has(key))
  ) {
    return "sessions.create recovery only accepts agentId and parentSessionKey";
  }
  return undefined;
}

function resolveOptionalInitialSessionMessage(params: {
  task?: unknown;
  message?: unknown;
}): string | undefined {
  if (typeof params.task === "string" && params.task.trim()) {
    return params.task;
  }
  if (typeof params.message === "string" && params.message.trim()) {
    return params.message;
  }
  return undefined;
}

export function resolveSessionCreateInitialTurn(params: {
  attachments?: unknown[];
  message?: unknown;
  recover?: unknown;
  task?: unknown;
}) {
  const message =
    params.recover === true
      ? RESTART_RECOVERY_CONTINUATION_MESSAGE
      : resolveOptionalInitialSessionMessage(params);
  const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(
    params.attachments as RpcAttachmentInput[] | undefined,
  );
  if (params.attachments?.length && !message && normalizedAttachments.length === 0) {
    return null;
  }
  const attachments = normalizedAttachments.length ? normalizedAttachments : undefined;
  return {
    attachments,
    hasInitialTurn: message !== undefined || attachments !== undefined,
    message,
  };
}

export function shouldAttachPendingMessageSeq(params: {
  cached?: boolean;
  payload: unknown;
}): boolean {
  if (params.cached) {
    return false;
  }
  const status =
    params.payload && typeof params.payload === "object"
      ? (params.payload as { status?: unknown }).status
      : undefined;
  return status === "started";
}

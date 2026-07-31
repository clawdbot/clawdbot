import {
  normalizeRpcAttachmentsToChatAttachments,
  type RpcAttachmentInput,
} from "./attachment-normalize.js";

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
  task?: unknown;
}) {
  const message = resolveOptionalInitialSessionMessage(params);
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

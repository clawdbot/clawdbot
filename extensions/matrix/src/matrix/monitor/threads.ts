// Matrix plugin module implements threads behavior.
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";

type MatrixThreadReplies = "off" | "inbound" | "always";

type MatrixThreadRouting = {
  threadId?: string;
};

export function resolveMatrixThreadSessionKeys(params: {
  baseSessionKey: string;
  threadId?: string | null;
  parentSessionKey?: string;
  useSuffix?: boolean;
}): { sessionKey: string; parentSessionKey?: string } {
  return resolveThreadSessionKeys({
    ...params,
    // Matrix event IDs are opaque and case-sensitive; keep the exact thread root.
    normalizeThreadId: (threadId) => threadId,
  });
}

export function resolveMatrixThreadRouting(params: {
  isDirectMessage: boolean;
  threadReplies: MatrixThreadReplies;
  dmThreadReplies?: MatrixThreadReplies;
  messageId: string;
  threadRootId?: string;
}): MatrixThreadRouting {
  const effectiveThreadReplies =
    params.isDirectMessage && params.dmThreadReplies !== undefined
      ? params.dmThreadReplies
      : params.threadReplies;
  const messageId = params.messageId.trim();
  const threadRootId = params.threadRootId?.trim();
  const inboundThreadId = threadRootId && threadRootId !== messageId ? threadRootId : undefined;
  const threadId =
    effectiveThreadReplies === "off"
      ? undefined
      : effectiveThreadReplies === "inbound"
        ? inboundThreadId
        : (inboundThreadId ?? (messageId || undefined));

  return {
    threadId,
  };
}

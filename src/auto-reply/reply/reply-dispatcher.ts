import { stripHeartbeatToken } from "../heartbeat.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";

export type ReplyDispatchKind = "tool" | "block" | "final";

type ReplyDispatchErrorHandler = (
  err: unknown,
  info: { kind: ReplyDispatchKind },
) => void;

type ReplyDispatchDeliverer = (
  payload: ReplyPayload,
  info: { kind: ReplyDispatchKind },
) => Promise<void>;

export type ReplyDispatcherOptions = {
  deliver: ReplyDispatchDeliverer;
  responsePrefix?: string;
  onHeartbeatStrip?: () => void;
  onIdle?: () => void;
  onError?: ReplyDispatchErrorHandler;
};

export type ReplyDispatcher = {
  sendToolResult: (payload: ReplyPayload) => boolean;
  sendBlockReply: (payload: ReplyPayload) => boolean;
  sendFinalReply: (payload: ReplyPayload) => boolean;
  waitForIdle: () => Promise<void>;
  getQueuedCounts: () => Record<ReplyDispatchKind, number>;
};

function normalizeReplyPayload(
  payload: ReplyPayload,
  opts: Pick<ReplyDispatcherOptions, "responsePrefix" | "onHeartbeatStrip">,
): ReplyPayload | null {
  const hasMedia = Boolean(
    payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0,
  );
  const trimmed = payload.text?.trim() ?? "";
  if (!trimmed && !hasMedia) return null;

  // Avoid sending the explicit silent token when no media is attached.
  if (trimmed === SILENT_REPLY_TOKEN && !hasMedia) return null;

  let text = payload.text ?? undefined;
  if (text && !trimmed) {
    // Keep empty text when media exists so media-only replies still send.
    text = "";
  }
  if (text?.includes(HEARTBEAT_TOKEN)) {
    const stripped = stripHeartbeatToken(text, { mode: "message" });
    if (stripped.didStrip) opts.onHeartbeatStrip?.();
    if (stripped.shouldSkip && !hasMedia) return null;
    text = stripped.text;
  }

  if (
    opts.responsePrefix &&
    text &&
    text.trim() !== HEARTBEAT_TOKEN &&
    !text.startsWith(opts.responsePrefix)
  ) {
    text = `${opts.responsePrefix} ${text}`;
  }

  return { ...payload, text };
}

export function createReplyDispatcher(
  options: ReplyDispatcherOptions,
): ReplyDispatcher {
  let sendChain: Promise<void> = Promise.resolve();
  // Track in-flight deliveries so we can emit a reliable "idle" signal.
  let pending = 0;
  // Serialize outbound replies to preserve tool/block/final order.
  const queuedCounts: Record<ReplyDispatchKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };

  const enqueue = (kind: ReplyDispatchKind, payload: ReplyPayload) => {
    const normalized = normalizeReplyPayload(payload, options);
    if (!normalized) return false;
    queuedCounts[kind] += 1;
    pending += 1;
    sendChain = sendChain
      .then(() => options.deliver(normalized, { kind }))
      .catch((err) => {
        options.onError?.(err, { kind });
      })
      .finally(() => {
        pending -= 1;
        if (pending === 0) {
          options.onIdle?.();
        }
      });
    return true;
  };

  return {
    sendToolResult: (payload) => enqueue("tool", payload),
    sendBlockReply: (payload) => enqueue("block", payload),
    sendFinalReply: (payload) => enqueue("final", payload),
    waitForIdle: () => sendChain,
    getQueuedCounts: () => ({ ...queuedCounts }),
  };
}

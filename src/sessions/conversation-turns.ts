import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type ConversationTurnReply = {
  conversationRef: string;
  messageId: string;
  replyToId?: string;
  threadId?: string;
  text: string;
  timestamp: number;
  transcriptArtifactId?: string;
  transcriptMessageId?: string;
};

type PendingConversationTurn = {
  key: string;
  agentId: string;
  id: string;
  conversationRef: string;
  sessionId: string;
  threadId?: string;
  createdAt: number;
  outboundMessageId?: string;
  correlationReady: Promise<void>;
  markCorrelationReady: () => void;
  stopTimeout: () => void;
  claimed: boolean;
  settle: (reply: ConversationTurnReply | undefined) => void;
};

type PendingConversationTurnHandle = {
  id: string;
  setOutboundMessageId: (messageId: string | undefined) => void;
  markReady: () => void;
  wait: () => Promise<ConversationTurnReply | undefined>;
  cancel: () => void;
};

type ConversationTurnReplyClaim = {
  turnId: string;
  sessionId: string;
  complete: (params?: { transcriptArtifactId?: string; transcriptMessageId?: string }) => void;
  release: () => void;
};

// Gateway RPC execution and inbound dispatch can live in different bundled chunks.
// Keep one process-wide registry so either chunk observes the same pending turn.
const pendingTurns = resolveGlobalSingleton(
  Symbol.for("openclaw.pendingConversationTurns"),
  () => new Map<string, PendingConversationTurn>(),
  (turns) => {
    for (const pending of turns.values()) {
      pending.settle(undefined);
    }
  },
);
const pendingTurnsByOutboundId = resolveGlobalSingleton(
  Symbol.for("openclaw.pendingConversationTurnsByOutboundId"),
  () => new Map<string, Set<PendingConversationTurn>>(),
  (turns) => turns.clear(),
);
function pendingTurnKey(agentId: string, id: string): string {
  return JSON.stringify([agentId, id]);
}

function outboundMessageKey(agentId: string, outboundMessageId: string): string {
  return JSON.stringify([agentId, outboundMessageId]);
}

function removePendingOutboundMembership(pending: PendingConversationTurn): void {
  if (!pending.outboundMessageId) {
    return;
  }
  const key = outboundMessageKey(pending.agentId, pending.outboundMessageId);
  const bucket = pendingTurnsByOutboundId.get(key);
  bucket?.delete(pending);
  if (bucket?.size === 0) {
    pendingTurnsByOutboundId.delete(key);
  }
}

/** Registers one process-local waiter; transcript correlation remains durable after completion. */
export function registerPendingConversationTurn(params: {
  agentId: string;
  id?: string;
  conversationRef: string;
  sessionId: string;
  threadId?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): PendingConversationTurnHandle {
  const agentId = normalizeOptionalString(params.agentId);
  if (!agentId) {
    throw new Error("conversation turn requires an agent id");
  }
  const id = normalizeOptionalString(params.id) ?? crypto.randomUUID();
  const key = pendingTurnKey(agentId, id);
  if (pendingTurns.has(key)) {
    throw new Error(`conversation turn already pending for ${agentId}: ${id}`);
  }
  const createdAt = Date.now();
  const timeoutMs = Math.max(0, params.timeoutMs);
  let settled = false;
  let resolvePromise: (reply: ConversationTurnReply | undefined) => void = () => undefined;
  const promise = new Promise<ConversationTurnReply | undefined>((resolve) => {
    resolvePromise = resolve;
  });
  let resolveCorrelationReady: () => void = () => undefined;
  const correlationReady = new Promise<void>((resolve) => {
    resolveCorrelationReady = resolve;
  });
  let correlationReadySettled = false;
  const markCorrelationReady = () => {
    if (correlationReadySettled) {
      return;
    }
    correlationReadySettled = true;
    resolveCorrelationReady();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopTimeout = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const settle = (reply: ConversationTurnReply | undefined) => {
    if (settled) {
      return;
    }
    settled = true;
    markCorrelationReady();
    removePendingOutboundMembership(pending);
    if (pendingTurns.get(key) === pending) {
      pendingTurns.delete(key);
    }
    stopTimeout();
    params.signal?.removeEventListener("abort", cancel);
    resolvePromise(reply);
  };
  const cancel = () => settle(undefined);
  const pending: PendingConversationTurn = {
    key,
    agentId,
    id,
    conversationRef: params.conversationRef,
    sessionId: params.sessionId,
    threadId: normalizeOptionalString(params.threadId),
    createdAt,
    correlationReady,
    markCorrelationReady,
    stopTimeout,
    claimed: false,
    settle,
  };
  pendingTurns.set(key, pending);
  timer = setTimeout(cancel, timeoutMs);
  timer.unref?.();
  params.signal?.addEventListener("abort", cancel, { once: true });
  if (params.signal?.aborted) {
    cancel();
  }
  return {
    id,
    setOutboundMessageId: (messageId) => {
      if (pendingTurns.get(key) !== pending) {
        return;
      }
      removePendingOutboundMembership(pending);
      pending.outboundMessageId = normalizeOptionalString(messageId);
      if (!pending.outboundMessageId) {
        pending.settle(undefined);
        return;
      }
      const outboundKey = outboundMessageKey(pending.agentId, pending.outboundMessageId);
      const bucket = pendingTurnsByOutboundId.get(outboundKey) ?? new Set();
      bucket.add(pending);
      pendingTurnsByOutboundId.set(outboundKey, bucket);
    },
    markReady: () => {
      if (pendingTurns.get(key) !== pending) {
        return;
      }
      if (pending.outboundMessageId) {
        pending.markCorrelationReady();
      } else {
        pending.settle(undefined);
      }
    },
    wait: async () => await promise,
    cancel,
  };
}

/** Cancels one Gateway-owned turn so a late reply follows ordinary inbound dispatch. */
export function cancelPendingConversationTurn(params: { agentId: string; id: string }): boolean {
  const agentId = normalizeOptionalString(params.agentId);
  const id = normalizeOptionalString(params.id);
  const pending = agentId && id ? pendingTurns.get(pendingTurnKey(agentId, id)) : undefined;
  if (!pending) {
    return false;
  }
  pending.settle(undefined);
  return true;
}

/** Claims a correlated inbound reply so the waiting turn can consume it without a second agent run. */
export async function claimPendingConversationTurnReply(params: {
  agentId: string;
  conversationRef: string;
  parentConversationRef?: string;
  sessionId: string;
  messageId: string;
  replyToId?: string;
  threadId?: string;
  text: string;
  timestamp?: number;
}): Promise<ConversationTurnReplyClaim | undefined> {
  const replyToId = normalizeOptionalString(params.replyToId);
  if (!replyToId) {
    return undefined;
  }
  const threadId = normalizeOptionalString(params.threadId);
  const parentConversationRef = normalizeOptionalString(params.parentConversationRef);
  const agentId = normalizeOptionalString(params.agentId);
  if (!agentId) {
    return undefined;
  }
  let pending: PendingConversationTurn | undefined;
  const candidates = pendingTurnsByOutboundId.get(outboundMessageKey(agentId, replyToId));
  for (const candidate of candidates ?? []) {
    if (
      candidate.claimed ||
      candidate.agentId !== agentId ||
      candidate.outboundMessageId !== replyToId ||
      (candidate.conversationRef !== params.conversationRef &&
        // Some transports promote an unthreaded message into a thread whose
        // id is that message id. Require the attested parent conversation too;
        // shared-main sessions can contain unrelated peers.
        (candidate.threadId ||
          threadId !== replyToId ||
          parentConversationRef !== candidate.conversationRef)) ||
      candidate.sessionId !== params.sessionId ||
      (candidate.threadId && threadId && candidate.threadId !== threadId)
    ) {
      continue;
    }
    if (!pending || candidate.createdAt < pending.createdAt) {
      pending = candidate;
    }
  }
  if (!pending) {
    return undefined;
  }
  pending.claimed = true;
  // Only an exact transport match can wait for outbound transcript durability.
  // Cancellation/deadline also releases this gate, so inbound dispatch stays bounded.
  await pending.correlationReady;
  if (pendingTurns.get(pending.key) !== pending) {
    return undefined;
  }
  // Keep the timer armed until complete(). The capture owner performs only a
  // synchronous guarded commit here; any accidental await yields so timeout wins.
  const reply: ConversationTurnReply = {
    conversationRef: params.conversationRef,
    messageId: params.messageId,
    ...(replyToId ? { replyToId } : {}),
    ...(threadId ? { threadId } : {}),
    text: params.text,
    timestamp: params.timestamp ?? Date.now(),
  };
  return {
    turnId: pending.id,
    sessionId: pending.sessionId,
    complete: (completion = {}) => {
      pending.settle({
        ...reply,
        ...(completion.transcriptArtifactId
          ? { transcriptArtifactId: completion.transcriptArtifactId }
          : {}),
        ...(completion.transcriptMessageId
          ? { transcriptMessageId: completion.transcriptMessageId }
          : {}),
      });
    },
    release: () => {
      // Persistence can fail after a transport reply was claimed. Keep the
      // waiter alive so a transport retry can claim it before the deadline.
      if (pendingTurns.get(pending.key) === pending) {
        pending.claimed = false;
      }
    },
  };
}

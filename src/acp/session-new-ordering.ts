import type { AnyMessage } from "@agentclientprotocol/sdk";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/**
 * Inbound requests that carry a session ID the protocol has already established:
 * the client is naming a session that exists independently of this connection, so
 * its updates must reach the wire immediately rather than waiting for a response.
 */
const SESSION_ESTABLISHING_METHODS = new Set(["session/load", "session/resume"]);

/**
 * Buffered state is driven by the peer, so every collection is bounded. Overflow
 * fails open — the update is written in arrival order — because dropping an update
 * loses session content, while emitting one early only restores the pre-fix ordering.
 */
const MAX_BUFFERED_SESSIONS = 64;
const MAX_BUFFERED_UPDATES_PER_SESSION = 256;
const MAX_PENDING_NEW_SESSION_REQUESTS = 64;

/** Keeps initial session updates behind the response that introduces their session ID. */
export class AcpSessionNewOrdering {
  /** Session IDs the protocol established, either by client assertion or by a `session/new` result. */
  private readonly establishedSessionIds = new Set<string>();
  private readonly bufferedSessionUpdates = new Map<string, AnyMessage[]>();
  /** JSON-RPC IDs of in-flight `session/new` requests, used to correlate the establishing response. */
  private readonly pendingNewSessionRequestIds = new Set<string>();
  /**
   * Updates released by an inbound message, which has no transform controller to
   * write to. The next outbound message drains them, so they are never dropped.
   */
  private readonly releasedUpdates: AnyMessage[] = [];

  observeInbound(message: AnyMessage): void {
    const messageObject = asOptionalRecord(message);
    const method = messageObject?.method;
    if (typeof method !== "string") {
      return;
    }

    if (method === "session/new") {
      const requestId = readRequestId(messageObject?.id);
      if (requestId !== undefined) {
        evictOldest(this.pendingNewSessionRequestIds, MAX_PENDING_NEW_SESSION_REQUESTS);
        this.pendingNewSessionRequestIds.add(requestId);
      }
      return;
    }

    const sessionId = readSessionId(messageObject?.params);
    if (!sessionId) {
      return;
    }

    // Any other method — `session/prompt` above all — may name a session that does
    // not exist. The translator rejects those, so recording them here would let a
    // peer grow this set for the lifetime of the process.
    if (SESSION_ESTABLISHING_METHODS.has(method)) {
      this.establishedSessionIds.add(sessionId);
      this.flushBufferedUpdates(sessionId);
      return;
    }

    if (method === "session/close") {
      // The session can never be introduced again, so anything still buffered for it
      // would be stranded. Release it and keep the ID established: a late update must
      // reach the wire rather than re-entering the buffer.
      this.flushBufferedUpdates(sessionId);
    }
  }

  transformOutbound(
    message: AnyMessage,
    controller: TransformStreamDefaultController<AnyMessage>,
  ): void {
    const messageObject = asOptionalRecord(message);

    if (this.releasedUpdates.length > 0) {
      for (const released of this.releasedUpdates.splice(0)) {
        controller.enqueue(released);
      }
    }

    const responseId = readRequestId(messageObject?.id);
    if (responseId !== undefined && this.pendingNewSessionRequestIds.delete(responseId)) {
      // The response to `session/new` always goes out first; it is what introduces
      // the session ID to the client. A failed creation carries no ID to establish.
      controller.enqueue(message);
      const establishedSessionId = readSessionId(messageObject?.result);
      if (establishedSessionId) {
        this.establishedSessionIds.add(establishedSessionId);
        this.drainBufferedUpdates(establishedSessionId, controller);
      }
      return;
    }

    const sessionId = readSessionId(messageObject?.params);
    if (
      messageObject?.method === "session/update" &&
      sessionId &&
      !this.establishedSessionIds.has(sessionId) &&
      this.bufferUpdate(sessionId, message)
    ) {
      return;
    }

    controller.enqueue(message);
  }

  /** @returns false when the buffer is full and the caller must write the message through. */
  private bufferUpdate(sessionId: string, message: AnyMessage): boolean {
    const buffered = this.bufferedSessionUpdates.get(sessionId);
    if (buffered) {
      if (buffered.length >= MAX_BUFFERED_UPDATES_PER_SESSION) {
        return false;
      }
      buffered.push(message);
      return true;
    }
    if (this.bufferedSessionUpdates.size >= MAX_BUFFERED_SESSIONS) {
      return false;
    }
    this.bufferedSessionUpdates.set(sessionId, [message]);
    return true;
  }

  private drainBufferedUpdates(
    sessionId: string,
    controller: TransformStreamDefaultController<AnyMessage>,
  ): void {
    const buffered = this.bufferedSessionUpdates.get(sessionId);
    if (!buffered) {
      return;
    }
    this.bufferedSessionUpdates.delete(sessionId);
    for (const message of buffered) {
      controller.enqueue(message);
    }
  }

  /**
   * Releases buffered updates from an inbound callback, where no controller exists.
   * They move to `releasedUpdates` rather than being discarded, and the next outbound
   * message drains them; FIFO order within the session is preserved throughout.
   */
  private flushBufferedUpdates(sessionId: string): void {
    const buffered = this.bufferedSessionUpdates.get(sessionId);
    if (!buffered) {
      return;
    }
    this.bufferedSessionUpdates.delete(sessionId);
    this.releasedUpdates.push(...buffered);
  }
}

function evictOldest(ids: Set<string>, limit: number): void {
  if (ids.size < limit) {
    return;
  }
  const oldest = ids.values().next();
  if (!oldest.done) {
    ids.delete(oldest.value);
  }
}

/** Normalizes a JSON-RPC ID, keeping the number `2` distinct from the string `"2"`. */
function readRequestId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `n:${value}`;
  }
  return typeof value === "string" && value.length > 0 ? `s:${value}` : undefined;
}

function readSessionId(value: unknown): string | undefined {
  const sessionId = asOptionalRecord(value)?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

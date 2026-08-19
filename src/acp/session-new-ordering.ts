import type { AnyMessage } from "@agentclientprotocol/sdk";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/**
 * Inbound requests that carry a session ID the protocol has already established:
 * the client is naming a session that exists independently of this connection, so
 * its updates must reach the wire immediately rather than waiting for a response.
 */
const SESSION_ESTABLISHING_METHODS = new Set(["session/load", "session/resume"]);

/**
 * Every collection here is filled by the peer, so every one is bounded and every
 * overflow fails open by writing the update through in arrival order. Dropping an
 * update loses session content permanently, while emitting one early only restores
 * the ordering that existed before this boundary.
 */
const MAX_BUFFERED_SESSIONS = 64;
const MAX_BUFFERED_UPDATES_PER_SESSION = 256;
const MAX_PENDING_NEW_SESSION_REQUESTS = 64;
const MAX_ESTABLISHED_SESSIONS = 1024;

/** Keeps initial session updates behind the response that introduces their session ID. */
export class AcpSessionNewOrdering {
  /** Session IDs the protocol established, either by client assertion or by a `session/new` result. */
  private readonly establishedSessionIds = new Set<string>();
  /**
   * Set once a session could not be recorded. Established and not-yet-established
   * are no longer distinguishable, so buffering stops rather than holding updates
   * that might never be released.
   */
  private establishedTrackingSaturated = false;
  private readonly bufferedSessionUpdates = new Map<string, AnyMessage[]>();
  /** JSON-RPC IDs of in-flight `session/new` requests, used to correlate the establishing response. */
  private readonly pendingNewSessionRequestIds = new Set<string>();
  /**
   * Set when a `session/new` arrived that could not be correlated. Some response we
   * will not recognize is then in flight, so buffering stops until the tracked
   * correlations drain: holding an update we cannot prove is releasable is what
   * strands it. Cleared when the pending set empties.
   */
  private correlationSaturated = false;
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
      if (requestId === undefined) {
        return;
      }
      if (this.pendingNewSessionRequestIds.size >= MAX_PENDING_NEW_SESSION_REQUESTS) {
        // A correlation is never evicted: its response is the only thing that can
        // release the updates already buffered for that session, so discarding one
        // would recreate the stall this boundary exists to prevent. Past the cap the
        // request is simply not correlated, and the boundary fails open until the
        // tracked correlations drain. Matching such a response by anything other
        // than its own request ID — a count, a shape — lets unrelated RPC traffic
        // claim it, which reintroduces the ordering failure from the other side.
        this.correlationSaturated = true;
        return;
      }
      this.pendingNewSessionRequestIds.add(requestId);
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
      this.establish(sessionId);
      this.flushBufferedUpdates(sessionId);
      return;
    }

    if (method === "session/close") {
      // The session is over, so release both its ID and anything still buffered for
      // it. Retaining the ID is what would let a long-lived bridge grow this set
      // without bound; a late update now passes through on the rule below instead.
      this.establishedSessionIds.delete(sessionId);
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
    if (responseId !== undefined) {
      if (this.pendingNewSessionRequestIds.delete(responseId)) {
        // The response to `session/new` always goes out first; it is what introduces
        // the session ID to the client. A failed creation carries no ID to establish.
        controller.enqueue(message);
        const sessionIdFromResult = readSessionId(messageObject?.result);
        if (sessionIdFromResult) {
          this.establish(sessionIdFromResult);
          this.drainBufferedUpdates(sessionIdFromResult, controller);
        }
        if (this.pendingNewSessionRequestIds.size === 0) {
          this.correlationSaturated = false;
        }
        this.releaseUnreachableUpdates(controller);
        return;
      }
    }

    const sessionId = readSessionId(messageObject?.params);
    if (
      messageObject?.method === "session/update" &&
      sessionId &&
      this.shouldBuffer(sessionId) &&
      this.bufferUpdate(sessionId, message)
    ) {
      return;
    }

    controller.enqueue(message);
  }

  /**
   * An update may only be held while some `session/new` response can still release
   * it. Nothing else introduces a session ID to the client, so buffering outside
   * that window would strand the update for the life of the process.
   */
  private shouldBuffer(sessionId: string): boolean {
    if (
      this.correlationSaturated ||
      this.establishedTrackingSaturated ||
      this.establishedSessionIds.has(sessionId)
    ) {
      return false;
    }
    return this.pendingNewSessionRequestIds.size > 0;
  }

  private establish(sessionId: string): void {
    if (
      !this.establishedSessionIds.has(sessionId) &&
      this.establishedSessionIds.size >= MAX_ESTABLISHED_SESSIONS
    ) {
      this.establishedTrackingSaturated = true;
      return;
    }
    this.establishedSessionIds.add(sessionId);
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
   * With no `session/new` correlation left in flight, nothing can introduce the
   * session IDs still buffered here, so they are written through in arrival order
   * rather than held for the life of the process.
   */
  private releaseUnreachableUpdates(
    controller: TransformStreamDefaultController<AnyMessage>,
  ): void {
    if (this.pendingNewSessionRequestIds.size > 0) {
      return;
    }
    for (const buffered of this.bufferedSessionUpdates.values()) {
      for (const message of buffered) {
        controller.enqueue(message);
      }
    }
    this.bufferedSessionUpdates.clear();
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

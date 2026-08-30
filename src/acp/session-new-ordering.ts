import type { AnyMessage } from "@agentclientprotocol/sdk";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/**
 * Inbound requests that carry a session ID the protocol has already established:
 * the client is naming a session that exists independently of this connection, so
 * its updates must reach the wire immediately rather than waiting for a response.
 */
const SESSION_ESTABLISHING_METHODS = new Set(["session/load", "session/resume"]);

/**
 * Every collection here is filled by the peer, so every one is bounded, and every
 * bound fails open by writing updates through in arrival order. Dropping an update
 * loses session content permanently, while emitting one early only restores the
 * ordering that existed before this boundary.
 */
// Sized to sit above what the agent itself admits — its default window allows well
// over a hundred creations — so ordinary accepted traffic can never overflow this
// and silently fall back to unordered delivery. A peer reaching it has paid for that
// many real session creations, and the per-session bound below still applies.
const MAX_QUEUED_SESSIONS = 512;
const MAX_QUEUED_UPDATES_PER_SESSION = 256;
const MAX_ESTABLISHED_SESSIONS = 1024;

type QueuedUpdate = { sessionId: string; message: AnyMessage };

/**
 * Keeps initial session updates behind the response that introduces their session ID.
 *
 * Two invariants carry the whole design:
 *
 * 1. An update is queued only while some `session/new` response can still release
 *    it. Nothing else introduces a session ID, so queuing outside that window would
 *    strand the update for the life of the process.
 * 2. The queue drains strictly from the front. An update is never emitted ahead of
 *    one that arrived earlier and is still blocked, so releasing never reorders
 *    updates against each other.
 */
export class AcpSessionNewOrdering {
  /** Session IDs the protocol established, either by client assertion or by a `session/new` result. */
  private readonly establishedSessionIds = new Set<string>();
  /** Queued updates in arrival order across all sessions; the only ordering authority. */
  private readonly queue: QueuedUpdate[] = [];
  /** Per-session queue depth, used only to enforce the bounds — never for ordering. */
  private readonly queuedPerSession = new Map<string, number>();
  /**
   * JSON-RPC IDs of in-flight `session/new` requests, used to correlate the
   * establishing response.
   *
   * Deliberately uncapped. An entry is one short string, it is removed by the
   * response to its own request, and every entry costs the peer a real session
   * creation — the agent's own admission limit bounds this long before memory
   * does. A cap here would be lower than the work the bridge already accepts, so
   * a legal burst would silently disable the ordering guarantee for the rest of
   * the process, which is worse than the growth it would prevent.
   */
  private readonly pendingNewSessionRequestIds = new Set<string>();

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
      return;
    }

    if (method === "session/close") {
      // Releasing the ID is what keeps this set bounded across a long-lived bridge,
      // and it frees capacity so later sessions can be tracked again. Anything still
      // queued for the session is released by the ordinary drain once no creation is
      // outstanding, so nothing needs to be special-cased here.
      this.establishedSessionIds.delete(sessionId);
    }
  }

  transformOutbound(
    message: AnyMessage,
    controller: TransformStreamDefaultController<AnyMessage>,
  ): void {
    const emit = (queued: AnyMessage) => controller.enqueue(queued);
    // Inbound events cannot write to the stream, so anything they unblocked is
    // released here, ahead of this message, which is where it arrived.
    this.drain(emit);

    const messageObject = asOptionalRecord(message);
    const responseId = isJsonRpcResponse(messageObject)
      ? readRequestId(messageObject?.id)
      : undefined;
    if (responseId !== undefined && this.pendingNewSessionRequestIds.delete(responseId)) {
      // The response to `session/new` always goes out first; it is what introduces
      // the session ID to the client. A failed creation carries no ID to establish.
      emit(message);
      const establishedSessionId = readSessionId(messageObject?.result);
      if (establishedSessionId) {
        this.establish(establishedSessionId);
      }
      this.drain(emit);
      return;
    }

    const sessionId = readSessionId(messageObject?.params);
    if (
      messageObject?.method === "session/update" &&
      sessionId &&
      this.shouldQueue(sessionId) &&
      this.enqueue(sessionId, message)
    ) {
      return;
    }

    emit(message);
  }

  private shouldQueue(sessionId: string): boolean {
    if (this.establishedSessionIds.has(sessionId) || this.isTrackingSaturated()) {
      return false;
    }
    return this.pendingNewSessionRequestIds.size > 0;
  }

  /**
   * Recomputed rather than latched: `session/close` frees capacity, and a bridge that
   * recovers room must recover ordering with it instead of failing open forever.
   */
  private isTrackingSaturated(): boolean {
    return this.establishedSessionIds.size >= MAX_ESTABLISHED_SESSIONS;
  }

  private establish(sessionId: string): void {
    if (!this.establishedSessionIds.has(sessionId) && this.isTrackingSaturated()) {
      return;
    }
    this.establishedSessionIds.add(sessionId);
  }

  /** @returns false when a bound is reached and the caller must write the update through. */
  private enqueue(sessionId: string, message: AnyMessage): boolean {
    const queued = this.queuedPerSession.get(sessionId);
    if (queued === undefined) {
      if (this.queuedPerSession.size >= MAX_QUEUED_SESSIONS) {
        return false;
      }
    } else if (queued >= MAX_QUEUED_UPDATES_PER_SESSION) {
      return false;
    }
    this.queue.push({ sessionId, message });
    this.queuedPerSession.set(sessionId, (queued ?? 0) + 1);
    return true;
  }

  /**
   * Emits from the front of the queue and stops at the first update that is still
   * blocked. A later update is never taken out of the middle, so updates keep their
   * arrival order relative to each other no matter which session settles first.
   *
   * With no creation outstanding, nothing can introduce the remaining session IDs,
   * so the rest is written through rather than held for the life of the process.
   */
  private drain(emit: (message: AnyMessage) => void): void {
    if (this.queue.length === 0) {
      return;
    }
    const nothingOutstanding = this.pendingNewSessionRequestIds.size === 0;
    let released = 0;
    while (released < this.queue.length) {
      const entry = this.queue[released];
      if (!nothingOutstanding && !this.establishedSessionIds.has(entry.sessionId)) {
        break;
      }
      emit(entry.message);
      const remaining = this.queuedPerSession.get(entry.sessionId) ?? 1;
      if (remaining <= 1) {
        this.queuedPerSession.delete(entry.sessionId);
      } else {
        this.queuedPerSession.set(entry.sessionId, remaining - 1);
      }
      released += 1;
    }
    if (released > 0) {
      this.queue.splice(0, released);
    }
  }
}

/**
 * A response carries `result` or `error` and no `method`. The outbound stream also
 * carries agent-initiated requests such as `requestPermission`, and a client-chosen
 * ID can collide with an in-flight `session/new`, so settling a correlation on the
 * ID alone would release a session's updates before its result.
 */
function isJsonRpcResponse(value: Record<string, unknown> | undefined): boolean {
  if (value === undefined || value.method !== undefined) {
    return false;
  }
  return value.result !== undefined || value.error !== undefined;
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

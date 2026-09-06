import type { AnyMessage } from "@agentclientprotocol/sdk";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/**
 * Inbound requests that carry a session ID the protocol has already established:
 * the client is naming a session that exists independently of this connection, so
 * its updates must reach the wire immediately rather than waiting for a response.
 */
const SESSION_ESTABLISHING_METHODS = new Set(["session/load", "session/resume"]);

/**
 * The one bound in this file. It caps how much of a single session's initial burst
 * is held, and fails open by writing the update through in arrival order: dropping
 * an update loses session content permanently, while emitting one early only
 * restores the ordering that existed before this boundary.
 *
 * Nothing else is capped, deliberately. The number of sessions with queued updates
 * is the number of accepted creations still outstanding, and the identifier sets
 * track work the bridge has already admitted. Every earlier cap on those sat below
 * what the bridge accepts, so ordinary traffic overflowed it and silently lost the
 * guarantee — a rate limit bounds arrivals, not concurrency, so no fixed number is
 * safe there.
 */
const MAX_QUEUED_UPDATES_PER_SESSION = 256;

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
  /**
   * Session IDs the protocol confirmed: a `session/new` result, or a load/resume
   * the agent accepted. Provisional claims live separately in `provisionalClaims`.
   *
   * Uncapped, and released by `forget` — on `session/close` and whenever the session
   * store removes the session itself. Every entry corresponds to a session
   * that is live on the Gateway side, which costs orders of magnitude more than the
   * ID string held here, so this can never be the binding constraint. Capping it
   * would mean a bridge that reaches the cap stops being able to tell an established
   * session from a pending one, and silently gives up ordering for the rest of its
   * life — the same trade that made the two bounds below wrong.
   */
  private readonly establishedSessionIds = new Set<string>();
  /** Queued updates in arrival order across all sessions; the only ordering authority. */
  private readonly queue: QueuedUpdate[] = [];
  /** Per-session queue depth, used only to enforce the bounds — never for ordering. */
  private readonly queuedPerSession = new Map<string, number>();
  /**
   * In-flight `session/load` / `session/resume` requests, keyed by JSON-RPC ID, with
   * the session each one named. Those IDs are established provisionally on arrival
   * so their updates are never delayed, but the agent can still reject the request
   * — a load carrying per-session MCP servers, for one — and a rejected ID must not
   * stay recognized: it is client-chosen, so leaving it would let a peer grow the
   * established set without bound. The error response retires it. Bounded by
   * in-flight loads, each of which is real work, and cleared by its own response.
   */
  private readonly provisionalSessions = new Map<string, string>();
  /**
   * How many in-flight load/resume requests currently claim each session. A session
   * is recognized while it is confirmed *or* while any claim on it is outstanding,
   * so a rejected claim retires only itself: if another request for the same
   * session succeeded meanwhile, or is still pending, recognition survives.
   */
  private readonly provisionalClaims = new Map<string, number>();
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
      // A load or resume is a claim on the session, recognized immediately so its
      // updates are never delayed, and confirmed or retired by its own response. It
      // never writes to the confirmed set directly: two overlapping claims on one
      // session must resolve independently, so that one failing cannot erase what
      // the other established.
      const requestId = readRequestId(messageObject?.id);
      if (requestId !== undefined) {
        this.provisionalSessions.set(requestId, sessionId);
        this.provisionalClaims.set(sessionId, (this.provisionalClaims.get(sessionId) ?? 0) + 1);
      }
      return;
    }

    if (method === "session/close") {
      this.forget(sessionId);
    }
  }

  /**
   * Stops recognizing a session. Called for `session/close`, and by the session
   * store for every removal it performs on its own — idle reaping and capacity
   * eviction produce no ACP request, so without this hook a long-lived bridge
   * would keep recognizing sessions the store had already discarded. Anything
   * still queued for the session is released by the ordinary drain once no
   * creation is outstanding, so nothing needs to be special-cased here.
   */
  forget(sessionId: string): void {
    this.establishedSessionIds.delete(sessionId);
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
    if (responseId !== undefined) {
      const claimed = this.provisionalSessions.get(responseId);
      if (claimed !== undefined) {
        this.provisionalSessions.delete(responseId);
        const remaining = (this.provisionalClaims.get(claimed) ?? 1) - 1;
        if (remaining > 0) {
          this.provisionalClaims.set(claimed, remaining);
        } else {
          this.provisionalClaims.delete(claimed);
        }
        if (messageObject?.error === undefined) {
          this.establish(claimed);
        }
        // A rejection retires only this claim. Recognition persists exactly when
        // the session is confirmed or another claim on it is still outstanding.
      }
    }
    if (responseId !== undefined && this.pendingNewSessionRequestIds.delete(responseId)) {
      // The response to `session/new` always goes out first; it is what introduces
      // the session ID to the client. A failed creation carries no ID to establish.
      emit(message);
      const establishedSessionId = readSessionId(messageObject?.result);
      if (establishedSessionId) {
        this.establish(establishedSessionId);
        // Release this session's backlog immediately rather than only the run at the
        // head of the global queue. Sessions are independent streams, so holding one
        // behind another buys no ordering the client can observe, while it does delay
        // this session's updates past frames that never enter the queue at all — a
        // prompt's completion response, above all, which would then arrive before the
        // text it completes.
        this.releaseSession(establishedSessionId, emit);
      }
      this.drain(emit);
      return;
    }

    const sessionId = readSessionId(messageObject?.params);
    if (
      messageObject?.method === "session/update" &&
      sessionId &&
      this.shouldQueue(sessionId) &&
      this.enqueue(sessionId, message, emit)
    ) {
      return;
    }

    emit(message);
  }

  private isRecognized(sessionId: string): boolean {
    return this.establishedSessionIds.has(sessionId) || this.provisionalClaims.has(sessionId);
  }

  private shouldQueue(sessionId: string): boolean {
    // A session with updates still queued keeps queuing, recognized or not, so a
    // newer update can never pass an older one from the same session. The backlog is
    // released whole when the session is introduced, so this holds only for as long
    // as the session has genuinely not reached the client.
    if (this.queuedPerSession.has(sessionId)) {
      return true;
    }
    if (this.isRecognized(sessionId)) {
      return false;
    }
    return this.pendingNewSessionRequestIds.size > 0;
  }

  private establish(sessionId: string): void {
    this.establishedSessionIds.add(sessionId);
  }

  /** @returns false when a bound is reached and the caller must write the update through. */
  private enqueue(
    sessionId: string,
    message: AnyMessage,
    emit: (message: AnyMessage) => void,
  ): boolean {
    const queued = this.queuedPerSession.get(sessionId) ?? 0;
    if (queued >= MAX_QUEUED_UPDATES_PER_SESSION) {
      // Fail open, but never out of order within the session: release everything
      // this session has queued, in order, before the caller writes this one through.
      // Cross-session order degrades here; intra-session order does not.
      this.releaseSession(sessionId, emit);
      return false;
    }
    this.queue.push({ sessionId, message });
    this.queuedPerSession.set(sessionId, queued + 1);
    return true;
  }

  /** Emits one session's queued updates in order and removes them from the queue. */
  private releaseSession(sessionId: string, emit: (message: AnyMessage) => void): void {
    if (!this.queuedPerSession.delete(sessionId)) {
      return;
    }
    let kept = 0;
    for (const entry of this.queue) {
      if (entry.sessionId === sessionId) {
        emit(entry.message);
        continue;
      }
      this.queue[kept] = entry;
      kept += 1;
    }
    this.queue.length = kept;
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
    for (const entry of this.queue) {
      if (!nothingOutstanding && !this.isRecognized(entry.sessionId)) {
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

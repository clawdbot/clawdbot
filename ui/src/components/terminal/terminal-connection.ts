// Typed terminal RPCs plus per-session event routing; DOM-free for focused tests.

import { BoundedBuffer } from "../../../../src/shared/bounded-buffer.ts";

type TerminalRequestOptions = { timeoutMs?: number | null; signal?: AbortSignal };

/** Minimal gateway surface the terminal needs; GatewayBrowserClient satisfies it. */
export interface TerminalGatewayClient {
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: TerminalRequestOptions,
  ): Promise<T>;
  addEventListener(listener: (evt: { event: string; payload: unknown }) => void): () => void;
  inboundActivitySeq?: number;
  /** Recovers unreplayable output gaps and half-open terminal streams. */
  forceReconnect(reason: string): void;
}

type TerminalOpenResult = {
  sessionId: string;
  agentId: string;
  shell: string;
  cwd: string;
  confined: boolean;
  title?: string;
};

type TerminalCatalogReference = {
  catalogId: string;
  hostId: string;
  threadId: string;
};

type TerminalAttachResult = TerminalOpenResult & {
  /** Recent output replayed into the emulator before live data resumes. */
  buffer: string;
  /** Cumulative UTF-16 output offset at the end of the replay snapshot. */
  seq?: number;
};

export type TerminalSessionInfo = {
  sessionId: string;
  agentId: string;
  shell: string;
  cwd: string;
  confined: boolean;
  attached: boolean;
  owner?: "conn" | `agent:${string}`;
  createdAtMs: number;
};

type TerminalExitInfo = {
  exitCode: number | null;
  signal: number | null;
  reason?: string;
  error?: string;
};

type SessionSink = {
  onData: (data: string) => void;
  /** Clears emulator state before replaying the authoritative ring snapshot. */
  onReplay?: (data: string, newlyObservedFrom: number) => void;
  onExit: (info: TerminalExitInfo) => void;
};

type StreamState = {
  sink: SessionSink;
  seqMode: "unknown" | "offset" | "counter";
  expectedSeq: number | null;
  recovering: boolean;
};

type PendingEvent =
  | { kind: "data"; seq: number; data: string }
  | { kind: "exit"; info: TerminalExitInfo };

const TERMINAL_LIVENESS_IDLE_MS = 20_000;
const TERMINAL_LIVENESS_PROBE_TIMEOUT_MS = 5_000;
const TERMINAL_LIVENESS_MAX_CONSECUTIVE_FAILURES = 2;
const TERMINAL_LIVENESS_FAILURE_RETRY_MS = 5_000;
// The Gateway owns the 30s open deadline. This longer browser watchdog only
// recovers a half-open socket when the Gateway's response cannot arrive.
const TERMINAL_OPEN_WATCHDOG_MS = 35_000;
export class TerminalOpenTimeoutError extends Error {
  constructor(cause: unknown) {
    super("terminal open timed out", { cause });
    this.name = "TerminalOpenTimeoutError";
  }
}

function isTerminalOpenRequestTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^gateway request timed out after \d+ms: terminal\.open$/u.test(error.message)
  );
}

function isTerminalOpenTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "terminal open timed out" || isTerminalOpenRequestTimeout(error))
  );
}

/** Routes the shared terminal event stream to the session that owns each id. */
export class TerminalConnection {
  private readonly client: TerminalGatewayClient;
  private readonly streams = new Map<string, StreamState>();
  // Events can race ahead of open/attach responses. Preserve their seq so a
  // capped buffer becomes a detectable gap instead of silent output loss.
  private readonly pending = new Map<string, BoundedBuffer<PendingEvent>>();
  private unsubscribe: (() => void) | null = null;
  private pendingOpenCount = 0;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessProbeInFlight = false;
  private livenessProbeFailures = 0;
  private lastLivenessFailureActivityVersion: number | null = null;
  private lastTerminalActivityAtMs = Date.now();
  private inboundActivityVersion = 0;

  // Failed opens never register, so bound their pre-registration output.
  private static readonly MAX_PENDING_EVENTS = 512;

  constructor(client: TerminalGatewayClient) {
    this.client = client;
  }

  /** Starts listening for terminal events; idempotent. */
  private ensureSubscribed(): void {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.client.addEventListener((evt) => {
      if (evt.event === "terminal.data") {
        this.noteTerminalActivity();
        const payload = evt.payload as
          | { sessionId?: string; seq?: number; data?: string }
          | undefined;
        if (
          payload?.sessionId &&
          typeof payload.seq === "number" &&
          typeof payload.data === "string"
        ) {
          const frame = { kind: "data" as const, seq: payload.seq, data: payload.data };
          const stream = this.streams.get(payload.sessionId);
          if (stream) {
            this.deliverData(payload.sessionId, stream, frame);
          } else {
            this.bufferEarly(payload.sessionId, frame);
          }
        }
        return;
      }
      if (evt.event === "terminal.exit") {
        this.noteTerminalActivity();
        const payload = evt.payload as
          | {
              sessionId?: string;
              exitCode?: number | null;
              signal?: number | null;
              reason?: string;
              error?: string;
            }
          | undefined;
        if (payload?.sessionId) {
          const info: TerminalExitInfo = {
            exitCode: payload.exitCode ?? null,
            signal: payload.signal ?? null,
            reason: payload.reason,
            error: payload.error,
          };
          const stream = this.streams.get(payload.sessionId);
          if (stream) {
            if (stream.recovering) {
              this.bufferEarly(payload.sessionId, { kind: "exit", info });
            } else {
              this.deliverExit(payload.sessionId, stream.sink, info);
            }
          } else {
            this.bufferEarly(payload.sessionId, { kind: "exit", info });
          }
        }
      }
    });
  }

  /** Opens a session and registers its output/exit sinks before returning. */
  async open(
    params: { agentId?: string; cols: number; rows: number; catalog?: TerminalCatalogReference },
    sink: SessionSink,
  ): Promise<TerminalOpenResult> {
    let result: TerminalOpenResult;
    try {
      result = await this.requestWhileHoldingStream(() =>
        this.client.request<TerminalOpenResult>("terminal.open", params, {
          timeoutMs: TERMINAL_OPEN_WATCHDOG_MS,
        }),
      );
    } catch (error) {
      if (!isTerminalOpenTimeout(error)) {
        throw error;
      }
      if (isTerminalOpenRequestTimeout(error)) {
        // The server should answer first. A later browser timeout means this
        // socket cannot carry the response, so disconnect to cancel ownership.
        this.forceReconnect("terminal open watchdog timeout");
      }
      throw new TerminalOpenTimeoutError(error);
    }
    this.adoptSession(result.sessionId, sink, { seqMode: "unknown", expectedSeq: 0 });
    return result;
  }

  /** Rebinds a session and resets the emulator to its authoritative replay. */
  async attach(sessionId: string, sink: SessionSink): Promise<TerminalAttachResult> {
    const result = await this.requestWhileHoldingStream(() =>
      this.client.request<TerminalAttachResult>("terminal.attach", { sessionId }),
    );
    const offset =
      typeof result.seq === "number" && Number.isSafeInteger(result.seq) ? result.seq : null;
    this.adoptSession(
      sessionId,
      sink,
      offset !== null
        ? { seqMode: "offset", expectedSeq: offset }
        : { seqMode: "counter", expectedSeq: null },
      result.buffer,
      // Old protocol-4 replies have no snapshot high-water. Preserve raced
      // counter frames because they may have been emitted after the snapshot.
      offset ?? undefined,
    );
    return result;
  }

  async list(): Promise<TerminalSessionInfo[]> {
    const result = await this.client.request<{ sessions?: TerminalSessionInfo[] }>("terminal.list");
    return result?.sessions ?? [];
  }

  private async requestWhileHoldingStream<T>(run: () => Promise<T>): Promise<T> {
    this.ensureSubscribed();
    this.pendingOpenCount += 1;
    try {
      const result = await run();
      this.pendingOpenCount -= 1;
      return result;
    } catch (err) {
      this.pendingOpenCount -= 1;
      this.maybeUnsubscribe();
      throw err;
    }
  }

  /** Registers a sink, then flushes events that raced after open/attach. */
  private adoptSession(
    sessionId: string,
    sink: SessionSink,
    baseline: Pick<StreamState, "seqMode" | "expectedSeq">,
    replay?: string,
    coveredThroughSeq?: number,
  ): void {
    const stream: StreamState = { sink, ...baseline, recovering: false };
    this.streams.set(sessionId, stream);
    this.lastTerminalActivityAtMs = Date.now();
    if (replay !== undefined) {
      if (sink.onReplay) {
        sink.onReplay(replay, replay.length);
      } else {
        sink.onData(replay);
      }
    }
    this.flushPending(sessionId, stream, coveredThroughSeq, replay !== undefined);
    this.scheduleLivenessCheck();
  }

  /** Validates one frame's arithmetic continuity before exposing its bytes. */
  private deliverData(
    sessionId: string,
    stream: StreamState,
    frame: Extract<PendingEvent, { kind: "data" }>,
  ): void {
    if (stream.recovering) {
      this.bufferEarly(sessionId, frame);
      return;
    }
    if (!Number.isSafeInteger(frame.seq)) {
      this.recoverGap(sessionId, stream, frame);
      return;
    }
    if (stream.seqMode === "counter") {
      // Shipped protocol-4 counters were diagnostic-only. Jumps cannot prove
      // byte loss, and legacy attach replies lack a replay high-water.
      stream.expectedSeq = frame.seq + 1;
      stream.sink.onData(frame.data);
      return;
    }
    const startOfChunk = frame.seq - frame.data.length;
    if (startOfChunk === stream.expectedSeq) {
      if (frame.data.length > 0) {
        stream.seqMode = "offset";
      }
      stream.expectedSeq = frame.seq;
      stream.sink.onData(frame.data);
      return;
    }
    // Shipped protocol-4 gateways started their per-frame counter at zero.
    if (stream.seqMode === "unknown" && stream.expectedSeq === 0 && frame.seq === 0) {
      stream.seqMode = "counter";
      stream.expectedSeq = 1;
      stream.sink.onData(frame.data);
      return;
    }
    this.recoverGap(sessionId, stream, frame);
  }

  /** Re-attaches once; its snapshot includes the frame that exposed the gap. */
  private recoverGap(
    sessionId: string,
    stream: StreamState,
    gapFrame: Extract<PendingEvent, { kind: "data" }>,
  ): void {
    if (stream.recovering) {
      return;
    }
    stream.recovering = true;
    void this.client
      .request<TerminalAttachResult>("terminal.attach", { sessionId })
      .then((result) => {
        if (this.streams.get(sessionId) !== stream) {
          return;
        }
        const offset =
          typeof result.seq === "number" && Number.isSafeInteger(result.seq) ? result.seq : null;
        if (offset === null) {
          // Version-skew fallback: a legacy snapshot cannot identify which
          // queued counter frames it covers. Keep the live stream exactly once.
          stream.seqMode = "counter";
          stream.expectedSeq = null;
          stream.recovering = false;
          this.deliverData(sessionId, stream, gapFrame);
          this.flushPending(sessionId, stream, undefined, true);
          return;
        }
        const previouslyObservedThrough = stream.expectedSeq;
        stream.seqMode = "offset";
        stream.expectedSeq = offset;
        if (!stream.sink.onReplay) {
          // Recovery must replace emulator state. Appending a full ring replay
          // would duplicate bytes already rendered before the detected gap.
          stream.recovering = false;
          this.pending.delete(sessionId);
          this.forceReconnect("terminal replay reset unavailable");
          return;
        }
        // The ring may include both bytes already delivered and the gap's
        // missing suffix. Preserve that boundary so response-producing
        // emulators do not answer historical control queries twice.
        const replayStart = offset - result.buffer.length;
        const newlyObservedFrom =
          typeof previouslyObservedThrough === "number"
            ? Math.max(0, Math.min(result.buffer.length, previouslyObservedThrough - replayStart))
            : 0;
        stream.sink.onReplay(result.buffer, newlyObservedFrom);
        stream.recovering = false;
        this.flushPending(sessionId, stream, offset, true);
      })
      .catch(() => {
        if (this.streams.get(sessionId) !== stream) {
          return;
        }
        const queued = this.pending.get(sessionId)?.drain();
        if (queued?.some((event) => event.kind === "exit")) {
          // The process can exit before the recovery attach finds it. Preserve
          // every received tail frame, then surface the terminal exit once.
          this.pending.delete(sessionId);
          stream.recovering = false;
          stream.sink.onData(gapFrame.data);
          for (const event of queued) {
            if (event.kind === "data") {
              stream.sink.onData(event.data);
            } else {
              this.deliverExit(sessionId, stream.sink, event.info);
              break;
            }
          }
          return;
        }
        stream.recovering = false;
        this.pending.delete(sessionId);
        this.forceReconnect("terminal replay failed");
      });
  }

  private flushPending(
    sessionId: string,
    stream: StreamState,
    coveredThroughSeq?: number,
    discardPreAttachDetachedExit = false,
  ): void {
    const pending = this.pending.get(sessionId);
    if (!pending) {
      return;
    }
    this.pending.delete(sessionId);
    const events = pending.drain();
    for (const event of events) {
      if (this.streams.get(sessionId) !== stream) {
        break;
      }
      // A successful attach reestablishes ownership after earlier events. A
      // preceding detach notice is stale and must not kill the rebound stream.
      if (
        discardPreAttachDetachedExit &&
        event.kind === "exit" &&
        event.info.reason === "detached"
      ) {
        continue;
      }
      if (event.kind === "data") {
        // Frames emitted before the server took its attach snapshot can reach
        // the browser first. The replay already contains them; never duplicate
        // them or mistake them for a second gap.
        if (coveredThroughSeq !== undefined && event.seq <= coveredThroughSeq) {
          continue;
        }
        this.deliverData(sessionId, stream, event);
      } else if (stream.recovering) {
        this.bufferEarly(sessionId, event);
      } else {
        this.deliverExit(sessionId, stream.sink, event.info);
      }
    }
  }

  /** Own cleanup: replayed exits can arrive before the caller records the session id. */
  private deliverExit(sessionId: string, sink: SessionSink, info: TerminalExitInfo): void {
    sink.onExit(info);
    this.streams.delete(sessionId);
    this.pending.delete(sessionId);
    this.maybeUnsubscribe();
  }

  private bufferEarly(sessionId: string, event: PendingEvent): void {
    const buffer =
      this.pending.get(sessionId) ??
      new BoundedBuffer<PendingEvent>(TerminalConnection.MAX_PENDING_EVENTS, {
        mode: "drop-oldest",
      });
    this.pending.set(sessionId, buffer);
    buffer.push(event);
  }

  /** Terminal traffic delays the next probe without resetting a timer per chunk. */
  private noteTerminalActivity(): void {
    this.resetLivenessProbeFailures();
    this.lastTerminalActivityAtMs = Date.now();
    this.inboundActivityVersion += 1;
  }

  private forceReconnect(reason: string): void {
    this.resetLivenessProbeFailures();
    this.client.forceReconnect(reason);
  }

  private resetLivenessProbeFailures(): void {
    this.livenessProbeFailures = 0;
    this.lastLivenessFailureActivityVersion = null;
  }

  private scheduleLivenessCheck(delayMs = TERMINAL_LIVENESS_IDLE_MS): void {
    if (this.livenessTimer || this.livenessProbeInFlight || this.streams.size === 0) {
      return;
    }
    this.livenessTimer = setTimeout(
      () => {
        this.livenessTimer = null;
        this.checkLiveness();
      },
      Math.max(0, delayMs),
    );
  }

  private checkLiveness(): void {
    if (this.streams.size === 0) {
      return;
    }
    const remaining = TERMINAL_LIVENESS_IDLE_MS - (Date.now() - this.lastTerminalActivityAtMs);
    if (remaining > 0) {
      this.scheduleLivenessCheck(remaining);
      return;
    }
    const activityBefore = this.client.inboundActivitySeq ?? this.inboundActivityVersion;
    if (
      this.lastLivenessFailureActivityVersion !== null &&
      activityBefore !== this.lastLivenessFailureActivityVersion
    ) {
      // A frame arrived since the last failed probe, so the socket is proven alive. Treat it like
      // any other activity: restart the full idle window instead of immediately re-probing on the
      // short failure-retry backoff (matches the during-probe activity path).
      this.resetLivenessProbeFailures();
      this.lastTerminalActivityAtMs = Date.now();
      this.scheduleLivenessCheck();
      return;
    }
    let nextDelayMs = TERMINAL_LIVENESS_IDLE_MS;
    this.livenessProbeInFlight = true;
    void this.client
      .request("terminal.list", undefined, { timeoutMs: TERMINAL_LIVENESS_PROBE_TIMEOUT_MS })
      .then(() => {
        // The response itself proves the inbound half of the socket is alive.
        this.resetLivenessProbeFailures();
        this.lastTerminalActivityAtMs = Date.now();
      })
      .catch(() => {
        if (this.streams.size === 0) {
          this.resetLivenessProbeFailures();
          return;
        }
        const activityNow = this.client.inboundActivitySeq ?? this.inboundActivityVersion;
        if (activityNow !== activityBefore) {
          // Any valid inbound frame proves the socket is not half-open.
          this.resetLivenessProbeFailures();
          this.lastTerminalActivityAtMs = Date.now();
          return;
        }
        this.livenessProbeFailures += 1;
        this.lastLivenessFailureActivityVersion = activityNow;
        if (this.livenessProbeFailures >= TERMINAL_LIVENESS_MAX_CONSECUTIVE_FAILURES) {
          // One probe cannot distinguish a dead socket from a stalled Gateway event loop.
          this.forceReconnect("terminal liveness timeout");
          return;
        }
        // Keep the old activity time so the short retry performs another probe.
        nextDelayMs = TERMINAL_LIVENESS_FAILURE_RETRY_MS;
      })
      .finally(() => {
        this.livenessProbeInFlight = false;
        this.scheduleLivenessCheck(nextDelayMs);
      });
  }

  async input(sessionId: string, data: string): Promise<void> {
    await this.client.request("terminal.input", { sessionId, data }).catch(() => undefined);
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.client.request("terminal.resize", { sessionId, cols, rows }).catch(() => undefined);
  }

  /** Closes a session server-side and drops its local stream state. */
  async close(sessionId: string): Promise<void> {
    this.streams.delete(sessionId);
    this.pending.delete(sessionId);
    await this.client.request("terminal.close", { sessionId }).catch(() => undefined);
    // terminal.exit precedes the close response and can otherwise be buffered.
    this.pending.delete(sessionId);
    this.maybeUnsubscribe();
  }

  get size(): number {
    return this.streams.size;
  }

  dispose(): void {
    this.streams.clear();
    this.pending.clear();
    this.stopLiveness();
    this.dropSubscriptions();
  }

  private maybeUnsubscribe(): void {
    if (this.streams.size === 0 && this.pendingOpenCount === 0) {
      this.pending.clear();
      this.stopLiveness();
      this.dropSubscriptions();
    }
  }

  private stopLiveness(): void {
    this.resetLivenessProbeFailures();
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  private dropSubscriptions(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

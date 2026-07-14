// Terminal protocol layer: wraps the gateway client with typed
// terminal.* RPCs and fans the terminal.data / terminal.exit event stream out to
// per-session sinks. Kept DOM-free so it can be unit tested without ghostty-web.

/** Minimal gateway surface the terminal needs; GatewayBrowserClient satisfies it. */
export interface TerminalGatewayClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  addEventListener(listener: (evt: { event: string; payload: unknown }) => void): () => void;
}

type TerminalOpenResult = {
  sessionId: string;
  agentId: string;
  shell: string;
  cwd: string;
  confined: boolean;
};

type TerminalAttachResult = TerminalOpenResult & {
  /** Recent output replayed into the emulator before live data resumes. */
  buffer: string;
};

type TerminalSessionInfo = {
  sessionId: string;
  agentId: string;
  shell: string;
  cwd: string;
  confined: boolean;
  attached: boolean;
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
  onExit: (info: TerminalExitInfo) => void;
};

/** An event buffered before its session sink was registered. */
type PendingEvent = { kind: "data"; data: string } | { kind: "exit"; info: TerminalExitInfo };

/** Routes the shared terminal event stream to the session that owns each id. */
export class TerminalConnection {
  private readonly client: TerminalGatewayClient;
  private readonly sinks = new Map<string, SessionSink>();
  // Events that arrive after the terminal.open RPC response but before the
  // caller registers its sink (the server wires the PTY before responding, so a
  // prompt/MOTD — or an instant exit — can race ahead). Buffered in arrival
  // order per session and flushed on register so nothing is dropped.
  private readonly pending = new Map<string, PendingEvent[]>();
  private unsubscribe: (() => void) | null = null;
  // Opens still awaiting their RPC response; keeps the subscription alive so
  // their early output is buffered even if every registered session closes.
  private pendingOpenCount = 0;

  // Bounds the pre-registration buffer so a session that never registers (e.g.
  // its open failed after the server started streaming) cannot grow unbounded.
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
        const payload = evt.payload as { sessionId?: string; data?: string } | undefined;
        if (payload?.sessionId && typeof payload.data === "string") {
          const sink = this.sinks.get(payload.sessionId);
          if (sink) {
            sink.onData(payload.data);
          } else {
            this.bufferEarly(payload.sessionId, { kind: "data", data: payload.data });
          }
        }
        return;
      }
      if (evt.event === "terminal.exit") {
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
          const sink = this.sinks.get(payload.sessionId);
          if (sink) {
            this.deliverExit(payload.sessionId, sink, info);
          } else {
            // An instant-exiting shell can emit exit before its sink registers;
            // buffer it so the UI does not keep a live tab for a dead session.
            this.bufferEarly(payload.sessionId, { kind: "exit", info });
          }
        }
      }
    });
  }

  /** Opens a session and registers its output/exit sinks before returning. */
  async open(
    params: { agentId?: string; cols: number; rows: number },
    sink: SessionSink,
  ): Promise<TerminalOpenResult> {
    const result = await this.requestWhileHoldingStream(() =>
      this.client.request<TerminalOpenResult>("terminal.open", params),
    );
    this.adoptSession(result.sessionId, sink);
    return result;
  }

  /**
   * Rebinds an existing (usually detached) session to this connection and
   * replays its buffered output into the sink before live data resumes.
   */
  async attach(sessionId: string, sink: SessionSink): Promise<TerminalAttachResult> {
    const result = await this.requestWhileHoldingStream(() =>
      this.client.request<TerminalAttachResult>("terminal.attach", { sessionId }),
    );
    this.adoptSession(sessionId, sink, result.buffer);
    return result;
  }

  /** Sessions this operator could attach; empty when the surface is off. */
  async list(): Promise<TerminalSessionInfo[]> {
    const result = await this.client.request<{ sessions?: TerminalSessionInfo[] }>("terminal.list");
    return result?.sessions ?? [];
  }

  /**
   * Holds the event subscription while an open/attach RPC is in flight so a
   * concurrent close/exit on another session cannot drop the listener and lose
   * this session's early output.
   */
  private async requestWhileHoldingStream<T>(run: () => Promise<T>): Promise<T> {
    this.ensureSubscribed();
    this.pendingOpenCount += 1;
    try {
      const result = await run();
      this.pendingOpenCount -= 1;
      return result;
    } catch (err) {
      // A rejected open/attach (sandboxed agent, disabled terminal, expired
      // session, disconnect race) never registers a sink. Drop the listener
      // when no sessions remain so repeated failures across reconnects don't
      // accumulate listeners on the shared gateway client.
      this.pendingOpenCount -= 1;
      this.maybeUnsubscribe();
      throw err;
    }
  }

  /** Registers a sink, replaying the attach buffer first, then early events. */
  private adoptSession(sessionId: string, sink: SessionSink, replay?: string): void {
    this.sinks.set(sessionId, sink);
    if (replay) {
      sink.onData(replay);
    }
    // Replay any events that raced ahead of registration, in arrival order.
    // These are post-snapshot bytes, so they follow the attach replay.
    const early = this.pending.get(sessionId);
    if (early) {
      this.pending.delete(sessionId);
      for (const event of early) {
        if (event.kind === "data") {
          sink.onData(event.data);
        } else {
          this.deliverExit(sessionId, sink, event.info);
        }
      }
    }
  }

  /**
   * Delivers a terminal exit and drops the session's own sink. The connection
   * owns this cleanup (rather than the caller) because an exit can be replayed
   * during open() before the caller has recorded the session id, so caller-side
   * release would target an empty id and leak the sink.
   */
  private deliverExit(sessionId: string, sink: SessionSink, info: TerminalExitInfo): void {
    sink.onExit(info);
    this.sinks.delete(sessionId);
    this.pending.delete(sessionId);
    this.maybeUnsubscribe();
  }

  /** Buffers a pre-registration event, dropping the oldest once the cap is hit. */
  private bufferEarly(sessionId: string, event: PendingEvent): void {
    let buf = this.pending.get(sessionId);
    if (!buf) {
      buf = [];
      this.pending.set(sessionId, buf);
    }
    buf.push(event);
    if (buf.length > TerminalConnection.MAX_PENDING_EVENTS) {
      buf.shift();
    }
  }

  /** Sends client input; failures are swallowed since the exit event drives teardown. */
  async input(sessionId: string, data: string): Promise<void> {
    await this.client.request("terminal.input", { sessionId, data }).catch(() => undefined);
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.client.request("terminal.resize", { sessionId, cols, rows }).catch(() => undefined);
  }

  /** Closes a session server-side and drops its local sink. */
  async close(sessionId: string): Promise<void> {
    this.sinks.delete(sessionId);
    this.pending.delete(sessionId);
    await this.client.request("terminal.close", { sessionId }).catch(() => undefined);
    // The server emits this session's final terminal.exit while handling the
    // close RPC (the event frame precedes the response), and with the sink
    // already gone it lands in the early-event buffer. Drop it again or closed
    // ids accumulate for the lifetime of the subscription.
    this.pending.delete(sessionId);
    this.maybeUnsubscribe();
  }

  /** Number of live session sinks; used by the panel and tests. */
  get size(): number {
    return this.sinks.size;
  }

  /**
   * Drops the gateway subscription and all buffered state. The panel calls this
   * when it discards the connection (disconnect/disable) so the listener does
   * not outlive the connection and leak on the shared gateway client.
   */
  dispose(): void {
    this.sinks.clear();
    this.pending.clear();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  private maybeUnsubscribe(): void {
    if (this.sinks.size === 0 && this.pendingOpenCount === 0 && this.unsubscribe) {
      // No live sessions and no opens in flight: drop the listener and any
      // orphaned early-output buffers too.
      this.pending.clear();
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}

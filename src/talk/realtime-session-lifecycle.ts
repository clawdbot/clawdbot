const REALTIME_VOICE_MAX_PENDING_AUDIO_CHUNKS = 320;
const REALTIME_VOICE_MAX_PENDING_AUDIO_BYTES = 1024 * 1024;

type RealtimeVoiceAudioOverflowPolicy = "drop-oldest" | "reject-newest";

export type RealtimeVoiceAudioQueue = {
  clear: () => void;
  drain: () => Buffer[];
  enqueue: (audio: Buffer) => boolean;
};

export function createRealtimeVoiceAudioQueue(
  overflowPolicy: RealtimeVoiceAudioOverflowPolicy,
): RealtimeVoiceAudioQueue {
  let chunks: Buffer[] = [];
  let bytes = 0;

  const clear = () => {
    chunks = [];
    bytes = 0;
  };

  return {
    clear,
    drain: () => {
      const drained = chunks;
      clear();
      return drained;
    },
    enqueue: (audio) => {
      if (audio.byteLength > REALTIME_VOICE_MAX_PENDING_AUDIO_BYTES) {
        return false;
      }
      if (
        overflowPolicy === "reject-newest" &&
        (chunks.length >= REALTIME_VOICE_MAX_PENDING_AUDIO_CHUNKS ||
          bytes + audio.byteLength > REALTIME_VOICE_MAX_PENDING_AUDIO_BYTES)
      ) {
        return false;
      }
      while (
        chunks.length >= REALTIME_VOICE_MAX_PENDING_AUDIO_CHUNKS ||
        bytes + audio.byteLength > REALTIME_VOICE_MAX_PENDING_AUDIO_BYTES
      ) {
        const dropped = chunks.shift();
        if (!dropped) {
          return false;
        }
        bytes -= dropped.byteLength;
      }
      // Capture transports can recycle caller-owned views before provider readiness,
      // so the queue owns an immutable copy of every accepted chunk.
      const chunk = Buffer.from(audio);
      chunks.push(chunk);
      bytes += chunk.byteLength;
      return true;
    },
  };
}

type RealtimeVoiceSessionPhase = "idle" | "connecting" | "ready" | "retry-wait" | "terminal";
type RealtimeVoiceTerminalOutcome = "completed" | "error";

export type RealtimeVoiceSessionConnection = Readonly<{
  id: symbol;
  signal: AbortSignal;
}>;

type RealtimeVoiceIdleState = {
  phase: "idle" | "terminal";
  terminalOutcome?: "completed";
};

type RealtimeVoiceConnectionState = {
  connection: RealtimeVoiceSessionConnection;
  controller: AbortController;
  phase: Exclude<RealtimeVoiceSessionPhase, "idle">;
  retryAttempts: number;
  terminalOutcome?: RealtimeVoiceTerminalOutcome;
  terminalNotified: boolean;
};

type RealtimeVoiceConnectAttempt = {
  readonly promise: Promise<void>;
  readonly ready: boolean;
  readonly settled: boolean;
  readonly startupFailed: boolean;
  reject: (error: Error) => void;
  rejectStartup: (error: Error) => boolean;
  resolve: (providerReady?: boolean) => void;
  startTimeout: () => void;
};

type RealtimeVoiceConnectAttemptOptions = {
  connection: RealtimeVoiceSessionConnection;
  onAbort: (outcome: RealtimeVoiceTerminalOutcome | undefined) => void;
  onTimeout: () => void;
  timeoutError: () => Error;
  timeoutMs: number;
};

export class RealtimeVoiceSessionLifecycle {
  private state: RealtimeVoiceIdleState | RealtimeVoiceConnectionState = { phase: "idle" };
  private connectPromise: Promise<void> | undefined;
  private readonly pendingAudio = createRealtimeVoiceAudioQueue("reject-newest");

  constructor(private readonly label: string) {}

  connect(start: (connection: RealtimeVoiceSessionConnection) => Promise<void>): Promise<void> {
    if (this.isReady()) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    const connection = this.createFreshConnection();
    const promise = start(connection);
    this.connectPromise = promise;
    const clear = () => {
      if (this.connectPromise === promise) {
        this.connectPromise = undefined;
      }
    };
    void promise.then(clear, clear);
    return promise;
  }

  reconnect(
    connection: RealtimeVoiceSessionConnection,
  ): RealtimeVoiceSessionConnection | undefined {
    const state = this.currentState(connection);
    if (!state || state.phase !== "retry-wait" || state.terminalOutcome) {
      return undefined;
    }
    const nextConnection = this.createConnection(state.controller);
    state.connection = nextConnection;
    state.phase = "connecting";
    return nextConnection;
  }

  ready(connection: RealtimeVoiceSessionConnection): boolean {
    const state = this.currentState(connection);
    if (!state || state.phase !== "connecting" || state.terminalOutcome) {
      return false;
    }
    state.phase = "ready";
    state.retryAttempts = 0;
    return true;
  }

  retry(
    connection: RealtimeVoiceSessionConnection,
    maxAttempts: number,
  ): { attempt: number; signal: AbortSignal } | "exhausted" | undefined {
    const state = this.currentState(connection);
    if (!state || state.phase === "retry-wait" || state.terminalOutcome) {
      return undefined;
    }
    if (state.retryAttempts >= maxAttempts) {
      return "exhausted";
    }
    state.retryAttempts += 1;
    state.phase = "retry-wait";
    return { attempt: state.retryAttempts, signal: state.controller.signal };
  }

  createConnectAttempt(options: RealtimeVoiceConnectAttemptOptions): RealtimeVoiceConnectAttempt {
    let settled = false;
    let ready = false;
    let startupFailed = false;
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    let removeAbortListener = () => {};
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      removeAbortListener();
    };
    const resolve = (providerReady = false) => {
      if (settled) {
        return;
      }
      settled = true;
      ready = providerReady;
      cleanup();
      resolvePromise();
    };
    const reject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const rejectStartup = (error: Error) => {
      if (settled || !this.acceptsEvents(options.connection) || ready) {
        return false;
      }
      startupFailed = true;
      reject(error);
      return true;
    };
    const startTimeout = () => {
      if (settled || timeout) {
        return;
      }
      timeout = setTimeout(() => {
        if (
          this.isCurrent(options.connection) &&
          !ready &&
          this.terminalOutcome(options.connection) !== "completed"
        ) {
          startupFailed = true;
          options.onTimeout();
          reject(options.timeoutError());
        }
      }, options.timeoutMs);
    };
    const onAbort = () => {
      const outcome = this.terminalOutcome(options.connection);
      options.onAbort(outcome);
      if (outcome === "completed") {
        resolve();
        return;
      }
      const reason = options.connection.signal.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    options.connection.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => options.connection.signal.removeEventListener("abort", onAbort);
    if (options.connection.signal.aborted) {
      onAbort();
    }
    return {
      promise,
      get ready() {
        return ready;
      },
      get settled() {
        return settled;
      },
      get startupFailed() {
        return startupFailed;
      },
      reject,
      rejectStartup,
      resolve,
      startTimeout,
    };
  }

  cancel(): boolean {
    const state = this.state;
    if (state.phase === "terminal") {
      return false;
    }
    this.connectPromise = undefined;
    this.pendingAudio.clear();
    if (!("controller" in state)) {
      this.state = { phase: "terminal", terminalOutcome: "completed" };
      return true;
    }
    state.phase = "terminal";
    state.terminalOutcome = "completed";
    state.controller.abort(new Error(`${this.label} realtime voice session canceled`));
    return true;
  }

  failure(connection: RealtimeVoiceSessionConnection): boolean {
    const state = this.currentState(connection);
    if (!state || state.terminalOutcome) {
      return false;
    }
    this.pendingAudio.clear();
    state.phase = "terminal";
    state.terminalOutcome = "error";
    state.controller.abort(new Error(`${this.label} realtime voice session failed`));
    return true;
  }

  close(
    connection: RealtimeVoiceSessionConnection,
    outcome: RealtimeVoiceTerminalOutcome,
  ): RealtimeVoiceTerminalOutcome | undefined {
    const state = this.currentState(connection);
    if (!state) {
      return undefined;
    }
    this.pendingAudio.clear();
    if (!state.terminalOutcome) {
      state.phase = "terminal";
      state.terminalOutcome = outcome;
      state.controller.abort(new Error(`${this.label} realtime voice session closed`));
    }
    if (state.terminalNotified) {
      return undefined;
    }
    state.terminalNotified = true;
    return state.terminalOutcome;
  }

  currentConnection(): RealtimeVoiceSessionConnection | undefined {
    return "connection" in this.state ? this.state.connection : undefined;
  }

  isCurrent(connection: RealtimeVoiceSessionConnection): boolean {
    return this.currentState(connection) !== undefined;
  }

  acceptsEvents(connection: RealtimeVoiceSessionConnection): boolean {
    const phase = this.currentState(connection)?.phase;
    return phase === "connecting" || phase === "ready";
  }

  isReady(): boolean {
    return this.state.phase === "ready";
  }

  phase(): RealtimeVoiceSessionPhase {
    return this.state.phase;
  }

  terminalOutcome(
    connection: RealtimeVoiceSessionConnection,
  ): RealtimeVoiceTerminalOutcome | undefined {
    return this.currentState(connection)?.terminalOutcome;
  }

  enqueuePendingAudio(audio: Buffer): boolean {
    return this.pendingAudio.enqueue(audio);
  }

  drainPendingAudio(): Buffer[] {
    return this.pendingAudio.drain();
  }

  private createFreshConnection(): RealtimeVoiceSessionConnection {
    if ("controller" in this.state) {
      this.state.controller.abort(new Error(`${this.label} realtime voice connection replaced`));
    }
    const controller = new AbortController();
    const connection = this.createConnection(controller);
    this.state = {
      connection,
      controller,
      phase: "connecting",
      retryAttempts: 0,
      terminalNotified: false,
    };
    return connection;
  }

  private createConnection(controller: AbortController): RealtimeVoiceSessionConnection {
    return {
      id: Symbol(`${this.label.toLowerCase()}-realtime-voice-connection`),
      signal: controller.signal,
    };
  }

  private currentState(
    connection: RealtimeVoiceSessionConnection,
  ): RealtimeVoiceConnectionState | undefined {
    return "connection" in this.state && this.state.connection.id === connection.id
      ? this.state
      : undefined;
  }
}

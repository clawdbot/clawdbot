type XaiRealtimeVoiceLifecyclePhase = "idle" | "connecting" | "ready" | "retry-wait" | "terminal";

type XaiRealtimeVoiceTerminalOutcome = "completed" | "error";

export type XaiRealtimeVoiceConnection = Readonly<{
  id: symbol;
  signal: AbortSignal;
}>;

type XaiRealtimeVoiceIdleState = {
  phase: "idle" | "terminal";
  terminalOutcome?: "completed";
};

type XaiRealtimeVoiceConnectionState = {
  connection: XaiRealtimeVoiceConnection;
  controller: AbortController;
  phase: Exclude<XaiRealtimeVoiceLifecyclePhase, "idle">;
  retryAttempts: number;
  terminalOutcome?: XaiRealtimeVoiceTerminalOutcome;
  terminalNotified: boolean;
};

export class XaiRealtimeVoiceLifecycle {
  private state: XaiRealtimeVoiceIdleState | XaiRealtimeVoiceConnectionState = {
    phase: "idle",
  };

  connect(): XaiRealtimeVoiceConnection {
    if ("controller" in this.state) {
      this.state.controller.abort(new Error("xAI realtime voice connection replaced"));
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

  reconnect(connection: XaiRealtimeVoiceConnection): XaiRealtimeVoiceConnection | undefined {
    const state = this.currentState(connection);
    if (!state || state.phase !== "retry-wait" || state.terminalOutcome) {
      return undefined;
    }
    const nextConnection = this.createConnection(state.controller);
    state.connection = nextConnection;
    state.phase = "connecting";
    return nextConnection;
  }

  ready(connection: XaiRealtimeVoiceConnection): boolean {
    const state = this.currentState(connection);
    if (!state || state.phase !== "connecting" || state.terminalOutcome) {
      return false;
    }
    state.phase = "ready";
    state.retryAttempts = 0;
    return true;
  }

  retry(
    connection: XaiRealtimeVoiceConnection,
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

  cancel(): boolean {
    const state = this.state;
    if (state.phase === "terminal") {
      return false;
    }
    if (!("controller" in state)) {
      this.state = {
        phase: "terminal",
        terminalOutcome: "completed",
      };
      return true;
    }
    state.phase = "terminal";
    state.terminalOutcome = "completed";
    state.controller.abort(new Error("xAI realtime voice session canceled"));
    return true;
  }

  failure(connection: XaiRealtimeVoiceConnection): boolean {
    const state = this.currentState(connection);
    if (!state || state.terminalOutcome) {
      return false;
    }
    state.phase = "terminal";
    state.terminalOutcome = "error";
    state.controller.abort(new Error("xAI realtime voice session failed"));
    return true;
  }

  close(
    connection: XaiRealtimeVoiceConnection,
    outcome: XaiRealtimeVoiceTerminalOutcome,
  ): XaiRealtimeVoiceTerminalOutcome | undefined {
    const state = this.currentState(connection);
    if (!state) {
      return undefined;
    }
    if (!state.terminalOutcome) {
      state.phase = "terminal";
      state.terminalOutcome = outcome;
      state.controller.abort(new Error("xAI realtime voice session closed"));
    }
    if (state.terminalNotified) {
      return undefined;
    }
    state.terminalNotified = true;
    return state.terminalOutcome;
  }

  isCurrent(connection: XaiRealtimeVoiceConnection): boolean {
    return this.currentState(connection) !== undefined;
  }

  acceptsEvents(connection: XaiRealtimeVoiceConnection): boolean {
    const phase = this.currentState(connection)?.phase;
    return phase === "connecting" || phase === "ready";
  }

  isReady(): boolean {
    return this.state.phase === "ready";
  }

  phase(): XaiRealtimeVoiceLifecyclePhase {
    return this.state.phase;
  }

  terminalOutcome(
    connection: XaiRealtimeVoiceConnection,
  ): XaiRealtimeVoiceTerminalOutcome | undefined {
    return this.currentState(connection)?.terminalOutcome;
  }

  private createConnection(controller: AbortController): XaiRealtimeVoiceConnection {
    return { id: Symbol("xai-realtime-voice-connection"), signal: controller.signal };
  }

  private currentState(
    connection: XaiRealtimeVoiceConnection,
  ): XaiRealtimeVoiceConnectionState | undefined {
    return "connection" in this.state && this.state.connection.id === connection.id
      ? this.state
      : undefined;
  }
}

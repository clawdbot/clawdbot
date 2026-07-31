type OpenAIRealtimeVoiceLifecyclePhase =
  | "idle"
  | "connecting"
  | "ready"
  | "retry-wait"
  | "terminal";

type OpenAIRealtimeVoiceTerminalOutcome = "completed" | "error";

export type OpenAIRealtimeVoiceConnection = Readonly<{
  id: symbol;
  signal: AbortSignal;
}>;

type OpenAIRealtimeVoiceIdleState = {
  phase: "idle" | "terminal";
  terminalOutcome?: "completed";
};

type OpenAIRealtimeVoiceConnectionState = {
  connection: OpenAIRealtimeVoiceConnection;
  controller: AbortController;
  phase: Exclude<OpenAIRealtimeVoiceLifecyclePhase, "idle">;
  retryAttempts: number;
  terminalOutcome?: OpenAIRealtimeVoiceTerminalOutcome;
  terminalNotified: boolean;
};

export class OpenAIRealtimeVoiceLifecycle {
  private state: OpenAIRealtimeVoiceIdleState | OpenAIRealtimeVoiceConnectionState = {
    phase: "idle",
  };

  connect(): OpenAIRealtimeVoiceConnection {
    if ("controller" in this.state) {
      this.state.controller.abort(new Error("OpenAI realtime voice connection replaced"));
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

  reconnect(connection: OpenAIRealtimeVoiceConnection): OpenAIRealtimeVoiceConnection | undefined {
    const state = this.currentState(connection);
    if (!state || state.phase !== "retry-wait" || state.terminalOutcome) {
      return undefined;
    }
    const nextConnection = this.createConnection(state.controller);
    state.connection = nextConnection;
    state.phase = "connecting";
    return nextConnection;
  }

  ready(connection: OpenAIRealtimeVoiceConnection): boolean {
    const state = this.currentState(connection);
    if (!state || state.phase !== "connecting" || state.terminalOutcome) {
      return false;
    }
    state.phase = "ready";
    state.retryAttempts = 0;
    return true;
  }

  retry(
    connection: OpenAIRealtimeVoiceConnection,
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
    state.controller.abort(new Error("OpenAI realtime voice session canceled"));
    return true;
  }

  failure(connection: OpenAIRealtimeVoiceConnection): boolean {
    const state = this.currentState(connection);
    if (!state || state.terminalOutcome) {
      return false;
    }
    state.phase = "terminal";
    state.terminalOutcome = "error";
    state.controller.abort(new Error("OpenAI realtime voice session failed"));
    return true;
  }

  close(
    connection: OpenAIRealtimeVoiceConnection,
    outcome: OpenAIRealtimeVoiceTerminalOutcome,
  ): OpenAIRealtimeVoiceTerminalOutcome | undefined {
    const state = this.currentState(connection);
    if (!state) {
      return undefined;
    }
    if (!state.terminalOutcome) {
      state.phase = "terminal";
      state.terminalOutcome = outcome;
      state.controller.abort(new Error("OpenAI realtime voice session closed"));
    }
    if (state.terminalNotified) {
      return undefined;
    }
    state.terminalNotified = true;
    return state.terminalOutcome;
  }

  isCurrent(connection: OpenAIRealtimeVoiceConnection): boolean {
    return this.currentState(connection) !== undefined;
  }

  acceptsEvents(connection: OpenAIRealtimeVoiceConnection): boolean {
    const phase = this.currentState(connection)?.phase;
    return phase === "connecting" || phase === "ready";
  }

  isReady(): boolean {
    return this.state?.phase === "ready";
  }

  phase(): OpenAIRealtimeVoiceLifecyclePhase {
    return this.state.phase;
  }

  terminalOutcome(
    connection: OpenAIRealtimeVoiceConnection,
  ): OpenAIRealtimeVoiceTerminalOutcome | undefined {
    return this.currentState(connection)?.terminalOutcome;
  }

  private createConnection(controller: AbortController): OpenAIRealtimeVoiceConnection {
    return { id: Symbol("openai-realtime-voice-connection"), signal: controller.signal };
  }

  private currentState(
    connection: OpenAIRealtimeVoiceConnection,
  ): OpenAIRealtimeVoiceConnectionState | undefined {
    return "connection" in this.state && this.state.connection.id === connection.id
      ? this.state
      : undefined;
  }
}

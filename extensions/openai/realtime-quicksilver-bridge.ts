// GPT-Live backend bridge over the Frameless Bidi WebSocket protocol used by Codex realtime v3.
import { randomUUID } from "node:crypto";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import {
  canonicalizeBase64,
  rawDataToString,
  createStreamingPcmResampler,
  mulawToPcm,
  pcmToMulaw,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  RealtimeVoiceSessionLifecycle,
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeCreateRequest,
  type RealtimeVoiceSessionConnection,
  type RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import WebSocket, { type RawData } from "ws";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import { projectOpenAIQuicksilverErrorMessage } from "./realtime-quicksilver-redaction.js";
import {
  connectOpenAIQuicksilverSideband,
  type OpenAIQuicksilverSocket,
  type OpenAIQuicksilverSocketFactory,
} from "./realtime-quicksilver-sideband.js";
import {
  boundOpenAIQuicksilverDelegationResult,
  buildOpenAIQuicksilverSessionUpdate,
  buildOpenAIQuicksilverWebSocketUrl,
  chunkOpenAIQuicksilverAppendText,
  parseOpenAIQuicksilverEvent,
  type OpenAIQuicksilverAuth,
  type OpenAIQuicksilverInboundEvent,
  type OpenAIQuicksilverRequestIds,
} from "./realtime-quicksilver-wire.js";

const OPENAI_QUICKSILVER_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const OPENAI_QUICKSILVER_READY_TIMEOUT_MS = 15_000;
const OPENAI_QUICKSILVER_SAMPLE_RATE = 24_000;
// Private transport diagnostics retain activity only, never routes, session IDs, or frame content.
const OPENAI_QUICKSILVER_CAPTURE_FLOW = "private-realtime";
const OPENAI_QUICKSILVER_CAPTURE_URL = "wss://realtime.invalid/private";
const WEBSOCKET_OPEN = 1;

type OpenAIQuicksilverVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  model: string;
  voice?: string;
  resolveAuth: () => Promise<OpenAIQuicksilverAuth>;
  logger?: Pick<PluginLogger, "warn">;
  webSocketFactory?: OpenAIQuicksilverSocketFactory;
};

function toolResultText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    for (const key of ["text", "result", "output", "error"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  }
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

export class OpenAIQuicksilverVoiceBridge implements RealtimeVoiceBridge {
  readonly supportsToolResultContinuation = true;
  readonly supportsToolResultSuppression = true;
  readonly handlesInputAudioBargeIn = false;

  private socket: OpenAIQuicksilverSocket | undefined;
  private readonly lifecycle: RealtimeVoiceSessionLifecycle;
  private inboundTelephonyResampler = createStreamingPcmResampler(
    8_000,
    OPENAI_QUICKSILVER_SAMPLE_RATE,
  );
  private outboundTelephonyResampler = createStreamingPcmResampler(
    OPENAI_QUICKSILVER_SAMPLE_RATE,
    8_000,
  );
  private activeDelegations = new Set<string>();
  private readonly requestIds: OpenAIQuicksilverRequestIds = {
    realtimeSessionId: randomUUID(),
    sessionId: randomUUID(),
    threadId: randomUUID(),
  };

  constructor(
    private readonly config: OpenAIQuicksilverVoiceBridgeConfig,
    private readonly runtime: OpenAIRealtimeHost,
  ) {
    this.lifecycle = new RealtimeVoiceSessionLifecycle("OpenAI", {
      pendingAudioOverflowPolicy: "drop-oldest",
      onPendingAudioOverflow: () =>
        (config.logger?.warn ?? console.warn)(
          "OpenAI GPT-Live input audio queue overflow; keeping newest audio",
        ),
    });
  }

  async connect(): Promise<void> {
    await this.lifecycle.connect((connection) => this.connectConnection(connection));
  }

  private async connectConnection(connection: RealtimeVoiceSessionConnection): Promise<void> {
    let connected: Awaited<ReturnType<typeof connectOpenAIQuicksilverSideband>>;
    try {
      const auth = await this.waitForConnection(this.config.resolveAuth(), connection);
      if (!auth) {
        return;
      }
      const url = buildOpenAIQuicksilverWebSocketUrl(this.config.model);
      const createSocket = this.config.webSocketFactory ?? this.createSocketFactory();
      connected = await connectOpenAIQuicksilverSideband(
        {
          auth,
          createSocket,
          requestIds: this.requestIds,
          signal: connection.signal,
          url,
        },
        this.runtime,
      );
    } catch (error) {
      if (
        !this.lifecycle.isCurrent(connection) ||
        this.lifecycle.terminalOutcome(connection) === "completed"
      ) {
        return;
      }
      this.failLifecycle(connection);
      throw this.redactError(error);
    }
    if (!this.lifecycle.isCurrent(connection) || connection.signal.aborted) {
      this.closeSocket("stale connection", connected.socket);
      return;
    }
    this.socket = connected.socket;
    this.runtime.captureWsEvent({
      url: OPENAI_QUICKSILVER_CAPTURE_URL,
      direction: "local",
      kind: "ws-open",
      flowId: OPENAI_QUICKSILVER_CAPTURE_FLOW,
      meta: { provider: "openai", capability: "gpt-live-voice" },
    });

    let reachedReady = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let readySettled = false;
    let removeAbortListener = () => {};
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const settleReady = (providerReady = true) => {
      if (readySettled) {
        return;
      }
      readySettled = true;
      reachedReady = providerReady;
      if (readyTimeout) {
        clearTimeout(readyTimeout);
      }
      removeAbortListener();
      resolveReady();
    };
    const failReady = (error: Error) => {
      if (readySettled) {
        return;
      }
      readySettled = true;
      if (readyTimeout) {
        clearTimeout(readyTimeout);
      }
      removeAbortListener();
      rejectReady(error);
    };
    const failStartup = (error: Error, reason: string) => {
      if (this.lifecycle.terminalOutcome(connection) === "completed") {
        settleReady(false);
        return;
      }
      if (!this.lifecycle.acceptsEvents(connection) || reachedReady) {
        return;
      }
      this.failLifecycle(connection);
      failReady(this.redactError(error));
      this.closeSocket(reason, connected.socket);
    };
    const readyTimeout = setTimeout(() => {
      failStartup(
        new Error("GPT-Live WebSocket did not emit session.started"),
        "session-start timeout",
      );
    }, OPENAI_QUICKSILVER_READY_TIMEOUT_MS);
    readyTimeout.unref?.();
    const onAbort = () => {
      if (this.lifecycle.terminalOutcome(connection) === "completed") {
        settleReady(false);
      }
    };
    connection.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => connection.signal.removeEventListener("abort", onAbort);
    if (connection.signal.aborted) {
      onAbort();
    }

    connected.socket.on("message", (data: RawData, isBinary: boolean) => {
      if (!this.lifecycle.acceptsEvents(connection) || this.socket !== connected.socket) {
        return;
      }
      if (isBinary) {
        const error = new Error("GPT-Live WebSocket returned an unexpected binary frame");
        if (!reachedReady) {
          failStartup(error, "unexpected binary frame");
        } else {
          this.fail(connection, error);
        }
        return;
      }
      const payload = rawDataToString(data);
      this.runtime.captureWsEvent({
        url: OPENAI_QUICKSILVER_CAPTURE_URL,
        direction: "inbound",
        kind: "ws-frame",
        flowId: OPENAI_QUICKSILVER_CAPTURE_FLOW,
        meta: { provider: "openai", capability: "gpt-live-voice" },
      });
      const event = parseOpenAIQuicksilverEvent(payload);
      if (event) {
        this.handleEvent(event, connection, settleReady, failStartup);
      }
    });
    connected.socket.on("error", (error: Error) => {
      if (!this.lifecycle.acceptsEvents(connection) || this.socket !== connected.socket) {
        return;
      }
      if (!reachedReady) {
        failStartup(error, "startup error");
      } else {
        this.fail(connection, error);
      }
    });
    connected.socket.on("close", (code) => {
      if (!this.lifecycle.isCurrent(connection) || this.socket !== connected.socket) {
        return;
      }
      this.socket = undefined;
      if (!reachedReady) {
        if (this.lifecycle.terminalOutcome(connection) === "completed") {
          settleReady();
          this.notifyClose(connection, "completed");
          return;
        }
        const error = new Error("GPT-Live WebSocket closed before session.started");
        this.failLifecycle(connection);
        failReady(error);
        this.lifecycle.close(connection, "error");
        return;
      }
      this.notifyClose(connection, code === 1000 ? "completed" : "error");
    });

    const terminalEvent = connected.detachBuffer();
    this.sendEvent(
      buildOpenAIQuicksilverSessionUpdate({
        model: this.config.model,
        instructions: this.config.instructions,
        voice: this.config.voice,
      }),
    );
    for (const frame of connected.bufferedFrames) {
      if (!frame.isBinary) {
        const event = parseOpenAIQuicksilverEvent(rawDataToString(frame.data));
        if (event) {
          this.handleEvent(event, connection, settleReady, failStartup);
        }
      }
    }
    if (terminalEvent) {
      const error =
        terminalEvent.kind === "error"
          ? terminalEvent.error
          : new Error("GPT-Live WebSocket closed during startup");
      if (reachedReady) {
        if (terminalEvent.kind === "close" && terminalEvent.code === 1000) {
          this.notifyClose(connection, "completed");
        } else if (this.fail(connection, error, "startup terminal event")) {
          this.notifyClose(connection, "error");
        }
      } else {
        failStartup(error, "startup terminal event");
      }
    }
    await readyPromise;
  }

  sendAudio(audio: Buffer): void {
    if (this.lifecycle.phase() === "terminal") {
      return;
    }
    if (!this.lifecycle.isReady() || this.socket?.readyState !== WEBSOCKET_OPEN) {
      this.lifecycle.enqueuePendingAudio(audio);
      return;
    }
    this.sendAudioNow(audio);
  }

  setMediaTimestamp(_ts: number): void {}

  sendUserMessage(text: string): void {
    this.sendContext("session.context.append", undefined, text);
  }

  triggerGreeting(instructions?: string): void {
    this.sendContext(
      "session.context.append",
      undefined,
      instructions ?? "Greet the user briefly.",
      "speakable",
    );
  }

  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    const channel = options?.suppressResponse || options?.willContinue ? "commentary" : "speakable";
    const isDelegation = this.activeDelegations.has(callId);
    const type = isDelegation ? "delegation.context.append" : "session.context.append";
    const text = toolResultText(result);
    this.sendContext(
      type,
      isDelegation ? callId : undefined,
      isDelegation ? boundOpenAIQuicksilverDelegationResult(text) : text,
      channel,
    );
    if (!options?.willContinue) {
      this.activeDelegations.delete(callId);
    }
  }

  acknowledgeMark(_markName?: string): void {}

  close(): void {
    const connection = this.lifecycle.currentConnection();
    if (!this.lifecycle.cancel()) {
      return;
    }
    this.resetTerminalState();
    if (!connection) {
      return;
    }
    if (this.socket?.readyState === WEBSOCKET_OPEN) {
      this.sendEvent({ type: "session.close" });
    }
    this.closeSocket("bridge closed");
    this.notifyClose(connection, "completed");
  }

  isConnected(): boolean {
    return this.lifecycle.isReady() && this.socket?.readyState === WEBSOCKET_OPEN;
  }

  handleBargeIn(): void {
    // Frameless Bidi owns interruption from incoming audio and exposes no client cancel event.
    this.config.onClearAudio("barge-in");
  }

  private createSocketFactory(): OpenAIQuicksilverSocketFactory {
    return (url, options) =>
      new WebSocket(url, {
        ...options,
        maxPayload: OPENAI_QUICKSILVER_MAX_PAYLOAD_BYTES,
      });
  }

  private async waitForConnection<T>(
    promise: Promise<T>,
    connection: RealtimeVoiceSessionConnection,
  ): Promise<T | undefined> {
    if (connection.signal.aborted) {
      return undefined;
    }
    return new Promise<T | undefined>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        resolve(undefined);
      };
      const cleanup = () => connection.signal.removeEventListener("abort", onAbort);
      connection.signal.addEventListener("abort", onAbort, { once: true });
      void promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private handleEvent(
    event: OpenAIQuicksilverInboundEvent,
    connection: RealtimeVoiceSessionConnection,
    settleReady: () => void,
    failStartup: (error: Error, reason: string) => void,
  ): void {
    if (event.kind === "ignored" || event.kind === "unknown") {
      return;
    }
    if (event.kind === "session-started") {
      if (this.lifecycle.ready(connection)) {
        for (const audio of this.lifecycle.drainPendingAudio()) {
          this.sendAudioNow(audio);
        }
        this.config.onReady?.();
      }
      this.config.onEvent?.({ direction: "server", type: "session.started" });
      settleReady();
      return;
    }
    if (event.kind === "audio-cleared") {
      this.config.onEvent?.({ direction: "server", type: "output_audio_buffer.cleared" });
      this.config.onClearAudio("barge-in");
      return;
    }
    if (event.kind === "audio") {
      const canonical = canonicalizeBase64(event.data);
      if (!canonical) {
        this.fail(connection, new Error("GPT-Live WebSocket returned malformed base64 audio"));
        return;
      }
      const pcm = Buffer.from(canonical, "base64");
      const output =
        this.config.audioFormat?.encoding === "g711_ulaw"
          ? pcmToMulaw(this.outboundTelephonyResampler.process(pcm))
          : pcm;
      if (output.length > 0) {
        this.config.onAudio(output);
      }
      this.config.onEvent?.({ direction: "server", type: "output_audio.delta" });
      return;
    }
    if (event.kind === "transcript-delta" || event.kind === "transcript-done") {
      if (
        event.kind === "transcript-done" &&
        event.role === "assistant" &&
        this.config.audioFormat?.encoding === "g711_ulaw"
      ) {
        const tail = pcmToMulaw(this.outboundTelephonyResampler.flush());
        this.outboundTelephonyResampler = createStreamingPcmResampler(
          OPENAI_QUICKSILVER_SAMPLE_RATE,
          8_000,
        );
        if (tail.length > 0) {
          this.config.onAudio(tail);
        }
      }
      this.config.onTranscript?.(event.role, event.text, event.kind === "transcript-done");
      this.config.onEvent?.({
        direction: "server",
        type:
          event.kind === "transcript-done"
            ? event.role === "assistant"
              ? "response.done"
              : "turn.done"
            : `${event.role === "user" ? "input" : "output"}_transcript.added`,
      });
      return;
    }
    if (event.kind === "delegation") {
      this.activeDelegations.add(event.id);
      this.config.onEvent?.({
        direction: "server",
        type: "delegation.created",
        itemId: event.id,
      });
      this.config.onToolCall?.({
        itemId: event.id,
        callId: event.id,
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: event.prompt },
      });
      return;
    }
    const message = projectOpenAIQuicksilverErrorMessage("provider");
    const error = new Error(message);
    if (!this.lifecycle.isReady()) {
      failStartup(error, "session start failed");
      return;
    }
    this.config.onEvent?.({ direction: "server", type: "error", detail: message });
    if (event.fatalAuth) {
      this.fail(connection, error, "authentication failed");
    } else {
      this.config.onError?.(error);
    }
  }

  private sendAudioNow(audio: Buffer): void {
    const pcm =
      this.config.audioFormat?.encoding === "g711_ulaw"
        ? this.inboundTelephonyResampler.process(mulawToPcm(audio))
        : audio;
    if (pcm.length === 0) {
      return;
    }
    this.sendEvent({ type: "input_audio.append", audio: pcm.toString("base64") });
  }

  private sendContext(
    type: "delegation.context.append" | "session.context.append",
    delegationItemId: string | undefined,
    text: string,
    channel?: "speakable" | "commentary",
  ): void {
    for (const chunk of chunkOpenAIQuicksilverAppendText(text)) {
      this.sendEvent({
        type,
        ...(delegationItemId ? { delegation_item_id: delegationItemId } : {}),
        ...(channel ? { channel } : {}),
        content: [{ type: "input_text", text: chunk }],
      });
    }
  }

  private sendEvent(event: object): void {
    if (!this.socket || this.socket.readyState !== WEBSOCKET_OPEN) {
      return;
    }
    const payload = JSON.stringify(event);
    this.runtime.captureWsEvent({
      url: OPENAI_QUICKSILVER_CAPTURE_URL,
      direction: "outbound",
      kind: "ws-frame",
      flowId: OPENAI_QUICKSILVER_CAPTURE_FLOW,
      meta: { provider: "openai", capability: "gpt-live-voice" },
    });
    this.socket.send(payload);
  }

  private fail(
    connection: RealtimeVoiceSessionConnection,
    error: Error,
    reason = "bridge error",
  ): boolean {
    if (!this.failLifecycle(connection)) {
      return false;
    }
    this.config.onError?.(this.redactError(error));
    this.closeSocket(reason);
    return true;
  }

  private redactError(_error: unknown): Error {
    return new Error(projectOpenAIQuicksilverErrorMessage("transport"));
  }

  private failLifecycle(connection: RealtimeVoiceSessionConnection): boolean {
    if (!this.lifecycle.failure(connection)) {
      return false;
    }
    this.resetTerminalState();
    return true;
  }

  private resetTerminalState(): void {
    this.activeDelegations.clear();
    this.inboundTelephonyResampler = createStreamingPcmResampler(
      8_000,
      OPENAI_QUICKSILVER_SAMPLE_RATE,
    );
    this.outboundTelephonyResampler = createStreamingPcmResampler(
      OPENAI_QUICKSILVER_SAMPLE_RATE,
      8_000,
    );
  }

  private closeSocket(reason: string, socket = this.socket): void {
    try {
      socket?.close(1000, reason);
    } catch {
      // Closing is best effort once the bridge reaches a terminal state.
    }
  }

  private notifyClose(
    connection: RealtimeVoiceSessionConnection,
    reason: "completed" | "error",
  ): void {
    const outcome = this.lifecycle.close(connection, reason);
    if (!outcome) {
      return;
    }
    this.resetTerminalState();
    this.config.onClose?.(outcome);
  }
}

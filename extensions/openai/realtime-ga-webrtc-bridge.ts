import { randomUUID } from "node:crypto";
import type {
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceBridge,
  RealtimeVoiceSessionConnection,
} from "openclaw/plugin-sdk/realtime-voice";
import { RealtimeVoiceSessionLifecycle } from "openclaw/plugin-sdk/realtime-voice-provider";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverAudioPeer } from "./realtime-quicksilver-peer.runtime.js";
import {
  createOpenAIQuicksilverCall,
  hangupOpenAIRealtimeCall,
  type OpenAIQuicksilverAuth,
} from "./realtime-quicksilver-wire.js";
import { isOpenAIGptLiveModel } from "./realtime-quicksilver.js";
import { OpenAIRealtimeEvents } from "./realtime-voice-events.js";
import type {
  OpenAIRealtimeVoiceBridgeConfig,
  RealtimeEvent,
} from "./realtime-voice-session-policy.js";

function hasOptionalStrings(value: unknown, keys: string[]): boolean {
  return (
    isRecord(value) &&
    keys.every((key) => value[key] === undefined || typeof value[key] === "string")
  );
}

function isGaControlEvent(value: unknown): value is RealtimeEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (
    !hasOptionalStrings(value, [
      "delta",
      "data",
      "text",
      "transcript",
      "item_id",
      "response_id",
      "call_id",
      "name",
      "arguments",
    ])
  ) {
    return false;
  }
  if (
    value.item !== undefined &&
    !hasOptionalStrings(value.item, ["id", "type", "name", "call_id", "arguments"])
  ) {
    return false;
  }
  if (value.part !== undefined && !hasOptionalStrings(value.part, ["type"])) {
    return false;
  }
  if (value.response !== undefined) {
    if (!hasOptionalStrings(value.response, ["id", "status"]) || !isRecord(value.response)) {
      return false;
    }
    if (value.response.output !== undefined && !Array.isArray(value.response.output)) {
      return false;
    }
  }
  return true;
}

type OutputResponse = {
  id: string;
  cancelled: boolean;
  audioExpected: boolean;
  started: boolean;
  bufferEnded: boolean;
  done?: RealtimeEvent;
};

/** Private Gateway media/control transport. Authentication is captured by the selected owner. */
export class OpenAIRealtimeGaWebRtcBridge
  extends OpenAIRealtimeEvents
  implements RealtimeVoiceBridge
{
  private readonly lifecycle = new RealtimeVoiceSessionLifecycle("OpenAI GA WebRTC");
  private readonly requestId = randomUUID();
  private peer?: OpenAIQuicksilverAudioPeer;
  private callId?: string;
  private closed = false;
  private failure?: Error;
  private answerApplied = false;
  private sessionCreated = false;
  private output?: OutputResponse;
  private readonly retiredResponses = new Set<string>();
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;

  constructor(
    config: OpenAIRealtimeVoiceBridgeConfig,
    runtime: OpenAIRealtimeHost,
    private readonly auth: OpenAIQuicksilverAuth,
  ) {
    super(config, runtime);
  }

  connect(): Promise<void> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (this.closed) {
      return Promise.resolve();
    }
    return this.lifecycle.connect((connection) => {
      const attempt = this.lifecycle.createConnectAttempt({
        connection,
        timeoutMs: 30_000,
        timeoutError: () => new Error("OpenAI Realtime WebRTC startup timed out"),
        onTimeout: () =>
          this.fail(new Error("OpenAI Realtime WebRTC startup timed out"), connection),
        onAbort: () => this.releaseResources(),
      });
      this.resolveReady = () => attempt.resolve(true);
      this.rejectReady = (error) => attempt.reject(error);
      attempt.startTimeout();
      void this.start(connection).catch((error: unknown) => {
        if (this.acceptsEvent(connection)) {
          this.fail(this.safeError(error), connection);
        }
      });
      return attempt.promise;
    });
  }

  private async start(connection: RealtimeVoiceSessionConnection): Promise<void> {
    const session = structuredClone(this.buildGaSessionUpdate().session);
    if (
      isOpenAIGptLiveModel(session.model) ||
      this.config.azureEndpoint ||
      this.config.azureDeployment ||
      this.config.azureApiVersion ||
      this.config.callId
    ) {
      throw new Error("GA WebRTC relay requires a new OpenAI GA Realtime call");
    }
    const format = this.config.audioFormat;
    if (format?.encoding !== "pcm16" || format.sampleRateHz !== 24_000 || format.channels !== 1) {
      throw new Error("OpenAI GA WebRTC relay requires 24 kHz mono PCM16");
    }
    if (this.config.model && session.model !== this.config.model) {
      throw new Error("OpenAI GA initial policy model must match the selected model");
    }
    // The complete policy is part of POST /calls, before SDP enables any microphone media.
    // A prebuilt policy cannot override the caller's strict response ownership contract.
    if (this.config.autoRespondToAudio === false) {
      session.audio.input.turn_detection = {
        ...session.audio.input.turn_detection,
        create_response: false,
      };
    }
    const peer = await OpenAIQuicksilverAudioPeer.create({
      signal: connection.signal,
      callbacks: {
        onAudio: (audio) => this.receiveAudio(audio, connection),
        onError: () => this.fail(new Error("OpenAI Realtime WebRTC media failed"), connection),
      },
      gaDataChannel: {
        onOpen: () => this.maybeReady(connection),
        onMessage: (message) => this.receiveControl(message, connection),
      },
    });
    if (!this.acceptsEvent(connection)) {
      peer.close();
      return;
    }
    this.peer = peer;
    const sdp = await peer.createOffer();
    if (!this.acceptsEvent(connection)) {
      return;
    }
    const call = await createOpenAIQuicksilverCall(
      {
        auth: this.auth,
        sdp,
        session,
        requestIds: {
          realtimeSessionId: this.requestId,
          sessionId: this.requestId,
          threadId: this.requestId,
        },
        signal: connection.signal,
        onCallAllocated: (callId) => {
          this.callId = callId;
          // Headers can arrive after cancellation, even when fetch ignored its signal.
          if (!this.acceptsEvent(connection)) {
            this.retireCall();
          }
        },
      },
      this.runtime,
    );
    if (!this.acceptsEvent(connection)) {
      return;
    }
    if (call.kind !== "ga-realtime") {
      throw new Error("Unexpected OpenAI Realtime call transport");
    }
    await peer.applyAnswer(call.answerSdp);
    if (!this.acceptsEvent(connection)) {
      return;
    }
    this.answerApplied = true;
    this.maybeReady(connection);
  }

  sendAudio(audio: Buffer): void {
    if (this.closed) {
      return;
    }
    if (!this.isConnected()) {
      this.lifecycle.enqueuePendingAudio(audio);
      return;
    }
    this.peer?.sendAudio(audio);
  }

  triggerGreeting(instructions?: string): void {
    if (this.isConnected()) {
      this.sendUserMessage(instructions ?? this.config.instructions ?? "Greet the meeting.");
    }
  }

  isConnected(): boolean {
    return !this.closed && this.lifecycle.isReady() && this.isTransportOpen();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const connection = this.lifecycle.currentConnection();
    this.lifecycle.cancel();
    this.releaseResources();
    if (connection && this.lifecycle.close(connection, "completed")) {
      this.config.onClose?.("completed");
    }
  }

  private releaseResources(): void {
    this.peer?.close();
    this.peer = undefined;
    this.output = undefined;
    this.resetRealtimeSessionState();
    this.retireCall();
  }

  private retireCall(): void {
    const callId = this.callId;
    if (!callId) {
      return;
    }
    this.callId = undefined;
    // Retirement has its own bound, not the already-aborted connection signal, and
    // uses the original account/token. No selection, fallback, or retry at cleanup.
    void hangupOpenAIRealtimeCall(
      {
        auth: this.auth,
        callId,
        signal: AbortSignal.timeout(5_000),
      },
      this.runtime,
    ).catch(() => {
      this.config.logger.warn(
        "OpenAI Realtime remote call retirement failed; local media/control closed",
      );
    });
  }

  private safeError(error: unknown): Error {
    let message = error instanceof Error ? error.message : "OpenAI Realtime WebRTC failed";
    for (const secret of [
      this.auth.token,
      this.auth.type === "oauth" ? this.auth.accountId : undefined,
    ]) {
      if (secret) {
        message = message.split(secret).join("[REDACTED]");
      }
    }
    return new Error(this.runtime.redactSensitiveText(message, { mode: "tools" }).slice(0, 500));
  }

  private fail(error: Error, connection: RealtimeVoiceSessionConnection): void {
    if (!this.acceptsEvent(connection)) {
      return;
    }
    this.failure = error;
    this.rejectReady?.(error);
    this.closed = true;
    this.lifecycle.failure(connection);
    this.releaseResources();
    try {
      this.config.onError?.(error);
    } finally {
      if (this.lifecycle.close(connection, "error")) {
        this.config.onClose?.("error");
      }
    }
  }

  private maybeReady(connection: RealtimeVoiceSessionConnection): void {
    if (
      !this.acceptsEvent(connection) ||
      !this.answerApplied ||
      !this.sessionCreated ||
      !this.isTransportOpen()
    ) {
      return;
    }
    if (!this.lifecycle.ready(connection)) {
      return;
    }
    this.config.onReady?.();
    if (!this.acceptsEvent(connection)) {
      return;
    }
    for (const audio of this.lifecycle.drainPendingAudio()) {
      this.sendAudio(audio);
    }
    this.resolveReady?.();
  }

  private receiveControl(
    message: string | Buffer,
    connection: RealtimeVoiceSessionConnection,
  ): void {
    if (!this.acceptsEvent(connection)) {
      return;
    }
    try {
      if (Buffer.byteLength(message) > 1024 * 1024) {
        throw new Error("OpenAI Realtime control event exceeds limit");
      }
      const value: unknown = JSON.parse(message.toString());
      if (!isGaControlEvent(value)) {
        throw new Error("Invalid OpenAI Realtime control event");
      }
      this.receiveEvent(value, connection);
    } catch (error) {
      this.fail(this.safeError(error), connection);
    }
  }

  private receiveEvent(incoming: RealtimeEvent, connection: RealtimeVoiceSessionConnection): void {
    let event = incoming;
    if (event.type === "session.created") {
      this.sessionCreated = true;
      this.maybeReady(connection);
      return;
    }
    if (
      event.type === "error" ||
      event.type === "conversation.item.input_audio_transcription.failed"
    ) {
      // Provider diagnostics may echo request credentials. Keep the control plane bounded
      // and redacted while retaining the GA owner's request-id error correlation.
      const diagnostic = isRecord(event.error) ? event.error : {};
      const safeFields = Object.fromEntries(
        ["type", "code", "param", "event_id", "message"].flatMap((key) => {
          const value = diagnostic[key];
          return typeof value === "string" ? [[key, this.safeError(new Error(value)).message]] : [];
        }),
      );
      event = { ...event, error: { message: "OpenAI Realtime provider error", ...safeFields } };
    }
    if (event.type === "error" && !this.lifecycle.isReady()) {
      throw this.safeError(
        new Error(
          isRecord(event.error) ? String(event.error.message) : "OpenAI Realtime startup failed",
        ),
      );
    }
    if (event.response?.status_details !== undefined) {
      event = {
        ...event,
        response: {
          ...event.response,
          status_details: {
            error: {
              message: this.safeError(new Error(JSON.stringify(event.response.status_details)))
                .message,
            },
          },
        },
      };
    }
    const responseId = event.response_id ?? event.response?.id;
    if (event.type === "response.created") {
      if (!responseId || this.retiredResponses.has(responseId)) {
        return;
      }
      if (
        this.output ||
        (this.config.autoRespondToAudio === false && this.responseCreateState !== "in-flight")
      ) {
        throw new Error("OpenAI Realtime produced an unowned response");
      }
      this.output = {
        id: responseId,
        cancelled: this.responseCancelInFlight,
        audioExpected: false,
        started: false,
        bufferEnded: false,
      };
    } else if (
      event.type.startsWith("response.") ||
      event.type.startsWith("output_audio_buffer.")
    ) {
      if (!responseId || responseId !== this.output?.id) {
        return;
      }
    }
    const output = this.output;
    if (event.type === "response.content_part.added" && output && event.part?.type === "audio") {
      output.audioExpected = true;
    }
    if (event.type === "output_audio_buffer.started" && output) {
      output.audioExpected = true;
      output.started = true;
      this.peer?.discardInboundAudio();
      return;
    }
    if (
      (event.type === "output_audio_buffer.stopped" ||
        event.type === "output_audio_buffer.cleared") &&
      output
    ) {
      output.bufferEnded = true;
      if (event.type === "output_audio_buffer.cleared") {
        output.cancelled = true;
      }
      this.peer?.discardInboundAudio();
      this.finishOutput(connection);
      return;
    }
    if (event.type === "response.done" && output) {
      output.done = event;
      output.audioExpected ||= Boolean(
        event.response?.output?.some(
          (item) =>
            isRecord(item) &&
            Array.isArray(item.content) &&
            item.content.some((part: unknown) => isRecord(part) && part.type === "audio"),
        ),
      );
      this.finishOutput(connection);
      return;
    }
    // Audio comes from RTP, never a fabricated base64/data-channel packet or native ID.
    if (event.type.endsWith("audio.delta") || event.type.startsWith("conversation.output_")) {
      return;
    }
    if (output?.cancelled && event.type.startsWith("response.")) {
      return;
    }
    this.handleEvent(event, connection);
  }

  private finishOutput(connection: RealtimeVoiceSessionConnection): void {
    const output = this.output;
    if (!output?.done) {
      return;
    }
    // response.done precedes WebRTC output-buffer drain. Do not start queued readback
    // until the documented same-response buffer terminal; otherwise old RTP is rebound.
    if (output.audioExpected && !output.bufferEnded) {
      // Generation can finish far ahead of audible playback. Transport failure
      // closes the call; a fixed drain deadline would cut off valid long answers.
      return;
    }
    if (this.retiredResponses.size >= 1024) {
      throw new Error("OpenAI Realtime response session limit exceeded");
    }
    this.retiredResponses.add(output.id);
    this.output = undefined;
    const done = output.cancelled
      ? { ...output.done, response: { ...output.done.response, status: "cancelled", output: [] } }
      : output.done;
    this.handleEvent(done, connection);
  }

  private receiveAudio(audio: Buffer, connection: RealtimeVoiceSessionConnection): void {
    const output = this.output;
    if (
      !this.isConnected() ||
      !this.acceptsEvent(connection) ||
      !output?.started ||
      output.cancelled ||
      output.bufferEnded
    ) {
      return;
    }
    // RTP carries no GA item id. The documented response/output-buffer lifecycle
    // gates delivery, but cannot bind an individual PCM packet to output_item metadata.
    // WebRTC cancellation clears the provider buffer instead of inventing sink item ids.
    this.emitOutputAudio(audio, undefined, connection);
  }

  override handleBargeIn(options?: RealtimeVoiceBargeInOptions): void {
    if (this.isConnected()) {
      super.handleBargeIn({ audioPlaybackActive: this.output?.started, ...options });
    }
  }

  protected override clearTransportPlayback(): void {
    if (this.output) {
      this.output.cancelled = true;
    }
    this.peer?.discardInboundAudio();
    this.sendEvent({ type: "output_audio_buffer.clear" });
  }

  protected sendEvent(event: unknown, detail?: string): void {
    if (!this.isTransportOpen() || !isRecord(event) || typeof event.type !== "string") {
      return;
    }
    if (event.type === "response.cancel" && this.output) {
      this.output.cancelled = true;
    }
    try {
      this.peer?.sendControl(JSON.stringify(event));
      this.config.onEvent?.({
        direction: "client",
        type: event.type,
        ...(detail ? { detail } : {}),
      });
    } catch (error) {
      const connection = this.lifecycle.currentConnection();
      if (connection) {
        this.fail(this.safeError(error), connection);
      }
      throw this.safeError(error);
    }
  }

  protected acceptsEvent(connection: RealtimeVoiceSessionConnection): boolean {
    return !this.closed && this.lifecycle.acceptsEvents(connection);
  }
  protected isTransportOpen(): boolean {
    return !this.closed && this.peer?.isControlOpen() === true;
  }
  protected onSessionUpdated(connection: RealtimeVoiceSessionConnection): void {
    this.maybeReady(connection);
  }
  protected rotateExpiredSession(): void {
    const connection = this.lifecycle.currentConnection();
    if (connection) {
      this.fail(new Error("OpenAI Realtime session expired; start a new call"), connection);
    }
  }
  protected failToolCallSessionLimit(
    error: Error,
    connection: RealtimeVoiceSessionConnection,
  ): void {
    this.fail(error, connection);
  }
}

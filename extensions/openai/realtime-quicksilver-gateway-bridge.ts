// Gateway-owned GPT-Live bridge over released WebRTC and unlisted direct transport.
import { randomUUID } from "node:crypto";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceCloseDisposition,
  RealtimeVoiceCloseOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import { toErrorObject } from "openclaw/plugin-sdk/realtime-voice-provider";
import WebSocket, { type RawData } from "ws";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverPendingAudio } from "./realtime-quicksilver-audio-buffer.js";
import { OpenAIQuicksilverDelegationController } from "./realtime-quicksilver-delegation-controller.js";
import type {
  OpenAIQuicksilverAudioPeerCallbacks,
  OpenAIQuicksilverAudioPeerContract,
} from "./realtime-quicksilver-peer.runtime.js";
import {
  projectOpenAIQuicksilverAuthErrorMessage,
  projectOpenAIQuicksilverErrorMessage,
} from "./realtime-quicksilver-redaction.js";
import {
  releaseOpenAIQuicksilverSession,
  reserveOpenAIQuicksilverSession,
} from "./realtime-quicksilver-session-limit.js";
import {
  connectOpenAIQuicksilverSideband,
  type OpenAIQuicksilverSocket,
  type OpenAIQuicksilverSocketFactory,
} from "./realtime-quicksilver-sideband.js";
import {
  buildOpenAIQuicksilverSession,
  buildOpenAIQuicksilverWebSocketUrl,
  createOpenAIQuicksilverCall,
  type OpenAIQuicksilverAuth,
  type OpenAIQuicksilverRequestIds,
} from "./realtime-quicksilver-wire.js";
import { isSupportedOpenAIGptLiveModel } from "./realtime-quicksilver.js";

const RELAY_SAMPLE_RATE = 24_000;
const QUICKSILVER_SESSION_TTL_MS = 30 * 60_000;
const QUICKSILVER_CONNECT_TIMEOUT_MS = 30_000;
const WEBSOCKET_OPEN = 1;

type OpenAIQuicksilverBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  model: string;
  voice?: string;
  logger: Pick<PluginLogger, "debug" | "warn">;
  resolveAuth: () => Promise<OpenAIQuicksilverAuth>;
  createPeer?: (
    callbacks: OpenAIQuicksilverAudioPeerCallbacks,
    signal: AbortSignal,
  ) => Promise<OpenAIQuicksilverAudioPeerContract>;
  fetchImpl?: typeof fetch;
  webSocketFactory?: OpenAIQuicksilverSocketFactory;
  connectTimeoutMs?: number;
};

type ActiveSideband = {
  socket: OpenAIQuicksilverSocket;
  requestIds: OpenAIQuicksilverRequestIds;
};

type OpenAIQuicksilverGatewayTransport = "direct" | "webrtc";

function normalizeSidebandCloseReason(reason: Buffer | string | undefined): string {
  const text = typeof reason === "string" ? reason : (reason?.toString("utf8") ?? "");
  return text.replaceAll(/\s+/g, " ").trim().slice(0, 180);
}

function describeSidebandClose(code: number, reason: string): string {
  return `OpenAI GPT-Live sideband closed (code ${code}${reason ? `: ${reason}` : ""})`;
}

function connectAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("GPT-Live gateway relay startup stopped", { cause: signal.reason });
}

function waitForConnectStep<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(connectAbortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(connectAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(toErrorObject(error, "OpenAI GPT-Live gateway relay failed"));
      },
    );
  });
}

/** Realtime voice bridge used only when a Gateway relay injects the agent runner. */
export class OpenAIQuicksilverGatewayBridge implements RealtimeVoiceBridge {
  readonly supportsToolResultContinuation = false;
  readonly supportsToolResultSuppression = false;

  private abortController = new AbortController();
  private connectPromise: Promise<void> | undefined;
  private delegations: OpenAIQuicksilverDelegationController | undefined;
  private connected = false;
  private closed = false;
  private closeNotified = false;
  private peer: OpenAIQuicksilverAudioPeerContract | undefined;
  private pendingAudio = new OpenAIQuicksilverPendingAudio();
  private ready = false;
  private sideband: ActiveSideband | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private transport: OpenAIQuicksilverGatewayTransport | undefined;

  constructor(
    private readonly config: OpenAIQuicksilverBridgeConfig,
    private readonly runtime: OpenAIRealtimeHost,
  ) {}

  connect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("GPT-Live gateway relay bridge is closed"));
    }
    this.connectPromise ??= this.connectInternal();
    return this.connectPromise;
  }

  sendAudio(audio: Buffer): void {
    if (
      this.transport === "direct" &&
      this.ready &&
      this.sideband?.socket.readyState === WEBSOCKET_OPEN
    ) {
      this.sendDirectAudio(audio);
    } else if (this.peer) {
      this.peer.sendAudio(audio);
    } else if (!this.closed && !this.abortController.signal.aborted) {
      // Relay capture starts before transport readiness and may recycle its input buffers.
      this.pendingAudio.append(audio);
    }
  }

  setMediaTimestamp(_ts: number): void {}

  sendUserMessage(text: string): void {
    this.delegations?.sendSessionContext(text, "speakable");
  }

  submitToolResult(): void {
    throw new Error("GPT-Live gateway relay uses provider-owned agent delegations");
  }

  acknowledgeMark(): void {}

  close(options?: RealtimeVoiceCloseOptions): void {
    this.teardown("completed", undefined, options?.disposition ?? "abort");
  }

  isConnected(): boolean {
    return this.connected && !this.closed;
  }

  private async connectInternal(): Promise<void> {
    if (!this.config.runAgentConsult) {
      throw new Error("OpenAI GPT-Live gateway relay requires the Gateway agent-consult runtime");
    }
    const audioFormat = this.config.audioFormat;
    if (
      audioFormat &&
      (audioFormat.encoding !== "pcm16" ||
        audioFormat.sampleRateHz !== RELAY_SAMPLE_RATE ||
        audioFormat.channels !== 1)
    ) {
      throw new Error("OpenAI GPT-Live gateway relay requires mono PCM16 audio at 24 kHz");
    }
    reserveOpenAIQuicksilverSession(this);
    const connectSignal = AbortSignal.any([
      this.abortController.signal,
      AbortSignal.timeout(this.config.connectTimeoutMs ?? QUICKSILVER_CONNECT_TIMEOUT_MS),
    ]);
    let auth: OpenAIQuicksilverAuth;
    try {
      auth = await waitForConnectStep(this.config.resolveAuth(), connectSignal);
    } catch (error) {
      this.releaseResources("abort");
      throw this.redactAdmissionError(error);
    }
    try {
      const requestIds = {
        realtimeSessionId: randomUUID(),
        sessionId: randomUUID(),
        threadId: randomUUID(),
      };
      if (auth.type === "api-key" && !isSupportedOpenAIGptLiveModel(this.config.model)) {
        await this.connectDirect(auth, requestIds, connectSignal);
      } else {
        await this.connectWebRtc(auth, requestIds, connectSignal);
      }
      if (this.closed || connectSignal.aborted) {
        throw connectAbortError(connectSignal);
      }
      this.connected = true;
      if (!this.timer) {
        this.scheduleExpiry(QUICKSILVER_SESSION_TTL_MS);
      }
    } catch (error) {
      this.releaseResources("abort");
      throw this.redactError(error);
    }
  }

  private async connectDirect(
    auth: Extract<OpenAIQuicksilverAuth, { type: "api-key" }>,
    requestIds: OpenAIQuicksilverRequestIds,
    connectSignal: AbortSignal,
  ): Promise<void> {
    this.transport = "direct";
    let resolveReady!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    this.delegations = this.createDelegationController({
      onAudio: (audio) => this.config.onAudio(audio),
      onSessionStarted: resolveReady,
    });
    const connected = await this.connectSocket(
      auth,
      requestIds,
      buildOpenAIQuicksilverWebSocketUrl(this.config.model),
      connectSignal,
    );
    this.adoptConnectedSocket(connected);
    const { model: _model, ...session } = buildOpenAIQuicksilverSession({
      model: this.config.model,
      hostControlsInput: true,
      instructions: this.config.instructions,
      voice: this.config.voice,
    });
    this.sendSocketEvent({ type: "session.update", session });
    await waitForConnectStep(readyPromise, connectSignal);
  }

  private async connectWebRtc(
    auth: OpenAIQuicksilverAuth,
    requestIds: OpenAIQuicksilverRequestIds,
    connectSignal: AbortSignal,
  ): Promise<void> {
    this.transport = "webrtc";
    this.delegations = this.createDelegationController();
    const createPeer =
      this.config.createPeer ??
      (async (callbacks: OpenAIQuicksilverAudioPeerCallbacks, signal: AbortSignal) => {
        const { OpenAIQuicksilverAudioPeer } =
          await import("./realtime-quicksilver-peer.runtime.js");
        return await OpenAIQuicksilverAudioPeer.create({ callbacks, signal });
      });
    const peerPromise = createPeer(
      {
        onAudio: (audio) => this.config.onAudio(audio),
        onError: (error) => this.fail(error),
        onMediaError: () => this.config.logger.debug?.("GPT-Live WebRTC media packet dropped"),
        onRtpPacket: () => this.config.onEvent?.({ direction: "server", type: "output_audio.rtp" }),
      },
      connectSignal,
    );
    // A factory can finish after the deadline. Close that late peer because the
    // timed-out connect path can no longer adopt or release it synchronously.
    void peerPromise.then(
      (peer) => {
        if (connectSignal.aborted || this.closed) {
          peer.close();
        }
      },
      () => undefined,
    );
    this.peer = await waitForConnectStep(peerPromise, connectSignal);
    if (this.pendingAudio.length > 0) {
      const pendingAudio = this.pendingAudio;
      // Detach synchronously before adoption so bridge teardown can only clear
      // the new owner and no capture can interleave with the transfer.
      this.pendingAudio = new OpenAIQuicksilverPendingAudio();
      this.peer.adoptPendingAudio(pendingAudio);
    }
    const offerSdp = await waitForConnectStep(this.peer.createOffer(), connectSignal);
    const call = await waitForConnectStep(
      createOpenAIQuicksilverCall(
        {
          auth,
          requestIds,
          sdp: offerSdp,
          session: buildOpenAIQuicksilverSession({
            model: this.config.model,
            hostControlsInput: Boolean(this.config.handleDelegationInput),
            instructions: this.config.instructions,
            voice: this.config.voice,
          }),
          signal: connectSignal,
          fetchImpl: this.config.fetchImpl,
        },
        this.runtime,
      ),
      connectSignal,
    );
    if (call.kind !== "gpt-live") {
      throw new Error("GPT-Live gateway relay unexpectedly used the GA realtime call shape");
    }
    await waitForConnectStep(this.peer.applyAnswer(call.answerSdp), connectSignal);
    const connected = await this.connectSocket(auth, requestIds, call.sidebandUrl, connectSignal);
    this.adoptConnectedSocket(connected);
  }

  private async connectSocket(
    auth: OpenAIQuicksilverAuth,
    requestIds: OpenAIQuicksilverRequestIds,
    url: string,
    connectSignal: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof connectOpenAIQuicksilverSideband>>> {
    const createSocket =
      this.config.webSocketFactory ??
      ((socketUrl: string, options: Parameters<OpenAIQuicksilverSocketFactory>[1]) =>
        new WebSocket(socketUrl, options));
    const connected = await connectOpenAIQuicksilverSideband(
      {
        auth,
        createSocket,
        requestIds,
        signal: connectSignal,
        url,
      },
      this.runtime,
    );
    if (connectSignal.aborted) {
      connected.socket.close(1000, "session stopped");
      throw connectSignal.reason;
    }
    this.sideband = { socket: connected.socket, requestIds };
    this.attachSidebandHandlers(connected.socket);
    return connected;
  }

  private adoptConnectedSocket(
    connected: Awaited<ReturnType<typeof connectOpenAIQuicksilverSideband>>,
  ): void {
    const terminalEvent = connected.detachBuffer();
    for (const frame of connected.bufferedFrames) {
      this.handleSidebandFrame(frame.data, frame.isBinary);
    }
    if (terminalEvent?.kind === "error") {
      throw terminalEvent.error;
    }
    if (terminalEvent?.kind === "close") {
      const reason = normalizeSidebandCloseReason(terminalEvent.reason);
      throw new Error(describeSidebandClose(terminalEvent.code, reason));
    }
  }

  private createDelegationController(params?: {
    onAudio?: (audio: Buffer) => void;
    onSessionStarted?: () => void;
  }): OpenAIQuicksilverDelegationController {
    const runAgentConsult = this.config.runAgentConsult;
    if (!runAgentConsult) {
      throw new Error("OpenAI GPT-Live gateway relay requires the Gateway agent-consult runtime");
    }
    return new OpenAIQuicksilverDelegationController(
      {
        getSocket: () => this.sideband?.socket,
        logger: this.config.logger,
        model: this.config.model,
        onError: this.config.onError,
        onFatalError: (error) => this.fail(error),
        ...(params?.onAudio ? { onAudio: params.onAudio } : {}),
        onSessionStarted: (expiresAt) => {
          if (expiresAt !== undefined) {
            this.scheduleExpiry(
              Math.min(QUICKSILVER_SESSION_TTL_MS, Math.max(0, expiresAt * 1000 - Date.now())),
            );
          }
          if (!this.ready) {
            this.connected = true;
            this.ready = true;
            this.flushPendingDirectAudio();
            this.config.onReady?.();
          }
          params?.onSessionStarted?.();
        },
        onTranscript: (role, text, done) => this.config.onTranscript?.(role, text, done),
        handleDelegationInput: this.config.handleDelegationInput,
        onWireEventType: (eventType) => {
          this.config.onEvent?.({ direction: "server", type: eventType });
          if (eventType === "output_audio_buffer.cleared") {
            this.config.onClearAudio("barge-in");
          }
        },
        runAgentConsult,
        signal: this.abortController.signal,
      },
      this.runtime.formatErrorMessage,
    );
  }

  private flushPendingDirectAudio(): void {
    if (this.transport !== "direct" || this.pendingAudio.length === 0) {
      return;
    }
    const audio = Buffer.allocUnsafe(this.pendingAudio.length);
    const bytes = this.pendingAudio.readInto(audio);
    if (bytes > 0) {
      this.sendDirectAudio(audio.subarray(0, bytes));
    }
  }

  private sendDirectAudio(audio: Buffer): void {
    this.sendSocketEvent({ type: "input_audio.append", audio: audio.toString("base64") });
  }

  private sendSocketEvent(event: object): void {
    const socket = this.sideband?.socket;
    if (socket?.readyState === WEBSOCKET_OPEN) {
      socket.send(JSON.stringify(event));
    }
  }

  private attachSidebandHandlers(socket: OpenAIQuicksilverSocket): void {
    socket.on("message", (data, isBinary) => this.handleSidebandFrame(data, isBinary));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", (code, rawReason) => {
      const closeCode = code ?? 1006;
      const reason = normalizeSidebandCloseReason(rawReason);
      if (!this.closed) {
        if (closeCode === 1000) {
          this.teardown("completed");
        } else {
          this.fail(new Error(describeSidebandClose(closeCode, reason)));
        }
      }
    });
  }

  private handleSidebandFrame(data: RawData, isBinary: boolean): void {
    this.delegations?.handleFrame(data, isBinary);
  }

  private scheduleExpiry(ttlMs: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.teardown("completed"), Math.max(0, ttlMs));
    this.timer.unref?.();
  }

  private fail(error: Error): void {
    const redactedError = this.redactError(error);
    this.teardown("error", () => this.config.onError?.(redactedError));
  }

  private redactError(error: unknown): Error {
    const projected = new Error(projectOpenAIQuicksilverErrorMessage("gateway"));
    if (error instanceof Error && error.name === "TimeoutError") {
      projected.name = "TimeoutError";
    }
    return projected;
  }

  private redactAdmissionError(error: unknown): Error {
    const projected = new Error(projectOpenAIQuicksilverAuthErrorMessage(error));
    if (error instanceof Error && error.name === "TimeoutError") {
      projected.name = "TimeoutError";
    }
    return projected;
  }

  private teardown(
    reason: "completed" | "error",
    beforeClose?: () => void,
    disposition: RealtimeVoiceCloseDisposition = "abort",
  ): void {
    if (this.closed) {
      return;
    }
    // Claim terminal ownership and release resources before callbacks so reentrant close
    // cannot replace the outcome, while finally preserves error-before-close ordering.
    this.closed = true;
    this.releaseResources(disposition);
    try {
      beforeClose?.();
    } finally {
      if (!this.closeNotified) {
        this.closeNotified = true;
        this.config.onClose?.(reason);
      }
    }
  }

  private releaseResources(disposition: RealtimeVoiceCloseDisposition): void {
    releaseOpenAIQuicksilverSession(this);
    this.connected = false;
    this.ready = false;
    this.transport = undefined;
    this.pendingAudio.clear();
    if (disposition === "detach") {
      this.delegations?.detach();
    } else {
      this.delegations?.stop(new Error("GPT-Live delegation stopped"));
    }
    this.abortController.abort(new Error("GPT-Live gateway relay bridge closed"));
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const socket = this.sideband?.socket;
    this.sideband = undefined;
    if (socket?.readyState === WEBSOCKET_OPEN) {
      try {
        socket.send(JSON.stringify({ type: "session.close" }));
      } catch {
        // The sideband may close between readyState and send.
      }
    }
    try {
      socket?.close(1000, "session closed");
    } catch {
      // Socket teardown follows ownership release and is best effort.
    }
    this.peer?.close();
    this.peer = undefined;
  }
}

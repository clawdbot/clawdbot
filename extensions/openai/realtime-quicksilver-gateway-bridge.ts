// Gateway-owned GPT-Live WebRTC bridge: werift media peer plus OpenAI sideband control.
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
  buildOpenAIQuicksilverSidebandUrl,
  createOpenAIQuicksilverCall,
  type OpenAIQuicksilverAuth,
  type OpenAIQuicksilverRequestIds,
} from "./realtime-quicksilver-wire.js";

const RELAY_SAMPLE_RATE = 24_000;
const QUICKSILVER_SESSION_TTL_MS = 30 * 60_000;
const QUICKSILVER_CONNECT_TIMEOUT_MS = 30_000;
const WEBSOCKET_OPEN = 1;

export type OpenAIQuicksilverBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  model: string;
  voice: string;
  logger: Pick<PluginLogger, "debug" | "warn">;
  resolveAuth: () => Promise<OpenAIQuicksilverAuth>;
  /** Host-only control policy; ordinary native calls retain delegation behavior. */
  controlMode?: "capture" | "readback";
  createPeer?: (
    callbacks: OpenAIQuicksilverAudioPeerCallbacks,
    signal: AbortSignal,
  ) => Promise<OpenAIQuicksilverAudioPeerContract>;
  fetchImpl?: typeof fetch;
  webSocketFactory?: OpenAIQuicksilverSocketFactory;
  connectTimeoutMs?: number;
};

type AllocatedCall = {
  auth: OpenAIQuicksilverAuth;
  requestIds: OpenAIQuicksilverRequestIds;
  url: string;
};

type ActiveSideband = {
  socket: OpenAIQuicksilverSocket;
  requestIds: OpenAIQuicksilverRequestIds;
};

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
  private pendingCreation: Promise<unknown> | undefined;
  private cleanupPromise: Promise<void> | undefined;
  private allocatedCall: AllocatedCall | undefined;
  private delegations: OpenAIQuicksilverDelegationController | undefined;
  private connected = false;
  private closed = false;
  private closeNotified = false;
  private peer: OpenAIQuicksilverAudioPeerContract | undefined;
  private pendingAudio = new OpenAIQuicksilverPendingAudio();
  private ready = false;
  private sideband: ActiveSideband | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly config: OpenAIQuicksilverBridgeConfig,
    private readonly runtime: OpenAIRealtimeHost,
  ) {
    if (config.runAgentConsult || config.controlMode) {
      this.delegations = new OpenAIQuicksilverDelegationController(
        {
          getSocket: () => this.sideband?.socket,
          controlMode: config.controlMode,
          handleDelegationInput: config.handleDelegationInput,
          logger: config.logger,
          onError: config.onError,
          onFatalError: (error) => this.fail(error),
          onSessionStarted: (expiresAt) => {
            if (expiresAt !== undefined) {
              this.scheduleExpiry(
                Math.min(QUICKSILVER_SESSION_TTL_MS, Math.max(0, expiresAt * 1000 - Date.now())),
              );
            }
            if (!this.ready) {
              this.ready = true;
              this.config.onReady?.();
            }
          },
          onTranscript: (role, text, done) => {
            if (this.config.controlMode === "readback" && role === "assistant" && done) {
              // Flush packets already held by the reorder window before the
              // isolated output owner retires this call on native turn.done.
              this.peer?.flushInboundAudio();
            }
            if (!this.closed && !this.abortController.signal.aborted) {
              this.config.onTranscript?.(role, text, done);
            }
          },
          onWireEventType: (eventType) => {
            this.config.onEvent?.({ direction: "server", type: eventType });
            if (eventType === "output_audio_buffer.cleared") {
              this.config.onClearAudio("barge-in");
            }
          },
          runAgentConsult: config.runAgentConsult,
          signal: this.abortController.signal,
        },
        this.runtime.formatErrorMessage,
      );
    }
  }

  connect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("GPT-Live gateway relay bridge is closed"));
    }
    this.connectPromise ??= this.connectInternal();
    return this.connectPromise;
  }

  /** Serializes replacement even when a provider/factory ignores startup cancellation. */
  async waitForPendingResources(): Promise<void> {
    await this.pendingCreation?.catch(() => undefined);
    await this.cleanupPromise;
  }

  sendAudio(audio: Buffer): void {
    if (
      this.closed ||
      this.abortController.signal.aborted ||
      this.config.controlMode === "readback"
    ) {
      return;
    }
    if (this.peer) {
      this.peer.sendAudio(audio);
    } else if (!this.closed && !this.abortController.signal.aborted) {
      // Relay capture starts before asynchronous peer creation and may recycle its input buffers.
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
    if (!this.config.runAgentConsult && !this.config.controlMode) {
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
    try {
      const createPeer =
        this.config.createPeer ??
        (async (callbacks: OpenAIQuicksilverAudioPeerCallbacks, signal: AbortSignal) => {
          const { OpenAIQuicksilverAudioPeer } =
            await import("./realtime-quicksilver-peer.runtime.js");
          return await OpenAIQuicksilverAudioPeer.create({ callbacks, signal });
        });
      const peerPromise = createPeer(
        {
          onAudio: (audio) => {
            if (
              !this.closed &&
              !this.abortController.signal.aborted &&
              this.config.controlMode !== "capture"
            ) {
              this.config.onAudio(audio);
            }
          },
          onError: (error) => {
            if (!this.closed) {
              this.fail(error);
            }
          },
          onRtpPacket: () => {
            if (
              !this.closed &&
              !this.abortController.signal.aborted &&
              this.config.controlMode !== "capture"
            ) {
              this.config.onEvent?.({ direction: "server", type: "output_audio.rtp" });
            }
          },
        },
        connectSignal,
      );
      // A factory can finish after the deadline. Close that late peer because the
      // timed-out connect path can no longer adopt or release it synchronously.
      this.pendingCreation = peerPromise.then(
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
      const auth = await waitForConnectStep(this.config.resolveAuth(), connectSignal);
      const requestIds = {
        realtimeSessionId: randomUUID(),
        sessionId: randomUUID(),
        threadId: randomUUID(),
      };
      const callPromise = createOpenAIQuicksilverCall(
        {
          auth,
          requestIds,
          sdp: offerSdp,
          session: {
            ...buildOpenAIQuicksilverSession({
              model: this.config.model,
              hostControlsInput: Boolean(this.config.handleDelegationInput),
              instructions: this.config.instructions,
              voice: this.config.voice,
            }),
            // Existing native ack_filler is optional speech, not mandatory
            // delegation. Host-owned capture/readback must not produce it.
            ...(this.config.controlMode
              ? { delegation: { type: "client" as const, ack_filler: false as const } }
              : {}),
          },
          signal: connectSignal,
          fetchImpl: this.config.fetchImpl,
          onCallAllocated: (callId) => {
            const allocated = { auth, requestIds, url: buildOpenAIQuicksilverSidebandUrl(callId) };
            if (connectSignal.aborted || this.closed) {
              this.cleanupPromise = this.closeAllocatedCall(allocated);
            } else {
              this.allocatedCall = allocated;
            }
          },
        },
        this.runtime,
      );
      this.pendingCreation = callPromise;
      const call = await waitForConnectStep(callPromise, connectSignal);
      if (call.kind !== "gpt-live") {
        throw new Error("GPT-Live gateway relay unexpectedly used the GA realtime call shape");
      }
      await waitForConnectStep(this.peer.applyAnswer(call.answerSdp), connectSignal);
      const createSocket =
        this.config.webSocketFactory ??
        ((url: string, options: Parameters<OpenAIQuicksilverSocketFactory>[1]) =>
          new WebSocket(url, options));
      const connected = await connectOpenAIQuicksilverSideband(
        {
          auth,
          createSocket,
          requestIds,
          signal: connectSignal,
          url: call.sidebandUrl,
        },
        this.runtime,
      );
      if (connectSignal.aborted) {
        connected.socket.close(1000, "session stopped");
        throw connectSignal.reason;
      }
      this.allocatedCall = undefined;
      this.sideband = { socket: connected.socket, requestIds };
      this.attachSidebandHandlers(connected.socket);
      const terminalEvent = connected.detachBuffer();
      this.connected = true;
      this.scheduleExpiry(QUICKSILVER_SESSION_TTL_MS);
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
    } catch (error) {
      this.closed = true;
      this.releaseResources("abort");
      throw toErrorObject(error, "OpenAI GPT-Live gateway relay failed");
    }
  }

  private async closeAllocatedCall(call: AllocatedCall): Promise<void> {
    // Native calls expose session.close on their authenticated sideband, not a
    // GA hangup endpoint. Reattach only to retire a call allocated after cancellation.
    try {
      const connected = await connectOpenAIQuicksilverSideband(
        {
          ...call,
          createSocket:
            this.config.webSocketFactory ?? ((url, options) => new WebSocket(url, options)),
          signal: AbortSignal.timeout(
            this.config.connectTimeoutMs ?? QUICKSILVER_CONNECT_TIMEOUT_MS,
          ),
        },
        this.runtime,
      );
      connected.socket.on("error", () => undefined);
      connected.detachBuffer();
      try {
        connected.socket.send(JSON.stringify({ type: "session.close" }));
      } finally {
        connected.socket.close(1000, "session closed");
      }
    } catch {
      this.config.logger.warn("GPT-Live cancelled call could not be closed over its sideband");
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
    if (!this.closed && !this.abortController.signal.aborted) {
      this.delegations?.handleFrame(data, isBinary);
    }
  }

  private scheduleExpiry(ttlMs: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.teardown("completed"), Math.max(0, ttlMs));
    this.timer.unref?.();
  }

  private fail(error: Error): void {
    this.teardown("error", () => this.config.onError?.(error));
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
    this.pendingAudio.clear();
    if (disposition === "detach") {
      this.delegations?.detach();
    } else {
      this.delegations?.stop(new Error("GPT-Live delegation stopped"));
    }
    this.abortController.abort(new Error("GPT-Live gateway relay bridge closed"));
    const allocatedCall = this.allocatedCall;
    this.allocatedCall = undefined;
    if (allocatedCall) {
      this.cleanupPromise = this.closeAllocatedCall(allocatedCall);
    }
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

// Gateway-owned GPT-Live WebRTC bridge: werift media peer plus OpenAI sideband control.
import { randomUUID } from "node:crypto";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "openclaw/plugin-sdk/realtime-voice";
import WebSocket, { type RawData } from "ws";
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
  createOpenAIQuicksilverCall,
  type OpenAIQuicksilverAuth,
  type OpenAIQuicksilverRequestIds,
} from "./realtime-quicksilver-wire.js";

const RELAY_SAMPLE_RATE = 24_000;
const QUICKSILVER_SESSION_TTL_MS = 30 * 60_000;
const QUICKSILVER_CONNECT_TIMEOUT_MS = 30_000;
const WEBSOCKET_OPEN = 1;

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const value = error as { code?: unknown; message?: unknown; name?: unknown };
  return (
    value.name === "AbortError" ||
    value.code === "ABORT_ERR" ||
    value.message === "This operation was aborted"
  );
}

type OpenAIQuicksilverBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  model: string;
  voice: string;
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

  constructor(private readonly config: OpenAIQuicksilverBridgeConfig) {
    if (config.runAgentConsult) {
      this.delegations = new OpenAIQuicksilverDelegationController({
        getSocket: () => this.sideband?.socket,
        isCanceledError: isAbortLikeError,
        logger: config.logger,
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
        onTranscript: (role, text, done) => this.config.onTranscript?.(role, text, done),
        onWireEventType: (eventType) => {
          this.config.onEvent?.({ direction: "server", type: eventType });
          if (eventType === "output_audio_buffer.cleared") {
            this.config.onClearAudio("barge-in");
          }
        },
        runAgentConsult: config.runAgentConsult,
        signal: this.abortController.signal,
      });
    }
  }

  connect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("GPT-Live gateway relay bridge is closed"));
    }
    this.connectPromise ??= this.connectInternal();
    return this.connectPromise;
  }

  sendAudio(audio: Buffer): void {
    if (this.peer) {
      this.peer.sendAudio(audio);
    } else if (!this.closed && !this.abortController.signal.aborted) {
      // Relay capture starts before asynchronous peer creation and may recycle its input buffers.
      this.pendingAudio.append(audio);
    }
  }

  setMediaTimestamp(_ts: number): void {}

  sendUserMessage(text: string): void {
    this.delegations?.sendToActiveDelegation(text, "speakable");
  }

  submitToolResult(): void {
    throw new Error("GPT-Live gateway relay uses provider-owned agent delegations");
  }

  acknowledgeMark(): void {}

  close(): void {
    this.teardown("completed");
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
          onAudio: (audio) => this.config.onAudio(audio),
          onError: (error) => this.fail(error),
          onRtpPacket: () =>
            this.config.onEvent?.({ direction: "server", type: "output_audio.rtp" }),
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
      const auth = await waitForConnectStep(this.config.resolveAuth(), connectSignal);
      const requestIds = {
        realtimeSessionId: randomUUID(),
        sessionId: randomUUID(),
        threadId: randomUUID(),
      };
      const call = await waitForConnectStep(
        createOpenAIQuicksilverCall({
          auth,
          requestIds,
          sdp: offerSdp,
          session: buildOpenAIQuicksilverSession({
            model: this.config.model,
            instructions: this.config.instructions,
            voice: this.config.voice,
          }),
          signal: connectSignal,
          fetchImpl: this.config.fetchImpl,
        }),
        connectSignal,
      );
      if (call.kind !== "gpt-live") {
        throw new Error("GPT-Live gateway relay unexpectedly used the GA realtime call shape");
      }
      await waitForConnectStep(this.peer.applyAnswer(call.answerSdp), connectSignal);
      const createSocket =
        this.config.webSocketFactory ??
        ((url: string, options: Parameters<OpenAIQuicksilverSocketFactory>[1]) =>
          new WebSocket(url, options));
      const connected = await connectOpenAIQuicksilverSideband({
        auth,
        createSocket,
        requestIds,
        signal: connectSignal,
        url: call.sidebandUrl,
      });
      if (connectSignal.aborted) {
        connected.socket.close(1000, "session stopped");
        throw connectSignal.reason;
      }
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
      this.releaseResources();
      throw toErrorObject(error, "OpenAI GPT-Live gateway relay failed");
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
    this.teardown("error", () => this.config.onError?.(error));
  }

  private teardown(reason: "completed" | "error", beforeClose?: () => void): void {
    if (this.closed) {
      return;
    }
    // Claim terminal ownership and release resources before callbacks so reentrant close
    // cannot replace the outcome, while finally preserves error-before-close ordering.
    this.closed = true;
    this.releaseResources();
    try {
      beforeClose?.();
    } finally {
      if (!this.closeNotified) {
        this.closeNotified = true;
        this.config.onClose?.(reason);
      }
    }
  }

  private releaseResources(): void {
    releaseOpenAIQuicksilverSession(this);
    this.connected = false;
    this.pendingAudio.clear();
    this.abortController.abort(new Error("GPT-Live gateway relay bridge closed"));
    this.delegations?.stop(new Error("GPT-Live delegation stopped"));
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

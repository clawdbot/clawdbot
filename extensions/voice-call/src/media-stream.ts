/**
 * Media Stream Handler
 *
 * Handles bidirectional audio streaming between Twilio and the AI services.
 * - Receives mu-law audio from Twilio via WebSocket
 * - Forwards to the selected realtime transcription provider
 * - Sends TTS audio back to Twilio
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
} from "openclaw/plugin-sdk/realtime-transcription";
import {
  createTalkSessionController,
  recordTalkObservabilityEvent,
  type TalkEvent,
  type TalkEventInput,
  type TalkSessionController,
} from "openclaw/plugin-sdk/realtime-voice";
import { type RawData, WebSocket, WebSocketServer } from "ws";

/**
 * Configuration for the media stream handler.
 */
export interface MediaStreamConfig {
  /** Realtime transcription provider for streaming STT. */
  transcriptionProvider: RealtimeTranscriptionProviderPlugin;
  /** Provider-owned config blob passed into the transcription session. */
  providerConfig: RealtimeTranscriptionProviderConfig;
  /** Full runtime config, used by providers that can resolve OAuth profiles. */
  cfg?: OpenClawConfig;
  /** Close sockets that never send a valid `start` frame within this window. */
  preStartTimeoutMs?: number;
  /** Max concurrent pre-start sockets. */
  maxPendingConnections?: number;
  /** Max concurrent pre-start sockets from a single source IP. */
  maxPendingConnectionsPerIp?: number;
  /** Max total open sockets (pending + active sessions). */
  maxConnections?: number;
  /** Optional trusted resolver for the source IP used by pending-connection guards. */
  resolveClientIp?: (request: IncomingMessage) => string | undefined;
  /** Validate whether to accept a media stream for the given call ID */
  shouldAcceptStream?: (params: { callId: string; streamSid: string; token?: string }) => boolean;
  /** Callback when transcript is received */
  onTranscript?: (callId: string, transcript: string) => void;
  /** Callback for partial transcripts (streaming UI) */
  onPartialTranscript?: (callId: string, partial: string) => void;
  /** Callback when stream connects */
  onConnect?: (callId: string, streamSid: string) => void;
  /** Callback when realtime transcription is ready for the stream */
  onTranscriptionReady?: (callId: string, streamSid: string) => void;
  /** Callback when speech starts (barge-in) */
  onSpeechStart?: (callId: string) => void;
  /** Callback when stream disconnects */
  onDisconnect?: (callId: string, streamSid: string) => void;
  /** Callback for common Talk events emitted by the telephony STT/TTS adapter. */
  onTalkEvent?: (callId: string, streamSid: string, event: TalkEvent) => void;
}

/**
 * Active media stream session.
 */
interface StreamSession {
  callId: string;
  streamSid: string;
  ws: WebSocket;
  sttSession: RealtimeTranscriptionSession;
  talk: TalkSessionController;
}

type TtsQueueEntry = {
  playFn: (signal: AbortSignal) => Promise<void>;
  controller: AbortController;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type StreamSendResult = {
  sent: boolean;
  readyState?: number;
  bufferedBeforeBytes: number;
  bufferedAfterBytes: number;
};

type PendingConnection = {
  ip: string;
  timeout: ReturnType<typeof setTimeout>;
};

const DEFAULT_PRE_START_TIMEOUT_MS = 5000;
const DEFAULT_MAX_PENDING_CONNECTIONS = 32;
const DEFAULT_MAX_PENDING_CONNECTIONS_PER_IP = 4;
const DEFAULT_MAX_CONNECTIONS = 128;
const MAX_INBOUND_MESSAGE_BYTES = 64 * 1024;
const MAX_WS_BUFFERED_BYTES = 1024 * 1024;
const CLOSE_REASON_LOG_MAX_CHARS = 120;

export function sanitizeLogText(value: string, maxChars: number): string {
  const sanitized = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length <= maxChars) {
    return sanitized;
  }
  return `${sanitized.slice(0, maxChars)}...`;
}

function normalizeWsMessageData(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

export function parseTwilioMediaMessage(data: RawData): TwilioMediaMessage {
  const raw = normalizeWsMessageData(data);
  try {
    return JSON.parse(raw.toString("utf8")) as TwilioMediaMessage;
  } catch (cause) {
    throw new Error("Twilio media stream message was malformed JSON", { cause });
  }
}

/**
 * Manages WebSocket connections for Twilio media streams.
 */
export class MediaStreamHandler {
  private wss: WebSocketServer | null = null;
  private sessions = new Map<string, StreamSession>();
  private config: MediaStreamConfig;
  /** Pending sockets that have upgraded but not yet sent an accepted `start` frame. */
  private pendingConnections = new Map<WebSocket, PendingConnection>();
  /** Pending socket count per remote IP for pre-auth throttling. */
  private pendingByIp = new Map<string, number>();
  private preStartTimeoutMs: number;
  private maxPendingConnections: number;
  private maxPendingConnectionsPerIp: number;
  private maxConnections: number;
  private inflightUpgrades = 0;
  /** TTS playback queues per stream (serialize audio to prevent overlap) */
  private ttsQueues = new Map<string, TtsQueueEntry[]>();
  /** Whether TTS is currently playing per stream */
  private ttsPlaying = new Map<string, boolean>();
  /** Active TTS playback controllers per stream */
  private ttsActiveControllers = new Map<string, AbortController>();

  constructor(config: MediaStreamConfig) {
    this.config = config;
    this.preStartTimeoutMs = config.preStartTimeoutMs ?? DEFAULT_PRE_START_TIMEOUT_MS;
    this.maxPendingConnections = config.maxPendingConnections ?? DEFAULT_MAX_PENDING_CONNECTIONS;
    this.maxPendingConnectionsPerIp =
      config.maxPendingConnectionsPerIp ?? DEFAULT_MAX_PENDING_CONNECTIONS_PER_IP;
    this.maxConnections = config.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  }

  /**
   * Handle WebSocket upgrade for media stream connections.
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.wss) {
      this.wss = new WebSocketServer({
        noServer: true,
        // Reject oversized frames before app-level parsing runs on unauthenticated sockets.
        maxPayload: MAX_INBOUND_MESSAGE_BYTES,
      });
      this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    }

    const currentConnections = this.getCurrentConnectionCount();
    if (currentConnections >= this.maxConnections) {
      this.rejectUpgrade(socket, 503, "Too many media stream connections");
      return;
    }

    this.inflightUpgrades += 1;
    let released = false;
    const releaseUpgradeReservation = () => {
      if (released) {
        return;
      }
      released = true;
      this.inflightUpgrades = Math.max(0, this.inflightUpgrades - 1);
    };
    const handleUpgradeAbort = () => {
      socket.removeListener("error", handleUpgradeAbort);
      socket.removeListener("close", handleUpgradeAbort);
      releaseUpgradeReservation();
    };
    socket.once("error", handleUpgradeAbort);
    socket.once("close", handleUpgradeAbort);

    try {
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        socket.removeListener("error", handleUpgradeAbort);
        socket.removeListener("close", handleUpgradeAbort);
        releaseUpgradeReservation();
        this.wss?.emit("connection", ws, request);
      });
    } catch (error) {
      socket.removeListener("error", handleUpgradeAbort);
      socket.removeListener("close", handleUpgradeAbort);
      releaseUpgradeReservation();
      throw error;
    }
  }

  /**
   * Handle new WebSocket connection from Twilio.
   */
  private async handleConnection(ws: WebSocket, _request: IncomingMessage): Promise<void> {
    let session: StreamSession | null = null;
    const streamToken = this.getStreamToken(_request);
    const ip = this.getClientIp(_request);

    if (!this.registerPendingConnection(ws, ip)) {
      ws.close(1013, "Too many pending media stream connections");
      return;
    }

    ws.on("message", async (data: RawData) => {
      try {
        const message = parseTwilioMediaMessage(data);

        switch (message.event) {
          case "connected":
            console.log("[MediaStream] Twilio connected");
            break;

          case "start":
            session = this.handleStart(ws, message, streamToken);
            if (session) {
              this.clearPendingConnection(ws);
            }
            break;

          case "media":
            if (session && message.media?.payload) {
              // Forward audio to STT
              const audioBuffer = Buffer.from(message.media.payload, "base64");
              const turnId = this.ensureActiveTurn(session);
              this.emitTalkEvent(session, {
                type: "input.audio.delta",
                turnId,
                payload: {
                  callId: session.callId,
                  streamSid: session.streamSid,
                  bytes: audioBuffer.byteLength,
                },
              });
              session.sttSession.sendAudio(audioBuffer);
            }
            break;

          case "stop":
            if (session) {
              this.handleStop(session);
              session = null;
            }
            break;

          case "clear":
          case "mark":
            break;
        }
      } catch (error) {
        console.error("[MediaStream] Error processing message:", error);
      }
    });

    ws.on("close", (code, reason) => {
      const rawReason = Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "");
      const reasonText = sanitizeLogText(rawReason, CLOSE_REASON_LOG_MAX_CHARS);
      console.log(
        `[MediaStream] WebSocket closed (code: ${code}, reason: ${reasonText || "none"})`,
      );
      this.clearPendingConnection(ws);
      if (session) {
        this.handleStop(session);
      }
    });

    ws.on("error", (error) => {
      console.error("[MediaStream] WebSocket error:", error);
    });
  }

  /**
   * Handle stream start event.
   */
  private handleStart(
    ws: WebSocket,
    message: TwilioMediaMessage,
    streamToken?: string,
  ): StreamSession | null {
    const streamSid = message.streamSid || "";
    const callSid = message.start?.callSid || "";

    // Prefer token from start message customParameters (set via TwiML <Parameter>),
    // falling back to query string token. Twilio strips query params from WebSocket
    // URLs but reliably delivers <Parameter> values in customParameters.
    const effectiveToken = message.start?.customParameters?.token ?? streamToken;

    console.log(`[MediaStream] Stream started: ${streamSid} (call: ${callSid})`);
    if (!callSid) {
      console.warn("[MediaStream] Missing callSid; closing stream");
      ws.close(1008, "Missing callSid");
      return null;
    }
    if (
      this.config.shouldAcceptStream &&
      !this.config.shouldAcceptStream({ callId: callSid, streamSid, token: effectiveToken })
    ) {
      console.warn(`[MediaStream] Rejecting stream for unknown call: ${callSid}`);
      ws.close(1008, "Unknown call");
      return null;
    }

    const sttSession = this.config.transcriptionProvider.createSession({
      cfg: this.config.cfg,
      providerConfig: this.config.providerConfig,
      onPartial: (partial) => {
        const session = this.sessions.get(streamSid);
        if (session) {
          this.emitTalkEvent(session, {
            type: "transcript.delta",
            turnId: this.ensureActiveTurn(session),
            payload: { callId: callSid, streamSid, text: partial, role: "user" },
          });
        }
        this.config.onPartialTranscript?.(callSid, partial);
      },
      onTranscript: (transcript) => {
        const session = this.sessions.get(streamSid);
        if (session) {
          const turnId = this.ensureActiveTurn(session);
          this.emitTalkEvent(session, {
            type: "input.audio.committed",
            turnId,
            final: true,
            payload: { callId: callSid, streamSid },
          });
          this.emitTalkEvent(session, {
            type: "transcript.done",
            turnId,
            final: true,
            payload: { callId: callSid, streamSid, text: transcript, role: "user" },
          });
        }
        this.config.onTranscript?.(callSid, transcript);
      },
      onSpeechStart: () => {
        const session = this.sessions.get(streamSid);
        if (session) {
          this.ensureActiveTurn(session);
        }
        this.config.onSpeechStart?.(callSid);
      },
      onError: (error) => {
        console.warn("[MediaStream] Transcription session error:", error.message);
        const session = this.sessions.get(streamSid);
        if (session) {
          this.emitTalkEvent(session, {
            type: "session.error",
            final: true,
            payload: { callId: callSid, streamSid, error: error.message },
          });
        }
      },
    });

    const session: StreamSession = {
      callId: callSid,
      streamSid,
      ws,
      sttSession,
      talk: this.createTalkEvents(callSid, streamSid),
    };

    this.sessions.set(streamSid, session);
    this.config.onConnect?.(callSid, streamSid);
    this.emitTalkEvent(session, {
      type: "session.started",
      payload: { callId: callSid, streamSid, provider: this.config.transcriptionProvider.id },
    });
    void this.connectTranscriptionAndNotify(session);

    return session;
  }

  private async connectTranscriptionAndNotify(session: StreamSession): Promise<void> {
    try {
      await session.sttSession.connect();
    } catch (error) {
      console.warn(
        "[MediaStream] STT connection failed; closing media stream:",
        error instanceof Error ? error.message : String(error),
      );
      this.emitTalkEvent(session, {
        type: "session.error",
        final: true,
        payload: {
          callId: session.callId,
          streamSid: session.streamSid,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      if (
        this.sessions.get(session.streamSid) === session &&
        session.ws.readyState === WebSocket.OPEN
      ) {
        session.ws.close(1011, "STT connection failed");
      } else {
        session.sttSession.close();
      }
      return;
    }

    if (
      this.sessions.get(session.streamSid) !== session ||
      session.ws.readyState !== WebSocket.OPEN
    ) {
      session.sttSession.close();
      return;
    }

    this.emitTalkEvent(session, {
      type: "session.ready",
      payload: { callId: session.callId, streamSid: session.streamSid },
    });
    this.config.onTranscriptionReady?.(session.callId, session.streamSid);
  }

  /**
   * Handle stream stop event.
   */
  private handleStop(session: StreamSession): void {
    console.log(`[MediaStream] Stream stopped: ${session.streamSid}`);

    this.clearTtsState(session.streamSid);
    session.sttSession.close();
    this.sessions.delete(session.streamSid);
    this.emitTalkEvent(session, {
      type: "session.closed",
      final: true,
      payload: { callId: session.callId, streamSid: session.streamSid },
    });
    this.config.onDisconnect?.(session.callId, session.streamSid);
  }

  private getStreamToken(request: IncomingMessage): string | undefined {
    if (!request.url || !request.headers.host) {
      return undefined;
    }
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      return url.searchParams.get("token") ?? undefined;
    } catch {
      return undefined;
    }
  }

  private getClientIp(request: IncomingMessage): string {
    const resolvedIp = this.config.resolveClientIp?.(request)?.trim();
    if (resolvedIp) {
      return resolvedIp;
    }
    return request.socket.remoteAddress || "unknown";
  }

  private getCurrentConnectionCount(): number {
    return this.wss ? this.wss.clients.size + this.inflightUpgrades : this.inflightUpgrades;
  }

  private registerPendingConnection(ws: WebSocket, ip: string): boolean {
    if (this.pendingConnections.size >= this.maxPendingConnections) {
      console.warn("[MediaStream] Rejecting connection: pending connection limit reached");
      return false;
    }

    const pendingForIp = this.pendingByIp.get(ip) ?? 0;
    if (pendingForIp >= this.maxPendingConnectionsPerIp) {
      console.warn(`[MediaStream] Rejecting connection: pending per-IP limit reached (${ip})`);
      return false;
    }

    const timeout = setTimeout(() => {
      if (!this.pendingConnections.has(ws)) {
        return;
      }
      console.warn(
        `[MediaStream] Closing pre-start idle connection after ${this.preStartTimeoutMs}ms (${ip})`,
      );
      ws.close(1008, "Start timeout");
    }, this.preStartTimeoutMs);

    timeout.unref?.();
    this.pendingConnections.set(ws, { ip, timeout });
    this.pendingByIp.set(ip, pendingForIp + 1);
    return true;
  }

  private clearPendingConnection(ws: WebSocket): void {
    const pending = this.pendingConnections.get(ws);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingConnections.delete(ws);

    const current = this.pendingByIp.get(pending.ip) ?? 0;
    if (current <= 1) {
      this.pendingByIp.delete(pending.ip);
      return;
    }
    this.pendingByIp.set(pending.ip, current - 1);
  }

  private rejectUpgrade(socket: Duplex, statusCode: 429 | 503, message: string): void {
    const statusText = statusCode === 429 ? "Too Many Requests" : "Service Unavailable";
    const body = `${message}\n`;
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
        "Connection: close\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "\r\n" +
        body,
    );
    socket.destroy();
  }

  /**
   * Get an active session with an open WebSocket, or undefined if unavailable.
   */
  private getOpenSession(streamSid: string): StreamSession | undefined {
    const session = this.sessions.get(streamSid);
    return session?.ws.readyState === WebSocket.OPEN ? session : undefined;
  }

  /**
   * Send a message to a stream's WebSocket if available.
   */
  private sendToStream(streamSid: string, message: unknown): StreamSendResult {
    const session = this.sessions.get(streamSid);
    if (!session) {
      return {
        sent: false,
        bufferedBeforeBytes: 0,
        bufferedAfterBytes: 0,
      };
    }

    const readyState = session.ws.readyState;
    const bufferedBeforeBytes = session.ws.bufferedAmount;
    if (readyState !== WebSocket.OPEN) {
      return {
        sent: false,
        readyState,
        bufferedBeforeBytes,
        bufferedAfterBytes: session.ws.bufferedAmount,
      };
    }
    if (bufferedBeforeBytes > MAX_WS_BUFFERED_BYTES) {
      try {
        session.ws.close(1013, "Backpressure: send buffer exceeded");
      } catch {
        // Best-effort close; caller still receives sent:false.
      }
      return {
        sent: false,
        readyState,
        bufferedBeforeBytes,
        bufferedAfterBytes: session.ws.bufferedAmount,
      };
    }

    try {
      session.ws.send(JSON.stringify(message));
      const bufferedAfterBytes = session.ws.bufferedAmount;
      if (bufferedAfterBytes > MAX_WS_BUFFERED_BYTES) {
        try {
          session.ws.close(1013, "Backpressure: send buffer exceeded");
        } catch {
          // Best-effort close; caller still receives sent:false.
        }
        return {
          sent: false,
          readyState,
          bufferedBeforeBytes,
          bufferedAfterBytes,
        };
      }
      return {
        sent: true,
        readyState,
        bufferedBeforeBytes,
        bufferedAfterBytes,
      };
    } catch {
      return {
        sent: false,
        readyState,
        bufferedBeforeBytes,
        bufferedAfterBytes: session.ws.bufferedAmount,
      };
    }
  }

  /**
   * Send audio to a specific stream (for TTS playback).
   * Audio should be mu-law encoded at 8kHz mono.
   */
  sendAudio(streamSid: string, muLawAudio: Buffer): StreamSendResult {
    const session = this.getOpenSession(streamSid);
    if (session) {
      this.emitTalkEvent(session, {
        type: "output.audio.delta",
        turnId: this.ensureActiveTurn(session),
        payload: { callId: session.callId, streamSid, bytes: muLawAudio.byteLength },
      });
    }
    return this.sendToStream(streamSid, {
      event: "media",
      streamSid,
      media: { payload: muLawAudio.toString("base64") },
    });
  }

  /**
   * Send a mark event to track audio playback position.
   */
  sendMark(streamSid: string, name: string): StreamSendResult {
    return this.sendToStream(streamSid, {
      event: "mark",
      streamSid,
      mark: { name },
    });
  }

  /**
   * Clear audio buffer (interrupt playback).
   */
  clearAudio(streamSid: string): StreamSendResult {
    return this.sendToStream(streamSid, { event: "clear", streamSid });
  }

  /**
   * Queue a TTS operation for sequential playback.
   * Only one TTS operation plays at a time per stream to prevent overlap.
   */
  async queueTts(streamSid: string, playFn: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const queue = this.getTtsQueue(streamSid);
    let resolveEntry: () => void;
    let rejectEntry: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveEntry = resolve;
      rejectEntry = reject;
    });

    queue.push({
      playFn,
      controller: new AbortController(),
      resolve: resolveEntry!,
      reject: rejectEntry!,
    });

    if (!this.ttsPlaying.get(streamSid)) {
      void this.processQueue(streamSid);
    }

    return promise;
  }

  /**
   * Clear TTS queue and interrupt current playback (barge-in).
   */
  clearTtsQueue(streamSid: string, _reason = "unspecified"): void {
    const queue = this.getTtsQueue(streamSid);
    this.resolveQueuedTtsEntries(queue);
    this.ttsActiveControllers.get(streamSid)?.abort();
    const session = this.sessions.get(streamSid);
    if (session?.talk.activeTurnId) {
      const cancelled = session.talk.cancelTurn({
        payload: { callId: session.callId, streamSid, reason: _reason },
      });
      if (cancelled.ok) {
        this.config.onTalkEvent?.(session.callId, session.streamSid, cancelled.event);
      }
    }
    this.clearAudio(streamSid);
  }

  /**
   * Get active session by call ID.
   */
  getSessionByCallId(callId: string): StreamSession | undefined {
    return [...this.sessions.values()].find((session) => session.callId === callId);
  }

  /**
   * Close all sessions.
   */
  closeAll(): void {
    for (const session of this.sessions.values()) {
      this.clearTtsState(session.streamSid);
      session.sttSession.close();
      session.ws.close();
    }
    this.sessions.clear();
  }

  private getTtsQueue(streamSid: string): TtsQueueEntry[] {
    const existing = this.ttsQueues.get(streamSid);
    if (existing) {
      return existing;
    }
    const queue: TtsQueueEntry[] = [];
    this.ttsQueues.set(streamSid, queue);
    return queue;
  }

  /**
   * Process the TTS queue for a stream.
   * Uses iterative approach to avoid stack accumulation from recursion.
   */
  private async processQueue(streamSid: string): Promise<void> {
    this.ttsPlaying.set(streamSid, true);

    while (true) {
      const queue = this.ttsQueues.get(streamSid);
      if (!queue || queue.length === 0) {
        this.ttsPlaying.set(streamSid, false);
        this.ttsActiveControllers.delete(streamSid);
        return;
      }

      const entry = queue.shift()!;
      this.ttsActiveControllers.set(streamSid, entry.controller);
      const session = this.sessions.get(streamSid);
      let playbackTurnId: string | undefined;

      try {
        if (session) {
          playbackTurnId = this.ensureActiveTurn(session);
          this.emitTalkEvent(session, {
            type: "output.audio.started",
            turnId: playbackTurnId,
            payload: { callId: session.callId, streamSid },
          });
        }
        await entry.playFn(entry.controller.signal);
        if (entry.controller.signal.aborted) {
          entry.resolve();
          continue;
        }
        if (session) {
          const turnId = playbackTurnId ?? this.ensureActiveTurn(session);
          this.emitTalkEvent(session, {
            type: "output.audio.done",
            turnId,
            final: true,
            payload: { callId: session.callId, streamSid },
          });
          if (session.talk.activeTurnId) {
            const ended = session.talk.endTurn({
              payload: { callId: session.callId, streamSid },
            });
            if (ended.ok) {
              this.config.onTalkEvent?.(session.callId, session.streamSid, ended.event);
            }
          }
        }
        entry.resolve();
      } catch (error) {
        if (entry.controller.signal.aborted) {
          entry.resolve();
        } else {
          console.error("[MediaStream] TTS playback error:", error);
          entry.reject(error);
        }
      } finally {
        if (this.ttsActiveControllers.get(streamSid) === entry.controller) {
          this.ttsActiveControllers.delete(streamSid);
        }
      }
    }
  }

  private createTalkEvents(callId: string, streamSid: string): TalkSessionController {
    return createTalkSessionController(
      {
        sessionId: `voice-call:${callId}:${streamSid}`,
        mode: "stt-tts",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: this.config.transcriptionProvider.id,
        turnIdPrefix: `${streamSid}:turn`,
      },
      { onEvent: recordTalkObservabilityEvent },
    );
  }

  private emitTalkEvent(session: StreamSession, input: TalkEventInput): void {
    const event = session.talk.emit(input);
    this.config.onTalkEvent?.(session.callId, session.streamSid, event);
  }

  private ensureActiveTurn(session: StreamSession): string {
    const turn = session.talk.ensureTurn({
      payload: { callId: session.callId, streamSid: session.streamSid },
    });
    if (turn.event) {
      this.config.onTalkEvent?.(session.callId, session.streamSid, turn.event);
    }
    return turn.turnId;
  }

  private clearTtsState(streamSid: string): void {
    const queue = this.ttsQueues.get(streamSid);
    if (queue) {
      this.resolveQueuedTtsEntries(queue);
    }
    this.ttsActiveControllers.get(streamSid)?.abort();
    this.ttsActiveControllers.delete(streamSid);
    this.ttsPlaying.delete(streamSid);
    this.ttsQueues.delete(streamSid);
  }

  private resolveQueuedTtsEntries(queue: TtsQueueEntry[]): void {
    const pending = queue.splice(0);
    for (const entry of pending) {
      entry.controller.abort();
      entry.resolve();
    }
  }
}

/**
 * Twilio Media Stream message format.
 */
interface TwilioMediaMessage {
  event: "connected" | "start" | "media" | "stop" | "mark" | "clear";
  sequenceNumber?: string;
  streamSid?: string;
  start?: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: string[];
    customParameters?: Record<string, string>;
    mediaFormat: {
      encoding: string;
      sampleRate: number;
      channels: number;
    };
  };
  media?: {
    track?: string;
    chunk?: string;
    timestamp?: string;
    payload?: string;
  };
  mark?: {
    name: string;
  };
}

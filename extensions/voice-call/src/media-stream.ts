/**
 * Media Stream Handler
 *
 * Handles bidirectional audio streaming between Twilio and the AI services.
 * - Receives mu-law audio from Twilio via WebSocket
 * - Forwards to OpenAI Realtime STT for transcription
 * - Sends TTS audio back to Twilio
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import type {
  OpenAIRealtimeSTTProvider,
  RealtimeSTTSession,
} from "./providers/stt-openai-realtime.js";

/**
 * Configuration for the media stream handler.
 */
export interface MediaStreamConfig {
  /** STT provider for transcription */
  sttProvider: OpenAIRealtimeSTTProvider;
  /** Callback when transcript is received */
  onTranscript?: (callId: string, transcript: string) => void;
  /** Callback for partial transcripts (streaming UI) */
  onPartialTranscript?: (callId: string, partial: string) => void;
  /** Callback when stream connects */
  onConnect?: (callId: string, streamSid: string) => void;
  /** Callback when speech starts (barge-in) */
  onSpeechStart?: (callId: string) => void;
  /** Callback when stream disconnects */
  onDisconnect?: (callId: string) => void;
}

/**
 * Active media stream session.
 */
interface StreamSession {
  callId: string;
  streamSid: string;
  ws: WebSocket;
  sttSession: RealtimeSTTSession;
}

type TtsQueueEntry = {
  playFn: (signal: AbortSignal) => Promise<void>;
  controller: AbortController;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/**
 * Manages WebSocket connections for Twilio media streams.
 */
export class MediaStreamHandler {
  private wss: WebSocketServer | null = null;
  private sessions = new Map<string, StreamSession>();
  private config: MediaStreamConfig;
  /** TTS playback queues per stream (serialize audio to prevent overlap) */
  private ttsQueues = new Map<string, TtsQueueEntry[]>();
  /** Whether TTS is currently playing per stream */
  private ttsPlaying = new Map<string, boolean>();
  /** Active TTS playback controllers per stream */
  private ttsActiveControllers = new Map<string, AbortController>();

  constructor(config: MediaStreamConfig) {
    this.config = config;
  }

  /**
   * Handle WebSocket upgrade for media stream connections.
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.wss) {
      this.wss = new WebSocketServer({ noServer: true });
      this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss?.emit("connection", ws, request);
    });
  }

  /**
   * Handle new WebSocket connection from Twilio.
   */
  private async handleConnection(
    ws: WebSocket,
    _request: IncomingMessage,
  ): Promise<void> {
    let session: StreamSession | null = null;

    ws.on("message", async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as TwilioMediaMessage;

        switch (message.event) {
          case "connected":
            console.log("[MediaStream] Twilio connected");
            break;

          case "start":
            session = await this.handleStart(ws, message);
            break;

          case "media":
            if (session && message.media?.payload) {
              // Forward audio to STT
              const audioBuffer = Buffer.from(message.media.payload, "base64");
              session.sttSession.sendAudio(audioBuffer);
            }
            break;

          case "stop":
            if (session) {
              this.handleStop(session);
              session = null;
            }
            break;
        }
      } catch (error) {
        console.error("[MediaStream] Error processing message:", error);
      }
    });

    ws.on("close", () => {
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
  private async handleStart(
    ws: WebSocket,
    message: TwilioMediaMessage,
  ): Promise<StreamSession> {
    const streamSid = message.streamSid || "";
    const callSid = message.start?.callSid || "";

    console.log(
      `[MediaStream] Stream started: ${streamSid} (call: ${callSid})`,
    );

    // Create STT session
    const sttSession = this.config.sttProvider.createSession();

    // Set up transcript callbacks
    sttSession.onPartial((partial) => {
      this.config.onPartialTranscript?.(callSid, partial);
    });

    sttSession.onTranscript((transcript) => {
      this.config.onTranscript?.(callSid, transcript);
    });

    sttSession.onSpeechStart(() => {
      this.config.onSpeechStart?.(callSid);
    });

    const session: StreamSession = {
      callId: callSid,
      streamSid,
      ws,
      sttSession,
    };

    this.sessions.set(streamSid, session);

    // Notify connection BEFORE STT connect so TTS can work even if STT fails
    this.config.onConnect?.(callSid, streamSid);

    // Connect to OpenAI STT (non-blocking, log errors but don't fail the call)
    sttSession.connect().catch((err) => {
      console.warn(
        `[MediaStream] STT connection failed (TTS still works):`,
        err.message,
      );
    });

    return session;
  }

  /**
   * Handle stream stop event.
   */
  private handleStop(session: StreamSession): void {
    console.log(`[MediaStream] Stream stopped: ${session.streamSid}`);

    this.clearTtsState(session.streamSid);
    session.sttSession.close();
    this.sessions.delete(session.streamSid);
    this.config.onDisconnect?.(session.callId);
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
  private sendToStream(streamSid: string, message: unknown): void {
    const session = this.getOpenSession(streamSid);
    session?.ws.send(JSON.stringify(message));
  }

  /**
   * Send audio to a specific stream (for TTS playback).
   * Audio should be mu-law encoded at 8kHz mono.
   */
  sendAudio(streamSid: string, muLawAudio: Buffer): void {
    this.sendToStream(streamSid, {
      event: "media",
      streamSid,
      media: { payload: muLawAudio.toString("base64") },
    });
  }

  /**
   * Send a mark event to track audio playback position.
   */
  sendMark(streamSid: string, name: string): void {
    this.sendToStream(streamSid, {
      event: "mark",
      streamSid,
      mark: { name },
    });
  }

  /**
   * Clear audio buffer (interrupt playback).
   */
  clearAudio(streamSid: string): void {
    this.sendToStream(streamSid, { event: "clear", streamSid });
  }

  /**
   * Queue a TTS operation for sequential playback.
   * Only one TTS operation plays at a time per stream to prevent overlap.
   */
  async queueTts(
    streamSid: string,
    playFn: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
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
  clearTtsQueue(streamSid: string): void {
    const queue = this.getTtsQueue(streamSid);
    queue.length = 0;
    this.ttsActiveControllers.get(streamSid)?.abort();
    this.clearAudio(streamSid);
  }

  /**
   * Get active session by call ID.
   */
  getSessionByCallId(callId: string): StreamSession | undefined {
    return [...this.sessions.values()].find(
      (session) => session.callId === callId,
    );
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
    if (existing) return existing;
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

      try {
        await entry.playFn(entry.controller.signal);
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

  private clearTtsState(streamSid: string): void {
    const queue = this.ttsQueues.get(streamSid);
    if (queue) queue.length = 0;
    this.ttsActiveControllers.get(streamSid)?.abort();
    this.ttsActiveControllers.delete(streamSid);
    this.ttsPlaying.delete(streamSid);
    this.ttsQueues.delete(streamSid);
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

/**
 * OpenAI Realtime STT Provider
 *
 * Uses the OpenAI Realtime API for streaming transcription with:
 * - Direct mu-law audio support (no conversion needed)
 * - Built-in server-side VAD for turn detection
 * - Low-latency streaming transcription
 * - Partial transcript callbacks for real-time UI updates
 */

import WebSocket from "ws";

/**
 * Configuration for OpenAI Realtime STT.
 */
export interface RealtimeSTTConfig {
  /** OpenAI API key */
  apiKey: string;
  /** Model to use (default: gpt-4o-transcribe) */
  model?: string;
  /** Silence duration in ms before considering speech ended (default: 800) */
  silenceDurationMs?: number;
  /** VAD threshold 0-1 (default: 0.5) */
  vadThreshold?: number;
}

/**
 * Session for streaming audio and receiving transcripts.
 */
export interface RealtimeSTTSession {
  /** Connect to the transcription service */
  connect(): Promise<void>;
  /** Send mu-law audio data (8kHz mono) */
  sendAudio(audio: Buffer): void;
  /** Wait for next complete transcript (after VAD detects end of speech) */
  waitForTranscript(timeoutMs?: number): Promise<string>;
  /** Set callback for partial transcripts (streaming) */
  onPartial(callback: (partial: string) => void): void;
  /** Set callback for final transcripts */
  onTranscript(callback: (transcript: string) => void): void;
  /** Set callback when speech starts (VAD) */
  onSpeechStart(callback: () => void): void;
  /** Close the session */
  close(): void;
  /** Check if session is connected */
  isConnected(): boolean;
}

/**
 * Provider factory for OpenAI Realtime STT sessions.
 */
export class OpenAIRealtimeSTTProvider {
  readonly name = "openai-realtime";
  private apiKey: string;
  private model: string;
  private silenceDurationMs: number;
  private vadThreshold: number;

  constructor(config: RealtimeSTTConfig) {
    if (!config.apiKey) {
      throw new Error("OpenAI API key required for Realtime STT");
    }
    this.apiKey = config.apiKey;
    this.model = config.model || "gpt-4o-transcribe";
    this.silenceDurationMs = config.silenceDurationMs || 800;
    this.vadThreshold = config.vadThreshold || 0.5;
  }

  /**
   * Create a new realtime transcription session.
   */
  createSession(): RealtimeSTTSession {
    return new OpenAIRealtimeSTTSession(
      this.apiKey,
      this.model,
      this.silenceDurationMs,
      this.vadThreshold,
    );
  }
}

/**
 * WebSocket-based session for real-time speech-to-text.
 */
class OpenAIRealtimeSTTSession implements RealtimeSTTSession {
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly RECONNECT_DELAY_MS = 1000;

  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private reconnectAttempts = 0;
  private pendingTranscript = "";
  private onTranscriptCallback: ((transcript: string) => void) | null = null;
  private onPartialCallback: ((partial: string) => void) | null = null;
  private onSpeechStartCallback: (() => void) | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly silenceDurationMs: number,
    private readonly vadThreshold: number,
  ) {}

  async connect(): Promise<void> {
    this.closed = false;
    this.reconnectAttempts = 0;
    return this.doConnect();
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = "wss://api.openai.com/v1/realtime?intent=transcription";

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      this.ws.on("open", () => {
        console.log("[RealtimeSTT] WebSocket connected");
        this.connected = true;
        this.reconnectAttempts = 0;

        // Configure the transcription session
        this.sendEvent({
          type: "transcription_session.update",
          session: {
            input_audio_format: "g711_ulaw",
            input_audio_transcription: {
              model: this.model,
            },
            turn_detection: {
              type: "server_vad",
              threshold: this.vadThreshold,
              prefix_padding_ms: 300,
              silence_duration_ms: this.silenceDurationMs,
            },
          },
        });

        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString());
          this.handleEvent(event);
        } catch (e) {
          console.error("[RealtimeSTT] Failed to parse event:", e);
        }
      });

      this.ws.on("error", (error) => {
        console.error("[RealtimeSTT] WebSocket error:", error);
        if (!this.connected) reject(error);
      });

      this.ws.on("close", (code, reason) => {
        console.log(
          `[RealtimeSTT] WebSocket closed (code: ${code}, reason: ${reason?.toString() || "none"})`,
        );
        this.connected = false;

        // Attempt reconnection if not intentionally closed
        if (!this.closed) {
          void this.attemptReconnect();
        }
      });

      setTimeout(() => {
        if (!this.connected) {
          reject(new Error("Realtime STT connection timeout"));
        }
      }, 10000);
    });
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed) {
      return;
    }

    if (
      this.reconnectAttempts >= OpenAIRealtimeSTTSession.MAX_RECONNECT_ATTEMPTS
    ) {
      console.error(
        `[RealtimeSTT] Max reconnect attempts (${OpenAIRealtimeSTTSession.MAX_RECONNECT_ATTEMPTS}) reached`,
      );
      return;
    }

    this.reconnectAttempts++;
    const delay =
      OpenAIRealtimeSTTSession.RECONNECT_DELAY_MS *
      2 ** (this.reconnectAttempts - 1);
    console.log(
      `[RealtimeSTT] Reconnecting ${this.reconnectAttempts}/${OpenAIRealtimeSTTSession.MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`,
    );

    await new Promise((resolve) => setTimeout(resolve, delay));

    if (this.closed) {
      return;
    }

    try {
      await this.doConnect();
      console.log("[RealtimeSTT] Reconnected successfully");
    } catch (error) {
      console.error("[RealtimeSTT] Reconnect failed:", error);
    }
  }

  private handleEvent(event: {
    type: string;
    delta?: string;
    transcript?: string;
    error?: unknown;
  }): void {
    switch (event.type) {
      case "transcription_session.created":
      case "transcription_session.updated":
      case "input_audio_buffer.speech_stopped":
      case "input_audio_buffer.committed":
        console.log(`[RealtimeSTT] ${event.type}`);
        break;

      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.pendingTranscript += event.delta;
          this.onPartialCallback?.(this.pendingTranscript);
        }
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          console.log(`[RealtimeSTT] Transcript: ${event.transcript}`);
          this.onTranscriptCallback?.(event.transcript);
        }
        this.pendingTranscript = "";
        break;

      case "input_audio_buffer.speech_started":
        console.log("[RealtimeSTT] Speech started");
        this.pendingTranscript = "";
        this.onSpeechStartCallback?.();
        break;

      case "error":
        console.error("[RealtimeSTT] Error:", event.error);
        break;
    }
  }

  private sendEvent(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  sendAudio(muLawData: Buffer): void {
    if (!this.connected) return;
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: muLawData.toString("base64"),
    });
  }

  onPartial(callback: (partial: string) => void): void {
    this.onPartialCallback = callback;
  }

  onTranscript(callback: (transcript: string) => void): void {
    this.onTranscriptCallback = callback;
  }

  onSpeechStart(callback: () => void): void {
    this.onSpeechStartCallback = callback;
  }

  async waitForTranscript(timeoutMs = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.onTranscriptCallback = null;
        reject(new Error("Transcript timeout"));
      }, timeoutMs);

      this.onTranscriptCallback = (transcript) => {
        clearTimeout(timeout);
        this.onTranscriptCallback = null;
        resolve(transcript);
      };
    });
  }

  close(): void {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

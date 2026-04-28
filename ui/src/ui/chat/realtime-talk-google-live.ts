import { base64ToBytes, bytesToBase64, floatToPcm16, pcm16ToFloat } from "./realtime-talk-audio.ts";
import type { RealtimeTalkJsonPcmWebSocketSessionResult } from "./realtime-talk-shared.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  submitRealtimeTalkConsult,
  type RealtimeTalkTransport,
  type RealtimeTalkTransportContext,
} from "./realtime-talk-shared.ts";

type GoogleLiveMessage = {
  setupComplete?: unknown;
  serverContent?: {
    interrupted?: boolean;
    inputTranscription?: { text?: string; finished?: boolean };
    outputTranscription?: { text?: string; finished?: boolean };
    modelTurn?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        inlineData?: { data?: string; mimeType?: string };
      }>;
    };
    turnComplete?: boolean;
  };
  toolCall?: {
    functionCalls?: Array<{
      id?: string;
      name?: string;
      args?: unknown;
    }>;
  };
};

type PendingFunctionCall = {
  name: string;
  args: unknown;
};

const GOOGLE_LIVE_WEBSOCKET_HOST = "generativelanguage.googleapis.com";
const GOOGLE_LIVE_WEBSOCKET_PATH =
  /^\/ws\/google\.ai\.generativelanguage\.v[0-9a-z]+\.GenerativeService\.BidiGenerateContent(?:Constrained)?$/;

export function buildGoogleLiveUrl(session: RealtimeTalkJsonPcmWebSocketSessionResult): string {
  let url: URL;
  try {
    url = new URL(session.websocketUrl);
  } catch {
    throw new Error("Invalid Google Live WebSocket URL");
  }
  if (url.protocol !== "wss:") {
    throw new Error("Google Live WebSocket URL must use wss://");
  }
  if (url.hostname.toLowerCase() !== GOOGLE_LIVE_WEBSOCKET_HOST) {
    throw new Error("Untrusted Google Live WebSocket host");
  }
  if (url.username || url.password) {
    throw new Error("Google Live WebSocket URL must not include credentials");
  }
  if (!GOOGLE_LIVE_WEBSOCKET_PATH.test(url.pathname)) {
    throw new Error("Untrusted Google Live WebSocket path");
  }
  url.search = "";
  url.searchParams.set("access_token", session.clientSecret);
  return url.toString();
}

export class GoogleLiveRealtimeTalkTransport implements RealtimeTalkTransport {
  private ws: WebSocket | null = null;
  private media: MediaStream | null = null;
  private inputContext: AudioContext | null = null;
  private outputContext: AudioContext | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputProcessor: ScriptProcessorNode | null = null;
  private playhead = 0;
  private closed = false;
  private pendingCalls = new Map<string, PendingFunctionCall>();

  constructor(
    private readonly session: RealtimeTalkJsonPcmWebSocketSessionResult,
    private readonly ctx: RealtimeTalkTransportContext,
  ) {}

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof WebSocket === "undefined") {
      throw new Error("Realtime Talk requires browser WebSocket and microphone access");
    }
    if (this.session.protocol !== "google-live-bidi") {
      throw new Error(`Unsupported realtime WebSocket protocol: ${this.session.protocol}`);
    }
    const wsUrl = buildGoogleLiveUrl(this.session);
    this.closed = false;
    this.media = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.inputContext = new AudioContext({ sampleRate: this.session.audio.inputSampleRateHz });
    this.outputContext = new AudioContext({ sampleRate: this.session.audio.outputSampleRateHz });
    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener("open", () => {
      this.send(this.session.initialMessage ?? { setup: {} });
      this.startMicrophonePump();
    });
    this.ws.addEventListener("message", (event) => this.handleMessage(event.data));
    this.ws.addEventListener("close", () => {
      if (!this.closed) {
        this.ctx.callbacks.onStatus?.("error", "Realtime connection closed");
      }
    });
    this.ws.addEventListener("error", () => {
      if (!this.closed) {
        this.ctx.callbacks.onStatus?.("error", "Realtime connection failed");
      }
    });
  }

  stop(): void {
    this.closed = true;
    this.pendingCalls.clear();
    this.inputProcessor?.disconnect();
    this.inputProcessor = null;
    this.inputSource?.disconnect();
    this.inputSource = null;
    this.media?.getTracks().forEach((track) => track.stop());
    this.media = null;
    void this.inputContext?.close();
    this.inputContext = null;
    void this.outputContext?.close();
    this.outputContext = null;
    this.ws?.close();
    this.ws = null;
  }

  private startMicrophonePump(): void {
    if (!this.media || !this.inputContext) {
      return;
    }
    this.inputSource = this.inputContext.createMediaStreamSource(this.media);
    this.inputProcessor = this.inputContext.createScriptProcessor(4096, 1, 1);
    this.inputProcessor.onaudioprocess = (event) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        return;
      }
      const pcm = floatToPcm16(event.inputBuffer.getChannelData(0));
      this.send({
        realtimeInput: {
          audio: {
            data: bytesToBase64(pcm),
            mimeType: `audio/pcm;rate=${this.inputContext?.sampleRate ?? 16000}`,
          },
        },
      });
    };
    this.inputSource.connect(this.inputProcessor);
    this.inputProcessor.connect(this.inputContext.destination);
  }

  private send(message: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private handleMessage(data: unknown): void {
    let message: GoogleLiveMessage;
    try {
      message = JSON.parse(String(data)) as GoogleLiveMessage;
    } catch {
      return;
    }
    if (message.setupComplete) {
      this.ctx.callbacks.onStatus?.("listening");
    }
    const content = message.serverContent;
    if (content?.interrupted) {
      this.playhead = this.outputContext?.currentTime ?? 0;
    }
    if (content?.inputTranscription?.text) {
      this.ctx.callbacks.onTranscript?.({
        role: "user",
        text: content.inputTranscription.text,
        final: content.inputTranscription.finished ?? false,
      });
    }
    if (content?.outputTranscription?.text) {
      this.ctx.callbacks.onTranscript?.({
        role: "assistant",
        text: content.outputTranscription.text,
        final: content.outputTranscription.finished ?? false,
      });
    }
    for (const part of content?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        this.playPcm16(part.inlineData.data);
      } else if (!part.thought && typeof part.text === "string" && part.text.trim()) {
        this.ctx.callbacks.onTranscript?.({
          role: "assistant",
          text: part.text,
          final: content?.turnComplete ?? false,
        });
      }
    }
    for (const call of message.toolCall?.functionCalls ?? []) {
      void this.handleToolCall(call);
    }
  }

  private playPcm16(base64: string): void {
    if (!this.outputContext) {
      return;
    }
    const samples = pcm16ToFloat(base64ToBytes(base64));
    if (samples.length === 0) {
      return;
    }
    const buffer = this.outputContext.createBuffer(
      1,
      samples.length,
      this.session.audio.outputSampleRateHz,
    );
    buffer.getChannelData(0).set(samples);
    const source = this.outputContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outputContext.destination);
    const startAt = Math.max(this.outputContext.currentTime, this.playhead);
    source.start(startAt);
    this.playhead = startAt + buffer.duration;
  }

  private async handleToolCall(call: {
    id?: string;
    name?: string;
    args?: unknown;
  }): Promise<void> {
    const name = call.name?.trim();
    const callId = call.id?.trim();
    if (!name || !callId) {
      return;
    }
    this.pendingCalls.set(callId, { name, args: call.args ?? {} });
    if (name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      return;
    }
    await submitRealtimeTalkConsult({
      ctx: this.ctx,
      callId,
      args: call.args ?? {},
      submit: (toolCallId, result) => this.submitToolResult(toolCallId, result),
    });
  }

  private submitToolResult(callId: string, result: unknown): void {
    const pending = this.pendingCalls.get(callId);
    if (!pending) {
      return;
    }
    this.pendingCalls.delete(callId);
    this.send({
      toolResponse: {
        functionResponses: [
          {
            id: callId,
            name: pending.name,
            scheduling: "WHEN_IDLE",
            response:
              result && typeof result === "object" && !Array.isArray(result)
                ? result
                : { output: result },
          },
        ],
      },
    });
  }
}

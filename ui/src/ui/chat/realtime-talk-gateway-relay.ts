import { base64ToBytes, bytesToBase64, floatToPcm16, pcm16ToFloat } from "./realtime-talk-audio.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  submitRealtimeTalkConsult,
  type RealtimeTalkGatewayRelaySessionResult,
  type RealtimeTalkTransport,
  type RealtimeTalkTransportContext,
} from "./realtime-talk-shared.ts";

type GatewayRelayEvent =
  | { relaySessionId?: string; type?: "ready" }
  | { relaySessionId?: string; type?: "audio"; audioBase64?: string }
  | { relaySessionId?: string; type?: "clear" }
  | { relaySessionId?: string; type?: "mark"; markName?: string }
  | {
      relaySessionId?: string;
      type?: "transcript";
      role?: "user" | "assistant";
      text?: string;
      final?: boolean;
    }
  | {
      relaySessionId?: string;
      type?: "toolCall";
      callId?: string;
      name?: string;
      args?: unknown;
    }
  | { relaySessionId?: string; type?: "error"; message?: string }
  | { relaySessionId?: string; type?: "close"; reason?: string };

export class GatewayRelayRealtimeTalkTransport implements RealtimeTalkTransport {
  private media: MediaStream | null = null;
  private inputContext: AudioContext | null = null;
  private outputContext: AudioContext | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputProcessor: ScriptProcessorNode | null = null;
  private unsubscribe: (() => void) | null = null;
  private playhead = 0;
  private closed = false;
  private readonly sources = new Set<AudioBufferSourceNode>();

  constructor(
    private readonly session: RealtimeTalkGatewayRelaySessionResult,
    private readonly ctx: RealtimeTalkTransportContext,
  ) {}

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Realtime Talk requires browser microphone access");
    }
    if (
      this.session.audio.inputEncoding !== "pcm16" ||
      this.session.audio.outputEncoding !== "pcm16"
    ) {
      throw new Error("Gateway-relay realtime Talk currently requires PCM16 audio");
    }
    this.closed = false;
    this.unsubscribe = this.ctx.client.addEventListener((evt) => {
      if (evt.event !== "talk.realtime.relay") {
        return;
      }
      this.handleRelayEvent(evt.payload as GatewayRelayEvent);
    });
    this.media = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.inputContext = new AudioContext({ sampleRate: this.session.audio.inputSampleRateHz });
    this.outputContext = new AudioContext({ sampleRate: this.session.audio.outputSampleRateHz });
    this.startMicrophonePump();
  }

  stop(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.inputProcessor?.disconnect();
    this.inputProcessor = null;
    this.inputSource?.disconnect();
    this.inputSource = null;
    this.media?.getTracks().forEach((track) => track.stop());
    this.media = null;
    this.stopOutput();
    void this.inputContext?.close();
    this.inputContext = null;
    void this.outputContext?.close();
    this.outputContext = null;
    void this.ctx.client.request("talk.realtime.relayStop", {
      relaySessionId: this.session.relaySessionId,
    });
  }

  private startMicrophonePump(): void {
    if (!this.media || !this.inputContext) {
      return;
    }
    this.inputSource = this.inputContext.createMediaStreamSource(this.media);
    this.inputProcessor = this.inputContext.createScriptProcessor(4096, 1, 1);
    this.inputProcessor.onaudioprocess = (event) => {
      if (this.closed) {
        return;
      }
      const pcm = floatToPcm16(event.inputBuffer.getChannelData(0));
      void this.ctx.client.request("talk.realtime.relayAudio", {
        relaySessionId: this.session.relaySessionId,
        audioBase64: bytesToBase64(pcm),
        timestamp: Math.round((this.inputContext?.currentTime ?? 0) * 1000),
      });
    };
    this.inputSource.connect(this.inputProcessor);
    this.inputProcessor.connect(this.inputContext.destination);
  }

  private handleRelayEvent(event: GatewayRelayEvent): void {
    if (event.relaySessionId !== this.session.relaySessionId || this.closed) {
      return;
    }
    switch (event.type) {
      case "ready":
        this.ctx.callbacks.onStatus?.("listening");
        return;
      case "audio":
        if (event.audioBase64) {
          this.playPcm16(event.audioBase64);
        }
        return;
      case "clear":
        this.stopOutput();
        return;
      case "mark":
        this.scheduleMarkAck();
        return;
      case "transcript":
        if (event.role && event.text) {
          this.ctx.callbacks.onTranscript?.({
            role: event.role,
            text: event.text,
            final: event.final ?? false,
          });
        }
        return;
      case "toolCall":
        void this.handleToolCall(event);
        return;
      case "error":
        this.ctx.callbacks.onStatus?.("error", event.message ?? "Realtime relay failed");
        return;
      case "close":
        if (!this.closed) {
          this.ctx.callbacks.onStatus?.(
            event.reason === "error" ? "error" : "idle",
            event.reason === "error" ? "Realtime relay closed" : undefined,
          );
        }
        return;
      default:
        return;
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
    this.sources.add(source);
    source.addEventListener("ended", () => this.sources.delete(source));
    source.buffer = buffer;
    source.connect(this.outputContext.destination);
    const startAt = Math.max(this.outputContext.currentTime, this.playhead);
    source.start(startAt);
    this.playhead = startAt + buffer.duration;
  }

  private stopOutput(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {}
    }
    this.sources.clear();
    this.playhead = this.outputContext?.currentTime ?? 0;
  }

  private scheduleMarkAck(): void {
    const delayMs = Math.max(
      0,
      Math.ceil(
        ((this.playhead || this.outputContext?.currentTime || 0) -
          (this.outputContext?.currentTime ?? 0)) *
          1000,
      ),
    );
    window.setTimeout(() => {
      if (this.closed) {
        return;
      }
      void this.ctx.client.request("talk.realtime.relayMark", {
        relaySessionId: this.session.relaySessionId,
      });
    }, delayMs);
  }

  private async handleToolCall(event: Extract<GatewayRelayEvent, { type?: "toolCall" }>) {
    const callId = event.callId?.trim();
    const name = event.name?.trim();
    if (!callId || !name) {
      return;
    }
    if (name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      this.submitToolResult(callId, { error: `Tool "${name}" not available in browser Talk` });
      return;
    }
    await submitRealtimeTalkConsult({
      ctx: this.ctx,
      callId,
      args: event.args ?? {},
      submit: (toolCallId, result) => this.submitToolResult(toolCallId, result),
    });
  }

  private submitToolResult(callId: string, result: unknown): void {
    void this.ctx.client.request("talk.realtime.relayToolResult", {
      relaySessionId: this.session.relaySessionId,
      callId,
      result,
    });
  }
}

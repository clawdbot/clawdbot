import { base64ToBytes, bytesToBase64, floatToPcm16, pcm16ToFloat } from "./realtime-talk-audio.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  submitRealtimeTalkConsult,
  type RealtimeTalkGatewayRelaySessionResult,
  type RealtimeTalkEvent,
  type RealtimeTalkTransport,
  type RealtimeTalkTransportContext,
} from "./realtime-talk-shared.ts";

type GatewayRelayEvent = {
  relaySessionId?: string;
  talkEvent?: RealtimeTalkEvent;
} & (
  | { type?: "ready" }
  | { type?: "audio"; audioBase64?: string }
  | { type?: "clear" }
  | { type?: "mark"; markName?: string }
  | {
      type?: "transcript";
      role?: "user" | "assistant";
      text?: string;
      final?: boolean;
    }
  | {
      type?: "toolCall";
      callId?: string;
      name?: string;
      args?: unknown;
    }
  | { type?: "error"; message?: string }
  | { type?: "close"; reason?: string }
);

const BARGE_IN_RMS_THRESHOLD = 0.02;
const BARGE_IN_PEAK_THRESHOLD = 0.08;
const BARGE_IN_CONSECUTIVE_SPEECH_FRAMES = 2;

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
  private readonly consultAbortControllers = new Set<AbortController>();
  private cancelRequestedForPlayback = false;
  private speechFramesDuringPlayback = 0;
  private lastRelayError: string | undefined;

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
      if (evt.event !== "talk.event") {
        return;
      }
      this.handleRelayEvent(evt.payload as GatewayRelayEvent);
    });
    this.media = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    this.inputContext = new AudioContext({ sampleRate: this.session.audio.inputSampleRateHz });
    this.outputContext = new AudioContext({ sampleRate: this.session.audio.outputSampleRateHz });
    this.startMicrophonePump();
  }

  stop(): void {
    const wasClosed = this.closed;
    this.stopLocal();
    if (!wasClosed) {
      void this.ctx.client
        .request("talk.session.close", {
          sessionId: this.session.relaySessionId,
        })
        .catch(() => undefined);
    }
  }

  private stopLocal(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.inputProcessor?.disconnect();
    this.inputProcessor = null;
    this.inputSource?.disconnect();
    this.inputSource = null;
    this.abortConsults();
    this.media?.getTracks().forEach((track) => track.stop());
    this.media = null;
    this.stopOutput();
    void this.inputContext?.close();
    this.inputContext = null;
    void this.outputContext?.close();
    this.outputContext = null;
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
      const samples = event.inputBuffer.getChannelData(0);
      const pcm = floatToPcm16(samples);
      if (this.detectBargeInSpeech(samples)) {
        this.cancelOutputForBargeIn();
      }
      void this.ctx.client
        .request("talk.session.appendAudio", {
          sessionId: this.session.relaySessionId,
          audioBase64: bytesToBase64(pcm),
          timestamp: Math.round((this.inputContext?.currentTime ?? 0) * 1000),
        })
        .catch((error: unknown) => {
          if (!this.closed) {
            this.ctx.callbacks.onStatus?.(
              "error",
              error instanceof Error ? error.message : String(error),
            );
            this.stop();
          }
        });
    };
    this.inputSource.connect(this.inputProcessor);
    this.inputProcessor.connect(this.inputContext.destination);
  }

  private handleRelayEvent(event: GatewayRelayEvent): void {
    if (event.relaySessionId !== this.session.relaySessionId || this.closed) {
      return;
    }
    if (event.talkEvent) {
      this.ctx.callbacks.onTalkEvent?.(event.talkEvent);
    }
    switch (event.type) {
      case "ready":
        this.ctx.callbacks.onStatus?.("listening");
        return;
      case "audio":
        if (event.audioBase64) {
          this.cancelRequestedForPlayback = false;
          this.speechFramesDuringPlayback = 0;
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
        this.lastRelayError = event.message ?? "Realtime relay failed";
        this.ctx.callbacks.onStatus?.("error", this.lastRelayError);
        return;
      case "close":
        this.abortConsults();
        if (!this.closed) {
          this.ctx.callbacks.onStatus?.(
            event.reason === "error" ? "error" : "idle",
            event.reason === "error" ? (this.lastRelayError ?? "Realtime relay closed") : undefined,
          );
          this.stopLocal();
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
    this.speechFramesDuringPlayback = 0;
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
    const abortController = new AbortController();
    this.consultAbortControllers.add(abortController);
    try {
      await submitRealtimeTalkConsult({
        ctx: this.ctx,
        callId,
        args: event.args ?? {},
        relaySessionId: this.session.relaySessionId,
        signal: abortController.signal,
        submit: (toolCallId, result) => this.submitToolResult(toolCallId, result),
      });
    } finally {
      this.consultAbortControllers.delete(abortController);
    }
  }

  private submitToolResult(callId: string, result: unknown): void {
    void this.ctx.client.request("talk.session.submitToolResult", {
      sessionId: this.session.relaySessionId,
      callId,
      result,
    });
  }

  private cancelOutputForBargeIn(): void {
    if (this.sources.size === 0 || this.cancelRequestedForPlayback) {
      return;
    }
    this.cancelRequestedForPlayback = true;
    this.stopOutput();
    void this.ctx.client.request("talk.session.cancelOutput", {
      sessionId: this.session.relaySessionId,
      reason: "barge-in",
    });
  }

  private abortConsults(): void {
    for (const controller of this.consultAbortControllers) {
      controller.abort();
    }
    this.consultAbortControllers.clear();
  }

  private detectBargeInSpeech(samples: Float32Array): boolean {
    if (this.sources.size === 0 || this.cancelRequestedForPlayback || samples.length === 0) {
      this.speechFramesDuringPlayback = 0;
      return false;
    }

    let sumSquares = 0;
    let peak = 0;
    for (const sample of samples) {
      const abs = Math.abs(sample);
      peak = Math.max(peak, abs);
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / samples.length);
    if (rms >= BARGE_IN_RMS_THRESHOLD && peak >= BARGE_IN_PEAK_THRESHOLD) {
      this.speechFramesDuringPlayback += 1;
    } else {
      this.speechFramesDuringPlayback = 0;
    }
    return this.speechFramesDuringPlayback >= BARGE_IN_CONSECUTIVE_SPEECH_FRAMES;
  }
}

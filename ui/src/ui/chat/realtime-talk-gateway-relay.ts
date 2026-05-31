import { bytesToBase64, floatToPcm16 } from "./realtime-talk-audio.ts";
import { RealtimeTalkPcmOutputQueue } from "./realtime-talk-pcm-output.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  submitRealtimeTalkAgentControl,
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
      forced?: boolean;
    }
  | { type?: "toolResult"; callId?: string }
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
  private closed = false;
  private readonly outputQueue = new RealtimeTalkPcmOutputQueue();
  private readonly consultAbortControllers = new Map<string, AbortController>();
  private readonly completedToolCalls = new Set<string>();
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
      case "toolResult":
        if (this.isFinalToolResult(event)) {
          this.completeToolCall(event.callId);
        }
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

      default:
    }
  }

  private playPcm16(base64: string): void {
    this.outputQueue.play(base64, this.outputContext, this.session.audio.outputSampleRateHz);
  }

  private stopOutput(): void {
    this.outputQueue.stop(this.outputContext);
    this.speechFramesDuringPlayback = 0;
  }

  private scheduleMarkAck(): void {
    const delayMs = Math.max(
      0,
      Math.ceil(
        ((this.outputQueue.queuedUntil || this.outputContext?.currentTime || 0) -
          (this.outputContext?.currentTime ?? 0)) *
          1000,
      ),
    );
    window.setTimeout(() => {}, delayMs);
  }

  private async handleToolCall(event: Extract<GatewayRelayEvent, { type?: "toolCall" }>) {
    const callId = event.callId?.trim();
    const name = event.name?.trim();
    if (!callId || !name) {
      return;
    }
    if (name === REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME) {
      await submitRealtimeTalkAgentControl({
        ctx: this.ctx,
        callId,
        args: event.args ?? {},
        sessionId: this.session.relaySessionId,
        submit: (toolCallId, result) => this.submitToolResult(toolCallId, result),
      });
      return;
    }
    if (name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      this.submitToolResult(callId, { error: `Tool "${name}" not available in browser Talk` });
      return;
    }
    const abortController = new AbortController();
    this.consultAbortControllers.set(callId, abortController);
    try {
      if (event.forced) {
        this.submitToolResult(
          callId,
          {
            status: "working",
            tool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
            message:
              "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
          },
          { willContinue: true },
        );
      }
      await submitRealtimeTalkConsult({
        ctx: this.ctx,
        callId,
        args: event.args ?? {},
        relaySessionId: this.session.relaySessionId,
        signal: abortController.signal,
        submit: (toolCallId, result) => this.submitToolResult(toolCallId, result),
      });
    } finally {
      this.consultAbortControllers.delete(callId);
    }
  }

  private submitToolResult(
    callId: string,
    result: unknown,
    options?: { suppressResponse?: boolean; willContinue?: boolean },
  ): void {
    if (this.completedToolCalls.has(callId)) {
      return;
    }
    void this.ctx.client.request("talk.session.submitToolResult", {
      sessionId: this.session.relaySessionId,
      callId,
      result,
      ...(options ? { options } : {}),
    });
  }

  private completeToolCall(callIdRaw: string | undefined): void {
    const callId = callIdRaw?.trim();
    if (!callId) {
      return;
    }
    this.completedToolCalls.add(callId);
    this.consultAbortControllers.get(callId)?.abort();
    this.consultAbortControllers.delete(callId);
  }

  private isFinalToolResult(event: GatewayRelayEvent): boolean {
    const talkEvent = event.talkEvent;
    if (talkEvent?.type === "tool.progress") {
      return false;
    }
    if (talkEvent?.type === "tool.result" && talkEvent.final === false) {
      return false;
    }
    return true;
  }

  private cancelOutputForBargeIn(): void {
    if (!this.outputQueue.isPlaying || this.cancelRequestedForPlayback) {
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
    for (const controller of this.consultAbortControllers.values()) {
      controller.abort();
    }
    this.consultAbortControllers.clear();
  }

  private detectBargeInSpeech(samples: Float32Array): boolean {
    if (!this.outputQueue.isPlaying || this.cancelRequestedForPlayback || samples.length === 0) {
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

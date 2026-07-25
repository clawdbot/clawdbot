import {
  bytesToBase64,
  floatToPcm16,
  measureRealtimeTalkAudioFrame,
  RealtimeTalkMediaStreamMeter,
  RealtimeTalkPcmInputPump,
  RealtimeTalkPcmOutputQueue,
  type RealtimeTalkAudioFrame,
} from "./realtime-talk-audio.ts";
import type { DelayedToolResult, GatewayRelayEvent } from "./realtime-talk-gateway-relay-types.ts";
import { openRealtimeTalkInput } from "./realtime-talk-input.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  submitRealtimeTalkAgentControl,
  submitRealtimeTalkConsult,
  type RealtimeTalkGatewayRelaySessionResult,
  type RealtimeTalkTransport,
  type RealtimeTalkTransportContext,
} from "./realtime-talk-shared.ts";

const BARGE_IN_RMS_THRESHOLD = 0.02;
const BARGE_IN_PEAK_THRESHOLD = 0.08;
const BARGE_IN_CONSECUTIVE_SPEECH_FRAMES = 2;

export class GatewayRelayRealtimeTalkTransport implements RealtimeTalkTransport {
  private media: MediaStream | null = null;
  private inputContext: AudioContext | null = null;
  private outputContext: AudioContext | null = null;
  private inputMeter: RealtimeTalkMediaStreamMeter | null = null;
  private readonly inputPump = new RealtimeTalkPcmInputPump();
  private unsubscribe: (() => void) | null = null;
  private closed = false;
  private readonly outputQueue = new RealtimeTalkPcmOutputQueue();
  private readonly consultAbortControllers = new Map<string, AbortController>();
  private readonly completedToolCalls = new Set<string>();
  private readonly submittingToolCalls = new Set<string>();
  private readonly delayedToolResults = new Set<DelayedToolResult>();
  private readonly markAckTimers = new Set<number>();
  private cancelRequestedForPlayback = false;
  private pendingOutputCancellations = 0;
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
    let media: MediaStream;
    try {
      media = await openRealtimeTalkInput(this.ctx.inputDeviceId);
    } catch (error) {
      if (this.closed) {
        return;
      }
      throw error;
    }
    if (this.closed) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    this.media = media;
    this.inputContext = new AudioContext({ sampleRate: this.session.audio.inputSampleRateHz });
    this.outputContext = new AudioContext({ sampleRate: this.session.audio.outputSampleRateHz });
    if (this.ctx.callbacks.onInputLevel) {
      this.inputMeter = new RealtimeTalkMediaStreamMeter(this.ctx.callbacks.onInputLevel);
      this.inputMeter.start(this.media, this.inputContext);
    }
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
    this.inputPump.stop();
    this.inputMeter?.stop();
    this.inputMeter = null;
    // Mark callbacks recurse until playback drains, so shutdown must cancel every owned timer.
    this.markAckTimers.forEach((timer) => window.clearTimeout(timer));
    this.markAckTimers.clear();
    this.discardDelayedToolResults();
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
    this.inputPump.start(this.media, this.inputContext, (samples) => {
      if (this.closed) {
        return;
      }
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
    });
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
        this.stopOutput({ releaseDelayedToolResults: this.pendingOutputCancellations === 0 });
        if (event.talkEvent?.type === "turn.cancelled") {
          this.abortConsults();
        }
        return;
      case "mark":
        if (event.markName) {
          this.scheduleMarkAck(event.markName);
        }
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
        void this.handleToolCall(event).catch((error: unknown) => {
          this.reportToolResultSubmissionError(error);
        });
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

  private stopOutput(options: { releaseDelayedToolResults?: boolean } = {}): void {
    this.outputQueue.stop(this.outputContext);
    this.speechFramesDuringPlayback = 0;
    if (options.releaseDelayedToolResults ?? true) {
      this.flushDelayedToolResults();
    }
  }

  private scheduleMarkAck(markName: string): void {
    const delayMs = this.outputPlaybackDelayMs();
    if (delayMs > 0) {
      const timer = window.setTimeout(() => {
        this.markAckTimers.delete(timer);
        this.scheduleMarkAck(markName);
      }, delayMs);
      this.markAckTimers.add(timer);
      return;
    }
    if (this.closed) {
      return;
    }
    void this.ctx.client
      .request("talk.session.acknowledgeMark", {
        sessionId: this.session.relaySessionId,
        markName,
      })
      .catch((error: unknown) => this.reportToolResultSubmissionError(error));
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
      await this.submitToolResult(callId, {
        error: `Tool "${name}" not available in browser Talk`,
      });
      return;
    }
    const abortController = new AbortController();
    this.consultAbortControllers.set(callId, abortController);
    try {
      if (event.forced) {
        await this.submitToolResult(
          callId,
          {
            status: "working",
            tool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
            message:
              "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
          },
          { willContinue: true },
        );
        if (this.completedToolCalls.has(callId)) {
          return;
        }
        if (abortController.signal.aborted) {
          await this.submitToolResult(callId, { status: "cancelled" });
          return;
        }
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

  private async submitToolResult(
    callId: string,
    result: unknown,
    options?: { suppressResponse?: boolean; willContinue?: boolean },
  ): Promise<void> {
    if (this.completedToolCalls.has(callId)) {
      return;
    }
    const shouldAllowProviderResponse =
      options?.suppressResponse !== true && options?.willContinue !== true;
    if (
      !this.closed &&
      shouldAllowProviderResponse &&
      (this.pendingOutputCancellations > 0 || this.outputPlaybackDelayMs() > 0)
    ) {
      this.scheduleDelayedToolResult({ callId, result, ...(options ? { options } : {}) });
      return;
    }
    await this.sendToolResultNow(callId, result, options);
  }

  private async sendToolResultNow(
    callId: string,
    result: unknown,
    options?: { suppressResponse?: boolean; willContinue?: boolean },
  ): Promise<void> {
    if (this.completedToolCalls.has(callId)) {
      return;
    }
    this.submittingToolCalls.add(callId);
    try {
      await this.ctx.client.request("talk.session.submitToolResult", {
        sessionId: this.session.relaySessionId,
        callId,
        result,
        ...(options ? { options } : {}),
      });
    } finally {
      this.submittingToolCalls.delete(callId);
    }
  }

  private outputPlaybackDelayMs(): number {
    if (!this.outputContext) {
      return 0;
    }
    return Math.max(
      0,
      Math.ceil((this.outputQueue.queuedUntil - this.outputContext.currentTime) * 1000),
    );
  }

  private scheduleDelayedToolResult(pending: DelayedToolResult): void {
    this.delayedToolResults.add(pending);
    this.rescheduleDelayedToolResult(pending);
  }

  private rescheduleDelayedToolResult(pending: DelayedToolResult): void {
    if (this.closed) {
      this.discardDelayedToolResult(pending);
      return;
    }
    if (this.pendingOutputCancellations > 0) {
      return;
    }
    const playbackDelayMs = this.outputPlaybackDelayMs();
    if (playbackDelayMs > 0) {
      pending.timer = window.setTimeout(() => {
        pending.timer = undefined;
        this.rescheduleDelayedToolResult(pending);
      }, playbackDelayMs);
      return;
    }
    this.discardDelayedToolResult(pending);
    void this.sendToolResultNow(pending.callId, pending.result, pending.options).catch(
      (error: unknown) => {
        this.reportToolResultSubmissionError(error);
      },
    );
  }

  private flushDelayedToolResults(): void {
    for (const pending of this.delayedToolResults) {
      this.discardDelayedToolResult(pending);
      if (!this.closed) {
        void this.sendToolResultNow(pending.callId, pending.result, pending.options).catch(
          (error: unknown) => {
            this.reportToolResultSubmissionError(error);
          },
        );
      }
    }
  }

  private pauseDelayedToolResults(): void {
    for (const pending of this.delayedToolResults) {
      if (pending.timer !== undefined) {
        window.clearTimeout(pending.timer);
        pending.timer = undefined;
      }
    }
  }

  private discardDelayedToolResults(): void {
    for (const pending of this.delayedToolResults) {
      this.discardDelayedToolResult(pending);
    }
  }

  private discardDelayedToolResult(pending: DelayedToolResult): void {
    if (pending.timer !== undefined) {
      window.clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    this.delayedToolResults.delete(pending);
  }

  private reportToolResultSubmissionError(error: unknown): void {
    if (this.closed) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.lastRelayError = message;
    this.ctx.callbacks.onStatus?.("error", message);
  }

  private completeToolCall(callIdRaw: string | undefined): void {
    const callId = callIdRaw?.trim();
    if (!callId) {
      return;
    }
    this.completedToolCalls.add(callId);
    // The Gateway broadcasts acceptance before resolving the matching RPC.
    // Do not turn our own accepted result into a late consult cancellation.
    if (this.submittingToolCalls.has(callId)) {
      return;
    }
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
    // Keep completed consult results until the Gateway records this cancellation.
    // Releasing earlier can let the provider answer from a turn the user interrupted.
    this.pendingOutputCancellations += 1;
    this.pauseDelayedToolResults();
    this.stopOutput({ releaseDelayedToolResults: false });
    void this.ctx.client
      .request("talk.session.cancelOutput", {
        sessionId: this.session.relaySessionId,
        reason: "barge-in",
      })
      .then(
        () => {
          this.pendingOutputCancellations -= 1;
          if (this.pendingOutputCancellations === 0) {
            this.flushDelayedToolResults();
          }
        },
        (error: unknown) => {
          this.pendingOutputCancellations -= 1;
          this.reportToolResultSubmissionError(error);
          this.stop();
        },
      );
  }

  private abortConsults(): void {
    for (const controller of this.consultAbortControllers.values()) {
      controller.abort();
    }
    this.consultAbortControllers.clear();
  }

  private detectBargeInSpeech(samples: Float32Array): boolean {
    if (!this.outputQueue.isPlaying || this.cancelRequestedForPlayback) {
      this.speechFramesDuringPlayback = 0;
      return false;
    }
    const frame: RealtimeTalkAudioFrame = measureRealtimeTalkAudioFrame(samples);
    if (frame.rms >= BARGE_IN_RMS_THRESHOLD && frame.peak >= BARGE_IN_PEAK_THRESHOLD) {
      this.speechFramesDuringPlayback += 1;
    } else {
      this.speechFramesDuringPlayback = 0;
    }
    return this.speechFramesDuringPlayback >= BARGE_IN_CONSECUTIVE_SPEECH_FRAMES;
  }
}

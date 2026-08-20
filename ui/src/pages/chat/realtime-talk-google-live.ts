// Control UI chat module implements realtime talk google live behavior.
import { formatUiError } from "../../lib/format-error.ts";
import {
  bytesToBase64,
  estimateBase64DecodedByteLength,
  floatToPcm16,
  RealtimeTalkMediaStreamMeter,
  RealtimeTalkPcmInputPump,
  RealtimeTalkPcmOutputQueue,
} from "./realtime-talk-audio.ts";
import { RealtimeTalkCameraController } from "./realtime-talk-camera-controller.ts";
import {
  buildGoogleLiveUrl,
  GoogleLiveConnectionLifecycle,
  GOOGLE_LIVE_SETUP_TIMEOUT_MS,
  runRealtimeTalkCleanup,
} from "./realtime-talk-google-live-lifecycle.ts";
import {
  GoogleLiveToolOwner,
  type GoogleLiveFunctionCall,
} from "./realtime-talk-google-live-tools.ts";
import { openRealtimeTalkCamera, openRealtimeTalkInput } from "./realtime-talk-input.ts";
import {
  type RealtimeTalkJsonPcmWebSocketSessionResult,
  createRealtimeTalkEventEmitter,
  steerRealtimeTalkActiveConsult,
  shouldAutoControlRealtimeVoiceAgentText,
  type RealtimeTalkTransport,
  type RealtimeTalkTransportContext,
  type RealtimeTalkTransportStartResult,
} from "./realtime-talk-shared.ts";
import {
  captureRealtimeTalkVideoFrame,
  type RealtimeTalkVideoFrame,
} from "./realtime-talk-video.ts";

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
    functionCalls?: GoogleLiveFunctionCall[];
  };
  toolCallCancellation?: {
    ids?: string[];
  };
};

const GOOGLE_LIVE_VIDEO_FRAME_INTERVAL_MS = 1_000;
const GOOGLE_LIVE_VIDEO_MESSAGE_MAX_BYTES = 512 * 1024;
function googleLiveVideoMessage(frame: RealtimeTalkVideoFrame): unknown {
  return {
    realtimeInput: {
      video: frame,
    },
  };
}

// Browser sessions can still pin a 2.5 model, whose text and tool-response wire
// contract differs from the 3.1 default carried in new session metadata.
function isGemini31LiveModel(model: string | undefined): boolean {
  if (!model) {
    return true;
  }
  const modelId = model.startsWith("models/") ? model.slice("models/".length) : model;
  return modelId.startsWith("gemini-3.1-") && modelId.includes("-live");
}

export class GoogleLiveRealtimeTalkTransport implements RealtimeTalkTransport {
  private ws: WebSocket | null = null;
  private setupTimeout: ReturnType<typeof globalThis.setTimeout> | null = null;
  private media: MediaStream | null = null;
  private inputContext: AudioContext | null = null;
  private outputContext: AudioContext | null = null;
  private inputMeter: RealtimeTalkMediaStreamMeter | null = null;
  private readonly inputPump = new RealtimeTalkPcmInputPump();
  private closed = false;
  private mediaSetupController: AbortController | null = null;
  private readonly camera: RealtimeTalkCameraController;
  private readonly lifecycle = new GoogleLiveConnectionLifecycle();
  private cameraPublished = false;
  private videoFramesActive = false;
  private hasSentVideoFrame = false;
  private videoFrameTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private readonly outputQueue = new RealtimeTalkPcmOutputQueue();
  private readonly emitTalkEvent: ReturnType<typeof createRealtimeTalkEventEmitter>;
  private readonly toolOwner: GoogleLiveToolOwner;

  constructor(
    private readonly session: RealtimeTalkJsonPcmWebSocketSessionResult,
    private readonly ctx: RealtimeTalkTransportContext,
  ) {
    this.emitTalkEvent = createRealtimeTalkEventEmitter(ctx, session);
    this.toolOwner = new GoogleLiveToolOwner({
      ctx,
      emitTalkEvent: this.emitTalkEvent,
      isClosed: () => this.closed,
      failConnection: (detail) => {
        const ws = this.ws;
        if (ws) {
          this.failConnection(ws, detail);
        }
      },
      isDescribeViewActive: () =>
        this.videoFramesActive && this.hasSentVideoFrame && this.camera.hasUsableTrack(),
      sendResult: (callId, name, result) => this.sendToolResult(callId, name, result),
      sendControlSpeechMessage: (message) => this.sendControlSpeechMessage(message),
      stopOutputForSuppressedControl: (result) => this.stopOutputForSuppressedControl(result),
    });
    this.camera = new RealtimeTalkCameraController({
      acquire: (deviceId, signal) => openRealtimeTalkCamera(deviceId, { signal }),
      getDeviceId: () => this.ctx.videoDeviceId,
      setDeviceId: (deviceId) => (this.ctx.videoDeviceId = deviceId),
      isClosed: () => this.closed,
      onStream: (stream) => {
        if (stream) {
          if (!this.lifecycle.isActive) {
            return;
          }
          this.cameraPublished = true;
          this.ctx.callbacks.onVideoStream?.(stream);
        } else if (this.cameraPublished) {
          this.cameraPublished = false;
          this.ctx.callbacks.onVideoStream?.(null);
        }
      },
      onAcquired: () => {
        if (this.lifecycle.isActive) {
          this.startVideoFrames();
        }
      },
      onReleased: () => this.stopVideoFrames(),
    });
  }

  async start(): Promise<RealtimeTalkTransportStartResult> {
    if (!navigator.mediaDevices?.getUserMedia || typeof WebSocket === "undefined") {
      throw new Error("Realtime Talk requires browser WebSocket and microphone access");
    }
    if (this.session.protocol !== "google-live-bidi") {
      throw new Error(`Unsupported realtime WebSocket protocol: ${this.session.protocol}`);
    }
    const wsUrl = buildGoogleLiveUrl(this.session);
    this.closed = false;
    this.cameraPublished = false;
    this.mediaSetupController?.abort();
    const mediaSetupController = new AbortController();
    this.mediaSetupController = mediaSetupController;
    let media: MediaStream;
    try {
      media = await openRealtimeTalkInput(this.ctx.inputDeviceId, {
        signal: mediaSetupController.signal,
      });
    } catch (error) {
      if (this.closed) {
        return "cancelled";
      }
      throw error;
    } finally {
      if (this.mediaSetupController === mediaSetupController) {
        this.mediaSetupController = null;
      }
    }
    if (this.closed) {
      media.getTracks().forEach((track) => track.stop());
      return "cancelled";
    }
    this.media = media;
    this.inputContext = new AudioContext({ sampleRate: this.session.audio.inputSampleRateHz });
    this.outputContext = new AudioContext({ sampleRate: this.session.audio.outputSampleRateHz });
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    const startup = this.lifecycle.begin(ws);
    this.setupTimeout = globalThis.setTimeout(() => {
      if (this.closed || this.ws !== ws) {
        return;
      }
      this.setupTimeout = null;
      this.failConnection(
        ws,
        `Realtime connection timed out after ${GOOGLE_LIVE_SETUP_TIMEOUT_MS}ms`,
      );
    }, GOOGLE_LIVE_SETUP_TIMEOUT_MS);
    ws.addEventListener("open", () => {
      if (this.closed || this.ws !== ws) {
        return;
      }
      this.send(this.session.initialMessage ?? { setup: {} });
    });
    ws.addEventListener("message", (event) => {
      void this.handleMessage(ws, event.data);
    });
    ws.addEventListener("close", () => {
      this.failConnection(ws, "Realtime connection closed");
    });
    ws.addEventListener("error", () => {
      this.failConnection(ws, "Realtime connection failed");
    });
    return this.lifecycle.finishStart(await startup);
  }

  activate(): void {
    if (this.closed || !this.lifecycle.activate()) {
      return;
    }
    try {
      this.ctx.callbacks.onStatus?.("listening");
      this.assertActivationCurrent();
      this.emitTalkEvent({ type: "session.ready" });
      this.assertActivationCurrent();
      if (this.ctx.callbacks.onInputLevel && this.media && this.inputContext) {
        const inputMeter = new RealtimeTalkMediaStreamMeter(this.ctx.callbacks.onInputLevel);
        this.inputMeter = inputMeter;
        inputMeter.start(this.media, this.inputContext);
        this.assertActivationCurrent();
      }
      this.startMicrophonePump();
      if (this.camera.stream && !this.cameraPublished) {
        this.cameraPublished = true;
        this.ctx.callbacks.onVideoStream?.(this.camera.stream);
      }
      this.assertActivationCurrent();
      this.startVideoFrames();
    } catch (error) {
      try {
        this.stop({ emitClosed: false });
      } catch {
        // Preserve the activation callback as the terminal cause after cleanup.
      }
      throw error;
    }
  }

  private assertActivationCurrent(): void {
    if (this.closed || !this.lifecycle.isActive) {
      throw new Error("Google Live transport activation cancelled");
    }
  }

  async setVideoEnabled(enabled: boolean): Promise<void> {
    await this.camera.setEnabled(enabled);
  }

  async switchCamera(videoDeviceId: string | undefined): Promise<void> {
    await this.camera.switchDevice(videoDeviceId);
  }

  stop(options?: { emitClosed?: boolean }): void {
    const emitClosed = !this.closed && this.lifecycle.isActive && options?.emitClosed !== false;
    this.closed = true;
    this.lifecycle.cancel();
    runRealtimeTalkCleanup([
      () => {
        if (emitClosed) {
          this.emitTalkEvent({ type: "session.closed", final: true });
        }
      },
      () => this.releaseResources(),
    ]);
  }

  private releaseResources(): void {
    const mediaSetupController = this.mediaSetupController;
    this.mediaSetupController = null;
    this.clearSetupTimeout();
    const inputMeter = this.inputMeter;
    this.inputMeter = null;
    const media = this.media;
    this.media = null;
    const inputContext = this.inputContext;
    this.inputContext = null;
    const outputContext = this.outputContext;
    this.outputContext = null;
    const ws = this.ws;
    this.ws = null;
    runRealtimeTalkCleanup([
      () => mediaSetupController?.abort(),
      () => this.toolOwner.release(),
      () => this.inputPump.stop(),
      () => inputMeter?.stop(),
      ...(media?.getTracks() ?? []).map((track) => () => track.stop()),
      () => this.camera.release(),
      () => this.stopOutput(),
      () => {
        void inputContext?.close();
      },
      () => {
        void outputContext?.close();
      },
      () => ws?.close(),
    ]);
  }

  private clearSetupTimeout(): void {
    if (this.setupTimeout !== null) {
      globalThis.clearTimeout(this.setupTimeout);
      this.setupTimeout = null;
    }
  }

  private failConnection(ws: WebSocket, detail: string): void {
    // Error and close can arrive for the same socket, or after a replacement
    // starts. Only the current lifecycle owner may report and release resources.
    if (this.closed || this.ws !== ws) {
      return;
    }
    if (this.lifecycle.failStartup(ws, new Error(detail))) {
      try {
        this.stop({ emitClosed: false });
      } catch {
        // Startup rejection owns terminal precedence; cleanup still ran to completion.
      }
      return;
    }
    try {
      this.ctx.callbacks.onStatus?.("error", detail);
    } finally {
      // Socket failure is terminal even when a consumer callback rejects the update.
      this.stop();
    }
  }

  private startMicrophonePump(): void {
    if (this.closed || !this.media || !this.inputContext) {
      return;
    }
    this.inputPump.start(this.media, this.inputContext, (samples) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        return;
      }
      const pcm = floatToPcm16(samples);
      this.send({
        realtimeInput: {
          audio: {
            data: bytesToBase64(pcm),
            mimeType: `audio/pcm;rate=${this.inputContext?.sampleRate ?? 16000}`,
          },
        },
      });
    });
  }

  private send(message: unknown): boolean {
    if (!this.closed && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  private async handleMessage(ws: WebSocket, data: unknown): Promise<void> {
    if (this.closed || this.ws !== ws) {
      return;
    }
    let message: GoogleLiveMessage;
    try {
      message = JSON.parse(await decodeGoogleLiveMessageData(data)) as GoogleLiveMessage;
    } catch {
      return;
    }
    if (this.closed || this.ws !== ws) {
      return;
    }
    if (message.setupComplete && this.lifecycle.markReady(ws)) {
      this.clearSetupTimeout();
    }
    // The parent session adopts the candidate after start() resolves. Provider
    // events remain provisional until activate() publishes that ownership.
    if (!this.lifecycle.isActive) {
      return;
    }
    const content = message.serverContent;
    if (content?.interrupted) {
      this.stopOutput();
      this.emitTalkEvent({
        type: "turn.cancelled",
        final: true,
        payload: { reason: "provider-interrupted" },
      });
    }
    if (content?.inputTranscription?.text) {
      this.ctx.callbacks.onTranscript?.({
        role: "user",
        text: content.inputTranscription.text,
        final: content.inputTranscription.finished ?? false,
      });
      if (this.closed) {
        return;
      }
      this.emitTalkEvent({
        type: content.inputTranscription.finished ? "transcript.done" : "transcript.delta",
        final: content.inputTranscription.finished ?? false,
        payload: { role: "user", text: content.inputTranscription.text },
      });
      if (
        content.inputTranscription.finished &&
        this.toolOwner.hasPendingConsult() &&
        shouldAutoControlRealtimeVoiceAgentText(content.inputTranscription.text)
      ) {
        void steerRealtimeTalkActiveConsult({
          ctx: this.ctx,
          text: content.inputTranscription.text,
          emitTalkEvent: this.emitTalkEvent,
          onControlResult: (result) => this.stopOutputForSuppressedControl(result),
          speakControlResult: (messageLocal) => this.sendControlSpeechMessage(messageLocal),
          suppressSpeechForModes: ["cancel"],
        });
      }
    }
    if (content?.outputTranscription?.text) {
      this.ctx.callbacks.onTranscript?.({
        role: "assistant",
        text: content.outputTranscription.text,
        final: content.outputTranscription.finished ?? false,
      });
      if (this.closed) {
        return;
      }
      this.emitTalkEvent({
        type: content.outputTranscription.finished ? "output.text.done" : "output.text.delta",
        final: content.outputTranscription.finished ?? false,
        payload: { text: content.outputTranscription.text },
      });
    }
    for (const part of content?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        this.emitTalkEvent({
          type: "output.audio.delta",
          payload: {
            byteLength: estimateBase64DecodedByteLength(part.inlineData.data),
            mimeType: part.inlineData.mimeType,
          },
        });
        this.playPcm16(part.inlineData.data);
        if (this.closed) {
          return;
        }
      } else if (!part.thought && typeof part.text === "string" && part.text.trim()) {
        this.ctx.callbacks.onTranscript?.({
          role: "assistant",
          text: part.text,
          final: content?.turnComplete ?? false,
        });
        if (this.closed) {
          return;
        }
        this.emitTalkEvent({
          type: content?.turnComplete ? "output.text.done" : "output.text.delta",
          final: content?.turnComplete ?? false,
          payload: { text: part.text },
        });
      }
    }
    if (content?.turnComplete) {
      this.emitTalkEvent({ type: "turn.ended", final: true });
    }
    for (const call of message.toolCall?.functionCalls ?? []) {
      void this.toolOwner.handleCall(call).catch((error: unknown) => {
        this.reportToolResultSubmissionError(error);
      });
    }
    this.toolOwner.cancel(message.toolCallCancellation?.ids);
  }

  private playPcm16(base64: string): void {
    if (this.closed) {
      return;
    }
    const result = this.outputQueue.play(
      base64,
      this.outputContext,
      this.session.audio.outputSampleRateHz,
    );
    if (result !== "overflow") {
      return;
    }
    this.stopOutput();
    this.emitTalkEvent({
      type: "turn.cancelled",
      final: true,
      payload: { reason: "playback-overflow" },
    });
    this.ctx.callbacks.onStatus?.(
      "error",
      "Realtime Talk playback exceeded the browser audio buffer limit",
    );
    // Google Live exposes server-driven interruption but no client response-cancel
    // frame, so closing the session is the only deterministic provider-side stop.
    this.stop();
  }

  private stopOutput(): void {
    this.outputQueue.stop(this.outputContext);
  }

  private sendToolResult(callId: string, name: string, result: unknown): void {
    const sent = this.send({
      toolResponse: {
        functionResponses: [
          {
            id: callId,
            name,
            ...(!isGemini31LiveModel(this.session.model) ? { scheduling: "WHEN_IDLE" } : {}),
            response:
              result && typeof result === "object" && !Array.isArray(result)
                ? result
                : { output: result },
          },
        ],
      },
    });
    if (!sent) {
      throw new Error("Google Live socket is not open");
    }
  }

  private reportToolResultSubmissionError(error: unknown): void {
    if (this.closed) {
      return;
    }
    const message = formatUiError(error);
    this.ctx.callbacks.onStatus?.("error", message);
  }

  private startVideoFrames(): void {
    if (!this.camera.video || this.videoFramesActive || this.closed) {
      return;
    }
    this.videoFramesActive = true;
    this.scheduleVideoFrame(0);
  }

  private scheduleVideoFrame(delayMs: number): void {
    if (!this.videoFramesActive || this.closed) {
      return;
    }
    this.videoFrameTimer = globalThis.setTimeout(() => {
      this.videoFrameTimer = null;
      void this.sendVideoFrame();
    }, delayMs);
  }

  private async sendVideoFrame(): Promise<void> {
    if (!this.camera.hasLiveTrack()) {
      this.stopVideoFrames();
      return;
    }
    if (!this.camera.hasUsableTrack()) {
      this.scheduleVideoFrame(GOOGLE_LIVE_VIDEO_FRAME_INTERVAL_MS);
      return;
    }
    try {
      const frame = await captureRealtimeTalkVideoFrame(
        this.camera.video,
        GOOGLE_LIVE_VIDEO_MESSAGE_MAX_BYTES,
        googleLiveVideoMessage,
      );
      if (!this.videoFramesActive || this.closed) {
        return;
      }
      if (!this.send(googleLiveVideoMessage(frame))) {
        throw new Error("Google Live socket is not open");
      }
      this.hasSentVideoFrame = true;
    } catch (error) {
      if (!this.closed) {
        this.videoFramesActive = false;
        this.reportToolResultSubmissionError(error);
      }
      return;
    }
    this.scheduleVideoFrame(GOOGLE_LIVE_VIDEO_FRAME_INTERVAL_MS);
  }

  private stopVideoFrames(): void {
    this.videoFramesActive = false;
    this.hasSentVideoFrame = false;
    if (this.videoFrameTimer !== null) {
      globalThis.clearTimeout(this.videoFrameTimer);
      this.videoFrameTimer = null;
    }
  }

  private sendControlSpeechMessage(message: string): void {
    this.stopOutput();
    if (!isGemini31LiveModel(this.session.model)) {
      this.send({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: message }] }],
          turnComplete: true,
        },
      });
      return;
    }
    this.send({
      realtimeInput: {
        text: message,
      },
    });
  }

  private stopOutputForSuppressedControl(result: unknown): void {
    if (!result || typeof result !== "object") {
      return;
    }
    const record = result as Record<string, unknown>;
    if (
      record.ok === true &&
      (record.mode === "cancel" || (record.suppress === true && record.mode !== "steer"))
    ) {
      this.stopOutput();
    }
  }
}

async function decodeGoogleLiveMessageData(dataInput: unknown): Promise<string> {
  let data = dataInput;
  if (typeof data === "string") {
    return data;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    data = await data.arrayBuffer();
  }
  if (isArrayBufferLike(data)) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return String(data);
}

function isArrayBufferLike(data: unknown): data is ArrayBuffer {
  return (
    data instanceof ArrayBuffer || Object.prototype.toString.call(data) === "[object ArrayBuffer]"
  );
}

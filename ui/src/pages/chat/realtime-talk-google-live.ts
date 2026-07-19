// Control UI chat module implements realtime talk google live behavior.
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../src/talk/describe-view-tool.js";
import {
  base64ToBytes,
  bytesToBase64,
  floatToPcm16,
  RealtimeTalkMediaStreamMeter,
  RealtimeTalkPcmInputPump,
  RealtimeTalkPcmOutputQueue,
} from "./realtime-talk-audio.ts";
import { openRealtimeTalkCamera, openRealtimeTalkInput } from "./realtime-talk-input.ts";
import type { RealtimeTalkJsonPcmWebSocketSessionResult } from "./realtime-talk-shared.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  createRealtimeTalkEventEmitter,
  steerRealtimeTalkActiveConsult,
  shouldAutoControlRealtimeVoiceAgentText,
  submitRealtimeTalkAgentControl,
  submitRealtimeTalkConsult,
  type RealtimeTalkTransport,
  type RealtimeTalkTransportContext,
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

function buildGoogleLiveUrl(session: RealtimeTalkJsonPcmWebSocketSessionResult): string {
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
  private cameraMedia: MediaStream | null = null;
  private captureVideo: HTMLVideoElement | null = null;
  private inputContext: AudioContext | null = null;
  private outputContext: AudioContext | null = null;
  private inputMeter: RealtimeTalkMediaStreamMeter | null = null;
  private readonly inputPump = new RealtimeTalkPcmInputPump();
  private closed = false;
  private mediaSetupController: AbortController | null = null;
  private cameraSetupController: AbortController | null = null;
  private readonly handleCameraTrackEnded = () => this.releaseCamera();
  private setupComplete = false;
  private videoFramesActive = false;
  private hasSentVideoFrame = false;
  private videoFrameTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private pendingCalls = new Map<string, PendingFunctionCall>();
  private readonly consultAbortControllers = new Set<AbortController>();
  private readonly outputQueue = new RealtimeTalkPcmOutputQueue();
  private readonly emitTalkEvent: ReturnType<typeof createRealtimeTalkEventEmitter>;

  constructor(
    private readonly session: RealtimeTalkJsonPcmWebSocketSessionResult,
    private readonly ctx: RealtimeTalkTransportContext,
  ) {
    this.emitTalkEvent = createRealtimeTalkEventEmitter(ctx, session);
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof WebSocket === "undefined") {
      throw new Error("Realtime Talk requires browser WebSocket and microphone access");
    }
    if (this.session.protocol !== "google-live-bidi") {
      throw new Error(`Unsupported realtime WebSocket protocol: ${this.session.protocol}`);
    }
    const wsUrl = buildGoogleLiveUrl(this.session);
    this.closed = false;
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
        return;
      }
      throw error;
    } finally {
      if (this.mediaSetupController === mediaSetupController) {
        this.mediaSetupController = null;
      }
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
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("open", () => {
      if (this.closed) {
        return;
      }
      this.send(this.session.initialMessage ?? { setup: {} });
      this.startMicrophonePump();
    });
    this.ws.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
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

  async setVideoEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      this.releaseCamera();
      return;
    }
    if (this.closed) {
      throw new Error("Realtime Talk session is closed");
    }
    if (this.cameraMedia?.getVideoTracks().some((track) => track.readyState === "live")) {
      return;
    }
    this.cameraSetupController?.abort();
    const controller = new AbortController();
    this.cameraSetupController = controller;
    let camera: MediaStream;
    try {
      camera = await openRealtimeTalkCamera(this.ctx.videoDeviceId, {
        signal: controller.signal,
      });
    } catch (error) {
      if (this.closed || controller.signal.aborted) {
        return;
      }
      throw error;
    } finally {
      if (this.cameraSetupController === controller) {
        this.cameraSetupController = null;
      }
    }
    if (this.closed || controller.signal.aborted) {
      camera.getTracks().forEach((track) => track.stop());
      return;
    }
    this.cameraMedia = camera;
    // External track loss clears preview state so the next toggle reacquires the camera.
    camera
      .getVideoTracks()
      .forEach((track) =>
        track.addEventListener("ended", this.handleCameraTrackEnded, { once: true }),
      );
    const captureVideo = document.createElement("video");
    captureVideo.autoplay = true;
    captureVideo.muted = true;
    captureVideo.playsInline = true;
    captureVideo.srcObject = camera;
    this.captureVideo = captureVideo;
    this.ctx.callbacks.onVideoStream?.(camera);
    void captureVideo.play().catch(() => undefined);
    if (this.setupComplete) {
      this.startVideoFrames();
    }
  }

  async switchCamera(videoDeviceId: string | undefined): Promise<void> {
    const nextDeviceId = videoDeviceId?.trim() || undefined;
    const previousDeviceId =
      this.cameraMedia?.getVideoTracks()[0]?.getSettings?.().deviceId?.trim() ||
      this.ctx.videoDeviceId;
    const shouldReacquire = this.cameraMedia !== null || this.cameraSetupController !== null;
    this.ctx.videoDeviceId = nextDeviceId;
    if (!shouldReacquire) {
      return;
    }

    this.releaseCamera();
    try {
      await this.setVideoEnabled(true);
    } catch (error) {
      if (!this.closed && previousDeviceId !== nextDeviceId) {
        this.ctx.videoDeviceId = previousDeviceId;
        try {
          await this.setVideoEnabled(true);
        } catch {
          // The original switch failure is the actionable error for the user.
        }
      }
      throw error;
    }
  }

  stop(): void {
    if (!this.closed) {
      this.emitTalkEvent({ type: "session.closed", final: true });
    }
    this.closed = true;
    this.mediaSetupController?.abort();
    this.mediaSetupController = null;
    this.cameraSetupController?.abort();
    this.cameraSetupController = null;
    this.setupComplete = false;
    for (const controller of this.consultAbortControllers) {
      controller.abort();
    }
    this.consultAbortControllers.clear();
    this.pendingCalls.clear();
    this.inputPump.stop();
    this.inputMeter?.stop();
    this.inputMeter = null;
    this.media?.getTracks().forEach((track) => track.stop());
    this.media = null;
    this.releaseCamera();
    this.stopOutput();
    void this.inputContext?.close();
    this.inputContext = null;
    void this.outputContext?.close();
    this.outputContext = null;
    this.ws?.close();
    this.ws = null;
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

  private async handleMessage(data: unknown): Promise<void> {
    if (this.closed) {
      return;
    }
    let message: GoogleLiveMessage;
    try {
      message = JSON.parse(await decodeGoogleLiveMessageData(data)) as GoogleLiveMessage;
    } catch {
      return;
    }
    if (this.closed) {
      return;
    }
    if (message.setupComplete) {
      this.setupComplete = true;
      this.ctx.callbacks.onStatus?.("listening");
      this.emitTalkEvent({ type: "session.ready" });
      this.startVideoFrames();
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
      this.emitTalkEvent({
        type: content.inputTranscription.finished ? "transcript.done" : "transcript.delta",
        final: content.inputTranscription.finished ?? false,
        payload: { role: "user", text: content.inputTranscription.text },
      });
      if (
        content.inputTranscription.finished &&
        this.consultAbortControllers.size > 0 &&
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
            byteLength: base64ToBytes(part.inlineData.data).byteLength,
            mimeType: part.inlineData.mimeType,
          },
        });
        this.playPcm16(part.inlineData.data);
      } else if (!part.thought && typeof part.text === "string" && part.text.trim()) {
        this.ctx.callbacks.onTranscript?.({
          role: "assistant",
          text: part.text,
          final: content?.turnComplete ?? false,
        });
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
      void this.handleToolCall(call).catch((error: unknown) => {
        this.reportToolResultSubmissionError(error);
      });
    }
  }

  private playPcm16(base64: string): void {
    this.outputQueue.play(base64, this.outputContext, this.session.audio.outputSampleRateHz);
  }

  private stopOutput(): void {
    this.outputQueue.stop(this.outputContext);
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
    this.emitTalkEvent({
      type: "tool.call",
      callId,
      payload: { name, args: call.args ?? {} },
    });
    if (name === REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME) {
      await submitRealtimeTalkAgentControl({
        ctx: this.createActiveContext(),
        callId,
        args: call.args ?? {},
        emitTalkEvent: this.emitTalkEvent,
        submit: (toolCallId, result) => this.submitToolResult(toolCallId, result),
      });
      return;
    }
    if (name === REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME) {
      const active = this.videoFramesActive && this.hasSentVideoFrame && this.isCameraTrackUsable();
      this.submitToolResult(
        callId,
        active ? { ok: true, cameraStreamActive: true } : { ok: false, error: "camera is off" },
      );
      this.emitTalkEvent({
        type: active ? "tool.result" : "tool.error",
        callId,
        final: true,
        payload: {
          name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
          cameraStreamActive: active,
        },
      });
      return;
    }
    if (name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      return;
    }
    const abortController = new AbortController();
    this.consultAbortControllers.add(abortController);
    try {
      await submitRealtimeTalkConsult({
        ctx: this.createActiveContext(),
        callId,
        args: call.args ?? {},
        signal: abortController.signal,
        emitTalkEvent: this.emitTalkEvent,
        submit: (toolCallId, result) => this.submitToolResult(toolCallId, result),
      });
    } finally {
      this.consultAbortControllers.delete(abortController);
    }
  }

  private createActiveContext(): RealtimeTalkTransportContext {
    return {
      ...this.ctx,
      callbacks: {
        onStatus: (status, detail) => {
          if (!this.closed) {
            this.ctx.callbacks.onStatus?.(status, detail);
          }
        },
        onTranscript: (entry) => {
          if (!this.closed) {
            this.ctx.callbacks.onTranscript?.(entry);
          }
        },
        onTalkEvent: (event) => {
          if (!this.closed) {
            this.ctx.callbacks.onTalkEvent?.(event);
          }
        },
      },
    };
  }

  private submitToolResult(callId: string, result: unknown): void {
    const pending = this.pendingCalls.get(callId);
    if (!pending) {
      throw new Error(`Google Live has no pending tool call for ${callId}`);
    }
    const sent = this.send({
      toolResponse: {
        functionResponses: [
          {
            id: callId,
            name: pending.name,
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
    this.pendingCalls.delete(callId);
  }

  private reportToolResultSubmissionError(error: unknown): void {
    if (this.closed) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.ctx.callbacks.onStatus?.("error", message);
  }

  private startVideoFrames(): void {
    if (!this.captureVideo || this.videoFramesActive || this.closed) {
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
    if (!this.hasLiveCameraTrack()) {
      this.stopVideoFrames();
      return;
    }
    if (!this.isCameraTrackUsable()) {
      this.scheduleVideoFrame(GOOGLE_LIVE_VIDEO_FRAME_INTERVAL_MS);
      return;
    }
    try {
      const frame = await captureRealtimeTalkVideoFrame(
        this.captureVideo,
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

  private hasLiveCameraTrack(): boolean {
    return this.cameraMedia?.getVideoTracks().some((track) => track.readyState === "live") === true;
  }

  private isCameraTrackUsable(): boolean {
    return (
      this.cameraMedia
        ?.getVideoTracks()
        .some((track) => track.readyState === "live" && track.enabled && !track.muted) === true
    );
  }

  private releaseCamera(): void {
    this.cameraSetupController?.abort();
    this.cameraSetupController = null;
    this.stopVideoFrames();
    this.cameraMedia?.getVideoTracks().forEach((track) => {
      track.removeEventListener("ended", this.handleCameraTrackEnded);
      track.stop();
    });
    this.cameraMedia = null;
    if (this.captureVideo) {
      this.captureVideo.srcObject = null;
      this.captureVideo = null;
    }
    this.ctx.callbacks.onVideoStream?.(null);
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

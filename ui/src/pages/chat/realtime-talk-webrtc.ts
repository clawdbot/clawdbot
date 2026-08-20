import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../src/talk/describe-view-tool.js";
// Control UI chat module implements realtime talk webrtc behavior.
import { formatUiError } from "../../lib/format-error.ts";
import { RealtimeTalkMediaStreamMeter } from "./realtime-talk-audio.ts";
import { RealtimeTalkCameraController } from "./realtime-talk-camera-controller.ts";
import { openRealtimeTalkCamera, openRealtimeTalkInput } from "./realtime-talk-input.ts";
import {
  type RealtimeTalkWebRtcSdpSessionResult,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  createRealtimeTalkEventEmitter,
  steerRealtimeTalkActiveConsult,
  shouldAutoControlRealtimeVoiceAgentText,
  submitRealtimeTalkAgentControl,
  submitRealtimeTalkConsult,
  type RealtimeTalkTransport,
  type RealtimeTalkTransportContext,
  type RealtimeTalkTransportStartResult,
} from "./realtime-talk-shared.ts";
import { captureRealtimeTalkVideoFrame } from "./realtime-talk-video.ts";
import {
  RealtimeTalkWebRtcOfferExchange,
  RealtimeTalkResponseOutcomeOwner,
  realtimeTalkDataChannelMaxMessageSize,
  realtimeTalkImageEvent,
  type RealtimeServerEvent,
} from "./realtime-talk-webrtc-support.ts";

type CompletedToolCall = {
  itemId?: string;
  name: string;
  callId: string;
  args: string;
};

const MAX_REALTIME_TOOL_ARGUMENT_BYTES = 256_000;
// Realtime defines no replay window, so evicting terminal IDs could execute a
// very late duplicate. End an extreme session instead of weakening dedupe.
const MAX_COMPLETED_TOOL_CALL_IDS = 1_024;
const utf8Encoder = new TextEncoder();
const cancelledSetup = Symbol("cancelledSetup");

export class WebRtcSdpRealtimeTalkTransport implements RealtimeTalkTransport {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private media: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private inputMeter: RealtimeTalkMediaStreamMeter | null = null;
  private closed = false;
  private responseActive = false;
  private responseCreateInFlight = false;
  private responseCreatePending = false;
  private readonly responseOutcomes = new RealtimeTalkResponseOutcomeOwner(
    MAX_COMPLETED_TOOL_CALL_IDS,
  );
  private readonly completedToolCallIds = new Set<string>();
  private readonly offerExchange = new RealtimeTalkWebRtcOfferExchange();
  private mediaSetupController: AbortController | null = null;
  private readonly camera: RealtimeTalkCameraController;
  private readonly consultAbortControllers = new Set<AbortController>();
  private readonly emitTalkEvent: ReturnType<typeof createRealtimeTalkEventEmitter>;
  private starting = false;
  private startupError: Error | null = null;

  constructor(
    private readonly session: RealtimeTalkWebRtcSdpSessionResult,
    private readonly ctx: RealtimeTalkTransportContext,
  ) {
    this.emitTalkEvent = createRealtimeTalkEventEmitter(ctx, session);
    this.camera = new RealtimeTalkCameraController({
      acquire: (deviceId, signal) => openRealtimeTalkCamera(deviceId, { signal }),
      getDeviceId: () => this.ctx.videoDeviceId,
      setDeviceId: (deviceId) => (this.ctx.videoDeviceId = deviceId),
      isClosed: () => this.closed,
      onStream: (stream) => this.ctx.callbacks.onVideoStream?.(stream),
    });
  }

  async start(): Promise<RealtimeTalkTransportStartResult> {
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      throw new Error("Realtime Talk requires browser WebRTC and microphone access");
    }
    this.closed = false;
    this.starting = true;
    this.startupError = null;
    this.mediaSetupController?.abort();
    const peer = new RTCPeerConnection();
    this.peer = peer;
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.muted = false;
    this.audio.setAttribute("playsinline", "");
    this.audio.style.display = "none";
    document.body.append(this.audio);
    peer.addEventListener("track", (event) => {
      const stream = event.streams[0];
      if (this.audio && stream) {
        this.audio.srcObject = stream;
        const audio = this.audio;
        const play = (reportError: boolean) => {
          if (this.audio !== audio || this.closed) {
            return;
          }
          void audio.play().catch((error: unknown) => {
            if (reportError && this.audio === audio && !this.closed) {
              this.ctx.callbacks.onStatus?.(
                "error",
                `Realtime audio playback failed: ${formatUiError(error)}`,
              );
            }
          });
        };
        play(!event.track.muted);
        // iOS can deliver the remote track muted until media starts flowing.
        // Retrying on unmute gives Safari a second chance to attach the live stream.
        event.track.addEventListener("unmute", () => play(true), { once: true });
      }
    });
    const mediaSetupController = new AbortController();
    this.mediaSetupController = mediaSetupController;
    let media: MediaStream | typeof cancelledSetup;
    try {
      media = await this.awaitSetupStep(
        peer,
        openRealtimeTalkInput(this.ctx.inputDeviceId, {
          signal: mediaSetupController.signal,
        }),
      );
    } finally {
      if (this.mediaSetupController === mediaSetupController) {
        this.mediaSetupController = null;
      }
    }
    if (media === cancelledSetup) {
      return this.cancelledStart();
    }
    if (!this.isCurrentPeer(peer)) {
      media.getTracks().forEach((track) => track.stop());
      return this.cancelledStart();
    }
    this.media = media;
    if (this.ctx.callbacks.onInputLevel) {
      this.inputMeter = new RealtimeTalkMediaStreamMeter(this.ctx.callbacks.onInputLevel);
      this.inputMeter.start(media);
    }
    // Camera frames travel only as explicit describe_view data-channel events.
    // Keeping video off the peer prevents unintended continuous camera upload.
    for (const track of media.getAudioTracks()) {
      peer.addTrack(track, media);
    }
    const channel = peer.createDataChannel("oai-events");
    if (!this.isCurrentPeer(peer)) {
      channel.close();
      return this.cancelledStart();
    }
    this.channel = channel;
    channel.addEventListener("open", () => {
      this.ctx.callbacks.onStatus?.("listening");
      this.emitTalkEvent({ type: "session.ready" });
    });
    channel.addEventListener("message", (event) => this.handleRealtimeEvent(event.data));
    peer.addEventListener("connectionstatechange", () => {
      if (this.closed) {
        return;
      }
      if (this.peer?.connectionState === "failed" || this.peer?.connectionState === "closed") {
        this.failConnection("Realtime connection closed");
      }
    });

    const offer = await this.awaitSetupStep(peer, peer.createOffer());
    if (offer === cancelledSetup) {
      return this.cancelledStart();
    }
    if (!this.isCurrentPeer(peer)) {
      return this.cancelledStart();
    }
    const localDescriptionResult = await this.awaitSetupStep(peer, peer.setLocalDescription(offer));
    if (localDescriptionResult === cancelledSetup) {
      return this.cancelledStart();
    }
    if (!this.isCurrentPeer(peer)) {
      return this.cancelledStart();
    }
    const answerSdp = await this.offerExchange.readAnswer({
      session: this.session,
      offer,
      gatewayUrl: this.ctx.client.gatewayUrl,
      isCurrent: () => this.isCurrentPeer(peer),
    });
    if (answerSdp === undefined) {
      return this.cancelledStart();
    }
    if (!this.isCurrentPeer(peer)) {
      return this.cancelledStart();
    }
    const remoteDescriptionResult = await this.awaitSetupStep(
      peer,
      peer.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      }),
    );
    if (remoteDescriptionResult === cancelledSetup || !this.isCurrentPeer(peer)) {
      return this.cancelledStart();
    }
    this.starting = false;
    return "ready";
  }

  async setVideoEnabled(enabled: boolean): Promise<void> {
    await this.camera.setEnabled(enabled);
  }

  async switchCamera(videoDeviceId: string | undefined): Promise<void> {
    await this.camera.switchDevice(videoDeviceId);
  }

  private isCurrentPeer(peer: RTCPeerConnection): boolean {
    return !this.closed && this.peer === peer;
  }

  private cancelledStart(): RealtimeTalkTransportStartResult {
    const startupError = this.currentStartupError();
    if (startupError) {
      throw startupError;
    }
    return "cancelled";
  }

  private currentStartupError(): Error | null {
    return this.startupError;
  }

  private async awaitSetupStep<T>(
    peer: RTCPeerConnection,
    promise: Promise<T>,
  ): Promise<T | typeof cancelledSetup> {
    try {
      return await promise;
    } catch (error) {
      if (!this.isCurrentPeer(peer)) {
        return cancelledSetup;
      }
      throw error;
    }
  }

  stop(options?: { emitClosed?: boolean }): void {
    const emitClosed = !this.closed && options?.emitClosed !== false;
    this.closed = true;
    try {
      if (emitClosed) {
        this.emitTalkEvent({ type: "session.closed", final: true });
      }
    } finally {
      this.releaseResources();
    }
  }

  private releaseResources(): void {
    this.starting = false;
    this.mediaSetupController?.abort();
    this.mediaSetupController = null;
    this.offerExchange.abort();
    this.channel?.close();
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    this.media?.getTracks().forEach((track) => track.stop());
    this.media = null;
    this.camera.release();
    this.inputMeter?.stop();
    this.inputMeter = null;
    this.audio?.remove();
    this.audio = null;
    for (const controller of this.consultAbortControllers) {
      controller.abort();
    }
    this.consultAbortControllers.clear();
    this.completedToolCallIds.clear();
    this.responseOutcomes.reset();
    this.responseActive = false;
    this.responseCreateInFlight = false;
    this.responseCreatePending = false;
  }

  private failConnection(detail: string): void {
    if (this.closed) {
      return;
    }
    const wasStarting = this.starting;
    try {
      if (!wasStarting) {
        this.ctx.callbacks.onStatus?.("error", detail);
      } else {
        this.startupError = new Error(detail);
      }
    } finally {
      // A terminal peer failure still owns browser media if status delivery fails.
      this.stop({ emitClosed: !wasStarting });
    }
  }

  private send(event: unknown): void {
    if (this.channel?.readyState === "open") {
      this.channel.send(JSON.stringify(event));
    }
  }

  private handleRealtimeEvent(data: unknown): void {
    if (this.closed) {
      return;
    }
    let event: RealtimeServerEvent;
    try {
      event = JSON.parse(String(data)) as RealtimeServerEvent;
    } catch {
      return;
    }
    switch (event.type) {
      case "input_transcript.added":
        this.emitFramelessTranscript("user", event.item?.text, false, event.item?.id);
        return;
      case "output_transcript.added":
        this.emitFramelessTranscript("assistant", event.item?.text, false, event.item?.id);
        return;
      case "turn.done": {
        const role = event.turn?.role;
        if (role === "user" || role === "assistant") {
          this.emitFramelessTranscript(role, event.turn?.transcript, true, event.turn?.id);
          if (this.closed) {
            return;
          }
          if (role === "assistant") {
            this.ctx.callbacks.onStatus?.("listening");
            this.emitTalkEvent({
              type: "turn.ended",
              final: true,
              payload: { status: "completed" },
            });
          }
        }
        return;
      }
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.ctx.callbacks.onTranscript?.({ role: "user", text: event.transcript, final: true });
          if (this.closed) {
            return;
          }
          this.emitTalkEvent({
            type: "transcript.done",
            final: true,
            itemId: event.item_id,
            payload: { role: "user", text: event.transcript },
          });
          if (
            this.consultAbortControllers.size > 0 &&
            shouldAutoControlRealtimeVoiceAgentText(event.transcript)
          ) {
            void steerRealtimeTalkActiveConsult({
              ctx: this.ctx,
              text: event.transcript,
              emitTalkEvent: this.emitTalkEvent,
              onControlResult: (result) => this.interruptSuppressedControlResponse(result),
              speakControlResult: (message) => this.sendControlSpeechMessage(message),
              suppressSpeechForModes: ["cancel"],
            });
          }
        }
        return;
      case "conversation.output_transcript.delta":
      case "response.output_text.delta":
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        this.emitAssistantTranscript(event, false);
        return;
      case "response.output_text.done":
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done":
        this.emitAssistantTranscript(event, true);
        break;
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done":
        // Tool argument events are provisional and can also arrive for interrupted
        // responses. Only the completed response owns executable calls.
        break;
      case "input_audio_buffer.speech_started":
        this.ctx.callbacks.onStatus?.("listening", "Speech detected");
        this.emitTalkEvent({ type: "turn.started", payload: { source: event.type } });
        return;
      case "input_audio_buffer.speech_stopped":
        this.ctx.callbacks.onStatus?.("thinking", "Processing speech");
        this.emitTalkEvent({ type: "input.audio.committed", final: true });
        return;
      case "response.created":
        this.responseActive = true;
        this.responseCreateInFlight = false;
        this.responseOutcomes.start(event.response?.id);
        this.ctx.callbacks.onStatus?.("thinking", "Generating response");
        return;
      case "response.cancelled":
      case "response.done": {
        const terminal = this.responseOutcomes.finish(event);
        if (!terminal) {
          return;
        }
        const { outcome } = terminal;
        try {
          if (outcome.status === "completed") {
            this.handleCompletedResponse(event);
            if (this.closed) {
              return;
            }
          }
          if (outcome.status === "failed" || outcome.status === "incomplete") {
            this.ctx.callbacks.onStatus?.("error", outcome.message);
            this.emitTalkEvent({
              type: "session.error",
              final: true,
              payload: outcome,
            });
          } else {
            this.ctx.callbacks.onStatus?.(
              "listening",
              outcome.status === "cancelled" ? "Response cancelled" : undefined,
            );
          }
          this.emitTalkEvent({
            type: outcome.status === "cancelled" ? "turn.cancelled" : "turn.ended",
            final: true,
            payload: outcome,
          });
        } finally {
          if (terminal.overflow) {
            this.failConnection("Realtime response session limit exceeded");
          }
          this.responseActive = false;
          this.responseCreateInFlight = false;
          this.flushPendingResponseCreate();
        }
        return;
      }
      case "error":
        this.responseCreateInFlight = false;
        this.ctx.callbacks.onStatus?.("error", this.extractErrorDetail(event.error));
        this.emitTalkEvent({
          type: "session.error",
          final: true,
          payload: { message: this.extractErrorDetail(event.error) },
        });

      default:
    }
  }

  private emitAssistantTranscript(event: RealtimeServerEvent, final: boolean): void {
    const text = final ? (event.transcript ?? event.text) : event.delta;
    if (!text) {
      return;
    }
    this.ctx.callbacks.onTranscript?.({
      role: "assistant",
      text,
      final,
    });
    if (this.closed) {
      return;
    }
    this.emitTalkEvent({
      type: final ? "output.text.done" : "output.text.delta",
      final,
      itemId: event.item_id,
      payload: { text },
    });
  }

  private emitFramelessTranscript(
    role: "user" | "assistant",
    text: string | undefined,
    final: boolean,
    itemId?: string,
  ): void {
    if (!text) {
      return;
    }
    this.ctx.callbacks.onTranscript?.({ role, text, final });
    if (this.closed) {
      return;
    }
    const type =
      role === "user"
        ? final
          ? "transcript.done"
          : "transcript.delta"
        : final
          ? "output.text.done"
          : "output.text.delta";
    this.emitTalkEvent({
      type,
      final,
      itemId,
      payload: { role, text },
    });
  }

  private extractErrorDetail(error: unknown): string {
    if (!error || typeof error !== "object") {
      return "Realtime provider error";
    }
    const record = error as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message.trim() : "";
    const code = typeof record.code === "string" ? record.code.trim() : "";
    const type = typeof record.type === "string" ? record.type.trim() : "";
    return message || code || type || "Realtime provider error";
  }

  private handleCompletedResponse(event: RealtimeServerEvent): void {
    const response: unknown = event.response;
    if (!isRecord(response) || response.status !== "completed" || !Array.isArray(response.output)) {
      return;
    }
    for (const output of response.output) {
      if (
        !isRecord(output) ||
        output.type !== "function_call" ||
        (output.status !== undefined && output.status !== "completed")
      ) {
        continue;
      }
      const itemId = typeof output.id === "string" ? output.id.trim() || undefined : undefined;
      const callId = typeof output.call_id === "string" ? output.call_id.trim() : "";
      const name = typeof output.name === "string" ? output.name.trim() : "";
      const args = typeof output.arguments === "string" ? output.arguments : "";
      if (!callId || !name || !args.trim()) {
        continue;
      }
      if (
        name !== REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME &&
        name !== REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME &&
        name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME
      ) {
        continue;
      }
      if (this.completedToolCallIds.has(callId)) {
        continue;
      }
      if (this.completedToolCallIds.size >= MAX_COMPLETED_TOOL_CALL_IDS) {
        this.failConnection("Realtime tool-call session limit exceeded");
        return;
      }
      this.completedToolCallIds.add(callId);
      if (utf8Encoder.encode(args).byteLength > MAX_REALTIME_TOOL_ARGUMENT_BYTES) {
        const message = "Realtime tool arguments exceed the 256000-byte UTF-8 limit";
        this.submitToolResult(callId, { error: message });
        this.emitTalkEvent({
          type: "tool.error",
          callId,
          itemId,
          final: true,
          payload: { name, message },
        });
        continue;
      }
      void this.handleToolCall({ itemId, callId, name, args }).catch((error: unknown) => {
        this.reportToolResultSubmissionError(error);
      });
    }
  }

  private async handleToolCall(call: CompletedToolCall): Promise<void> {
    const { itemId, callId, name, args } = call;
    if (name === REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME) {
      await submitRealtimeTalkAgentControl({
        ctx: this.ctx,
        callId,
        args,
        emitTalkEvent: this.emitTalkEvent,
        submit: (toolCallId, result) => this.submitToolResult(toolCallId, result),
      });
      return;
    }
    if (name === REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME) {
      await this.handleDescribeViewToolCall(callId, itemId);
      return;
    }
    if (name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      return;
    }
    this.emitTalkEvent({
      type: "tool.call",
      callId,
      itemId,
      payload: { name, args },
    });
    const abortController = new AbortController();
    this.consultAbortControllers.add(abortController);
    try {
      await submitRealtimeTalkConsult({
        ctx: this.ctx,
        callId,
        args,
        signal: abortController.signal,
        emitTalkEvent: this.emitTalkEvent,
        submit: (toolCallId, result) => this.submitToolResult(toolCallId, result),
      });
    } finally {
      this.consultAbortControllers.delete(abortController);
    }
  }

  private async handleDescribeViewToolCall(callId: string, itemId?: string): Promise<void> {
    this.emitTalkEvent({
      type: "tool.call",
      callId,
      itemId,
      payload: { name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME },
    });
    if (!this.camera.hasLiveTrack()) {
      this.submitToolResult(callId, { ok: false, error: "camera is off" });
      this.emitTalkEvent({
        type: "tool.error",
        callId,
        itemId,
        final: true,
        payload: { name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME, message: "camera is off" },
      });
      return;
    }
    try {
      const frame = await captureRealtimeTalkVideoFrame(
        this.camera.video,
        realtimeTalkDataChannelMaxMessageSize(this.peer),
        realtimeTalkImageEvent,
      );
      this.send(realtimeTalkImageEvent(frame));
      this.submitToolResult(callId, { ok: true, frameAttached: true });
      this.emitTalkEvent({
        type: "tool.result",
        callId,
        itemId,
        final: true,
        payload: { name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME, frameAttached: true },
      });
    } catch (error) {
      const message = formatUiError(error);
      this.submitToolResult(callId, { ok: false, error: message });
      this.emitTalkEvent({
        type: "tool.error",
        callId,
        itemId,
        final: true,
        payload: { name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME, message },
      });
    }
  }

  private submitToolResult(callId: string, result: unknown): void {
    if (this.closed) {
      return;
    }
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    this.requestResponseCreate();
  }

  private reportToolResultSubmissionError(error: unknown): void {
    if (this.closed) {
      return;
    }
    const message = formatUiError(error);
    this.ctx.callbacks.onStatus?.("error", message);
  }

  private sendControlSpeechMessage(message: string): void {
    if (this.responseActive) {
      this.send({ type: "response.cancel" });
    }
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: message }],
      },
    });
    this.requestResponseCreate();
  }

  private interruptSuppressedControlResponse(result: unknown): void {
    if (!this.responseActive || !result || typeof result !== "object") {
      return;
    }
    const record = result as Record<string, unknown>;
    if (
      record.ok === true &&
      (record.mode === "cancel" || (record.suppress === true && record.mode !== "steer"))
    ) {
      this.send({ type: "response.cancel" });
    }
  }

  private requestResponseCreate(): void {
    if (this.responseActive || this.responseCreateInFlight) {
      this.responseCreatePending = true;
      return;
    }
    this.responseCreatePending = false;
    this.responseCreateInFlight = true;
    this.send({ type: "response.create" });
  }

  private flushPendingResponseCreate(): void {
    if (!this.responseCreatePending) {
      return;
    }
    this.responseCreatePending = false;
    this.requestResponseCreate();
  }
}

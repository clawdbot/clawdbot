// Control UI chat module implements realtime talk webrtc behavior.
import { RealtimeTalkMediaStreamMeter } from "./realtime-talk-audio.ts";
import { openRealtimeTalkInput } from "./realtime-talk-input.ts";
import type { RealtimeTalkWebRtcSdpSessionResult } from "./realtime-talk-shared.ts";
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

type RealtimeServerEvent = {
  type?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  delta?: string;
  transcript?: string;
  text?: string;
  arguments?: string;
  error?: unknown;
  response?: {
    status?: string;
    status_details?: unknown;
  };
};

type ToolBuffer = {
  name: string;
  callId: string;
  args: string;
};

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
  private toolBuffers = new Map<string, ToolBuffer>();
  private readonly consultAbortControllers = new Set<AbortController>();
  private readonly emitTalkEvent: ReturnType<typeof createRealtimeTalkEventEmitter>;

  constructor(
    private readonly session: RealtimeTalkWebRtcSdpSessionResult,
    private readonly ctx: RealtimeTalkTransportContext,
  ) {
    this.emitTalkEvent = createRealtimeTalkEventEmitter(ctx, session);
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      throw new Error("Realtime Talk requires browser WebRTC and microphone access");
    }
    this.closed = false;
    const peer = new RTCPeerConnection();
    this.peer = peer;
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.style.display = "none";
    document.body.append(this.audio);
    peer.addEventListener("track", (event) => {
      if (this.audio) {
        this.audio.srcObject = event.streams[0];
      }
    });
    const media = await this.awaitSetupStep(peer, openRealtimeTalkInput(this.ctx.inputDeviceId));
    if (media === cancelledSetup) {
      return;
    }
    if (!this.isCurrentPeer(peer)) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    this.media = media;
    if (this.ctx.callbacks.onInputLevel) {
      this.inputMeter = new RealtimeTalkMediaStreamMeter(this.ctx.callbacks.onInputLevel);
      this.inputMeter.start(media);
    }
    for (const track of media.getAudioTracks()) {
      peer.addTrack(track, media);
    }
    const channel = peer.createDataChannel("oai-events");
    if (!this.isCurrentPeer(peer)) {
      channel.close();
      return;
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
        this.ctx.callbacks.onStatus?.("error", "Realtime connection closed");
      }
    });

    const offer = await this.awaitSetupStep(peer, peer.createOffer());
    if (offer === cancelledSetup) {
      return;
    }
    if (!this.isCurrentPeer(peer)) {
      return;
    }
    const localDescriptionResult = await this.awaitSetupStep(peer, peer.setLocalDescription(offer));
    if (localDescriptionResult === cancelledSetup) {
      return;
    }
    if (!this.isCurrentPeer(peer)) {
      return;
    }
    const sdp = await this.awaitSetupStep(
      peer,
      fetch(this.session.offerUrl ?? "https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: {
          ...this.session.offerHeaders,
          Authorization: `Bearer ${this.session.clientSecret}`,
          "Content-Type": "application/sdp",
        },
      }),
    );
    if (sdp === cancelledSetup) {
      return;
    }
    if (!this.isCurrentPeer(peer)) {
      return;
    }
    if (!sdp.ok) {
      throw new Error(`Realtime WebRTC setup failed (${sdp.status})`);
    }
    const answerSdp = await this.awaitSetupStep(peer, sdp.text());
    if (answerSdp === cancelledSetup) {
      return;
    }
    if (!this.isCurrentPeer(peer)) {
      return;
    }
    await this.awaitSetupStep(
      peer,
      peer.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      }),
    );
  }

  private isCurrentPeer(peer: RTCPeerConnection): boolean {
    return !this.closed && this.peer === peer;
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

  stop(): void {
    if (!this.closed) {
      this.emitTalkEvent({ type: "session.closed", final: true });
    }
    this.closed = true;
    this.channel?.close();
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    this.media?.getTracks().forEach((track) => track.stop());
    this.media = null;
    this.inputMeter?.stop();
    this.inputMeter = null;
    this.audio?.remove();
    this.audio = null;
    for (const controller of this.consultAbortControllers) {
      controller.abort();
    }
    this.consultAbortControllers.clear();
    this.toolBuffers.clear();
    this.responseActive = false;
    this.responseCreateInFlight = false;
    this.responseCreatePending = false;
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
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.ctx.callbacks.onTranscript?.({ role: "user", text: event.transcript, final: true });
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
        return;
      case "response.function_call_arguments.delta":
        this.bufferToolDelta(event);
        return;
      case "response.function_call_arguments.done":
        void this.handleToolCall(event);
        return;
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
        this.ctx.callbacks.onStatus?.("thinking", "Generating response");
        return;
      case "response.cancelled":
      case "response.done":
        this.responseActive = false;
        this.responseCreateInFlight = false;
        this.ctx.callbacks.onStatus?.("listening", this.extractResponseStatus(event));
        this.emitTalkEvent({
          type: "turn.ended",
          final: true,
          payload: {
            status:
              event.response?.status ??
              (event.type === "response.cancelled" ? "cancelled" : "completed"),
          },
        });
        this.flushPendingResponseCreate();
        return;
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

  private extractResponseStatus(event: RealtimeServerEvent): string | undefined {
    const status = event.response?.status;
    return status && status !== "completed" ? `Response ${status}` : undefined;
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
    this.emitTalkEvent({
      type: final ? "output.text.done" : "output.text.delta",
      final,
      itemId: event.item_id,
      payload: { text },
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

  private bufferToolDelta(event: RealtimeServerEvent): void {
    const key = event.item_id ?? "unknown";
    const existing = this.toolBuffers.get(key);
    if (existing) {
      existing.args += event.delta ?? "";
      return;
    }
    this.toolBuffers.set(key, {
      name: event.name ?? "",
      callId: event.call_id ?? "",
      args: event.delta ?? "",
    });
  }

  private async handleToolCall(event: RealtimeServerEvent): Promise<void> {
    const key = event.item_id ?? "unknown";
    const buffered = this.toolBuffers.get(key);
    this.toolBuffers.delete(key);
    const name = buffered?.name || event.name || "";
    const callId = buffered?.callId || event.call_id || "";
    if (!callId) {
      return;
    }
    if (name === REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME) {
      await submitRealtimeTalkAgentControl({
        ctx: this.ctx,
        callId,
        args: buffered?.args || event.arguments || "{}",
        emitTalkEvent: this.emitTalkEvent,
        submit: (toolCallId, result) => this.submitToolResult(toolCallId, result),
      });
      return;
    }
    if (name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      return;
    }
    this.emitTalkEvent({
      type: "tool.call",
      callId,
      itemId: key,
      payload: { name, args: buffered?.args || event.arguments || "{}" },
    });
    const abortController = new AbortController();
    this.consultAbortControllers.add(abortController);
    try {
      await submitRealtimeTalkConsult({
        ctx: this.ctx,
        callId,
        args: buffered?.args || event.arguments || "{}",
        signal: abortController.signal,
        emitTalkEvent: this.emitTalkEvent,
        submit: (toolCallId, result) => this.submitToolResult(toolCallId, result),
      });
    } finally {
      this.consultAbortControllers.delete(abortController);
    }
  }

  private submitToolResult(callId: string, result: unknown): void {
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

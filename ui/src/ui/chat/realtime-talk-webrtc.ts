import type { RealtimeTalkWebRtcSdpSessionResult } from "./realtime-talk-shared.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  createRealtimeTalkEventEmitter,
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

export class WebRtcSdpRealtimeTalkTransport implements RealtimeTalkTransport {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private media: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private closed = false;
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
    this.peer = new RTCPeerConnection();
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.style.display = "none";
    document.body.append(this.audio);
    this.peer.addEventListener("track", (event) => {
      if (this.audio) {
        this.audio.srcObject = event.streams[0];
      }
    });
    this.media = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of this.media.getAudioTracks()) {
      this.peer.addTrack(track, this.media);
    }
    this.channel = this.peer.createDataChannel("oai-events");
    this.channel.addEventListener("open", () => {
      this.ctx.callbacks.onStatus?.("listening");
      this.emitTalkEvent({ type: "session.ready" });
    });
    this.channel.addEventListener("message", (event) => this.handleRealtimeEvent(event.data));
    this.peer.addEventListener("connectionstatechange", () => {
      if (this.closed) {
        return;
      }
      if (this.peer?.connectionState === "failed" || this.peer?.connectionState === "closed") {
        this.ctx.callbacks.onStatus?.("error", "Realtime connection closed");
      }
    });

    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    const sdp = await fetch(this.session.offerUrl ?? "https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: {
        ...this.session.offerHeaders,
        Authorization: `Bearer ${this.session.clientSecret}`,
        "Content-Type": "application/sdp",
      },
    });
    if (!sdp.ok) {
      throw new Error(`Realtime WebRTC setup failed (${sdp.status})`);
    }
    await this.peer.setRemoteDescription({
      type: "answer",
      sdp: await sdp.text(),
    });
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
    this.audio?.remove();
    this.audio = null;
    for (const controller of this.consultAbortControllers) {
      controller.abort();
    }
    this.consultAbortControllers.clear();
    this.toolBuffers.clear();
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
        }
        return;
      case "response.audio_transcript.done":
        if (event.transcript) {
          this.ctx.callbacks.onTranscript?.({
            role: "assistant",
            text: event.transcript,
            final: true,
          });
          this.emitTalkEvent({
            type: "output.text.done",
            final: true,
            itemId: event.item_id,
            payload: { text: event.transcript },
          });
        }
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
        this.ctx.callbacks.onStatus?.("thinking", "Generating response");
        return;
      case "response.done":
        this.ctx.callbacks.onStatus?.("listening", this.extractResponseStatus(event));
        this.emitTalkEvent({
          type: "turn.ended",
          final: true,
          payload: { status: event.response?.status ?? "completed" },
        });
        return;
      case "error":
        this.ctx.callbacks.onStatus?.("error", this.extractErrorDetail(event.error));
        this.emitTalkEvent({
          type: "session.error",
          final: true,
          payload: { message: this.extractErrorDetail(event.error) },
        });
        return;
      default:
        return;
    }
  }

  private extractResponseStatus(event: RealtimeServerEvent): string | undefined {
    const status = event.response?.status;
    return status && status !== "completed" ? `Response ${status}` : undefined;
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
    if (name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME || !callId) {
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
    this.send({ type: "response.create" });
  }
}

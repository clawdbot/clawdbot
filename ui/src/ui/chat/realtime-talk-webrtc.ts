import type { RealtimeTalkWebRtcSdpSessionResult } from "./realtime-talk-shared.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
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

  constructor(
    private readonly session: RealtimeTalkWebRtcSdpSessionResult,
    private readonly ctx: RealtimeTalkTransportContext,
  ) {}

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
    this.channel.addEventListener("open", () => this.ctx.callbacks.onStatus?.("listening"));
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
    this.closed = true;
    this.channel?.close();
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    this.media?.getTracks().forEach((track) => track.stop());
    this.media = null;
    this.audio?.remove();
    this.audio = null;
    this.toolBuffers.clear();
  }

  private send(event: unknown): void {
    if (this.channel?.readyState === "open") {
      this.channel.send(JSON.stringify(event));
    }
  }

  private handleRealtimeEvent(data: unknown): void {
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
        }
        return;
      case "response.audio_transcript.done":
        if (event.transcript) {
          this.ctx.callbacks.onTranscript?.({
            role: "assistant",
            text: event.transcript,
            final: true,
          });
        }
        return;
      case "response.function_call_arguments.delta":
        this.bufferToolDelta(event);
        return;
      case "response.function_call_arguments.done":
        void this.handleToolCall(event);
        return;
      default:
        return;
    }
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
    await submitRealtimeTalkConsult({
      ctx: this.ctx,
      callId,
      args: buffered?.args || event.arguments || "{}",
      submit: (toolCallId, result) => this.submitToolResult(toolCallId, result),
    });
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

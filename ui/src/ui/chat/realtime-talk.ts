import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../../../src/realtime-voice/agent-consult-tool.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway.ts";
import { generateUUID } from "../uuid.ts";

export type RealtimeTalkStatus = "idle" | "connecting" | "listening" | "thinking" | "error";

export type RealtimeTalkCallbacks = {
  onStatus?: (status: RealtimeTalkStatus, detail?: string) => void;
  onTranscript?: (entry: { role: "user" | "assistant"; text: string; final: boolean }) => void;
};

export type RealtimeTalkSessionResult = {
  provider: string;
  clientSecret: string;
  model?: string;
  voice?: string;
  expiresAt?: number;
};

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

type ChatPayload = {
  runId?: string;
  state?: string;
  errorMessage?: string;
  message?: unknown;
};

function extractTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const parts = content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const entry = block as Record<string, unknown>;
      return entry.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .filter(Boolean);
  return parts.join("\n\n").trim();
}

function waitForChatResult(params: {
  client: GatewayBrowserClient;
  runId: string;
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      unsubscribe();
      reject(new Error("OpenClaw tool call timed out"));
    }, params.timeoutMs);
    const unsubscribe = params.client.addEventListener((evt: GatewayEventFrame) => {
      if (evt.event !== "chat") {
        return;
      }
      const payload = evt.payload as ChatPayload | undefined;
      if (!payload || payload.runId !== params.runId) {
        return;
      }
      if (payload.state === "final") {
        window.clearTimeout(timer);
        unsubscribe();
        resolve(extractTextFromMessage(payload.message) || "OpenClaw finished with no text.");
      } else if (payload.state === "error") {
        window.clearTimeout(timer);
        unsubscribe();
        reject(new Error(payload.errorMessage ?? "OpenClaw tool call failed"));
      }
    });
  });
}

export class RealtimeTalkSession {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private media: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private closed = false;
  private toolBuffers = new Map<string, ToolBuffer>();

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly sessionKey: string,
    private readonly callbacks: RealtimeTalkCallbacks = {},
  ) {}

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      throw new Error("Realtime Talk requires browser WebRTC and microphone access");
    }
    this.closed = false;
    this.callbacks.onStatus?.("connecting");
    const session = await this.client.request<RealtimeTalkSessionResult>("talk.realtime.session", {
      sessionKey: this.sessionKey,
    });
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
    this.channel.addEventListener("open", () => this.callbacks.onStatus?.("listening"));
    this.channel.addEventListener("message", (event) => this.handleRealtimeEvent(event.data));
    this.peer.addEventListener("connectionstatechange", () => {
      if (this.closed) {
        return;
      }
      if (this.peer?.connectionState === "failed" || this.peer?.connectionState === "closed") {
        this.callbacks.onStatus?.("error", "Realtime connection closed");
      }
    });

    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    const sdp = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${session.clientSecret}`,
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
    this.callbacks.onStatus?.("idle");
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
          this.callbacks.onTranscript?.({ role: "user", text: event.transcript, final: true });
        }
        return;
      case "response.audio_transcript.done":
        if (event.transcript) {
          this.callbacks.onTranscript?.({
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
    this.callbacks.onStatus?.("thinking");
    let question = "";
    try {
      const args = JSON.parse(buffered?.args || event.arguments || "{}") as {
        question?: unknown;
        context?: unknown;
        responseStyle?: unknown;
      };
      question = typeof args.question === "string" ? args.question.trim() : "";
      const context = typeof args.context === "string" ? args.context.trim() : "";
      const responseStyle = typeof args.responseStyle === "string" ? args.responseStyle.trim() : "";
      if (context || responseStyle) {
        question = [
          question,
          context ? `Context:\n${context}` : undefined,
          responseStyle ? `Spoken style:\n${responseStyle}` : undefined,
        ]
          .filter(Boolean)
          .join("\n\n");
      }
    } catch {}
    if (!question) {
      this.submitToolResult(callId, {
        error: `${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} requires a question`,
      });
      this.callbacks.onStatus?.("listening");
      return;
    }
    try {
      const idempotencyKey = generateUUID();
      const response = await this.client.request<{ runId?: string }>("chat.send", {
        sessionKey: this.sessionKey,
        message: question,
        idempotencyKey,
      });
      const result = await waitForChatResult({
        client: this.client,
        runId: response.runId ?? idempotencyKey,
        timeoutMs: 120_000,
      });
      this.submitToolResult(callId, { result });
    } catch (error) {
      this.submitToolResult(callId, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.callbacks.onStatus?.("listening");
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

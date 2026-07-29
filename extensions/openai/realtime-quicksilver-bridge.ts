// GPT-Live backend bridge over the Frameless Bidi WebSocket protocol used by Codex realtime v3.
import { randomUUID } from "node:crypto";
import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";
import {
  captureWsEvent,
  createDebugProxyWebSocketAgent,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import {
  convertPcmToMulaw8k,
  mulawToPcm,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resamplePcm,
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeCreateRequest,
  type RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import WebSocket, { type RawData } from "ws";
import {
  connectOpenAIQuicksilverSideband,
  type OpenAIQuicksilverSocket,
  type OpenAIQuicksilverSocketFactory,
} from "./realtime-quicksilver-sideband.js";
import {
  buildOpenAIQuicksilverSessionUpdate,
  buildOpenAIQuicksilverWebSocketUrl,
  chunkOpenAIQuicksilverAppendText,
  parseOpenAIQuicksilverEvent,
  type OpenAIQuicksilverAuth,
  type OpenAIQuicksilverInboundEvent,
  type OpenAIQuicksilverRequestIds,
} from "./realtime-quicksilver-wire.js";

const OPENAI_QUICKSILVER_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const OPENAI_QUICKSILVER_READY_TIMEOUT_MS = 15_000;
const OPENAI_QUICKSILVER_PENDING_AUDIO_CHUNKS = 320;
const OPENAI_QUICKSILVER_SAMPLE_RATE = 24_000;
const WEBSOCKET_OPEN = 1;

type OpenAIQuicksilverVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  model: string;
  voice?: string;
  resolveAuth: () => Promise<OpenAIQuicksilverAuth>;
  webSocketFactory?: OpenAIQuicksilverSocketFactory;
};

function decodeTextFrame(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    for (const key of ["text", "result", "output", "error"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  }
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

export class OpenAIQuicksilverVoiceBridge implements RealtimeVoiceBridge {
  readonly supportsToolResultContinuation = true;
  readonly supportsToolResultSuppression = true;
  readonly handlesInputAudioBargeIn = false;

  private socket: OpenAIQuicksilverSocket | undefined;
  private stopController = new AbortController();
  private ready = false;
  private intentionallyClosed = false;
  private closeNotified = false;
  private pendingAudio: Buffer[] = [];
  private activeDelegations = new Set<string>();
  private readonly flowId = randomUUID();
  private readonly requestIds: OpenAIQuicksilverRequestIds = {
    realtimeSessionId: randomUUID(),
    sessionId: randomUUID(),
    threadId: randomUUID(),
  };

  constructor(private readonly config: OpenAIQuicksilverVoiceBridgeConfig) {}

  async connect(): Promise<void> {
    if (this.ready) {
      return;
    }
    this.intentionallyClosed = false;
    this.closeNotified = false;
    if (this.stopController.signal.aborted) {
      this.stopController = new AbortController();
    }
    const auth = await this.config.resolveAuth();
    const url = buildOpenAIQuicksilverWebSocketUrl(this.config.model);
    const createSocket = this.config.webSocketFactory ?? this.createSocketFactory();
    const connected = await connectOpenAIQuicksilverSideband({
      auth,
      createSocket,
      requestIds: this.requestIds,
      signal: this.stopController.signal,
      url,
    });
    this.socket = connected.socket;
    captureWsEvent({
      url,
      direction: "local",
      kind: "ws-open",
      flowId: this.flowId,
      meta: { provider: "openai", capability: "gpt-live-voice" },
    });

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const readyTimeout = setTimeout(() => {
      rejectReady(new Error("GPT-Live WebSocket did not emit session.started"));
      this.closeSocket("session-start timeout");
    }, OPENAI_QUICKSILVER_READY_TIMEOUT_MS);
    readyTimeout.unref?.();
    const settleReady = () => {
      clearTimeout(readyTimeout);
      resolveReady();
    };
    const failReady = (error: Error) => {
      clearTimeout(readyTimeout);
      rejectReady(error);
    };

    connected.socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        const error = new Error("GPT-Live WebSocket returned an unexpected binary frame");
        if (!this.ready) {
          failReady(error);
        }
        this.fail(error);
        return;
      }
      const payload = decodeTextFrame(data);
      captureWsEvent({
        url,
        direction: "inbound",
        kind: "ws-frame",
        flowId: this.flowId,
        payload,
        meta: { provider: "openai", capability: "gpt-live-voice" },
      });
      const event = parseOpenAIQuicksilverEvent(payload);
      if (event) {
        this.handleEvent(event, settleReady, failReady);
      }
    });
    connected.socket.on("error", (error: Error) => {
      if (!this.ready) {
        failReady(error);
      }
      this.fail(error);
    });
    connected.socket.on("close", () => {
      const wasReady = this.ready;
      this.ready = false;
      this.socket = undefined;
      if (!wasReady) {
        failReady(new Error("GPT-Live WebSocket closed before session.started"));
      }
      this.notifyClose(this.intentionallyClosed ? "completed" : "error");
    });

    const terminalEvent = connected.detachBuffer();
    this.sendEvent(
      buildOpenAIQuicksilverSessionUpdate({
        instructions: this.config.instructions,
        voice: this.config.voice,
      }),
    );
    for (const frame of connected.bufferedFrames) {
      if (!frame.isBinary) {
        const event = parseOpenAIQuicksilverEvent(decodeTextFrame(frame.data));
        if (event) {
          this.handleEvent(event, settleReady, failReady);
        }
      }
    }
    if (terminalEvent) {
      const error =
        terminalEvent.kind === "error"
          ? terminalEvent.error
          : new Error("GPT-Live WebSocket closed during startup");
      failReady(error);
      this.fail(error);
    }
    await readyPromise;
  }

  sendAudio(audio: Buffer): void {
    if (!this.ready || this.socket?.readyState !== WEBSOCKET_OPEN) {
      if (this.pendingAudio.length < OPENAI_QUICKSILVER_PENDING_AUDIO_CHUNKS) {
        this.pendingAudio.push(audio);
      }
      return;
    }
    this.sendAudioNow(audio);
  }

  setMediaTimestamp(_ts: number): void {}

  sendUserMessage(text: string): void {
    this.sendContext("session.context.append", undefined, text);
  }

  triggerGreeting(instructions?: string): void {
    this.sendContext(
      "session.context.append",
      undefined,
      instructions ?? "Greet the user briefly.",
      "speakable",
    );
  }

  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    const channel = options?.suppressResponse || options?.willContinue ? "commentary" : "speakable";
    const type = this.activeDelegations.has(callId)
      ? "delegation.context.append"
      : "session.context.append";
    this.sendContext(
      type,
      type === "delegation.context.append" ? callId : undefined,
      toolResultText(result),
      channel,
    );
    if (!options?.willContinue) {
      this.activeDelegations.delete(callId);
    }
  }

  acknowledgeMark(_markName?: string): void {}

  close(): void {
    this.intentionallyClosed = true;
    this.stopController.abort(new Error("GPT-Live bridge closed"));
    if (this.socket?.readyState === WEBSOCKET_OPEN) {
      this.sendEvent({ type: "session.close" });
    }
    this.closeSocket("bridge closed");
    this.ready = false;
  }

  isConnected(): boolean {
    return this.ready && this.socket?.readyState === WEBSOCKET_OPEN;
  }

  handleBargeIn(): void {
    // Frameless Bidi owns interruption from incoming audio and exposes no client cancel event.
    this.config.onClearAudio("barge-in");
  }

  private createSocketFactory(): OpenAIQuicksilverSocketFactory {
    return (url, options) => {
      const proxyAgent = createDebugProxyWebSocketAgent(resolveDebugProxySettings());
      return new WebSocket(url, {
        ...options,
        maxPayload: OPENAI_QUICKSILVER_MAX_PAYLOAD_BYTES,
        ...(proxyAgent ? { agent: proxyAgent } : {}),
      });
    };
  }

  private handleEvent(
    event: OpenAIQuicksilverInboundEvent,
    settleReady: () => void,
    failReady: (error: Error) => void,
  ): void {
    if (event.kind === "ignored" || event.kind === "unknown") {
      return;
    }
    if (event.kind === "session-started") {
      if (!this.ready) {
        this.ready = true;
        for (const audio of this.pendingAudio.splice(0)) {
          this.sendAudioNow(audio);
        }
        this.config.onReady?.();
      }
      this.config.onEvent?.({ direction: "server", type: "session.started" });
      settleReady();
      return;
    }
    if (event.kind === "audio") {
      const canonical = canonicalizeBase64(event.data);
      if (!canonical) {
        this.fail(new Error("GPT-Live WebSocket returned malformed base64 audio"));
        return;
      }
      const pcm = Buffer.from(canonical, "base64");
      this.config.onAudio(
        this.config.audioFormat?.encoding === "g711_ulaw"
          ? convertPcmToMulaw8k(pcm, OPENAI_QUICKSILVER_SAMPLE_RATE)
          : pcm,
      );
      this.config.onEvent?.({ direction: "server", type: "output_audio.delta" });
      return;
    }
    if (event.kind === "transcript-delta" || event.kind === "transcript-done") {
      this.config.onTranscript?.(event.role, event.text, event.kind === "transcript-done");
      this.config.onEvent?.({
        direction: "server",
        type:
          event.kind === "transcript-done"
            ? event.role === "assistant"
              ? "response.done"
              : "turn.done"
            : `${event.role === "user" ? "input" : "output"}_transcript.added`,
      });
      return;
    }
    if (event.kind === "delegation") {
      this.activeDelegations.add(event.id);
      this.config.onEvent?.({
        direction: "server",
        type: "delegation.created",
        itemId: event.id,
      });
      this.config.onToolCall?.({
        itemId: event.id,
        callId: event.id,
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: event.prompt },
      });
      return;
    }
    const error = new Error(event.message);
    if (!this.ready) {
      failReady(error);
      this.closeSocket("session start failed");
    }
    this.config.onEvent?.({ direction: "server", type: "error", detail: event.message });
    this.config.onError?.(error);
    if (event.fatalAuth) {
      this.closeSocket("authentication failed");
    }
  }

  private sendAudioNow(audio: Buffer): void {
    const pcm =
      this.config.audioFormat?.encoding === "g711_ulaw"
        ? resamplePcm(mulawToPcm(audio), 8_000, OPENAI_QUICKSILVER_SAMPLE_RATE)
        : audio;
    this.sendEvent({ type: "input_audio.append", audio: pcm.toString("base64") });
  }

  private sendContext(
    type: "delegation.context.append" | "session.context.append",
    delegationItemId: string | undefined,
    text: string,
    channel?: "speakable" | "commentary",
  ): void {
    for (const chunk of chunkOpenAIQuicksilverAppendText(text)) {
      this.sendEvent({
        type,
        ...(delegationItemId ? { delegation_item_id: delegationItemId } : {}),
        ...(channel ? { channel } : {}),
        content: [{ type: "input_text", text: chunk }],
      });
    }
  }

  private sendEvent(event: object): void {
    if (!this.socket || this.socket.readyState !== WEBSOCKET_OPEN) {
      return;
    }
    const payload = JSON.stringify(event);
    captureWsEvent({
      url: buildOpenAIQuicksilverWebSocketUrl(this.config.model),
      direction: "outbound",
      kind: "ws-frame",
      flowId: this.flowId,
      payload,
      meta: { provider: "openai", capability: "gpt-live-voice" },
    });
    this.socket.send(payload);
  }

  private fail(error: Error): void {
    this.config.onError?.(error);
    this.closeSocket("bridge error");
  }

  private closeSocket(reason: string): void {
    try {
      this.socket?.close(1000, reason);
    } catch {
      // Closing is best effort once the bridge reaches a terminal state.
    }
  }

  private notifyClose(reason: "completed" | "error"): void {
    if (this.closeNotified) {
      return;
    }
    this.closeNotified = true;
    this.config.onClose?.(reason);
  }
}

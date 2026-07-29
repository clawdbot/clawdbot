// Gateway-owned GPT-Live WebRTC bridge: werift media peer plus OpenAI sideband control.
import { randomUUID } from "node:crypto";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "openclaw/plugin-sdk/realtime-voice";
import WebSocket, { type RawData } from "ws";
import {
  buildOpenAIQuicksilverDelegationPrompt,
  type OpenAIQuicksilverTranscriptEntry,
} from "./realtime-quicksilver-instructions.js";
import type {
  OpenAIQuicksilverAudioPeerCallbacks,
  OpenAIQuicksilverAudioPeerContract,
} from "./realtime-quicksilver-peer.runtime.js";
import {
  releaseOpenAIQuicksilverSession,
  reserveOpenAIQuicksilverSession,
} from "./realtime-quicksilver-session-limit.js";
import {
  connectOpenAIQuicksilverSideband,
  type OpenAIQuicksilverSocket,
  type OpenAIQuicksilverSocketFactory,
} from "./realtime-quicksilver-sideband.js";
import {
  boundOpenAIQuicksilverContextItems,
  buildOpenAIQuicksilverSession,
  chunkOpenAIQuicksilverAppendText,
  createOpenAIQuicksilverCall,
  parseOpenAIQuicksilverEvent,
  type OpenAIQuicksilverAuth,
  type OpenAIQuicksilverInboundEvent,
  type OpenAIQuicksilverRequestIds,
} from "./realtime-quicksilver-wire.js";

const RELAY_SAMPLE_RATE = 24_000;
const QUICKSILVER_SESSION_TTL_MS = 30 * 60_000;
const QUICKSILVER_CONNECT_TIMEOUT_MS = 30_000;
const WEBSOCKET_OPEN = 1;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

type OpenAIQuicksilverBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  model: string;
  voice: string;
  logger: Pick<PluginLogger, "debug" | "warn">;
  resolveAuth: () => Promise<OpenAIQuicksilverAuth>;
  createPeer?: (
    callbacks: OpenAIQuicksilverAudioPeerCallbacks,
  ) => Promise<OpenAIQuicksilverAudioPeerContract>;
  fetchImpl?: typeof fetch;
  webSocketFactory?: OpenAIQuicksilverSocketFactory;
};

type ActiveSideband = {
  socket: OpenAIQuicksilverSocket;
  requestIds: OpenAIQuicksilverRequestIds;
};

const CONSULT_FAILURE_TEXT =
  "The agent task failed. Tell the user it did not complete and offer to try again.";

function decodeTextFrame(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

function normalizeSidebandCloseReason(reason: Buffer | string | undefined): string {
  const text = typeof reason === "string" ? reason : (reason?.toString("utf8") ?? "");
  return text.replaceAll(/\s+/g, " ").trim().slice(0, 180);
}

function describeSidebandClose(code: number, reason: string): string {
  return `OpenAI GPT-Live sideband closed (code ${code}${reason ? `: ${reason}` : ""})`;
}

function sendDelegationAppend(params: {
  socket: OpenAIQuicksilverSocket;
  delegationId: string;
  text: string;
  channel: "speakable" | "commentary";
}): void {
  for (const chunk of chunkOpenAIQuicksilverAppendText(params.text)) {
    params.socket.send(
      JSON.stringify({
        type: "delegation.context.append",
        delegation_item_id: params.delegationId,
        channel: params.channel,
        content: [{ type: "input_text", text: chunk }],
      }),
    );
  }
}

/** Realtime voice bridge used only when a Gateway relay injects the agent runner. */
export class OpenAIQuicksilverGatewayBridge implements RealtimeVoiceBridge {
  readonly supportsToolResultContinuation = false;
  readonly supportsToolResultSuppression = false;

  private abortController = new AbortController();
  private activeDelegationId: string | undefined;
  private connectPromise: Promise<void> | undefined;
  private consultController: AbortController | undefined;
  private connected = false;
  private closed = false;
  private closeNotified = false;
  private peer: OpenAIQuicksilverAudioPeerContract | undefined;
  private ready = false;
  private sideband: ActiveSideband | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private transcript: OpenAIQuicksilverTranscriptEntry[] = [];
  private partialTranscriptRole: "user" | "assistant" | undefined;

  constructor(private readonly config: OpenAIQuicksilverBridgeConfig) {}

  connect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("GPT-Live gateway relay bridge is closed"));
    }
    this.connectPromise ??= this.connectInternal();
    return this.connectPromise;
  }

  sendAudio(audio: Buffer): void {
    this.peer?.sendAudio(audio);
  }

  setMediaTimestamp(_ts: number): void {}

  sendUserMessage(text: string): void {
    const delegationId = this.activeDelegationId;
    const socket = this.sideband?.socket;
    if (!delegationId || !socket || socket.readyState !== WEBSOCKET_OPEN || !text.trim()) {
      return;
    }
    sendDelegationAppend({ socket, delegationId, text: text.trim(), channel: "speakable" });
  }

  submitToolResult(): void {
    throw new Error("GPT-Live gateway relay uses provider-owned agent delegations");
  }

  acknowledgeMark(): void {}

  close(): void {
    this.teardown("completed");
  }

  isConnected(): boolean {
    return this.connected && !this.closed;
  }

  private async connectInternal(): Promise<void> {
    if (!this.config.runAgentConsult) {
      throw new Error("OpenAI GPT-Live gateway relay requires the Gateway agent-consult runtime");
    }
    const audioFormat = this.config.audioFormat;
    if (
      audioFormat &&
      (audioFormat.encoding !== "pcm16" ||
        audioFormat.sampleRateHz !== RELAY_SAMPLE_RATE ||
        audioFormat.channels !== 1)
    ) {
      throw new Error("OpenAI GPT-Live gateway relay requires mono PCM16 audio at 24 kHz");
    }
    reserveOpenAIQuicksilverSession(this);
    const connectSignal = AbortSignal.any([
      this.abortController.signal,
      AbortSignal.timeout(QUICKSILVER_CONNECT_TIMEOUT_MS),
    ]);
    try {
      const createPeer =
        this.config.createPeer ??
        (async (callbacks: OpenAIQuicksilverAudioPeerCallbacks) => {
          const { OpenAIQuicksilverAudioPeer } =
            await import("./realtime-quicksilver-peer.runtime.js");
          return await OpenAIQuicksilverAudioPeer.create({ callbacks });
        });
      this.peer = await createPeer({
        onAudio: (audio) => this.config.onAudio(audio),
        onError: (error) => this.fail(error),
        onRtpPacket: () => this.config.onEvent?.({ direction: "server", type: "output_audio.rtp" }),
      });
      const offerSdp = await this.peer.createOffer();
      const auth = await this.config.resolveAuth();
      const requestIds = {
        realtimeSessionId: randomUUID(),
        sessionId: randomUUID(),
        threadId: randomUUID(),
      };
      const call = await createOpenAIQuicksilverCall({
        auth,
        requestIds,
        sdp: offerSdp,
        session: buildOpenAIQuicksilverSession({
          model: this.config.model,
          instructions: this.config.instructions,
          voice: this.config.voice,
        }),
        signal: connectSignal,
        fetchImpl: this.config.fetchImpl,
      });
      if (call.kind !== "gpt-live") {
        throw new Error("GPT-Live gateway relay unexpectedly used the GA realtime call shape");
      }
      await this.peer.applyAnswer(call.answerSdp);
      const createSocket =
        this.config.webSocketFactory ??
        ((url: string, options: Parameters<OpenAIQuicksilverSocketFactory>[1]) =>
          new WebSocket(url, options));
      const connected = await connectOpenAIQuicksilverSideband({
        auth,
        createSocket,
        requestIds,
        signal: connectSignal,
        url: call.sidebandUrl,
      });
      if (connectSignal.aborted) {
        connected.socket.close(1000, "session stopped");
        throw connectSignal.reason;
      }
      this.sideband = { socket: connected.socket, requestIds };
      this.attachSidebandHandlers(connected.socket);
      const terminalEvent = connected.detachBuffer();
      this.connected = true;
      this.scheduleExpiry(QUICKSILVER_SESSION_TTL_MS);
      for (const frame of connected.bufferedFrames) {
        this.handleSidebandFrame(frame.data, frame.isBinary);
      }
      if (terminalEvent?.kind === "error") {
        throw terminalEvent.error;
      }
      if (terminalEvent?.kind === "close") {
        const reason = normalizeSidebandCloseReason(terminalEvent.reason);
        throw new Error(describeSidebandClose(terminalEvent.code, reason));
      }
    } catch (error) {
      this.releaseResources();
      throw toError(error);
    }
  }

  private attachSidebandHandlers(socket: OpenAIQuicksilverSocket): void {
    socket.on("message", (data, isBinary) => this.handleSidebandFrame(data, isBinary));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", (code, rawReason) => {
      const closeCode = code ?? 1006;
      const reason = normalizeSidebandCloseReason(rawReason);
      if (!this.closed) {
        if (closeCode === 1000) {
          this.teardown("completed");
        } else {
          this.fail(new Error(describeSidebandClose(closeCode, reason)));
        }
      }
    });
  }

  private handleSidebandFrame(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.fail(new Error("OpenAI GPT-Live sideband returned an unexpected binary frame"));
      return;
    }
    const payload = decodeTextFrame(data);
    let eventType: string | undefined;
    try {
      const decoded = JSON.parse(payload) as Record<string, unknown>;
      eventType = typeof decoded.type === "string" ? decoded.type : undefined;
    } catch {
      return;
    }
    if (eventType) {
      // Audio belongs to the negotiated RTP track. Sideband audio is observable for proof,
      // but never delivered twice into the relay sink.
      this.config.onEvent?.({ direction: "server", type: eventType });
      if (eventType === "output_audio_buffer.cleared") {
        this.config.onClearAudio("barge-in");
      }
    }
    const event = parseOpenAIQuicksilverEvent(payload);
    if (event) {
      this.handleSidebandEvent(event);
    }
  }

  private handleSidebandEvent(event: OpenAIQuicksilverInboundEvent): void {
    if (event.kind === "ignored") {
      return;
    }
    if (event.kind === "unknown") {
      this.config.logger.debug?.(`OpenAI GPT-Live ignored sideband event: ${event.eventType}`);
      return;
    }
    if (event.kind === "session-started") {
      if (event.expiresAt !== undefined) {
        this.scheduleExpiry(
          Math.min(QUICKSILVER_SESSION_TTL_MS, Math.max(0, event.expiresAt * 1000 - Date.now())),
        );
      }
      if (!this.ready) {
        this.ready = true;
        this.config.onReady?.();
      }
      return;
    }
    if (event.kind === "transcript-delta" || event.kind === "transcript-done") {
      this.appendTranscript(event);
      this.config.onTranscript?.(event.role, event.text, event.kind === "transcript-done");
      return;
    }
    if (event.kind === "error") {
      const error = new Error(`OpenAI GPT-Live sideband error: ${event.message}`);
      if (event.fatalAuth) {
        this.fail(error);
      } else {
        this.config.logger.warn(error.message);
      }
      return;
    }
    this.startDelegation(event.id, event.prompt);
  }

  private appendTranscript(
    event: Extract<OpenAIQuicksilverInboundEvent, { kind: "transcript-delta" | "transcript-done" }>,
  ): void {
    const last = this.transcript.at(-1);
    if (event.kind === "transcript-delta") {
      if (last?.role === event.role && this.partialTranscriptRole === event.role) {
        last.text += event.text;
      } else {
        this.transcript.push({ role: event.role, text: event.text });
      }
      this.partialTranscriptRole = event.role;
    } else {
      if (last?.role === event.role && this.partialTranscriptRole === event.role) {
        last.text = event.text;
      } else {
        this.transcript.push({ role: event.role, text: event.text });
      }
      this.partialTranscriptRole = undefined;
    }
    this.transcript = boundOpenAIQuicksilverContextItems(this.transcript);
  }

  private startDelegation(delegationId: string, input: string): void {
    const runAgentConsult = this.config.runAgentConsult as RealtimeVoiceAgentConsultRunner;
    if (!input.trim()) {
      return;
    }
    const transcript = this.transcript;
    this.transcript = [];
    this.partialTranscriptRole = undefined;
    this.consultController?.abort(new Error("GPT-Live delegation superseded"));
    const controller = new AbortController();
    this.consultController = controller;
    this.activeDelegationId = delegationId;
    const signal = AbortSignal.any([this.abortController.signal, controller.signal]);
    const prompt = buildOpenAIQuicksilverDelegationPrompt({ input, transcript });
    void this.runDelegation({ delegationId, prompt, runAgentConsult, signal }).finally(() => {
      if (this.consultController === controller) {
        this.consultController = undefined;
        this.activeDelegationId = undefined;
      }
    });
  }

  private async runDelegation(params: {
    delegationId: string;
    prompt: string;
    runAgentConsult: RealtimeVoiceAgentConsultRunner;
    signal: AbortSignal;
  }): Promise<void> {
    let text: string;
    try {
      const result = await params.runAgentConsult({ prompt: params.prompt, signal: params.signal });
      if (params.signal.aborted) {
        return;
      }
      text = result.text;
    } catch (error) {
      if (params.signal.aborted) {
        return;
      }
      this.config.logger.warn(
        `OpenAI GPT-Live delegation consult failed: ${toError(error).message}`,
      );
      text = CONSULT_FAILURE_TEXT;
    }
    const socket = this.sideband?.socket;
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) {
      return;
    }
    sendDelegationAppend({
      socket,
      delegationId: params.delegationId,
      text,
      channel: "speakable",
    });
  }

  private scheduleExpiry(ttlMs: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.teardown("completed"), Math.max(0, ttlMs));
    this.timer.unref?.();
  }

  private fail(error: Error): void {
    if (this.closed) {
      return;
    }
    this.config.onError?.(error);
    this.teardown("error");
  }

  private teardown(reason: "completed" | "error"): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.releaseResources();
    if (!this.closeNotified) {
      this.closeNotified = true;
      this.config.onClose?.(reason);
    }
  }

  private releaseResources(): void {
    releaseOpenAIQuicksilverSession(this);
    this.connected = false;
    this.abortController.abort(new Error("GPT-Live gateway relay bridge closed"));
    this.consultController?.abort(new Error("GPT-Live delegation stopped"));
    this.consultController = undefined;
    this.activeDelegationId = undefined;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const socket = this.sideband?.socket;
    this.sideband = undefined;
    if (socket?.readyState === WEBSOCKET_OPEN) {
      try {
        socket.send(JSON.stringify({ type: "session.close" }));
      } catch {
        // The sideband may close between readyState and send.
      }
    }
    try {
      socket?.close(1000, "session closed");
    } catch {
      // Socket teardown follows ownership release and is best effort.
    }
    this.peer?.close();
    this.peer = undefined;
  }
}

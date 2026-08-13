import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  RealtimeWebRtcAudioPeer,
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeCreateRequest,
  type RealtimeVoiceCloseReason,
  type RealtimeVoiceRole,
  type RealtimeWebRtcAudioPeerCallbacks,
  type RealtimeWebRtcAudioPeerContract,
} from "openclaw/plugin-sdk/realtime-voice";
import { createRealtimeVoiceAudioQueue } from "openclaw/plugin-sdk/realtime-voice-audio-queue";
import {
  asOptionalRecord,
  normalizeOptionalString,
  readStringField,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexServerNotification } from "./protocol.js";
import { withTimeout } from "./timeout.js";

const CODEX_REALTIME_STOP_TIMEOUT_MS = 5_000;
const CODEX_REALTIME_START_TIMEOUT_MS = 30_000;
const CODEX_REALTIME_WEBSOCKET_READ_FAILURE_PREFIX =
  "stream disconnected before completion: failed to read websocket message: ";
const CODEX_REALTIME_INITIAL_ITEMS_MAX_COUNT = 128;
const CODEX_REALTIME_INITIAL_ITEMS_MAX_BYTES = 8_192 * 4;

type CodexRealtimeInitialItem = {
  role: "developer" | RealtimeVoiceRole;
  text: string;
};

function readRealtimeRole(value: string | undefined): RealtimeVoiceRole | undefined {
  return value === "user" || value === "assistant" ? value : undefined;
}

type CodexRealtimeAudioPeerFactory = (
  callbacks: RealtimeWebRtcAudioPeerCallbacks,
  signal: AbortSignal,
) => Promise<RealtimeWebRtcAudioPeerContract>;

const createAudioPeer: CodexRealtimeAudioPeerFactory = (callbacks, signal) =>
  RealtimeWebRtcAudioPeer.create({
    callbacks,
    signal,
    loadDependencies: async () => {
      const [werift, libopus] = await Promise.all([import("werift"), import("libopus-wasm")]);
      return { werift, libopus };
    },
  });

class CodexAppServerRealtimeVoiceBridge implements RealtimeVoiceBridge {
  readonly handlesInputAudioBargeIn = true;
  readonly supportsToolResultContinuation = false;
  readonly supportsToolResultSuppression = false;
  readonly completion = createDeferred<RealtimeVoiceCloseReason>();
  private connected = false;
  private closing = false;
  private terminal = false;
  private startRequested = false;
  private recoveryPending = false;
  private recoveryTask?: Promise<void>;
  private stopPromise?: Promise<void>;
  private failureTask?: Promise<void>;
  private failure?: Error;
  private answerApplied?: ReturnType<typeof createDeferred<void>>;
  private answerAppliedSettled = false;
  private audioPeer?: RealtimeWebRtcAudioPeerContract;
  private transportGeneration = 0;
  private responseTerminalEmitted = false;
  private readonly pendingAudio = createRealtimeVoiceAudioQueue("reject-newest");
  private readonly transcriptHistory: CodexRealtimeInitialItem[] = [];
  private transcriptHistoryBytes = 0;

  constructor(
    private readonly client: CodexAppServerClient,
    private readonly threadId: string,
    private readonly request: RealtimeVoiceBridgeCreateRequest,
    private readonly signal: AbortSignal,
    private readonly createPeer: CodexRealtimeAudioPeerFactory = createAudioPeer,
  ) {}

  async connect(): Promise<void> {
    if (this.terminal || this.closing) {
      throw new Error("Codex realtime session is closed");
    }
    if (this.connected) {
      return;
    }
    if (this.recoveryTask) {
      return this.recoveryTask;
    }
    if (this.recoveryPending) {
      throw new Error("Codex realtime recovery is waiting for the prior transport to close");
    }
    const generation = ++this.transportGeneration;
    try {
      const peer = await this.createPeer(
        {
          onAudio: (audio) => {
            if (this.connected && this.isActiveGeneration(generation)) {
              this.request.onAudio(audio);
            }
          },
          onError: (error) => {
            if (this.isActiveGeneration(generation)) {
              void this.fail(error);
            }
          },
        },
        this.signal,
      );
      if (!this.isActiveGeneration(generation)) {
        peer.close();
        throw new Error("Codex realtime session closed during media startup");
      }
      this.audioPeer = peer;
      const sdp = await peer.createOffer();
      this.answerApplied = createDeferred<void>();
      this.answerAppliedSettled = false;
      const instructions = this.request.instructions?.trim();
      const model = normalizeOptionalString(this.request.providerConfig.model);
      const voice = normalizeOptionalString(this.request.providerConfig.voice);
      const initialItems = this.buildInitialItems(instructions);
      this.startRequested = true;
      await this.client.request(
        "thread/realtime/start",
        {
          threadId: this.threadId,
          outputModality: "audio",
          transport: { type: "webrtc", sdp },
          version: "v3",
          includeStartupContext: true,
          ...(initialItems.length > 0 ? { initialItems } : {}),
          ...(model ? { model } : {}),
          ...(voice ? { voice } : {}),
        },
        { signal: this.signal },
      );
      await withTimeout(
        this.answerApplied.promise,
        CODEX_REALTIME_START_TIMEOUT_MS,
        `Codex realtime transport startup timed out after ${CODEX_REALTIME_START_TIMEOUT_MS}ms`,
      );
      if (!this.isActiveGeneration(generation)) {
        throw new Error("Codex realtime session closed during startup");
      }
      this.connected = true;
      for (const audio of this.pendingAudio.drain()) {
        peer.sendAudio(audio);
      }
      this.request.onReady?.();
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      await this.fail(normalized).catch(() => undefined);
      throw normalized;
    }
  }

  sendAudio(audio: Buffer): void {
    if (this.terminal || this.closing || this.failureTask || audio.length === 0) {
      return;
    }
    if (this.connected) {
      this.audioPeer?.sendAudio(audio);
    } else if (this.recoveryPending || this.recoveryTask) {
      this.pendingAudio.enqueue(audio);
    }
  }

  sendUserMessage(text: string): void {
    const normalized = text.trim();
    if (!normalized || !this.connected || this.terminal || this.closing) {
      return;
    }
    this.responseTerminalEmitted = false;
    void this.client
      .request(
        "thread/realtime/appendText",
        { threadId: this.threadId, role: "user", text: normalized },
        { signal: this.signal },
      )
      .catch((error: unknown) => this.fail(error));
  }

  triggerGreeting(instructions?: string): void {
    if (instructions?.trim()) {
      this.sendUserMessage(instructions);
    }
  }

  handleBargeIn(): void {
    // Codex Realtime V3 owns VAD, cancellation, and interruption.
  }

  setMediaTimestamp(): void {}

  submitToolResult(): never {
    throw new Error("Codex realtime executes the bound agent's tools natively");
  }

  acknowledgeMark(): void {}

  close(): void {
    if (this.terminal || this.closing) {
      return;
    }
    this.closing = true;
    void this.stop().finally(() => this.finish("completed"));
  }

  isConnected(): boolean {
    return this.connected && !this.terminal && !this.closing;
  }

  getFailure(): Error | undefined {
    return this.failure;
  }

  handleNotification(notification: CodexServerNotification): void {
    if (this.terminal || this.closing || this.failureTask) {
      return;
    }
    const params = asOptionalRecord(notification.params);
    if (readStringField(params, "threadId") !== this.threadId) {
      return;
    }
    switch (notification.method) {
      case "thread/realtime/started":
        this.request.onEvent?.({ direction: "server", type: "session.created" });
        return;
      case "thread/realtime/sdp": {
        const sdp = readStringField(params, "sdp");
        if (!sdp) {
          void this.fail(new Error("Codex realtime returned an invalid WebRTC SDP answer"));
          return;
        }
        void this.applyAnswer(sdp);
        return;
      }
      case "thread/realtime/transcript/delta": {
        const role = readRealtimeRole(readStringField(params, "role"));
        const delta = readStringField(params, "delta");
        if (role && delta) {
          this.request.onTranscript?.(role, delta, false);
        }
        return;
      }
      case "thread/realtime/transcript/done": {
        const role = readRealtimeRole(readStringField(params, "role"));
        const text = readStringField(params, "text");
        if (!role) {
          return;
        }
        if (text) {
          this.recordTranscriptHistory(role, text);
          this.request.onTranscript?.(role, text, true);
        }
        if (role === "user") {
          this.responseTerminalEmitted = false;
        } else {
          this.emitResponseDone();
        }
        return;
      }
      case "thread/realtime/itemAdded": {
        const item = asOptionalRecord(params?.item);
        const type = readStringField(item, "type");
        if (type === "input_audio_buffer.speech_started") {
          this.request.onClearAudio("barge-in");
        }
        if (type) {
          this.request.onEvent?.({ direction: "server", type });
          if (type === "response.cancelled") {
            this.responseTerminalEmitted = true;
          }
        }
        return;
      }
      case "thread/realtime/error":
        this.handleRealtimeError(
          new Error(readStringField(params, "message") ?? "Codex realtime session failed"),
        );
        return;
      case "thread/realtime/closed": {
        const reason = readStringField(params, "reason");
        if (this.recoveryPending && reason === "error") {
          this.recoveryPending = false;
          this.beginRecovery();
          return;
        }
        this.recoveryPending = false;
        if (reason === "error") {
          void this.fail(new Error("Codex realtime transport closed unexpectedly"));
        } else {
          this.finish("completed");
        }
      }
    }
  }

  handleRouteFailure(reason: unknown): void {
    if (!this.closing) {
      void this.fail(reason instanceof Error ? reason : new Error(String(reason)));
    }
  }

  private handleRealtimeError(error: Error): void {
    const recoverable = error.message.startsWith(CODEX_REALTIME_WEBSOCKET_READ_FAILURE_PREFIX);
    if (this.recoveryPending && recoverable) {
      return;
    }
    if (!this.connected || !recoverable) {
      void this.fail(error);
      return;
    }
    this.recoveryPending = true;
    this.connected = false;
    this.pendingAudio.clear();
    this.retirePeer();
    this.request.onEvent?.({
      direction: "client",
      type: "session.continuity.reset",
      detail: "codex-transport-recovery",
    });
  }

  private beginRecovery(): void {
    if (this.recoveryTask || this.terminal || this.closing) {
      return;
    }
    this.resetTransport();
    const recovery = this.connect()
      .catch(() => undefined)
      .finally(() => {
        if (this.recoveryTask === recovery) {
          this.recoveryTask = undefined;
        }
      });
    this.recoveryTask = recovery;
  }

  private resetTransport(): void {
    this.retirePeer();
    this.answerApplied = undefined;
    this.answerAppliedSettled = false;
    this.responseTerminalEmitted = false;
    this.startRequested = false;
    this.stopPromise = undefined;
  }

  private buildInitialItems(instructions: string | undefined): CodexRealtimeInitialItem[] {
    const items: CodexRealtimeInitialItem[] = instructions
      ? [{ role: "developer", text: instructions }]
      : [];
    let remainingBytes =
      CODEX_REALTIME_INITIAL_ITEMS_MAX_BYTES - (instructions ? Buffer.byteLength(instructions) : 0);
    for (
      let index = this.transcriptHistory.length - 1;
      index >= 0 && items.length < CODEX_REALTIME_INITIAL_ITEMS_MAX_COUNT;
      index -= 1
    ) {
      const item = this.transcriptHistory[index]!;
      const bytes = Buffer.byteLength(item.text);
      if (bytes <= remainingBytes) {
        items.splice(instructions ? 1 : 0, 0, item);
        remainingBytes -= bytes;
      }
    }
    return items;
  }

  private recordTranscriptHistory(role: RealtimeVoiceRole, text: string): void {
    this.transcriptHistory.push({ role, text });
    this.transcriptHistoryBytes += Buffer.byteLength(text);
    while (
      this.transcriptHistory.length > CODEX_REALTIME_INITIAL_ITEMS_MAX_COUNT ||
      this.transcriptHistoryBytes > CODEX_REALTIME_INITIAL_ITEMS_MAX_BYTES
    ) {
      const removed = this.transcriptHistory.shift();
      if (removed) {
        this.transcriptHistoryBytes -= Buffer.byteLength(removed.text);
      }
    }
  }

  private retirePeer(): void {
    this.transportGeneration += 1;
    this.audioPeer?.close();
    this.audioPeer = undefined;
  }

  private isActiveGeneration(generation: number): boolean {
    return this.transportGeneration === generation && !this.terminal && !this.closing;
  }

  private async applyAnswer(sdp: string): Promise<void> {
    const answerApplied = this.answerApplied;
    const peer = this.audioPeer;
    if (!answerApplied || !peer || this.answerAppliedSettled) {
      return;
    }
    try {
      await peer.applyAnswer(sdp);
      this.answerAppliedSettled = true;
      answerApplied.resolve();
    } catch (error) {
      this.answerAppliedSettled = true;
      answerApplied.reject(error);
      void this.fail(error);
    }
  }

  private stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    if (!this.startRequested) {
      return Promise.resolve();
    }
    this.stopPromise = this.client
      .request(
        "thread/realtime/stop",
        { threadId: this.threadId },
        { signal: this.signal, timeoutMs: CODEX_REALTIME_STOP_TIMEOUT_MS },
      )
      .then(() => undefined)
      .catch(() => undefined);
    return this.stopPromise;
  }

  private emitResponseDone(): void {
    if (!this.responseTerminalEmitted) {
      this.responseTerminalEmitted = true;
      this.request.onEvent?.({ direction: "server", type: "response.done" });
    }
  }

  private fail(error: unknown): Promise<void> {
    if (this.failureTask) {
      return this.failureTask;
    }
    if (this.terminal || this.closing) {
      return Promise.resolve();
    }
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.failure = normalized;
    this.connected = false;
    this.failureTask = this.stop().finally(() => {
      try {
        this.request.onError?.(normalized);
      } finally {
        this.finish("error");
      }
    });
    return this.failureTask;
  }

  private finish(reason: RealtimeVoiceCloseReason): void {
    if (this.terminal) {
      return;
    }
    this.terminal = true;
    this.connected = false;
    this.pendingAudio.clear();
    this.answerAppliedSettled = true;
    this.answerApplied?.reject(new Error("Codex realtime session closed during startup"));
    this.retirePeer();
    try {
      this.request.onClose?.(reason);
    } finally {
      this.completion.resolve(reason);
    }
  }
}

export function createCodexAppServerRealtimeVoiceBridge(
  client: CodexAppServerClient,
  threadId: string,
  request: RealtimeVoiceBridgeCreateRequest,
  signal: AbortSignal,
  createPeer: CodexRealtimeAudioPeerFactory = createAudioPeer,
) {
  return new CodexAppServerRealtimeVoiceBridge(client, threadId, request, signal, createPeer);
}

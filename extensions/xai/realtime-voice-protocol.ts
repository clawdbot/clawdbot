import { randomUUID } from "node:crypto";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBargeInOptions,
  RealtimeVoicePlaybackItem,
  RealtimeVoiceSessionConnection,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  realtimeVoiceAudioDurationMs,
  toOpenAICompatibleRealtimeAudioFormat,
} from "openclaw/plugin-sdk/realtime-voice";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  XAI_REALTIME_DEFAULT_PREFIX_PADDING_MS,
  XAI_REALTIME_DEFAULT_SILENCE_DURATION_MS,
  XAI_REALTIME_DEFAULT_VAD_THRESHOLD,
  XAI_REALTIME_INPUT_TRANSCRIPTION_MODEL,
  XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS,
  serializeXaiRealtimeToolResult,
  type XaiRealtimeEvent,
  type XaiRealtimeSessionUpdate,
  type XaiRealtimeVoiceBridgeConfig,
} from "./realtime-voice-config.js";

export class XaiRealtimePlaybackMarkOverflowError extends Error {}

type XaiAssistantAudioItem = {
  itemId: string;
  bytes: number;
  startTimestamp: number;
};

export abstract class XaiRealtimeVoiceProtocol {
  protected readonly audioFormat: RealtimeVoiceAudioFormat;
  protected markQueue: string[] = [];
  protected responseActive = false;
  protected responseCreateInFlight = false;
  protected responseCancelInFlight = false;
  protected responseCreatePending = false;
  protected continuingToolCallIds = new Set<string>();
  protected pendingToolCallIds = new Set<string>();
  protected latestMediaTimestamp = 0;
  protected outputAudioGeneration = 0;
  private interruptingPlayback = false;
  protected assistantAudioItem: XaiAssistantAudioItem | null = null;
  protected toolCallBuffers = new Map<string, { name: string; callId: string; args: string }>();
  protected deliveredToolCallKeys = new Set<string>();
  protected pendingToolResultAcks = new Set<string>();
  protected conversationId: string | null = null;

  constructor(protected readonly config: XaiRealtimeVoiceBridgeConfig) {
    this.audioFormat = config.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ;
  }

  protected abstract sendEvent(event: unknown, detail?: string): void;

  protected sendUserMessageNow(text: string): void {
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.requestResponseCreate();
  }

  protected submitToolResultNow(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    if (options?.willContinue === true) {
      return;
    }
    const output = serializeXaiRealtimeToolResult(result);
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output,
      },
    });
    this.pendingToolResultAcks.add(callId);
    this.continuingToolCallIds.delete(callId);
    this.pendingToolCallIds.delete(callId);
    if (options?.suppressResponse !== true) {
      this.flushPendingResponseCreateAfterToolResults();
    }
  }

  acknowledgeMark(markName?: string): void {
    if (this.markQueue.length === 0) {
      return;
    }
    if (markName) {
      const index = this.markQueue.indexOf(markName);
      if (index < 0) {
        return;
      }
      this.markQueue.splice(index, 1);
    } else {
      this.markQueue.shift();
    }
    if (this.markQueue.length === 0) {
      this.flushPendingResponseCreate();
    }
  }

  handleBargeIn(options?: RealtimeVoiceBargeInOptions): void {
    this.interruptPlayback("barge-in", options);
  }

  protected handleServerVadBargeIn(): void {
    this.interruptPlayback("server-vad-barge-in");
  }

  private audioEndMs(item: XaiAssistantAudioItem): number {
    const producedAudioMs = Math.floor(realtimeVoiceAudioDurationMs(this.audioFormat, item.bytes));
    const playbackAudioMs = Math.max(0, this.latestMediaTimestamp - item.startTimestamp);
    return Math.min(producedAudioMs, playbackAudioMs);
  }

  private interruptPlayback(
    reason: "barge-in" | "server-vad-barge-in",
    options?: RealtimeVoiceBargeInOptions,
  ): void {
    // Wire observers can synchronously reenter before the sink clears its snapshot.
    if (this.interruptingPlayback) {
      return;
    }
    this.interruptingPlayback = true;
    try {
      const item = this.assistantAudioItem;
      const hasLegacyPlayback =
        this.markQueue.length > 0 ||
        (reason === "barge-in" && (this.responseActive || options?.audioPlaybackActive === true));
      // Timestamp/mark-only transports retain their shipped clock contract;
      // an empty native snapshot means all prior audio was already heard.
      const playbackState: readonly RealtimeVoicePlaybackItem[] = this.config.getPlaybackState
        ? this.config.getPlaybackState()
        : item && hasLegacyPlayback
          ? [{ itemId: item.itemId, audioEndMs: this.audioEndMs(item) }]
          : [];
      const playbackItems = playbackState.map(({ itemId, audioEndMs }) => ({ itemId, audioEndMs }));
      const cancelResponse =
        reason === "barge-in" &&
        (this.responseActive || this.responseCreateInFlight || playbackItems.length > 0) &&
        !this.responseCancelInFlight;
      this.outputAudioGeneration += 1;
      this.markQueue = [];
      this.assistantAudioItem = null;
      if (this.responseActive || this.responseCreateInFlight) {
        this.responseCancelInFlight = true;
      }
      // xAI requires manual cancellation before truncating even completed playback.
      // Only active generation has a later response.done; VAD owns its cancellation.
      if (cancelResponse) {
        this.sendEvent({ type: "response.cancel" }, `reason=${reason}`);
      }
      for (const playbackItem of playbackItems) {
        this.sendEvent(
          {
            type: "conversation.item.truncate",
            item_id: playbackItem.itemId,
            content_index: 0,
            audio_end_ms: playbackItem.audioEndMs,
          },
          `reason=${reason} audioEndMs=${playbackItem.audioEndMs}`,
        );
      }
      // The sink can request replacement generation when cleared; trim its history first.
      this.config.onClearAudio("barge-in");
    } finally {
      this.interruptingPlayback = false;
    }
    // Observer requests wait until history and the sink are cleared. Server VAD
    // owns its next response; only a host interruption drains this gate.
    if (reason === "barge-in") {
      this.flushPendingResponseCreate();
    }
  }

  protected buildSessionUpdate(): XaiRealtimeSessionUpdate {
    const cfg = this.config;
    const format = toOpenAICompatibleRealtimeAudioFormat(this.audioFormat);
    return {
      type: "session.update",
      session: {
        instructions: cfg.instructions,
        voice: cfg.voice ?? "eve",
        output_modalities: ["audio"],
        turn_detection: {
          type: "server_vad",
          threshold: cfg.vadThreshold ?? XAI_REALTIME_DEFAULT_VAD_THRESHOLD,
          prefix_padding_ms: cfg.prefixPaddingMs ?? XAI_REALTIME_DEFAULT_PREFIX_PADDING_MS,
          silence_duration_ms: cfg.silenceDurationMs ?? XAI_REALTIME_DEFAULT_SILENCE_DURATION_MS,
        },
        audio: {
          input: {
            format,
            transcription: { model: XAI_REALTIME_INPUT_TRANSCRIPTION_MODEL },
          },
          output: { format },
        },
        ...(cfg.sessionResumption === true ? { resumption: { enabled: true } } : {}),
        ...(cfg.reasoningEffort ? { reasoning: { effort: cfg.reasoningEffort } } : {}),
        ...(cfg.tools?.length
          ? {
              tools: cfg.tools,
              tool_choice: "auto",
            }
          : {}),
      },
    };
  }

  protected emitToolCallOnce(fields: {
    itemId?: string;
    callId?: string;
    name?: string;
    rawArgs?: string;
  }): void {
    if (!this.config.onToolCall) {
      return;
    }
    const itemId = fields.itemId || fields.callId || "unknown";
    const callId = fields.callId || itemId;
    const name = fields.name || "";
    const dedupeKey = fields.itemId || fields.callId || `${name}:${fields.rawArgs ?? ""}`;
    if (this.deliveredToolCallKeys.has(dedupeKey)) {
      return;
    }
    let args: unknown;
    try {
      args = JSON.parse(fields.rawArgs || "{}");
    } catch {
      this.rejectToolCallArguments({
        itemId,
        callId,
        dedupeKey,
        reason: "malformed-json",
      });
      return;
    }
    if (!isRecord(args)) {
      this.rejectToolCallArguments({
        itemId,
        callId,
        dedupeKey,
        reason: "non-object-json",
      });
      return;
    }
    this.deliveredToolCallKeys.add(dedupeKey);
    this.pendingToolCallIds.add(callId);
    this.config.onToolCall({ itemId, callId, name, args });
  }

  private rejectToolCallArguments(params: {
    itemId: string;
    callId: string;
    dedupeKey: string;
    reason: string;
  }): void {
    // xAI pauses until every function call receives an output. Treat rejection as
    // terminal and dedupe it before sending so replay cannot complete the call twice.
    this.deliveredToolCallKeys.add(params.dedupeKey);
    this.config.onEvent?.({
      direction: "server",
      type: "tool_call.arguments.rejected",
      detail: `reason=${params.reason}`,
      itemId: params.itemId,
    });
    this.submitToolResultNow(params.callId, { error: "Invalid tool arguments." });
  }

  private flushPendingResponseCreateAfterToolResults(): void {
    if (this.pendingToolCallIds.size > 0 || this.continuingToolCallIds.size > 0) {
      this.responseCreatePending = true;
      return;
    }
    this.requestResponseCreate();
  }

  protected requestResponseCreate(): void {
    // xAI requires every parallel function output before one response.create, and
    // relay playback must drain before the next response starts.
    if (
      this.interruptingPlayback ||
      this.responseActive ||
      this.responseCreateInFlight ||
      this.responseCancelInFlight ||
      this.markQueue.length > 0 ||
      this.continuingToolCallIds.size > 0 ||
      this.pendingToolCallIds.size > 0
    ) {
      this.responseCreatePending = true;
      return;
    }
    this.responseCreatePending = false;
    this.responseCreateInFlight = true;
    this.sendEvent({ type: "response.create" });
  }

  protected flushPendingResponseCreate(): void {
    if (!this.responseCreatePending) {
      return;
    }
    this.responseCreatePending = false;
    this.requestResponseCreate();
  }

  protected resetRealtimeSessionState(options: { preserveToolCallState?: boolean } = {}): void {
    this.outputAudioGeneration += 1;
    this.markQueue = [];
    this.responseActive = false;
    this.responseCreateInFlight = false;
    this.responseCancelInFlight = false;
    this.responseCreatePending = false;
    this.assistantAudioItem = null;
    this.resetInputTranscripts();
    if (!options.preserveToolCallState) {
      this.continuingToolCallIds.clear();
      this.pendingToolCallIds.clear();
      this.toolCallBuffers.clear();
      this.deliveredToolCallKeys.clear();
      this.pendingToolResultAcks.clear();
    }
  }

  protected createPlaybackMark(): string {
    // Playback marks gate the next response. Dropping one would invent an
    // acknowledgement, so fail before delivering audio that cannot be tracked.
    if (this.markQueue.length >= XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS) {
      throw new XaiRealtimePlaybackMarkOverflowError(
        `xAI realtime voice playback mark limit exceeded (${XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS})`,
      );
    }
    const markName = `audio-${randomUUID()}`;
    this.markQueue.push(markName);
    return markName;
  }

  protected abstract resetInputTranscripts(): void;
  protected abstract handleEvent(
    event: XaiRealtimeEvent,
    connection: RealtimeVoiceSessionConnection,
  ): void;
}

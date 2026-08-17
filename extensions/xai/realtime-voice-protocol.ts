import { randomUUID } from "node:crypto";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceSessionConnection,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import { REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ } from "openclaw/plugin-sdk/realtime-voice";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  XAI_REALTIME_DEFAULT_PREFIX_PADDING_MS,
  XAI_REALTIME_DEFAULT_SILENCE_DURATION_MS,
  XAI_REALTIME_DEFAULT_VAD_THRESHOLD,
  XAI_REALTIME_INPUT_TRANSCRIPTION_MODEL,
  XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS,
  serializeXaiRealtimeToolResult,
  type XaiRealtimeAudioFormatConfig,
  type XaiRealtimeEvent,
  type XaiRealtimeSessionUpdate,
  type XaiRealtimeVoiceBridgeConfig,
} from "./realtime-voice-config.js";

export class XaiRealtimePlaybackMarkOverflowError extends Error {}

export abstract class XaiRealtimeVoiceProtocol {
  protected readonly audioFormat: RealtimeVoiceAudioFormat;
  protected markQueue: string[] = [];
  protected responseStartTimestamp: number | null = null;
  protected responseActive = false;
  protected responseCreateInFlight = false;
  protected responseCancelInFlight = false;
  protected responseCreatePending = false;
  protected continuingToolCallIds = new Set<string>();
  protected pendingToolCallIds = new Set<string>();
  protected latestMediaTimestamp = 0;
  protected lastAssistantItemId: string | null = null;

  // Bytes of assistant audio delivered for the item currently identified by
  // lastAssistantItemId. conversation.item.truncate's audio_end_ms is otherwise
  // derived from the INPUT-audio media clock, which only tracks output for a
  // transport where both share one real-time clock; a relayed mobile client's
  // clocks drift independently, so the estimate must be clamped to audio this
  // item actually produced.
  protected deliveredAudioBytesForCurrentItem = 0;
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
    const assistantItemId = this.lastAssistantItemId;
    const responseStartTimestamp = this.responseStartTimestamp;
    const outputInterruptible =
      responseStartTimestamp !== null &&
      (this.responseActive || this.markQueue.length > 0 || options?.audioPlaybackActive === true);
    const shouldInterruptProvider = assistantItemId !== null && outputInterruptible;
    const audioEndMs = shouldInterruptProvider
      ? this.clampAudioEndMsToDelivered(
          Math.max(
            0,
            responseStartTimestamp === null
              ? this.latestMediaTimestamp
              : this.latestMediaTimestamp - responseStartTimestamp,
          ),
        )
      : null;
    if (this.responseActive && !this.responseCancelInFlight) {
      this.sendEvent({ type: "response.cancel" }, "reason=barge-in");
      this.responseCancelInFlight = true;
    }
    if (shouldInterruptProvider) {
      this.sendEvent(
        {
          type: "conversation.item.truncate",
          item_id: assistantItemId,
          content_index: 0,
          audio_end_ms: audioEndMs,
        },
        `reason=barge-in audioEndMs=${audioEndMs}`,
      );
      this.config.onClearAudio("barge-in");
      this.markQueue = [];
      this.lastAssistantItemId = null;
      this.responseStartTimestamp = null;
      this.resetItemAudioAccounting();
      return;
    }
    this.config.onClearAudio("barge-in");
    this.markQueue = [];
  }

  protected handleServerVadBargeIn(): void {
    // xAI owns server-VAD cancellation, but only the relay knows how much
    // queued audio actually played. Trim provider history to that boundary.
    if (
      this.lastAssistantItemId !== null &&
      this.responseStartTimestamp !== null &&
      this.markQueue.length > 0
    ) {
      const audioEndMs = this.clampAudioEndMsToDelivered(
        Math.max(0, this.latestMediaTimestamp - this.responseStartTimestamp),
      );
      this.sendEvent(
        {
          type: "conversation.item.truncate",
          item_id: this.lastAssistantItemId,
          content_index: 0,
          audio_end_ms: audioEndMs,
        },
        `reason=server-vad-barge-in audioEndMs=${audioEndMs}`,
      );
    }
    this.config.onClearAudio("barge-in");
    this.markQueue = [];
    this.lastAssistantItemId = null;
    this.responseStartTimestamp = null;
  }

  protected buildSessionUpdate(): XaiRealtimeSessionUpdate {
    const cfg = this.config;
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
            format: this.resolveRealtimeAudioFormat(),
            transcription: { model: XAI_REALTIME_INPUT_TRANSCRIPTION_MODEL },
          },
          output: { format: this.resolveRealtimeAudioFormat() },
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

  /** Upper bound, in ms, on how much of the current item could possibly have played. */
  protected deliveredAudioMsForCurrentItem(): number | null {
    if (this.deliveredAudioBytesForCurrentItem <= 0) {
      return null;
    }
    const bytesPerSample = this.audioFormat.encoding === "pcm16" ? 2 : 1;
    const bytesPerMs = (this.audioFormat.sampleRateHz * bytesPerSample) / 1000;
    if (!Number.isFinite(bytesPerMs) || bytesPerMs <= 0) {
      return null;
    }
    return Math.floor(this.deliveredAudioBytesForCurrentItem / bytesPerMs);
  }

  /** Clamps a media-clock estimate to audio this item actually delivered. */
  protected clampAudioEndMsToDelivered(audioEndMs: number): number {
    const deliveredMs = this.deliveredAudioMsForCurrentItem();
    return deliveredMs === null ? audioEndMs : Math.min(audioEndMs, deliveredMs);
  }

  protected resetItemAudioAccounting(): void {
    this.deliveredAudioBytesForCurrentItem = 0;
  }

  private resolveRealtimeAudioFormat(): XaiRealtimeAudioFormatConfig {
    return this.audioFormat.encoding === "pcm16"
      ? { type: "audio/pcm", rate: 24000 }
      : { type: "audio/pcmu" };
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
    this.markQueue = [];
    this.responseStartTimestamp = null;
    this.responseActive = false;
    this.responseCreateInFlight = false;
    this.responseCancelInFlight = false;
    this.responseCreatePending = false;
    this.lastAssistantItemId = null;
    this.resetInputTranscripts();
    if (!options.preserveToolCallState) {
      this.continuingToolCallIds.clear();
      this.pendingToolCallIds.clear();
      this.toolCallBuffers.clear();
      this.deliveredToolCallKeys.clear();
      this.pendingToolResultAcks.clear();
    }
  }

  protected emitAudioWithPlaybackMark(audio: Buffer): void {
    // Playback marks gate the next response. Dropping one would invent an
    // acknowledgement, so fail before delivering audio that cannot be tracked.
    if (this.markQueue.length >= XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS) {
      throw new XaiRealtimePlaybackMarkOverflowError(
        `xAI realtime voice playback mark limit exceeded (${XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS})`,
      );
    }
    const markName = `audio-${randomUUID()}`;
    this.config.onAudio(audio);
    this.markQueue.push(markName);
    this.config.onMark?.(markName);
  }

  protected abstract resetInputTranscripts(): void;
  protected abstract handleEvent(
    event: XaiRealtimeEvent,
    connection: RealtimeVoiceSessionConnection,
  ): void;
}

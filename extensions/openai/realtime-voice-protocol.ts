import { randomUUID } from "node:crypto";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import { REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ } from "openclaw/plugin-sdk/realtime-voice";
import {
  AZURE_OPENAI_REALTIME_TOOL_NAME_MAX_LENGTH,
  OPENAI_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS,
  OPENAI_REALTIME_DEFAULT_MODEL,
  buildOpenAIRealtimeGaSessionPolicy,
  buildOpenAIRealtimeTurnDetectionConfig,
  normalizeOpenAIRealtimeTools,
  parsePlaybackMarkSequence,
  type OpenAIRealtimeUserMessageOptions,
  type OpenAIRealtimeVoiceBridgeConfig,
  type RealtimeAzureDeploymentSessionUpdate,
  type RealtimeGaSessionUpdate,
  type RealtimeTurnDetectionConfig,
} from "./realtime-voice-session-policy.js";

export abstract class OpenAIRealtimeProtocol {
  static readonly MAX_TOOL_ARGUMENT_BYTES = 256_000;

  // Realtime defines no replay window. Keep every terminal id for this
  // connection generation, then fail instead of re-admitting late duplicates.
  static readonly MAX_COMPLETED_TOOL_CALL_IDS = 1_024;

  readonly supportsToolResultContinuation = true;

  readonly supportsToolResultSuppression = true;

  protected nextMarkSequence = 1;

  protected oldestOutstandingMarkSequence: number | null = null;

  protected latestOutstandingMarkSequence: number | null = null;

  protected responseStartTimestamp: number | null = null;

  protected responseActive = false;

  protected responseCreateInFlight = false;

  protected manualResponseCreateEventId: string | null = null;

  protected responseCancelInFlight = false;

  protected manualResponseCancelEventId: string | null = null;

  protected responseCreatePending = false;

  protected autoRespondSuppressedForManualResponse = false;

  protected continuingToolCallIds = new Set<string>();

  protected pendingToolCallIds = new Set<string>();

  protected latestMediaTimestamp = 0;

  protected lastAssistantItemId: string | null = null;

  // item_id of the assistant item we most recently sent
  // conversation.item.truncate for. Deltas that keep arriving for this exact
  // item after the truncate (a race between the request and the provider's
  // in-flight generation) must not be re-adopted as a new item - see
  // OpenAIRealtimeEvents' response.audio.delta handling.
  protected lastTruncatedItemId: string | null = null;

  // event_id of the most recently sent conversation.item.truncate, so a
  // provider-side rejection of that specific request can be recognized and
  // used to repair state (in particular, release responseCancelInFlight if
  // it was set for the same barge-in and nothing else will ever clear it).
  protected manualTruncateEventId: string | null = null;

  protected completedToolCallIds = new Set<string>();

  protected standaloneSpeechQueue: string[] = [];

  protected standaloneSpeechActive = false;

  protected standaloneSpeechEventId: string | null = null;

  // Cumulative bytes of assistant audio delivered to the client for the item
  // currently identified by lastAssistantItemId. Reset whenever that item
  // changes (see OpenAIRealtimeEvents' response.audio.delta handling) or
  // marks are cleared.
  protected deliveredAudioBytesForCurrentItem = 0;

  // Cumulative bytes of assistant audio the client has *confirmed playing*
  // (via acknowledgeMark) for the current item. This can only ever be <=
  // deliveredAudioBytesForCurrentItem, which is what makes it a safe source
  // for conversation.item.truncate's audio_end_ms: it is derived from audio
  // actually reaching the client, not from an unrelated input-audio clock.
  protected playedAudioBytesForCurrentItem = 0;

  // markSequence -> deliveredAudioBytesForCurrentItem snapshot at the moment
  // that mark was sent, so acknowledging a mark tells us exactly how many
  // bytes of the current item had been delivered by that point.
  private readonly markAudioByteOffsets = new Map<number, number>();

  private readonly audioFormat: RealtimeVoiceAudioFormat;

  constructor(protected readonly config: OpenAIRealtimeVoiceBridgeConfig) {
    this.audioFormat = config.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ;
  }

  setMediaTimestamp(ts: number): void {
    this.latestMediaTimestamp = ts;
  }

  acknowledgeMark(markName?: string): void {
    const oldest = this.oldestOutstandingMarkSequence;
    const latest = this.latestOutstandingMarkSequence;
    if (oldest === null || latest === null) {
      return;
    }
    const acknowledgedSequence =
      markName === undefined ? oldest : parsePlaybackMarkSequence(markName);
    if (
      acknowledgedSequence === undefined ||
      acknowledgedSequence < oldest ||
      acknowledgedSequence > latest
    ) {
      return;
    }
    const playedBytes = this.markAudioByteOffsets.get(acknowledgedSequence);
    if (playedBytes !== undefined && playedBytes > this.playedAudioBytesForCurrentItem) {
      this.playedAudioBytesForCurrentItem = playedBytes;
    }
    for (const sequence of this.markAudioByteOffsets.keys()) {
      if (sequence <= acknowledgedSequence) {
        this.markAudioByteOffsets.delete(sequence);
      }
    }
    // Marks follow ordered playback. Reaching a named mark also acknowledges every
    // earlier mark, while late acknowledgements from that prefix remain harmless.
    if (acknowledgedSequence === latest) {
      this.oldestOutstandingMarkSequence = null;
      this.latestOutstandingMarkSequence = null;
      return;
    }
    this.oldestOutstandingMarkSequence = acknowledgedSequence + 1;
  }

  // Bytes-per-millisecond for the negotiated output audio format. Guards
  // against NaN (not just <= 0) so a malformed sampleRateHz silently
  // disables barge-in truncation instead of producing a bogus audio_end_ms.
  private audioBytesPerMs(): number | null {
    const bytesPerSample = this.audioFormat.encoding === "pcm16" ? 2 : 1;
    const bytesPerMs = (this.audioFormat.sampleRateHz * bytesPerSample) / 1000;
    return Number.isFinite(bytesPerMs) && bytesPerMs > 0 ? bytesPerMs : null;
  }

  /**
   * Converts confirmed-played bytes for the current item into milliseconds
   * using the negotiated output audio format, or null when no mark for the
   * current item has been acknowledged yet (callers should fall back to
   * another audio_end_ms source in that case).
   */
  protected playedAudioMsForCurrentItem(): number | null {
    if (this.playedAudioBytesForCurrentItem <= 0) {
      return null;
    }
    const bytesPerMs = this.audioBytesPerMs();
    return bytesPerMs === null
      ? null
      : Math.floor(this.playedAudioBytesForCurrentItem / bytesPerMs);
  }

  /**
   * Converts bytes of assistant audio actually DELIVERED to the client for
   * the current item into milliseconds. This is a strict upper bound on how
   * much of the item could possibly have been heard - OpenAI cannot reject
   * conversation.item.truncate for exceeding item duration if audio_end_ms
   * never exceeds this value, regardless of which clock produced the
   * pre-clamp estimate.
   */
  protected deliveredAudioMsForCurrentItem(): number | null {
    if (this.deliveredAudioBytesForCurrentItem <= 0) {
      return null;
    }
    const bytesPerMs = this.audioBytesPerMs();
    return bytesPerMs === null
      ? null
      : Math.floor(this.deliveredAudioBytesForCurrentItem / bytesPerMs);
  }

  // Clears all per-item audio-accounting state (delivered bytes, confirmed-
  // played bytes, and the mark->byte-offset map). Must run on every item
  // transition - markAudioByteOffsets is private specifically so this is
  // the only way to clear it, preventing a subclass reset (see
  // OpenAIRealtimeEvents) from forgetting a piece of this state.
  protected resetItemAudioAccounting(): void {
    this.deliveredAudioBytesForCurrentItem = 0;
    this.playedAudioBytesForCurrentItem = 0;
    this.markAudioByteOffsets.clear();
  }

  protected sendSessionUpdate(): void {
    if (this.usesAzureDeploymentRealtimeApi()) {
      this.sendEvent(this.buildAzureDeploymentSessionUpdate());
      return;
    }

    this.sendEvent(this.buildGaSessionUpdate());
  }

  protected buildGaSessionUpdate(): RealtimeGaSessionUpdate {
    const cfg = this.config;
    return {
      type: "session.update",
      session:
        cfg.gaSessionPolicy ??
        buildOpenAIRealtimeGaSessionPolicy({
          audioFormat: this.audioFormat,
          autoRespondToAudio: cfg.autoRespondToAudio,
          instructions: cfg.instructions,
          interruptResponseOnInputAudio: cfg.interruptResponseOnInputAudio,
          language: cfg.language,
          model: cfg.model ?? OPENAI_REALTIME_DEFAULT_MODEL,
          noiseReduction: null,
          prefixPaddingMs: cfg.prefixPaddingMs,
          reasoningEffort: cfg.reasoningEffort,
          silenceDurationMs: cfg.silenceDurationMs,
          tools: normalizeOpenAIRealtimeTools(cfg.tools),
          vadThreshold: cfg.vadThreshold,
          voice: cfg.voice ?? "alloy",
        }),
    };
  }

  protected usesAzureDeploymentRealtimeApi(): boolean {
    return Boolean(this.config.azureEndpoint && this.config.azureDeployment);
  }

  protected buildAzureDeploymentSessionUpdate(): RealtimeAzureDeploymentSessionUpdate {
    const cfg = this.config;
    const format = this.resolveLegacyRealtimeAudioFormat();
    const tools = normalizeOpenAIRealtimeTools(
      cfg.tools,
      AZURE_OPENAI_REALTIME_TOOL_NAME_MAX_LENGTH,
    );
    return {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: cfg.instructions,
        voice: cfg.voice ?? "alloy",
        input_audio_format: format,
        output_audio_format: format,
        input_audio_transcription: {
          model: "whisper-1",
          ...(cfg.language ? { language: cfg.language } : {}),
        },
        turn_detection: this.buildTurnDetectionConfig(),
        temperature: cfg.temperature ?? 0.8,
        ...(tools
          ? {
              tools,
              tool_choice: "auto",
            }
          : {}),
      },
    };
  }

  protected buildTurnDetectionConfig(options?: {
    createResponse?: boolean;
    includeInterruptResponse?: boolean;
  }): RealtimeTurnDetectionConfig {
    return buildOpenAIRealtimeTurnDetectionConfig({
      autoRespondToAudio: this.config.autoRespondToAudio,
      createResponse: options?.createResponse,
      includeInterruptResponse: options?.includeInterruptResponse,
      interruptResponseOnInputAudio: this.config.interruptResponseOnInputAudio,
      prefixPaddingMs: this.config.prefixPaddingMs,
      silenceDurationMs: this.config.silenceDurationMs,
      vadThreshold: this.config.vadThreshold,
    });
  }

  protected sendAutoResponseSessionUpdate(createResponse: boolean): void {
    const azureDeployment = this.usesAzureDeploymentRealtimeApi();
    const turnDetection = this.buildTurnDetectionConfig({
      createResponse,
      includeInterruptResponse: !azureDeployment,
    });
    if (azureDeployment) {
      this.sendEvent({ type: "session.update", session: { turn_detection: turnDetection } });
      return;
    }
    this.sendEvent({
      type: "session.update",
      session: { type: "realtime", audio: { input: { turn_detection: turnDetection } } },
    });
  }

  protected resolveLegacyRealtimeAudioFormat(): "g711_ulaw" | "pcm16" {
    return this.audioFormat.encoding === "pcm16" ? "pcm16" : "g711_ulaw";
  }

  protected releaseResponseState(options: { drain?: boolean } = {}): void {
    this.responseActive = false;
    this.responseCreateInFlight = false;
    this.manualResponseCreateEventId = null;
    this.responseCancelInFlight = false;
    this.manualResponseCancelEventId = null;
    if (this.standaloneSpeechActive) {
      this.standaloneSpeechActive = false;
      this.standaloneSpeechEventId = null;
    }
    if (options.drain === false) {
      return;
    }
    if (this.standaloneSpeechQueue.length > 0) {
      this.flushStandaloneSpeech();
    } else if (this.responseCreatePending) {
      this.flushPendingResponseCreate();
    } else {
      this.restoreAutoRespondAfterManualResponse();
    }
  }

  handleBargeIn(options?: RealtimeVoiceBargeInOptions): void {
    const assistantItemId = this.lastAssistantItemId;
    const responseStartTimestamp = this.responseStartTimestamp;
    const force = options?.force === true;
    const shouldInterruptProvider =
      assistantItemId !== null &&
      ((responseStartTimestamp !== null &&
        (this.oldestOutstandingMarkSequence !== null || options?.audioPlaybackActive === true)) ||
        force);
    // audio_end_ms must describe audio actually heard by the user for THIS
    // item (OpenAI Realtime conversation.item.truncate contract). The
    // mark-acknowledgement byte count is the client's own confirmation of
    // playback progress, so prefer it whenever at least one mark for the
    // current item has been acknowledged. Only fall back to the
    // media-timestamp diff (which assumes input and output audio share one
    // continuous real-time clock - true for telephony bridges, not
    // guaranteed for a relayed mobile client) when no such confirmation
    // exists yet.
    const playedMs = shouldInterruptProvider ? this.playedAudioMsForCurrentItem() : null;
    const rawAudioEndMs = shouldInterruptProvider
      ? (playedMs ??
        Math.max(
          0,
          responseStartTimestamp === null
            ? this.latestMediaTimestamp
            : this.latestMediaTimestamp - responseStartTimestamp,
        ))
      : null;
    // deliveredAudioBytesForCurrentItem bytes are bytes OpenAI has actually
    // sent us for this item, so the millisecond equivalent is a hard upper
    // bound on the item's true audio duration - clamping here makes an
    // "Audio content of Xms is already shorter than Yms" rejection
    // structurally impossible on every path, including the media-timestamp
    // fallback above (which has no other relationship to this item's real
    // duration and previously could report clock drift as "audio played").
    const deliveredMs = shouldInterruptProvider ? this.deliveredAudioMsForCurrentItem() : null;
    const audioEndMs =
      rawAudioEndMs !== null && deliveredMs !== null
        ? Math.min(rawAudioEndMs, deliveredMs)
        : rawAudioEndMs;
    const minBargeInAudioEndMs =
      this.config.minBargeInAudioEndMs ?? OPENAI_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS;
    // Below-minimum audio_end_ms only means "not confident enough yet to
    // tell OpenAI precisely where to truncate this item" - it must NOT mean
    // "not a real barge-in". A genuine barge-in signal always cancels any
    // in-flight provider response and clears local playback immediately;
    // only the provider-side truncate call (which requires a trustworthy
    // audio_end_ms) is what gets skipped below the minimum. Gating local
    // clear on this too would let the assistant keep talking over the user
    // for as long as mark-acknowledgement round-trips lag real time.
    const audioEndMsBelowMinimum =
      !force && audioEndMs !== null && audioEndMs < minBargeInAudioEndMs;
    if (audioEndMsBelowMinimum) {
      this.config.onEvent?.({
        direction: "client",
        type: "conversation.item.truncate.skipped",
        detail: `reason=barge-in audioEndMs=${audioEndMs} minAudioEndMs=${minBargeInAudioEndMs}`,
      });
    }
    if (
      options?.audioPlaybackActive === true &&
      this.responseActive &&
      !this.responseCancelInFlight
    ) {
      const eventId = `openclaw-response-cancel-${randomUUID()}`;
      this.manualResponseCancelEventId = eventId;
      this.sendEvent({ type: "response.cancel", event_id: eventId }, "reason=barge-in");
      this.responseCancelInFlight = true;
    }
    if (shouldInterruptProvider && !audioEndMsBelowMinimum) {
      const truncateEventId = `openclaw-truncate-${randomUUID()}`;
      this.manualTruncateEventId = truncateEventId;
      this.sendEvent(
        {
          type: "conversation.item.truncate",
          item_id: assistantItemId,
          content_index: 0,
          audio_end_ms: audioEndMs,
          event_id: truncateEventId,
        },
        `reason=barge-in audioEndMs=${audioEndMs}`,
      );
      this.config.onClearAudio("barge-in");
      // The item we just told the server to stop at audioEndMs may still
      // have in-flight deltas arriving for the same item_id (the truncate
      // request and the provider's in-progress generation race). Remember
      // it so OpenAIRealtimeEvents can recognize and drop that stale tail
      // instead of re-adopting it as a brand new item, which would restart
      // clock/byte accounting mid-stream and could trigger a second,
      // spuriously-small-looking truncate rejection for the same item.
      this.lastTruncatedItemId = assistantItemId;
      this.clearOutstandingMarks();
      this.lastAssistantItemId = null;
      this.responseStartTimestamp = null;
      return;
    }
    this.config.onClearAudio("barge-in");
  }

  protected requestResponseCreate(options?: OpenAIRealtimeUserMessageOptions): void {
    if (
      this.responseActive ||
      this.responseCreateInFlight ||
      this.responseCancelInFlight ||
      this.continuingToolCallIds.size > 0 ||
      this.pendingToolCallIds.size > 0
    ) {
      this.responseCreatePending = true;
      return;
    }
    this.responseCreatePending = false;
    this.responseCreateInFlight = true;
    this.suppressAutoRespondForManualResponse();
    const eventId = `openclaw-response-create-${randomUUID()}`;
    // Realtime errors can describe unrelated client events. Keep this id until
    // the manual turn settles so only its rejection may release VAD suppression.
    this.manualResponseCreateEventId = eventId;
    this.sendEvent({
      type: "response.create",
      event_id: eventId,
      ...(options?.toolChoice
        ? { response: { output_modalities: ["audio"], tool_choice: options.toolChoice } }
        : {}),
    });
  }

  protected flushStandaloneSpeech(): void {
    if (
      this.standaloneSpeechActive ||
      this.responseActive ||
      this.responseCreateInFlight ||
      this.responseCancelInFlight
    ) {
      return;
    }
    const text = this.standaloneSpeechQueue.shift();
    if (!text) {
      return;
    }
    const eventId = `openclaw-standalone-speech-${randomUUID()}`;
    this.standaloneSpeechActive = true;
    this.standaloneSpeechEventId = eventId;
    this.responseCreateInFlight = true;
    this.sendEvent({
      type: "response.create",
      event_id: eventId,
      response: {
        conversation: "none",
        output_modalities: ["audio"],
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        ],
      },
    });
  }

  protected suppressAutoRespondForManualResponse(): void {
    if (this.config.autoRespondToAudio === false || this.autoRespondSuppressedForManualResponse) {
      return;
    }
    // Manual response.create owns this turn. Keep VAD events and interruption active,
    // but prevent a second server-owned response until all queued manual work finishes.
    this.autoRespondSuppressedForManualResponse = true;
    this.sendAutoResponseSessionUpdate(false);
  }

  protected restoreAutoRespondAfterManualResponse(): void {
    if (!this.autoRespondSuppressedForManualResponse) {
      return;
    }
    this.autoRespondSuppressedForManualResponse = false;
    this.sendAutoResponseSessionUpdate(true);
  }

  protected flushPendingResponseCreate(): void {
    if (!this.responseCreatePending) {
      return;
    }
    this.responseCreatePending = false;
    this.requestResponseCreate();
  }

  protected resetRealtimeSessionState(): void {
    this.clearOutstandingMarks();
    this.lastTruncatedItemId = null;
    this.manualTruncateEventId = null;
    this.responseStartTimestamp = null;
    this.responseActive = false;
    this.responseCreateInFlight = false;
    this.manualResponseCreateEventId = null;
    this.responseCancelInFlight = false;
    this.manualResponseCancelEventId = null;
    this.responseCreatePending = false;
    this.autoRespondSuppressedForManualResponse = false;
    this.continuingToolCallIds.clear();
    this.pendingToolCallIds.clear();
    this.lastAssistantItemId = null;
    this.completedToolCallIds.clear();
    this.standaloneSpeechQueue = [];
    this.standaloneSpeechActive = false;
    this.standaloneSpeechEventId = null;
  }

  protected sendMark(): void {
    const sequence = this.nextMarkSequence;
    this.nextMarkSequence += 1;
    if (this.oldestOutstandingMarkSequence === null) {
      this.oldestOutstandingMarkSequence = sequence;
    }
    this.latestOutstandingMarkSequence = sequence;
    this.markAudioByteOffsets.set(sequence, this.deliveredAudioBytesForCurrentItem);
    const markName = `audio-${sequence}`;
    this.config.onMark?.(markName);
  }

  protected clearOutstandingMarks(): void {
    this.oldestOutstandingMarkSequence = null;
    this.latestOutstandingMarkSequence = null;
    this.resetItemAudioAccounting();
  }

  abstract submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void;

  protected abstract sendEvent(event: unknown, detail?: string): void;
}

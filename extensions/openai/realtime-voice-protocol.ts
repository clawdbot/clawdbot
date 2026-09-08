import { randomUUID } from "node:crypto";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBargeInOptions,
  RealtimeVoicePlaybackItem,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  realtimeVoiceAudioDurationMs,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
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

  protected responseActive = false;

  protected responseCreateState: "idle" | "preparing" | "in-flight" = "idle";

  protected manualResponseCreateEventId: string | null = null;

  protected responseCancelInFlight = false;

  protected manualResponseCancelEventId: string | null = null;

  protected responseCreatePending = false;

  protected autoRespondSuppressedForManualResponse = false;

  protected continuingToolCallIds = new Set<string>();

  protected pendingToolCallIds = new Set<string>();

  protected latestMediaTimestamp = 0;

  protected outputAudioGeneration = 0;

  protected interruptingPlayback = false;

  protected assistantAudioItem: {
    itemId: string;
    bytes: number;
    startTimestamp: number;
  } | null = null;

  protected completedToolCallIds = new Set<string>();

  protected standaloneSpeechQueue: string[] = [];

  protected standaloneSpeechActive = false;

  protected standaloneSpeechEventId: string | null = null;

  private readonly audioFormat: RealtimeVoiceAudioFormat;

  constructor(
    protected readonly config: OpenAIRealtimeVoiceBridgeConfig,
    protected readonly runtime: OpenAIRealtimeHost,
  ) {
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
    // Marks follow ordered playback. Reaching a named mark also acknowledges every
    // earlier mark, while late acknowledgements from that prefix remain harmless.
    if (acknowledgedSequence === latest) {
      this.oldestOutstandingMarkSequence = null;
      this.latestOutstandingMarkSequence = null;
      return;
    }
    this.oldestOutstandingMarkSequence = acknowledgedSequence + 1;
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
          tools: normalizeOpenAIRealtimeTools(cfg.tools, this.runtime.warn),
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
      this.runtime.warn,
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
    this.responseCreateState = "idle";
    this.manualResponseCreateEventId = null;
    this.responseCancelInFlight = false;
    this.manualResponseCancelEventId = null;
    if (this.standaloneSpeechActive) {
      this.standaloneSpeechActive = false;
      this.standaloneSpeechEventId = null;
    }
    if (options.drain !== false) {
      this.drainResponseQueue();
    }
  }

  private drainResponseQueue(): void {
    if (
      this.interruptingPlayback ||
      this.responseActive ||
      this.responseCreateState !== "idle" ||
      this.responseCancelInFlight
    ) {
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
    // Wire observers can synchronously reenter while the sink still owns its snapshot.
    if (this.interruptingPlayback) {
      return;
    }
    this.interruptingPlayback = true;
    try {
      this.interruptPlayback(options);
    } finally {
      this.interruptingPlayback = false;
    }
    this.drainResponseQueue();
  }

  private interruptPlayback(options?: RealtimeVoiceBargeInOptions): void {
    const assistantAudioItem = this.assistantAudioItem;
    const force = options?.force === true;
    const shouldInterruptProvider =
      assistantAudioItem !== null &&
      (this.oldestOutstandingMarkSequence !== null ||
        options?.audioPlaybackActive === true ||
        force);
    // Timestamp/mark-only transports retain their shipped clock contract. An
    // authoritative empty sink snapshot must never fall back to an already-heard item.
    const playbackState: readonly RealtimeVoicePlaybackItem[] = this.config.getPlaybackState
      ? this.config.getPlaybackState()
      : shouldInterruptProvider && assistantAudioItem
        ? [
            {
              itemId: assistantAudioItem.itemId,
              audioEndMs: Math.min(
                Math.floor(
                  realtimeVoiceAudioDurationMs(this.audioFormat, assistantAudioItem.bytes),
                ),
                Math.max(0, this.latestMediaTimestamp - assistantAudioItem.startTimestamp),
              ),
            },
          ]
        : [];
    const playbackItems = playbackState.map(({ itemId, audioEndMs }) => ({ itemId, audioEndMs }));
    // Short prefixes stay retained while a response generates; they must not pin
    // the echo guard below its threshold after later audio has played.
    const audioEndMs = playbackItems.reduce((played, item) => played + item.audioEndMs, 0);
    const minBargeInAudioEndMs =
      this.config.minBargeInAudioEndMs ?? OPENAI_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS;
    if (!force && playbackItems.length > 0 && audioEndMs < minBargeInAudioEndMs) {
      this.config.onEvent?.({
        direction: "client",
        type: "conversation.item.truncate.skipped",
        detail: `reason=barge-in audioEndMs=${audioEndMs} minAudioEndMs=${minBargeInAudioEndMs}`,
      });
      return;
    }
    // VAD suppression can notify observers before create is sent. Retire that
    // local reservation without awaiting a native terminal that cannot arrive.
    if (this.responseCreateState === "preparing") {
      this.releaseResponseState({ drain: false });
    }
    const cancelResponse =
      (options?.audioPlaybackActive === true || force) &&
      (this.responseActive || this.responseCreateState === "in-flight") &&
      !this.responseCancelInFlight;
    // Retire playback before callbacks can admit replacement output or reenter control.
    this.outputAudioGeneration += 1;
    this.assistantAudioItem = null;
    this.clearOutstandingMarks();
    if (this.responseActive || this.responseCreateState === "in-flight") {
      this.responseCancelInFlight = true;
    }
    if (cancelResponse) {
      const eventId = `openclaw-response-cancel-${randomUUID()}`;
      this.manualResponseCancelEventId = eventId;
      this.sendEvent({ type: "response.cancel", event_id: eventId }, "reason=barge-in");
    }
    for (const item of playbackItems) {
      this.sendEvent(
        {
          type: "conversation.item.truncate",
          item_id: item.itemId,
          content_index: 0,
          audio_end_ms: item.audioEndMs,
        },
        `reason=barge-in audioEndMs=${item.audioEndMs}`,
      );
    }
    // The sink can request replacement generation when cleared; trim its history first.
    this.config.onClearAudio("barge-in");
  }

  protected requestResponseCreate(options?: OpenAIRealtimeUserMessageOptions): void {
    if (
      this.interruptingPlayback ||
      this.responseActive ||
      this.responseCreateState !== "idle" ||
      this.responseCancelInFlight ||
      this.continuingToolCallIds.size > 0 ||
      this.pendingToolCallIds.size > 0
    ) {
      this.responseCreatePending = true;
      return;
    }
    this.responseCreatePending = false;
    this.responseCreateState = "preparing";
    this.suppressAutoRespondForManualResponse();
    if (this.responseCreateState !== "preparing") {
      return;
    }
    this.responseCreateState = "in-flight";
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
      this.interruptingPlayback ||
      this.standaloneSpeechActive ||
      this.responseActive ||
      this.responseCreateState !== "idle" ||
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
    this.responseCreateState = "in-flight";
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
    this.outputAudioGeneration += 1;
    this.clearOutstandingMarks();
    this.assistantAudioItem = null;
    this.responseActive = false;
    this.responseCreateState = "idle";
    this.manualResponseCreateEventId = null;
    this.responseCancelInFlight = false;
    this.manualResponseCancelEventId = null;
    this.responseCreatePending = false;
    this.autoRespondSuppressedForManualResponse = false;
    this.continuingToolCallIds.clear();
    this.pendingToolCallIds.clear();
    this.completedToolCallIds.clear();
    this.standaloneSpeechQueue = [];
    this.standaloneSpeechActive = false;
    this.standaloneSpeechEventId = null;
  }

  protected createPlaybackMark(): string {
    const sequence = this.nextMarkSequence;
    this.nextMarkSequence += 1;
    if (this.oldestOutstandingMarkSequence === null) {
      this.oldestOutstandingMarkSequence = sequence;
    }
    this.latestOutstandingMarkSequence = sequence;
    return `audio-${sequence}`;
  }

  protected clearOutstandingMarks(): void {
    this.oldestOutstandingMarkSequence = null;
    this.latestOutstandingMarkSequence = null;
  }

  abstract submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void;

  protected abstract sendEvent(event: unknown, detail?: string): void;
}

import type { RealtimeVoiceAgentTalkbackQueue } from "./agent-talkback-runtime.js";
import {
  createRealtimeVoiceAgentTalkbackQueue,
  type RealtimeVoiceAgentTalkbackQueueParams,
} from "./agent-talkback-runtime.js";
import {
  createRealtimeVoiceForcedConsultCoordinator,
  type RealtimeVoiceForcedConsultCoordinator,
  type RealtimeVoiceForcedConsultCoordinatorOptions,
} from "./forced-consult-coordinator.js";
import { recordTalkObservabilityEvent } from "./observability.js";
import {
  createRealtimeVoiceOutputActivityTracker,
  type RealtimeVoiceOutputActivityDelta,
  type RealtimeVoiceOutputActivityTracker,
} from "./output-activity-tracker.js";
import type {
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceBridgeEvent,
  RealtimeVoiceResponseOutcome,
  RealtimeVoiceRole,
} from "./provider-types.js";
import {
  extendRealtimeVoiceOutputEchoSuppression,
  getRealtimeVoiceBridgeEventHealth,
  getRealtimeVoiceTranscriptHealth,
  isLikelyRealtimeVoiceAssistantEchoTranscript,
  recordRealtimeVoiceBridgeEvent,
  recordRealtimeVoiceTranscript,
  type RealtimeVoiceBridgeEventLogEntry,
  type RealtimeVoiceTranscriptEntry,
} from "./session-log-runtime.js";
import {
  createRealtimeVoiceBridgeSession,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceBridgeSessionParams,
} from "./session-runtime.js";
import type { TalkEvent, TalkEventInput } from "./talk-events.js";
import {
  createTalkSessionController,
  type TalkSessionController,
  type TalkSessionControllerParams,
  type TalkTurnResult,
} from "./talk-session-controller.js";

const MAX_SETTLED_RESPONSE_IDS = 64;

type RealtimeVoiceHarnessResponseOwner = {
  claimResponseEvent(event: RealtimeVoiceBridgeEvent): void;
  finishLegacyEvent(event: RealtimeVoiceBridgeEvent): RealtimeVoiceResponseOutcome | undefined;
};

const harnessResponseOwners = new WeakMap<
  RealtimeVoiceSessionHarness,
  RealtimeVoiceHarnessResponseOwner
>();

/** Core-only adapter for direct provider bridges that cannot use createBridge(). */
export function handleRealtimeVoiceHarnessBridgeEvent(
  harness: RealtimeVoiceSessionHarness,
  event: RealtimeVoiceBridgeEvent,
): RealtimeVoiceResponseOutcome | undefined {
  const owner = harnessResponseOwners.get(harness);
  owner?.claimResponseEvent(event);
  return owner?.finishLegacyEvent(event);
}

type RealtimeVoiceSessionHarnessTalkPayloads = {
  turnStarted: () => unknown;
  turnEnded: (reason: string) => unknown;
  inputAudioDelta: (audio: Buffer) => unknown;
  outputAudioStarted: () => unknown;
  outputAudioDelta: (audio: Buffer) => unknown;
  outputAudioDone: (reason: string) => unknown;
};

type RealtimeVoiceSessionHarnessEchoSuppression = {
  bytesPerMs: number;
  tailMs: number;
  transcriptLookbackMs: number;
};

type RealtimeVoiceSessionHarnessHealth = ReturnType<typeof getRealtimeVoiceTranscriptHealth> &
  Partial<ReturnType<typeof getRealtimeVoiceBridgeEventHealth>> & {
    providerConnected: boolean;
    realtimeReady: boolean;
    audioInputActive: boolean;
    audioOutputActive: boolean;
    lastInputAt?: string;
    lastOutputAt?: string;
    lastSuppressedInputAt?: string;
    lastInputBytes: number;
    lastOutputBytes: number;
    suppressedInputBytes: number;
    recentTalkEvents: Array<{
      id: string;
      type: TalkEvent["type"];
      sessionId: string;
      turnId?: string;
      seq: number;
      timestamp: string;
      final?: boolean;
    }>;
  };

export type RealtimeVoiceSessionHarness<TForcedConsultContext = unknown> = {
  readonly forcedConsults: RealtimeVoiceForcedConsultCoordinator<TForcedConsultContext>;
  readonly outputActivity: RealtimeVoiceOutputActivityTracker;
  readonly talk: TalkSessionController;
  readonly talkback: RealtimeVoiceAgentTalkbackQueue | undefined;
  readonly transcript: RealtimeVoiceTranscriptEntry[];
  close(): void;
  createBridge(params: RealtimeVoiceBridgeSessionParams): RealtimeVoiceBridgeSession;
  emit<TPayload>(input: TalkEventInput<TPayload>): TalkEvent<TPayload>;
  ensureTurn(): string;
  endTurn(reason?: string): void;
  finishResponse(outcome: RealtimeVoiceResponseOutcome): TalkTurnResult;
  finishOutputAudio(reason: string): void;
  flushOutput(flush: () => void): void;
  getHealth(params: {
    providerConnected: boolean;
    realtimeReady: boolean;
  }): RealtimeVoiceSessionHarnessHealth;
  handleBargeIn(options: RealtimeVoiceBargeInOptions, flushOutput: () => void): void;
  isLikelyAssistantEchoTranscript(text: string): boolean;
  isOutputPlaybackWindowActive(): boolean;
  recordInputAudio(audio: Buffer): boolean;
  recordOutputAudio(audio: Buffer, activity?: RealtimeVoiceOutputActivityDelta): void;
  recordTranscript(role: RealtimeVoiceRole, text: string): RealtimeVoiceTranscriptEntry;
};

export function createRealtimeVoiceSessionHarness<TForcedConsultContext = unknown>(params: {
  talk: TalkSessionControllerParams;
  talkPayloads: RealtimeVoiceSessionHarnessTalkPayloads;
  onTalkEvent?: (event: TalkEvent) => void;
  talkback?: Omit<RealtimeVoiceAgentTalkbackQueueParams, "isStopped">;
  forcedConsults?: RealtimeVoiceForcedConsultCoordinatorOptions;
  echoSuppression?: RealtimeVoiceSessionHarnessEchoSuppression;
  transcriptLookbackMs?: number;
  captureBridgeEvents?: boolean;
}): RealtimeVoiceSessionHarness<TForcedConsultContext> {
  let closed = false;
  let bridge: RealtimeVoiceBridgeSession | undefined;
  let lastInputAt: string | undefined;
  let lastOutputAt: string | undefined;
  let lastSuppressedInputAt: string | undefined;
  let lastInputBytes = 0;
  let suppressedInputBytes = 0;
  let suppressInputUntilMs = 0;
  let lastOutputPlayableUntilMs = 0;
  let outputFlushGeneration = 0;
  let responseOwnerTurnId: string | undefined;
  let responseOwnerId: string | undefined;
  let suppressNextUnkeyedLegacyTerminal = false;
  const settledResponseIds = new Set<string>();
  const settledResponseIdOrder: string[] = [];
  const transcript: RealtimeVoiceTranscriptEntry[] = [];
  const bridgeEvents: RealtimeVoiceBridgeEventLogEntry[] = [];
  const outputActivity = createRealtimeVoiceOutputActivityTracker();
  const transcriptLookbackMs =
    params.transcriptLookbackMs ?? params.echoSuppression?.transcriptLookbackMs;
  const forcedConsults = createRealtimeVoiceForcedConsultCoordinator<TForcedConsultContext>(
    params.forcedConsults,
  );
  const talk = createTalkSessionController(
    { maxRecentEvents: 40, ...params.talk },
    {
      onEvent: (event) => {
        recordTalkObservabilityEvent(event);
        params.onTalkEvent?.(event);
      },
    },
  );
  const talkback = params.talkback
    ? createRealtimeVoiceAgentTalkbackQueue({
        ...params.talkback,
        isStopped: () => closed,
      })
    : undefined;

  const ensureTurn = () => {
    const turnId = talk.ensureTurn({ payload: params.talkPayloads.turnStarted() }).turnId;
    responseOwnerTurnId ??= turnId;
    return turnId;
  };

  const rememberSettledResponse = (responseId: string | undefined): void => {
    if (!responseId || settledResponseIds.has(responseId)) {
      return;
    }
    settledResponseIds.add(responseId);
    settledResponseIdOrder.push(responseId);
    if (settledResponseIdOrder.length > MAX_SETTLED_RESPONSE_IDS) {
      const oldest = settledResponseIdOrder.shift();
      if (oldest) {
        settledResponseIds.delete(oldest);
      }
    }
  };

  const claimResponseEvent = (event: RealtimeVoiceBridgeEvent): void => {
    if (event.direction !== "server" || event.type !== "response.created") {
      return;
    }
    responseOwnerTurnId = ensureTurn();
    responseOwnerId = event.responseId;
    suppressNextUnkeyedLegacyTerminal = false;
  };

  const finishResponse = (
    outcome: RealtimeVoiceResponseOutcome,
    source: "typed" | "legacy" | "manual",
  ): TalkTurnResult => {
    if (outcome.responseId && settledResponseIds.has(outcome.responseId)) {
      return { ok: false, reason: "no_active_turn" };
    }
    if (outcome.responseId && responseOwnerId && outcome.responseId !== responseOwnerId) {
      return { ok: false, reason: "stale_turn" };
    }
    const turnId = responseOwnerTurnId ?? talk.activeTurnId;
    if (!turnId) {
      return { ok: false, reason: "no_active_turn" };
    }
    if (talk.activeTurnId !== turnId) {
      return { ok: false, reason: "stale_turn" };
    }
    talk.finishOutputAudio({
      turnId,
      payload: params.talkPayloads.outputAudioDone(outcome.status),
    });
    if (outcome.status === "failed" || outcome.status === "incomplete") {
      talk.emit({
        type: "session.error",
        turnId,
        payload: outcome,
        final: true,
      });
    }
    const payload = params.talkPayloads.turnEnded(outcome.status);
    const result =
      outcome.status === "cancelled"
        ? talk.cancelTurn({ turnId, payload })
        : talk.endTurn({ turnId, payload });
    if (result.ok) {
      rememberSettledResponse(outcome.responseId);
      if (!outcome.responseId && source === "typed") {
        // Current typed providers emit the legacy bridge event in the same dispatch.
        // Suppress that unkeyed twin without treating arbitrary later events as typed.
        suppressNextUnkeyedLegacyTerminal = true;
      }
      if (!responseOwnerId || !outcome.responseId || responseOwnerId === outcome.responseId) {
        responseOwnerTurnId = undefined;
        responseOwnerId = undefined;
      }
    }
    return result;
  };

  const finishLegacyEvent = (
    event: RealtimeVoiceBridgeEvent,
  ): RealtimeVoiceResponseOutcome | undefined => {
    if (
      event.direction !== "server" ||
      (event.type !== "response.done" && event.type !== "response.cancelled")
    ) {
      return undefined;
    }
    if (event.responseId && settledResponseIds.has(event.responseId)) {
      return undefined;
    }
    if (!event.responseId && suppressNextUnkeyedLegacyTerminal) {
      suppressNextUnkeyedLegacyTerminal = false;
      return undefined;
    }
    const outcome: RealtimeVoiceResponseOutcome = {
      status: event.type === "response.cancelled" ? "cancelled" : "completed",
      ...(event.responseId ? { responseId: event.responseId } : {}),
    };
    return finishResponse(outcome, "legacy").ok ? outcome : undefined;
  };

  const flushOutput = (flush: () => void): void => {
    outputFlushGeneration += 1;
    suppressInputUntilMs = 0;
    lastOutputPlayableUntilMs = 0;
    flush();
  };

  const harness: RealtimeVoiceSessionHarness<TForcedConsultContext> = {
    forcedConsults,
    outputActivity,
    talk,
    talkback,
    transcript,
    close() {
      if (closed) {
        return;
      }
      closed = true;
      talkback?.close();
      forcedConsults.clear();
      responseOwnerTurnId = undefined;
      responseOwnerId = undefined;
    },
    createBridge(bridgeParams) {
      bridge = createRealtimeVoiceBridgeSession({
        ...bridgeParams,
        onTranscript: (role, text, isFinal) => {
          if (isFinal) {
            harness.recordTranscript(role, text);
          }
          bridgeParams.onTranscript?.(role, text, isFinal);
        },
        onEvent: (event) => {
          claimResponseEvent(event);
          const legacyOutcome = finishLegacyEvent(event);
          if (legacyOutcome) {
            bridgeParams.onResponseDone?.(legacyOutcome);
          }
          if (params.captureBridgeEvents !== false) {
            recordRealtimeVoiceBridgeEvent(bridgeEvents, event);
          }
          bridgeParams.onEvent?.(event);
        },
        onResponseDone: (outcome) => {
          if (finishResponse(outcome, "typed").ok) {
            bridgeParams.onResponseDone?.(outcome);
          }
        },
      });
      return bridge;
    },
    emit: (input) => talk.emit(input),
    ensureTurn,
    endTurn(reason = "completed") {
      const result = talk.endTurn({ payload: params.talkPayloads.turnEnded(reason) });
      if (result.ok) {
        responseOwnerTurnId = undefined;
        responseOwnerId = undefined;
      }
    },
    finishResponse(outcome) {
      return finishResponse(outcome, "typed");
    },
    finishOutputAudio(reason) {
      talk.finishOutputAudio({ payload: params.talkPayloads.outputAudioDone(reason) });
    },
    flushOutput,
    getHealth(healthParams) {
      const output = outputActivity.snapshot();
      return {
        providerConnected: healthParams.providerConnected,
        realtimeReady: healthParams.realtimeReady,
        audioInputActive: lastInputBytes > 0,
        audioOutputActive: outputActivity.isActive(),
        lastInputAt,
        lastOutputAt,
        lastSuppressedInputAt,
        lastInputBytes,
        lastOutputBytes: output.sinkAudioBytes,
        suppressedInputBytes,
        ...getRealtimeVoiceTranscriptHealth(transcript),
        ...(bridge ? getRealtimeVoiceBridgeEventHealth(bridgeEvents) : {}),
        recentTalkEvents: talk.recentEvents.slice(-20).map((event) => ({
          id: event.id,
          type: event.type,
          sessionId: event.sessionId,
          turnId: event.turnId,
          seq: event.seq,
          timestamp: event.timestamp,
          final: event.final,
        })),
      };
    },
    handleBargeIn(options, fallbackFlush) {
      suppressInputUntilMs = 0;
      const flushGeneration = outputFlushGeneration;
      bridge?.handleBargeIn(options);
      if (flushGeneration === outputFlushGeneration) {
        flushOutput(fallbackFlush);
      }
    },
    isLikelyAssistantEchoTranscript(text) {
      return transcriptLookbackMs === undefined
        ? false
        : isLikelyRealtimeVoiceAssistantEchoTranscript({
            transcript,
            text,
            lookbackMs: transcriptLookbackMs,
          });
    },
    isOutputPlaybackWindowActive() {
      return Date.now() <= Math.max(lastOutputPlayableUntilMs, suppressInputUntilMs);
    },
    recordInputAudio(audio) {
      if (Date.now() < suppressInputUntilMs) {
        lastSuppressedInputAt = new Date().toISOString();
        suppressedInputBytes += audio.byteLength;
        return false;
      }
      lastInputAt = new Date().toISOString();
      lastInputBytes += audio.byteLength;
      harness.emit({
        type: "input.audio.delta",
        turnId: ensureTurn(),
        payload: params.talkPayloads.inputAudioDelta(audio),
      });
      return true;
    },
    recordOutputAudio(audio, activity = {}) {
      const turnId = ensureTurn();
      talk.startOutputAudio({
        turnId,
        payload: params.talkPayloads.outputAudioStarted(),
      });
      harness.emit({
        type: "output.audio.delta",
        turnId,
        payload: params.talkPayloads.outputAudioDelta(audio),
      });
      let audioMs = activity.audioMs;
      if (params.echoSuppression) {
        const suppression = extendRealtimeVoiceOutputEchoSuppression({
          audio,
          bytesPerMs: params.echoSuppression.bytesPerMs,
          tailMs: params.echoSuppression.tailMs,
          nowMs: Date.now(),
          lastOutputPlayableUntilMs,
          suppressInputUntilMs,
        });
        lastOutputPlayableUntilMs = suppression.lastOutputPlayableUntilMs;
        suppressInputUntilMs = suppression.suppressInputUntilMs;
        audioMs ??= suppression.durationMs;
      }
      outputActivity.markAudio({
        audioMs,
        sourceAudioBytes: activity.sourceAudioBytes ?? audio.byteLength,
        sinkAudioBytes: activity.sinkAudioBytes ?? audio.byteLength,
      });
      lastOutputAt = new Date().toISOString();
    },
    recordTranscript: (role, text) => recordRealtimeVoiceTranscript(transcript, role, text),
  };

  harnessResponseOwners.set(harness, { claimResponseEvent, finishLegacyEvent });

  return harness;
}

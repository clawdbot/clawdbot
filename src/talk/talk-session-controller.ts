// Talk session controller coordinates voice session state and output activity.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createTalkEventSequencer,
  type TalkBrain,
  type TalkEvent,
  type TalkEventContext,
  type TalkEventInput,
  type TalkEventSequencer,
  type TalkMode,
  type TalkTransport,
} from "./talk-events.js";

/**
 * Why a turn-scoped Talk operation could not emit an event.
 */
export type TalkTurnFailureReason = "no_active_turn" | "stale_turn";

/**
 * Successful turn operation with the emitted Talk event.
 */
export type TalkTurnSuccess = {
  event: TalkEvent;
  ok: true;
  turnId: string;
};

/**
 * Failed turn operation when the requested turn does not match controller state.
 */
export type TalkTurnFailure = {
  ok: false;
  reason: TalkTurnFailureReason;
};

/**
 * Result for ending or cancelling an active Talk turn.
 */
export type TalkTurnResult = TalkTurnSuccess | TalkTurnFailure;

/**
 * Result for operations that ensure a turn exists and may emit a start event.
 */
export type TalkEnsureTurnResult = {
  event?: TalkEvent;
  turnId: string;
};

/**
 * Stateful Talk event controller for one session's turns, output audio, and recent event buffer.
 */
export type TalkSessionController = {
  readonly activeTurnId: string | undefined;
  readonly context: TalkEventContext;
  readonly outputAudioActive: boolean;
  readonly recentEvents: readonly TalkEvent[];
  clearActiveTurn(): void;
  emit<TPayload>(input: TalkEventInput<TPayload>): TalkEvent<TPayload>;
  ensureTurn(params?: { payload?: unknown; turnId?: string }): TalkEnsureTurnResult;
  startTurn(params?: { payload?: unknown; turnId?: string }): TalkEnsureTurnResult;
  endTurn(params?: { payload?: unknown; turnId?: string }): TalkTurnResult;
  cancelTurn(params?: { payload?: unknown; turnId?: string }): TalkTurnResult;
  finishOutputAudio(params?: { payload?: unknown; turnId?: string }): TalkEvent | undefined;
  startOutputAudio(params?: { payload?: unknown; turnId?: string }): TalkEnsureTurnResult;
};

/**
 * Session context plus controller retention settings.
 */
export type TalkSessionControllerParams = TalkEventContext & {
  maxRecentEvents?: number;
  turnIdPrefix?: string;
};

/**
 * Optional controller hooks and sequencer overrides for tests and observers.
 */
export type TalkSessionControllerOptions = {
  now?: () => Date | string;
  onEvent?: (event: TalkEvent) => void;
  sequencer?: TalkEventSequencer;
};

function defaultTalkEventPayload(payload: unknown): unknown {
  return payload === undefined ? {} : payload;
}

/**
 * Creates a per-session Talk controller that emits correlated turn and output-audio events.
 */
export function createTalkSessionController(
  params: TalkSessionControllerParams,
  options: TalkSessionControllerOptions = {},
): TalkSessionController {
  const { maxRecentEvents = 20, turnIdPrefix = "turn", ...context } = params;
  const sequencer = options.sequencer ?? createTalkEventSequencer(context, { now: options.now });
  const recentEvents: TalkEvent[] = [];
  let activeTurnId: string | undefined;
  let outputAudioActive = false;
  let turnSeq = 0;

  const remember = <TPayload>(event: TalkEvent<TPayload>): TalkEvent<TPayload> => {
    // Keep only recent events for diagnostics; the authoritative transcript lives with
    // downstream observers/loggers, so this bounded buffer must not grow with session length.
    recentEvents.push(event as TalkEvent);
    if (recentEvents.length > maxRecentEvents) {
      recentEvents.splice(0, recentEvents.length - maxRecentEvents);
    }
    try {
      options.onEvent?.(event as TalkEvent);
    } catch {
      // Diagnostics hooks must not break Talk delivery.
    }
    return event;
  };

  const emit = <TPayload>(input: TalkEventInput<TPayload>): TalkEvent<TPayload> => {
    return remember(sequencer.next(input));
  };

  const resolveActiveTurn = (requestedTurnId: string | undefined): string | TalkTurnFailure => {
    // Caller-supplied turn ids protect async output callbacks from closing a newer turn.
    if (!activeTurnId) {
      return { ok: false, reason: "no_active_turn" };
    }
    const normalizedRequested = normalizeOptionalString(requestedTurnId);
    if (normalizedRequested && normalizedRequested !== activeTurnId) {
      return { ok: false, reason: "stale_turn" };
    }
    return activeTurnId;
  };

  const ensureTurn = (ensureParams: { payload?: unknown; turnId?: string } = {}) => {
    if (activeTurnId) {
      return { turnId: activeTurnId };
    }
    return startTurn(ensureParams);
  };

  const startTurn = (startParams: { payload?: unknown; turnId?: string } = {}) => {
    const turnId = normalizeOptionalString(startParams.turnId) ?? `${turnIdPrefix}-${++turnSeq}`;
    outputAudioActive = false;
    activeTurnId = turnId;
    return {
      turnId,
      event: emit({
        type: "turn.started",
        turnId,
        payload: defaultTalkEventPayload(startParams.payload),
      }),
    };
  };

  const finishTurn = (
    type: "turn.ended" | "turn.cancelled",
    paramsForTurn: { payload?: unknown; turnId?: string } = {},
  ): TalkTurnResult => {
    const turnId = resolveActiveTurn(paramsForTurn.turnId);
    if (typeof turnId !== "string") {
      return turnId;
    }
    outputAudioActive = false;
    activeTurnId = undefined;
    return {
      ok: true,
      turnId,
      event: emit({
        type,
        turnId,
        payload: defaultTalkEventPayload(paramsForTurn.payload),
        final: true,
      }),
    };
  };

  return {
    get activeTurnId() {
      return activeTurnId;
    },
    context,
    get outputAudioActive() {
      return outputAudioActive;
    },
    get recentEvents() {
      return recentEvents;
    },
    clearActiveTurn() {
      activeTurnId = undefined;
      outputAudioActive = false;
    },
    emit,
    ensureTurn,
    startTurn,
    endTurn(paramsForTurn) {
      return finishTurn("turn.ended", paramsForTurn);
    },
    cancelTurn(paramsForTurn) {
      return finishTurn("turn.cancelled", paramsForTurn);
    },
    finishOutputAudio(paramsForOutput = {}) {
      if (!outputAudioActive) {
        return undefined;
      }
      const turnId = resolveActiveTurn(paramsForOutput.turnId);
      if (typeof turnId !== "string") {
        return undefined;
      }
      outputAudioActive = false;
      return emit({
        type: "output.audio.done",
        turnId,
        payload: defaultTalkEventPayload(paramsForOutput.payload),
        final: true,
      });
    },
    startOutputAudio(paramsForOutput = {}) {
      const turn = ensureTurn({ turnId: paramsForOutput.turnId, payload: {} });
      if (outputAudioActive) {
        // Providers can emit duplicate start notifications; return the active turn without
        // emitting a second start event so observers see one output-audio span.
        return { turnId: turn.turnId };
      }
      outputAudioActive = true;
      return {
        turnId: turn.turnId,
        event: emit({
          type: "output.audio.started",
          turnId: turn.turnId,
          payload: defaultTalkEventPayload(paramsForOutput.payload),
        }),
      };
    },
  };
}

/**
 * Normalizes legacy realtime transport names into Talk transport families.
 */
export function normalizeTalkTransport(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  if (normalized === "webrtc-sdp") {
    return "webrtc";
  }
  if (normalized === "json-pcm-websocket") {
    return "provider-websocket";
  }
  return normalized;
}

export type { TalkBrain, TalkEvent, TalkEventInput, TalkMode, TalkTransport };

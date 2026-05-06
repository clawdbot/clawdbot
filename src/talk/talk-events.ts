export const TALK_EVENT_TYPES = [
  "session.started",
  "session.ready",
  "session.closed",
  "session.error",
  "session.replaced",
  "turn.started",
  "turn.ended",
  "turn.cancelled",
  "capture.started",
  "capture.stopped",
  "capture.cancelled",
  "capture.once",
  "input.audio.delta",
  "input.audio.committed",
  "transcript.delta",
  "transcript.done",
  "output.text.delta",
  "output.text.done",
  "output.audio.started",
  "output.audio.delta",
  "output.audio.done",
  "tool.call",
  "tool.progress",
  "tool.result",
  "tool.error",
  "usage.metrics",
  "latency.metrics",
  "health.changed",
] as const;

export type TalkEventType = (typeof TALK_EVENT_TYPES)[number];

export type TalkMode = "realtime" | "stt-tts" | "transcription";

export type TalkTransport = "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room";

export type TalkBrain = "agent-consult" | "direct-tools" | "none";

export type TalkEventContext = {
  sessionId: string;
  mode: TalkMode;
  transport: TalkTransport;
  brain: TalkBrain;
  provider?: string;
};

export type TalkEvent<TPayload = unknown> = TalkEventContext & {
  id: string;
  type: TalkEventType;
  turnId?: string;
  captureId?: string;
  seq: number;
  timestamp: string;
  final?: boolean;
  callId?: string;
  itemId?: string;
  parentId?: string;
  payload: TPayload;
};

export type TalkEventInput<TPayload = unknown> = {
  type: TalkEventType;
  payload: TPayload;
  turnId?: string;
  captureId?: string;
  timestamp?: string;
  final?: boolean;
  callId?: string;
  itemId?: string;
  parentId?: string;
};

export type TalkEventSequencer = {
  next<TPayload>(input: TalkEventInput<TPayload>): TalkEvent<TPayload>;
};

const TURN_SCOPED_TALK_EVENT_TYPES = new Set<TalkEventType>([
  "turn.started",
  "turn.ended",
  "turn.cancelled",
  "input.audio.delta",
  "input.audio.committed",
  "transcript.delta",
  "transcript.done",
  "output.text.delta",
  "output.text.done",
  "output.audio.started",
  "output.audio.delta",
  "output.audio.done",
  "tool.call",
  "tool.progress",
  "tool.result",
  "tool.error",
]);

const CAPTURE_SCOPED_TALK_EVENT_TYPES = new Set<TalkEventType>([
  "capture.started",
  "capture.stopped",
  "capture.cancelled",
  "capture.once",
]);

function assertTalkEventCorrelation(input: TalkEventInput): void {
  if (TURN_SCOPED_TALK_EVENT_TYPES.has(input.type) && !input.turnId?.trim()) {
    throw new Error(`Talk event ${input.type} requires turnId`);
  }
  if (CAPTURE_SCOPED_TALK_EVENT_TYPES.has(input.type) && !input.captureId?.trim()) {
    throw new Error(`Talk event ${input.type} requires captureId`);
  }
}

export function createTalkEventSequencer(
  context: TalkEventContext,
  options: { now?: () => Date | string } = {},
): TalkEventSequencer {
  let seq = 0;
  const now = options.now ?? (() => new Date());
  return {
    next<TPayload>(input: TalkEventInput<TPayload>): TalkEvent<TPayload> {
      assertTalkEventCorrelation(input);
      seq += 1;
      const timestamp =
        input.timestamp ??
        (() => {
          const value = now();
          return typeof value === "string" ? value : value.toISOString();
        })();
      return {
        ...context,
        id: `${context.sessionId}:${seq}`,
        type: input.type,
        turnId: input.turnId,
        captureId: input.captureId,
        seq,
        timestamp,
        final: input.final,
        callId: input.callId,
        itemId: input.itemId,
        parentId: input.parentId,
        payload: input.payload,
      };
    },
  };
}

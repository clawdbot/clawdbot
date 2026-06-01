import { getChildLogger } from "../logging/logger.js";
import { firstFiniteTalkEventNumber, talkEventPayloadRecord } from "./event-metrics.js";
import type { TalkEvent, TalkEventType } from "./talk-events.js";

type TalkLogLevel = "info" | "warn";

type TalkLogRecord = {
  level: TalkLogLevel;
  message: string;
  attributes: Record<string, string | number | boolean>;
};

const OMITTED_TALK_LOG_EVENT_TYPES = new Set<TalkEventType>([
  "input.audio.delta",
  "output.audio.delta",
  "output.text.delta",
  "transcript.delta",
  "tool.progress",
]);

const TALK_LOGGER_BINDINGS = Object.freeze({ subsystem: "talk" });

/** Converts high-level Talk events into compact structured log records, skipping noisy deltas. */
export function createTalkLogRecord(event: TalkEvent): TalkLogRecord | undefined {
  if (OMITTED_TALK_LOG_EVENT_TYPES.has(event.type)) {
    return undefined;
  }

  const payload = talkEventPayloadRecord(event.payload);
  const attributes: Record<string, string | number | boolean> = {
    sessionId: event.sessionId,
    talkEventType: event.type,
    talkMode: event.mode,
    talkTransport: event.transport,
    talkBrain: event.brain,
  };

  if (event.provider) {
    attributes.talkProvider = event.provider;
  }
  if (typeof event.final === "boolean") {
    attributes.talkFinal = event.final;
  }

  const durationMs = firstFiniteTalkEventNumber(payload, ["durationMs", "latencyMs", "elapsedMs"]);
  if (durationMs !== undefined) {
    attributes.talkDurationMs = durationMs;
  }
  const byteLength = firstFiniteTalkEventNumber(payload, ["byteLength", "audioBytes"]);
  if (byteLength !== undefined) {
    attributes.talkByteLength = byteLength;
  }

  return {
    level: event.type === "session.error" || event.type === "tool.error" ? "warn" : "info",
    message: `talk event ${event.type}`,
    attributes,
  };
}

/** Emits Talk logs best-effort so logging failures never break realtime audio handling. */
export function recordTalkLogEvent(event: TalkEvent): void {
  const record = createTalkLogRecord(event);
  if (!record) {
    return;
  }

  try {
    const logger = getChildLogger(TALK_LOGGER_BINDINGS);
    if (record.level === "warn") {
      logger.warn(record.attributes, record.message);
      return;
    }
    logger.info(record.attributes, record.message);
  } catch {
    // logging must never block the realtime Talk path
  }
}

import {
  emitTrustedDiagnosticEvent,
  type DiagnosticEventInput,
} from "../infra/diagnostic-events.js";
import { firstFiniteTalkEventNumber, talkEventPayloadRecord } from "./event-metrics.js";
import type { TalkEvent } from "./talk-events.js";

type TalkDiagnosticEventInput = Extract<DiagnosticEventInput, { type: "talk.event" }>;

export function createTalkDiagnosticEvent(event: TalkEvent): TalkDiagnosticEventInput {
  const payload = talkEventPayloadRecord(event.payload);
  return {
    type: "talk.event",
    sessionId: event.sessionId,
    turnId: event.turnId,
    captureId: event.captureId,
    talkEventType: event.type,
    mode: event.mode,
    transport: event.transport,
    brain: event.brain,
    provider: event.provider,
    final: event.final,
    durationMs: firstFiniteTalkEventNumber(payload, ["durationMs", "latencyMs", "elapsedMs"]),
    byteLength: firstFiniteTalkEventNumber(payload, ["byteLength", "audioBytes"]),
  };
}

export function recordTalkDiagnosticEvent(event: TalkEvent): void {
  emitTrustedDiagnosticEvent(createTalkDiagnosticEvent(event));
}

/**
 * Privacy-preserving Talk diagnostic event projection.
 *
 * The diagnostic stream needs timing and size counters for reliability work,
 * but must not export raw provider payloads, transcripts, or audio content.
 */
import {
  emitTrustedDiagnosticEvent,
  type DiagnosticEventInput,
} from "../infra/diagnostic-events.js";
import { firstFiniteTalkEventNumber, talkEventPayloadRecord } from "./event-metrics.js";
import type { TalkEvent } from "./talk-events.js";

type TalkDiagnosticEventInput = Extract<DiagnosticEventInput, { type: "talk.event" }>;

/** Convert a Talk event into the bounded diagnostic payload shape. */
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
    // Read only known numeric aliases from provider payloads; raw payload text
    // and audio bytes stay out of diagnostics.
    durationMs: firstFiniteTalkEventNumber(payload, ["durationMs", "latencyMs", "elapsedMs"]),
    byteLength: firstFiniteTalkEventNumber(payload, ["byteLength", "audioBytes"]),
  };
}

/** Emit a trusted internal diagnostic event for one Talk event. */
export function recordTalkDiagnosticEvent(event: TalkEvent): void {
  emitTrustedDiagnosticEvent(createTalkDiagnosticEvent(event));
}

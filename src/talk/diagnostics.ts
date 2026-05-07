import {
  emitTrustedDiagnosticEvent,
  type DiagnosticEventInput,
} from "../infra/diagnostic-events.js";
import type { TalkEvent } from "./talk-events.js";

type TalkDiagnosticEventInput = Extract<DiagnosticEventInput, { type: "talk.event" }>;

export function createTalkDiagnosticEvent(event: TalkEvent): TalkDiagnosticEventInput {
  const payload = asRecord(event.payload);
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
    durationMs: firstFiniteNumber(payload, ["durationMs", "latencyMs", "elapsedMs"]),
    byteLength: firstFiniteNumber(payload, ["byteLength", "audioBytes"]),
  };
}

export function recordTalkDiagnosticEvent(event: TalkEvent): void {
  emitTrustedDiagnosticEvent(createTalkDiagnosticEvent(event));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstFiniteNumber(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

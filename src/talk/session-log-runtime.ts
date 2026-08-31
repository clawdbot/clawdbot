// Talk session log runtime persists voice session transcripts and metadata.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { RealtimeVoiceBridgeEvent, RealtimeVoiceRole } from "./provider-types.js";

/** Ring-buffer entry for transcript text used by Talk health and echo suppression. */
export type RealtimeVoiceTranscriptEntry = {
  at: string;
  role: RealtimeVoiceRole;
  text: string;
};

/** Compact health snapshot exposed to diagnostics without dumping full transcript history. */
export type RealtimeVoiceTranscriptHealth = {
  realtimeTranscriptLines: number;
  lastRealtimeTranscriptAt?: string;
  lastRealtimeTranscriptRole?: RealtimeVoiceRole;
  lastRealtimeTranscriptText?: string;
  recentRealtimeTranscript: RealtimeVoiceTranscriptEntry[];
};

/** Bridge event plus capture time, kept separate from provider event payload shape. */
export type RealtimeVoiceBridgeEventLogEntry = RealtimeVoiceBridgeEvent & {
  at: string;
};

/** Compact health snapshot of recent realtime bridge events. */
export type RealtimeVoiceBridgeEventHealth = {
  lastRealtimeEventAt?: string;
  lastRealtimeEventType?: string;
  lastRealtimeEventDetail?: string;
  recentRealtimeEvents: RealtimeVoiceBridgeEventLogEntry[];
};

/** Appends a transcript entry and trims old rows in-place to bound Talk diagnostics memory. */
export function recordRealtimeVoiceTranscript(
  transcript: RealtimeVoiceTranscriptEntry[],
  role: RealtimeVoiceRole,
  text: string,
  maxEntries = 40,
): RealtimeVoiceTranscriptEntry {
  const entry = { at: new Date().toISOString(), role, text };
  transcript.push(entry);
  if (transcript.length > maxEntries) {
    transcript.splice(0, transcript.length - maxEntries);
  }
  return entry;
}

/** Summarizes transcript history for health endpoints and UI diagnostics. */
export function getRealtimeVoiceTranscriptHealth(
  transcript: RealtimeVoiceTranscriptEntry[],
): RealtimeVoiceTranscriptHealth {
  const last = transcript.at(-1);
  return {
    realtimeTranscriptLines: transcript.length,
    lastRealtimeTranscriptAt: last?.at,
    lastRealtimeTranscriptRole: last?.role,
    lastRealtimeTranscriptText: last?.text,
    recentRealtimeTranscript: transcript.slice(-5),
  };
}

/** Records low-volume bridge events while dropping raw audio chunks from diagnostics. */
export function recordRealtimeVoiceBridgeEvent(
  events: RealtimeVoiceBridgeEventLogEntry[],
  event: RealtimeVoiceBridgeEvent,
  maxEntries = 40,
): void {
  if (event.direction === "client" && event.type === "input_audio_buffer.append") {
    return;
  }
  events.push({ at: new Date().toISOString(), ...event });
  if (events.length > maxEntries) {
    events.splice(0, events.length - maxEntries);
  }
}

/** Summarizes recent bridge events without exposing the full rolling event buffer. */
export function getRealtimeVoiceBridgeEventHealth(
  events: RealtimeVoiceBridgeEventLogEntry[],
): RealtimeVoiceBridgeEventHealth {
  const last = events.at(-1);
  return {
    lastRealtimeEventAt: last?.at,
    lastRealtimeEventType: last ? `${last.direction}:${last.type}` : undefined,
    lastRealtimeEventDetail: last?.detail,
    recentRealtimeEvents: events.slice(-10),
  };
}

function normalizeTranscriptForEchoMatch(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function hasMeaningfulEchoOverlap(userTokens: string[], assistantTokens: string[]): boolean {
  if (userTokens.length < 4 || assistantTokens.length < 4) {
    return false;
  }
  const uniqueUserTokens = uniqueStrings(userTokens);
  if (uniqueUserTokens.length < 4) {
    return false;
  }
  const assistantTokenSet = new Set(assistantTokens);
  const overlap = uniqueUserTokens.filter((token) => assistantTokenSet.has(token)).length;
  return overlap / uniqueUserTokens.length >= 0.58;
}

/** Detects user transcript text that likely came from assistant speaker echo, not speech. */
export function isLikelyRealtimeVoiceAssistantEchoTranscript(params: {
  transcript: RealtimeVoiceTranscriptEntry[];
  text: string;
  lookbackMs: number;
  nowMs?: number;
}): boolean {
  const userTokens = normalizeTranscriptForEchoMatch(params.text);
  if (userTokens.length < 4) {
    return false;
  }
  const nowMs = params.nowMs ?? Date.now();
  const recentAssistantText = params.transcript
    .filter((entry) => {
      if (entry.role !== "assistant") {
        return false;
      }
      const at = Date.parse(entry.at);
      return Number.isFinite(at) && nowMs - at <= params.lookbackMs;
    })
    .slice(-6)
    .map((entry) => entry.text)
    .join(" ");
  if (!recentAssistantText.trim()) {
    return false;
  }
  const userNormalized = userTokens.join(" ");
  const assistantTokens = normalizeTranscriptForEchoMatch(recentAssistantText);
  const assistantNormalized = assistantTokens.join(" ");
  return (
    (userNormalized.length >= 18 && assistantNormalized.includes(userNormalized)) ||
    (assistantNormalized.length >= 18 && userNormalized.includes(assistantNormalized)) ||
    hasMeaningfulEchoOverlap(userTokens, assistantTokens)
  );
}

/** Extends input suppression through the estimated playback tail for assistant audio. */
export function extendRealtimeVoiceOutputEchoSuppression(params: {
  audio: Buffer;
  bytesPerMs: number;
  tailMs: number;
  nowMs: number;
  lastOutputPlayableUntilMs: number;
  suppressInputUntilMs: number;
}): { lastOutputPlayableUntilMs: number; suppressInputUntilMs: number; durationMs: number } {
  const durationMs = Math.ceil(params.audio.byteLength / params.bytesPerMs);
  const playbackStartMs = Math.max(params.nowMs, params.lastOutputPlayableUntilMs);
  const playbackEndMs = playbackStartMs + durationMs;
  return {
    durationMs,
    lastOutputPlayableUntilMs: playbackEndMs,
    suppressInputUntilMs: Math.max(params.suppressInputUntilMs, playbackEndMs + params.tailMs),
  };
}

import { describe, expect, it } from "vitest";
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

describe("realtime voice session log runtime", () => {
  it("records bounded transcript health", () => {
    const transcript: RealtimeVoiceTranscriptEntry[] = [];
    recordRealtimeVoiceTranscript(transcript, "user", "hello", 1);
    recordRealtimeVoiceTranscript(transcript, "assistant", "hi", 1);

    expect(getRealtimeVoiceTranscriptHealth(transcript)).toEqual({
      realtimeTranscriptLines: 1,
      lastRealtimeTranscriptAt: transcript[0]?.at,
      lastRealtimeTranscriptRole: "assistant",
      lastRealtimeTranscriptText: "hi",
      recentRealtimeTranscript: transcript,
    });
  });

  it("skips noisy audio append events and records bridge health", () => {
    const events: RealtimeVoiceBridgeEventLogEntry[] = [];
    recordRealtimeVoiceBridgeEvent(events, {
      direction: "client",
      type: "input_audio_buffer.append",
    });
    recordRealtimeVoiceBridgeEvent(events, {
      direction: "server",
      type: "response.done",
      detail: "ok",
    });

    expect(getRealtimeVoiceBridgeEventHealth(events)).toEqual({
      lastRealtimeEventAt: events[0]?.at,
      lastRealtimeEventType: "server:response.done",
      lastRealtimeEventDetail: "ok",
      recentRealtimeEvents: events,
    });
  });

  it("detects likely assistant echo transcripts", () => {
    const nowMs = Date.now();
    const transcript: RealtimeVoiceTranscriptEntry[] = [
      {
        at: new Date(nowMs - 1000).toISOString(),
        role: "assistant",
        text: "The deployment finished cleanly and all checks passed",
      },
    ];

    expect(
      isLikelyRealtimeVoiceAssistantEchoTranscript({
        transcript,
        text: "deployment finished cleanly and all checks passed",
        lookbackMs: 45_000,
        nowMs,
      }),
    ).toBe(true);
  });

  it("extends output echo suppression from audio duration", () => {
    expect(
      extendRealtimeVoiceOutputEchoSuppression({
        audio: Buffer.alloc(96),
        bytesPerMs: 48,
        tailMs: 3000,
        nowMs: 100,
        lastOutputPlayableUntilMs: 0,
        suppressInputUntilMs: 0,
      }),
    ).toEqual({
      durationMs: 2,
      lastOutputPlayableUntilMs: 102,
      suppressInputUntilMs: 3102,
    });
  });
});
